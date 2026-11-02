use crate::{State, listing};
use anyhow::{Result, bail};
use nostr::{Filter, JsonUtil, Kind, Timestamp};
use nostr_pubsub::{EventBus, NostrEventSubscriber, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub fn validate_relays(relays: &[String]) -> Result<()> {
    if relays.len() > 8 {
        bail!("Choose up to eight message servers");
    }
    for value in relays {
        let u = url::Url::parse(value)?;
        let local = u
            .host_str()
            .is_some_and(|h| h == "localhost" || h == "127.0.0.1" || h == "[::1]");
        if u.host_str().is_none()
            || !(u.scheme() == "wss" || u.scheme() == "ws" && local)
            || !u.username().is_empty()
            || u.password().is_some()
        {
            bail!("Use secure wss:// server URLs (ws:// is allowed for localhost tests)");
        }
    }
    Ok(())
}

pub(crate) async fn run(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    tokio::spawn(run_outbox(state.clone(), stopped.clone(), false));
    while !stopped.load(Ordering::Acquire) {
        let relays = { state.lock().unwrap().settings.relays.clone() };
        if relays.is_empty() {
            {
                let mut s = state.lock().unwrap();
                s.status = "Offline · saved listings available".into();
                s.revision += 1;
            }
            notify.notified().await;
            continue;
        }
        let bus = match RelayEventBus::new(relays.clone(), Duration::from_secs(5)).await {
            Ok(bus) => bus,
            Err(_) => {
                state.lock().unwrap().status = "Could not connect · retrying".into();
                tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(15))=>{} }
                continue;
            }
        };
        let consumer = state.clone();
        let filter = Filter::new().limit(300);
        // Inclusive overlap joins bounded history with new live events.
        let live_since = Timestamp::now();
        let subscription = bus
            .subscribe(
                listing::filters(filter.clone().since(live_since)),
                Arc::new(move |received| {
                    let mut s = consumer.lock().unwrap();
                    if let Ok(true) =
                        s.store
                            .ingest(received.event.as_event(), listing::now(), false)
                    {
                        s.revision += 1;
                    }
                }),
            )
            .await;
        let subscription = match subscription {
            Ok(subscription) => subscription,
            Err(_) => {
                bus.client().shutdown().await;
                state.lock().unwrap().status = "Offline · reconnecting".into();
                tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(10))=>{} }
                continue;
            }
        };
        if let Ok(report) = bus
            .query(
                listing::filters(filter.until(live_since)),
                QueryOptions { limit: Some(300) },
            )
            .await
        {
            let mut s = state.lock().unwrap();
            for event in report.events {
                if let Ok(true) = s
                    .store
                    .ingest(event.event.as_event(), listing::now(), false)
                {
                    s.revision += 1;
                }
            }
        }
        let mut metadata_queried = std::collections::HashSet::new();
        let mut buying_request = 0;
        loop {
            if stopped.load(Ordering::Acquire) {
                break;
            }
            if state.lock().unwrap().settings.relays != relays {
                break;
            }
            let request = state.lock().unwrap().buying_request;
            if request != buying_request {
                buying_request = request;
                backfill_buying(&bus, &state, &relays, request, &stopped).await;
            }
            // These are authors of the public marketplace feed, never inbox peers.
            let authors = {
                let s = state.lock().unwrap();
                s.store
                    .listings(&s.owner.to_hex(), listing::now())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|listing| nostr::PublicKey::from_hex(&listing.author).ok())
                    .filter(|author| metadata_queried.insert(*author))
                    .take(64)
                    .collect::<Vec<_>>()
            };
            if !authors.is_empty()
                && let Ok(report) = bus
                    .query(
                        vec![
                            Filter::new()
                                .kinds([Kind::Metadata, Kind::EventDeletion])
                                .authors(authors.clone())
                                .limit(128),
                        ],
                        QueryOptions { limit: Some(128) },
                    )
                    .await
            {
                let mut s = state.lock().unwrap();
                for received in report.events {
                    let event = received.event.into_event();
                    if matches!(event.kind, Kind::Metadata | Kind::EventDeletion)
                        && authors.contains(&event.pubkey)
                    {
                        let _ = s.profiles.ingest_public(event);
                    }
                }
                s.revision += 1;
            }
            let connected = bus
                .client()
                .relays()
                .await
                .values()
                .any(|r| r.is_connected());
            {
                let mut s = state.lock().unwrap();
                s.status = if connected {
                    "Connected"
                } else {
                    "Offline · changes queued"
                }
                .into();
                s.revision += 1;
            }
            if state.lock().unwrap().buying_request != buying_request {
                continue;
            }
            tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(20))=>{} }
        }
        drop(subscription);
        bus.client().shutdown().await;
    }
}

