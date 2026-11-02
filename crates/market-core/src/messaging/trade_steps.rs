//! Authenticated private wallet coordination. Keep proof material out of general snapshots.
use super::{Messaging, MessagingResult, PendingContactMessage, now};
use nostr::{EventBuilder, EventId, Kind, PublicKey, Tag, Timestamp, UnsignedEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
mod receipts;

const TAG: &str = "iris-market/escrow-trade";
pub(crate) const MAX_STEP: usize = 64 * 1024;
const MAX_PENDING_STEP: usize = 4 * 1024;
const MAX_PENDING_ROWS: usize = 128;
const MAX_ROWS: usize = 2048;
const ACTIONS: &[&str] = &[
    "invite", "join", "approve", "funded", "payout", "cosign", "settled", "dispute", "rated",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    id: EventId,
    peer: PublicKey,
    mine: bool,
    created_at: u64,
    operation_id: EventId,
    step: Value,
}

pub fn is_trade(event: &UnsignedEvent) -> bool {
    event.kind == Kind::from(14) && event.tags.iter().any(|tag| tag.as_slice()[0] == TAG)
}
fn valid(step: &Value) -> bool {
    step["v"].as_u64() == Some(1)
        && step["trade_id"]
            .as_str()
            .is_some_and(|id| EventId::from_hex(id).is_ok())
        && step["action"]
            .as_str()
            .is_some_and(|a| ACTIONS.contains(&a))
}
impl Record {
    fn summary(&self, outcome: Option<&str>) -> Value {
        let mut step =
            json!({"v":1, "trade_id":self.step["trade_id"], "action":self.step["action"]});
        if self.step["action"] == "invite" {
            let deal = &self.step["deal"];
            let mut public = json!({});
            for key in [
                "listing_id",
                "revision",
                "title",
                "maker",
                "taker",
                "buyer",
                "seller",
                "funder",
                "beneficiary",
                "provider",
                "mint",
            ] {
                if let Some(text) = deal[key].as_str().filter(|s| s.len() <= 2048) {
                    public[key] = Value::from(text);
                }
            }
            if let Some(sats) = deal["sats"]
                .as_u64()
                .filter(|n| (1..=1_000_000_000_000).contains(n))
            {
                public["sats"] = sats.into();
            }
            step["deal"] = public;
            if let Some(outcome) = outcome {
                step["outcome"] = outcome.into();
            }
        }
        json!({"id":self.id,"peer":self.peer,"mine":self.mine,"created_at":self.created_at,"operation_id":self.operation_id,"step":step})
    }
}

fn invite_matches(step: &Value, actor: &str, participant: &str) -> bool {
    let deal = &step["deal"];
    let parties = ["buyer", "seller", "provider"].map(|key| deal[key].as_str().unwrap_or(""));
    deal["taker"] == actor
        && parties[..2].contains(&actor)
        && parties.contains(&participant)
        && parties.iter().all(|key| PublicKey::from_hex(key).is_ok())
        && parties.iter().collect::<BTreeSet<_>>().len() == 3
}

// Matches the canonical JSON digest used by the shared trade screen.
fn invitation_hash(deal: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut sorted = deal.clone();
    sorted.sort_all_objects();
    format!("{:x}", Sha256::digest(sorted.to_string().as_bytes()))
}

impl Messaging {
    pub(crate) fn trade_steps(&self, private: bool) -> Vec<Value> {
        let rows = &self.state.trade_steps;
        if private {
            return rows.iter().map(|row| json!(row)).collect();
        }
        let receipts = receipts::Receipts::new(rows, self.owner);
        rows.iter()
            .map(|row| row.summary(receipts.for_invite(row, self.owner)))
            .collect()
    }
    pub(crate) fn send_trade_step(
        &mut self,
        peers: BTreeSet<PublicKey>,
        operation_id: EventId,
        step: Value,
    ) -> MessagingResult<()> {
        self.require_authorization()?;
        let payload = serde_json::to_string(&step).map_err(|_| "Invalid trade step")?;
        if !valid(&step)
            || payload.len() > MAX_STEP
            || !(1..=2).contains(&peers.len())
            || peers.contains(&self.owner)
            || peers.contains(&self.keys.public_key())
        {
            return Err("Invalid escrow action or recipients".into());
        }
        self.transaction(|this| {
            let previous: Vec<_> = this
                .state
                .trade_steps
                .iter()
                .filter(|r| r.mine && r.operation_id == operation_id)
                .collect();
            if !previous.is_empty() {
                if previous.iter().all(|r| r.step == step)
                    && previous.iter().map(|r| r.peer).collect::<BTreeSet<_>>() == peers
                {
                    return Ok(());
                }
                return Err("This escrow action was already used for different terms".into());
            }
            if this.state.trade_steps.len() + peers.len() > MAX_ROWS
                || this.state.outbox.len() + this.state.pending_contact_messages.len() + peers.len()
                    > super::MAX_OUTBOX
            {
                return Err("Private trade queue is full".into());
            }
            for peer in &peers {
                let peer_id = peer.to_hex();
                this.ensure_conversation(&peer_id)?;
                let ms = this.next_message_millis();
                let mut rumor = EventBuilder::new(Kind::from(14), "Private escrow update")
                    .tags([
                        Tag::public_key(*peer),
                        Tag::parse(["ms", &ms.to_string()]).map_err(super::protocol_error)?,
                        Tag::parse([TAG, "1", &operation_id.to_hex(), &payload])
                            .map_err(super::protocol_error)?,
                    ])
                    .custom_created_at(Timestamp::from(ms / 1000))
                    .build(this.keys.public_key());
                rumor.ensure_id();
                let id = rumor.id.ok_or("Missing escrow action identifier")?;
                this.state.trade_steps.push(Record {
                    id,
                    peer: *peer,
                    mine: true,
                    created_at: ms / 1000,
                    operation_id,
                    step: step.clone(),
                });
                this.state.pending_contact_messages.insert(
                    id.to_hex(),
                    PendingContactMessage {
                        peer_id,
                        rumor,
                        expires_at: None,
                    },
                );
            }
            Ok(())
        })
    }
    pub(super) fn receive_trade_step(&mut self, sender: PublicKey, rumor: &UnsignedEvent) {
        if sender == self.owner
            || !rumor.tags.public_keys().copied().eq([self.owner])
            || rumor.created_at.as_secs() > now() + 300
        {
            return;
        }
        let mut tags = rumor.tags.iter().map(Tag::as_slice).filter(|t| t[0] == TAG);
        let Some([_, version, operation, payload]) = tags.next() else {
            return;
        };
        if version != "1" || payload.len() > MAX_STEP || tags.next().is_some() {
            return;
        }
        let (Ok(step), Ok(operation_id), Some(id)) = (
            serde_json::from_str::<Value>(payload),
            EventId::from_hex(operation),
            rumor.id,
        ) else {
            return;
        };
        let rows = &mut self.state.trade_steps;
        let owner = self.owner.to_hex();
        let peer = sender.to_hex();
        let trade = &step["trade_id"];
        let action = step["action"].as_str().unwrap_or("");
        if !valid(&step)
            || (action == "invite" && !invite_matches(&step, &peer, &owner))
            || rows.iter().any(|r| {
                !r.mine && r.peer == sender && (r.operation_id == operation_id || r.step == step)
            })
        {
            return;
        }
        // Relay replay can deliver a provider's key before the invitation. Keep a
        // bounded set of small pending records until this device chooses to join.
        let joined: BTreeSet<_> = rows
            .iter()
            .filter(|r| r.mine && r.step["action"] == "join")
            .filter_map(|r| r.step["trade_id"].as_str())
            .map(str::to_owned)
            .collect();
        let pinned = rows
            .iter()
            .find(|r| r.mine && r.step["trade_id"] == *trade && r.step["action"] == "join");
        if let Some(join) = pinned {
            let expected = &join.step["deal_hash"];
            if (action == "invite" && invitation_hash(&step["deal"]) != *expected)
                || (action != "invite" && step["deal_hash"] != *expected)
            {
                return;
            }
            // Pick the invitation approved by this wallet even if a stranger reuses the trade ID.
            let authorized = rows.iter().any(|r| {
                if r.step["trade_id"] != *trade || r.step["action"] != "invite" {
                    return false;
                }
                let taker = if r.mine { &owner } else { &r.peer.to_hex() };
                invite_matches(&r.step, taker, &peer)
                    && invitation_hash(&r.step["deal"]) == join.step["deal_hash"]
                    && (action != "funded" || r.step["deal"]["funder"] == peer)
            });
            if !authorized {
                return;
            }
        } else if !matches!(action, "invite" | "join") || payload.len() > MAX_PENDING_STEP {
            return;
        }
        // Two distinct copies are sufficient to detect conflicting keys or proposals.
        if rows
            .iter()
            .filter(|r| {
                !r.mine
                    && r.peer == sender
                    && r.step["trade_id"] == *trade
                    && r.step["action"] == action
                    && r.step["direction"].as_str().filter(|d| *d == "refund")
                        == step["direction"].as_str().filter(|d| *d == "refund")
            })
            .take(2)
            .count()
            == 2
        {
            return;
        }
        let pending =
            |r: &Record| !r.mine && !joined.contains(r.step["trade_id"].as_str().unwrap_or(""));
        if rows.len() >= MAX_ROWS
            || (pinned.is_none() && rows.iter().filter(|r| pending(r)).count() >= MAX_PENDING_ROWS)
        {
            if let Some(first) = rows.iter().position(pending) {
                rows.remove(first);
            } else {
                return;
            }
        }
        self.state.trade_steps.push(Record {
            id,
            peer: sender,
            mine: false,
            created_at: rumor.created_at.as_secs(),
            operation_id,
            step,
        });
    }
}

#[cfg(test)]
mod tests;
