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
    let directory = tempfile::tempdir().unwrap();
    Store::open(&directory.path().join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![relay],
            ..Default::default()
        })
        .unwrap();
    let market =
        Market::open_fresh(directory.path(), &iris_market_core::generate_secret_key()).unwrap();
    let snapshot = || serde_json::from_str::<Value>(&market.snapshot().unwrap()).unwrap();
    assert_eq!(snapshot()["messaging_ready"], true);
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
}
