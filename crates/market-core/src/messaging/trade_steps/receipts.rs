//! Receipt hints for the inbox. Money actions always revalidate the full private journal.
use super::{Record, invitation_hash, invite_matches};
use nostr::PublicKey;
use std::collections::{HashMap, HashSet};

type Marker<'a> = (&'a str, &'a str, &'a str, &'a str, PublicKey, &'a str);

pub(super) struct Receipts<'a> {
    approved: HashMap<(&'a str, &'a str), &'a str>,
    observed: HashSet<Marker<'a>>,
    updated: HashSet<&'a str>,
    declined: HashSet<(&'a str, &'a str, PublicKey)>,
    consented: HashSet<(&'a str, &'a str, PublicKey)>,
}
impl<'a> Receipts<'a> {
    pub(super) fn new(rows: &'a [Record], owner: PublicKey) -> Self {
        let mut receipts = Self {
            approved: HashMap::new(),
            observed: HashSet::new(),
            updated: HashSet::new(),
            declined: HashSet::new(),
            consented: HashSet::new(),
        };
        for r in rows {
            let s = &r.step;
            let actor = if r.mine { owner } else { r.peer };
            let (Some(id), Some(deal), Some(action)) = (
                s["trade_id"].as_str(),
                s["deal_hash"].as_str(),
                s["action"].as_str(),
            ) else {
                continue;
            };
            if action == "decline" {
                receipts.declined.insert((id, deal, actor));
            }
            let Some(terms) = s["terms_hash"]
                .as_str()
                .filter(|s| nostr::EventId::from_hex(s).is_ok())
            else {
                continue;
            };
            if action == "approve" {
                receipts.consented.insert((id, deal, actor));
            }
            if matches!(action, "settled" | "dispute") {
                receipts.updated.insert(id);
            }
            if r.mine && action == "approve" {
                receipts.approved.insert((id, deal), terms);
            }
            let direction = s["direction"]
                .as_str()
                .filter(|d| matches!(*d, "release" | "refund"))
                .unwrap_or("");
            receipts
                .observed
                .insert((id, deal, terms, action, actor, direction));
        }
        receipts
    }
    pub(super) fn for_invite(&self, r: &Record, owner: PublicKey) -> Option<&'static str> {
        let s = &r.step;
        if s["action"] != "invite"
            || (self.declined.is_empty() && !self.updated.contains(s["trade_id"].as_str()?))
        {
            return None;
        }
        let actor = if r.mine { owner } else { r.peer };
        if !invite_matches(s, &actor.to_hex(), &owner.to_hex()) {
            return None;
        }
        let d = &s["deal"];
        let id = s["trade_id"].as_str()?;
        let digest = invitation_hash(d);
        let key = |field: &str| PublicKey::from_hex(d[field].as_str()?).ok();
        let funder = key("funder")?;
        let beneficiary = key("beneficiary")?;
        let provider = key("provider")?;
        if [funder, beneficiary, provider].iter().any(|actor| {
            let key = (id, digest.as_str(), *actor);
            self.declined.contains(&key) && !self.consented.contains(&key)
        }) {
            return Some("declined");
        }
        let terms = self.approved.get(&(id, digest.as_str()))?;
        let has = |action: &str, actor: PublicKey, direction: &str| {
            self.observed
                .contains(&(id, digest.as_str(), *terms, action, actor, direction))
        };
        if !has("funded", funder, "") {
            return None;
        }
        let disputed = has("dispute", funder, "") || has("dispute", beneficiary, "");
        for (direction, payee, other) in [
            ("release", beneficiary, funder),
            ("refund", funder, beneficiary),
        ] {
            if has("payout", payee, direction)
                && has("settled", payee, direction)
                && (has("cosign", other, direction)
                    || disputed && has("cosign", provider, direction))
            {
                return Some(direction);
            }
        }
        disputed.then_some("disputed")
    }
}
