//! Real Nostr relay admission: author discovery streams before EOSE, and cancels cleanly.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market, listing,
    model::{Draft, Settings},
    store::Store,
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
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
        tags: Vec::new(),
        escrow: None,
        service_areas: None,
        image_url: None,
        expires_at: None,
    };
    let active = listing::build(&author, &draft, "visible", now, false).unwrap();
    let removed = listing::build(&author, &draft, "removed", now, false).unwrap();
    let tombstone = listing::build(&author, &draft, "removed", now + 1, true).unwrap();
    let foreign = listing::build(&stranger, &draft, "foreign", now, false).unwrap();
    let foreign_id = format!("{}:foreign", stranger.public_key());
    let collection = EventBuilder::new(Kind::Custom(30405), "")
        .tags([
            Tag::identifier("weekend"),
            Tag::parse(["title", "Weekend finds"]).unwrap(),
            Tag::parse(["a", &format!("30402:{foreign_id}")]).unwrap(),
        ])
        .sign_with_keys(&author)
        .unwrap();
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
            let collection = collection.clone();
            let member = foreign.clone();
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
                        if frame[2]["kinds"] == json!([30405])
                            && frame[2]["authors"] == json!([wanted])
                        {
                            let _ = socket
                                .send(Message::Text(
                                    json!(["EVENT", frame[1], collection]).to_string().into(),
                                ))
                                .await;
                        } else if frame[2]["kinds"] == json!([30402])
                            && frame[2]["authors"] == json!([member.pubkey.to_hex()])
                            && frame[2]["#d"] == json!(["foreign"])
                        {
                            let _ = socket
                                .send(Message::Text(
                                    json!(["EVENT", frame[1], member]).to_string().into(),
                                ))
                                .await;
                        } else if profile {
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
    wait("profile collections", || {
        snapshot(&app)["profile_listings"]["collections"][0]["title"] == "Weekend finds"
    });
    assert!(
        !frames
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame[0] == "REQ" && frame[2]["#d"] == json!(["foreign"])),
        "reading profile summaries must not request another seller's products"
    );
    app.command(
        &json!({"type":"open_collection","author":author_hex,"identifier":"weekend"}).to_string(),
    )
    .unwrap();
    wait(
        "cross-author collection product streams before EOSE",
        || {
            let state = snapshot(&app);
            state["profile_listings"]["collections"][0]["members"][0]["listing"]["id"] == foreign_id
        },
    );
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
    assert_eq!(current["profile"]["followers_loaded"], false);
    assert!(
        !frames.lock().unwrap().iter().any(|frame| frame[0] == "REQ"
            && frame[2]["#p"] == json!([author_hex])
            && frame[2]["kinds"] == json!([3])),
        "Opening a profile must not fetch followers"
    );
    app.command(&json!({"type":"load_profile_followers","author":author_hex}).to_string())
        .unwrap();
    wait("explicit followers", || {
        snapshot(&app)["profile"]["followers_loaded"] == true
    });
    assert!(frames.lock().unwrap().iter().any(|frame| frame[0] == "REQ"
        && frame[2]["#p"] == json!([author_hex])
        && frame[2]["kinds"] == json!([3])));
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
    assert_eq!(saved.len(), 2);
    assert!(saved.iter().any(|l| l.author == author_hex));
    assert!(saved.iter().any(|l| l.id == foreign_id));
    app.shutdown();
    server.abort();
    runtime.shutdown_background();
}

