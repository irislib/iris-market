//! Exercise encrypted pairing, device enrollment and public signing against an isolated relay.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market, identity,
    model::Settings,
    remote_signer::{Approval, RemoteSigner},
    store::Store,
};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, UnsignedEvent, nips::nip44};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

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
                        let _ = socket.send(json_frame(json!(["EOSE", subscription]))).await;
                    } else if frame[0] == "EVENT" {
                        let event = Event::from_json(frame[1].to_string()).unwrap();
                        event.verify().unwrap();
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
                                draft.sign_with_keys(&owner).unwrap().as_json()
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
    let old_profile = EventBuilder::new(
        Kind::Metadata,
        json!({"name":"Old","about":"Retain this"}).to_string(),
    )
    .sign_with_keys(&owner)
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
    let profile = store
        .profile_metadata(&owner.public_key().to_hex())
        .unwrap()
        .unwrap();
    profile.verify().unwrap();
    let content: Value = serde_json::from_str(&profile.content).unwrap();
    assert_eq!(content["display_name"], "New name");
    assert_eq!(content["about"], "Retain this");
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