/// An explicit Buying refresh retrieves indexed requests, then a finite legacy
/// lookback. It never sends a user's search text or imports unsigned fixtures.
async fn backfill_buying(
    bus: &RelayEventBus,
    state: &Arc<Mutex<State>>,
    relays: &[String],
    request: u64,
    stopped: &AtomicBool,
) {
    let mut until = None;
    let mut bytes = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    for page in 0..5 {
        {
            let s = state.lock().unwrap();
            if stopped.load(Ordering::Acquire)
                || s.settings.relays != relays
                || s.buying_request != request
                || s.side != "request"
            {
                return;
            }
        }
        let mut filter = Filter::new().limit(300);
        if page == 0 {
            filter = filter.hashtag(listing::REQUEST_TOPIC);
        }
        if let Some(cursor) = until {
            filter = filter.until(Timestamp::from(cursor));
        }
        let Ok(Ok(report)) = tokio::time::timeout_at(
            deadline,
            bus.query(listing::filters(filter), QueryOptions { limit: Some(300) }),
        )
        .await
        else {
            return;
        };
        let count = report.events.len();
        let mut oldest = None;
        let mut s = state.lock().unwrap();
        if s.settings.relays != relays || s.buying_request != request || s.side != "request" {
            return;
        }
        for received in report.events.into_iter().take(300) {
            let event = received.event.as_event();
            bytes = bytes.saturating_add(event.as_json().len());
            if bytes > 8 * 1024 * 1024 {
                return;
            }
            oldest = Some(oldest.map_or(event.created_at.as_secs(), |at: u64| {
                at.min(event.created_at.as_secs())
            }));
            if let Ok(true) = s.store.ingest(event, listing::now(), false) {
                s.revision += 1;
            }
        }
        if page == 0 {
            continue;
        }
        if count < 300 {
            return;
        }
        let Some(oldest) = oldest else {
            return;
        };
        // Inclusive boundary preserves same-second records. Stop if a relay's
        // dense second prevents progress, rather than skip unseen revisions.
        if until.is_some_and(|previous| oldest >= previous) {
            return;
        }
        until = Some(oldest);
    }
}

pub(crate) async fn discover_authorization(
    relays: &[String],
    owner: nostr::PublicKey,
) -> Result<Vec<nostr::Event>> {
    crate::identity::fetch_authorization_complete(relays, owner).await
}

