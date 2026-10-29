//! Real Nostr relay admission: author discovery streams before EOSE, and cancels cleanly.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market, listing,
    model::{Draft, Settings},
    store::Store,
};
use nostr::{Event, Keys};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
fn wait(label: &str, mut predicate: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(12);
    while !predicate() {
        assert!(
            Instant::now() < end,
            "Profile relay condition timed out: {label}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn snapshot(app: &Market) -> Value {
    serde_json::from_str(&app.snapshot().unwrap()).unwrap()
}
#[test]
fn author_subscription_streams_signed_winners_before_eose_and_closes_on_navigation() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let author = Keys::generate();
    let stranger = Keys::generate();
    let now = listing::now();
    let draft = Draft {
        title: "Only in the author feed".into(),
        description: "Signed localhost listing".into(),
        side: "offer".into(),
        price: "12".into(),
        currency: "EUR".into(),
        location: "Test".into(),
        category: "Other".into(),
        image_url: None,
        expires_at: None,
    };
    let active = listing::build(&author, &draft, "visible", now, false).unwrap();
    let removed = listing::build(&author, &draft, "removed", now, false).unwrap();
    let tombstone = listing::build(&author, &draft, "removed", now + 1, true).unwrap();
    let foreign = listing::build(&stranger, &draft, "foreign", now, false).unwrap();
    let mut forged = active.clone();
    forged.content = "Tampered listing".into();
    let author_hex = author.public_key().to_hex();
    let wanted = author_hex.clone();
    let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = frames.clone();
    let server = runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let log = log.clone();
            let wanted = wanted.clone();
            let events: Vec<Event> = vec![
                forged.clone(),
                tombstone.clone(),
                removed.clone(),
                active.clone(),
                foreign.clone(),
            ];
            tokio::spawn(async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let mut profile_ids = Vec::new();
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Ping(bytes) = message {
                        let _ = socket.send(Message::Pong(bytes)).await;
                        continue;
                    }
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    log.lock().unwrap().push(frame.clone());
                    if frame[0] == "REQ" {
                        let profile = frame[2]["authors"]
                            .as_array()
                            .is_some_and(|authors| authors.contains(&json!(wanted)))
                            && frame[2]["kinds"] == json!([30402]);
                        if profile {
                            assert_eq!(frame[2]["limit"], 48);
                            profile_ids.push(frame[1].clone());
                            for event in &events {
                                let _ = socket
                                    .send(Message::Text(
                                        json!(["EVENT", frame[1], event]).to_string().into(),
                                    ))
                                    .await;
                            }
                        } else {
                            let _ = socket
                                .send(Message::Text(json!(["EOSE", frame[1]]).to_string().into()))
                                .await;
                        }
                        // Deliberately never emit EOSE for profile subscriptions.
                    }
                }
                log.lock()
                    .unwrap()
                    .push(json!(["DISCONNECTED", profile_ids]));
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    Store::open(&dir.path().join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![relay],
            ..Default::default()
        })
        .unwrap();
    let app = Market::open(dir.path(), &iris_market_core::generate_secret_key(), false).unwrap();
    app.command(r#"{"type":"set_filter","query":"invisible search","side":"request"}"#)
        .unwrap();
    let start = Instant::now();
    app.command(&json!({"type":"load_profile","author":author_hex}).to_string())
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    wait("streamed listing", || {
        snapshot(&app)["profile_listings"]["listings"]
            .as_array()
            .is_some_and(|items| items.len() == 1)
    });
    let current = snapshot(&app);
    assert_eq!(
        current["profile_listings"]["loading"], true,
        "Streaming must not wait for EOSE"
    );
    assert_eq!(
        current["profile_listings"]["listings"][0]["title"],
        "Only in the author feed"
    );
    assert_eq!(current["query"], "invisible search");
    assert!(current["listings"].as_array().unwrap().is_empty());
    let profile_subs = frames
        .lock()
        .unwrap()
        .iter()
        .filter(|frame| {
            frame[0] == "REQ"
                && frame[2]["authors"] == json!([author_hex])
                && frame[2]["kinds"] == json!([30402])
        })
        .map(|frame| frame[1].clone())
        .collect::<Vec<_>>();
    assert!(!profile_subs.is_empty());
    app.command(&json!({"type":"close_profile","author":author_hex}).to_string())
        .unwrap();
    wait("subscription close", || {
        frames.lock().unwrap().iter().any(|frame| {
            (frame[0] == "CLOSE" && profile_subs.contains(&frame[1]))
                || (frame[0] == "DISCONNECTED"
                    && frame[1]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|id| profile_subs.contains(id))))
        })
    });
    assert!(snapshot(&app)["profile_listings"].is_null());
    let saved = Store::open(&dir.path().join("market.sqlite"))
        .unwrap()
        .listings(
            snapshot(&app)["public_key"].as_str().unwrap(),
            listing::now(),
        )
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].author, author_hex);
    app.shutdown();
    server.abort();
    runtime.shutdown_background();
}
