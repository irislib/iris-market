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
        bus.client()
            .wait_for_connection(Duration::from_secs(5))
            .await;
        let consumer = state.clone();
        let filter = Filter::new()
            .kind(Kind::Custom(listing::LISTING_KIND))
            .limit(300);
        // Inclusive overlap joins bounded history with new live events.
        let live_since = Timestamp::now();
        let subscription = bus
            .subscribe(
                vec![filter.clone().since(live_since)],
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
                vec![filter.until(live_since)],
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
            let pending = {
                let s = state.lock().unwrap();
                if s.profile_name_required {
                    Vec::new()
                } else {
                    s.store.pending().unwrap_or_default()
                }
            };
            let mut confirmed = 0;
            for event in pending {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                // Only an actual relay OK confirms publication; enqueue acceptance does not.
                if let Ok(Ok(output)) =
                    tokio::time::timeout(Duration::from_secs(8), bus.client().send_event(&event))
                        .await
                    && !output.success.is_empty()
                {
                    let mut s = state.lock().unwrap();
                    if s.store.acknowledge(&event.id.to_hex()).is_ok() {
                        confirmed += 1;
                        s.revision += 1;
                    }
                }
            }
            let connected = bus
                .client()
                .relays()
                .await
                .values()
                .any(|r| r.is_connected());
            {
                let mut s = state.lock().unwrap();
                s.status = if confirmed > 0 {
                    "Published"
                } else if connected {
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
        let mut filter = Filter::new()
            .kind(Kind::Custom(listing::LISTING_KIND))
            .limit(300);
        if page == 0 {
            filter = filter.hashtag(listing::REQUEST_TOPIC);
        }
        if let Some(cursor) = until {
            filter = filter.until(Timestamp::from(cursor));
        }
        let Ok(Ok(report)) = tokio::time::timeout_at(
            deadline,
            bus.query(vec![filter], QueryOptions { limit: Some(300) }),
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
        let (relays, scopes, pending) = {
            let mut s = state.lock().unwrap();
            let relays = s.settings.relays.clone();
            if let Some(m) = s.messaging.as_mut() {
                if m.retry().is_err() {
                    // The protocol adapter preserves its journal on failure.
                    // Surface this below without including any private payload.
                }
                (relays, m.subscriptions(), m.pending_outbound())
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
                bus.client()
                    .wait_for_connection(Duration::from_secs(4))
                    .await;
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
            for event in pending.into_iter().take(16) {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                // Fresh anonymous send-only client per envelope, never any receiving/listing scope.
                let Ok(sender) = RelayEventBus::new(relays.clone(), Duration::from_secs(4)).await
                else {
                    continue;
                };
                sender
                    .client()
                    .wait_for_connection(Duration::from_secs(4))
                    .await;
                // A roster update may have revoked a device while this client connected.
                let still_allowed =
                    state
                        .lock()
                        .unwrap()
                        .messaging
                        .as_ref()
                        .is_some_and(|messaging| {
                            messaging
                                .pending_outbound()
                                .iter()
                                .any(|queued| queued.id == event.id)
                        });
                if !still_allowed {
                    sender.client().shutdown().await;
                    continue;
                }
                let result = tokio::time::timeout(
                    Duration::from_secs(8),
                    sender.client().send_event(&event),
                )
                .await;
                sender.client().shutdown().await;
                if let Ok(Ok(output)) = result
                    && !output.success.is_empty()
                {
                    let mut s = state.lock().unwrap();
                    if let Some(m) = s.messaging.as_mut()
                        && m.acknowledge_published(&event.id.to_hex()).is_ok()
                    {
                        s.revision += 1;
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
