//! A bounded public author feed, independent of Browse filters and private inboxes.
use crate::{State, image_proxy, listing, model::Listing, store::Store};
use anyhow::Result;
use nostr::{Event, Filter, JsonUtil, Kind, PublicKey};
use nostr_pubsub::{EventBus, NostrEventSubscriber, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{runtime::Runtime, sync::Notify};

const PAGE_SIZE: usize = 48;
const MAX_RECORDS: usize = 240;
const MAX_DELIVERIES: usize = 1024;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Page {
    pub author: String,
    pub listings: Vec<Listing>,
    pub loading: bool,
    pub can_load_more: bool,
    pub error: Option<String>,
}
struct Control {
    cancelled: AtomicBool,
    wake: Notify,
}
pub(crate) struct Feed {
    pub author: String,
    limit: usize,
    loading: bool,
    has_more: bool,
    error: Option<String>,
    control: Arc<Control>,
    deliveries: usize,
    bytes: usize,
    seen: HashSet<nostr::EventId>,
}
impl Feed {
    pub fn cancel(&self) {
        self.control.cancelled.store(true, Ordering::Release);
        self.control.wake.notify_one();
    }
    pub fn snapshot(
        &self,
        store: &Store,
        owner: &str,
        proxy: &crate::model::ImageProxySettings,
        rates: &crate::rates::RateBook,
        currency: &str,
    ) -> Result<Page> {
        let mut listings = store.listings_for_author(owner, &self.author, listing::now())?;
        let more_cached = listings.len() > self.limit;
        listings.truncate(self.limit);
        for listing in &mut listings {
            crate::rates::project(listing, rates, currency, listing::now());
            listing.image_url = listing
                .image_url
                .as_deref()
                .and_then(|url| image_proxy::image_url(url, proxy, 800, 800, false));
        }
        Ok(Page {
            author: self.author.clone(),
            listings,
            loading: self.loading,
            can_load_more: self.limit < MAX_RECORDS && (self.has_more || more_cached),
            error: self.error.clone(),
        })
    }
}
pub(crate) fn start(
    runtime: &Runtime,
    state: Arc<Mutex<State>>,
    author: &str,
    more: bool,
) -> Result<()> {
    let (relays, control, limit, demo) = {
        let mut s = state.lock().unwrap();
        let limit = if more {
            let feed = s
                .profile_listings
                .as_ref()
                .filter(|feed| feed.author == author)
                .ok_or_else(|| anyhow::anyhow!("Open this profile first"))?;
            if feed.loading || (feed.limit >= MAX_RECORDS && feed.error.is_none()) {
                return Ok(());
            }
            if feed.error.is_some() {
                feed.limit
            } else {
                (feed.limit + PAGE_SIZE).min(MAX_RECORDS)
            }
        } else {
            PAGE_SIZE
        };
        if let Some(feed) = s.profile_listings.take() {
            feed.cancel();
        }
        let control = Arc::new(Control {
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
        });
        let demo = s.demo;
        let relays = s.settings.relays.clone();
        s.profile_listings = Some(Feed {
            author: author.into(),
            limit,
            loading: !demo && !relays.is_empty(),
            has_more: false,
            error: None,
            control: control.clone(),
            deliveries: 0,
            bytes: 0,
            seen: HashSet::new(),
        });
        s.revision += 1;
        (relays, control, limit, demo)
    };
    if !demo && !relays.is_empty() {
        runtime.spawn(run(
            state,
            relays,
            PublicKey::from_hex(author)?,
            control,
            limit,
        ));
    }
    Ok(())
}
fn ingest(state: &Arc<Mutex<State>>, control: &Arc<Control>, author: PublicKey, event: &Event) {
    if control.cancelled.load(Ordering::Acquire)
        || event.pubkey != author
        || event.kind != Kind::Custom(listing::LISTING_KIND)
    {
        return;
    }
    let mut s = state.lock().unwrap();
    let Some(feed) = s
        .profile_listings
        .as_mut()
        .filter(|feed| Arc::ptr_eq(&feed.control, control))
    else {
        return;
    };
    feed.deliveries += 1;
    if feed.deliveries > MAX_DELIVERIES {
        feed.loading = false;
        feed.error = Some("Some listings couldn’t be loaded. Try again.".into());
        feed.cancel();
        s.revision += 1;
        return;
    }
    if !feed.seen.insert(event.id) {
        return;
    }
    feed.bytes += event.as_json().len();
    if feed.bytes > MAX_BYTES || feed.seen.len() > MAX_RECORDS * 2 {
        feed.loading = false;
        feed.error = Some("Some listings couldn’t be loaded. Try again.".into());
        feed.cancel();
        s.revision += 1;
        return;
    }
    if let Ok(true) = s.store.ingest(event, listing::now(), false) {
        s.revision += 1;
    }
}
fn finish(state: &Arc<Mutex<State>>, control: &Arc<Control>, count: Option<usize>) {
    let mut s = state.lock().unwrap();
    if let Some(feed) = s
        .profile_listings
        .as_mut()
        .filter(|feed| Arc::ptr_eq(&feed.control, control))
    {
        if control.cancelled.load(Ordering::Acquire) && feed.error.is_some() {
            return;
        }
        feed.loading = false;
        feed.has_more = count.is_some_and(|count| count >= feed.limit);
        feed.error = if count.is_none() {
            Some("Couldn’t refresh listings. Try again.".into())
        } else {
            None
        };
        s.revision += 1;
    }
}
async fn run(
    state: Arc<Mutex<State>>,
    relays: Vec<String>,
    author: PublicKey,
    control: Arc<Control>,
    limit: usize,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let bus = match RelayEventBus::new(relays, Duration::from_secs(5)).await {
        Ok(bus) => bus,
        Err(_) => {
            finish(&state, &control, None);
            return;
        }
    };
    if control.cancelled.load(Ordering::Acquire) {
        bus.client().shutdown().await;
        return;
    }
    tokio::select! {
        _ = control.wake.notified() => { bus.client().shutdown().await; return; },
        _ = bus.client().wait_for_connection(Duration::from_secs(3)) => {}
    }
    let filter = Filter::new()
        .author(author)
        .kind(Kind::Custom(listing::LISTING_KIND))
        .limit(limit);
    let target = state.clone();
    let token = control.clone();
    let subscription = bus
        .subscribe(
            vec![filter.clone()],
            Arc::new(move |received| ingest(&target, &token, author, received.event.as_event())),
        )
        .await;
    let subscription = match subscription {
        Ok(subscription) => subscription,
        Err(_) => {
            finish(&state, &control, None);
            bus.client().shutdown().await;
            return;
        }
    };
    // Streaming starts before this bounded historical query. Cached data and new
    // events are visible immediately; EOSE never gates opening the profile.
    tokio::select! {
        _=control.wake.notified()=>{},
        report=tokio::time::timeout(Duration::from_secs(6),bus.query(vec![filter],QueryOptions{limit:Some(limit)}))=>{
            match report {
                Ok(Ok(report))=>{let count=report.events.len();for received in report.events {ingest(&state,&control,author,received.event.as_event());}finish(&state,&control,Some(count));},
                _=>finish(&state,&control,None),
            }
        }
    }
    if !control.cancelled.load(Ordering::Acquire) {
        tokio::select! {_=control.wake.notified()=>{},_=tokio::time::sleep_until(deadline)=>{}}
    }
    let _ = subscription.close().await;
    bus.client().shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_budget_stops_stream_and_preserves_retry_error() {
        let dir = tempfile::tempdir().unwrap();
        Store::open(&dir.path().join("market.sqlite"))
            .unwrap()
            .save_settings(&crate::model::Settings {
                relays: vec![],
                ..Default::default()
            })
            .unwrap();
        let app = crate::Market::open(dir.path(), &crate::generate_secret_key(), false).unwrap();
        let keys = nostr::Keys::generate();
        app.command(
            &serde_json::json!({"type":"load_profile","author":keys.public_key().to_hex()})
                .to_string(),
        )
        .unwrap();
        let token = app
            .state
            .lock()
            .unwrap()
            .profile_listings
            .as_ref()
            .unwrap()
            .control
            .clone();
        let draft = crate::model::Draft {
            title: "Fixture".into(),
            description: String::new(),
            side: "offer".into(),
            price: "1".into(),
            currency: "EUR".into(),
            location: String::new(),
            category: "Other".into(),
            tags: Vec::new(),
            service_areas: None,
            image_url: None,
            expires_at: None,
        };
        let event = listing::build(&keys, &draft, "fixture", listing::now(), false).unwrap();
        for _ in 0..=MAX_DELIVERIES {
            ingest(&app.state, &token, keys.public_key(), &event);
        }
        assert!(token.cancelled.load(Ordering::Acquire));
        finish(&app.state, &token, Some(1));
        let state = app.state.lock().unwrap();
        let feed = state.profile_listings.as_ref().unwrap();
        assert!(!feed.loading);
        assert!(feed.error.is_some());
        assert_eq!(feed.seen.len(), 1);
        drop(state);
        app.shutdown();
    }
}
