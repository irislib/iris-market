//! Opt-in, file-driven cross-language wire test. Uses no network and only synthetic identities.
use iris_market_core::messaging::Messaging;
use nostr::{Event, Keys};
use serde::Deserialize;
use std::{env, fs, path::PathBuf};
#[derive(Deserialize)]
struct Input {
    authorization: Event,
    invite: Event,
    #[serde(default)]
    incoming: Vec<Event>,
    expected_text: Option<String>,
    send_text: Option<String>,
    expected_order: Option<String>,
    order_patch: Option<serde_json::Value>,
    #[serde(default)]
    mark_read: Vec<String>,
    #[serde(default)]
    toggle_reactions: Vec<ReactionCommand>,
    #[serde(default)]
    expected_controls: Vec<ExpectedControl>,
}
#[derive(Deserialize)]
struct ReactionCommand {
    message_id: String,
    emoji: String,
}
#[derive(Deserialize)]
struct ExpectedControl {
    message_id: String,
    delivery: Option<String>,
    reaction_emoji: Option<String>,
    reaction_count: Option<usize>,
}
#[test]
#[ignore = "requires JS NdrRuntime fixture producer; no live accounts or relays"]
fn javascript_runtime_wire_roundtrip() {
    let input_path =
        PathBuf::from(env::var("MARKET_INTEROP_JS_INPUT").expect("synthetic JS fixture path"));
    let directory =
        PathBuf::from(env::var("MARKET_INTEROP_DATA_DIR").expect("task-exclusive test directory"));
    let output = PathBuf::from(env::var("MARKET_INTEROP_RUST_OUTPUT").expect("wire output path"));
    let input: Input = serde_json::from_slice(&fs::read(input_path).unwrap()).unwrap();
    // Published test constant, never an account key or production credential.
    let keys =
        Keys::parse("1111111111111111111111111111111111111111111111111111111111111111").unwrap();
    let mut market = Messaging::open(&directory, keys.clone()).unwrap();
    let timestamp = nostr::Timestamp::now().as_secs();
    let authorization =
        iris_chat_protocol::AppKeys::new(vec![iris_chat_protocol::DeviceEntry::new(
            keys.public_key(),
            timestamp,
        )])
        .get_event_at(keys.public_key(), timestamp)
        .sign_with_keys(&keys)
        .unwrap();
    market.ingest_authorization(&authorization).unwrap();
    market.ingest_authorization(&input.authorization).unwrap();
    if market.conversations().is_empty() {
        market
            .accept_public_contact_event(&input.invite, &input.authorization.pubkey.to_hex())
            .unwrap();
    }
    for event in input.incoming {
        market.receive(&event).unwrap();
    }
    let received = market
        .conversations()
        .into_iter()
        .flat_map(|thread| thread.messages)
        .filter(|message| !message.mine)
        .map(|message| message.text)
        .collect::<Vec<_>>();
    if let Some(expected) = input.expected_text {
        assert!(received.contains(&expected), "JS message was not received");
    }
    if let Some(expected) = input.expected_order {
        assert!(
            market.orders().iter().any(|view| view.order.id == expected),
            "JS order was not received"
        );
        if let Some(patch) = input.order_patch {
            market.update_order(&expected, patch).unwrap();
        }
    }
    if !input.mark_read.is_empty() {
        market.mark_messages_read(&input.mark_read).unwrap();
    }
    for reaction in input.toggle_reactions {
        market
            .toggle_reaction(
                &input.authorization.pubkey.to_hex(),
                &reaction.message_id,
                &reaction.emoji,
            )
            .unwrap();
    }
    for expected in input.expected_controls {
        let conversations = market.conversations();
        let message = conversations
            .iter()
            .flat_map(|thread| thread.messages.iter())
            .find(|message| message.id == expected.message_id)
            .expect("expected private control target");
        if let Some(delivery) = expected.delivery {
            assert_eq!(message.delivery, delivery);
        }
        if let Some(emoji) = expected.reaction_emoji {
            let reaction = message
                .reactions
                .iter()
                .find(|reaction| reaction.emoji == emoji)
                .expect("expected private emoji reaction");
            assert_eq!(reaction.count, expected.reaction_count.unwrap_or(1));
        }
    }
    if let Some(text) = input.send_text {
        market
            .send(&input.authorization.pubkey.to_hex(), &text)
            .unwrap();
    }
    market.retry().unwrap();
    let outgoing = market.pending_outbound();
    for event in &outgoing {
        assert_ne!(event.pubkey, keys.public_key());
    }
    let invite = market.public_contact_event().unwrap();
    fs::write(output,serde_json::to_vec_pretty(&serde_json::json!({"owner_public_key":keys.public_key().to_hex(),"authorization":authorization,"invite":invite,"outgoing":outgoing,"received":received,"orders":market.orders(),"conversations":market.conversations()})).unwrap()).unwrap();
    for event in outgoing {
        market.acknowledge_published(&event.id.to_hex()).unwrap();
    }
}

