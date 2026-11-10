//! Pairwise, opt-in listing requests. Only the helper's separately signed
//! listing and public contact record cross from this vault to the public store.
use super::*;
use crate::{listing, model::Draft, store::Store};
use anyhow::{Context, Result, ensure};
use nostr::{Tag, Timestamp, nips::nip19::ToBech32};
use std::collections::BTreeSet;

const TAG: &str = "iris-market/friend-post";
const REVIEW_WINDOW: u64 = 7 * 86400;
const MAX_REQUESTS: usize = 128;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub allowed_senders: BTreeSet<PublicKey>,
    pub sides: BTreeSet<String>,
    #[serde(default)]
    pub categories: BTreeSet<String>,
}

impl Policy {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.allowed_senders.len() <= MAX_THREADS,
            "Too many approved senders"
        );
        ensure!(
            self.sides
                .iter()
                .all(|s| matches!(s.as_str(), "offer" | "request")),
            "Choose offer or request"
        );
        ensure!(
            self.categories.len() <= 32
                && self
                    .categories
                    .iter()
                    .all(|c| !c.trim().is_empty() && c.chars().count() <= 60),
            "Invalid friend posting categories"
        );
        Ok(())
    }

    fn allows(&self, sender: PublicKey, draft: &Draft) -> bool {
        self.allowed_senders.contains(&sender)
            && self.sides.contains(&draft.side)
            && (self.categories.is_empty()
                || self
                    .categories
                    .iter()
                    .any(|c| c.trim().eq_ignore_ascii_case(draft.category.trim())))
    }
}

#[derive(Clone, Copy, Debug, Ord, PartialOrd, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Vouch {
    KnowPersonally,
    TradedBefore,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub draft: Draft,
    #[serde(default)]
    pub allowed_vouches: BTreeSet<Vouch>,
}

impl Request {
    fn validate(&self, owner: PublicKey, device: PublicKey, at: u64) -> Result<()> {
        listing::validate(&self.draft)?;
        ensure!(
            self.draft.expires_at.is_none_or(|expiry| expiry > at),
            "Listing has expired"
        );
        ensure!(
            self.draft.image_url.is_none() && self.draft.service_areas.is_none(),
            "Friend posts accept text listings only"
        );
        let copy = serde_json::to_string(&self.draft)?.to_ascii_lowercase();
        for key in [owner, device] {
            ensure!(
                !copy.contains(&key.to_hex()) && !copy.contains(&key.to_bech32()?),
                "Remove the origin identity from the public copy"
            );
        }
        ensure!(
            !copy.contains("nsec1"),
            "Remove private credentials from the listing"
        );
        Ok(())
    }

    fn review_deadline(&self, created: u64) -> u64 {
        created
            .saturating_add(REVIEW_WINDOW)
            .min(self.draft.expires_at.unwrap_or(u64::MAX))
    }

