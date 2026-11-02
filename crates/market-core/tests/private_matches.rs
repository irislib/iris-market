//! Exercise the pending mailbox through the same command and encrypted transport as the app.
use iris_market_core::{Market, messaging::Messaging, model::Settings, store::Store};
use nostr::{JsonUtil, Keys};
use serde_json::{Value, json};
use std::path::Path;
use tempfile::tempdir;

fn open(path: &Path, keys: &Keys) -> Market {
    Store::open(&path.join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    Market::open(path, &keys.secret_key().to_secret_hex(), false).unwrap()
}

fn action(app: &Market, action: Value) {
    app.command(&json!({"type":"private_match","action":action}).to_string())
        .unwrap();
}

#[test]
fn encrypted_offer_reaches_only_the_helpers_private_mailbox() {
    let (origin, helper) = (Keys::generate(), Keys::generate());
    let (a, b) = (tempdir().unwrap(), tempdir().unwrap());
    for (path, keys) in [(a.path(), &origin), (b.path(), &helper)] {
        let app = open(path, keys);
        action(&app, json!({"op":"enable","enabled":true}));
    }
    let app = open(a.path(), &origin);
    action(
        &app,
        json!({"op":"share","helper":helper.public_key(),"side":"offer","summary":"A private cargo bike"}),
    );
    drop(app);
    let mut sender = Messaging::open(a.path(), origin.clone()).unwrap();
    let mut recipient = Messaging::open(b.path(), helper.clone()).unwrap();
    sender.retry().unwrap();
    assert!(sender.pending_outbound().is_empty());
    sender
        .receive(&recipient.public_contact_event().unwrap())
        .unwrap();
    for _ in 0..8 {
        for outbound in [true, false] {
            let (src, dst) = if outbound {
                (&mut sender, &mut recipient)
            } else {
                (&mut recipient, &mut sender)
            };
            src.retry().unwrap();
            for event in src.pending_outbound() {
                let wire = event.as_json();
                for hidden in [
                    "A private cargo bike",
                    "iris-market/private-match",
                    &origin.public_key().to_hex(),
                ] {
                    assert!(!wire.contains(hidden));
                }
                dst.receive(&event).unwrap();
                dst.receive(&event).unwrap();
                src.acknowledge_published(&event.id.to_hex()).unwrap();
            }
        }
    }
    drop((sender, recipient));
    let restored = open(b.path(), &helper);
    let snapshot: Value = serde_json::from_str(&restored.snapshot().unwrap()).unwrap();
    let received = snapshot["private_matching"]["received"]
        .as_object()
        .unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(
        received.values().next().unwrap()["summary"],
        "A private cargo bike"
    );
    assert!(snapshot["listings"].as_array().unwrap().is_empty());
    assert!(
        Store::open(&b.path().join("market.sqlite"))
            .unwrap()
            .pending()
            .unwrap()
            .is_empty()
    );
}
