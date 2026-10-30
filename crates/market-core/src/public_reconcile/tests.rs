use super::*;
use crate::{model::Draft, store::Store};
use futures_util::{SinkExt, StreamExt};
use nostr::Keys;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn event(keys: &Keys, id: &str, at: u64, sold: bool, expires: Option<u64>) -> Event {
    listing::build(
        keys,
        &Draft {
            title: format!("Listing {id}"),
            description: "Public listing".into(),
            side: "offer".into(),
            price: "1".into(),
            currency: "EUR".into(),
            location: String::new(),
            category: "Other".into(),
            tags: vec![],
            service_areas: None,
            image_url: None,
            expires_at: expires,
        },
        id,
        at,
        sold,
    )
    .unwrap()
}

async fn relay(
    remote: Vec<Event>,
    window: Window,
    extras: Vec<Event>,
) -> (String, JoinHandle<Vec<EventId>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let mut engine = Session::new(
            records(&remote, window).unwrap(),
            window,
            Limits {
                max_frame_bytes: FRAME_BYTES,
                ..Limits::default()
            },
        )
        .unwrap();
        let mut requested = vec![];
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.to_text() else {
                continue;
            };
            let Ok(message) = ClientMessage::from_json(text) else {
                continue;
            };
            match message {
                ClientMessage::NegOpen {
                    subscription_id,
                    filter,
                    initial_message,
                    ..
                } => {
                    assert_eq!(
                        filter
                            .kinds
                            .as_ref()
                            .unwrap()
                            .iter()
                            .copied()
                            .collect::<Vec<_>>(),
                        vec![Kind::Custom(listing::LISTING_KIND)]
                    );
                    assert_eq!(filter.since.unwrap().as_secs(), window.since);
                    assert_eq!(filter.until.unwrap().as_secs(), window.until);
                    let frame = engine.respond(&unhex(&initial_message).unwrap()).unwrap();
                    socket
                        .send(Message::Text(
                            serde_json::json!(["NEG-MSG", subscription_id, hex(&frame)])
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                ClientMessage::NegMsg {
                    subscription_id,
                    message,
                } => {
                    let frame = engine.respond(&unhex(&message).unwrap()).unwrap();
                    socket
                        .send(Message::Text(
                            serde_json::json!(["NEG-MSG", subscription_id, hex(&frame)])
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                ClientMessage::Req {
                    subscription_id,
                    filters,
                } => {
                    let filter = &filters[0];
                    let ids = filter.ids.as_ref().unwrap();
                    assert!(ids.len() <= FETCH_BATCH);
                    requested.extend(ids.iter().copied());
                    for event in remote
                        .iter()
                        .filter(|e| ids.contains(&e.id))
                        .chain(extras.iter())
                    {
                        socket
                            .send(Message::Text(
                                RelayMessage::event(
                                    subscription_id.clone().into_owned(),
                                    event.clone(),
                                )
                                .as_json()
                                .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    socket
                        .send(Message::Text(
                            serde_json::json!(["EOSE", subscription_id])
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                ClientMessage::Event(_) | ClientMessage::Auth(_) => {
                    panic!("Download-only repair must never publish/authenticate")
                }
                ClientMessage::NegClose { .. } | ClientMessage::Close(_) => {}
                _ => {}
            }
        }
        requested
    });
    (url, task)
}

#[test]
fn snapshot_uses_real_winning_store_records_including_inactive_authority() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("store.sqlite")).unwrap();
    let keys = Keys::generate();
    let at = listing::now();
    let old = event(&keys, "sold", at - 4, false, None);
    let sold = event(&keys, "sold", at - 2, true, None);
    let expired = event(&keys, "expired", at - 3, false, Some(at - 1));
    for e in [&old, &sold, &expired] {
        store.ingest(e, at, false).unwrap();
    }
    assert!(
        store
            .listings(&keys.public_key().to_hex(), at)
            .unwrap()
            .is_empty()
    );
    let snapshot = store
        .reconciliation_snapshot(at - 10, at, MAX_RECORDS, MAX_BYTES)
        .unwrap();
    let ids: HashSet<_> = snapshot.iter().map(|e| e.id).collect();
    assert_eq!(ids, HashSet::from([sold.id, expired.id]));
    assert!(!ids.contains(&old.id));
    assert!(
        store
            .reconciliation_snapshot(at - 10, at, 1, MAX_BYTES)
            .is_err()
    );
    assert!(
        store
            .reconciliation_snapshot(at - 10, at, MAX_RECORDS, 1)
            .is_err()
    );
}

#[tokio::test]
async fn real_protocol_downloads_only_missing_signed_records_and_keeps_inactive_winners() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("store.sqlite")).unwrap();
    let keys = Keys::generate();
    let at = listing::now();
    let known = event(&keys, "known", at - 4, false, None);
    let old = event(&keys, "changed", at - 3, false, None);
    let sold = event(&keys, "changed", at - 1, true, None);
    let added = event(&keys, "added", at - 2, false, None);
    store.ingest(&known, at, false).unwrap();
    store.ingest(&old, at, false).unwrap();
    let mut forged = sold.clone();
    forged.content = "invalid signature".into();
    let unrelated = event(&keys, "unrequested", at - 2, false, None);
    let window = Window {
        since: at - 10,
        until: at,
    };
    let snapshot = store
        .reconciliation_snapshot(window.since, window.until, MAX_RECORDS, MAX_BYTES)
        .unwrap();
    let (url, server) = relay(
        vec![known.clone(), sold.clone(), added.clone()],
        window,
        vec![forged, unrelated],
    )
    .await;
    let report = reconcile(
        &url,
        &snapshot,
        window,
        |e| store.ingest(&e, at, false),
        || true,
    )
    .await
    .unwrap();
    assert!(report.complete);
    assert_eq!(report.requested, 2);
    assert_eq!(report.received, 2);
    let requested = timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        requested.into_iter().collect::<HashSet<_>>(),
        HashSet::from([sold.id, added.id])
    );
    assert_eq!(
        store
            .event(&format!("{}:changed", keys.public_key()))
            .unwrap()
            .id,
        sold.id
    );
    assert_eq!(
        store
            .listings(&keys.public_key().to_hex(), at)
            .unwrap()
            .len(),
        2
    );
    assert!(
        store.pending().unwrap().is_empty(),
        "repair must not enqueue publication"
    );
}

async fn bad_relay(response: &'static str) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.to_text() else {
                continue;
            };
            if let Ok(ClientMessage::NegOpen {
                subscription_id, ..
            }) = ClientMessage::from_json(text)
            {
                let reply = if response == "error" {
                    serde_json::json!(["NEG-ERR", subscription_id, "unsupported"])
                } else {
                    serde_json::json!(["NEG-MSG", subscription_id, response])
                };
                socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .unwrap();
                break;
            }
        }
        while socket.next().await.is_some() {}
    });
    (url, task)
}

