use iris_market_core::messaging::Messaging;
use nostr::{Event, JsonUtil, Keys};
use std::fs;
use tempfile::TempDir;

fn exchange(a: &mut Messaging, b: &mut Messaging) {
    for _ in 0..8 {
        let mut count = 0;
        for event in a.pending_outbound() {
            b.receive(&event).expect("receive from A");
            a.acknowledge_published(&event.id.to_hex()).unwrap();
            count += 1;
        }
        for event in b.pending_outbound() {
            a.receive(&event).expect("receive from B");
            b.acknowledge_published(&event.id.to_hex()).unwrap();
            count += 1;
        }
        a.retry().unwrap();
        b.retry().unwrap();
        if count == 0 {
            break;
        }
    }
}

#[test]
fn invitation_messages_restart_and_wire_privacy() {
    let ad = TempDir::new().unwrap();
    let bd = TempDir::new().unwrap();
    let ak = Keys::generate();
    let bk = Keys::generate();
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    let invitation = a.invite().unwrap();
    assert_eq!(
        b.accept_invite(&invitation).unwrap(),
        ak.public_key().to_hex()
    );
    for event in b.pending_outbound() {
        assert_ne!(event.pubkey, ak.public_key());
        assert_ne!(event.pubkey, bk.public_key());
        assert!(!event.as_json().contains(&bk.secret_key().to_secret_hex()));
        assert!(
            !event.as_json().contains(&bk.public_key().to_hex()),
            "private sender must not appear in serialized outer event"
        );
    }
    exchange(&mut a, &mut b);
    b.send(&ak.public_key().to_hex(), "Is the lovely lamp available?")
        .unwrap();
    let queued = b.pending_outbound();
    assert!(!queued.is_empty());
    for event in &queued {
        assert!(!event.as_json().contains(&bk.public_key().to_hex()));
        assert!(!event.as_json().contains("lovely lamp"));
    }
    drop(b);
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    assert_eq!(
        queued.iter().map(|e| e.id).collect::<Vec<_>>(),
        b.pending_outbound()
            .iter()
            .map(|e| e.id)
            .collect::<Vec<_>>()
    );
    exchange(&mut a, &mut b);
    let thread = a
        .conversations()
        .into_iter()
        .find(|t| t.id == bk.public_key().to_hex())
        .unwrap();
    assert_eq!(
        thread.messages.last().unwrap().text,
        "Is the lovely lamp available?"
    );
    assert!(!thread.messages.last().unwrap().mine);
    for event in queued {
        a.receive(&event).unwrap();
    }
    assert_eq!(a.conversations()[0].messages.len(), 1);
    a.send(&bk.public_key().to_hex(), "Yes, it is!").unwrap();
    exchange(&mut a, &mut b);
    assert_eq!(b.conversations()[0].messages.len(), 2);
    let bytes = fs::read(bd.path().join("private-messages/messages.sqlite3")).unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(!raw.contains("lovely lamp"));
    assert!(!raw.contains("Yes, it is!"));
    assert!(!raw.contains(&bk.secret_key().to_secret_hex()));
    drop(b);
    let b = Messaging::open(bd.path(), bk).unwrap();
    assert_eq!(b.conversations()[0].messages.len(), 2);
}

#[test]
fn invalid_input_cannot_create_messages_or_reveal_secret() {
    let dir = TempDir::new().unwrap();
    let keys = Keys::generate();
    let mut a = Messaging::open(dir.path(), keys.clone()).unwrap();
    assert!(a.accept_invite("not an invitation").is_err());
    assert!(a.accept_invite(&a.invite().unwrap()).is_err());
    assert!(
        a.send(&Keys::generate().public_key().to_hex(), "hello")
            .is_err()
    );
    assert!(a.conversations().is_empty());
    let subscriptions = a.subscriptions();
    assert!(
        subscriptions
            .iter()
            .all(|s| !s.scope.contains(&keys.secret_key().to_secret_hex()))
    );
    let listing = nostr::EventBuilder::text_note("not a private event")
        .sign_with_keys(&keys)
        .unwrap();
    assert!(a.receive(&listing).is_err());
    let mut value = serde_json::to_value(listing).unwrap();
    value["content"] = "tampered".into();
    let tampered: Event = serde_json::from_value(value).unwrap();
    assert!(a.receive(&tampered).is_err());
}

