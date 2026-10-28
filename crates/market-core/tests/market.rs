use iris_market_core::{
    Market, listing,
    model::{Draft, Settings},
    store::Store,
};
use nostr::Keys;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};

fn draft() -> Draft {
    Draft {
        title: "A useful camera".into(),
        description: "Works well".into(),
        side: "offer".into(),
        price: "120".into(),
        currency: "EUR".into(),
        location: "Helsinki".into(),
        category: "Photography".into(),
        image_url: None,
        expires_at: None,
    }
}
fn offline(dir: &std::path::Path) {
    let store = Store::open(&dir.join("market.sqlite")).unwrap();
    store
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
}

#[test]
fn signed_revisions_survive_restart_without_resurrecting_closed_or_expired_offers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("market.sqlite");
    let keys = Keys::generate();
    let mut store = Store::open(&path).unwrap();
    let d = draft();
    let first = listing::build(&keys, &d, "camera", 100, false).unwrap();
    assert!(store.ingest(&first, 100, false).unwrap());
    store
        .toggle_saved(&format!("{}:camera", keys.public_key().to_hex()))
        .unwrap();
    let closed = listing::build(&keys, &d, "camera", 101, true).unwrap();
    store.ingest(&closed, 101, false).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(!store.ingest(&first, 102, false).unwrap());
    assert!(
        store
            .listings(&keys.public_key().to_hex(), 102)
            .unwrap()
            .is_empty()
    );
    let mut expires = d.clone();
    expires.expires_at = Some(110);
    let newer = listing::build(&keys, &expires, "camera", 105, false).unwrap();
    store.ingest(&newer, 105, false).unwrap();
    assert_eq!(
        store
            .listings(&keys.public_key().to_hex(), 109)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .listings(&keys.public_key().to_hex(), 110)
            .unwrap()
            .is_empty()
    );
    assert!(!store.ingest(&first, 110, false).unwrap());
}

#[test]
fn verification_and_coordinate_ordering_are_transport_independent() {
    let keys = Keys::generate();
    let d = draft();
    let good = listing::build(&keys, &d, "x", 100, false).unwrap();
    let mut forged = good.clone();
    forged.content = "Changed after signing".into();
    assert!(listing::parse(&forged, 100).is_err());
    assert!(listing::parse(&good, 0).is_ok());
    let future = listing::build(&keys, &d, "x", 500, false).unwrap();
    assert!(listing::parse(&future, 100).is_err());
    let mut other = d.clone();
    other.title = "Different revision".into();
    let second = listing::build(&keys, &other, "x", 100, false).unwrap();
    for events in [
        &[good.clone(), second.clone()][..],
        &[second.clone(), good.clone()][..],
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        for e in events {
            store.ingest(e, 100, false).unwrap();
        }
        let winner = store
            .event(&format!("{}:x", keys.public_key().to_hex()))
            .unwrap();
        assert_eq!(winner.id, good.id.min(second.id));
    }
}

#[test]
fn preview_is_explicit_and_cannot_publish_or_call_a_provider() {
    let dir = tempfile::tempdir().unwrap();
    let app = Market::open(dir.path(), &iris_market_core::generate_secret_key(), true).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(state["demo"], true);
    assert_eq!(state["listings"].as_array().unwrap().len(), 8);
    assert!(
        app.command(&json!({"type":"publish","draft":draft()}).to_string())
            .is_err()
    );
    assert!(
        app.command(r#"{"type":"check_ai","api_key":"unused"}"#)
            .is_err()
    );
    assert!(
        app.command(&json!({"type":"save","id":state["listings"][0]["id"]}).to_string())
            .is_ok()
    );
    let state: Value = serde_json::from_str(
        &app.command(r#"{"type":"set_filter","query":"bike","side":"offer"}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(state["listings"].as_array().unwrap().len(), 1);
    app.shutdown();
}

#[test]
fn queued_posts_and_settings_persist_without_exporting_credentials() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let secret = iris_market_core::generate_secret_key();
    let app = Market::open(dir.path(), &secret, false).unwrap();
    let raw = app
        .command(&json!({"type":"publish","draft":draft()}).to_string())
        .unwrap();
    assert!(!raw.contains(&secret));
    let state: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(state["listings"][0]["delivery"], "queued");
    let id = state["listings"][0]["id"].clone();
    app.command(&json!({"type":"save","id":id}).to_string())
        .unwrap();
    app.shutdown();
    drop(app);
    let app = Market::open(dir.path(), &secret, false).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(state["saved_count"], 1);
    assert_eq!(state["listings"][0]["delivery"], "queued");
    app.shutdown();
}

#[test]
fn configurable_model_produces_a_yes_no_decision_without_removing_the_listing() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let len = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() >= end + 4 + len {
                    break;
                }
            }
        }
        let request = String::from_utf8(bytes).unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"));
        assert!(request.contains("untrusted data"));
        assert!(request.contains("test-model"));
        let body=json!({"choices":[{"message":{"content":"{\"show\":false,\"reason\":\"You asked for bicycles\"}"}}]}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let app = Market::open(dir.path(), &iris_market_core::generate_secret_key(), false).unwrap();
    let seller = Keys::generate();
    app.ingest_event(&listing::build(&seller, &draft(), "x", listing::now(), false).unwrap())
        .unwrap();
    let mut settings = Settings {
        relays: vec![],
        ..Default::default()
    };
    settings.ai.enabled = true;
    settings.ai.model = "test-model".into();
    settings.ai.base_url = format!("http://127.0.0.1:{port}/v1");
    settings.ai.interests = "bicycles".into();
    settings.ai.curate_feed = true;
    app.command(&json!({"type":"set_settings","settings":settings}).to_string())
        .unwrap();
    let raw = app
        .command(r#"{"type":"curate","api_key":"private-test-key"}"#)
        .unwrap();
    assert!(!raw.contains("private-test-key"));
    let state: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(state["listings"].as_array().unwrap().len(), 1);
    assert_eq!(state["listings"][0]["relevance"]["show"], false);
    assert!(iris_market_core::ai::decision(r#"{"show":"false"}"#).is_err());
    server.join().unwrap();
    app.shutdown();
}
