use crate::{State, listing};
use anyhow::{Result, bail};
use nostr::{Filter, Kind};
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
        let subscription = bus
            .subscribe(
                vec![filter.clone()],
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
            .query(vec![filter], QueryOptions { limit: Some(300) })
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
        loop {
            if stopped.load(Ordering::Acquire) {
                break;
            }
            if state.lock().unwrap().settings.relays != relays {
                break;
            }
            let pending = state.lock().unwrap().store.pending().unwrap_or_default();
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
            tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(20))=>{} }
        }
        drop(subscription);
        bus.client().shutdown().await;
    }
}

pub(crate) async fn discover_contact(
    relays: &[String],
    author: nostr::PublicKey,
) -> Result<nostr::Event> {
    if relays.is_empty() {
        bail!("Connect to a message server to start a conversation");
    }
    // This discovery context queries one public author and is never reused for sends.
    let bus = RelayEventBus::new(relays.to_vec(), Duration::from_secs(8)).await?;
    bus.client()
        .wait_for_connection(Duration::from_secs(5))
        .await;
    let filter = crate::messaging::Messaging::contact_discovery_filter(&author.to_hex())
        .map_err(anyhow::Error::msg)?
        .filter;
    let result = bus
        .query(vec![filter], QueryOptions { limit: Some(5) })
        .await;
    bus.client().shutdown().await;
    let report = result?;
    report.events.into_iter().map(|q|q.event.into_event()).filter(|e|e.pubkey==author)
        .max_by_key(|e|e.created_at).ok_or_else(||anyhow::anyhow!("This seller has not enabled private enquiries here. You can exchange a private invitation instead."))
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
                            if let Some(m) = s.messaging.as_mut()
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
