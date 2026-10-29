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
        tags: Vec::new(),
        service_areas: None,
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
    app.command(r#"{"type":"set_filter","query":"bicycles","side":"all","ai_search":true}"#)
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

#[test]
fn ai_search_uses_one_query_without_hiding_unreviewed_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let app =
        iris_market_core::Market::open(dir.path(), &iris_market_core::generate_secret_key(), true)
            .unwrap();
    let ordinary: serde_json::Value = serde_json::from_str(
        &app.command(r#"{"type":"set_filter","query":"nonliteral matching request","side":"all"}"#)
            .unwrap(),
    )
    .unwrap();
    assert!(ordinary["listings"].as_array().unwrap().is_empty());
    let ai: serde_json::Value = serde_json::from_str(&app.command(r#"{"type":"set_filter","query":"nonliteral matching request","side":"all","ai_search":true}"#).unwrap()).unwrap();
    assert_eq!(ai["listings"].as_array().unwrap().len(), 8);
    assert_eq!(ai["query"], "nonliteral matching request");
    assert_eq!(ai["ai_search"], true);
    let profile: serde_json::Value = serde_json::from_str(
        &app.command(
            &serde_json::json!({"type":"load_profile","author":ai["listings"][0]["author"]})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        profile["profile"]["error"],
        "Profiles are unavailable in offline preview."
    );
    assert_eq!(profile["graph_context_loaded"], false);
    let newest: serde_json::Value = serde_json::from_str(
        &app.command(r#"{"type":"set_sort","sort":"newest"}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(newest["sort"], "newest");
}

#[test]
fn fresh_profile_persists_initial_roster_and_returns_ready_without_network() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let secret = iris_market_core::generate_secret_key();
    let app = Market::open_fresh(dir.path(), &secret).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(state["can_sign"], true);
    assert_eq!(state["messaging_ready"], true);
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    let proof = store.initial_authorization().unwrap().unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.pubkey.to_hex(), state["public_key"]);
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .any(|event| event.id == proof.id)
    );
    let initial_id = proof.id;
    app.shutdown();
    drop(app);
    // Replaying a persisted bootstrap intent reuses exactly the original roster.
    let resumed = Market::open_fresh(dir.path(), &secret).unwrap();
    assert_eq!(
        store.initial_authorization().unwrap().unwrap().id,
        initial_id
    );
    resumed.shutdown();
    drop(resumed);
    let restored = Market::open(dir.path(), &secret, false).unwrap();
    let state: Value = serde_json::from_str(&restored.snapshot().unwrap()).unwrap();
    assert_eq!(state["messaging_ready"], true);
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .any(|event| event.id == initial_id)
    );
    restored.shutdown();
}

#[test]
fn fresh_constructor_never_rewrites_existing_legacy_or_other_owner_authorization() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let secret = iris_market_core::generate_secret_key();
    let legacy = Market::open(dir.path(), &secret, false).unwrap();
    legacy.shutdown();
    drop(legacy);
    assert!(Market::open_fresh(dir.path(), &secret).is_err());
    assert!(
        Store::open(&dir.path().join("market.sqlite"))
            .unwrap()
            .initial_authorization()
            .unwrap()
            .is_none()
    );
    let fresh_dir = tempfile::tempdir().unwrap();
    offline(fresh_dir.path());
    let app = Market::open_fresh(fresh_dir.path(), &secret).unwrap();
    app.shutdown();
    drop(app);
    assert!(
        Market::open_fresh(fresh_dir.path(), &iris_market_core::generate_secret_key()).is_err()
    );
}

#[test]
fn public_profile_listings_are_cached_immediately_and_independent_of_browse_filters() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let app = Market::open(dir.path(), &iris_market_core::generate_secret_key(), false).unwrap();
    let author = Keys::generate();
    let now = listing::now();
    for i in 0..60 {
        let mut d = draft();
        d.title = format!("Author listing {i}");
        app.ingest_event(
            &listing::build(&author, &d, &format!("author-{i}"), now - i, false).unwrap(),
        )
        .unwrap();
    }
    // The latest closed revision remains a tombstone, not a visible profile tile.
    app.ingest_event(&listing::build(&author, &draft(), "author-5", now + 1, true).unwrap())
        .unwrap();
    app.command(r#"{"type":"set_filter","query":"no-match","side":"request"}"#)
        .unwrap();
    let state: Value = serde_json::from_str(
        &app.command(
            &json!({"type":"load_profile","author":author.public_key().to_hex()}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(state["listings"].as_array().unwrap().is_empty());
    assert_eq!(state["query"], "no-match");
    assert_eq!(state["side"], "request");
    let page = &state["profile_listings"];
    assert_eq!(page["listings"].as_array().unwrap().len(), 48);
    assert_eq!(page["can_load_more"], true);
    assert_eq!(page["loading"], false);
    assert!(
        !page["listings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == format!("{}:author-5", author.public_key().to_hex()))
    );
    let state: Value = serde_json::from_str(
        &app.command(
            &json!({"type":"load_more_profile_listings","author":author.public_key().to_hex()})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        state["profile_listings"]["listings"]
            .as_array()
            .unwrap()
            .len(),
        59
    );
    assert_eq!(state["profile_listings"]["can_load_more"], false);
    app.command(
        &json!({"type":"close_profile","author":Keys::generate().public_key().to_hex()})
            .to_string(),
    )
    .unwrap();
    assert!(
        serde_json::from_str::<Value>(&app.snapshot().unwrap()).unwrap()["profile_listings"]
            .is_object()
    );
    app.command(&json!({"type":"close_profile","author":author.public_key().to_hex()}).to_string())
        .unwrap();
    assert!(
        serde_json::from_str::<Value>(&app.snapshot().unwrap()).unwrap()["profile_listings"]
            .is_null()
    );
    app.shutdown();
}

#[test]
fn saved_items_do_not_follow_browse_query_or_side_and_still_obey_winners() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let keys = Keys::generate();
    let app = Market::open(dir.path(), &keys.secret_key().to_secret_hex(), false).unwrap();
    let event = listing::build(&keys, &draft(), "saved", listing::now(), false).unwrap();
    app.ingest_event(&event).unwrap();
    let id = format!("{}:saved", keys.public_key().to_hex());
    app.command(&json!({"type":"save","id":id}).to_string())
        .unwrap();
    let state: Value = serde_json::from_str(
        &app.command(r#"{"type":"set_filter","query":"does not match","side":"request"}"#)
            .unwrap(),
    )
    .unwrap();
    assert!(state["listings"].as_array().unwrap().is_empty());
    assert_eq!(state["saved_listings"][0]["id"], id);
    assert_eq!(state["saved_count"], 1);
    assert!(!state["people"][keys.public_key().to_hex()].is_null());
    let closed = listing::build(&keys, &draft(), "saved", listing::now() + 1, true).unwrap();
    app.ingest_event(&closed).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert!(state["saved_listings"].as_array().unwrap().is_empty());
    assert_eq!(state["saved_count"], 0);
}

#[test]
fn fresh_name_commits_locally_queues_and_restores_without_relay_ack() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let secret = iris_market_core::generate_secret_key();
    let app = Market::open_fresh(dir.path(), &secret).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(state["profile_name_required"], true);
    let state: Value = serde_json::from_str(
        &app.command(r#"{"type":"update_profile","name":"Taylor"}"#)
            .unwrap(),
    )
    .unwrap();
    let owner = state["public_key"].as_str().unwrap();
    assert_eq!(state["people"][owner]["name"], "Taylor");
    assert_eq!(state["profile_name_required"], false);
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    let metadata = store.profile_metadata(owner).unwrap().unwrap();
    metadata.verify().unwrap();
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .any(|event| event.id == metadata.id)
    );
    drop(store);
    app.shutdown();
    let restored = Market::open(dir.path(), &secret, false).unwrap();
    let state: Value = serde_json::from_str(&restored.snapshot().unwrap()).unwrap();
    assert_eq!(state["people"][owner]["name"], "Taylor");
    assert_eq!(state["profile_name_required"], false);
}

#[test]
fn imported_name_edit_preserves_signed_metadata_and_does_not_require_signup() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let keys = Keys::generate();
    let metadata = nostr::EventBuilder::new(nostr::Kind::Metadata, r#"{"name":"Old","about":"Original description","website":"https://example.com","custom":{"preserve":true}}"#).sign_with_keys(&keys).unwrap();
    let cache = iris_market_core::public_cache::PublicEventCache::open(
        &dir.path().join("public-events.sqlite"),
    )
    .unwrap();
    cache.ingest(&metadata).unwrap();
    drop(cache);
    let app = Market::open(dir.path(), &keys.secret_key().to_secret_hex(), false).unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(state["profile_name_required"], false);
    app.command(r#"{"type":"update_profile","name":"New"}"#)
        .unwrap();
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    let current = store
        .profile_metadata(&keys.public_key().to_hex())
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(&current.content).unwrap();
    assert_eq!(value["name"], "New");
    assert_eq!(value["about"], "Original description");
    assert_eq!(value["custom"]["preserve"], true);
    assert_eq!(value["website"], "https://example.com");
    assert!(current.created_at > metadata.created_at);
}

#[test]
fn ai_configuration_provenance_preserves_explicit_off_and_legacy_missing_block() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("market.sqlite");
    let store = Store::open(&path).unwrap();
    assert!(!store.ai_configured().unwrap());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO preferences VALUES ('settings', ?1)",
            [r#"{"relays":[]}"#],
        )
        .unwrap();
    assert!(!store.ai_configured().unwrap());
    store.save_settings(&Settings::default()).unwrap();
    assert!(store.ai_configured().unwrap());
    assert!(!store.settings().unwrap().ai.enabled);
}

#[test]
fn display_currency_projects_browse_saved_and_author_without_mutating_signed_price() {
    let dir = tempfile::tempdir().unwrap();
    offline(dir.path());
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    let now = listing::now();
    let book = iris_market_core::rates::RateBook::from_cache(
        &json!({"rates":{
            "EUR":{"value":60000.0,"source":"Coinbase","updated_at":now},
            "USD":{"value":66000.0,"source":"Coinbase","updated_at":now}
        }})
        .to_string(),
        now,
    )
    .unwrap();
    store.save_exchange_rates(&book).unwrap();
    let app = Market::open(dir.path(), &iris_market_core::generate_secret_key(), false).unwrap();
    let seller = Keys::generate();
    let mut d = draft();
    d.currency = "USD".into();
    d.price = "66".into();
    let event = listing::build(&seller, &d, "conversion", now, false).unwrap();
    app.ingest_event(&event).unwrap();
    let id = format!("{}:conversion", seller.public_key().to_hex());
    let state: Value = serde_json::from_str(
        &app.command(&json!({"type":"save","id":id}).to_string())
            .unwrap(),
    )
    .unwrap();
    for key in ["listings", "saved_listings"] {
        assert_eq!(state[key][0]["price"], "66");
        assert_eq!(state[key][0]["currency"], "USD");
        assert!((state[key][0]["display_price"]["amount"].as_f64().unwrap() - 60.0).abs() < 1e-9);
        assert_eq!(state[key][0]["display_price"]["currency"], "EUR");
    }
    app.command(&json!({"type":"load_profile","author":seller.public_key().to_hex()}).to_string())
        .unwrap();
    let state: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(
        state["profile_listings"]["listings"][0]["display_price"]["currency"],
        "EUR"
    );
    assert_eq!(state["exchange_rates"]["status"], "fresh");
    assert_eq!(store.event(&id).unwrap(), event);
    let mut settings = store.settings().unwrap();
    settings.currency = "INVALID".into();
    assert!(
        app.command(&json!({"type":"set_settings","settings":settings}).to_string())
            .is_err()
    );
    app.shutdown();
}