#[test]
fn wrong_key_preserves_existing_private_store() {
    let dir = TempDir::new().unwrap();
    let key = Keys::generate();
    let a = Messaging::open(dir.path(), key.clone()).unwrap();
    let invite = a.invite().unwrap();
    drop(a);
    assert!(Messaging::open(dir.path(), Keys::generate()).is_err());
    let restored = Messaging::open(dir.path(), key).unwrap();
    assert_eq!(restored.invite().unwrap(), invite);
}

#[test]
fn second_writer_is_rejected_without_touching_state() {
    let dir = TempDir::new().unwrap();
    let key = Keys::generate();
    let first = Messaging::open(dir.path(), key.clone()).unwrap();
    assert!(Messaging::open(dir.path(), key.clone()).is_err());
    let invite = first.invite().unwrap();
    drop(first);
    let reopened = Messaging::open(dir.path(), key).unwrap();
    assert_eq!(reopened.invite().unwrap(), invite);
}

#[test]
fn public_contact_is_separate_and_bound_to_listing_author() {
    let ad = TempDir::new().unwrap();
    let bd = TempDir::new().unwrap();
    let ak = Keys::generate();
    let bk = Keys::generate();
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    let private = iris_chat_protocol::parse_invite_url(&a.invite().unwrap()).unwrap();
    let contact = a.public_contact_event().unwrap();
    let public = iris_chat_protocol::parse_invite_event(&contact).unwrap();
    assert_ne!(
        private.inviter_ephemeral_public_key,
        public.inviter_ephemeral_public_key
    );
    assert_ne!(private.shared_secret, public.shared_secret);
    assert_eq!(contact.pubkey, ak.public_key());
    let discovery = Messaging::contact_discovery_filter(&ak.public_key().to_hex()).unwrap();
    assert!(discovery.filter.match_event(&contact, Default::default()));
    assert!(
        b.accept_public_contact_event(&contact, &bk.public_key().to_hex())
            .is_err()
    );
    assert_eq!(
        b.accept_public_contact_event(&contact, &ak.public_key().to_hex())
            .unwrap(),
        ak.public_key().to_hex()
    );
    exchange(&mut a, &mut b);
    b.send(&ak.public_key().to_hex(), "Can I collect the chair today?")
        .unwrap();
    exchange(&mut a, &mut b);
    assert_eq!(
        a.conversations()[0].messages.last().unwrap().text,
        "Can I collect the chair today?"
    );
    a.send(&bk.public_key().to_hex(), "Yes, after five")
        .unwrap();
    exchange(&mut a, &mut b);
    assert_eq!(b.conversations()[0].messages.len(), 2);
    drop(a);
    let a = Messaging::open(ad.path(), ak).unwrap();
    assert_eq!(
        a.invite().unwrap(),
        iris_chat_protocol::invite_url(&private, "https://market.iris.to/invite").unwrap()
    );
}

fn signed_roster(owner: &Keys, devices: &[nostr::PublicKey], timestamp: u64) -> Event {
    iris_chat_protocol::AppKeys::new(
        devices
            .iter()
            .map(|device| iris_chat_protocol::DeviceEntry::new(*device, timestamp))
            .collect(),
    )
    .get_event_at(owner.public_key(), timestamp)
    .sign_with_keys(owner)
    .unwrap()
}

