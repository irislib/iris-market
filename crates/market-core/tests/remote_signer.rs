//! Exercise encrypted pairing, device enrollment and public signing against an isolated relay.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market, identity,
    model::Settings,
    remote_signer::{Approval, RemoteSigner},
    store::Store,
};
use nostr::{
    Event, EventBuilder, EventId, JsonUtil, Keys, Kind, Tag, Timestamp, UnsignedEvent, nips::nip44,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Default)]
struct ProfileRace {
    first_signature: Option<EventId>,
    published: Vec<EventId>,
}

#[test]
fn pair_register_reopen_and_publish_without_owner_key() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let owner = Keys::generate();
    let server = Keys::generate();
    let device = Keys::generate();
    let old_profile = EventBuilder::new(
        Kind::Metadata,
        r#"{"name":"seller","display_name":"Old","about":"Retain this","count":9007199254740993}"#,
    )
    .allow_self_tagging()
    .tags([
        Tag::public_key(owner.public_key()),
        Tag::parse(["custom", "two", "values"]).unwrap(),
    ])
    .sign_with_keys(&owner)
    .unwrap();
    let concurrent = EventBuilder::new(
        Kind::Metadata,
        old_profile
            .content
            .replace("Retain this", "Edited while signing"),
    )
    .allow_self_tagging()
    .tags(old_profile.tags.iter().cloned())
    .tag(Tag::parse(["concurrent", "keep"]).unwrap())
    .custom_created_at(Timestamp::from(old_profile.created_at.as_secs() + 1))
    .sign_with_keys(&owner)
    .unwrap();
    let race = Arc::new(Mutex::new(ProfileRace::default()));
    let relay_race = race.clone();
    let relay_profile = concurrent.clone();
    let methods = Arc::new(Mutex::new(Vec::<String>::new()));
    let tamper = Arc::new(AtomicBool::new(false));
    let (signing_keys, server_keys, seen, tamper_reply) = (
        owner.clone(),
        server.clone(),
        methods.clone(),
        tamper.clone(),
    );
    rt.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let race = relay_race.clone();
            let concurrent = relay_profile.clone();
            let (owner, server, methods, tamper) = (
                signing_keys.clone(),
                server_keys.clone(),
                seen.clone(),
                tamper_reply.clone(),
            );
            tokio::spawn(async move {
                let mut socket = accept_async(stream).await.unwrap();
                let mut subscription = Value::Null;
                while let Some(Ok(frame)) = socket.next().await {
                    let Message::Text(text) = frame else { continue };
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame[0] == "REQ" {
                        subscription = frame[1].clone();
                        // Only a fresh, scoped own-profile check can see the competing client's event.
                        if frame[2]["kinds"] == json!([0])
                            && frame[2]["authors"] == json!([owner.public_key().to_hex()])
                            && frame[2]["limit"] == 1
                            && race.lock().unwrap().first_signature.is_some()
                        {
                            let _ = socket
                                .send(json_frame(json!(["EVENT", subscription, concurrent])))
                                .await;
                        }
                        let _ = socket.send(json_frame(json!(["EOSE", subscription]))).await;
                    } else if frame[0] == "EVENT" {
                        let event = Event::from_json(frame[1].to_string()).unwrap();
                        event.verify().unwrap();
                        if event.kind == Kind::Metadata {
                            race.lock().unwrap().published.push(event.id);
                        }
                        let _ = socket
                            .send(json_frame(json!(["OK", event.id.to_hex(), true, ""])))
                            .await;
                        if event.kind != Kind::NostrConnect {
                            continue;
                        }
                        let clear =
                            nip44::decrypt(server.secret_key(), &event.pubkey, event.content)
                                .unwrap();
                        let req: Value = serde_json::from_str(&clear).unwrap();
                        let method = req["method"].as_str().unwrap();
                        methods.lock().unwrap().push(method.into());
                        let result = match method {
                            "connect" => {
                                assert_eq!(req["params"][1], "once");
                                "ack".into()
                            }
                            "get_public_key" => owner.public_key().to_hex(),
                            "switch_relays" => "null".into(),
                            "sign_event" => {
                                let mut draft =
                                    UnsignedEvent::from_json(req["params"][0].as_str().unwrap())
                                        .unwrap();
                                if tamper.load(Ordering::Relaxed) {
                                    draft.content.push('!');
                                    draft.id = None;
                                }
                                let signed = draft.sign_with_keys(&owner).unwrap();
                                if signed.kind == Kind::Metadata {
                                    // The other client publishes after the request arrives and before approval returns.
                                    race.lock()
                                        .unwrap()
                                        .first_signature
                                        .get_or_insert(signed.id);
                                }
                                signed.as_json()
                            }
                            _ => panic!("unexpected method"),
                        };
                        let cipher = nip44::encrypt(
                            server.secret_key(),
                            &event.pubkey,
                            json!({"id":req["id"],"result":result}).to_string(),
                            nip44::Version::V2,
                        )
                        .unwrap();
                        let reply = EventBuilder::new(Kind::NostrConnect, cipher)
                            .tag(Tag::public_key(event.pubkey))
                            .sign_with_keys(&server)
                            .unwrap();
                        let _ = socket
                            .send(json_frame(json!(["EVENT", subscription, reply])))
                            .await;
                    }
                }
            });
        }
    });
    let approval: Approval = Arc::new(|_| panic!("unexpected approval URL"));
    let link = format!(
        "bunker://{}?relay={relay}&secret=once",
        server.public_key().to_hex()
    );
    let signer = rt.block_on(RemoteSigner::pair(&link, &approval)).unwrap();
    assert_eq!(signer.owner(), owner.public_key());
    let credential = serde_json::to_string(&signer).unwrap();
    assert!(!credential.contains("once"));
    assert!(!credential.contains(&owner.secret_key().to_secret_hex()));
    let proof = rt
        .block_on(identity::register_with_signer(
            signer.owner(),
            &device.secret_key().to_secret_hex(),
            std::slice::from_ref(&relay),
            async |draft| signer.sign(draft, &approval).await,
        ))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(&directory.path().join("market.sqlite")).unwrap();
    store
        .save_settings(&Settings {
            relays: vec![relay],
            ..Default::default()
        })
        .unwrap();
    store.queue_profile_metadata(&old_profile).unwrap();
    let app = Market::open_identity(
        directory.path(),
        owner.public_key(),
        None,
        device,
        Some(proof),
        false,
    )
    .unwrap();
    app.attach_remote_signer(serde_json::from_str(&credential).unwrap(), approval)
        .unwrap();
    let publish = json!({"type":"publish","draft":{"title":"Fixture","description":"Loopback","category":"Tools","side":"offer"}});
    let snapshot: Value =
        serde_json::from_str(&app.command(&publish.to_string()).unwrap()).unwrap();
    let record = &snapshot["listings"][0];
    let id = record["id"].as_str().unwrap();
    let event = store.event(id).unwrap();
    assert_eq!(event.pubkey, owner.public_key());
    event.verify().unwrap();
    app.command(&json!({"type":"update_profile","name":"New name"}).to_string())
        .unwrap();
    let stop = std::time::Instant::now() + std::time::Duration::from_secs(12);
    let profile = loop {
        let current = store
            .profile_metadata(&owner.public_key().to_hex())
            .unwrap()
            .unwrap();
        if current.id != old_profile.id {
            break current;
        }
        assert!(
            std::time::Instant::now() < stop,
            "queued profile must reach the signing path"
        );
        std::thread::sleep(std::time::Duration::from_millis(40));
    };
    let stale = race.lock().unwrap().first_signature.unwrap();
    assert_ne!(
        profile.id, stale,
        "the stale signature must never enter the outbox"
    );
    assert!(
        store
            .pending()
            .unwrap()
            .iter()
            .all(|event| event.id != stale)
    );
    assert!(!race.lock().unwrap().published.contains(&stale));
    assert_eq!(profile.tags, concurrent.tags);
    assert!(profile.created_at > concurrent.created_at);
    assert!(profile.content.contains("9007199254740993"));
    profile.verify().unwrap();
    let content: Value = serde_json::from_str(&profile.content).unwrap();
    assert_eq!(content["display_name"], "New name");
    assert_eq!(content["name"], "seller");
    assert_eq!(content["about"], "Edited while signing");
    tamper.store(true, Ordering::Relaxed);
    assert!(
        app.command(&json!({"type":"close","id":id}).to_string())
            .is_err()
    );
    assert_eq!(store.event(id).unwrap().id, event.id);
    tamper.store(false, Ordering::Relaxed);
    app.command(&json!({"type":"close","id":id}).to_string())
        .unwrap();
    assert_ne!(store.event(id).unwrap().id, event.id);
    assert_eq!(
        methods
            .lock()
            .unwrap()
            .iter()
            .filter(|method| *method == "connect")
            .count(),
        1
    );
    app.shutdown();
}
fn json_frame(value: Value) -> Message {
    Message::Text(value.to_string().into())
}
