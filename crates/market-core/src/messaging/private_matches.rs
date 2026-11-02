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
}

#[derive(Clone, Serialize, Deserialize)]
struct Interest {
    helper: PublicKey,
    entry: Uuid,
    summary: String,
    expires_at: u64,
    vote: Option<bool>,
    contact: Option<PublicKey>,
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
    },
    Introduce {
        proposal: Uuid,
        contact: PublicKey,
        expires_at: u64,
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
        helper: PublicKey,
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
                    },
                );
            }
            Action::Vote { proposal, accept } => {
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
                for (peer, contact) in [(a, b), (b, a)] {
                    sends.push((
                        peer,
                        Wire::Introduce {
                            proposal,
                            contact,
                            expires_at: p.expires_at,
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
                    });
                }
            }
            Wire::Vote {
                proposal,
                accept,
                expires_at,
            } => {
                if let Some(p) = self.pairs.get_mut(&proposal)
                    && p.expires_at == expires_at
                {
                    for (i, e) in p.entries.iter().enumerate() {
                        if self.received.get(e).is_some_and(|r| r.peer == peer) {
                            p.votes[i].get_or_insert(accept);
                        }
                    }
                }
            }
            Wire::Introduce {
                proposal,
                contact,
                expires_at,
            } => {
                if let Some(p) = self.interests.get_mut(&proposal)
                    && p.helper == peer
                    && p.vote == Some(true)
                    && p.expires_at == expires_at
                    && contact != me
                    && contact != peer
                {
                    p.contact.get_or_insert(contact);
                }
            }
            Wire::PublicListing {
                entry,
                listing,
                title,
                expires_at,
            } if current(expires_at, now) && valid_summary(&title) => {
                if listing.len() <= 350
                    && valid_address(&listing)
                    && self
                        .sent
                        .get(&entry)
                        .is_some_and(|r| r.peer == peer && r.entry.expires_at == expires_at)
                    && self.public_leads.len() < CAP
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
            }
            _ => {}
        }
        self.prune(now);
    }
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
            w.len() > 1
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
        self.transaction(|m| {
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
    }
    pub(crate) fn matching_view(&self) -> Option<serde_json::Value> {
        if !self.state.matches.enabled {
            return None;
        }
        let mut book = self.state.matches.clone();
        book.prune(now());
        Some(
            serde_json::json!({"sent":book.sent,"received":book.received,"pairs":book.pairs,"interests":book.interests,"public_leads":book.public_leads}),
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
