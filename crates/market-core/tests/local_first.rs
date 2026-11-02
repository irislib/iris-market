//! A connected relay that never replies must not become a UI barrier.
use futures_util::StreamExt;
use iris_market_core::{Market, model::Settings, store::Store};
use nostr::Keys;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;

fn local<T>(label: &str, action: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = action();
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "{label} waited for a silent relay"
    );
    result
}

fn command(app: &Market, request: Value) -> Value {
    local(request["type"].as_str().unwrap(), || {
        serde_json::from_str(&app.command(&request.to_string()).unwrap()).unwrap()
    })
}

#[test]
fn searches_without_networking_never_wait_for_discovery() {
    for preview in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        if !preview {
            Store::open(&dir.path().join("market.sqlite"))
                .unwrap()
                .save_settings(&Settings {
                    relays: vec![],
                    ..Default::default()
                })
                .unwrap();
        }
        let app = Market::open(
            dir.path(),
            &iris_market_core::generate_secret_key(),
            preview,
        )
        .unwrap();
        let state = command(
            &app,
            json!({"type":"set_filter","query":"no-such-listing","side":"offer","ai_search":false}),
        );
        let settings = state["settings"].clone();
        for result in [
            state,
            command(&app, json!({"type":"continue_search"})),
            command(&app, json!({"type":"refresh"})),
            command(&app, json!({"type":"set_settings","settings":settings})),
        ] {
            assert_eq!(
                result["search_discovery"]["loading"], false,
                "preview={preview}"
            );
            assert_eq!(
                result["search_discovery"]["has_more"], false,
                "preview={preview}"
            );
        }
        app.shutdown();
    }
}

#[test]
fn local_actions_and_restoration_finish_without_relay_replies() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let received = Arc::new(AtomicBool::new(false));
    let seen = received.clone();
    runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                while let Some(Ok(_)) = socket.next().await {
                    seen.store(true, Ordering::Release);
                    // No OK, EOSE, AUTH, or subscription events.
                }
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("market.sqlite")).unwrap();
    store
        .save_settings(&Settings {
            relays: vec![relay],
            ..Default::default()
        })
        .unwrap();
    let secret = iris_market_core::generate_secret_key();
    let app = local("create profile", || {
        Market::open_fresh(dir.path(), &secret).unwrap()
    });
    command(
        &app,
        json!({"type":"update_profile","name":"Silent relay test"}),
    );
    // Prove the background connection is active before exercising local actions.
    let deadline = Instant::now() + Duration::from_secs(3);
    while !received.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "Local relay did not receive a request"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let published = command(
        &app,
        json!({"type":"publish","draft":{
            "title":"Local-first listing","description":"Synthetic test","side":"offer",
            "price":"12","currency":"EUR","location":"Test","category":"Other","tags":[]
        }}),
    );
    let id = published["listings"][0]["id"].as_str().unwrap().to_owned();
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .any(|event| event.kind.as_u16() == 30402)
    );
    let saved = command(&app, json!({"type":"save","id":id}));
    assert_eq!(saved["saved_listings"].as_array().unwrap().len(), 1);
    command(
        &app,
        json!({"type":"set_filter","query":"Local-first","side":"offer","ai_search":false}),
    );
    command(&app, json!({"type":"refresh"}));
    let peer = Keys::generate().public_key().to_hex();
    command(&app, json!({"type":"load_profile","author":peer}));
    command(&app, json!({"type":"contact","author":peer}));
    let conversation = command(
        &app,
        json!({"type":"send_message","peer_id":peer,"text":"Synthetic queued enquiry"}),
    );
    assert_eq!(
        conversation["conversations"][0]["messages"][0]["delivery"],
        "pending"
    );
    local("queue review", || {
        app.publish_review(peer.clone(), 5, "Synthetic review".into())
            .unwrap()
    });
    let mut settings = saved["settings"].clone();
    settings["currency"] = json!("USD");
    command(&app, json!({"type":"set_settings","settings":settings}));
    local("close profile", || app.shutdown());
    let restored = local("restore profile", || {
        Market::open(dir.path(), &secret, false).unwrap()
    });
    let state: Value = serde_json::from_str(&restored.snapshot().unwrap()).unwrap();
    assert_eq!(state["settings"]["currency"], "USD");
    assert_eq!(state["saved_listings"][0]["id"], id);
    assert!(
        state["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chat| chat["id"] == peer)
    );
    assert_eq!(
        state["conversations"][0]["messages"][0]["text"],
        "Synthetic queued enquiry"
    );
    assert_eq!(
        state["conversations"][0]["messages"][0]["delivery"],
        "pending"
    );
    assert!(
        !store.pending().unwrap().is_empty(),
        "No relay acknowledged publication"
    );
    restored.shutdown();
}
