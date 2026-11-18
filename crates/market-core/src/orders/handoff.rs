//! A private order supplies the expected key ahead of time. Only an explicit
//! presentation signs a short-lived pass. Neither the event nor its signature is published.
use super::*;
use hkdf::Hkdf;
use nostr::{EventBuilder, Keys, Kind, SecretKey, Tag, Timestamp};
use sha2::Sha256;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecipientHandoff {
    pub id: String,
    pub key: String,
}

pub(super) fn reference(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value).ok().filter(|id| {
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == value
    })
}

impl RecipientHandoff {
    pub(crate) fn create(device: &Keys) -> Result<Self> {
        let id = Uuid::new_v4().to_string();
        let key = recipient_keys(device, &id)?.public_key().to_hex();
        Ok(Self { id, key })
    }
    pub(super) fn validate(&self) -> Result<()> {
        require(
            reference(&self.id).is_some()
                && hex(&self.key)
                && PublicKey::from_hex(&self.key)
                    .and_then(|key| key.xonly())
                    .is_ok(),
            "Invalid recipient handoff",
        )
    }
}

pub(super) fn recipient_keys(device: &Keys, id: &str) -> Result<Keys> {
    let salt = reference(id).ok_or("Invalid handoff reference")?;
    let mut secret = [0u8; 32];
    Hkdf::<Sha256>::new(Some(salt.as_bytes()), device.secret_key().as_secret_bytes())
        .expand(b"iris-market/order-handoff-key/v1", &mut secret)
        .map_err(|_| "Could not prepare handoff key")?;
    let keys = SecretKey::from_slice(&secret)
        .map(Keys::new)
        .map_err(|_| "Could not prepare handoff key".to_string());
    secret.fill(0);
    keys
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HandoffKind {
    Pickup,
    Dropoff,
}
impl HandoffKind {
    fn name(self) -> &'static str {
        match self {
            Self::Pickup => "pickup",
            Self::Dropoff => "dropoff",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HandoffAction {
    Show,
    Scan,
    Checked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HandoffView {
    pub kind: HandoffKind,
    pub action: HandoffAction,
}

struct Participant<'a> {
    kind: HandoffKind,
    action: HandoffAction,
    id: &'a str,
    key: &'a str,
    courier_signature: bool,
}

impl Record {
    fn handoff(&self, owner: &str, kind: HandoffKind) -> Option<Participant<'_>> {
        use HandoffAction::{Scan, Show};
        let o = &self.order;
        if !matches!(o.status, OrderStatus::Accepted | OrderStatus::InTransit) {
            return None;
        }
        let recipient = o.recipient_handoff.as_ref();
        let (action, id, key, courier_signature) = match kind {
            HandoffKind::Pickup if o.fulfillment == Some(Fulfillment::Pickup) => {
                let h = recipient?;
                (
                    if owner == o.buyer {
                        Show
                    } else if owner == o.seller {
                        Scan
                    } else {
                        return None;
                    },
                    &h.id,
                    &h.key,
                    false,
                )
            }
            HandoffKind::Pickup if owner == o.seller => {
                if let Some(c) = o
                    .delivery_request
                    .as_ref()
                    .and_then(|r| r.collection.as_ref())
                {
                    (Show, &c.reference, &o.seller, true)
                } else {
                    let auth = o.pickup_authorization.as_ref()?;
                    (Scan, &auth.reference, &auth.courier_pubkey, true)
                }
            }
            HandoffKind::Dropoff => {
                let h = recipient?;
                let action = if let Some(service) = &o.delivery_request {
                    if owner != o.seller || service.collection.is_none() {
                        return None;
                    }
                    Scan
                } else if owner == o.buyer && o.fulfillment != Some(Fulfillment::Pickup) {
                    Show
                } else if owner == o.seller
                    && o.fulfillment == Some(Fulfillment::MerchantDelivery)
                    && self.delivery_order_id.is_none()
                    && o.pickup_authorization.is_none()
                    && o.shipment.tracking_url.is_none()
                    && o.shipment
                        .stops
                        .iter()
                        .all(|stop| stop.courier_pubkey.is_none())
                {
                    Scan
                } else {
                    return None;
                };
                (action, &h.id, &h.key, false)
            }
            _ => return None,
        };
        reference(id)?;
        Some(Participant {
            kind,
            action,
            id,
            key,
            courier_signature,
        })
    }

    pub(super) fn handoff_views(&self, owner: &str) -> Vec<HandoffView> {
        [HandoffKind::Pickup, HandoffKind::Dropoff]
            .into_iter()
            .filter_map(|kind| {
                if self.order.status.terminal() {
                    let prefix = format!("{}:", kind.name());
                    return self
                        .checked_handoffs
                        .iter()
                        .any(|key| key.starts_with(&prefix))
                        .then_some(HandoffView {
                            kind,
                            action: HandoffAction::Checked,
                        });
                }
                let p = self.handoff(owner, kind)?;
                let action = if p.action == HandoffAction::Scan
                    && self.checked_handoffs.contains(&p.receipt_key())
                {
                    HandoffAction::Checked
                } else {
                    p.action
                };
                Some(HandoffView { kind, action })
            })
            .collect()
    }
}

impl Participant<'_> {
    fn receipt_key(&self) -> String {
        format!("{}:{}:{}", self.kind.name(), self.id, self.key)
    }
    fn prefix(&self, at: u64) -> String {
        format!("iris-handoff:1:{}:{}:{at}", self.kind.name(), self.id)
    }
    fn draft(&self, at: u64) -> Result<UnsignedEvent> {
        let tag = Tag::parse(["iris-market/handoff", "1", self.kind.name(), self.id])
            .map_err(|_| "Invalid handoff")?;
        Ok(EventBuilder::new(Kind::from(27835), "")
            .tag(tag)
            .custom_created_at(Timestamp::from(at))
            .build(PublicKey::from_hex(self.key).map_err(|_| "Invalid handoff key")?))
    }
}

impl OrderBook {
    fn participant(
        &self,
        order_id: &str,
        owner: &str,
        kind: HandoffKind,
        action: HandoffAction,
    ) -> Result<Participant<'_>> {
        self.records
            .get(order_id)
            .and_then(|r| r.handoff(owner, kind))
            .filter(|p| p.action == action)
            .ok_or_else(|| "This handoff is unavailable for this order".into())
    }

    pub(crate) fn show_handoff(
        &self,
        order_id: &str,
        owner: &str,
        kind: HandoffKind,
        device: &Keys,
        account: Option<&Keys>,
        now: u64,
    ) -> Result<String> {
        let p = self.participant(order_id, owner, kind, HandoffAction::Show)?;
        let derived;
        let keys = if p.courier_signature {
            account
                .ok_or("Show this pickup pass on the device that holds your courier profile key")?
        } else {
            derived = recipient_keys(device, p.id)?;
            &derived
        };
        require(
            keys.public_key().to_hex() == p.key,
            "Show this pass on the device that placed the order",
        )?;
        let event = p
            .draft(now)?
            .sign_with_keys(keys)
            .map_err(|_| "Could not sign handoff")?;
        Ok(format!("{}:{}", p.prefix(now), event.sig))
    }

    pub(crate) fn verify_handoff(
        &mut self,
        order_id: &str,
        owner: &str,
        kind: HandoffKind,
        pass: &str,
        now: u64,
    ) -> Result<()> {
        let p = self.participant(order_id, owner, kind, HandoffAction::Scan)?;
        let wrong = "This pass does not match this handoff";
        require(pass.len() <= 220, wrong)?;
        let (prefix, signature) = pass.rsplit_once(':').ok_or(wrong)?;
        let (_, timestamp) = prefix.rsplit_once(':').ok_or(wrong)?;
        let at: u64 = timestamp.parse().map_err(|_| wrong)?;
        require(
            prefix == p.prefix(at)
                && signature.len() == 128
                && signature
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            wrong,
        )?;
        require(
            at >= now.saturating_sub(120) && at <= now.saturating_add(15),
            "Pass expired or device clocks differ. Show a fresh pass",
        )?;
        p.draft(at)?
            .add_signature(signature.parse().map_err(|_| wrong)?)
            .map_err(|_| wrong)?;
        let key = p.receipt_key();
        require(
            !self
                .records
                .values()
                .any(|r| r.checked_handoffs.contains(&key)),
            "This handoff has already been checked",
        )?;
        let record = self.records.get_mut(order_id).ok_or(wrong)?;
        require(
            record.checked_handoffs.len() < 32,
            "Too many replaced handoffs for this order",
        )?;
        record.checked_handoffs.insert(key);
        Ok(())
    }
}
