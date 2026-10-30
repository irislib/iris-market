//! Search admission over a loopback relay; no public network or provider key.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market, listing,
    model::{Draft, Settings},
    store::Store,
};
use nostr::Keys;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[test]
fn submitted_search_streams_tags_without_eose_and_pages_when_nip50_is_unsupported() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let keys = Keys::generate();
    let now = listing::now();
    let draft = |title: &str, tags: Vec<String>| Draft {
        title: title.into(),
        description: String::new(),
        side: "offer".into(),
        price: String::new(),
        currency: "EUR".into(),
        location: String::new(),
        category: "Other".into(),
        tags,
        service_areas: None,
        image_url: None,
        expires_at: None,
    };
    let recent = (0..300)
        .map(|i| {
            listing::build(
                &keys,
                &draft("Unrelated inventory", vec![]),
                &format!("recent-{i}"),
                now - i,
                false,
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let tagged = listing::build(
        &keys,
        &draft("Tagged fresh MEAT", vec!["meat".into()]),
        "tagged",
        now - 10000,
        false,
    )
    .unwrap();
    let older = listing::build(
        &keys,
        &draft("Older fresh meat", vec![]),
        "older",
        now - 10001,
        false,
    )
    .unwrap();
    let mut forged = tagged.clone();
    forged.content = "Forged meat".into();
    let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
    let log = frames.clone();
    let server = runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (log, recent, tagged, older, forged) = (
                log.clone(),
                recent.clone(),
                tagged.clone(),
                older.clone(),
                forged.clone(),
            );
            tokio::spawn(async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
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
                    if frame[0] != "REQ" {
                        continue;
                    }
                    let filter = &frame[2];
                    let mut eose = true;
                    let events = if !filter["search"].is_null() {
                        let _ = socket
                            .send(Message::Text(
                                json!(["CLOSED", frame[1], "unsupported: search"])
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        continue;
                    } else if filter["#t"] == json!(["meat"]) {
                        eose = false;
                        vec![forged.clone(), tagged.clone()]
                    } else if filter["kinds"] == json!([30402]) && filter["until"].is_number() {
                        vec![older.clone()]
                    } else if filter["kinds"] == json!([30402]) && filter["#t"].is_null() {
                        // Relays may cap their response below our requested
                        // 300 records. A short page must still allow history.
                        recent.iter().take(128).cloned().collect()
                    } else {
                        vec![]
                    };
                    for event in events {
                        if socket
                            .send(Message::Text(
                                json!(["EVENT", frame[1], event]).to_string().into(),
                            ))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    if eose {
                        let _ = socket
                            .send(Message::Text(json!(["EOSE", frame[1]]).to_string().into()))
                            .await;
                    }
                }
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
    let start = Instant::now();
    let initial: Value = serde_json::from_str(
        &app.command(r#"{"type":"set_filter","query":"MEAT","side":"all","ai_search":false}"#)
            .unwrap(),
    )
    .unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(initial["query"], "MEAT");
    let streaming_deadline = Instant::now() + Duration::from_millis(1800);
    loop {
        let snapshot: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
        if snapshot["listings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["title"] == "Tagged fresh MEAT")
        {
            break;
        }
        assert!(
            Instant::now() < streaming_deadline,
            "A tagged result must arrive before the two-second EOSE timeout"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let snapshot: Value = serde_json::from_str(&app.snapshot().unwrap()).unwrap();
        if snapshot["listings"].as_array().unwrap().len() == 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Tagged and untagged older inventory must stream despite unsupported NIP-50; results={:?}, requests={:?}",
            snapshot["listings"],
            frames
                .lock()
                .unwrap()
                .iter()
                .filter(|f| f[0] == "REQ")
                .collect::<Vec<_>>()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let requests = frames.lock().unwrap();
    assert!(
        requests
            .iter()
            .any(|f| f[0] == "REQ" && f[2]["search"] == "meat" && f[2]["#t"].is_null())
    );
    assert!(
        requests
            .iter()
            .any(|f| f[0] == "REQ" && f[2]["#t"] == json!(["meat"]) && f[2]["search"].is_null())
    );
    assert!(
        requests
            .iter()
            .any(|f| f[0] == "REQ" && f[2]["until"].is_number())
    );
    drop(requests);
    app.shutdown();
    server.abort();
    runtime.shutdown_background();
}
