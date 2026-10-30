//! Synthetic offline contact flows: no public relay, profile or provider writes.
use iris_market_core::{
    Market, listing,
    messaging::Messaging,
    model::{Draft, Settings},
    store::Store,
};
use nostr::{Event, JsonUtil, Keys};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn offline_market(path: &std::path::Path, secret: &str) -> Market {
    Store::open(&path.join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    Market::open(path, secret, false).unwrap()
}
fn snapshot(app: &Market) -> Value {
    serde_json::from_str(&app.snapshot().unwrap()).unwrap()
}
fn roster(owner: &Keys, devices: &[nostr::PublicKey], at: u64) -> Event {
    iris_chat_protocol::AppKeys::new(
        devices
            .iter()
            .map(|device| iris_chat_protocol::DeviceEntry::new(*device, at))
            .collect(),
    )
    .get_event_at(owner.public_key(), at)
    .sign_with_keys(owner)
    .unwrap()
}

#[test]
fn profile_contact_without_listing_opens_and_persists_offline() {
    let dir = tempfile::tempdir().unwrap();
    let secret = iris_market_core::generate_secret_key();
    let peer = Keys::generate();
    let app = offline_market(dir.path(), &secret);
    let started = Instant::now();
    let result = app
        .command(&json!({"type":"contact","author":peer.public_key().to_hex()}).to_string())
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "opening a contact must not wait for discovery"
    );
    let state: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(state["conversations"][0]["id"], peer.public_key().to_hex());
    assert!(
        state["conversations"][0]["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.shutdown();
    drop(app);
    let app = offline_market(dir.path(), &secret);
    assert_eq!(
        snapshot(&app)["conversations"][0]["id"],
        peer.public_key().to_hex()
    );
    app.shutdown();
}

#[test]
fn listing_contact_checks_the_verified_cached_author_before_opening() {
    let dir = tempfile::tempdir().unwrap();
    let app = offline_market(dir.path(), &iris_market_core::generate_secret_key());
    let seller = Keys::generate();
    let stranger = Keys::generate();
    let draft = Draft {
        title: "Synthetic test chair".into(),
        description: "Offline fixture only".into(),
        side: "offer".into(),
        price: "10".into(),
        currency: "EUR".into(),
        location: "Test area".into(),
        category: "Home".into(),
        tags: vec![],
        service_areas: None,
        image_url: None,
        expires_at: None,
    };
    app.ingest_event(
        &listing::build(&seller, &draft, "test-chair", listing::now(), false).unwrap(),
    )
    .unwrap();
    let id = format!("{}:test-chair", seller.public_key().to_hex());
    let bad = json!({"type":"contact","author":stranger.public_key().to_hex(),"listing_id":id});
    assert!(
        app.command(&bad.to_string())
            .unwrap_err()
            .to_string()
            .contains("Listing author does not match")
    );
    assert!(
        snapshot(&app)["conversations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.command(
        &json!({"type":"contact","author":seller.public_key().to_hex(),"listing_id":id})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        snapshot(&app)["conversations"][0]["id"],
        seller.public_key().to_hex()
    );
    app.shutdown();
}

#[test]
fn local_contact_queues_without_peer_approval_and_uses_isolated_discovery() {
    let dir = tempfile::tempdir().unwrap();
    let local_key = Keys::generate();
    let peer = Keys::generate();
    let mut local = Messaging::open(dir.path(), local_key.clone()).unwrap();
    assert!(
        local
            .open_contact(&local_key.public_key().to_hex())
            .is_err()
    );
    local.open_contact(&peer.public_key().to_hex()).unwrap();
    local.open_contact(&peer.public_key().to_hex()).unwrap();
    assert_eq!(local.conversations().len(), 1);
    local
        .send(&peer.public_key().to_hex(), "Synthetic queued inquiry")
        .unwrap();
    assert_eq!(local.conversations()[0].messages[0].delivery, "pending");
    assert!(
        local.pending_outbound().is_empty(),
        "opening a contact is not peer authorization"
    );
    let discovery = Messaging::contact_discovery_filter(&peer.public_key().to_hex()).unwrap();
    assert!(
        local
            .subscriptions()
            .iter()
            .any(|s| s.filter == discovery.filter)
    );
    for scope in local.subscriptions() {
        let value = serde_json::to_value(&scope.filter).unwrap();
        if value["kinds"].as_array().is_some_and(|kinds| {
            kinds
                .iter()
                .any(|kind| kind.as_u64() == Some(iris_chat_protocol::MESSAGE_EVENT_KIND as u64))
        }) {
            assert!(
                !value.to_string().contains(&peer.public_key().to_hex()),
                "public peer discovery must not enter private message delivery filters"
            );
        }
    }
    drop(local);
    let mut local = Messaging::open(dir.path(), local_key).unwrap();
    local.retry().unwrap();
    assert_eq!(local.conversations()[0].messages.len(), 1);
    assert!(local.pending_outbound().is_empty());
}

#[test]
fn opening_contact_does_not_approve_this_device_or_revoked_peer_devices() {
    let local_dir = tempfile::tempdir().unwrap();
    let peer_dir = tempfile::tempdir().unwrap();
    let local_owner = Keys::generate();
    let local_device = Keys::generate();
    let peer_owner = Keys::generate();
    let mut unapproved = Messaging::open_identity(
        local_dir.path(),
        local_owner.public_key(),
        None,
        local_device,
        None,
    )
    .unwrap();
    unapproved
        .open_contact(&peer_owner.public_key().to_hex())
        .unwrap();
    assert!(
        unapproved
            .send(&peer_owner.public_key().to_hex(), "Must not send")
            .unwrap_err()
            .contains("account approval")
    );
    assert!(unapproved.pending_outbound().is_empty());
    drop(unapproved);

    let approved_dir = tempfile::tempdir().unwrap();
    let local_key = Keys::generate();
    let peer_device = Keys::generate();
    let at = listing::now();
    let valid = roster(&peer_owner, &[peer_device.public_key()], at);
    let mut peer = Messaging::open_identity(
        peer_dir.path(),
        peer_owner.public_key(),
        Some(peer_owner.clone()),
        peer_device,
        Some(&valid),
    )
    .unwrap();
    let invitation = peer.public_contact_event().unwrap();
    let mut local = Messaging::open(approved_dir.path(), local_key).unwrap();
    assert!(
        local.receive(&invitation).is_err(),
        "unsolicited invitations cannot create a contact"
    );
    local
        .open_contact(&peer_owner.public_key().to_hex())
        .unwrap();
    local
        .send(
            &peer_owner.public_key().to_hex(),
            "Queued while verification is missing",
        )
        .unwrap();
    local
        .receive(&roster(&peer_owner, &[Keys::generate().public_key()], at))
        .unwrap();
    assert!(
        local.receive(&invitation).is_err(),
        "a device absent from its owner's signed roster is rejected"
    );
    local.retry().unwrap();
    assert!(local.pending_outbound().is_empty());
    local
        .receive(&roster(&peer_owner, &[peer.device_public_key()], at + 1))
        .unwrap();
    local.receive(&invitation).unwrap();
    local
        .send(
            &peer_owner.public_key().to_hex(),
            "A new inquiry after verified approval",
        )
        .unwrap();
    local.retry().unwrap();
    assert!(
        !local.pending_outbound().is_empty(),
        "verified discovery permits delivery only to an approved device"
    );
    for event in local.pending_outbound() {
        assert!(
            !event.as_json().contains(&peer_owner.public_key().to_hex()),
            "peer public identity must not enter encrypted delivery envelopes"
        );
    }
}

#[test]
fn requested_legacy_public_invite_is_verified_before_async_acceptance() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut peer = Messaging::open(a.path(), Keys::generate()).unwrap();
    let invitation = peer.public_contact_event().unwrap();
    let mut local = Messaging::open(b.path(), Keys::generate()).unwrap();
    assert!(local.receive(&invitation).is_err());
    local.open_contact(&invitation.pubkey.to_hex()).unwrap();
    let mut forged = invitation.clone();
    forged.content.push('x');
    assert!(local.receive(&forged).is_err());
    assert!(local.pending_outbound().is_empty());
    local.receive(&invitation).unwrap();
    local
        .send(&invitation.pubkey.to_hex(), "Synthetic legacy inquiry")
        .unwrap();
    assert!(!local.pending_outbound().is_empty());
}

#[test]
fn signed_roster_cannot_fall_back_to_a_revoked_legacy_owner_invite() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let owner = Keys::generate();
    let mut peer = Messaging::open(a.path(), owner.clone()).unwrap();
    let invitation = peer.public_contact_event().unwrap();
    let mut local = Messaging::open(b.path(), Keys::generate()).unwrap();
    local.open_contact(&owner.public_key().to_hex()).unwrap();
    local
        .receive(&roster(
            &owner,
            &[Keys::generate().public_key()],
            listing::now(),
        ))
        .unwrap();
    assert!(
        local.receive(&invitation).is_err(),
        "an explicit roster supersedes legacy owner=device discovery"
    );
    assert!(local.pending_outbound().is_empty());
}

#[test]
fn verified_async_discovery_wakes_an_offline_queued_contact_message() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let owner = Keys::generate();
    let device = Keys::generate();
    let proof = roster(&owner, &[device.public_key()], listing::now());
    let mut peer = Messaging::open_identity(
        a.path(),
        owner.public_key(),
        Some(owner.clone()),
        device,
        Some(&proof),
    )
    .unwrap();
    let invitation = peer.public_contact_event().unwrap();
    let mut local = Messaging::open(b.path(), Keys::generate()).unwrap();
    local.open_contact(&owner.public_key().to_hex()).unwrap();
    local
        .send(
            &owner.public_key().to_hex(),
            "Synthetic queued while offline",
        )
        .unwrap();
    assert!(local.pending_outbound().is_empty());
    local.receive(&proof).unwrap();
    local.receive(&invitation).unwrap();
    local.retry().unwrap();
    assert!(!local.pending_outbound().is_empty());
    for _ in 0..8 {
        let mut count = 0;
        for event in local.pending_outbound() {
            peer.receive(&event).unwrap();
            local.acknowledge_published(&event.id.to_hex()).unwrap();
            count += 1;
        }
        for event in peer.pending_outbound() {
            local.receive(&event).unwrap();
            peer.acknowledge_published(&event.id.to_hex()).unwrap();
            count += 1;
        }
        local.retry().unwrap();
        peer.retry().unwrap();
        if count == 0 {
            break;
        }
    }
    assert!(
        peer.conversations()
            .iter()
            .flat_map(|c| &c.messages)
            .any(|m| m.text == "Synthetic queued while offline")
    );
}

#[test]
fn undiscovered_contact_queue_is_bounded_and_preserves_repeated_message_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut local = Messaging::open(dir.path(), Keys::generate()).unwrap();
    let peer = Keys::generate().public_key().to_hex();
    local.open_contact(&peer).unwrap();
    for _ in 0..256 {
        local
            .send(&peer, "Identical synthetic queued text")
            .unwrap();
    }
    let messages = &local.conversations()[0].messages;
    assert_eq!(messages.len(), 256);
    assert_eq!(
        messages
            .iter()
            .map(|m| &m.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        256
    );
    assert!(local.send(&peer, "Beyond queue capacity").is_err());
    assert_eq!(local.conversations()[0].messages.len(), 256);
    assert!(local.pending_outbound().is_empty());
}