pub(crate) async fn run_private(
    state: Arc<Mutex<State>>,
    notify: Arc<Notify>,
    stopped: Arc<AtomicBool>,
) {
    use nostr_pubsub::NostrEventSubscription;
    use std::collections::{HashMap, HashSet};
    tokio::spawn(run_outbox(state.clone(), stopped.clone(), true));
    let mut connections: HashMap<String, (RelayEventBus, Box<dyn NostrEventSubscription>)> =
        HashMap::new();
    let mut previous_relays = Vec::new();
    while !stopped.load(Ordering::Acquire) {
        // A generated local identity is still a visitor until explicit setup.
        // Preserve its journal, but create no private subscriptions or sends.
        if state.lock().unwrap().profile_name_required {
            for (_, (bus, _sub)) in connections.drain() {
                bus.client().shutdown().await;
            }
            tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(5))=>{} }
            continue;
        }
        let (relays, scopes) = {
            let mut s = state.lock().unwrap();
            let relays = s.settings.relays.clone();
            if let Some(m) = s.messaging.as_mut() {
                if m.retry().is_err() {
                    // The protocol adapter preserves its journal on failure.
                    // Surface this below without including any private payload.
                }
                (relays, m.subscriptions())
            } else {
                return;
            }
        };
        if relays != previous_relays {
            for (_, (bus, _sub)) in connections.drain() {
                bus.client().shutdown().await;
            }
            previous_relays = relays.clone();
        }
        if !relays.is_empty() {
            let wanted: HashSet<_> = scopes.iter().map(|s| s.scope.clone()).collect();
            let retired: Vec<_> = connections
                .keys()
                .filter(|key| !wanted.contains(*key))
                .cloned()
                .collect();
            for key in retired {
                if let Some((bus, _sub)) = connections.remove(&key) {
                    bus.client().shutdown().await;
                }
            }
            for scope in scopes {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                if connections.contains_key(&scope.scope) {
                    continue;
                }
                let Ok(bus) = RelayEventBus::new(relays.clone(), Duration::from_secs(4)).await
                else {
                    continue;
                };
                let receiver = state.clone();
                let wake = notify.clone();
                let subscription = bus
                    .subscribe(
                        vec![scope.filter],
                        Arc::new(move |q| {
                            let mut s = receiver.lock().unwrap();
                            if q.event.as_event().kind == Kind::Metadata {
                                if s.profiles.ingest(q.event.as_event().clone()).is_ok() {
                                    s.revision += 1;
                                }
                            } else if let Some(m) = s.messaging.as_mut()
                                && m.receive(q.event.as_event()).is_ok()
                            {
                                s.revision += 1;
                                wake.notify_waiters();
                            }
                        }),
                    )
                    .await;
                match subscription {
                    Ok(sub) => {
                        connections.insert(scope.scope, (bus, sub));
                    }
                    Err(_) => {
                        bus.client().shutdown().await;
                    }
                }
            }
        }
        tokio::select! {_=notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(5))=>{}}
    }
    for (_, (bus, _sub)) in connections {
        bus.client().shutdown().await;
    }
}

// Durable queues are drained independently of discovery and browsing. Dispatch
// queues EVENT locally; relay OK notifications are background bookkeeping only.
struct OutboundLease {
    id: nostr::EventId,
    sender: RelayEventBus,
    responses: tokio::sync::broadcast::Receiver<nostr_sdk::RelayPoolNotification>,
    expires: tokio::time::Instant,
}

