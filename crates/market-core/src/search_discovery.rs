//! Bounded, resumable public discovery. Each relay/filter owns its own cursor.
use crate::{State, listing};
use nostr::{Event, Filter, JsonUtil, Kind, Timestamp};
use nostr_pubsub::{
    EventSource, HistoryCursor, HistoryPage, HistoryPageCompletion, HistoryPageStatus, QueryEvent,
    SOURCE_PRIORITY_RELAY, SourceId, VerifiedEvent,
};
use nostr_pubsub_relay::RelayEventBus;
use nostr_sdk::{RelayMessage, RelayPoolNotification};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};

const PAGE_SIZE: usize = 300;
const MAX_EVENTS: usize = 1800;
const MAX_DELIVERIES: usize = 6000;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default, Clone, Serialize)]
pub struct Status {
    pub loading: bool,
    pub has_more: bool,
}
struct Entry {
    cursor: HistoryCursor,
    active: Option<HistoryPage>,
    done: bool,
}
#[derive(Default)]
pub(crate) struct Discovery {
    generation: u64,
    attempt: u64,
    stopped: bool,
    status: Status,
    cursors: HashMap<(String, String), Entry>,
    next_branch: HashMap<String, usize>,
}
impl Discovery {
    pub fn status(&self) -> Status {
        self.status.clone()
    }
    pub fn restart(&mut self, generation: u64, has_query: bool) {
        *self = Self {
            generation,
            attempt: 1,
            status: Status {
                loading: has_query,
                has_more: has_query,
            },
            ..Self::default()
        };
    }
    fn finish_active(&mut self) {
        for entry in self.cursors.values_mut() {
            if let Some(page) = entry.active.take() {
                entry
                    .cursor
                    .finish_page(page.token, HistoryPageCompletion::Partial);
            }
        }
    }
    pub fn more(&mut self) {
        self.finish_active();
        self.attempt = self.attempt.wrapping_add(1);
        self.stopped = false;
        self.status.loading = true;
    }
    pub fn stop(&mut self) {
        self.finish_active();
        self.attempt = self.attempt.wrapping_add(1);
        self.stopped = true;
        self.status.loading = false;
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Request {
    generation: u64,
    attempt: u64,
    query: String,
    relays: Vec<String>,
    terms: Vec<String>,
}
impl Request {
    fn current(&self, s: &State) -> bool {
        s.search_request == self.generation
            && s.search_discovery.generation == self.generation
            && s.search_discovery.attempt == self.attempt
            && !s.search_discovery.stopped
            && s.settings.relays == self.relays
    }
}
#[derive(Default)]
struct Budget {
    seen: HashSet<nostr::EventId>,
    bytes: usize,
    deliveries: usize,
    exhausted: bool,
}
fn ingest_locked(s: &mut State, budget: &mut Budget, event: &Event) {
    if budget.seen.contains(&event.id) {
        return;
    }
    budget.bytes = budget.bytes.saturating_add(event.as_json().len());
    if budget.bytes > MAX_BYTES || budget.seen.len() >= MAX_EVENTS {
        budget.exhausted = true;
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
        return vec![];
    }
    let base = Filter::new()
        .kind(Kind::Custom(listing::LISTING_KIND))
        .limit(PAGE_SIZE);
    vec![base.clone().hashtags(tags), base.search(normalized)]
}
fn filters(request: &Request) -> Vec<Filter> {
    let mut result = vec![
        Filter::new()
            .kind(Kind::Custom(listing::LISTING_KIND))
            .limit(PAGE_SIZE),
    ];
    result.extend(indexed_filters(&request.query));
    if !request.terms.is_empty() {
        result.push(
            Filter::new()
                .kind(Kind::Custom(listing::LISTING_KIND))
                .hashtags(request.terms.clone())
                .limit(PAGE_SIZE),
        );
    }
    result
}
fn admit(
    state: &Arc<Mutex<State>>,
    request: &Request,
    key: &(String, String),
    page: &HistoryPage,
    budget: &Mutex<Budget>,
    event: VerifiedEvent,
) {
    let mut s = state.lock().unwrap();
    if !request.current(&s) {
        return;
    }
    let received = QueryEvent {
        event,
        source: EventSource::relay(key.0.clone()),
        priority: SOURCE_PRIORITY_RELAY,
    };
    let mut budget = budget.lock().unwrap();
    budget.deliveries += 1;
    if budget.deliveries > MAX_DELIVERIES {
        budget.exhausted = true;
        return;
    }
    let Some(entry) = s.search_discovery.cursors.get_mut(key) else {
        return;
    };
    // Record this relay's raw verified page evidence BEFORE global cache dedup.
    if !entry.cursor.observe(page.token, &received) {
        return;
    }
    ingest_locked(&mut s, &mut budget, received.event.as_event());
}
#[allow(clippy::too_many_arguments)]
async fn read_page(
    bus: &RelayEventBus,
    state: &Arc<Mutex<State>>,
    request: &Request,
    key: &(String, String),
    page: &HistoryPage,
    budget: &Mutex<Budget>,
    deadline: tokio::time::Instant,
    stopped: &AtomicBool,
) -> (HistoryPageCompletion, bool) {
    if !request.current(&state.lock().unwrap()) {
        return (HistoryPageCompletion::Partial, false);
    }
    let mut notifications = bus.client().notifications();
    let output = tokio::time::timeout_at(
        deadline,
        bus.client()
            .subscribe_to([key.0.as_str()], page.filter.clone(), None),
    )
    .await;
    let Ok(Ok(output)) = output else {
        return (HistoryPageCompletion::Partial, false);
    };
    if output.success.is_empty() {
        return (HistoryPageCompletion::Partial, false);
    }
    let id = output.val;
    let page_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(2));
    let mut complete = HistoryPageCompletion::Partial;
    let mut unsupported = false;
    loop {
        if stopped.load(Ordering::Acquire)
            || !request.current(&state.lock().unwrap())
            || budget.lock().unwrap().exhausted
        {
            break;
        }
        tokio::select! {
            _=tokio::time::sleep_until(page_deadline)=>break,
            _=tokio::time::sleep(Duration::from_millis(50))=>{},
            received=notifications.recv()=>match received {
                Ok(RelayPoolNotification::Message{message:RelayMessage::Event{subscription_id,event},..}) if subscription_id.as_ref()==&id => {
                    if let Ok(event)=VerifiedEvent::try_from(event.into_owned()) {admit(state,request,key,page,budget,event);}
                },
                Ok(RelayPoolNotification::Message{message:RelayMessage::EndOfStoredEvents(subscription_id),..}) if subscription_id.as_ref()==&id=>{complete=HistoryPageCompletion::Complete;break;},
                Ok(RelayPoolNotification::Message{message:RelayMessage::Closed{subscription_id,..},..}) if subscription_id.as_ref()==&id=>{unsupported=page.filter.search.is_some();break;},
                Err(_)=>break,
                _=>{}
            }
        }
    }
    bus.client().unsubscribe(&id).await;
    (complete, unsupported)
}
async fn relay_window(
    state: Arc<Mutex<State>>,
    request: Request,
    relay: String,
    budget: Arc<Mutex<Budget>>,
    slots: Arc<Semaphore>,
    deadline: tokio::time::Instant,
    stopped: Arc<AtomicBool>,
) {
    let Ok(bus) = RelayEventBus::new([relay.clone()], Duration::from_secs(2)).await else {
        return;
    };
    let _ = tokio::time::timeout_at(
        deadline,
        bus.client().wait_for_connection(Duration::from_secs(2)),
    )
    .await;
    let branches = filters(&request);
    // Three pages per source per window. Branch rotation persists across windows.
    for _ in 0..3 {
        if tokio::time::Instant::now() >= deadline
            || stopped.load(Ordering::Acquire)
            || budget.lock().unwrap().exhausted
        {
            break;
        }
        let selected = {
            let mut s = state.lock().unwrap();
            if !request.current(&s) {
                break;
            }
            let mut chosen = None;
            for _ in 0..branches.len() {
                let index = s
                    .search_discovery
                    .next_branch
                    .entry(relay.clone())
                    .or_default();
                let filter = branches[*index % branches.len()].clone();
                *index += 1;
                let key = (relay.clone(), filter.as_json());
                let entry = s
                    .search_discovery
                    .cursors
                    .entry(key.clone())
                    .or_insert_with(|| Entry {
                        cursor: HistoryCursor::new(
                            SourceId::new(relay.clone()),
                            filter,
                            Timestamp::now(),
                            1600,
                        )
                        .expect("bounded listing filter"),
                        active: None,
                        done: false,
                    });
                if entry.done {
                    continue;
                }
                if let Some(page) = entry.cursor.begin_page() {
                    entry.active = Some(page.clone());
                    chosen = Some((key, page));
                    break;
                }
            }
            chosen
        };
        let Some((key, page)) = selected else {
            break;
        };
        let permit = tokio::time::timeout_at(deadline, slots.acquire()).await;
        let outcome = if let Ok(Ok(_permit)) = permit {
            read_page(
                &bus, &state, &request, &key, &page, &budget, deadline, &stopped,
            )
            .await
        } else {
            (HistoryPageCompletion::Partial, false)
        };
        let mut s = state.lock().unwrap();
        if !request.current(&s) {
            break;
        }
        if let Some(entry) = s.search_discovery.cursors.get_mut(&key) {
            let result = entry.cursor.finish_page(page.token, outcome.0);
            entry.active = None;
            entry.done = outcome.1
                || matches!(
                    result.status,
                    HistoryPageStatus::Exhausted | HistoryPageStatus::Limited
                );
        }
    }
    bus.client().shutdown().await;
}
pub(crate) async fn run(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    let mut previous = None;
    while !stopped.load(Ordering::Acquire) {
        let request = {
            let s = state.lock().unwrap();
            Request {
                generation: s.search_request,
                attempt: s.search_discovery.attempt,
                query: s.query.clone(),
                relays: s.settings.relays.clone(),
                terms: s.search_terms.clone(),
            }
        };
        if request.query.trim().is_empty()
            || request.relays.is_empty()
            || !request.current(&state.lock().unwrap())
            || previous.as_ref() == Some(&request)
        {
            tokio::select! {_=notify.notified()=>{},_=tokio::time::sleep(Duration::from_millis(250))=>{}}
            continue;
        }
        previous = Some(request.clone());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        let budget = Arc::new(Mutex::new(Budget::default()));
        let slots = Arc::new(Semaphore::new(2));
        let mut jobs = tokio::task::JoinSet::new();
        let mut started = HashSet::new();
        for relay in &request.relays {
            if !started.insert(relay) {
                continue;
            }
            jobs.spawn(relay_window(
                state.clone(),
                request.clone(),
                relay.clone(),
                budget.clone(),
                slots.clone(),
                deadline,
                stopped.clone(),
            ));
        }
        while jobs.join_next().await.is_some() {}
        let mut s = state.lock().unwrap();
        if request.current(&s) {
            s.search_discovery.status.loading = false;
            let branches = filters(&request);
            s.search_discovery.status.has_more = request.relays.iter().any(|relay| {
                branches.iter().any(|filter| {
                    s.search_discovery
                        .cursors
                        .get(&(relay.clone(), filter.as_json()))
                        .is_none_or(|entry| !entry.done)
                })
            });
            s.revision += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_wire_deliveries_still_exhaust_the_window_budget() {
        let dir = tempfile::tempdir().unwrap();
        let app = crate::Market::open(dir.path(), &crate::generate_secret_key(), true).unwrap();
        app.command(r#"{"type":"set_filter","query":"fixture","side":"all"}"#)
            .unwrap();
        let request = {
            let s = app.state.lock().unwrap();
            Request {
                generation: s.search_request,
                attempt: s.search_discovery.attempt,
                query: s.query.clone(),
                relays: s.settings.relays.clone(),
                terms: vec![],
            }
        };
        let filter = Filter::new()
            .kind(Kind::Custom(listing::LISTING_KIND))
            .limit(1);
        let key = ("test-source".to_owned(), filter.as_json());
        let mut cursor =
            HistoryCursor::new(SourceId::new(&key.0), filter, Timestamp::now(), 1600).unwrap();
        let page = cursor.begin_page().unwrap();
        app.state.lock().unwrap().search_discovery.cursors.insert(
            key.clone(),
            Entry {
                cursor,
                active: Some(page.clone()),
                done: false,
            },
        );
        let draft = crate::model::Draft {
            title: "Fixture".into(),
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
        };
        let event = listing::build(
            &nostr::Keys::generate(),
            &draft,
            "fixture",
            listing::now(),
            false,
        )
        .unwrap();
        let event = VerifiedEvent::try_from(event).unwrap();
        let budget = Mutex::new(Budget::default());
        for _ in 0..=MAX_DELIVERIES {
            admit(&app.state, &request, &key, &page, &budget, event.clone());
        }
        assert!(budget.lock().unwrap().exhausted);
        assert_eq!(budget.lock().unwrap().seen.len(), 1);
        app.shutdown();
    }
}
