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