#[test]
#[ignore = "requires the isolated localhost strict-JS peer fixture"]
fn fresh_native_profile_orders_with_strict_js_peer() {
    use iris_market_core::{Market, model::Settings, store::Store};
    use serde_json::{Value, json};
    use std::time::{Duration, Instant};
    let relay = env::var("MARKET_NATIVE_RELAY").expect("local fixture relay");
    let url = url::Url::parse(&relay).unwrap();
    assert_eq!(url.scheme(), "ws");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let mut relays = vec![relay];
    let legacy = env::var_os("MARKET_TEST_OWNER_KEY_SESSION").is_some();
    if let Ok(silent) = env::var("MARKET_NATIVE_SILENT_RELAY") {
        let url = url::Url::parse(&silent).unwrap();
        assert_eq!(url.scheme(), "ws");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        relays.push(silent);
    }
    let directory = tempfile::tempdir().unwrap();
    Store::open(&directory.path().join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays,
            ..Default::default()
        })
        .unwrap();
    let secret = iris_market_core::generate_secret_key();
    let market = if legacy {
        Market::open(directory.path(), &secret, false)
    } else {
        Market::open_fresh(directory.path(), &secret)
    }
    .unwrap();
    let snapshot = || serde_json::from_str::<Value>(&market.snapshot().unwrap()).unwrap();
    assert_eq!(snapshot()["messaging_ready"], true);
    // Fresh profiles browse as guests until the explicit local setup action.
    if !legacy {
        market
            .command(r#"{"type":"update_profile","name":"Synthetic buyer"}"#)
            .unwrap();
    }
    assert_eq!(snapshot()["profile_name_required"], false);
    let end = Instant::now() + Duration::from_secs(30);
    while snapshot()["listings"].as_array().unwrap().is_empty() {
        assert!(
            Instant::now() < end,
            "Native app did not discover the JS listing"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let id = snapshot()["listings"][0]["id"].clone();
    market.command(&json!({"type":"request_order","listing_id":id,"quantity":1,"note":"Synthetic native order"}).to_string()).unwrap();
    if legacy {
        assert_eq!(snapshot()["needs_chat_device_approval"], true);
    }
    let end = Instant::now() + Duration::from_secs(40);
    loop {
        let state = snapshot();
        if state["orders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|order| order["status"] == "accepted")
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "Strict JS peer did not accept fresh native order"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    market.shutdown();
    if legacy {
        let reopened = Market::open(directory.path(), &secret, false).unwrap();
        let state: Value = serde_json::from_str(&reopened.snapshot().unwrap()).unwrap();
        assert_eq!(state["needs_chat_device_approval"], true);
        assert_eq!(state["orders"][0]["status"], "accepted");
        reopened.shutdown();
    }
}

/// Explicit opt-in diagnostic: public discovery reads only; never start Market's sender.
#[test]
#[ignore = "requires an explicitly supplied public contact fixture; read-only relay access"]
fn public_contact_discovery_read_only() {
    use nostr_pubsub::NostrEventSubscriber;
    use nostr_pubsub_relay::RelayEventBus;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };
    let input: Input = serde_json::from_slice(
        &fs::read(env::var("MARKET_PUBLIC_CONTACT_INPUT").expect("public contact fixture path"))
            .unwrap(),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut messaging = Messaging::open(directory.path(), Keys::generate()).unwrap();
    let owner = input.authorization.pubkey.to_hex();
    messaging.open_contact(&owner).unwrap();
    runtime.block_on(async {
        let relays = iris_market_core::model::Settings::default().relays;
        for prefix in ["private-authorization-", "private-device-invites-"] {
            let scope = messaging
                .subscriptions()
                .into_iter()
                .find(|scope| {
                    scope.scope.starts_with(prefix)
                        && if prefix == "private-authorization-" {
                            scope.scope.ends_with(&owner)
                        } else {
                            scope.scope.ends_with(&input.invite.pubkey.to_hex())
                        }
                })
                .expect("verified discovery scope");
            let bus = RelayEventBus::new(relays.clone(), Duration::from_secs(4))
                .await
                .unwrap();
            bus.client()
                .wait_for_connection(Duration::from_secs(4))
                .await;
            let received = Arc::new(Mutex::new(Vec::new()));
            let collector = received.clone();
            let _subscription = bus
                .subscribe(
                    vec![scope.filter],
                    Arc::new(move |event| {
                        collector
                            .lock()
                            .unwrap()
                            .push(event.event.as_event().clone());
                    }),
                )
                .await
                .unwrap();
            let expected = if prefix == "private-authorization-" {
                input.authorization.id
            } else {
                input.invite.id
            };
            let end = tokio::time::Instant::now() + Duration::from_secs(12);
            loop {
                let events = std::mem::take(&mut *received.lock().unwrap());
                let mut found = false;
                for event in events {
                    if event.id == expected {
                        messaging.receive(&event).unwrap();
                        found = true;
                    }
                }
                if found {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < end,
                    "Native relay discovery did not return the known public record"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            bus.client().shutdown().await;
        }
    });
}
