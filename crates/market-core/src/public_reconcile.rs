//! Download-only, bounded NIP-77 repair of public listings and discovery lists.
//! This never shares account keys, private subscriptions, messages or outboxes.
use crate::{State, listing};
use anyhow::{Result, bail, ensure};
use nostr::{
    ClientMessage, Event, EventId, Filter, JsonUtil, Kind, PublicKey, RelayMessage, SubscriptionId,
    Timestamp,
};
use nostr_pubsub_reconcile::{Filter as Window, Limits, Record, Session};
use nostr_pubsub_relay::{RelaySession, RelaySessionEvent};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::Notify,
    time::{Instant, timeout},
};

const MAX_RECORDS: usize = 4096;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const FRAME_BYTES: usize = 16_384;
const GRAPH_BATCH: usize = 32;
const MAX_NEED: usize = 256;
const FETCH_BATCH: usize = 32;
const MAX_DELIVERIES: usize = 2048;
const ROUND_TIME: Duration = Duration::from_secs(20);
const INTERVAL: Duration = Duration::from_secs(300);
const HISTORY_SECONDS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Default)]
struct Report {
    requested: usize,
    received: usize,
    complete: bool,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(value: &str) -> Result<Vec<u8>> {
    ensure!(
        value.len() <= FRAME_BYTES * 2 && value.len().is_multiple_of(2),
        "Reconciliation frame exceeds its budget"
    );
    ensure!(
        value.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid reconciliation frame"
    );
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(Into::into))
        .collect()
}

/// Reverify the immutable local snapshot outside the application state lock.
fn records(events: &[Event], window: Window) -> Result<Vec<Record>> {
    ensure!(
        events.len() <= MAX_RECORDS,
        "Public snapshot exceeds its record budget"
    );
    let mut bytes = 0usize;
    events
        .iter()
        .map(|event| {
            bytes = bytes.saturating_add(event.as_json().len());
            ensure!(
                bytes <= MAX_BYTES && window.contains(event.created_at.as_secs()),
                "Public snapshot is outside its budget/window"
            );
            listing::parse(event, window.until)?;
            Ok(Record {
                timestamp: event.created_at.as_secs(),
                id: event.id.to_bytes(),
            })
        })
        .collect()
}

