//! Compact pickup proofs travel only inside authenticated encrypted direct messages.
use super::*;
use crate::orders::pickup_receipt::{ACK, PickupChange, RECEIPT, Statement};

pub(super) fn has_tag(event: &UnsignedEvent) -> bool {
    event.tags.iter().any(|t| {
        matches!(
            t.as_slice().first().map(String::as_str),
            Some(ACK | RECEIPT)
        )
    })
}

impl Messaging {
    pub fn acknowledge_order_pickup(&mut self, id: &str) -> MessagingResult<String> {
        self.require_authorization()?;
        self.transaction(|this| {
            let (pass, change) = this.state.orders.acknowledge_pickup(
                id,
                &this.owner.to_hex(),
                &this.keys,
                this.owner_keys.as_ref(),
                now(),
            )?;
            if let Some(change) = change {
                this.queue_pickup_proof(change)?;
            }
            Ok(pass)
        })
    }
    pub fn confirm_order_pickup(&mut self, id: &str) -> MessagingResult<()> {
        self.require_authorization()?;
        self.transaction(|this| {
            if let Some(change) = this.state.orders.confirm_pickup(
                id,
                &this.owner.to_hex(),
                this.owner_keys.as_ref(),
                now(),
            )? {
                this.queue_pickup_proof(change)?;
            }
            Ok(())
        })
    }
    pub fn show_pickup_receipt(&self, id: &str) -> MessagingResult<String> {
        self.show_recorded_pickup_receipt(id, None)
    }
    pub(crate) fn show_recorded_pickup_receipt(
        &self,
        id: &str,
        reference: Option<&str>,
    ) -> MessagingResult<String> {
        self.state
            .orders
            .pickup_receipt_qr(id, &self.owner.to_hex(), reference)
    }
    pub fn verify_pickup_receipt(&mut self, id: &str, receipt: &str) -> MessagingResult<()> {
        let proof = Statement::from_qr(receipt, true)?;
        self.transaction(|this| {
            this.state
                .orders
                .accept_pickup(Some(id), &this.owner.to_hex(), None, &proof, now())
        })
    }
    fn queue_pickup_proof(&mut self, change: PickupChange) -> MessagingResult<()> {
        if self.state.outbox.len()
            + self.state.pending_contact_messages.len()
            + change.recipients.len()
            > MAX_OUTBOX
        {
            return Err("Connect to send queued messages before confirming pickup".into());
        }
        let tag = nostr::Tag::parse(change.statement.fields()).map_err(protocol_error)?;
        for id in change.recipients {
            let peer = PublicKey::from_hex(&id).map_err(protocol_error)?;
            let mut builder = nostr::EventBuilder::new(Kind::from(14), "")
                .tag(nostr::Tag::public_key(peer))
                .tag(tag.clone());
            let expires_at = change.statement.expires_at();
            if let Some(at) = expires_at {
                builder = builder.tag(nostr::Tag::expiration(nostr::Timestamp::from(at)));
            }
            let mut rumor = builder.build(self.keys.public_key());
            let event_id = rumor.id().to_hex();
            self.state.pending_contact_messages.insert(
                event_id,
                PendingContactMessage {
                    peer_id: id,
                    rumor,
                    expires_at,
                },
            );
        }
        Ok(())
    }
    pub(super) fn receive_pickup_proof(&mut self, sender: PublicKey, inner: &UnsignedEvent) {
        if inner.kind != Kind::from(14) || !inner.content.is_empty() {
            return;
        }
        let mut tags = inner
            .tags
            .iter()
            .map(|t| t.as_slice())
            .filter(|t| matches!(t.first().map(String::as_str), Some(ACK | RECEIPT)));
        let Some(s) = tags.next().and_then(Statement::parse) else {
            return;
        };
        if tags.next().is_some() {
            return;
        }
        if sender != self.owner && inner.tags.public_keys().any(|p| *p != self.owner) {
            return;
        }
        self.state
            .orders
            .receive_pickup(&self.owner.to_hex(), &sender.to_hex(), s, now());
    }
    pub(super) fn pickup_discovery_peers(&self) -> std::collections::BTreeSet<String> {
        let mut peers = self.state.orders.pickup_peers(&self.owner.to_hex());
        // Private receipts still need recipient device discovery if the sale
        // closes while the recipient is offline.
        peers.extend(
            self.state
                .pending_contact_messages
                .values()
                .filter(|p| has_tag(&p.rumor))
                .map(|p| p.peer_id.clone()),
        );
        peers
    }
    pub(super) fn wants_private_peer(&self, owner: PublicKey) -> bool {
        let peer = owner.to_hex();
        self.state.conversations.contains_key(&peer)
            || self.pickup_discovery_peers().contains(&peer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orders::{DeliveryPlace, Fulfillment, HandoffKind, OrderEscrow, OrderStatus};
    use serde_json::json;
    use tempfile::TempDir;
    fn listing(owner: &Keys) -> crate::model::Listing {
        serde_json::from_value(json!({"id":format!("{}:lamp",owner.public_key().to_hex()),"author":owner.public_key().to_hex(),"title":"Lamp","description":"","side":"offer","price":"12","currency":"EUR","location":"","category":"goods","created_at":now(),"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"sent","relevance":null})).unwrap()
    }
    fn relay(peers: &mut [&mut Messaging]) {
        for _ in 0..12 {
            let mut events = vec![];
            for (i, m) in peers.iter_mut().enumerate() {
                m.retry().unwrap();
                events.extend(m.pending_outbound().into_iter().map(|e| (i, e)));
            }
            if events.is_empty() {
                return;
            }
            for (sender, e) in events {
                for (i, peer) in peers.iter_mut().enumerate() {
                    if i != sender {
                        peer.receive(&e).unwrap();
                    }
                }
                peers[sender].acknowledge_published(&e.id.to_hex()).unwrap();
            }
        }
    }
    fn record(m: &Messaging, id: &str) -> crate::orders::OrderView {
        m.orders().into_iter().find(|o| o.order.id == id).unwrap()
    }
    fn state(m: &Messaging, id: &str) -> Option<String> {
        record(m, id).pickup_receipt.map(|r| r.state)
    }
    fn order(b: &mut Messaging, s: &Keys, fulfillment: Fulfillment) -> String {
        b.request_order_with_escrow(
            &listing(s),
            1,
            "Private goods",
            None,
            OrderEscrow::default(),
            Some(fulfillment),
            false,
        )
        .unwrap()
    }
    #[test]
    fn private_pickup_ack_and_confirmation_survive_restart_and_relay_without_changing_sale() {
        let bd = TempDir::new().unwrap();
        let sd = TempDir::new().unwrap();
        let bk = Keys::generate();
        let sk = Keys::generate();
        let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
        let mut s = Messaging::open(sd.path(), sk.clone()).unwrap();
        b.accept_invite(&s.invite().unwrap()).unwrap();
        let id = order(&mut b, &sk, Fulfillment::Pickup);
        relay(&mut [&mut b, &mut s]);
        s.update_order(&id, json!({"status":"accepted"})).unwrap();
        relay(&mut [&mut b, &mut s]);
        let k = HandoffKind::Pickup;
        let old = b.show_order_handoff(&id, k).unwrap();
        s.verify_order_handoff(&id, k, &old).unwrap();
        assert!(state(&s, &id).is_none());
        assert!(s.confirm_order_pickup(&id).is_err());
        let before = record(&s, &id).order;
        let ack = b.acknowledge_order_pickup(&id).unwrap();
        assert_eq!(ack, b.acknowledge_order_pickup(&id).unwrap());
        assert_eq!(state(&b, &id).as_deref(), Some("acknowledged"));
        assert!(s.acknowledge_order_pickup(&id).is_err());
        assert!(b.confirm_order_pickup(&id).is_err());
        assert!(b.verify_order_handoff(&id, k, &ack).is_err());
        relay(&mut [&mut b, &mut s]); // Merchant learns the signed statement even without a camera.
        assert_eq!(state(&s, &id).as_deref(), Some("awaiting-confirmation"));
        s.verify_order_handoff(&id, k, &ack).unwrap();
        s.confirm_order_pickup(&id).unwrap();
        let count = s.state.pending_contact_messages.len();
        s.confirm_order_pickup(&id).unwrap();
        assert_eq!(s.state.pending_contact_messages.len(), count);
        assert_eq!(state(&b, &id).as_deref(), Some("acknowledged"));
        let receipt = s.show_pickup_receipt(&id).unwrap();
        assert_eq!(record(&s, &id).order, before);
        drop(s);
        let mut s = Messaging::open(sd.path(), sk).unwrap();
        assert_eq!(s.show_pickup_receipt(&id).unwrap(), receipt);
        relay(&mut [&mut b, &mut s]);
        assert_eq!(state(&b, &id).as_deref(), Some("confirmed"));
        assert_eq!(b.show_pickup_receipt(&id).unwrap(), receipt);
        s.update_order(&id, json!({"status":"delivered"})).unwrap();
        relay(&mut [&mut b, &mut s]);
        b.verify_pickup_receipt(&id, &receipt).unwrap();
        b.verify_pickup_receipt(&id, &receipt).unwrap();
        assert_eq!(state(&b, &id).as_deref(), Some("confirmed"));
        for m in [&b, &s] {
            assert!(
                m.conversations()
                    .iter()
                    .flat_map(|c| &c.messages)
                    .all(|m| !m.text.is_empty()
                        && !m.text.contains("iris-handoff")
                        && !m.text.contains("iris-pickup-receipt"))
            );
        }
    }
    #[test]
    fn split_courier_receipt_reaches_independent_buyer_and_collector_without_product_details() {
        let bd = TempDir::new().unwrap();
        let sd = TempDir::new().unwrap();
        let cd = TempDir::new().unwrap();
        let bk = Keys::generate();
        let sk = Keys::generate();
        let ck = Keys::generate();
        let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
        let mut s = Messaging::open(sd.path(), sk.clone()).unwrap();
        let mut c = Messaging::open(cd.path(), ck.clone()).unwrap();
        b.accept_invite(&s.invite().unwrap()).unwrap();
        c.accept_invite(&s.invite().unwrap()).unwrap();
        let sale = order(&mut b, &sk, Fulfillment::MerchantDelivery);
        relay(&mut [&mut b, &mut s, &mut c]);
        s.update_order(&sale, json!({"status":"accepted"})).unwrap();
        relay(&mut [&mut b, &mut s, &mut c]);
        let mut service = listing(&ck);
        service.tags = vec!["parcel".into()];
        let place = DeliveryPlace {
            label: "Shop".into(),
            address: "Test pickup".into(),
            coordinates: None,
        };
        let job = s
            .book_delivery(&sale, &service, place.clone(), Some(place))
            .unwrap();
        relay(&mut [&mut b, &mut s, &mut c]);
        c.update_order(&job, json!({"status":"accepted"})).unwrap();
        relay(&mut [&mut b, &mut s, &mut c]);
        assert!(b.acknowledge_order_pickup(&sale).is_err());
        assert!(c.confirm_order_pickup(&job).is_err());
        let ack = c.acknowledge_order_pickup(&job).unwrap();
        s.verify_order_handoff(&sale, HandoffKind::Pickup, &ack)
            .unwrap();
        s.confirm_order_pickup(&sale).unwrap();
        let proof = s.show_pickup_receipt(&sale).unwrap();
        assert!(b.verify_pickup_receipt(&sale, &ack).is_err());
        assert_eq!(state(&b, &sale), None);
        let queues: Vec<_> = s
            .state
            .pending_contact_messages
            .values()
            .filter(|m| has_tag(&m.rumor))
            .collect();
        assert_eq!(queues.len(), 2);
        for message in queues {
            assert!(message.rumor.content.is_empty());
            let tag = message
                .rumor
                .tags
                .iter()
                .find(|t| t.as_slice()[0] == RECEIPT)
                .unwrap();
            assert!(
                ![
                    &sale,
                    &job,
                    &bk.public_key().to_hex(),
                    &sk.public_key().to_hex(),
                    &ck.public_key().to_hex(),
                    "Private goods",
                    "Test pickup"
                ]
                .iter()
                .any(|v| tag.as_slice().iter().any(|s| s.contains(*v)))
            );
        }
        c.verify_pickup_receipt(&job, &proof).unwrap(); // Immediate private offline copy at the counter.
        relay(&mut [&mut b, &mut s, &mut c]);
        assert_eq!(b.show_pickup_receipt(&sale).unwrap(), proof);
        assert_eq!(c.show_pickup_receipt(&job).unwrap(), proof);
        assert!(c.orders().iter().all(|v| v.order.id != sale));
        assert!(b.orders().iter().all(|v| v.order.id != job));
        assert_eq!(record(&s, &sale).order.status, OrderStatus::Accepted);
        assert!(record(&s, &sale).order.payment.is_none());
    }
    #[test]
    fn buyer_booked_courier_queues_until_merchant_contact_discovery_and_keeps_orders_separate() {
        let dirs = [
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
        ];
        let buyer_key = Keys::generate();
        let store_key = Keys::generate();
        let driver_key = Keys::generate();
        let mut buyer = Messaging::open(dirs[0].path(), buyer_key).unwrap();
        let mut store = Messaging::open(dirs[1].path(), store_key.clone()).unwrap();
        let mut driver = Messaging::open(dirs[2].path(), driver_key.clone()).unwrap();
        buyer.accept_invite(&store.invite().unwrap()).unwrap();
        buyer.accept_invite(&driver.invite().unwrap()).unwrap();
        let sale = order(&mut buyer, &store_key, Fulfillment::BuyerCourier);
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        store
            .update_order(&sale, json!({"status":"accepted"}))
            .unwrap();
        store.update_order(&sale,json!({"shipment":{"stops":[{"id":"counter","label":"Store","address":"Test counter"}]}})).unwrap();
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        let mut listing = listing(&driver_key);
        listing.tags = vec!["parcel".into()];
        let job = buyer
            .request_delivery(
                &sale,
                &listing,
                DeliveryPlace {
                    label: "Home".into(),
                    address: "Test home".into(),
                    coordinates: None,
                },
            )
            .unwrap();
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        driver
            .update_order(&job, json!({"status":"accepted"}))
            .unwrap();
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        assert!(!driver.contact_recipient_ready(store_key.public_key()));
        let ack = driver.acknowledge_order_pickup(&job).unwrap();
        drop(driver);
        let mut driver = Messaging::open(dirs[2].path(), driver_key.clone()).unwrap();
        assert_eq!(driver.acknowledge_order_pickup(&job).unwrap(), ack);
        assert!(driver.wants_private_peer(store_key.public_key()));
        assert!(store.wants_private_peer(driver_key.public_key()));
        let at = nostr::Timestamp::now().as_secs();
        for (remote, keys) in [(&mut driver, &store_key), (&mut store, &driver_key)] {
            let roster =
                iris_chat_protocol::AppKeys::new(vec![iris_chat_protocol::DeviceEntry::new(
                    keys.public_key(),
                    at,
                )])
                .get_event_at(keys.public_key(), at)
                .sign_with_keys(keys)
                .unwrap();
            remote.receive(&roster).unwrap();
        }
        driver
            .receive(&store.public_contact_event().unwrap())
            .unwrap();
        store
            .receive(&driver.public_contact_event().unwrap())
            .unwrap();
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        assert_eq!(
            state(&store, &sale).as_deref(),
            Some("awaiting-confirmation")
        );
        store.confirm_order_pickup(&sale).unwrap();
        store
            .update_order(&sale, json!({"status":"delivered"}))
            .unwrap();
        driver
            .update_order(&job, json!({"status":"delivered"}))
            .unwrap();
        assert!(
            store
                .pickup_discovery_peers()
                .contains(&driver_key.public_key().to_hex())
        );
        assert!(
            driver
                .pickup_discovery_peers()
                .contains(&store_key.public_key().to_hex())
        );
        relay(&mut [&mut buyer, &mut store, &mut driver]);
        let receipt = store.show_pickup_receipt(&sale).unwrap();
        assert_eq!(driver.show_pickup_receipt(&job).unwrap(), receipt);
        assert_eq!(buyer.show_pickup_receipt(&sale).unwrap(), receipt);
        assert!(store.orders().iter().all(|v| v.order.id != job));
        assert!(driver.orders().iter().all(|v| v.order.id != sale));
    }
}