#[test]
fn collect_from_different_sellers_offline_edit_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("market.sqlite");
    Store::open(&database)
        .unwrap()
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    let curator = Keys::generate();
    let seller = Keys::generate();
    let at = listing::now();
    let secret = curator.secret_key().to_secret_hex();
    let app = Market::open(dir.path(), &secret, false).unwrap();
    let draft: Draft = serde_json::from_value(
        json!({"title":"From a real listing","description":"Test product","side":"offer"}),
    )
    .unwrap();
    let own = listing::build(&curator, &draft, "own", at, false).unwrap();
    let foreign = listing::build(&seller, &draft, "with:colon", at, false).unwrap();
    let mine = format!("{}:own", curator.public_key());
    let theirs = format!("{}:with:colon", seller.public_key());
    app.ingest_event(&own).unwrap();
    app.ingest_event(&foreign).unwrap();
    let author = curator.public_key().to_hex();
    app.command(&json!({"type":"save","id":theirs}).to_string())
        .unwrap();
    let open = json!({"type":"load_profile","author":author}).to_string();
    app.command(&open).unwrap();
    let save = json!({"type":"save_collection","title":"My favorite products","listing_ids":[theirs,mine]});
    let state: Value = serde_json::from_str(&app.command(&save.to_string()).unwrap()).unwrap();
    let summary = &state["profile_listings"]["collections"][0];
    assert!(summary["members"][0]["listing"].is_null());
    let state: Value = serde_json::from_str(
        &app.command(
            &json!({"type":"open_collection","author":author,"identifier":summary["identifier"]})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let c = &state["profile_listings"]["collections"][0];
    assert_eq!(c["title"], "My favorite products");
    assert_eq!(c["delivery"], "queued");
    assert_eq!(c["members"][0]["listing"]["saved"], true);
    assert_eq!(c["members"][1]["listing"]["author"], author);
    let refreshed: Value = serde_json::from_str(&app.command(&open).unwrap()).unwrap();
    assert_eq!(
        refreshed["profile_listings"]["collections"][0]["members"][0]["listing"]["id"], theirs,
        "reopening the same profile retains the expanded collection"
    );
    assert_eq!(
        state["profile_listings"]["listings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut edit = json!({"type":"save_collection","title":"Our shop","identifier":c["identifier"],
        "previous_event_id":c["event_id"],"listing_ids":[mine]});
    let changed: Value = serde_json::from_str(&app.command(&edit.to_string()).unwrap()).unwrap();
    assert_eq!(
        changed["profile_listings"]["collections"][0]["members"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        app.command(&edit.to_string()).is_err(),
        "replayed stale edit must not overwrite a newer revision"
    );
    edit["previous_event_id"] = changed["profile_listings"]["collections"][0]["event_id"].clone();
    edit["listing_ids"] = json!([format!("{author}:missing")]);
    assert!(
        app.command(&edit.to_string()).is_err(),
        "new product must exist"
    );
    let store = Store::open(&database).unwrap();
    let outbox: Vec<_> = store
        .pending()
        .unwrap()
        .into_iter()
        .filter(|e| e.kind.as_u16() == 30405)
        .collect();
    assert_eq!(
        outbox.len(),
        1,
        "Only the latest signed revision needs delivery"
    );
    assert!(
        outbox
            .iter()
            .all(|e| e.verify().is_ok() && e.pubkey == curator.public_key())
    );
    let id = changed["profile_listings"]["collections"][0]["event_id"]
        .as_str()
        .unwrap();
    app.shutdown();
    let viewer_keys = Keys::generate();
    let viewer_dir = tempfile::tempdir().unwrap();
    let viewer = Market::open_identity_private(
        dir.path(),
        viewer_dir.path(),
        viewer_keys.public_key(),
        None,
        viewer_keys,
        None,
        false,
    )
    .unwrap();
    let visitor: Value = serde_json::from_str(&viewer.command(&open).unwrap()).unwrap();
    assert!(
        visitor["profile_listings"]["collections"]
            .as_array()
            .unwrap()
            .is_empty(),
        "unacknowledged collections are only displayed for their own account"
    );
    assert!(
        viewer
            .command(
                &json!({"type":"open_collection","author":author,"identifier":c["identifier"]})
                    .to_string()
            )
            .is_err()
    );
    store.acknowledge(id).unwrap();
    assert_eq!(
        snapshot(&viewer)["profile_listings"]["collections"][0]["event_id"],
        id
    );
    viewer.shutdown();
    let reopened = Market::open(dir.path(), &secret, false).unwrap();
    let state: Value = serde_json::from_str(&reopened.command(&open).unwrap()).unwrap();
    let c = &state["profile_listings"]["collections"][0];
    assert_eq!(c["event_id"], id);
    assert_eq!(c["delivery"], "published");
    assert_eq!(
        state["saved_listings"][0]["id"], theirs,
        "publishing never changes private saves"
    );
    reopened.shutdown();
    let preview = Market::open(dir.path(), &secret, true).unwrap();
    assert!(preview.command(&save.to_string()).is_err());
}

#[test]
fn verified_revision_expiration_deletion_and_preserved_metadata() {
    let dir = tempfile::tempdir().unwrap();
    Store::open(&dir.path().join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    let owner = Keys::generate();
    let other = Keys::generate();
    let app = Market::open(dir.path(), &owner.secret_key().to_secret_hex(), false).unwrap();
    let author = owner.public_key().to_hex();
    let at = listing::now() - 25;
    let missing = format!("{}:unavailable", other.public_key());
    let a = format!("30402:{missing}");
    let collection = |timestamp, extra: Vec<Tag>| {
        EventBuilder::new(Kind::Custom(30405), "Existing description")
            .tags(
                [
                    Tag::identifier("picks"),
                    Tag::parse(["title", "My favorites"]).unwrap(),
                    Tag::parse(["a", a.as_str(), "wss://example.invalid"]).unwrap(),
                    Tag::parse(["shipping_option", "external"]).unwrap(),
                ]
                .into_iter()
                .chain(extra),
            )
            .custom_created_at(Timestamp::from(timestamp))
            .sign_with_keys(&owner)
            .unwrap()
    };
    let open = json!({"type":"load_profile","author":author}).to_string();
    let view = || snapshot(&app)["profile_listings"]["collections"].clone();
    app.command(&open).unwrap();
    let initial = collection(at, vec![]);
    let mut fake = initial.clone();
    fake.content = "forged".into();
    assert!(app.ingest_event(&fake).is_err());
    assert!(app.ingest_event(&initial).unwrap());
    assert!(view()[0]["members"][0]["listing"].is_null());
    let expired = collection(
        at + 1,
        vec![Tag::parse(["expiration", &at.to_string()]).unwrap()],
    );
    app.ingest_event(&expired).unwrap();
    assert!(view().as_array().unwrap().is_empty());
    assert!(!app.ingest_event(&initial).unwrap());
    let invalid = collection(
        at + 2,
        vec![Tag::parse(["title", "Conflicting name"]).unwrap()],
    );
    assert!(app.ingest_event(&invalid).unwrap());
    assert!(!app.ingest_event(&expired).unwrap());
    assert!(view().as_array().unwrap().is_empty());
    let tie1 = collection(at + 3, vec![]);
    let tie2 = collection(
        at + 3,
        vec![Tag::parse(["summary", "Another revision"]).unwrap()],
    );
    let (winner, loser) = if tie1.id < tie2.id {
        (tie1, tie2)
    } else {
        (tie2, tie1)
    };
    app.ingest_event(&loser).unwrap();
    app.ingest_event(&winner).unwrap();
    assert_eq!(view()[0]["event_id"], winner.id.to_hex());
    let deletion = |keys: &Keys, tag: Tag| {
        EventBuilder::new(Kind::EventDeletion, "")
            .tag(tag)
            .custom_created_at(Timestamp::from(at + 4))
            .sign_with_keys(keys)
            .unwrap()
    };
    app.ingest_event(&deletion(&other, Tag::event(winner.id)))
        .unwrap();
    assert_eq!(view()[0]["event_id"], winner.id.to_hex());
    app.ingest_event(&deletion(&owner, Tag::event(winner.id)))
        .unwrap();
    assert!(view().as_array().unwrap().is_empty());
    assert!(!app.ingest_event(&loser).unwrap());
    let newer = collection(at + 5, vec![]);
    app.ingest_event(&newer).unwrap();
    app.command(&json!({"type":"save_collection","identifier":"picks","previous_event_id":newer.id.to_hex(),"title":"Renamed","listing_ids":[missing]}).to_string()).unwrap();
    let updated = Store::open(&dir.path().join("market.sqlite"))
        .unwrap()
        .pending()
        .unwrap()
        .into_iter()
        .find(|e| e.kind.as_u16() == 30405)
        .unwrap();
    assert_eq!(updated.content, "Existing description");
    assert!(
        updated
            .tags
            .iter()
            .any(|t| t.as_slice() == ["shipping_option", "external"])
    );
    assert!(
        updated
            .tags
            .iter()
            .any(|t| t.as_slice() == ["a", a.as_str(), "wss://example.invalid"])
    );
    let address = format!("30405:{author}:picks");
    let deletion = EventBuilder::new(Kind::EventDeletion, "")
        .tag(Tag::parse(["a", address.as_str()]).unwrap())
        .custom_created_at(updated.created_at)
        .sign_with_keys(&owner)
        .unwrap();
    app.ingest_event(&deletion).unwrap();
    assert!(view().as_array().unwrap().is_empty());
    assert!(!app.ingest_event(&newer).unwrap());
    for index in 0..32 {
        let event = EventBuilder::new(Kind::Custom(30405), "")
            .tags([
                Tag::identifier(format!("collection-{index}")),
                Tag::parse(["title", "Set"]).unwrap(),
                Tag::parse(["a", &a]).unwrap(),
            ])
            .sign_with_keys(&owner)
            .unwrap();
        app.ingest_event(&event).unwrap();
    }
    let error = app
        .command(
            &json!({"type":"save_collection","title":"One more","listing_ids":[missing]})
                .to_string(),
        )
        .unwrap_err();
    assert!(error.to_string().contains("up to 32"));
    app.shutdown();
}
