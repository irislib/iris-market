use iris_market_core::{
    Market, ai, listing,
    model::{AiSettings, Draft, Settings},
    store::Store,
};
use nostr::Keys;
use serde_json::{Value, json};

fn setup() -> (tempfile::TempDir, Market) {
    let dir = tempfile::tempdir().unwrap();
    let market = Market::open(
        dir.path(),
        &Keys::generate().secret_key().to_secret_hex(),
        true,
    )
    .unwrap();
    command(
        &market,
        json!({"type":"set_settings","settings":{"relays":[],"ai":{"enabled":true,"provider":"apple","model":"apple-system","interests":"a camera"}}}),
    );
    command(
        &market,
        json!({"type":"set_filter","query":"a camera","side":"all","ai_search":true}),
    );
    (dir, market)
}
fn command(market: &Market, value: Value) -> Value {
    serde_json::from_str(&market.command(&value.to_string()).unwrap()).unwrap()
}
fn begin(market: &Market) -> Value {
    command(market, json!({"type":"begin_local_curation"}))["local_curation"].clone()
}
fn decisions(batch: &Value) -> Vec<Value> {
    batch["candidates"].as_array().unwrap().iter().map(|candidate| json!({"event_id":candidate["event_id"],"show":false,"reason":"Does not match"})).collect()
}
fn apply(batch: &Value) -> Value {
    json!({"type":"apply_local_curation","id":batch["id"],"decisions":decisions(batch)})
}

