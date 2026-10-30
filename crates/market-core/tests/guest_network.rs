//! Visitor privacy over a real loopback relay. No public network or credentials.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{Market, model::Settings, store::Store};
use nostr::{Event, JsonUtil};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for loopback exchange"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn fresh_guest_reopens_without_public_or_private_activity_then_explicit_setup_activates() {
    guest_activation("Local fixture");
}

#[test]
fn blank_setup_activates_without_metadata_and_stays_complete_after_reopen() {
    guest_activation("");
}

fn guest_activation(name: &str) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let wire = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = wire.clone();
    let server = runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                while let Some(Ok(message)) = socket.next().await {
                    let text = match message {
                        Message::Ping(data) => {
                            let _ = socket.send(Message::Pong(data)).await;
                            continue;
                        }
                        Message::Text(text) => text,
                        _ => continue,
                    };
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    log.lock().unwrap().push(frame.clone());
                    match frame[0].as_str() {
                        Some("REQ") => {
                            let _ = socket
                                .send(Message::Text(json!(["EOSE", frame[1]]).to_string().into()))
                                .await;
                        }
                        Some("EVENT") => {
                            let event = Event::from_json(frame[1].to_string()).unwrap();
                            event.verify().unwrap();
                            let _ = socket
                                .send(Message::Text(
                                    json!(["OK", event.id.to_hex(), true, ""])
                                        .to_string()
                                        .into(),
                                ))
                                .await;
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    store
        .save_settings(&Settings {
            relays: vec![relay.clone()],
            ..Default::default()
        })
        .unwrap();
    let secret = iris_market_core::generate_secret_key();
    let guest = Market::open_fresh(dir.path(), &secret).unwrap();
    let initial = store.initial_authorization().unwrap().unwrap();
    let assert_guest = |app: &Market| {
        assert_eq!(
            serde_json::from_str::<Value>(&app.snapshot().unwrap()).unwrap()["profile_name_required"],
            true
        );
        wait_until(|| {
            wire.lock()
                .unwrap()
                .iter()
                .filter(|f| f[0] == "REQ")
                .count()
                >= 2
        });
        // Wait through a normal public-worker round after EOSE. An ungated
        // outbox would publish immediately; private discovery would add REQs.
        std::thread::sleep(Duration::from_millis(600));
        let frames = wire.lock().unwrap();
        assert!(
            !frames.iter().any(|f| f[0] == "EVENT"),
            "Guest must not publish even authorization/contact events"
        );
        for frame in frames.iter().filter(|f| f[0] == "REQ") {
            for filter in &frame.as_array().unwrap()[2..] {
                assert!(
                    filter["kinds"].as_array().is_some_and(|kinds| kinds
                        .iter()
                        .all(|kind| matches!(kind.as_u64(), Some(0 | 3 | 5 | 30402)))),
                    "Only public listing/profile discovery is expected for this guest fixture: {filter}"
                );
                assert!(filter.get("#p").is_none());
            }
        }
    };
    assert_guest(&guest);
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .any(|event| event.id == initial.id)
    );
    guest.shutdown();
    drop(guest);
    wire.lock().unwrap().clear();
    let guest = Market::open(dir.path(), &secret, false).unwrap();
    assert_guest(&guest);
    let activated: Value = serde_json::from_str(
        &guest
            .command(&json!({"type":"update_profile","name":name}).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(activated["profile_name_required"], false);
    wait_until(|| {
        let frames = wire.lock().unwrap();
        frames
            .iter()
            .any(|f| f[0] == "EVENT" && f[1]["id"] == initial.id.to_hex())
            && (name.is_empty() || frames.iter().any(|f| f[0] == "EVENT" && f[1]["kind"] == 0))
    });
    wait_until(|| store.pending().unwrap().is_empty());
    if name.is_empty() {
        assert!(
            !wire
                .lock()
                .unwrap()
                .iter()
                .any(|f| f[0] == "EVENT" && f[1]["kind"] == 0)
        );
        assert!(
            store
                .profile_metadata(&initial.pubkey.to_hex())
                .unwrap()
                .is_none()
        );
        assert!(store.profile_setup_complete(initial.pubkey).unwrap());
    }
    guest.shutdown();
    drop(guest);
    wire.lock().unwrap().clear();
    // Restoring the completed profile never re-enters visitor mode and still
    // publishes an explicitly requested update.
    let restored = Market::open(dir.path(), &secret, false).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&restored.snapshot().unwrap()).unwrap()["profile_name_required"],
        false
    );
    if name.is_empty() {
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !wire
                .lock()
                .unwrap()
                .iter()
                .any(|f| f[0] == "EVENT" && f[1]["kind"] == 0)
        );
        assert!(
            restored
                .command(r#"{"type":"update_profile","name":""}"#)
                .is_err(),
            "Blank edits do not silently erase an existing profile"
        );
    }
    restored
        .command(r#"{"type":"update_profile","name":"Restored fixture"}"#)
        .unwrap();
    wait_until(|| {
        wire.lock()
            .unwrap()
            .iter()
            .any(|f| f[0] == "EVENT" && f[1]["kind"] == 0)
    });
    restored.shutdown();
    wire.lock().unwrap().clear();
    let legacy_dir = tempfile::tempdir().unwrap();
    let mut legacy_store = Store::open(&legacy_dir.path().join("market.sqlite")).unwrap();
    legacy_store
        .save_settings(&Settings {
            relays: vec![relay],
            ..Default::default()
        })
        .unwrap();
    let legacy_keys = nostr::Keys::generate();
    let metadata =
        nostr::EventBuilder::new(nostr::Kind::Metadata, r#"{"name":"Existing fixture"}"#)
            .sign_with_keys(&legacy_keys)
            .unwrap();
    legacy_store.queue_profile_metadata(&metadata).unwrap();
    let legacy = Market::open(
        legacy_dir.path(),
        &legacy_keys.secret_key().to_secret_hex(),
        false,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&legacy.snapshot().unwrap()).unwrap()["profile_name_required"],
        false
    );
    wait_until(|| {
        wire.lock()
            .unwrap()
            .iter()
            .any(|f| f[0] == "EVENT" && f[1]["id"] == metadata.id.to_hex())
    });
    legacy.shutdown();
    server.abort();
}
