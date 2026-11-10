//! Scope product and deletion lookups to signed collections of the open profile.
use super::*;
use crate::collections;
use nostr::{Alphabet, EventId, Kind, SingleLetterTag};

pub(super) fn mark_error(state: &Mutex<State>, control: &Arc<Control>) {
    let mut state = state.lock().unwrap();
    if let Some(feed) = state.profile_listings.as_mut().filter(|f| f.owns(control)) {
        feed.collections_error = Some("Some collections couldn’t be refreshed. Try again.".into());
        state.revision += 1;
    }
}

async fn subscribe(
    bus: &RelayEventBus,
    state: &Arc<Mutex<State>>,
    control: &Arc<Control>,
    filters: Vec<Filter>,
    budget: &Arc<Mutex<Budget>>,
) -> Result<Box<dyn nostr_pubsub::NostrEventSubscription>> {
    let target = state.clone();
    let token = control.clone();
    let budget = budget.clone();
    let scope = filters.clone();
    Ok(bus
        .subscribe(
            filters,
            Arc::new(move |received| {
                let event = received.event.as_event();
                if token.cancelled.load(Ordering::Acquire)
                    || !scope
                        .iter()
                        .any(|f| f.match_event(event, Default::default()))
                {
                    return;
                }
                let mut budget = budget.lock().unwrap();
                if budget.exhausted {
                    return;
                }
                budget.deliveries += 1;
                budget.bytes += event.as_json().len();
                if budget.deliveries > MAX_DELIVERIES || budget.bytes > MAX_BYTES {
                    budget.exhausted = true;
                    drop(budget);
                    mark_error(&target, &token);
                    token.updates.notify_one();
                    return;
                }
                drop(budget);
                let mut state = target.lock().unwrap();
                if !state
                    .profile_listings
                    .as_ref()
                    .is_some_and(|f| f.owns(&token))
                {
                    return;
                }
                let result = match event.kind.as_u16() {
                    collections::KIND => {
                        state
                            .store
                            .ingest_collection(event, listing::now(), false, None)
                    }
                    5 => state
                        .store
                        .ingest_collection_deletion(event, listing::now()),
                    listing::LISTING_KIND => state.store.ingest(event, listing::now(), false),
                    _ => return,
                };
                if matches!(result, Ok(true)) {
                    state.revision += 1;
                    if event.kind.as_u16() != listing::LISTING_KIND
                        && let Some(feed) = &state.profile_listings
                    {
                        feed.collection_changed();
                    }
                }
            }),
        )
        .await?)
}

#[derive(Default)]
struct Budget {
    deliveries: usize,
    bytes: usize,
    exhausted: bool,
}

pub(super) async fn observe(
    bus: &RelayEventBus,
    state: &Arc<Mutex<State>>,
    control: &Arc<Control>,
    author: PublicKey,
    selected: Option<&str>,
) {
    let budget = Arc::new(Mutex::new(Budget::default()));
    let filter = Filter::new()
        .kind(Kind::Custom(collections::KIND))
        .author(author);
    let roots = vec![match selected {
        Some(id) => filter.identifier(id).limit(1),
        None => filter.limit(collections::PROFILE_LIMIT),
    }];
    let mut handles = Vec::new();
    let Ok(roots) = subscribe(bus, state, control, roots, &budget).await else {
        mark_error(state, control);
        return;
    };
    handles.push(roots);
    let mut observed_roots = HashSet::new();
    let mut observed_members = HashSet::new();
    loop {
        // Cached collections participate even before any relay has replied.
        if control.cancelled.load(Ordering::Acquire) || budget.lock().unwrap().exhausted {
            break;
        }
        let records = {
            let state = state.lock().unwrap();
            state.store.collection_targets(
                &author.to_hex(),
                &state.owner.to_hex(),
                selected,
                listing::now(),
            )
        };
        let Ok(records) = records else {
            mark_error(state, control);
            break;
        };
        let mut addresses = Vec::new();
        let mut event_ids = Vec::new();
        let mut products = std::collections::BTreeMap::new();
        let mut filters = Vec::new();
        for (identifier, event_id, members) in records {
            if observed_roots.len() < collections::PROFILE_LIMIT * 2
                && observed_roots.insert(event_id.clone())
            {
                addresses.push(format!("30405:{author}:{identifier}"));
                if let Ok(id) = EventId::from_hex(&event_id) {
                    event_ids.push(id);
                }
            }
            for id in members {
                if observed_members.len() >= MAX_RECORDS || !observed_members.insert(id.clone()) {
                    continue;
                }
                if let Ok((seller, product)) = collections::listing_parts(&id) {
                    products
                        .entry(seller)
                        .or_insert_with(Vec::new)
                        .push(product.to_owned());
                }
            }
        }
        for (seller, ids) in products {
            let count = ids.len();
            filters.push(
                Filter::new()
                    .kind(Kind::Custom(listing::LISTING_KIND))
                    .author(seller)
                    .identifiers(ids)
                    .limit(count),
            );
        }
        if !event_ids.is_empty() {
            filters.push(
                Filter::new()
                    .kind(Kind::EventDeletion)
                    .author(author)
                    .events(event_ids)
                    .limit(64),
            );
            filters.push(
                Filter::new()
                    .kind(Kind::EventDeletion)
                    .author(author)
                    .custom_tags(SingleLetterTag::lowercase(Alphabet::A), addresses)
                    .limit(64),
            );
        }
        // Each REQ is bounded. Products never widen into a general seller query.
        for chunk in filters.chunks(16) {
            match subscribe(bus, state, control, chunk.to_vec(), &budget).await {
                Ok(handle) => handles.push(handle),
                Err(_) => {
                    mark_error(state, control);
                    return;
                }
            }
        }
        control.updates.notified().await;
    }
    for handle in handles {
        let _ = handle.close().await;
    }
}

pub(crate) fn open(
    runtime: &Runtime,
    state: Arc<Mutex<State>>,
    author: String,
    selected: Option<String>,
) -> Result<()> {
    let author = PublicKey::from_hex(&author)?;
    let (control, relays, demo) = {
        let mut s = state.lock().unwrap();
        if let Some(id) = &selected {
            anyhow::ensure!(
                s.store
                    .collection_targets(
                        &author.to_hex(),
                        &s.owner.to_hex(),
                        Some(id),
                        listing::now()
                    )?
                    .len()
                    == 1,
                "This collection is unavailable"
            );
        }
        let feed = s
            .profile_listings
            .as_mut()
            .filter(|f| f.author == author.to_hex())
            .ok_or_else(|| anyhow::anyhow!("Open this profile first"))?;
        if let Some((_, prior)) = feed.selected.take() {
            prior.cancel();
        }
        let control = Arc::new(Control::default());
        feed.selected = selected.as_ref().map(|id| (id.clone(), control.clone()));
        s.revision += 1;
        (control, s.settings.relays.clone(), s.demo)
    };
    if let Some(id) = selected
        && !relays.is_empty()
        && !demo
    {
        runtime.spawn(async move {
            let bus = match RelayEventBus::new(relays, Duration::from_secs(5)).await {
                Ok(bus) => bus,
                Err(_) => {
                    mark_error(&state, &control);
                    return;
                }
            };
            let work = async {
                bus.client()
                    .wait_for_connection(Duration::from_secs(3))
                    .await;
                observe(&bus, &state, &control, author, Some(&id)).await;
            };
            tokio::select! {
                _ = control.wake.notified() => {},
                _ = tokio::time::timeout(Duration::from_secs(30), work) => {}
            }
            bus.client().shutdown().await;
        });
    }
    Ok(())
}