async fn next(
    session: &mut RelaySession,
    current: &impl Fn() -> bool,
    deliveries: &mut usize,
) -> Result<RelaySessionEvent> {
    loop {
        ensure!(current(), "Public reconciliation cancelled");
        tokio::select! {
            result = session.next() => {
                let value = result?.ok_or_else(|| anyhow::anyhow!("Relay closed reconciliation"))?;
                *deliveries += 1;
                ensure!(*deliveries <= MAX_DELIVERIES, "Relay exceeded reconciliation delivery budget");
                return Ok(value);
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

struct Round {
    filter: Filter,
    window: Window,
    snapshot: Vec<Record>,
}

// Only public follow paths select authors. Never enumerate mute targets, private peers or outboxes.
fn graph_round(
    graph: &nostr_social_graph::SocialGraph,
    cursor: &mut usize,
    until: u64,
) -> Option<Round> {
    let root = PublicKey::from_hex(graph.get_root()).ok()?;
    let mut neighbours = Vec::new();
    for distance in [1, 2] {
        let mut layer = graph.get_users_by_follow_distance(distance);
        layer.sort_unstable();
        neighbours.extend(
            layer
                .into_iter()
                .filter_map(|key| PublicKey::from_hex(&key).ok()),
        );
    }
    let mut authors = vec![root];
    if !neighbours.is_empty() {
        let count = neighbours.len().min(GRAPH_BATCH - 1);
        authors.extend(
            neighbours
                .iter()
                .cycle()
                .skip(*cursor % neighbours.len())
                .take(count)
                .copied(),
        );
        *cursor = (*cursor % neighbours.len() + count) % neighbours.len();
    }
    let window = Window { since: 0, until };
    let mut snapshot = Vec::new();
    for author in &authors {
        for kind in [3, 10000] {
            if let Some(head) = graph.get_list_revision(&author.to_hex(), kind)
                && head.complete
                && window.contains(head.created_at)
                && let Ok(id) = EventId::from_hex(&head.id)
            {
                snapshot.push(Record {
                    timestamp: head.created_at,
                    id: id.to_bytes(),
                });
            }
        }
    }
    Some(Round {
        filter: Filter::new()
            .authors(authors)
            .kinds([Kind::ContactList, Kind::MuteList]),
        window,
        snapshot,
    })
}

fn accepts_graph_list(graph: &nostr_social_graph::SocialGraph, event: &Event) -> bool {
    let author = event.pubkey.to_hex();
    let previous_at = match event.kind {
        Kind::ContactList => graph.get_follow_list_created_at(&author),
        Kind::MuteList => graph.get_mute_list_created_at(&author),
        _ => return false,
    };
    let head = graph.get_list_revision(&author, u32::from(event.kind.as_u16()));
    nostr_social_graph::accepts_list_revision(
        previous_at,
        head.as_ref(),
        event.created_at.as_secs(),
        &event.id.to_hex(),
    )
}

async fn reconcile(
    url: &str,
    local: &[Event],
    window: Window,
    admit: impl FnMut(Event) -> Result<bool>,
    current: impl Fn() -> bool,
) -> Result<Report> {
    let round = Round {
        filter: Filter::new().kind(Kind::Custom(listing::LISTING_KIND)),
        snapshot: records(local, window)?,
        window,
    };
    fetch_missing(url, round, admit, current).await
}

async fn fetch_missing(
    url: &str,
    round: Round,
    mut admit: impl FnMut(Event) -> Result<bool>,
    current: impl Fn() -> bool,
) -> Result<Report> {
    let Round {
        filter,
        window,
        snapshot,
    } = round;
    timeout(ROUND_TIME, async {
        let mut session = RelaySession::connect(url).await?;
        let mut deliveries = 0;
        loop {
            if matches!(
                next(&mut session, &current, &mut deliveries).await?,
                RelaySessionEvent::Connection(true)
            ) {
                break;
            }
        }
        let filter = filter
            .since(Timestamp::from(window.since))
            .until(Timestamp::from(window.until));
        let id = SubscriptionId::generate();
        let mut engine = Session::new(
            snapshot,
            window,
            Limits {
                max_records: MAX_RECORDS,
                max_frame_bytes: FRAME_BYTES,
                max_rounds: 32,
            },
        )
        .map_err(anyhow::Error::msg)?;
        let initial = hex(&engine.initiate().map_err(anyhow::Error::msg)?);
        session
            .send(ClientMessage::NegOpen {
                subscription_id: Cow::Borrowed(&id),
                filter: Cow::Borrowed(&filter),
                id_size: None,
                initial_message: Cow::Owned(initial),
            })
            .await?;
        let mut needed = HashSet::new();
        loop {
            match next(&mut session, &current, &mut deliveries).await? {
                RelaySessionEvent::Message(message) => match *message {
                    RelayMessage::NegMsg {
                        subscription_id,
                        message,
                    } if subscription_id.as_ref() == &id => {
                        let step = engine
                            .reconcile(&unhex(&message)?)
                            .map_err(anyhow::Error::msg)?;
                        for bytes in step.need {
                            needed.insert(EventId::from_byte_array(bytes));
                        }
                        ensure!(
                            needed.len() <= MAX_NEED,
                            "Reconciliation exceeds missing-event budget"
                        );
                        // `have` is deliberately ignored: this repair never uploads records.
                        if let Some(frame) = step.next {
                            session
                                .send(ClientMessage::NegMsg {
                                    subscription_id: Cow::Borrowed(&id),
                                    message: Cow::Owned(hex(&frame)),
                                })
                                .await?;
                        } else {
                            break;
                        }
                    }
                    RelayMessage::NegErr {
                        subscription_id, ..
                    } if subscription_id.as_ref() == &id => {
                        bail!("Relay does not support this reconciliation")
                    }
                    _ => {}
                },
                RelaySessionEvent::Connection(false) | RelaySessionEvent::Lagged(_) => {
                    bail!("Relay interrupted reconciliation")
                }
                _ => {}
            }
        }
        session
            .send(ClientMessage::NegClose {
                subscription_id: Cow::Borrowed(&id),
            })
            .await?;
        let mut ids: Vec<_> = needed.into_iter().collect();
        ids.sort();
        let mut report = Report {
            requested: ids.len(),
            received: 0,
            complete: true,
        };
        let mut bytes = 0usize;
        for batch in ids.chunks(FETCH_BATCH) {
            ensure!(current(), "Public reconciliation cancelled");
            let request_id = SubscriptionId::generate();
            let wanted: HashSet<_> = batch.iter().copied().collect();
            let mut received = HashSet::new();
            let request = filter.clone().ids(batch.iter().copied());
            session
                .send(ClientMessage::req(request_id.clone(), vec![request]))
                .await?;
            loop {
                match next(&mut session, &current, &mut deliveries).await? {
                    RelaySessionEvent::Message(message) => match *message {
                        RelayMessage::Event {
                            subscription_id,
                            event,
                        } if subscription_id.as_ref() == &request_id => {
                            bytes = bytes.saturating_add(event.as_json().len());
                            ensure!(bytes <= MAX_BYTES, "Reconciliation exceeds payload budget");
                            if wanted.contains(&event.id)
                                && !received.contains(&event.id)
                                && filter.match_event(&event, Default::default())
                                && match event.kind {
                                    Kind::ContactList | Kind::MuteList => {
                                        event.verify().is_ok()
                                            && crate::public_cache::current(&event, window.until)
                                    }
                                    _ => listing::parse(&event, window.until).is_ok(),
                                }
                            {
                                admit(event.as_ref().clone())?;
                                received.insert(event.id);
                                report.received += 1;
                            }
                        }
                        RelayMessage::EndOfStoredEvents(subscription_id)
                            if subscription_id.as_ref() == &request_id =>
                        {
                            break;
                        }
                        RelayMessage::Closed {
                            subscription_id, ..
                        } if subscription_id.as_ref() == &request_id => {
                            report.complete = false;
                            break;
                        }
                        _ => {}
                    },
                    RelaySessionEvent::Connection(false) | RelaySessionEvent::Lagged(_) => {
                        bail!("Relay interrupted public record download")
                    }
                    _ => {}
                }
            }
            session.send(ClientMessage::close(request_id)).await?;
            report.complete &= received.len() == wanted.len();
        }
        report.complete &= report.received == report.requested;
        Ok(report)
    })
    .await
    .map_err(|_| anyhow::anyhow!("Public reconciliation timed out"))?
}

fn advertises_negentropy(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| value.get("supported_nips")?.as_array().cloned())
        .is_some_and(|nips| nips.iter().any(|nip| nip.as_u64() == Some(77)))
}

async fn supports_negentropy(client: &reqwest::Client, relay: &str) -> bool {
    let Ok(mut url) = url::Url::parse(relay) else {
        return false;
    };
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return false,
    };
    if url.set_scheme(scheme).is_err() {
        return false;
    }
    let Ok(mut response) = client
        .get(url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
    else {
        return false;
    };
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65_536) {
        return false;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 65_536 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => return advertises_negentropy(&bytes),
            _ => return false,
        }
    }
}

pub(crate) async fn run(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    let Ok(http) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return;
    };
    let mut capabilities: HashMap<String, (Instant, bool)> = HashMap::new();
    let mut previous = Vec::new();
    let mut cursor = 0usize;
    let mut graph_cursors = HashMap::new();
    let mut due = Instant::now() + Duration::from_secs(3);
    loop {
        tokio::select! { _ = tokio::time::sleep_until(due) => {}, _ = notify.notified() => {} }
        if stopped.load(Ordering::Acquire) {
            return;
        }
        let relays = state.lock().unwrap().settings.relays.clone();
        if relays != previous {
            previous = relays.clone();
            cursor = 0;
            graph_cursors.clear();
            due = Instant::now() + Duration::from_secs(3);
            continue;
        }
        if Instant::now() < due {
            continue;
        }
        due = Instant::now() + INTERVAL;
        if relays.is_empty() {
            continue;
        }
        let url = &relays[cursor % relays.len()];
        cursor = cursor.wrapping_add(1);
        capabilities.retain(|relay, _| relays.contains(relay));
        let supported = if let Some((_, supported)) = capabilities
            .get(url)
            .filter(|(checked, _)| checked.elapsed() < Duration::from_secs(3600))
        {
            *supported
        } else {
            let supported = supports_negentropy(&http, url).await;
            capabilities.insert(url.clone(), (Instant::now(), supported));
            supported
        };
        if !supported {
            continue;
        }
        let until = listing::now();
        let window = Window {
            since: until.saturating_sub(HISTORY_SECONDS),
            until,
        };
        let snapshot = state.lock().unwrap().store.reconciliation_snapshot(
            window.since,
            window.until,
            MAX_RECORDS,
            MAX_BYTES,
        );
        let current =
            || !stopped.load(Ordering::Acquire) && state.lock().unwrap().settings.relays == relays;
        let admit = |event| {
            let mut state = state.lock().unwrap();
            if stopped.load(Ordering::Acquire) || state.settings.relays != relays {
                return Ok(false);
            }
            let changed = state.store.ingest(&event, listing::now(), false)?;
            if changed {
                state.revision += 1;
            }
            Ok(changed)
        };
        // Unsupported, offline and incomplete rounds never suppress normal REQ browsing.
        if let Ok(snapshot) = snapshot {
            let _ = reconcile(url, &snapshot, window, admit, current).await;
        }

        let (owner, graph) = {
            let s = state.lock().unwrap();
            if stopped.load(Ordering::Acquire) || s.settings.relays != relays || s.demo {
                continue;
            }
            (s.owner, Arc::clone(s.profiles.discovery_graph()))
        };
        let root = graph.get_root();
        let (last_root, offset) = graph_cursors
            .entry(url.clone())
            .or_insert_with(|| (String::new(), 0));
        if last_root != root {
            *last_root = root.to_owned();
            *offset = 0;
        }
        let Some(round) = graph_round(&graph, offset, listing::now()) else {
            continue;
        };
        let active = |s: &State| {
            !stopped.load(Ordering::Acquire)
                && !s.demo
                && s.owner == owner
                && s.settings.relays == relays
                && s.profiles.home_root() == root
        };
        let current = || active(&state.lock().unwrap());
        let admit = |event: Event| {
            if !accepts_graph_list(&graph, &event) {
                return Ok(false);
            }
            let mut s = state.lock().unwrap();
            if !active(&s) {
                return Ok(false);
            }
            let changed = s.profiles.ingest_graph_list(event)?;
            if changed {
                s.revision += 1;
            }
            Ok(changed)
        };
        let _ = fetch_missing(url, round, admit, current).await;
    }
}

#[cfg(test)]
mod tests;
