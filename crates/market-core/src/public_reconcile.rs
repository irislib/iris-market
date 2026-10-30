//! Download-only, bounded NIP-77 repair of the existing public listing store.
//! This never shares account keys, private subscriptions, messages or outboxes.
use crate::{State, listing};
use anyhow::{Result, bail, ensure};
use nostr::{
    ClientMessage, Event, EventId, Filter, JsonUtil, Kind, RelayMessage, SubscriptionId, Timestamp,
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

async fn reconcile(
    url: &str,
    local: &[Event],
    window: Window,
    mut admit: impl FnMut(Event) -> Result<bool>,
    current: impl Fn() -> bool,
) -> Result<Report> {
    let snapshot = records(local, window)?;
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
        let filter = Filter::new()
            .kind(Kind::Custom(listing::LISTING_KIND))
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
                                && window.contains(event.created_at.as_secs())
                                && listing::parse(&event, window.until).is_ok()
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
        let Ok(snapshot) = snapshot else {
            continue;
        };
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
        let _ = reconcile(url, &snapshot, window, admit, current).await;
    }
}

#[cfg(test)]
mod tests;
