use base64::Engine;
use iris_market_core::{
    messaging::{Messaging, mobile_push::resolve},
    mobile_push::{Delivery, build_request},
};
use nostr::{JsonUtil, Keys};
fn exchange(a: &mut Messaging, b: &mut Messaging) {
    for _ in 0..8 {
        let mut count = 0;
        for event in a.pending_outbound() {
            b.receive(&event).unwrap();
            a.acknowledge_published(&event.id.to_hex()).unwrap();
            count += 1;
        }
        for event in b.pending_outbound() {
            a.receive(&event).unwrap();
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
fn detached_preview_never_changes_live_ratchet_or_leaks_text() {
    let ad = tempfile::tempdir().unwrap();
    let bd = tempfile::tempdir().unwrap();
    let ak = Keys::generate();
    let bk = Keys::generate();
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    b.accept_invite(&a.invite().unwrap()).unwrap();
    exchange(&mut a, &mut b);
    a.set_push_enabled(true).unwrap();
    b.send(&ak.public_key().to_hex(), "Private purchase question")
        .unwrap();
    let event = b
        .pending_outbound()
        .into_iter()
        .find(|e| e.kind.as_u16() == 1060)
        .unwrap();
    let payload = serde_json::json!({"event":event}).to_string();
    let path = ad.path().join("private-messages/messages.sqlite3");
    let before = std::fs::read(&path).unwrap();
    let preview = resolve(ad.path(), ak.public_key(), &ak, &payload);
    assert!(preview.show);
    assert_eq!(
        preview.peer_id.as_deref(),
        Some(bk.public_key().to_hex().as_str())
    );
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains("Private purchase")
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        resolve(ad.path(), ak.public_key(), &ak, &payload),
        preview,
        "preview must not consume the ratchet"
    );
    a.mark_notifications_presented(&[event.id.to_hex()])
        .unwrap();
    assert!(!resolve(ad.path(), ak.public_key(), &ak, &payload).show);
    a.receive(&event).unwrap();
    let message = a.conversations()[0].messages[0].clone();
    assert_eq!(message.text, "Private purchase question");
    a.mark_messages_read(std::slice::from_ref(&message.id)).unwrap();
    drop(a);
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    assert!(!resolve(ad.path(), ak.public_key(), &ak, &payload).show);
    a.set_push_enabled(false).unwrap();
    assert!(a.push_snapshot().unwrap().filters.is_empty());
    assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(&message.id));
}
#[test]
fn registration_has_no_public_peer_discovery_and_uses_separate_signer() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Keys::generate();
    let mut app = Messaging::open(dir.path(), keys.clone()).unwrap();
    app.set_push_enabled(true).unwrap();
    app.invite().unwrap();
    let filters = app.push_snapshot().unwrap().filters;
    assert!(filters.iter().all(
        |f| f["kinds"] == serde_json::json!([1060]) || f["kinds"] == serde_json::json!([1059])
    ));
    let registration = Keys::generate();
    let request = build_request(
        &registration.secret_key().to_secret_hex(),
        "POST",
        "https://example.com",
        None,
        Some(Delivery {
            platform: "android".into(),
            token: "device-token".into(),
            apns_topic: None,
            production: true,
            filters,
        }),
    )
    .unwrap();
    assert!(!request.body.as_ref().unwrap().contains("subscriber"));
    assert!(
        !request
            .body
            .as_ref()
            .unwrap()
            .contains(&keys.public_key().to_hex()),
        "legacy identity must not become a notification inbox filter"
    );
    assert!(!request.authorization.contains(&keys.public_key().to_hex()));
    let auth = nostr::Event::from_json(
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(request.authorization.strip_prefix("Nostr ").unwrap())
                .unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    auth.verify().unwrap();
    assert_eq!(
        auth.pubkey,
        registration.public_key(),
        "registration must not authenticate as the public account"
    );
    assert!(
        auth.tags
            .iter()
            .any(|tag| tag.as_slice().first().is_some_and(|kind| kind == "u")
                && tag.as_slice().get(1) == Some(&request.url))
    );
    assert!(auth.tags.iter().any(
        |tag| tag.as_slice().first().is_some_and(|kind| kind == "method")
            && tag.as_slice().get(1).is_some_and(|method| method == "POST")
    ));
    assert!(
        auth.tags
            .iter()
            .any(|tag| tag.as_slice().first().is_some_and(|kind| kind == "payload")),
        "HTTP authorization binds the exact POST body"
    );

    let invalid = Delivery {
        platform: "android".into(),
        token: "device-token".into(),
        apns_topic: None,
        production: true,
        filters: vec![serde_json::json!({"kinds":[0],"authors":[keys.public_key().to_hex()]})],
    };
    assert!(
        build_request(
            &registration.secret_key().to_secret_hex(),
            "POST",
            "https://example.com",
            None,
            Some(invalid)
        )
        .is_err()
    );
    assert!(
        build_request(
            &registration.secret_key().to_secret_hex(),
            "GET",
            "https://example.com",
            Some("../other"),
            None
        )
        .is_err()
    );
    assert!(!resolve(dir.path(), keys.public_key(), &keys, &serde_json::json!({"event":nostr::EventBuilder::text_note("untrusted").sign_with_keys(&keys).unwrap().as_json()}).to_string()).show);
}

#[test]
fn relay_first_cache_read_markers_and_optout_are_durable() {
    let ad = tempfile::tempdir().unwrap();
    let bd = tempfile::tempdir().unwrap();
    let ak = Keys::generate();
    let bk = Keys::generate();
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    b.accept_invite(&a.invite().unwrap()).unwrap();
    exchange(&mut a, &mut b);
    a.set_push_enabled(true).unwrap();
    b.send(&ak.public_key().to_hex(), "Unread private question")
        .unwrap();
    let event = b
        .pending_outbound()
        .into_iter()
        .find(|e| e.kind.as_u16() == 1060)
        .unwrap();
    let payload = serde_json::json!({"event":event}).to_string();
    a.receive(&event).unwrap();
    assert!(
        resolve(ad.path(), ak.public_key(), &ak, &payload).show,
        "relay delivery before push must preserve authenticated preview routing"
    );
    let id = a.conversations()[0].messages[0].id.clone();
    a.mark_messages_read(std::slice::from_ref(&id)).unwrap();
    assert!(!resolve(ad.path(), ak.public_key(), &ak, &payload).show);
    drop(a);
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    assert!(!resolve(ad.path(), ak.public_key(), &ak, &payload).show);
    a.set_push_enabled(false).unwrap();
    assert!(!resolve(ad.path(), ak.public_key(), &ak, &payload).show);
    assert!(
        !String::from_utf8_lossy(
            &std::fs::read(ad.path().join("private-messages/messages.sqlite3")).unwrap()
        )
        .contains(&id)
    );
}
#[test]
fn signed_invite_controls_forgery_wrong_keys_and_outgoing_are_suppressed() {
    let ad = tempfile::tempdir().unwrap();
    let bd = tempfile::tempdir().unwrap();
    let ak = Keys::generate();
    let bk = Keys::generate();
    let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    let invitation = a.invite().unwrap();
    a.set_push_enabled(true).unwrap();
    b.accept_invite(&invitation).unwrap();
    let response = b
        .pending_outbound()
        .into_iter()
        .find(|e| e.kind.as_u16() == 1059)
        .unwrap();
    let payload = serde_json::json!({"event":response}).to_string();
    assert!(
        iris_market_core::mobile_push::payload_event(&payload).is_some(),
        "signed private handshake is admitted for background ingestion"
    );
    let before = std::fs::read(ad.path().join("private-messages/messages.sqlite3")).unwrap();
    assert!(
        !resolve(ad.path(), ak.public_key(), &ak, &payload).show,
        "handshake is not a user-visible message"
    );
    assert_eq!(
        std::fs::read(ad.path().join("private-messages/messages.sqlite3")).unwrap(),
        before
    );
    let mut forged = response.clone();
    forged.content.push('x');
    assert!(
        iris_market_core::mobile_push::payload_event(
            &serde_json::json!({"event":forged}).to_string()
        )
        .is_none()
    );
    assert!(!resolve(ad.path(), ak.public_key(), &Keys::generate(), &payload).show);
    exchange(&mut a, &mut b);
    b.send(&ak.public_key().to_hex(), "First authenticated message")
        .unwrap();
    exchange(&mut a, &mut b);
    a.send(&bk.public_key().to_hex(), "Outgoing").unwrap();
    for event in a.pending_outbound() {
        assert!(
            !resolve(
                ad.path(),
                ak.public_key(),
                &ak,
                &serde_json::json!({"event":event}).to_string()
            )
            .show
        );
    }
}

#[test]
fn cold_first_message_replays_signed_controls_without_consuming_live_storage() {
    for public in [false, true] {
        let ad = tempfile::tempdir().unwrap();
        let bd = tempfile::tempdir().unwrap();
        let ak = Keys::generate();
        let bk = Keys::generate();
        let mut a = Messaging::open(ad.path(), ak.clone()).unwrap();
        let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
        if public {
            b.accept_public_contact_event(
                &a.public_contact_event().unwrap(),
                &ak.public_key().to_hex(),
            )
            .unwrap();
        } else {
            b.accept_invite(&a.invite().unwrap()).unwrap();
        }
        a.set_push_enabled(true).unwrap();
        let before_send: Vec<_> = b.pending_outbound().iter().map(|e| e.id).collect();
        b.send(
            &ak.public_key().to_hex(),
            "First message while you are away",
        )
        .unwrap();
        let expected_message = b.conversations()[0].messages.last().unwrap().id.clone();
        let pending = b.pending_outbound();
        let response = pending
            .iter()
            .find(|e| e.kind.as_u16() == 1059)
            .unwrap()
            .clone();
        let message = pending
            .iter()
            .find(|e| e.kind.as_u16() == 1060 && !before_send.contains(&e.id))
            .unwrap()
            .clone();
        let alone = serde_json::json!({"event":message}).to_string();
        assert!(!resolve(ad.path(), ak.public_key(), &ak, &alone).show);
        let file = ad.path().join("private-messages/messages.sqlite3");
        let before = std::fs::read(&file).unwrap();
        let replay =
            serde_json::json!({"event":message,"pending_events":[response,response]}).to_string();
        let resolution = resolve(ad.path(), ak.public_key(), &ak, &replay);
        assert!(
            resolution.show,
            "cold private/public contact should resolve after verified handshake replay; public={public}"
        );
        assert_eq!(resolution.notification_id, message.id.to_hex());
        assert_eq!(
            resolution.message_id,
            Some(expected_message),
            "the alert must represent the actual user message, not a handshake control"
        );
        assert_eq!(resolution.peer_id, Some(bk.public_key().to_hex()));
        assert_eq!(
            resolve(ad.path(), ak.public_key(), &ak, &replay),
            resolution,
            "duplicate controls are idempotent"
        );
        let reordered =
            serde_json::json!({"event":response,"pending_events":[message]}).to_string();
        assert_eq!(
            resolve(ad.path(), ak.public_key(), &ak, &reordered),
            resolution,
            "late handshake may unlock an earlier message"
        );
        let mut forged = response.clone();
        forged.content.push('x');
        assert!(
            !resolve(
                ad.path(),
                ak.public_key(),
                &ak,
                &serde_json::json!({"event":message,"pending_events":[forged]}).to_string()
            )
            .show
        );
        assert_eq!(
            std::fs::read(&file).unwrap(),
            before,
            "all replay mutations stay in memory"
        );
        a.mark_notifications_presented(&[message.id.to_hex()])
            .unwrap();
        assert!(!resolve(ad.path(), ak.public_key(), &ak, &replay).show);
        assert!(
            !resolve(
                ad.path(),
                ak.public_key(),
                &ak,
                &serde_json::json!({"event":message,"pending_events":vec![response;17]})
                    .to_string()
            )
            .show,
            "replay count is bounded"
        );
    }
}

#[test]
fn linked_preview_and_registration_respect_local_signed_device_revocation() {
    let ad = tempfile::tempdir().unwrap();
    let bd = tempfile::tempdir().unwrap();
    let owner = Keys::generate();
    let device = Keys::generate();
    let bk = Keys::generate();
    let now = nostr::Timestamp::now().as_secs();
    let roster = |devices: Vec<nostr::PublicKey>, at: u64| {
        iris_chat_protocol::AppKeys::new(
            devices
                .into_iter()
                .map(|key| iris_chat_protocol::DeviceEntry::new(key, at))
                .collect(),
        )
        .get_event_at(owner.public_key(), at)
        .sign_with_keys(&owner)
        .unwrap()
    };
    let authorization = roster(vec![device.public_key()], now - 2);
    let mut a = Messaging::open_identity(
        ad.path(),
        owner.public_key(),
        None,
        device.clone(),
        Some(&authorization),
    )
    .unwrap();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    b.ingest_authorization(&authorization).unwrap();
    b.accept_invite(&a.invite().unwrap()).unwrap();
    exchange(&mut a, &mut b);
    a.set_push_enabled(true).unwrap();
    b.send(
        &owner.public_key().to_hex(),
        "Device-approved private message",
    )
    .unwrap();
    let event = b
        .pending_outbound()
        .into_iter()
        .find(|e| e.kind.as_u16() == 1060)
        .unwrap();
    let payload = serde_json::json!({"event":event}).to_string();
    assert!(resolve(ad.path(), owner.public_key(), &device, &payload).show);
    a.ingest_authorization(&roster(vec![Keys::generate().public_key()], now - 1))
        .unwrap();
    assert!(!a.can_send());
    assert!(a.push_snapshot().unwrap().filters.is_empty());
    assert!(
        !resolve(ad.path(), owner.public_key(), &device, &payload).show,
        "read-only preview cannot bypass the signed local-device roster"
    );
}
