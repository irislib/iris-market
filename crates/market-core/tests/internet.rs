//! Two independent app profiles communicate through a real WebSocket Nostr relay.
use futures_util::{SinkExt, StreamExt};
use iris_market_core::{
    Market,
    model::{Draft, Settings},
    store::Store,
};
use nostr::{Event, Filter, JsonUtil};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::broadcast};
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(25);
    while Instant::now() < end {
        if predicate() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("Timed out waiting for relay exchange");
}
fn snapshot(app: &Market) -> Value {
    serde_json::from_str(&app.snapshot().unwrap()).unwrap()
}

#[test]
fn two_profiles_publish_discover_and_exchange_private_enquiries_over_internet_transport() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let relay = format!("ws://{}", listener.local_addr().unwrap());
    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(vec![]));
    let wire: Arc<Mutex<Vec<(usize, Value)>>> = Arc::new(Mutex::new(vec![]));
    let (broadcast, _) = broadcast::channel::<Event>(1000);
    let pool = events.clone();
    let log = wire.clone();
    let server=runtime.spawn(async move{
        let mut next=0;
        while let Ok((stream,_))=listener.accept().await{
            let id=next;next+=1;let pool=pool.clone();let log=log.clone();let tx=broadcast.clone();let mut rx=tx.subscribe();
            tokio::spawn(async move{
                let Ok(ws)=accept_async(stream).await else{return;};let (mut send,mut receive)=ws.split();
                let mut subscriptions:HashMap<String,Vec<Filter>>=HashMap::new();
                loop{tokio::select!{
                    incoming=receive.next()=>{
                        let text=match incoming{Some(Ok(Message::Text(text)))=>text,Some(Ok(Message::Ping(data)))=>{let _=send.send(Message::Pong(data)).await;continue;},Some(Ok(Message::Pong(_)))=>continue,Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>continue};
                        let Ok(value)=serde_json::from_str::<Value>(&text) else{continue;};log.lock().unwrap().push((id,value.clone()));
                        match value[0].as_str(){
                            Some("REQ")=>{
                                let sub=value[1].as_str().unwrap().to_string();
                                let filters:Vec<Filter>=value.as_array().unwrap()[2..].iter().map(|v|serde_json::from_value(v.clone()).unwrap()).collect();
                                let stored=pool.lock().unwrap().clone();
                                for event in stored{if filters.iter().any(|f|f.match_event(&event,Default::default())){let _=send.send(Message::Text(json!(["EVENT",sub,event]).to_string().into())).await;}}
                                let _=send.send(Message::Text(json!(["EOSE",sub]).to_string().into())).await;subscriptions.insert(sub,filters);
                            },
                            Some("EVENT")=>{
                                let event=Event::from_json(value[1].to_string()).unwrap();event.verify().unwrap();
                                {let mut store=pool.lock().unwrap();if !store.iter().any(|e|e.id==event.id){store.push(event.clone());}}
                                let _=send.send(Message::Text(json!(["OK",event.id.to_hex(),true,""]).to_string().into())).await;
                                let _=tx.send(event);
                            },
                            Some("CLOSE")=>{subscriptions.remove(value[1].as_str().unwrap());},
                            _=>{}
                        }
                    },
                    event=rx.recv()=>{if let Ok(event)=event{for (sub,filters) in &subscriptions{if filters.iter().any(|f|f.match_event(&event,Default::default()))&& send.send(Message::Text(json!(["EVENT",sub,event]).to_string().into())).await.is_err(){return;}}}}
                }}
            });
        }
    });
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    for dir in [&a_dir, &b_dir] {
        Store::open(&dir.path().join("market.sqlite"))
            .unwrap()
            .save_settings(&Settings {
                relays: vec![relay.clone()],
                ..Default::default()
            })
            .unwrap();
    }
    let alice = Market::open(
        a_dir.path(),
        &iris_market_core::generate_secret_key(),
        false,
    )
    .unwrap();
    let bob = Market::open(
        b_dir.path(),
        &iris_market_core::generate_secret_key(),
        false,
    )
    .unwrap();
    let d = Draft {
        title: "A real signed listing".into(),
        description: "Relay integration fixture".into(),
        side: "offer".into(),
        price: "20".into(),
        currency: "EUR".into(),
        location: "Test neighbourhood".into(),
        category: "Other".into(),
        image_url: None,
        expires_at: None,
    };
    alice
        .command(&json!({"type":"publish","draft":d}).to_string())
        .unwrap();
    wait_until(|| {
        snapshot(&bob)["listings"]
            .as_array()
            .is_some_and(|l| l.len() == 1)
    });
    wait_until(|| snapshot(&alice)["listings"][0]["delivery"] == "published");
    let listing = snapshot(&bob)["listings"][0].clone();
    wait_until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.kind.as_u16() == 30078)
    });
    bob.command(
        &json!({"type":"contact","author":listing["author"],"listing_id":listing["id"]})
            .to_string(),
    )
    .unwrap();
    wait_until(|| {
        !snapshot(&alice)["conversations"]
            .as_array()
            .unwrap()
            .is_empty()
    });
    let peer = snapshot(&bob)["conversations"][0]["id"].clone();
    bob.command(
        &json!({"type":"send_message","peer_id":peer,"text":"Is this still available?"})
            .to_string(),
    )
    .unwrap();
    wait_until(|| {
        snapshot(&alice)["conversations"][0]["messages"]
            .as_array()
            .is_some_and(|m| m.iter().any(|v| v["text"] == "Is this still available?"))
    });
    let records = wire.lock().unwrap().clone();
    // A private send-only connection never carries subscriptions (nor public listing traffic).
    for (connection, value) in &records {
        if value[0] == "EVENT"
            && value[1]["kind"]
                .as_u64()
                .is_some_and(|k| k == 1060 || k == 1059)
        {
            assert!(
                !records
                    .iter()
                    .any(|(id, v)| id == connection && v[0] == "REQ")
            );
        }
        assert!(!value.to_string().contains("Is this still available?"));
    }
    alice.shutdown();
    bob.shutdown();
    server.abort();
    runtime.shutdown_background();
}