#[test]
fn local_models_use_bounded_public_batches_and_keep_hidden_listings_accessible() {
    let (_dir, market) = setup();
    let batch = begin(&market);
    assert!(!batch["candidates"].as_array().unwrap().is_empty());
    assert!(batch["candidates"].as_array().unwrap().len() <= 24);
    assert_eq!(
        batch
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["candidates", "id", "interests"]
    );
    let snapshot = command(&market, apply(&batch));
    assert!(snapshot["local_curation"].is_null());
    assert_eq!(
        snapshot["listings"].as_array().unwrap().len(),
        batch["candidates"].as_array().unwrap().len()
    );
    assert!(
        snapshot["listings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["relevance"]["show"] == false)
    );
    assert!(
        market.command(&apply(&batch).to_string()).is_err(),
        "batch replay must fail"
    );
}

#[test]
fn changed_search_side_settings_and_cancellation_invalidate_a_batch() {
    for change in [
        json!({"type":"set_filter","query":"bicycle","side":"all","ai_search":true}),
        json!({"type":"set_filter","query":"","side":"offer","ai_search":false}),
        json!({"type":"set_settings","settings":{"relays":[],"ai":{"enabled":true,"provider":"litert","model":"gemma","interests":"a camera"}}}),
    ] {
        let (_dir, market) = setup();
        let batch = begin(&market);
        command(&market, change);
        assert!(market.command(&apply(&batch).to_string()).is_err());
        let snapshot: Value = serde_json::from_str(&market.snapshot().unwrap()).unwrap();
        assert!(
            snapshot["listings"]
                .as_array()
                .unwrap()
                .iter()
                .all(|l| l["relevance"].is_null())
        );
    }
    let (_dir, market) = setup();
    let batch = begin(&market);
    command(
        &market,
        json!({"type":"cancel_local_curation","id":batch["id"]}),
    );
    assert!(market.command(&apply(&batch).to_string()).is_err());
}

#[test]
fn malformed_or_partial_results_never_apply_a_partial_filter() {
    let (_dir, market) = setup();
    for mode in ["partial", "duplicate", "unknown"] {
        let batch = begin(&market);
        let mut values = decisions(&batch);
        match mode {
            "partial" => {
                values.pop();
            }
            "duplicate" => values[1] = values[0].clone(),
            _ => values[0]["event_id"] = json!("not-a-listing"),
        }
        assert!(
            market
                .command(
                    &json!({"type":"apply_local_curation","id":batch["id"],"decisions":values})
                        .to_string()
                )
                .is_err()
        );
        let snapshot: Value = serde_json::from_str(&market.snapshot().unwrap()).unwrap();
        assert!(
            snapshot["listings"]
                .as_array()
                .unwrap()
                .iter()
                .all(|l| l["relevance"].is_null())
        );
    }
}

#[test]
fn storage_failure_rolls_back_the_whole_decision_batch() {
    let (dir, market) = setup();
    let batch = begin(&market);
    let connection = rusqlite::Connection::open(dir.path().join("preview.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_second_decision BEFORE INSERT ON relevance WHEN (SELECT count(*) FROM relevance) >= 1 BEGIN SELECT RAISE(ABORT, 'synthetic disk write failure'); END;").unwrap();
    assert!(market.command(&apply(&batch).to_string()).is_err());
    let count: i64 = connection
        .query_row("SELECT count(*) FROM relevance", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "a partial filter must never survive a failed batch"
    );
}

#[test]
fn local_provider_validation_never_uses_endpoint_or_credentials() {
    let ai = AiSettings {
        enabled: true,
        provider: "apple".into(),
        base_url: "this is not a network endpoint".into(),
        ..Default::default()
    };
    assert!(ai::validate(&ai).is_ok());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    assert!(
        runtime
            .block_on(ai::ask(&ai, "", "", ""))
            .unwrap_err()
            .to_string()
            .contains("on-device model")
    );
}

#[test]
fn native_relay_defaults_match_iris_and_preserve_saved_custom_settings() {
    assert_eq!(
        Settings::default().relays,
        [
            "wss://temp.iris.to",
            "wss://vault.iris.to",
            "wss://relay.damus.io",
            "wss://relay.snort.social",
            "wss://relay.primal.net",
            "wss://nos.lol"
        ]
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("market.sqlite");
    let store = Store::open(&path).unwrap();
    store
        .save_settings(&Settings {
            relays: vec!["ws://127.0.0.1:4785".into()],
            ..Default::default()
        })
        .unwrap();
    drop(store);
    assert_eq!(
        Store::open(&path).unwrap().settings().unwrap().relays,
        ["ws://127.0.0.1:4785"]
    );
}

#[test]
fn bounded_batches_do_not_apply_to_replaced_signed_events_or_other_accounts() {
    let (dir, market) = setup();
    let mut store = Store::open(&dir.path().join("preview.sqlite")).unwrap();
    let keys = Keys::generate();
    let draft: Draft = serde_json::from_value(
        json!({"title":"Camera","description":"A useful camera","side":"offer"}),
    )
    .unwrap();
    let now = listing::now();
    for index in 0..40 {
        store
            .ingest(
                &listing::build(&keys, &draft, &format!("camera-{index}"), now, false).unwrap(),
                now,
                false,
            )
            .unwrap();
    }
    let batch = begin(&market);
    assert_eq!(batch["candidates"].as_array().unwrap().len(), 24);
    let candidate = batch["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["listing"]["author"] == keys.public_key().to_hex())
        .unwrap();
    let coordinate = candidate["listing"]["id"].as_str().unwrap();
    let identifier = coordinate.split_once(':').unwrap().1;
    let replacement = listing::build(
        &keys,
        &Draft {
            title: "Changed camera".into(),
            ..draft
        },
        identifier,
        now + 1,
        false,
    )
    .unwrap();
    store.ingest(&replacement, now + 1, false).unwrap();
    let snapshot = command(&market, apply(&batch));
    let changed = snapshot["listings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == coordinate)
        .unwrap();
    assert_eq!(changed["title"], "Changed camera");
    assert!(changed["relevance"].is_null());
    let (_other_dir, other) = setup();
    let _ = begin(&other);
    assert!(other.command(&apply(&batch).to_string()).is_err());
}

#[test]
fn normal_feed_never_uses_legacy_interests_to_start_local_inference() {
    let (_dir, market) = setup();
    for filter in [
        json!({"type":"set_filter","query":"","side":"all","ai_search":false}),
        json!({"type":"set_filter","query":" ","side":"all","ai_search":true}),
        json!({"type":"set_filter","query":"camera","side":"all","ai_search":false}),
    ] {
        command(&market, filter);
        assert!(
            market
                .command(r#"{"type":"begin_local_curation"}"#)
                .is_err()
        );
        let state: Value = serde_json::from_str(&market.snapshot().unwrap()).unwrap();
        assert!(state["local_curation"].is_null());
    }
}