#[test]
fn invitation_waits_durably_for_signed_owner_evidence_without_network_or_bypass() {
    let local_dir = TempDir::new().unwrap();
    let peer_dir = TempDir::new().unwrap();
    let local_key = Keys::generate();
    let owner = Keys::generate();
    let device = Keys::generate();
    let timestamp = nostr::Timestamp::now().as_secs();
    let authorization = signed_roster(&owner, &[device.public_key()], timestamp);
    let mut peer = Messaging::open_identity(
        peer_dir.path(),
        owner.public_key(),
        Some(owner.clone()),
        device.clone(),
        Some(&authorization),
    )
    .unwrap();
    let invite = peer.invite().unwrap();
    let mut local = Messaging::open(local_dir.path(), local_key.clone()).unwrap();
    assert!(!local.accept_invite_locally(&invite).unwrap());
    assert!(local.pending_outbound().is_empty());
    assert!(
        local
            .subscriptions()
            .iter()
            .any(|subscription| subscription.scope
                == format!("private-authorization-{}", owner.public_key().to_hex()))
    );
    drop(local);
    let mut local = Messaging::open(local_dir.path(), local_key).unwrap();
    local.retry().unwrap();
    assert!(local.pending_outbound().is_empty());
    let wrong = signed_roster(&owner, &[Keys::generate().public_key()], timestamp + 1);
    local.ingest_authorization(&wrong).unwrap();
    local.retry().unwrap();
    assert!(local.pending_outbound().is_empty());
    let valid = signed_roster(&owner, &[device.public_key()], timestamp + 2);
    local.ingest_authorization(&valid).unwrap();
    local.retry().unwrap();
    assert!(!local.pending_outbound().is_empty());
    exchange(&mut local, &mut peer);
    local
        .send(&owner.public_key().to_hex(), "Approved after restart")
        .unwrap();
    exchange(&mut local, &mut peer);
    assert!(peer.conversations().iter().any(|thread| {
        thread
            .messages
            .iter()
            .any(|message| message.text == "Approved after restart")
    }));
}

fn peer_receive(
    engine: &mut iris_chat_protocol::ProtocolEngine,
    events: Vec<Event>,
) -> Vec<String> {
    let mut texts = Vec::new();
    for event in events {
        match event.kind.as_u16() as u32 {
            iris_chat_protocol::INVITE_RESPONSE_KIND => {
                for message in engine
                    .observe_invite_response_event(&event)
                    .unwrap()
                    .direct_messages
                {
                    texts.push(message.content);
                }
            }
            iris_chat_protocol::MESSAGE_EVENT_KIND => {
                if let Some(message) = engine.process_direct_message_event(&event).unwrap() {
                    texts.push(message.content);
                }
            }
            _ => panic!("unexpected private event"),
        }
    }
    texts
}

#[test]
fn iris_chat_linked_device_invite_requires_signed_authorization_and_honors_revocation() {
    use iris_chat_protocol::{InMemoryStorage, ProtocolEngine, invite_unsigned_event};
    use std::sync::Arc;
    let directory = TempDir::new().unwrap();
    let market_keys = Keys::generate();
    let owner = Keys::generate();
    let device = Keys::generate();
    let mut market = Messaging::open(directory.path(), market_keys.clone()).unwrap();
    let mut chat = ProtocolEngine::load_or_create_for_local_device(
        Arc::new(InMemoryStorage::new()),
        owner.public_key(),
        &device,
    )
    .unwrap();
    chat.authenticate_local_owner_for_sending(&owner).unwrap();
    let now = nostr::Timestamp::now().as_secs();
    let authorization = signed_roster(&owner, &[device.public_key()], now);
    chat.ingest_app_keys_event(&authorization).unwrap();
    let unsigned = invite_unsigned_event(&chat.local_invite().unwrap()).unwrap();
    let invite = nostr::EventBuilder::new(unsigned.kind, unsigned.content)
        .tags(
            unsigned
                .tags
                .iter()
                .filter(|tag| {
                    tag.as_slice()
                        .first()
                        .is_none_or(|name| name != "ownerPublicKey")
                })
                .cloned(),
        )
        .sign_with_keys(&device)
        .unwrap();
    assert!(
        market
            .accept_public_contact_event(&invite, &owner.public_key().to_hex())
            .is_err()
    );
    assert!(market.conversations().is_empty());
    market.ingest_authorization(&authorization).unwrap();
    assert_eq!(
        market
            .accept_public_contact_event(&invite, &owner.public_key().to_hex())
            .unwrap(),
        owner.public_key().to_hex()
    );
    peer_receive(&mut chat, market.pending_outbound());
    for event in market.pending_outbound() {
        market.acknowledge_published(&event.id.to_hex()).unwrap();
    }
    market
        .send(
            &owner.public_key().to_hex(),
            "Native Market to linked Iris Chat",
        )
        .unwrap();
    let sent = market.pending_outbound();
    assert!(
        sent.iter()
            .all(|event| !event.as_json().contains(&market_keys.public_key().to_hex()))
    );
    let received = peer_receive(&mut chat, sent);
    assert!(
        received
            .iter()
            .any(|text| text.contains("Native Market to linked Iris Chat"))
    );
    // Equal-time contradictory signed rosters must fail closed, even if a
    // library projection still contains the original recipient device.
    let conflicting = signed_roster(&owner, &[], now);
    market.ingest_authorization(&conflicting).unwrap();
    assert!(market.pending_outbound().is_empty());
    // Revocation must stop both new joins and retransmission of queued ciphertext.
    let revoked = signed_roster(&owner, &[], now + 1);
    market.ingest_authorization(&revoked).unwrap();
    assert!(market.pending_outbound().is_empty());
    assert!(
        market
            .accept_public_contact_event(&invite, &owner.public_key().to_hex())
            .is_err()
    );
    drop(market);
    let mut market = Messaging::open(directory.path(), market_keys).unwrap();
    assert!(
        market
            .accept_public_contact_event(&invite, &owner.public_key().to_hex())
            .is_err()
    );
    assert_eq!(market.conversations()[0].messages[0].delivery, "failed");
}

