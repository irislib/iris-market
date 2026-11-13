//! Pending offers belong to a pairwise encrypted mailbox. This module has no
//! public listing writer and never passes private text to a model or relay query.
use super::*;
use nostr::{Tag, Timestamp};
use uuid::Uuid;

const TAG: &str = "iris-market/private-match";
const WEEK: u64 = 7 * 86400;
const CAP: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Offer,
    Request,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: Uuid,
    pub side: Side,
    pub summary: String,
    pub expires_at: u64,
}
impl Entry {
    fn valid(&self, at: u64) -> bool {
        current(self.expires_at, at) && valid_summary(&self.summary)
    }
}
fn valid_summary(text: &str) -> bool {
    !text.trim().is_empty() && text.chars().count() <= 200 && !text.chars().any(char::is_control)
}
fn current(expiry: u64, at: u64) -> bool {
    expiry > at && expiry <= at.saturating_add(WEEK)
}

#[derive(Clone, Serialize, Deserialize)]
struct Row {
    peer: PublicKey,
    #[serde(flatten)]
    entry: Entry,
}

#[derive(Clone, Serialize, Deserialize)]
struct Pair {
    entries: [Uuid; 2],
    votes: [Option<bool>; 2],
    expires_at: u64,
    introduced: bool,
    /// Each person's single-use alias invitation, carried with their agreement.
    #[serde(default)]
    invites: [Option<String>; 2],
}

