//! Submitted searches retrieve public inventory without gating local results.
//! Literal tags, optional NIP-50 and chronological history are independent:
//! relays that do not support search cannot suppress the other sources.
use crate::{State, listing};
use nostr::{Event, EventId, Filter, JsonUtil, Kind, Timestamp};
use nostr_pubsub::{EventBus, NostrEventSubscriber, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const PAGE_SIZE: usize = 300;
const MAX_EVENTS: usize = 1800;
const MAX_DELIVERIES: usize = 6000;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
struct Request {
    generation: u64,
    query: String,
    relays: Vec<String>,
}
impl Request {
    fn current(&self, s: &State) -> bool {
        s.search_request == self.generation && s.settings.relays == self.relays
    }
}
#[derive(Default)]
struct Budget {
    seen: HashSet<EventId>,
    bytes: usize,
    deliveries: usize,
}

fn ingest(state: &Arc<Mutex<State>>, request: &Request, budget: &Mutex<Budget>, event: &Event) {
    let mut s = state.lock().unwrap();
    if !request.current(&s) || event.kind != Kind::Custom(listing::LISTING_KIND) {
        return;
    }
    let mut budget = budget.lock().unwrap();
    budget.deliveries += 1;
    if budget.deliveries > MAX_DELIVERIES
        || budget.bytes >= MAX_BYTES
        || budget.seen.len() >= MAX_EVENTS
        || budget.seen.contains(&event.id)
    {
        return;
    }
    budget.bytes = budget.bytes.saturating_add(event.as_json().len());
    if budget.bytes > MAX_BYTES {
        return;
    }
    budget.seen.insert(event.id);
    if let Ok(true) = s.store.ingest(event, listing::now(), false) {
        s.revision += 1;
    }
}

fn indexed_filters(query: &str) -> Vec<Filter> {
    let normalized = query.trim().to_lowercase();
    let mut tags = Vec::new();
    for word in normalized
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
    {
        if !tags.iter().any(|tag| tag == word) {
            tags.push(word.to_owned());
        }
        if tags.len() == 6 {
            break;
        }
    }
    if tags.is_empty() {
        return Vec::new();
    }
    let base = Filter::new()
        .kind(Kind::Custom(listing::LISTING_KIND))
        .limit(PAGE_SIZE);
    vec![base.clone().hashtags(tags), base.search(normalized)]
}

async fn retrieve(
    bus: &RelayEventBus,
    state: &Arc<Mutex<State>>,
    request: &Request,
    budget: &Arc<Mutex<Budget>>,
    filter: Filter,
) -> Vec<Event> {
    let target = state.clone();
    let request_copy = request.clone();
    let allowance = budget.clone();
    // Subscription admission streams verified events before the finite query
    // finishes, including from a relay that never sends EOSE.
    let subscription = bus
        .subscribe(
            vec![filter.clone()],
            Arc::new(move |received| {
                ingest(
                    &target,
                    &request_copy,
                    &allowance,
                    received.event.as_event(),
                );
            }),
        )
        .await
        .ok();
    let events = bus
        .query(
            vec![filter],
            QueryOptions {
                limit: Some(PAGE_SIZE),
            },
        )
        .await
        .map(|report| {
            report
                .events
                .into_iter()
                .map(|e| e.event.into_event())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for event in &events {
        ingest(state, request, budget, event);
    }
    if let Some(subscription) = subscription {
        let _ = subscription.close().await;
    }
    events
}

async fn discover(bus: &RelayEventBus, state: &Arc<Mutex<State>>, request: &Request) {
    let budget = Arc::new(Mutex::new(Budget::default()));
    let filters = indexed_filters(&request.query);
    let indexed = async {
        if let [tags, text] = filters.as_slice() {
            tokio::join!(
                retrieve(bus, state, request, &budget, tags.clone()),
                retrieve(bus, state, request, &budget, text.clone())
            );
        }
    };
    let chronological = async {
        let mut until = None;
        for _ in 0..5 {
            let mut filter = Filter::new()
                .kind(Kind::Custom(listing::LISTING_KIND))
                .limit(PAGE_SIZE);
            if let Some(cursor) = until {
                filter = filter.until(Timestamp::from(cursor));
            }
            let events = retrieve(bus, state, request, &budget, filter).await;
            // Relay timeouts can return a partial page without EOSE. A short
            // page does not establish exhaustion; continue until the cursor
            // stops or the existing page/time/byte budgets are reached.
            if events.is_empty() {
                break;
            }
            let Some(oldest) = events.iter().map(|event| event.created_at.as_secs()).min() else {
                break;
            };
            // Keep an inclusive boundary. Dense seconds stop rather than skip
            // unseen events; finite history is best-effort, not completeness.
            if until.is_some_and(|previous| oldest >= previous) {
                break;
            }
            until = Some(oldest);
        }
    };
    tokio::join!(indexed, chronological);
}

async fn obsolete(state: &Arc<Mutex<State>>, request: &Request, stopped: &AtomicBool) {
    loop {
        if stopped.load(Ordering::Acquire) || !request.current(&state.lock().unwrap()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(crate) async fn run(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    let mut previous = None;
    while !stopped.load(Ordering::Acquire) {
        let request = {
            let s = state.lock().unwrap();
            Request {
                generation: s.search_request,
                query: s.query.clone(),
                relays: s.settings.relays.clone(),
            }
        };
        if request.generation == 0
            || request.query.trim().is_empty()
            || request.relays.is_empty()
            || previous.as_ref() == Some(&request)
        {
            tokio::select! { _=notify.notified()=>{}, _=tokio::time::sleep(Duration::from_millis(250))=>{} }
            continue;
        }
        previous = Some(request.clone());
        let bus = tokio::select! {
            _ = obsolete(&state, &request, &stopped) => continue,
            result = RelayEventBus::new(request.relays.clone(), Duration::from_secs(2)) => {
                match result { Ok(bus) => bus, Err(_) => continue }
            }
        };
        // This private worker session never blocks a command, feed refresh or
        // publication. Cancelled generations cannot admit late deliveries.
        tokio::select! {
            _ = obsolete(&state, &request, &stopped) => {},
            _ = tokio::time::timeout(Duration::from_secs(12), async {
                bus.client().wait_for_connection(Duration::from_secs(2)).await;
                discover(&bus, &state, &request).await;
            }) => {},
        }
        bus.client().shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_queries_are_literal_lowercase_and_independent() {
        let filters = indexed_filters(" MEAT / Local meat ");
        let tags: serde_json::Value = serde_json::from_str(&filters[0].as_json()).unwrap();
        let search: serde_json::Value = serde_json::from_str(&filters[1].as_json()).unwrap();
        assert_eq!(tags["#t"], serde_json::json!(["local", "meat"]));
        assert!(tags["search"].is_null());
        assert_eq!(search["search"], "meat / local meat");
        assert!(search["#t"].is_null());
        assert!(indexed_filters("---").is_empty());
    }

    #[test]
    fn changed_query_rejects_late_inventory_and_bounds_duplicate_deliveries() {
        let dir = tempfile::tempdir().unwrap();
        crate::store::Store::open(&dir.path().join("market.sqlite"))
            .unwrap()
            .save_settings(&crate::model::Settings {
                relays: vec![],
                ..Default::default()
            })
            .unwrap();
        let app = crate::Market::open(dir.path(), &crate::generate_secret_key(), false).unwrap();
        app.command(r#"{"type":"set_filter","query":"MEAT","side":"all"}"#)
            .unwrap();
        let request = Request {
            generation: app.state.lock().unwrap().search_request,
            query: "MEAT".into(),
            relays: vec![],
        };
        let budget = Mutex::new(Budget::default());
        let event = listing::build(
            &nostr::Keys::generate(),
            &crate::model::Draft {
                title: "Fresh meat".into(),
                description: String::new(),
                side: "offer".into(),
                price: String::new(),
                currency: "EUR".into(),
                location: String::new(),
                category: "Other".into(),
                tags: vec![],
                service_areas: None,
                image_url: None,
                expires_at: None,
            },
            "late",
            listing::now(),
            false,
        )
        .unwrap();
        app.command(r#"{"type":"set_filter","query":"bicycle","side":"all"}"#)
            .unwrap();
        ingest(&app.state, &request, &budget, &event);
        assert!(budget.lock().unwrap().seen.is_empty());
        assert!(
            app.state
                .lock()
                .unwrap()
                .store
                .event(&format!("{}:late", event.pubkey))
                .is_err()
        );
        let current = Request {
            generation: app.state.lock().unwrap().search_request,
            ..request
        };
        for _ in 0..=MAX_DELIVERIES {
            ingest(&app.state, &current, &budget, &event);
        }
        assert_eq!(budget.lock().unwrap().seen.len(), 1);
        app.shutdown();
    }
}