#[test]
fn iris_chat_owner_proof_connects_to_market_public_invite_without_identity_leakage() {
    use iris_chat_protocol::{
        InMemoryStorage, ProtocolAcceptInviteOutcome, ProtocolEffect, ProtocolEngine, UnixSeconds,
    };
    use std::sync::Arc;
    let directory = TempDir::new().unwrap();
    let market_keys = Keys::generate();
    let owner = Keys::generate();
    let device = Keys::generate();
    let mut market = Messaging::open(directory.path(), market_keys.clone()).unwrap();
    let mut chat = ProtocolEngine::load_or_create_for_local_device(
        Arc::new(InMemoryStorage::new()),
        owner.public_key(),
        &device,
    )
    .unwrap();
    chat.authenticate_local_owner_for_sending(&owner).unwrap();
    let now = nostr::Timestamp::now().as_secs();
    chat.ingest_app_keys_event(&signed_roster(&owner, &[device.public_key()], now))
        .unwrap();
    let invite =
        iris_chat_protocol::parse_invite_event(&market.public_contact_event().unwrap()).unwrap();
    let ProtocolAcceptInviteOutcome::Accepted(accepted) = chat
        .accept_invite(&invite, Some(market_keys.public_key()))
        .unwrap()
    else {
        panic!("market invite was rejected")
    };
    for ProtocolEffect::Publish(publish) in accepted.effects {
        let wire = publish.event.as_json();
        assert!(!wire.contains(&owner.public_key().to_hex()));
        assert!(!wire.contains(&device.public_key().to_hex()));
        market.receive(&publish.event).unwrap();
    }
    let outgoing = chat
        .send_direct_text(
            market_keys.public_key(),
            &market_keys.public_key().to_hex(),
            "Iris Chat to Market",
            None,
            UnixSeconds(now),
        )
        .unwrap();
    for ProtocolEffect::Publish(publish) in outgoing.effects {
        market.receive(&publish.event).unwrap();
    }
    assert_eq!(market.conversations()[0].id, owner.public_key().to_hex());
    assert_eq!(
        market.conversations()[0].messages[0].text,
        "Iris Chat to Market"
    );
    market
        .send(&owner.public_key().to_hex(), "And back again")
        .unwrap();
    assert!(
        peer_receive(&mut chat, market.pending_outbound())
            .iter()
            .any(|text| text.contains("And back again"))
    );
}