#[tokio::test]
async fn unsupported_and_malformed_peers_do_not_admit_events() {
    for response in ["error", "not-hex", "6101"] {
        let (url, server) = bad_relay(response).await;
        let mut admitted = 0;
        let result = reconcile(
            &url,
            &[],
            Window {
                since: 0,
                until: listing::now(),
            },
            |_| {
                admitted += 1;
                Ok(true)
            },
            || true,
        )
        .await;
        assert!(result.is_err(), "{response}");
        assert_eq!(admitted, 0);
        timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[test]
fn frame_and_snapshot_validation_are_bounded() {
    assert!(unhex(&"a".repeat(FRAME_BYTES * 2 + 2)).is_err());
    assert!(unhex("0").is_err());
    assert!(unhex("zz").is_err());
    let keys = Keys::generate();
    let at = listing::now();
    let mut invalid = event(&keys, "invalid", at, false, None);
    invalid.content.push_str("forged");
    assert!(
        records(
            &[invalid],
            Window {
                since: at - 1,
                until: at
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn nip11_is_required_and_queried_with_a_bounded_plain_get() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    assert!(advertises_negentropy(br#"{"supported_nips":[1,77]}"#));
    assert!(!advertises_negentropy(br#"{"supported_nips":[1]}"#));
    assert!(!advertises_negentropy(br#"{"supported_nips":["77"]}"#));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 2048];
        let count = stream.read(&mut buf).await.unwrap();
        let request = String::from_utf8_lossy(&buf[..count]).to_ascii_lowercase();
        assert!(request.starts_with("get / http/1.1"));
        assert!(request.contains("accept: application/nostr+json"));
        let body = r#"{"supported_nips":[1,77]}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(supports_negentropy(&client, &url).await);
    server.await.unwrap();
}

#[tokio::test]
async fn oversized_missing_set_aborts_before_fetch_or_publication() {
    let keys = Keys::generate();
    let at = listing::now();
    let events = (0..=MAX_NEED)
        .map(|i| event(&keys, &format!("gap-{i}"), at, false, None))
        .collect();
    let window = Window {
        since: at - 1,
        until: at,
    };
    let (url, server) = relay(events, window, vec![]).await;
    let mut admitted = 0;
    let result = reconcile(
        &url,
        &[],
        window,
        |_| {
            admitted += 1;
            Ok(true)
        },
        || true,
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("missing-event budget")
    );
    assert_eq!(admitted, 0);
    assert!(
        timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn cancellation_does_not_wait_for_relay_or_admit_data() {
    let started = Instant::now();
    let result = reconcile(
        "ws://127.0.0.1:9",
        &[],
        Window {
            since: 0,
            until: listing::now(),
        },
        |_| panic!("cancelled"),
        || false,
    )
    .await;
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
}
