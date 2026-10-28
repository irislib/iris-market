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
    send_text: String,
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
    market
        .send(&input.authorization.pubkey.to_hex(), &input.send_text)
        .unwrap();
    let outgoing = market.pending_outbound();
    for event in &outgoing {
        assert_ne!(event.pubkey, keys.public_key());
    }
    fs::write(output,serde_json::to_vec_pretty(&serde_json::json!({"owner_public_key":keys.public_key().to_hex(),"outgoing":outgoing,"received":received})).unwrap()).unwrap();
    for event in outgoing {
        market.acknowledge_published(&event.id.to_hex()).unwrap();
    }
}
