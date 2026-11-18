//! A private statement of collection and the merchant's separate signed handover.
//! The signatures only bind the shared pickup reference and expected participants.
use super::*;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

pub(crate) const ACK: &str = "iris-market/pickup-ack";
pub(crate) const RECEIPT: &str = "iris-market/pickup-receipt";
const DOMAIN: &str = "iris-market/handoff";
const WRONG: &str = "This proof does not match this pickup";
const STALE: &str = "Pickup acknowledgment expired. Ask the collector for a fresh code";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PickupReceiptRole {
    Collector,
    Merchant,
    Observer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickupReceiptView {
    pub state: String,
    pub collected_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousPickupReceipt {
    pub reference: String,
    pub collected_at: u64,
    pub confirmed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Scope<T = String> {
    reference: T,
    merchant: T,
    collector: T,
    key: T,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Statement {
    reference: String,
    at: u64,
    signature: String,
    confirmed: Option<(u64, String)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Saved {
    scope: Scope,
    statement: Statement,
}

fn fresh(at: u64, now: u64) -> bool {
    at >= now.saturating_sub(120) && at <= now.saturating_add(15)
}

fn active(order: &Order) -> bool {
    matches!(order.status, OrderStatus::Accepted | OrderStatus::InTransit)
}

impl<'a> Scope<&'a str> {
    fn for_order(o: &'a Order) -> Option<Self> {
        let (reference, merchant, collector, key) = if let Some(service) = &o.delivery_request {
            let c = service.collection.as_ref()?;
            (&c.reference, &c.merchant, &o.seller, &o.seller)
        } else if o.fulfillment == Some(Fulfillment::Pickup) {
            let h = o.recipient_handoff.as_ref()?;
            (&h.id, &o.seller, &o.buyer, &h.key)
        } else {
            let a = o.pickup_authorization.as_ref()?;
            if a.courier_pubkey == o.buyer {
                return None;
            }
            (
                &a.reference,
                &o.seller,
                &a.courier_pubkey,
                &a.courier_pubkey,
            )
        };
        if merchant == collector || merchant == key {
            return None;
        }
        handoff::reference(reference)?;
        Some(Self {
            reference,
            merchant,
            collector,
            key,
        })
    }
}
impl<T: AsRef<str>> Scope<T> {
    fn role(&self, order: &Order, owner: &str) -> Option<PickupReceiptRole> {
        if owner == self.collector.as_ref() {
            Some(PickupReceiptRole::Collector)
        } else if owner == self.merchant.as_ref() && order.delivery_request.is_none() {
            Some(PickupReceiptRole::Merchant)
        } else if owner == order.buyer {
            Some(PickupReceiptRole::Observer)
        } else {
            None
        }
    }
}
impl Scope {
    fn from_order(order: &Order) -> Option<Self> {
        let s = Scope::for_order(order)?;
        Some(Self {
            reference: s.reference.into(),
            merchant: s.merchant.into(),
            collector: s.collector.into(),
            key: s.key.into(),
        })
    }
    fn borrowed(&self) -> Scope<&str> {
        Scope {
            reference: &self.reference,
            merchant: &self.merchant,
            collector: &self.collector,
            key: &self.key,
        }
    }
    fn event(&self, at: u64, collected: Option<&str>) -> Result<UnsignedEvent> {
        let (step, other, key) = match collected {
            None => ("collect", self.merchant.as_str(), &self.key),
            Some(id) => ("release", id, &self.merchant),
        };
        let tag = Tag::parse([DOMAIN, "2", step, &self.reference, other]).map_err(|_| WRONG)?;
        Ok(EventBuilder::new(Kind::from(27835), "")
            .tag(tag)
            .custom_created_at(Timestamp::from(at))
            .build(PublicKey::from_hex(key).map_err(|_| WRONG)?))
    }
    fn verify(&self, s: &Statement, now: u64) -> Result<String> {
        require(s.reference == self.reference, WRONG)?;
        let signed = self
            .event(s.at, None)?
            .add_signature(s.signature.parse().map_err(|_| WRONG)?)
            .map_err(|_| WRONG)?;
        let id = signed.id.to_hex();
        if let Some((confirmed, sig)) = &s.confirmed {
            require(
                *confirmed <= now.saturating_add(15) && fresh(s.at, *confirmed),
                WRONG,
            )?;
            self.event(*confirmed, Some(&id))?
                .add_signature(sig.parse().map_err(|_| WRONG)?)
                .map_err(|_| WRONG)?;
        } else {
            require(fresh(s.at, now), STALE)?;
        }
        Ok(id)
    }
}

impl Statement {
    pub(crate) fn parse(fields: &[String]) -> Option<Self> {
        fn at(s: &str) -> Option<u64> {
            s.parse::<u64>().ok().filter(|t| t.to_string() == s)
        }
        fn sig(s: &str) -> bool {
            s.len() == 128
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        let [domain, v, r, t, sig1, rest @ ..] = fields else {
            return None;
        };
        if v != "1" || handoff::reference(r).is_none() || !sig(sig1) {
            return None;
        }
        let confirmed = match (domain.as_str(), rest) {
            (ACK, []) => None,
            (RECEIPT, [t2, sig2]) if sig(sig2) => Some((at(t2)?, sig2.clone())),
            _ => return None,
        };
        Some(Self {
            reference: r.clone(),
            at: at(t)?,
            signature: sig1.clone(),
            confirmed,
        })
    }
    pub(crate) fn fields(&self) -> Vec<String> {
        let mut f = vec![
            if self.confirmed.is_some() {
                RECEIPT
            } else {
                ACK
            }
            .into(),
            "1".into(),
            self.reference.clone(),
            self.at.to_string(),
            self.signature.clone(),
        ];
        if let Some((at, sig)) = &self.confirmed {
            f.extend([at.to_string(), sig.clone()]);
        }
        f
    }
    fn qr(&self) -> String {
        let f = self.fields();
        let prefix = if self.confirmed.is_some() {
            "iris-pickup-receipt:1"
        } else {
            "iris-handoff:2:pickup"
        };
        format!("{prefix}:{}", f[2..].join(":"))
    }
    pub(crate) fn from_qr(raw: &str, complete: bool) -> Result<Self> {
        let (prefix, limit, tag) = if complete {
            ("iris-pickup-receipt:1:", 384, RECEIPT)
        } else {
            ("iris-handoff:2:pickup:", 220, ACK)
        };
        require(raw.is_ascii() && raw.len() <= limit, WRONG)?;
        let mut fields = vec![tag.into(), "1".into()];
        fields.extend(
            raw.strip_prefix(prefix)
                .ok_or(WRONG)?
                .split(':')
                .map(str::to_string),
        );
        Self::parse(&fields).ok_or_else(|| WRONG.into())
    }
    pub(crate) fn expires_at(&self) -> Option<u64> {
        self.confirmed
            .is_none()
            .then(|| self.at.saturating_add(121))
    }
}

impl Record {
    fn recorded_pickups<'a>(&'a self, owner: &'a str) -> impl Iterator<Item = &'a Saved> {
        self.previous_pickups
            .iter()
            .chain(self.pickup_receipt.iter())
            .filter(move |s| {
                s.statement.confirmed.is_some() && s.scope.role(&self.order, owner).is_some()
            })
    }
    pub(super) fn previous_receipt_views(&self, owner: &str) -> Vec<PreviousPickupReceipt> {
        if self.previous_pickups.is_empty()
            && self
                .pickup_receipt
                .as_ref()
                .is_none_or(|s| s.statement.confirmed.is_none())
        {
            return Vec::new();
        }
        let current = Scope::for_order(&self.order);
        self.recorded_pickups(owner)
            .filter(|saved| Some(saved.scope.borrowed()) != current)
            .filter_map(|saved| {
                Some(PreviousPickupReceipt {
                    reference: saved.scope.reference.clone(),
                    collected_at: saved.statement.at,
                    confirmed_at: saved.statement.confirmed.as_ref()?.0,
                })
            })
            .collect()
    }
    pub(super) fn pickup_view(
        &self,
        owner: &str,
    ) -> (Option<PickupReceiptRole>, Option<PickupReceiptView>) {
        if self.order.status == OrderStatus::Requested {
            return (None, None);
        }
        let Some(scope) = Scope::for_order(&self.order) else {
            return (None, None);
        };
        let saved = self
            .pickup_receipt
            .as_ref()
            .filter(|s| s.scope.borrowed() == scope);
        let role = scope.role(&self.order, owner);
        let view = saved
            .filter(|s| {
                s.statement.confirmed.is_some() || role != Some(PickupReceiptRole::Observer)
            })
            .and_then(|s| {
                Some(PickupReceiptView {
                    state: if s.statement.confirmed.is_some() {
                        "confirmed"
                    } else if role? == PickupReceiptRole::Merchant {
                        "awaiting-confirmation"
                    } else {
                        "acknowledged"
                    }
                    .into(),
                    collected_at: s.statement.at,
                    confirmed_at: s.statement.confirmed.as_ref().map(|c| c.0),
                })
            });
        (role, view)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PendingPickup {
    sender: String,
    statement: Statement,
    received_at: u64,
}

#[derive(Debug)]
pub(crate) struct PickupChange {
    pub statement: Statement,
    pub recipients: Vec<String>,
}
impl OrderBook {
    pub(crate) fn pickup_peers(&self, owner: &str) -> BTreeSet<String> {
        self.records
            .values()
            .filter_map(|r| {
                let scope = Scope::for_order(&r.order)?;
                match scope.role(&r.order, owner)? {
                    PickupReceiptRole::Merchant if active(&r.order) => {
                        Some(scope.collector.to_owned())
                    }
                    PickupReceiptRole::Collector
                        if active(&r.order)
                            || r.order.status.terminal()
                                && r.pickup_receipt.as_ref().is_none_or(|s| {
                                    s.scope.borrowed() != scope || s.statement.confirmed.is_none()
                                }) =>
                    {
                        Some(scope.merchant.to_owned())
                    }
                    _ => None,
                }
            })
            .collect()
    }
    pub(crate) fn receive_pickup(&mut self, owner: &str, sender: &str, s: Statement, now: u64) {
        if self
            .accept_pickup(None, owner, Some(sender), &s, now)
            .is_ok()
        {
            return;
        }
        // An authenticated merchant's receipt can overtake the booking. Retain only
        // bounded candidates and verify against trusted order state before exposing one.
        if s.confirmed.is_none() || !self.should_wait_for_pickup(owner, sender, &s, now) {
            return;
        }
        self.pending_pickups
            .retain(|p| p.received_at.saturating_add(30 * 86400) > now);
        if self.pending_pickups.len() < 64
            && self
                .pending_pickups
                .iter()
                .filter(|p| p.sender == sender)
                .count()
                < 8
            && !self
                .pending_pickups
                .iter()
                .any(|p| p.sender == sender && p.statement == s)
        {
            self.pending_pickups.push(PendingPickup {
                sender: sender.into(),
                statement: s,
                received_at: now,
            });
        }
    }
    fn should_wait_for_pickup(&self, owner: &str, sender: &str, s: &Statement, now: u64) -> bool {
        let Some((at, _)) = &s.confirmed else {
            return false;
        };
        if *at > now.saturating_add(15) || !fresh(s.at, *at) {
            return false;
        }
        let mut unknown = true;
        for r in self.records.values() {
            let Some(scope) = Scope::from_order(&r.order) else {
                continue;
            };
            if scope.reference != s.reference {
                continue;
            }
            unknown = false;
            if r.order.status == OrderStatus::Requested
                && scope.merchant == sender
                && scope.role(&r.order, owner).is_some()
                && scope.verify(s, now).is_ok()
            {
                return true;
            }
        }
        unknown
    }
    pub(crate) fn resolve_pending_pickups(&mut self, owner: &str, now: u64) {
        for p in std::mem::take(&mut self.pending_pickups) {
            if p.received_at.saturating_add(30 * 86400) > now
                && self
                    .accept_pickup(None, owner, Some(&p.sender), &p.statement, now)
                    .is_err()
                && self.should_wait_for_pickup(owner, &p.sender, &p.statement, now)
            {
                self.pending_pickups.push(p);
            }
        }
    }
    // One organizer may own both a product and its separately booked delivery.
    // A coincident or deliberately reused reference on unrelated orders is ambiguous.
    fn pickup_records(&self, scope: &Scope, owner: &str) -> Result<Vec<String>> {
        let mut records = Vec::new();
        for r in self.records.values() {
            let current = Scope::for_order(&r.order);
            // Replacing the assignee cannot repurpose a reference with recorded
            // signatures, even when the original assignment has been cleared.
            for old in r.previous_pickups.iter().chain(&r.pickup_receipt) {
                if old.scope.reference == scope.reference {
                    require(
                        old.scope == *scope && current.as_ref() == Some(&old.scope.borrowed()),
                        WRONG,
                    )?;
                }
            }
            let Some(s) = current else { continue };
            if s.reference != scope.reference || s.role(&r.order, owner).is_none() {
                continue;
            }
            require(s == scope.borrowed(), WRONG)?;
            records.push(r);
        }
        match records.as_slice() {
            [_] => {}
            [a, b]
                if (a.delivery_order_id.as_ref() == Some(&b.order.id)
                    && b.source_order_id.as_ref() == Some(&a.order.id))
                    || (b.delivery_order_id.as_ref() == Some(&a.order.id)
                        && a.source_order_id.as_ref() == Some(&b.order.id)) => {}
            _ => return Err("No unique order matches this pickup".into()),
        }
        Ok(records.iter().map(|r| r.order.id.clone()).collect())
    }
    fn pickup_scope(&self, id: &str, owner: &str, role: PickupReceiptRole) -> Result<Scope> {
        let r = self.records.get(id).ok_or(WRONG)?;
        let s = Scope::from_order(&r.order).ok_or(WRONG)?;
        require(
            active(&r.order) && s.role(&r.order, owner) == Some(role),
            "This pickup action is unavailable for this order",
        )?;
        let records = self.pickup_records(&s, owner)?;
        require(
            records
                .iter()
                .all(|id| !self.records[id].order.status.terminal()),
            "This pickup order has already finished",
        )?;
        Ok(s)
    }
    fn store_pickup(&mut self, ids: &[String], scope: &Scope, s: &Statement) -> Result<()> {
        for id in ids {
            let r = &self.records[id];
            require(
                r.pickup_receipt.as_ref().is_none_or(|old| {
                    old.scope == *scope
                        || old.statement.confirmed.is_none()
                        || r.previous_pickups.len() < 7
                }),
                "This order already has eight pickup receipts",
            )?;
            require(
                !r.previous_pickups
                    .iter()
                    .any(|old| old.scope.reference == scope.reference),
                "This pickup already has a receipt",
            )?;
        }
        for id in ids {
            let r = self.records.get_mut(id).expect("resolved pickup order");
            if r.pickup_receipt.as_ref().is_some_and(|old| {
                old.scope == *scope
                    && (old.statement.confirmed.is_some()
                        || s.confirmed.is_none() && old.statement.at >= s.at)
            }) {
                continue;
            }
            if let Some(previous) = r.pickup_receipt.take()
                && previous.scope != *scope
                && previous.statement.confirmed.is_some()
            {
                r.previous_pickups.push(previous);
            }
            r.pickup_receipt = Some(Saved {
                scope: scope.clone(),
                statement: s.clone(),
            });
        }
        Ok(())
    }
    pub(crate) fn acknowledge_pickup(
        &mut self,
        id: &str,
        owner: &str,
        device: &Keys,
        account: Option<&Keys>,
        now: u64,
    ) -> Result<(String, Option<PickupChange>)> {
        let scope = self.pickup_scope(id, owner, PickupReceiptRole::Collector)?;
        if let Some(old) = self.records[id]
            .pickup_receipt
            .as_ref()
            .filter(|s| s.scope == scope)
        {
            require(
                old.statement.confirmed.is_none(),
                "This pickup already has a receipt",
            )?;
            if fresh(old.statement.at, now) {
                return Ok((old.statement.qr(), None));
            }
        }
        let derived;
        let keys = if scope.key == scope.collector {
            account.ok_or("Use the device that holds your courier profile key")?
        } else {
            derived = handoff::recipient_keys(device, &scope.reference)?;
            &derived
        };
        require(
            keys.public_key().to_hex() == scope.key,
            "Use the device that placed this order",
        )?;
        let signature = scope
            .event(now, None)?
            .sign_with_keys(keys)
            .map_err(|_| WRONG)?
            .sig
            .to_string();
        let s = Statement {
            reference: scope.reference.clone(),
            at: now,
            signature,
            confirmed: None,
        };
        let ids = self.pickup_records(&scope, owner)?;
        self.store_pickup(&ids, &scope, &s)?;
        Ok((
            s.qr(),
            Some(PickupChange {
                statement: s,
                recipients: vec![scope.merchant],
            }),
        ))
    }
    pub(crate) fn confirm_pickup(
        &mut self,
        id: &str,
        owner: &str,
        account: Option<&Keys>,
        now: u64,
    ) -> Result<Option<PickupChange>> {
        let scope = self.pickup_scope(id, owner, PickupReceiptRole::Merchant)?;
        let record = &self.records[id];
        let mut s = record
            .pickup_receipt
            .as_ref()
            .filter(|s| s.scope == scope)
            .ok_or("Check the collector’s acknowledgment first")?
            .statement
            .clone();
        if s.confirmed.is_some() {
            return Ok(None);
        }
        let collected = scope.verify(&s, now)?;
        let keys = account
            .filter(|keys| keys.public_key().to_hex() == scope.merchant)
            .ok_or("Confirm on the device that holds your merchant profile key")?;
        let sig = scope
            .event(now, Some(&collected))?
            .sign_with_keys(keys)
            .map_err(|_| WRONG)?
            .sig
            .to_string();
        s.confirmed = Some((now, sig));
        let recipients = [record.order.buyer.clone(), scope.collector.clone()]
            .into_iter()
            .filter(|s| s != owner)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let ids = self.pickup_records(&scope, owner)?;
        self.store_pickup(&ids, &scope, &s)?;
        Ok(Some(PickupChange {
            statement: s,
            recipients,
        }))
    }
    pub(crate) fn pickup_receipt_qr(
        &self,
        id: &str,
        owner: &str,
        reference: Option<&str>,
    ) -> Result<String> {
        let r = self.records.get(id).ok_or(WRONG)?;
        let current = Scope::from_order(&r.order);
        let mut matches = r.recorded_pickups(owner).filter(|s| match reference {
            Some(reference) => reference == s.scope.reference,
            None => current.as_ref().is_none_or(|c| c == &s.scope),
        });
        let saved = matches
            .next()
            .ok_or("This pickup has no completed receipt")?;
        require(
            matches.next().is_none(),
            "Choose which pickup receipt to show",
        )?;
        Ok(saved.statement.qr())
    }
    pub(crate) fn accept_pickup(
        &mut self,
        selected: Option<&str>,
        owner: &str,
        sender: Option<&str>,
        s: &Statement,
        now: u64,
    ) -> Result<()> {
        if let Some(r) = selected.and_then(|id| self.records.get(id))
            && r.recorded_pickups(owner).any(|old| {
                &old.statement == s
                    && old.scope.role(&r.order, owner) != Some(PickupReceiptRole::Merchant)
            })
            && sender.is_none()
        {
            return Ok(());
        }
        let r = if let Some(id) = selected {
            self.records.get(id)
        } else {
            self.records.values().find(|r| {
                Scope::from_order(&r.order).is_some_and(|scope| {
                    scope.reference == s.reference && scope.role(&r.order, owner).is_some()
                })
            })
        }
        .ok_or(WRONG)?;
        let scope = Scope::from_order(&r.order).ok_or(WRONG)?;
        let ids = self.pickup_records(&scope, owner)?;
        let candidates = ids
            .iter()
            .filter_map(|id| self.records.get(id))
            .filter(|r| selected.is_none_or(|id| r.order.id == id));
        let confirmed = s.confirmed.as_ref().map(|c| c.0);
        // A locally linked terminal delivery cannot be used to start a new pickup
        // through its still-open product order, or to backfill a later signature.
        require(
            ids.iter().all(|id| {
                let r = &self.records[id];
                !r.order.status.terminal()
                    || confirmed.is_some_and(|at| {
                        at <= r.closed_at.unwrap_or(r.order.updated_at).saturating_add(15)
                    })
            }),
            WRONG,
        )?;
        let authorized = candidates.into_iter().any(|r| {
            let role = scope.role(&r.order, owner);
            let valid_time = s.at.saturating_add(15) >= r.order.created_at;
            if confirmed.is_some() {
                valid_time
                    && (active(&r.order) || r.order.status.terminal())
                    && role.is_some()
                    && sender.is_none_or(|p| p == scope.merchant)
                    && (sender.is_some() || role != Some(PickupReceiptRole::Merchant))
            } else {
                valid_time
                    && active(&r.order)
                    && (role == Some(PickupReceiptRole::Merchant)
                        || role == Some(PickupReceiptRole::Collector) && sender == Some(owner))
                    && sender.is_none_or(|p| p == scope.collector)
            }
        });
        require(authorized, WRONG)?;
        scope.verify(s, now)?;
        self.store_pickup(&ids, &scope, s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> (OrderBook, Statement, String, String) {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../shared/pickup-receipt-vector.json"
        ))
        .unwrap();
        let receipt = Statement::from_qr(v["receiptQr"].as_str().unwrap(), true).unwrap();
        let buyer = Keys::generate().public_key().to_hex();
        let merchant = v["merchant"].as_str().unwrap().to_owned();
        let order=serde_json::from_value(json!({"id":"product","buyer":buyer,"seller":merchant,"items":[],"shipment":{"stops":[]},"status":"accepted","createdAt":receipt.at-60,"updatedAt":receipt.at-30,"pickupAuthorization":{"courierPubkey":v["collectorKey"],"reference":receipt.reference},"fulfillment":"merchant-delivery"})).unwrap();
        let r: Record = Record {
            order,
            source_order_id: None,
            delivery_order_id: None,
            pickup_receipt: None,
            previous_pickups: vec![],
            closed_at: None,
            clocks: BTreeMap::new(),
            archived: false,
            checked_handoffs: BTreeSet::new(),
        };
        let mut book = OrderBook::default();
        book.records.insert("product".into(), r);
        (book, receipt, buyer, merchant)
    }

    #[test]
    fn late_and_reordered_receipts_require_matching_author_and_original_close_time() {
        let (mut b, p, owner, merchant) = sample();
        let now = p.at + 86400;
        let auth = b
            .records
            .get_mut("product")
            .unwrap()
            .order
            .pickup_authorization
            .take()
            .unwrap();
        b.receive_pickup(&owner, &merchant, p.clone(), now);
        assert_eq!(b.pending_pickups.len(), 1);
        assert!(b.records["product"].pickup_view(&owner).1.is_none());
        b = serde_json::from_value(serde_json::to_value(b).unwrap()).unwrap();
        let r = b.records.get_mut("product").unwrap();
        r.order.pickup_authorization = Some(auth);
        r.order.status = OrderStatus::Cancelled;
        r.closed_at = Some(p.at + 10);
        r.order.updated_at = now; // Later bookkeeping must never extend the handover window.
        assert!(
            b.accept_pickup(Some("product"), &owner, Some(&merchant), &p, now)
                .is_err()
        );
        b.records.get_mut("product").unwrap().closed_at = Some(p.at + 25);
        assert!(
            b.accept_pickup(Some("product"), &owner, Some(&owner), &p, now)
                .is_err()
        );
        b.resolve_pending_pickups(&owner, now);
        assert!(b.pending_pickups.is_empty());
        assert_eq!(
            b.pickup_receipt_qr("product", &owner, None).unwrap(),
            p.qr()
        );
    }

    #[test]
    fn completed_receipt_survives_assignment_changes_without_authorizing_another_handover() {
        let (mut b, p, owner, merchant) = sample();
        b.receive_pickup(&owner, &merchant, p.clone(), p.at + 31);
        let mut reused = b.clone();
        reused
            .records
            .get_mut("product")
            .unwrap()
            .order
            .pickup_authorization
            .as_mut()
            .unwrap()
            .courier_pubkey = Keys::generate().public_key().to_hex();
        let scope = Scope::from_order(&reused.records["product"].order).unwrap();
        assert!(reused.pickup_records(&scope, &owner).is_err());
        let other = Uuid::new_v4().to_string();
        let r = b.records.get_mut("product").unwrap();
        r.order.pickup_authorization.as_mut().unwrap().reference = other;
        assert!(r.pickup_view(&owner).1.is_none());
        assert_eq!(r.previous_receipt_views(&owner)[0].reference, p.reference);
        assert!(b.pickup_receipt_qr("product", &owner, None).is_err());
        assert_eq!(
            b.pickup_receipt_qr("product", &owner, Some(&p.reference))
                .unwrap(),
            p.qr()
        );
        b.accept_pickup(Some("product"), &owner, None, &p, p.at + 86400)
            .unwrap();
        assert!(
            b.accept_pickup(Some("product"), &owner, Some(&merchant), &p, p.at + 40)
                .is_err()
        );
        b.records
            .get_mut("product")
            .unwrap()
            .order
            .pickup_authorization = None;
        assert_eq!(
            b.pickup_receipt_qr("product", &owner, None).unwrap(),
            p.qr()
        );
    }

    #[test]
    fn forged_collectors_ambiguous_orders_and_unsigned_merchant_devices_cannot_confirm() {
        let (mut b, p, _owner, merchant) = sample();
        let mut forged_order = b.records["product"].order.clone();
        forged_order
            .pickup_authorization
            .as_mut()
            .unwrap()
            .courier_pubkey = merchant.clone();
        assert!(Scope::from_order(&forged_order).is_none());
        forged_order
            .pickup_authorization
            .as_mut()
            .unwrap()
            .courier_pubkey = forged_order.buyer.clone();
        assert!(Scope::from_order(&forged_order).is_none());
        let mut ack = p.clone();
        ack.confirmed = None;
        let courier = b.records["product"]
            .order
            .pickup_authorization
            .as_ref()
            .unwrap()
            .courier_pubkey
            .clone();
        let bad = Keys::generate();
        assert!(
            b.accept_pickup(
                Some("product"),
                &merchant,
                Some(&bad.public_key().to_hex()),
                &ack,
                p.at
            )
            .is_err()
        );
        let mut alias = b.records["product"].clone();
        alias.order.id = "duplicate".into();
        b.records.insert("duplicate".into(), alias);
        assert!(
            b.accept_pickup(Some("product"), &merchant, Some(&courier), &ack, p.at)
                .is_err()
        );
        b.records.remove("duplicate");
        b.accept_pickup(Some("product"), &merchant, Some(&courier), &ack, p.at)
            .unwrap();
        assert!(b.confirm_pickup("product", &merchant, None, p.at).is_err());
        assert!(
            b.confirm_pickup("product", &merchant, Some(&bad), p.at)
                .is_err()
        );
        assert!(
            b.confirm_pickup("product", &merchant, Some(&bad), p.at + 121)
                .unwrap_err()
                .contains("expired")
        );
    }

    #[test]
    fn fixed_vector_checks_both_signatures_canonical_encoding_and_signed_times() {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../shared/pickup-receipt-vector.json"
        ))
        .unwrap();
        let get = |key: &str| v[key].as_str().unwrap().to_owned();
        let scope = Scope {
            reference: get("ref"),
            merchant: get("merchant"),
            key: get("collectorKey"),
            collector: get("collectorKey"),
        };
        let ack = Statement::from_qr(&get("ackQr"), false).unwrap();
        let both = Statement::from_qr(&get("receiptQr"), true).unwrap();
        assert_eq!(
            ack.fields(),
            serde_json::from_value::<Vec<String>>(v["ackTag"].clone()).unwrap()
        );
        assert_eq!(
            both.fields(),
            serde_json::from_value::<Vec<String>>(v["receiptTag"].clone()).unwrap()
        );
        assert_eq!(
            scope.verify(&ack, ack.at + 120).unwrap(),
            get("collectorEventId")
        );
        assert!(scope.verify(&ack, ack.at + 121).is_err());
        assert_eq!(
            scope.verify(&both, ack.at + 100000).unwrap(),
            get("collectorEventId")
        );
        assert!(scope.verify(&both, ack.at).is_err());
        for index in [2, 3, 4, 5, 6] {
            let mut fields = both.fields();
            let bad = if fields[index].starts_with('a') {
                "b"
            } else {
                "a"
            };
            fields[index].replace_range(..1, bad);
            assert!(
                Statement::parse(&fields).is_none_or(|p| scope.verify(&p, ack.at + 140).is_err())
            );
        }
        let mut wrong = scope.clone();
        wrong.merchant = wrong.key.clone();
        assert!(wrong.verify(&both, ack.at + 50).is_err());
        assert!(Statement::from_qr(&get("ackQr"), true).is_err());
        assert!(Statement::from_qr(&get("receiptQr"), false).is_err());
        assert!(Statement::from_qr(&format!("{}:extra", get("receiptQr")), true).is_err());
        assert!(
            Statement::from_qr(&get("receiptQr").replace("1700000000", "01700000000"), true)
                .is_err()
        );
    }
}
