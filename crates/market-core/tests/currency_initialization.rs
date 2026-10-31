use iris_market_core::{Market, model::Settings, rates::RateBook, store::Store};
use serde_json::{Value, json};

#[test]
fn currency_migration_preserves_existing_choice_and_fresh_default_is_usd() {
    let fresh = Settings::default();
    assert_eq!(fresh.currency, "USD");
    assert!(!fresh.currency_initialized);
    let legacy: Settings = serde_json::from_value(json!({"currency":"GBP"})).unwrap();
    assert_eq!(legacy.currency, "GBP");
    assert!(legacy.currency_initialized);
    let older: Settings = serde_json::from_value(json!({"relays":[]})).unwrap();
    assert_eq!(older.currency, "EUR");
    assert!(older.currency_initialized);
}

#[test]
fn locale_currency_initializes_once_and_cached_satoshi_projection_needs_no_network() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    store
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    let now = iris_market_core::listing::now();
    let book = RateBook::from_cache(
        &json!({"rates":{"USD":{"value":100000.0,"source":"Coinbase","updated_at":now-1000}}})
            .to_string(),
        now,
    )
    .unwrap();
    store.save_exchange_rates(&book).unwrap();
    let secret = iris_market_core::generate_secret_key();
    let app = Market::open(dir.path(), &secret, false).unwrap();
    let initial: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
    assert_eq!(initial["settings"]["currency_initialized"], false);
    assert_eq!(initial["sats_display_price"]["currency"], "USD");
    assert!((initial["sats_display_price"]["amount"].as_f64().unwrap() - 0.001).abs() < 1e-12);
    assert_eq!(initial["sats_display_price"]["stale"], true);
    assert!(
        initial["supported_currencies"]
            .as_array()
            .unwrap()
            .contains(&json!("GBP"))
    );
    assert!(
        app.command(r#"{"type":"initialize_currency","currency":"ZZZ"}"#)
            .is_err()
    );
    let localized: Value = serde_json::from_str(
        &app.command(r#"{"type":"initialize_currency","currency":"gbp"}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(localized["settings"]["currency"], "GBP");
    assert_eq!(localized["settings"]["currency_initialized"], true);
    assert!(localized["sats_display_price"].is_null());
    app.command(r#"{"type":"initialize_currency","currency":"JPY"}"#)
        .unwrap();
    assert_eq!(store.settings().unwrap().currency, "GBP");
    let mut settings = store.settings().unwrap();
    settings.currency = "EUR".into();
    settings.currency_initialized = false;
    app.command(&json!({"type":"set_settings","settings":settings}).to_string())
        .unwrap();
    app.command(r#"{"type":"initialize_currency","currency":"USD"}"#)
        .unwrap();
    assert_eq!(store.settings().unwrap().currency, "EUR");
    assert!(store.settings().unwrap().currency_initialized);
    app.shutdown();
    let reopened = Market::open(dir.path(), &secret, false).unwrap();
    let state: Value = serde_json::from_str(&reopened.snapshot().unwrap()).unwrap();
    assert_eq!(state["settings"]["currency"], "EUR");
    assert_eq!(state["settings"]["currency_initialized"], true);
    reopened.shutdown();
}