    fn public_draft(&self, vouches: &BTreeSet<Vouch>) -> Result<Draft> {
        ensure!(
            vouches.is_subset(&self.allowed_vouches),
            "The sender has not approved this disclosure"
        );
        let mut draft = self.draft.clone();
        let mut copy = String::from("Posted for a friend.");
        for vouch in vouches {
            copy.push_str(match vouch {
                Vouch::KnowPersonally => " I know this person personally.",
                Vouch::TradedBefore => " I have traded with this person before.",
            });
        }
        if !draft.description.trim().is_empty() {
            copy.push_str("\n\n");
            copy.push_str(&draft.description);
        }
        draft.description = copy;
        Ok(draft)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Received {
    sender: PublicKey,
    request: Request,
    expires_at: u64,
    // Chosen locally before review, independent of the origin and rumor ID.
    listing_identifier: String,
    declined: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Inbox {
    policy: Policy,
    requests: BTreeMap<String, Received>,
}

pub(super) fn is_request(rumor: &UnsignedEvent) -> bool {
    rumor.kind == Kind::from(14) && rumor.tags.iter().any(|tag| tag.as_slice()[0] == TAG)
}

impl Messaging {
    pub(crate) fn set_friend_post_policy(&mut self, policy: Policy) -> Result<()> {
        policy.validate()?;
        self.transaction(|this| {
            this.state.friend_posts.policy = policy;
            Ok(())
        })
        .map_err(anyhow::Error::msg)
    }

    pub(crate) fn request_friend_post(
        &mut self,
        helper: PublicKey,
        request: Request,
    ) -> Result<()> {
        self.require_authorization().map_err(anyhow::Error::msg)?;
        ensure!(
            helper != self.owner && helper != self.keys.public_key(),
            "Choose someone else to post for you"
        );
        request.validate(self.owner, self.keys.public_key(), now())?;
        let payload = serde_json::to_string(&request)?;
        ensure!(
            payload.len() <= MAX_MESSAGE_BYTES,
            "Friend post request is too large"
        );
        self.transaction(|this| {
            if this.state.outbox.len() + this.state.pending_contact_messages.len() >= MAX_OUTBOX {
                return Err("Private message queue is full".into());
            }
            let peer_id = helper.to_hex();
            this.ensure_conversation(&peer_id)?;
            let ms = this.next_message_millis();
            let mut rumor = nostr::EventBuilder::new(Kind::from(14), "Private listing request")
                .tags([
                    Tag::public_key(helper),
                    Tag::parse(["ms", &ms.to_string()]).map_err(protocol_error)?,
                    Tag::parse([TAG, "1", &payload]).map_err(protocol_error)?,
                ])
                .custom_created_at(Timestamp::from(ms / 1000))
                .build(this.keys.public_key());
            rumor.ensure_id();
            let id = rumor.id.ok_or("Missing request ID")?.to_hex();
            this.state.pending_contact_messages.insert(
                id,
                PendingContactMessage {
                    peer_id,
                    rumor,
                    expires_at: Some(request.review_deadline(ms / 1000)),
                },
            );
            Ok(())
        })
        .map_err(anyhow::Error::msg)
    }

    // Called after authenticating the device and verifying the inner event ID.
    pub(super) fn receive_friend_post(
        &mut self,
        sender: PublicKey,
        device: PublicKey,
        inner: &UnsignedEvent,
    ) {
        let inbox = &mut self.state.friend_posts;
        if sender == self.owner || !inbox.policy.allowed_senders.contains(&sender) {
            return;
        }
        let mut requests = inner
            .tags
            .iter()
            .map(|t| t.as_slice())
            .filter(|t| t[0] == TAG);
        let Some([_, version, payload]) = requests.next() else {
            return;
        };
        if requests.next().is_some()
            || version != "1"
            || payload.len() > MAX_MESSAGE_BYTES
            || !inner.tags.public_keys().copied().eq([self.owner])
        {
            return;
        }
        let Ok(request) = serde_json::from_str::<Request>(payload) else {
            return;
        };
        let at = now();
        let created = inner.created_at.as_secs();
        let expires_at = request.review_deadline(created);
        if expires_at <= at
            || created > at + 300
            || !inbox.policy.allows(sender, &request.draft)
            || request.validate(sender, device, at).is_err()
        {
            return;
        }
        inbox.requests.retain(|_, item| item.expires_at > at);
        if inbox.requests.len() < MAX_REQUESTS
            && let Some(id) = inner.id
        {
            inbox
                .requests
                .entry(id.to_hex())
                .or_insert_with(|| Received {
                    sender,
                    request,
                    expires_at,
                    declined: false,
                    listing_identifier: uuid::Uuid::new_v4().to_string(),
                });
        }
    }

    pub(crate) fn friend_posts(&self, store: &Store) -> Result<serde_json::Value> {
        let inbox = &self.state.friend_posts;
        let mut requests = Vec::new();
        for (id, item) in inbox
            .requests
            .iter()
            .filter(|(_, item)| item.expires_at > now())
        {
            let coordinate = listing::coordinate(
                self.owner,
                &item.listing_identifier,
                item.request.draft.escrow,
            );
            let posted = store.has_listing(&coordinate)?;
            let status = if posted {
                "accepted"
            } else if item.declined {
                "declined"
            } else if inbox.policy.allows(item.sender, &item.request.draft) {
                "pending"
            } else {
                "blocked"
            };
            requests.push(serde_json::json!({
                "id":id, "sender":item.sender, "request":item.request, "expires_at":item.expires_at,
                "status":status, "listing_id":posted.then_some(coordinate)
            }));
        }
        Ok(serde_json::json!({"policy": inbox.policy, "requests": requests}))
    }

    pub(crate) fn decline_friend_post(&mut self, store: &Store, id: &str) -> Result<()> {
        let item = self
            .state
            .friend_posts
            .requests
            .get(id)
            .context("Unknown friend post")?;
        let coordinate = listing::coordinate(
            self.owner,
            &item.listing_identifier,
            item.request.draft.escrow,
        );
        ensure!(
            !store.has_listing(&coordinate)?,
            "Already accepted. Close the public listing instead"
        );
        self.transaction(|this| {
            this.state
                .friend_posts
                .requests
                .get_mut(id)
                .ok_or("Unknown friend post")?
                .declined = true;
            Ok(())
        })
        .map_err(anyhow::Error::msg)
    }

    pub(crate) fn prepare_friend_post(
        &self,
        store: &Store,
        id: &str,
        vouches: &BTreeSet<Vouch>,
    ) -> Result<Option<nostr::UnsignedEvent>> {
        let inbox = &self.state.friend_posts;
        let item = inbox.requests.get(id).context("Unknown friend post")?;
        let coordinate = listing::coordinate(
            self.owner,
            &item.listing_identifier,
            item.request.draft.escrow,
        );
        // The public insert and outbox entry commit together. A retry after a
        // crash sees the same coordinate, even if it has since been closed.
        if store.has_listing(&coordinate)? {
            return Ok(None);
        }
        let at = now();
        ensure!(
            !item.declined && item.expires_at > at,
            "This request is no longer open"
        );
        ensure!(
            inbox.policy.allows(item.sender, &item.request.draft),
            "This request is outside your current policy"
        );
        let draft = item.request.public_draft(vouches)?;
        let event =
            listing::builder(&draft, &item.listing_identifier, at, false)?.build(self.owner);
        Ok(Some(event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Request {
        serde_json::from_value(
            json!({"draft":{"title":"Bicycle","description":"","category":"Bikes","side":"offer"}}),
        )
        .unwrap()
    }

    fn rumor(
        sender: PublicKey,
        target: PublicKey,
        created: u64,
        payload: &Request,
    ) -> UnsignedEvent {
        let mut inner = nostr::EventBuilder::new(Kind::from(14), "Private listing request")
            .tags([
                Tag::public_key(target),
                Tag::parse([TAG, "1", &serde_json::to_string(payload).unwrap()]).unwrap(),
            ])
            .custom_created_at(Timestamp::from(created))
            .build(sender);
        inner.ensure_id();
        inner
    }

    #[test]
    fn admission_binds_authenticated_sender_recipient_policy_and_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let mut helper = Messaging::open(dir.path(), Keys::generate()).unwrap();
        let store = Store::open(&dir.path().join("public.sqlite")).unwrap();
        let owner = helper.owner;
        let origin = Keys::generate().public_key();
        let stranger = Keys::generate().public_key();
        let at = now();
        let request = fixture();
        let inner = rumor(origin, owner, at, &request);
        helper.receive_friend_post(origin, origin, &inner);
        assert!(helper.state.friend_posts.requests.is_empty());
        helper
            .set_friend_post_policy(Policy {
                allowed_senders: [origin].into(),
                sides: ["offer".into()].into(),
                categories: ["BIKES".into()].into(),
            })
            .unwrap();
        let mut wrong_side = request.clone();
        wrong_side.draft.side = "request".into();
        let mut wrong_category = request.clone();
        wrong_category.draft.category = "cars".into();
        for (sender, invalid) in [
            (stranger, rumor(stranger, owner, at, &request)),
            (origin, rumor(origin, stranger, at, &request)),
            (
                origin,
                rumor(origin, owner, at.saturating_sub(REVIEW_WINDOW), &request),
            ),
            (origin, rumor(origin, owner, at + 3600, &request)),
            (origin, rumor(origin, owner, at, &wrong_side)),
            (origin, rumor(origin, owner, at, &wrong_category)),
        ] {
            helper.receive_friend_post(sender, sender, &invalid);
            assert!(helper.state.friend_posts.requests.is_empty());
        }
        helper.receive_friend_post(origin, origin, &inner);
        let id = inner.id.unwrap().to_hex();
        helper.decline_friend_post(&store, &id).unwrap();
        helper.receive_friend_post(origin, origin, &inner);
        assert!(
            helper
                .prepare_friend_post(&store, &id, &BTreeSet::new())
                .is_err()
        );
        assert!(store.pending().unwrap().is_empty());
        assert_eq!(
            helper.friend_posts(&store).unwrap()["requests"][0]["status"],
            "declined"
        );
    }

    #[test]
    fn expires_offline_queue_even_without_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let mut origin = Messaging::open(dir.path(), Keys::generate()).unwrap();
        origin
            .request_friend_post(Keys::generate().public_key(), fixture())
            .unwrap();
        assert_eq!(origin.state.pending_contact_messages.len(), 1);
        origin
            .state
            .pending_contact_messages
            .values_mut()
            .next()
            .unwrap()
            .expires_at = Some(now());
        origin.retry().unwrap();
        assert!(origin.state.pending_contact_messages.is_empty());
        assert!(origin.pending_outbound().is_empty());
    }
}