async fn run_outbox(state: Arc<Mutex<State>>, stopped: Arc<AtomicBool>, private: bool) {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut leases: VecDeque<OutboundLease> = VecDeque::new();
    let mut retry_at = HashMap::new();
    let mut previous_relays = Vec::new();
    while !stopped.load(Ordering::Acquire) {
        let (relays, mut pending) = {
            let mut s = state.lock().unwrap();
            let relays = s.settings.relays.clone();
            let pending = if s.profile_name_required {
                Vec::new()
            } else if private {
                s.messaging
                    .as_mut()
                    .map(|m| {
                        let _ = m.retry();
                        m.pending_outbound()
                    })
                    .unwrap_or_default()
            } else {
                s.store.pending().unwrap_or_default()
            };
            (relays, pending)
        };
        let queued = pending.iter().map(|event| event.id).collect::<HashSet<_>>();
        retry_at.retain(|id, _| queued.contains(id));
        // Poll responses only; dispatch never awaits a response or connection.
        let mut retained = VecDeque::new();
        while let Some(mut lease) = leases.pop_front() {
            let accepted = poll_acceptance(&mut lease.responses, lease.id);
            if accepted {
                let mut s = state.lock().unwrap();
                let acknowledged = if private {
                    s.messaging
                        .as_mut()
                        .is_some_and(|m| m.acknowledge_published(&lease.id.to_hex()).is_ok())
                } else {
                    s.store.acknowledge(&lease.id.to_hex()).is_ok()
                };
                if acknowledged {
                    s.revision += 1;
                }
            }
            if accepted
                || !queued.contains(&lease.id)
                || relays != previous_relays
                || lease.expires <= tokio::time::Instant::now()
            {
                lease.sender.client().shutdown().await;
            } else {
                retained.push_back(lease);
            }
        }
        leases = retained;
        previous_relays = relays.clone();
        let active = leases.iter().map(|lease| lease.id).collect::<HashSet<_>>();
        // New work precedes retries; silent relays cannot starve the tail.
        pending.sort_by_key(|event| retry_at.get(&event.id).copied());
        let mut dispatched = 0;
        for event in pending {
            if relays.is_empty() || dispatched == 2 || stopped.load(Ordering::Acquire) {
                break;
            }
            if active.contains(&event.id)
                || retry_at
                    .get(&event.id)
                    .is_some_and(|at| *at > tokio::time::Instant::now())
            {
                continue;
            }
            let id = event.id;
            retry_at.insert(id, tokio::time::Instant::now() + Duration::from_secs(10));
            // Two attempts per 500ms and fixed 8s leases bound connection use
            // independently of responses. The cap is an extra resource guard,
            // never a gate: new work evicts the oldest lease, retaining its journal.
            if leases.len() == 64
                && let Some(oldest) = leases.pop_front()
            {
                oldest.sender.client().shutdown().await;
            }
            if let Ok(sender) = RelayEventBus::new(relays.clone(), Duration::from_secs(4)).await {
                let responses = sender.client().notifications();
                let allowed = {
                    let s = state.lock().unwrap();
                    !s.profile_name_required
                        && if private {
                            s.messaging.as_ref().is_some_and(|m| {
                                m.pending_outbound().iter().any(|event| event.id == id)
                            })
                        } else {
                            true
                        }
                };
                if allowed && enqueue_outbound(&sender, &event).await {
                    leases.push_back(OutboundLease {
                        id,
                        sender,
                        responses,
                        expires: tokio::time::Instant::now() + Duration::from_secs(8),
                    });
                } else {
                    sender.client().shutdown().await;
                }
            }
            dispatched += 1;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    for lease in leases {
        lease.sender.client().shutdown().await;
    }
}

fn poll_acceptance(
    responses: &mut tokio::sync::broadcast::Receiver<nostr_sdk::RelayPoolNotification>,
    id: nostr::EventId,
) -> bool {
    loop {
        match responses.try_recv() {
            Ok(nostr_sdk::RelayPoolNotification::Message {
                message:
                    nostr::RelayMessage::Ok {
                        event_id,
                        status: true,
                        ..
                    },
                ..
            }) if event_id == id => return true,
            Err(
                tokio::sync::broadcast::error::TryRecvError::Empty
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => return false,
            _ => {}
        }
    }
}

async fn enqueue_outbound(sender: &RelayEventBus, event: &nostr::Event) -> bool {
    sender
        .client()
        .send_msg_to(
            sender.relays().iter().map(String::as_str),
            nostr::ClientMessage::Event(std::borrow::Cow::Borrowed(event)),
        )
        .await
        .is_ok_and(|output| !output.success.is_empty())
}

#[cfg(test)]
async fn observe_acceptance(
    responses: &mut tokio::sync::broadcast::Receiver<nostr_sdk::RelayPoolNotification>,
    id: nostr::EventId,
    lifetime: Duration,
) -> bool {
    tokio::time::timeout(lifetime, async {
        loop {
            match responses.recv().await {
                Ok(nostr_sdk::RelayPoolNotification::Message {
                    message:
                        nostr::RelayMessage::Ok {
                            event_id,
                            status: true,
                            ..
                        },
                    ..
                }) if event_id == id => return true,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
                _ => {}
            }
        }
    })
    .await
    .unwrap_or(false)
}
#[cfg(test)]
mod private_publish_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use nostr::{EventBuilder, Keys};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    type RelayAcceptance = Arc<Mutex<Option<bool>>>;

    async fn relay(accept: Option<bool>) -> (String, tokio::task::JoinHandle<()>, RelayAcceptance) {
        let acceptance = Arc::new(Mutex::new(accept));
        let mode = acceptance.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                match message {
                    Message::Text(text) => {
                        let frame: Value = serde_json::from_str(&text).unwrap();
                        if frame[0] == "EVENT" {
                            let accepted = *mode.lock().unwrap();
                            if let Some(accepted) = accepted {
                                let _ = socket
                                    .send(Message::Text(
                                        json!(["OK", frame[1]["id"], accepted, ""])
                                            .to_string()
                                            .into(),
                                    ))
                                    .await;
                            }
                        }
                    }
                    Message::Ping(bytes) => {
                        let _ = socket.send(Message::Pong(bytes)).await;
                    }
                    _ => {}
                }
            }
        });
        (url, task, acceptance)
    }

    async fn publish_with(accept: Option<bool>) -> bool {
        let (first, first_task, _) = relay(accept).await;
        let (silent, silent_task, _) = relay(None).await;
        let sender = RelayEventBus::new([first, silent], Duration::from_secs(1))
            .await
            .unwrap();
        let event = EventBuilder::new(Kind::Custom(1059), "synthetic ciphertext")
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let mut responses = sender.client().notifications();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                enqueue_outbound(&sender, &event)
            )
            .await
            .unwrap()
        );
        let accepted =
            observe_acceptance(&mut responses, event.id, Duration::from_millis(300)).await;
        sender.client().shutdown().await;
        first_task.abort();
        silent_task.abort();
        accepted
    }

    #[test]
    fn seventeenth_envelope_dispatches_without_any_relay_response_and_shutdown_closes_clients() {
        use crate::{Market, model::Settings, store::Store};
        use std::sync::atomic::AtomicUsize;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let seen = received.clone();
        let live = Arc::new(AtomicUsize::new(0));
        let connections = live.clone();
        let server = runtime.spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let seen = seen.clone();
                let connections = connections.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = accept_async(stream).await else {
                        return;
                    };
                    connections.fetch_add(1, Ordering::AcqRel);
                    while let Some(Ok(message)) = socket.next().await {
                        if let Message::Text(text) = message {
                            let frame: Value = serde_json::from_str(&text).unwrap();
                            if frame[0] == "EVENT" {
                                seen.lock()
                                    .unwrap()
                                    .insert(frame[1]["id"].as_str().unwrap().to_string());
                            }
                            // Deliberately no OK, EOSE, AUTH, or other response.
                        }
                    }
                    connections.fetch_sub(1, Ordering::AcqRel);
                });
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("market.sqlite")).unwrap();
        store
            .save_settings(&Settings {
                relays: vec![url],
                ..Default::default()
            })
            .unwrap();
        let keys = Keys::generate();
        let expected = (0..17)
            .map(|index| {
                let event = EventBuilder::new(Kind::TextNote, format!("synthetic backlog {index}"))
                    .sign_with_keys(&keys)
                    .unwrap();
                store.queue_event(&event).unwrap();
                event.id.to_hex()
            })
            .collect::<std::collections::HashSet<_>>();
        let market =
            Market::open(directory.path(), &keys.secret_key().to_secret_hex(), false).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(7);
        while !expected.is_subset(&received.lock().unwrap()) {
            assert!(
                std::time::Instant::now() < deadline,
                "A later envelope waited for a relay reply/timeout"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            store.pending().unwrap().len(),
            17,
            "Local dispatch is not relay acceptance"
        );
        market.shutdown();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while live.load(Ordering::Acquire) != 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "Stopped outbox leaked relay clients"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        server.abort();
    }

    #[tokio::test]
    async fn outbound_dispatch_never_waits_for_connection_or_reply() {
        // TCP endpoint intentionally never completes a WebSocket handshake.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sender = RelayEventBus::new(
            [format!("ws://{}", listener.local_addr().unwrap())],
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        for index in 0..3 {
            let event = EventBuilder::new(Kind::Custom(1059), format!("synthetic queued {index}"))
                .sign_with_keys(&Keys::generate())
                .unwrap();
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(100),
                    enqueue_outbound(&sender, &event)
                )
                .await
                .unwrap()
            );
        }
        sender.client().shutdown().await;
    }

    #[tokio::test]
    async fn private_publish_accepts_one_relay_without_waiting_for_silent_relay() {
        assert!(publish_with(Some(true)).await);
    }

    #[tokio::test]
    async fn private_publish_retries_the_same_event_after_silence() {
        let (url, task, mode) = relay(None).await;
        let sender = RelayEventBus::new([url], Duration::from_secs(1))
            .await
            .unwrap();
        let event = EventBuilder::new(Kind::Custom(1059), "synthetic retry ciphertext")
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let mut responses = sender.client().notifications();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                enqueue_outbound(&sender, &event)
            )
            .await
            .unwrap()
        );
        assert!(!observe_acceptance(&mut responses, event.id, Duration::from_millis(150)).await);
        *mode.lock().unwrap() = Some(true);
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                enqueue_outbound(&sender, &event)
            )
            .await
            .unwrap()
        );
        assert!(observe_acceptance(&mut responses, event.id, Duration::from_millis(300)).await);
        sender.client().shutdown().await;
        task.abort();
    }

    #[tokio::test]
    async fn private_publish_does_not_acknowledge_rejection_or_silence() {
        assert!(!publish_with(Some(false)).await);
        assert!(!publish_with(None).await);
    }
}