#[derive(Clone, Serialize, Deserialize)]
struct Interest {
    helper: PublicKey,
    entry: Uuid,
    summary: String,
    expires_at: u64,
    vote: Option<bool>,
    contact: Option<PublicKey>,
    /// Present when `contact` is the other person's per-match alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invite: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct PublicLead {
    helper: PublicKey,
    entry: Uuid,
    listing: String,
    title: String,
    expires_at: u64,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct Book {
    enabled: bool,
    sent: BTreeMap<Uuid, Row>,
    received: BTreeMap<Uuid, Row>,
    pairs: BTreeMap<Uuid, Pair>,
    interests: BTreeMap<Uuid, Interest>,
    public_leads: BTreeMap<String, PublicLead>,
    withdrawn: BTreeMap<String, u64>,
    #[serde(default)]
    ignore_shares_through: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Wire {
    Share {
        entry: Entry,
    },
    Withdraw {
        entry: Uuid,
        expires_at: u64,
    },
    Suggest {
        proposal: Uuid,
        entry: Uuid,
        summary: String,
        expires_at: u64,
    },
    Vote {
        proposal: Uuid,
        accept: bool,
        expires_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invite: Option<String>,
    },
    Introduce {
        proposal: Uuid,
        contact: PublicKey,
        expires_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invite: Option<String>,
    },
    PublicListing {
        entry: Uuid,
        listing: String,
        title: String,
        expires_at: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Enable {
        enabled: bool,
    },
    Share {
        helper: String,
        side: Side,
        summary: String,
    },
    Withdraw {
        entry: Uuid,
    },
    Suggest {
        left: Uuid,
        right: Uuid,
    },
    Vote {
        proposal: Uuid,
        accept: bool,
        /// Filled locally with this person's alias invitation, never by callers.
        #[serde(skip)]
        invite: Option<String>,
    },
    Introduce {
        proposal: Uuid,
    },
    SendPublic {
        entry: Uuid,
        listing: String,
    },
}

type Dispatch = (PublicKey, Wire, u64);
impl Book {
    pub(super) fn expired(&self, at: u64) -> bool {
        self.sent
            .values()
            .chain(self.received.values())
            .any(|row| row.entry.expires_at <= at)
            || self.interests.values().any(|row| row.expires_at <= at)
            || self.withdrawn.values().any(|expiry| *expiry <= at)
    }

    pub(super) fn prune(&mut self, now: u64) {
        self.sent.retain(|_, r| r.entry.expires_at > now);
        self.received.retain(|_, r| r.entry.expires_at > now);
        self.pairs.retain(|_, p| {
            p.expires_at > now && p.entries.iter().all(|id| self.received.contains_key(id))
        });
        self.interests
            .retain(|_, p| p.expires_at > now && self.sent.contains_key(&p.entry));
        self.public_leads
            .retain(|_, p| p.expires_at > now && self.sent.contains_key(&p.entry));
        self.withdrawn.retain(|_, until| *until > now);
    }

    fn apply(
        &mut self,
        me: PublicKey,
        action: Action,
        now: u64,
        public: Option<&crate::model::Listing>,
    ) -> MessagingResult<Vec<Dispatch>> {
        self.prune(now);
        let mut sends = Vec::new();
        if let Action::Enable { enabled } = action {
            if !enabled {
                for (id, row) in &self.sent {
                    sends.push((
                        row.peer,
                        Wire::Withdraw {
                            entry: *id,
                            expires_at: row.entry.expires_at,
                        },
                        row.entry.expires_at,
                    ));
                }
                self.ignore_shares_through = Some(now);
                self.sent.clear();
                self.received.clear();
                self.pairs.clear();
                self.interests.clear();
                self.public_leads.clear();
            }
            self.enabled = enabled;
            return Ok(sends);
        }
        if !self.enabled {
            return Err("Enable private matching in Settings first".into());
        }
        match action {
            Action::Enable { .. } => unreachable!(),
            Action::Share {
                helper,
                side,
                summary,
            } => {
                let helper = PublicKey::parse(helper.trim())
                    .map_err(|_| "Enter the helper’s npub or public key")?;
                let entry = Entry {
                    id: Uuid::new_v4(),
                    side,
                    summary: summary.trim().to_owned(),
                    expires_at: now + WEEK,
                };
                if helper == me || !entry.valid(now) || self.sent.len() >= CAP {
                    return Err("Choose another helper and a short offer or request".into());
                }
                self.sent.insert(
                    entry.id,
                    Row {
                        peer: helper,
                        entry: entry.clone(),
                    },
                );
                sends.push((helper, Wire::Share { entry }, now + WEEK));
            }
            Action::Withdraw { entry } => {
                let r = self
                    .sent
                    .remove(&entry)
                    .ok_or("This entry is no longer pending")?;
                sends.push((
                    r.peer,
                    Wire::Withdraw {
                        entry,
                        expires_at: r.entry.expires_at,
                    },
                    r.entry.expires_at,
                ));
            }
            Action::Suggest { left, right } => {
                let a = self.received.get(&left).ok_or("First entry expired")?;
                let b = self.received.get(&right).ok_or("Second entry expired")?;
                if a.peer == b.peer
                    || a.entry.side == b.entry.side
                    || self.pairs.len() >= CAP
                    || self
                        .pairs
                        .values()
                        .any(|p| p.entries.contains(&left) && p.entries.contains(&right))
                {
                    return Err(
                        "Choose one pending offer and one request from different people".into(),
                    );
                }
                let id = Uuid::new_v4();
                let end = a.entry.expires_at.min(b.entry.expires_at);
                for (row, other) in [(a, b), (b, a)] {
                    sends.push((
                        row.peer,
                        Wire::Suggest {
                            proposal: id,
                            entry: row.entry.id,
                            summary: other.entry.summary.clone(),
                            expires_at: end,
                        },
                        end,
                    ));
                }
                self.pairs.insert(
                    id,
                    Pair {
                        entries: [left, right],
                        votes: [None, None],
                        expires_at: end,
                        introduced: false,
                        invites: [None, None],
                    },
                );
            }
            Action::Vote {
                proposal,
                accept,
                invite,
            } => {
                let p = self
                    .interests
                    .get_mut(&proposal)
                    .ok_or("Suggestion expired")?;
                if p.vote.is_some() {
                    return Err("You already answered this suggestion".into());
                }
                p.vote = Some(accept);
                sends.push((
                    p.helper,
                    Wire::Vote {
                        proposal,
                        accept,
                        expires_at: p.expires_at,
                        invite: invite.filter(|_| accept),
                    },
                    p.expires_at,
                ));
            }
            Action::Introduce { proposal } => {
                let p = self
                    .pairs
                    .get_mut(&proposal)
                    .ok_or("Suggestion expired or withdrawn")?;
                if p.votes != [Some(true), Some(true)] || p.introduced {
                    return Err("Both people must agree to this introduction".into());
                }
                let [a, b] = p.entries.map(|id| self.received[&id].peer);
                // Each person meets the other's per-match alias, never their account.
                let aliases = match &p.invites {
                    [Some(x), Some(y)] => {
                        let alias = |url: &String| alias_of(url).map(|key| (key, url.clone()));
                        match (alias(x), alias(y)) {
                            (Some(x), Some(y)) if x.0 != y.0 => Some([x, y]),
                            _ => return Err("This introduction is no longer valid".into()),
                        }
                    }
                    [None, None] => None,
                    _ => {
                        return Err(
                            "One person needs to update Iris Market before this introduction"
                                .into(),
                        );
                    }
                };
                for (i, peer) in [a, b].into_iter().enumerate() {
                    let (contact, invite) = match &aliases {
                        Some(pair) => (pair[1 - i].0, Some(pair[1 - i].1.clone())),
                        None => ([b, a][i], None),
                    };
                    sends.push((
                        peer,
                        Wire::Introduce {
                            proposal,
                            contact,
                            expires_at: p.expires_at,
                            invite,
                        },
                        p.expires_at,
                    ));
                }
                p.introduced = true;
            }
            Action::SendPublic { entry, listing } => {
                let row = self.received.get(&entry).ok_or("Entry expired")?;
                let item = public
                    .filter(|l| {
                        l.id == listing
                            && l.author != row.peer.to_hex()
                            && ((l.side == "offer" && row.entry.side == Side::Request)
                                || (l.side == "request" && row.entry.side == Side::Offer))
                    })
                    .ok_or("Choose an active public listing on the opposite side")?;
                sends.push((
                    row.peer,
                    Wire::PublicListing {
                        entry,
                        listing: wire_address(&listing),
                        title: item.title.chars().take(200).collect(),
                        expires_at: row.entry.expires_at,
                    },
                    row.entry.expires_at,
                ));
            }
        }
        self.prune(now);
        Ok(sends)
    }

    fn receive(&mut self, me: PublicKey, peer: PublicKey, wire: Wire, created: u64, now: u64) {
        self.prune(now);
        if !self.enabled || me == peer {
            return;
        }
        match wire {
            Wire::Share { entry } => {
                if self
                    .ignore_shares_through
                    .is_some_and(|cutoff| created <= cutoff)
                    || !entry.valid(now)
                    || self.received.len() >= CAP
                    || self.received.values().filter(|r| r.peer == peer).count() >= 16
                    || self.withdrawn.contains_key(&format!("{peer}/{}", entry.id))
                {
                    return;
                }
                self.received.entry(entry.id).or_insert(Row { peer, entry });
            }
            Wire::Withdraw { entry, expires_at } if current(expires_at, now) => {
                if self.received.get(&entry).is_some_and(|r| r.peer == peer) {
                    self.received.remove(&entry);
                }
                let key = format!("{peer}/{entry}");
                if self.withdrawn.len() < 4 * CAP || self.withdrawn.contains_key(&key) {
                    self.withdrawn
                        .entry(key)
                        .and_modify(|old| *old = (*old).max(expires_at))
                        .or_insert(expires_at);
                } else {
                    // Older controls may still be in transit. Fail closed without growing the mailbox.
                    self.ignore_shares_through =
                        Some(self.ignore_shares_through.unwrap_or(0).max(created));
                }
            }
            Wire::Suggest {
                proposal,
                entry,
                summary,
                expires_at,
            } if current(expires_at, now) && valid_summary(&summary) => {
                if self
                    .sent
                    .get(&entry)
                    .is_some_and(|r| r.peer == peer && expires_at <= r.entry.expires_at)
                    && self.interests.len() < CAP
                {
                    self.interests.entry(proposal).or_insert(Interest {
                        helper: peer,
                        entry,
                        summary,
                        expires_at,
                        vote: None,
                        contact: None,
                        invite: None,
                    });
                }
            }
            Wire::Vote {
                proposal,
                accept,
                expires_at,
                invite,
            } => {
                let invite = invite.filter(|url| accept && alias_of(url).is_some());
                if let Some(p) = self.pairs.get_mut(&proposal)
                    && p.expires_at == expires_at
                {
                    for (i, e) in p.entries.iter().enumerate() {
                        if self.received.get(e).is_some_and(|r| r.peer == peer)
                            && p.votes[i].is_none()
                        {
                            p.votes[i] = Some(accept);
                            p.invites[i] = invite.clone();
                        }
                    }
                }
            }
            Wire::Introduce {
                proposal,
                contact,
                expires_at,
                invite,
            } => {
                if let Some(p) = self.interests.get_mut(&proposal)
                    && p.helper == peer
                    && p.vote == Some(true)
                    && p.expires_at == expires_at
                    && p.contact.is_none()
                    && contact != me
                    && contact != peer
                    && invite
                        .as_deref()
                        .is_none_or(|url| alias_of(url) == Some(contact))
                {
                    p.contact = Some(contact);
                    p.invite = invite;
                }
            }
            Wire::PublicListing {
                entry,
                listing,
                title,
                expires_at,
            } if current(expires_at, now)
                && valid_summary(&title)
                && listing.len() <= 350
                && valid_address(&listing)
                && self
                    .sent
                    .get(&entry)
                    .is_some_and(|r| r.peer == peer && r.entry.expires_at == expires_at)
                && self.public_leads.len() < CAP =>
            {
                self.public_leads.insert(
                    format!("{entry}/{listing}"),
                    PublicLead {
                        helper: peer,
                        entry,
                        listing,
                        title,
                        expires_at,
                    },
                );
            }
            _ => {}
        }
        self.prune(now);
    }
}

/// The alias a single-use private-match invitation belongs to.
fn alias_of(url: &str) -> Option<PublicKey> {
    if url.len() > 2048 {
        return None;
    }
    let invite = parse_invite_url(url).ok()?;
    PublicKey::from_slice(&invite.inviter_device_pubkey.to_bytes()).ok()
}

fn wire_address(id: &str) -> String {
    if valid_address(id) {
        id.to_owned()
    } else {
        format!("30402:{id}")
    }
}
fn valid_address(id: &str) -> bool {
    let mut parts = id.splitn(3, ':');
    matches!(parts.next(), Some("30402" | "38383"))
        && parts.next().is_some_and(|s| PublicKey::from_hex(s).is_ok())
        && parts
            .next()
            .is_some_and(|s| !s.is_empty() && s.len() <= 250 && !s.chars().any(char::is_control))
}
fn terms(s: &str) -> std::collections::BTreeSet<String> {
    crate::literal_search::normalize(s)
        .split_whitespace()
        .filter(|w| {
            w.chars().nth(1).is_some()
                && !matches!(
                    *w,
                    "the"
                        | "for"
                        | "and"
                        | "are"
                        | "can"
                        | "with"
                        | "need"
                        | "looking"
                        | "want"
                        | "offer"
                        | "request"
                        | "sell"
                        | "buy"
                        | "sale"
                        | "have"
                        | "any"
                        | "some"
                        | "to"
                        | "of"
                        | "is"
                        | "an"
                )
        })
        .take(40)
        .map(str::to_owned)
        .collect()
}
pub(super) fn is_match(inner: &UnsignedEvent) -> bool {
    inner.kind == Kind::from(14) && inner.tags.iter().any(|t| t.as_slice()[0] == TAG)
}

impl Messaging {
    pub(crate) fn matching_action(
        &mut self,
        action: Action,
        public: Option<&crate::model::Listing>,
    ) -> MessagingResult<()> {
        if !matches!(action, Action::Enable { .. }) {
            self.require_authorization()?;
        }
        let mut action = action;
        self.transaction(move |m| {
            if let Action::Vote {
                proposal,
                accept: true,
                invite,
            } = &mut action
                && let Some(p) = m.state.matches.interests.get(proposal)
                && p.vote.is_none()
            {
                let (summary, end) = (p.summary.clone(), p.expires_at);
                *invite = Some(m.create_alias(*proposal, &summary, end)?);
            }
            if matches!(action, Action::Enable { enabled: false }) {
                m.state.aliases.forget_pending();
            }
            // A locally queued summary can still be recalled before transport takes it.
            if matches!(
                action,
                Action::Withdraw { .. } | Action::Enable { enabled: false }
            ) {
                m.state.pending_contact_messages.retain(|_, job| {
                    let Some(tag) = job
                        .rumor
                        .tags
                        .iter()
                        .map(|tag| tag.as_slice())
                        .find(|tag| tag[0] == TAG)
                    else {
                        return true;
                    };
                    let Some(wire) = tag
                        .get(2)
                        .and_then(|raw| serde_json::from_str::<Wire>(raw).ok())
                    else {
                        return true;
                    };
                    match (&action, wire) {
                        (Action::Withdraw { entry }, Wire::Share { entry: queued }) => {
                            *entry != queued.id
                        }
                        (Action::Enable { enabled: false }, wire) => {
                            matches!(wire, Wire::Withdraw { .. })
                        }
                        _ => true,
                    }
                });
            }
            let sends = m.state.matches.apply(m.owner, action, now(), public)?;
            if m.state.outbox.len() + m.state.pending_contact_messages.len() + sends.len()
                > MAX_OUTBOX
            {
                return Err("Private message queue is full".into());
            }
            for (peer, wire, end) in sends {
                let peer_id = peer.to_hex();
                m.ensure_conversation(&peer_id)?;
                let ms = m.next_message_millis();
                let payload = serde_json::to_string(&wire).map_err(protocol_error)?;
                let mut rumor = nostr::EventBuilder::new(Kind::from(14), "Private matching")
                    .tags([
                        Tag::public_key(peer),
                        Tag::parse(["ms", &ms.to_string()]).map_err(protocol_error)?,
                        Tag::parse([TAG, "1", &payload]).map_err(protocol_error)?,
                    ])
                    .custom_created_at(Timestamp::from(ms / 1000))
                    .build(m.keys.public_key());
                rumor.ensure_id();
                let id = rumor
                    .id
                    .ok_or("Missing private matching message ID")?
                    .to_hex();
                m.state.pending_contact_messages.insert(
                    id,
                    PendingContactMessage {
                        peer_id,
                        rumor,
                        expires_at: Some(end),
                    },
                );
            }
            Ok(())
        })
    }
    pub(super) fn receive_match(&mut self, peer: PublicKey, inner: &UnsignedEvent) {
        let targets: Vec<_> = inner
            .tags
            .iter()
            .map(|t| t.as_slice())
            .filter(|t| t[0] == "p")
            .collect();
        let controls: Vec<_> = inner
            .tags
            .iter()
            .map(|t| t.as_slice())
            .filter(|t| t[0] == TAG)
            .collect();
        let [target] = targets.as_slice() else {
            return;
        };
        let [control] = controls.as_slice() else {
            return;
        };
        let [_, version, raw] = *control else {
            return;
        };
        if target.get(1) != Some(&self.owner.to_hex())
            || version != "1"
            || raw.len() > 4096
            || inner.created_at.as_secs() > now() + 60
            || inner.created_at.as_secs().saturating_add(WEEK) <= now()
        {
            return;
        }
        if let Ok(wire) = serde_json::from_str(raw) {
            self.state
                .matches
                .receive(self.owner, peer, wire, inner.created_at.as_secs(), now());
        }
        let introduced: Vec<_> = self
            .state
            .matches
            .interests
            .iter()
            .filter_map(|(id, p)| Some((*id, p.contact?, p.invite.clone()?)))
            .filter(|(id, ..)| !self.alias_connected(*id))
            .collect();
        for (chat, contact, invite) in introduced {
            // A bad introduction leaves the alias waiting; it never blocks delivery.
            let _ = self.alias_introduced(chat, contact, &invite);
        }
    }
    pub(crate) fn matching_view(&self) -> Option<serde_json::Value> {
        if !self.state.matches.enabled {
            return None;
        }
        let mut book = self.state.matches.clone();
        book.prune(now());
        // Invitations are private capabilities; views name only the local chat.
        let pairs: BTreeMap<_, _> = book
            .pairs
            .iter()
            .map(|(id, p)| {
                (
                    id,
                    serde_json::json!({"entries":p.entries,"votes":p.votes,"expires_at":p.expires_at,"introduced":p.introduced}),
                )
            })
            .collect();
        let interests: BTreeMap<_, _> = book
            .interests
            .iter()
            .map(|(id, p)| {
                let alias = p.invite.is_some();
                let chat = (alias && p.contact.is_some())
                    .then(|| format!("{}{id}", super::match_chats::PREFIX));
                (
                    id,
                    serde_json::json!({"helper":p.helper,"entry":p.entry,"summary":p.summary,
                        "expires_at":p.expires_at,"vote":p.vote,
                        "contact":if alias { None } else { p.contact },"chat":chat}),
                )
            })
            .collect();
        Some(
            serde_json::json!({"sent":book.sent,"received":book.received,"pairs":pairs,"interests":interests,"public_leads":book.public_leads}),
        )
    }
    pub(crate) fn match_candidates(
        &self,
        id: Uuid,
        items: &[crate::model::Listing],
    ) -> MessagingResult<Vec<serde_json::Value>> {
        let book = &self.state.matches;
        let target = book
            .received
            .get(&id)
            .filter(|r| book.enabled && r.entry.expires_at > now())
            .ok_or("Entry expired or withdrawn")?;
        let query = terms(&target.entry.summary);
        let mut rows = Vec::new();
        let mut add = |kind: &str, id: String, summary: &str, full: &str| {
            let score = query.intersection(&terms(full)).count();
            if score > 0 {
                rows.push((
                    std::cmp::Reverse(score),
                    kind.to_string(),
                    id,
                    summary.to_owned(),
                ));
            }
        };
        for r in book.received.values().filter(|r| {
            r.peer != target.peer && r.entry.side != target.entry.side && r.entry.expires_at > now()
        }) {
            add(
                "private",
                r.entry.id.to_string(),
                &r.entry.summary,
                &r.entry.summary,
            );
        }
        for l in items.iter().filter(|l| {
            l.author != target.peer.to_hex()
                && ((l.side == "offer" && target.entry.side == Side::Request)
                    || (l.side == "request" && target.entry.side == Side::Offer))
        }) {
            add(
                "public",
                l.id.clone(),
                &l.title,
                &format!("{} {} {}", l.title, l.category, l.tags.join(" ")),
            );
        }
        rows.sort();
        rows.truncate(40);
        Ok(rows
            .into_iter()
            .map(
                |(_, kind, id, summary)| serde_json::json!({"kind":kind,"id":id,"summary":summary}),
            )
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flush(chats: &mut [Messaging], published: &mut Vec<Event>) {
        for _ in 0..30 {
            let mut events = Vec::new();
            for (sender, c) in chats.iter_mut().enumerate() {
                c.retry().unwrap();
                events.extend(c.pending_outbound().into_iter().map(|e| (sender, e)));
            }
            let settled = events.is_empty();
            for (sender, e) in events {
                chats[sender].acknowledge_published(&e.id.to_hex()).unwrap();
                published.push(e);
            }
            // Like relays, replay stored events to each matching subscription.
            let before: Vec<_> = chats
                .iter()
                .map(|c| serde_json::to_string(&c.state).unwrap())
                .collect();
            for e in published.iter() {
                for c in chats.iter_mut() {
                    if c.subscriptions()
                        .iter()
                        .any(|s| s.filter.match_event(e, Default::default()))
                    {
                        let _ = c.receive(e);
                    }
                }
            }
            let after: Vec<_> = chats
                .iter()
                .map(|c| serde_json::to_string(&c.state).unwrap())
                .collect();
            if settled && before == after {
                return;
            }
        }
        panic!("Local delivery did not settle");
    }

    #[test]
    fn introductions_use_per_match_aliases_instead_of_accounts() {
        let dirs = [(); 3].map(|_| tempfile::tempdir().unwrap());
        let mut chats: Vec<_> = dirs
            .iter()
            .map(|dir| Messaging::open(dir.path(), Keys::generate()).unwrap())
            .collect();
        let owners: Vec<_> = chats.iter().map(|c| c.owner).collect();
        let (seeker, offerer, helper) = (0, 1, 2);
        let mut published = Vec::new();
        for person in [seeker, offerer] {
            let invite = chats[helper].invite().unwrap();
            chats[person].accept_invite(&invite).unwrap();
            flush(&mut chats, &mut published);
        }
        for c in chats.iter_mut() {
            c.matching_action(Action::Enable { enabled: true }, None)
                .unwrap();
        }
        for (person, side, summary) in [
            (seeker, Side::Request, "Looking for a cargo bike"),
            (offerer, Side::Offer, "Offering a two-seat cargo bike"),
        ] {
            chats[person]
                .matching_action(
                    Action::Share {
                        helper: owners[helper].to_hex(),
                        side,
                        summary: summary.into(),
                    },
                    None,
                )
                .unwrap();
        }
        flush(&mut chats, &mut published);
        let entries: Vec<_> = [seeker, offerer]
            .map(|person| *chats[person].state.matches.sent.keys().next().unwrap())
            .into();
        chats[helper]
            .matching_action(
                Action::Suggest {
                    left: entries[0],
                    right: entries[1],
                },
                None,
            )
            .unwrap();
        flush(&mut chats, &mut published);
        let proposal = *chats[seeker].state.matches.interests.keys().next().unwrap();
        // Introducing before both agree is refused.
        assert!(
            chats[helper]
                .matching_action(Action::Introduce { proposal }, None)
                .is_err()
        );
        for person in [seeker, offerer] {
            chats[person]
                .matching_action(
                    Action::Vote {
                        proposal,
                        accept: true,
                        invite: None,
                    },
                    None,
                )
                .unwrap();
        }
        flush(&mut chats, &mut published);
        chats[helper]
            .matching_action(Action::Introduce { proposal }, None)
            .unwrap();
        flush(&mut chats, &mut published);

        let chat_id = format!("{}{proposal}", super::super::match_chats::PREFIX);
        for person in [seeker, offerer] {
            let view = chats[person].matching_view().unwrap();
            assert_eq!(view["interests"][proposal.to_string()]["chat"], chat_id);
            assert!(view["interests"][proposal.to_string()]["contact"].is_null());
            let thread = chats[person]
                .conversations()
                .into_iter()
                .find(|c| c.id == chat_id)
                .expect("introduced chat");
            assert!(thread.name.starts_with("Private match"));
            assert_eq!(thread.messages[0].text, super::super::match_chats::HELLO);
        }
        chats[offerer]
            .send(&chat_id, "It is still available")
            .unwrap();
        chats[seeker].send(&chat_id, "Great, thanks").unwrap();
        flush(&mut chats, &mut published);
        for person in [seeker, offerer] {
            let thread = chats[person]
                .conversations()
                .into_iter()
                .find(|c| c.id == chat_id)
                .unwrap();
            let texts: Vec<_> = thread.messages.iter().map(|m| m.text.as_str()).collect();
            assert!(texts.contains(&"It is still available"), "{texts:?}");
            assert!(texts.contains(&"Great, thanks"), "{texts:?}");
            assert!(
                thread
                    .messages
                    .iter()
                    .all(|m| !m.mine || m.delivery == "sent")
            );
        }

        // Neither person learns the other's account, in views or decrypted state.
        for (me, other) in [(seeker, offerer), (offerer, seeker)] {
            let visible = serde_json::json!({
                "conversations": chats[me].conversations(),
                "matching": chats[me].matching_view(),
            })
            .to_string();
            assert!(!visible.contains(&owners[other].to_hex()));
            assert!(!visible.contains("#%7B"), "invitation leaked into a view");
            let private = serde_json::to_string(&chats[me].state.aliases).unwrap();
            assert!(!private.contains(&owners[other].to_hex()));
            assert!(!private.contains(&owners[me].to_hex()));
        }
        // No published event is signed by, or names, an account in plaintext.
        for event in &published {
            let raw = event.as_json();
            for owner in &owners {
                assert_ne!(event.pubkey, *owner);
                assert!(!raw.contains(&owner.to_hex()));
            }
        }
        // Alias traffic uses its own receive scopes, apart from account scopes.
        for person in [seeker, offerer] {
            let scopes = chats[person].subscriptions();
            assert!(
                scopes
                    .iter()
                    .any(|s| s.scope.starts_with("private-match-session-"))
            );
        }
        // Reopening keeps the connected chat and nothing else.
        let keys = chats[seeker].keys.clone();
        drop(chats.remove(seeker));
        let reopened = Messaging::open(dirs[seeker].path(), keys).unwrap();
        assert!(reopened.conversations().iter().any(|c| c.id == chat_id));
    }

    #[test]
    fn helpers_refuse_to_mix_alias_and_account_introductions() {
        let owner = Keys::generate().public_key();
        let (a, b) = (Keys::generate().public_key(), Keys::generate().public_key());
        let at = 1000;
        let mut book = Book::default();
        book.apply(owner, Action::Enable { enabled: true }, at, None)
            .unwrap();
        for (peer, side) in [(a, Side::Request), (b, Side::Offer)] {
            book.receive(
                owner,
                peer,
                Wire::Share {
                    entry: Entry {
                        id: Uuid::new_v4(),
                        side,
                        summary: "Cargo bike".into(),
                        expires_at: at + WEEK,
                    },
                },
                at,
                at,
            );
        }
        let ids: Vec<_> = book.received.keys().copied().collect();
        let sends = book
            .apply(
                owner,
                Action::Suggest {
                    left: ids[0],
                    right: ids[1],
                },
                at,
                None,
            )
            .unwrap();
        let Wire::Suggest { proposal, .. } = sends[0].1.clone() else {
            panic!()
        };
        let alias = Keys::generate().public_key();
        let url = invite_url(
            &Invite::create_new(alias, None, Some(1)).unwrap(),
            "https://market.iris.to/invite",
        )
        .unwrap();
        for (i, peer) in [book.received[&ids[0]].peer, book.received[&ids[1]].peer]
            .into_iter()
            .enumerate()
        {
            book.receive(
                owner,
                peer,
                Wire::Vote {
                    proposal,
                    accept: true,
                    expires_at: at + WEEK,
                    invite: (i == 0).then(|| url.clone()),
                },
                at,
                at,
            );
        }
        let err = book
            .apply(owner, Action::Introduce { proposal }, at, None)
            .err()
            .unwrap();
        assert!(err.contains("update"));
    }

    #[test]
    fn pending_entries_survive_restart_but_withdrawn_or_expired_entries_do_not_return() {
        let owner = Keys::generate().public_key();
        let sender = Keys::generate().public_key();
        let at = 1000;
        let entry = Entry {
            id: Uuid::new_v4(),
            side: Side::Offer,
            summary: "Cargo bike".into(),
            expires_at: at + WEEK,
        };
        let mut book = Book::default();
        book.apply(owner, Action::Enable { enabled: true }, at, None)
            .unwrap();
        let share = Wire::Share {
            entry: entry.clone(),
        };
        book.receive(owner, sender, share.clone(), at, at);
        let mut restored: Book =
            serde_json::from_slice(&serde_json::to_vec(&book).unwrap()).unwrap();
        assert_eq!(restored.received[&entry.id].entry.summary, "Cargo bike");
        restored.receive(
            owner,
            sender,
            Wire::Withdraw {
                entry: entry.id,
                expires_at: entry.expires_at,
            },
            at + 1,
            at + 1,
        );
        restored.receive(owner, sender, share.clone(), at, at + 2);
        assert!(restored.received.is_empty());
        assert!(book.expired(at + WEEK));
        book.prune(at + WEEK);
        book.receive(owner, sender, share, at, at + WEEK);
        assert!(book.received.is_empty());
    }
}
