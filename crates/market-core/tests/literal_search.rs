use iris_market_core::{
    Market, generate_secret_key, listing,
    model::{Draft, Settings},
    store::Store,
};
use nostr::Keys;
use serde_json::{Value, json};

fn draft(title: &str, description: &str, side: &str, tags: &[&str]) -> Draft {
    Draft {
        title: title.into(),
        description: description.into(),
        side: side.into(),
        price: String::new(),
        currency: "EUR".into(),
        location: "Helsinki".into(),
        category: "transport".into(),
        tags: tags.iter().map(|value| (*value).into()).collect(),
        service_areas: None,
        image_url: None,
        expires_at: None,
    }
}

fn filter(app: &Market, query: &str, side: &str, ai_search: bool) -> Value {
    serde_json::from_str(
        &app.command(
            &json!({"type":"set_filter","query":query,"side":side,"ai_search":ai_search})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn verified_listing_words_and_tags_match_without_changing_ai_or_side_state() {
    let directory = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        relays: vec![],
        ..Settings::default()
    };
    // No relay/publication/provider calls are used by this test.
    Store::open(&directory.path().join("market.sqlite"))
        .unwrap()
        .save_settings(&settings)
        .unwrap();
    let app = Market::open(directory.path(), &generate_secret_key(), false).unwrap();
    let seller = Keys::generate();
    for (id, input) in [
        (
            "bike",
            draft(
                "Bicycle",
                "Bright red frame",
                "offer",
                &["vintage", "T-Shirt"],
            ),
        ),
        (
            "other",
            draft("Carpet", "A steak illustration", "offer", &[]),
        ),
        (
            "finnish",
            draft("TUORE LEIPÄ", "Paikallinen", "request", &[]),
        ),
    ] {
        let event = listing::build(&seller, &input, id, listing::now(), false).unwrap();
        assert!(app.ingest_event(&event).unwrap());
    }
    let reordered = filter(&app, "red bicycle vintage Helsinki", "all", false);
    assert_eq!(reordered["query"], "red bicycle vintage Helsinki");
    assert_eq!(reordered["ai_search"], false);
    assert_eq!(reordered["listings"].as_array().unwrap().len(), 1);
    assert_eq!(reordered["listings"][0]["title"], "Bicycle");
    assert_eq!(
        filter(&app, "t shirt", "all", false)["listings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for query in ["tea", "car", "electronics", "human edible products"] {
        assert!(
            filter(&app, query, "all", false)["listings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    let finnish = filter(&app, "leipä tuore", "all", false);
    assert_eq!(finnish["listings"].as_array().unwrap().len(), 1);
    assert_eq!(finnish["listings"][0]["title"], "TUORE LEIPÄ");
    assert!(
        filter(&app, "leipä tuore", "offer", false)["listings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        filter(&app, "", "all", false)["listings"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    settings.ai.enabled = true;
    settings.ai.provider = "apple".into();
    settings.ai.model = "apple-system".into();
    app.command(&json!({"type":"set_settings","settings":settings}).to_string())
        .unwrap();
    let ai = filter(&app, "nonliteral unmatched query", "offer", true);
    assert_eq!(ai["ai_search"], true);
    assert_eq!(ai["query"], "nonliteral unmatched query");
    assert_eq!(ai["listings"].as_array().unwrap().len(), 2);
    assert!(
        ai["listings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["relevance"].is_null())
    );
    assert!(
        filter(&app, "nonliteral unmatched query", "offer", false)["listings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.shutdown();
}
