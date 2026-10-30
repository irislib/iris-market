pub mod ai;
pub mod geo;
pub mod identity;
pub mod image_proxy;
pub mod listing;
pub mod literal_search;
pub mod local_ai;
pub mod messaging;
pub mod model;
pub mod network;
pub mod orders;
pub mod profile_listings;
pub mod profiles;
pub mod public_cache;
pub mod ranking;
pub mod rates;
mod search_discovery;
pub mod service_area;
pub mod store;
#[cfg(feature = "cashu-wallet")]
pub mod wallet;

use anyhow::{Context, Result, bail};
use model::*;
use nostr::{Keys, SecretKey};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{runtime::Runtime, sync::Notify};

pub(crate) struct State {
    store: store::Store,
    owner: nostr::PublicKey,
    owner_keys: Option<Keys>,
    settings: Settings,
    rates: rates::RateBook,
    ai_configured: bool,
    profile_name_required: bool,
    demo: bool,
    query: String,
    side: String,
    ai_search: bool,
    sort: String,
    status: String,
    error: Option<String>,
    ai_message: Option<String>,
    ai_test_result: Option<ai::TestResult>,
    ai_test_token: Option<String>,
    ai_check: u64,
    revision: u64,
    messaging: Option<messaging::Messaging>,
    invite: Option<String>,
    profiles: profiles::Profiles,
    public_cache: Option<public_cache::PublicEventCache>,
    profile: Option<profiles::Profile>,
    profile_request: u64,
    followers_request: u64,
    followers_cancel: Option<Arc<Notify>>,
    local_curation: Option<local_ai::Pending>,
    remote_ai_cancel: Option<Arc<Notify>>,
    remote_ai_is_check: bool,
    buying_request: u64,
    search_request: u64,
    profile_listings: Option<profile_listings::Feed>,
}
impl State {
    fn cancel_remote_ai(&mut self) {
        self.remote_ai_is_check = false;
        if let Some(cancel) = self.remote_ai_cancel.take() {
            // Retain a permit if invalidation happens before select starts.
            cancel.notify_one();
        }
    }
    fn remote_ai_current(&self, cancel: &Arc<Notify>) -> bool {
        self.remote_ai_cancel
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, cancel))
    }
    fn snapshot(&mut self) -> Result<Snapshot> {
        self.profiles.refresh_public_cache();
        if let Some(profile) = self.profile.as_mut() {
            let mut refreshed = self.profiles.profile(&profile.person.author);
            refreshed.loading = profile.loading;
            refreshed.error = profile.error.clone();
            refreshed.followers_loaded = profile.followers_loaded;
            refreshed.followers_loading = profile.followers_loading;
            refreshed.followers_error = profile.followers_error.clone();
            *profile = refreshed;
        }
        let mut listings = self.store.listings(&self.owner.to_hex(), listing::now())?;
        let mut saved_listings: Vec<_> = listings.iter().filter(|l| l.saved).cloned().collect();
        let saved_count = saved_listings.len();
        let query = self.query.to_lowercase();
        let interests = ranking::saved_interests(&listings);
        listings.retain(|l| {
            (self.side == "all" || l.side == self.side)
                && (self.ai_search
                    || query.is_empty()
                    || literal_search::matches_literal_search(
                        &format!(
                            "{} {} {} {} {}",
                            l.title,
                            l.description,
                            l.location,
                            l.category,
                            l.tags.join(" ")
                        ),
                        &query,
                    ))
        });
        if self.sort == "suggested" {
            ranking::rank(
                &mut listings,
                &self.profiles,
                &interests,
                &self.query,
                listing::now(),
            );
        }
        let mut people: std::collections::BTreeMap<_, _> = listings
            .iter()
            .chain(saved_listings.iter())
            .map(|l| (l.author.clone(), self.profiles.person(&l.author)))
            .collect();
        people.insert(
            self.owner.to_hex(),
            self.profiles.person(&self.owner.to_hex()),
        );
        if let Some(messaging) = &self.messaging {
            for conversation in messaging.conversations() {
                people.insert(
                    conversation.id.clone(),
                    self.profiles.person(&conversation.id),
                );
            }
            for view in messaging.orders() {
                let order = view.order;
                for person in [order.buyer, order.seller].into_iter().chain(
                    order
                        .shipment
                        .stops
                        .into_iter()
                        .filter_map(|stop| stop.courier_pubkey),
                ) {
                    people
                        .entry(person.clone())
                        .or_insert_with(|| self.profiles.person(&person));
                }
            }
        }
        for listing in listings.iter_mut().chain(saved_listings.iter_mut()) {
            rates::project(
                listing,
                &self.rates,
                &self.settings.currency,
                listing::now(),
            );
            listing.image_url = listing.image_url.as_deref().and_then(|url| {
                image_proxy::image_url(url, &self.settings.image_proxy, 800, 800, false)
            });
        }
        for person in people.values_mut() {
            image_proxy::person(person, &self.settings.image_proxy);
        }
        let mut profile = self.profile.clone();
        if let Some(profile) = &mut profile {
            image_proxy::profile(profile, &self.settings.image_proxy);
        }
        // Keep all results in the snapshot: UI can offer a curated view without making hidden items inaccessible.
        Ok(Snapshot {
            exchange_rates: self.rates.snapshot(listing::now()),
            local_curation: self
                .local_curation
                .as_ref()
                .map(|pending| pending.batch.clone()),
            public_key: self.owner.to_hex(),
            can_sign: self.owner_keys.is_some(),
            ai_configured: self.ai_configured,
            profile_name_required: self.profile_name_required,
            messaging_ready: self
                .messaging
                .as_ref()
                .is_some_and(|messaging| messaging.can_send()),
            live_location_supported: false,
            demo: self.demo,
            status: self.status.clone(),
            error: self.error.clone(),
            ai_message: self.ai_message.clone(),
            ai_test_result: self.ai_test_result.clone(),
            query: self.query.clone(),
            side: self.side.clone(),
            ai_search: self.ai_search,
            sort: self.sort.clone(),
            people,
            revision: self.revision,
            listings,
            saved_count,
            saved_listings,
            settings: self.settings.clone(),
            conversations: self
                .messaging
                .as_ref()
                .map(|m| {
                    m.conversations()
                        .into_iter()
                        .map(|c| Conversation {
                            name: self.profiles.person(&c.id).name,
                            id: c.id,
                            messages: c
                                .messages
                                .into_iter()
                                .map(|m| Message {
                                    id: m.id,
                                    text: m.text,
                                    mine: m.mine,
                                    created_at: m.created_at,
                                    delivery: m.delivery,
                                    order_id: m.order_id,
                                    cashu: m.cashu,
                                })
                                .collect(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            orders: self
                .messaging
                .as_ref()
                .map(|m| m.orders())
                .unwrap_or_default(),
            invite: self.invite.clone(),
            profile,
            profile_listings: self
                .profile_listings
                .as_ref()
                .map(|feed| {
                    feed.snapshot(
                        &self.store,
                        &self.owner.to_hex(),
                        &self.settings.image_proxy,
                        &self.rates,
                        &self.settings.currency,
                    )
                })
                .transpose()?,
            graph_context_loaded: self.profiles.context_loaded,
        })
    }
}

pub struct Market {
    state: Arc<Mutex<State>>,
    runtime: Mutex<Option<Runtime>>,
    notify: Arc<Notify>,
    stopped: Arc<AtomicBool>,
}
impl Market {
    pub fn open(data_dir: &Path, secret: &str, demo: bool) -> Result<Self> {
        let keys = Keys::new(SecretKey::parse(secret).context("Invalid profile secret")?);
        Self::open_identity(
            data_dir,
            keys.public_key(),
            Some(keys.clone()),
            keys,
            None,
            demo,
        )
    }
    /// Only for a key just generated by this app, never an imported/existing owner.
    /// Persist the signed first roster and outbox before opening any network task.
    pub fn open_fresh(data_dir: &Path, secret: &str) -> Result<Self> {
        let keys = Keys::new(SecretKey::parse(secret).context("Invalid profile secret")?);
        std::fs::create_dir_all(data_dir)?;
        let mut store = store::Store::open(&data_dir.join("market.sqlite"))?;
        let authorization = if let Some(event) = store.initial_authorization()? {
            event.verify()?;
            anyhow::ensure!(
                event.pubkey == keys.public_key(),
                "Initial authorization belongs to a different profile"
            );
            event
        } else {
            anyhow::ensure!(
                !data_dir.join("private-messages/messages.sqlite3").exists(),
                "Existing profiles must use profile restoration"
            );
            let event = identity::prepare_registration(
                keys.public_key(),
                keys.public_key(),
                &[],
                listing::now(),
            )?
            .sign_with_keys(&keys)?;
            store.queue_initial_authorization(&event)?;
            event
        };
        drop(store);
        Self::open_identity(
            data_dir,
            keys.public_key(),
            Some(keys.clone()),
            keys,
            Some(authorization),
            false,
        )
    }
    pub fn open_identity(
        data_dir: &Path,
        owner: nostr::PublicKey,
        owner_keys: Option<Keys>,
        device_keys: Keys,
        authorization: Option<nostr::Event>,
        demo: bool,
    ) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        if owner_keys
            .as_ref()
            .is_some_and(|keys| keys.public_key() != owner)
        {
            bail!("The profile key does not match this profile");
        }
        let store = store::Store::open(&data_dir.join(if demo {
            "preview.sqlite"
        } else {
            "market.sqlite"
        }))?;
        let settings = store.settings()?;
        let rates = store.exchange_rates().unwrap_or_default();
        let ai_configured = store.ai_configured()?;
        let local_profile = store.profile_metadata(&owner.to_hex())?;
        let profile_name_required = !demo
            && owner_keys.is_some()
            && local_profile.is_none()
            && store
                .initial_authorization()?
                .is_some_and(|event| event.pubkey == owner);

        let mut messaging = if demo {
            None
        } else {
            Some(
                messaging::Messaging::open_identity(
                    data_dir,
                    owner,
                    owner_keys.clone(),
                    device_keys,
                    authorization.as_ref(),
                )
                .map_err(anyhow::Error::msg)?,
            )
        };
        if let Some(messaging) = messaging.as_mut()
            && let Some(contact) = messaging
                .registered_contact_event()
                .map_err(anyhow::Error::msg)?
        {
            store.queue_event(&contact)?;
        }
        let public_cache = if demo {
            None
        } else {
            public_cache::PublicEventCache::open(&data_dir.join("public-events.sqlite")).ok()
        };
        let mut profiles = profiles::Profiles::from_public_cache(public_cache.clone());
        if let Some(event) = local_profile {
            let _ = profiles.ingest_public(event);
        }
        let mut state = State {
            store,
            owner,
            owner_keys,
            settings,
            rates,
            ai_configured,
            profile_name_required,
            demo,
            query: String::new(),
            side: "all".into(),
            ai_search: false,
            sort: "suggested".into(),
            status: if demo {
                "Preview · sample listings"
            } else {
                "Connecting"
            }
            .into(),
            error: None,
            ai_message: None,
            ai_test_result: None,
            ai_test_token: None,
            ai_check: 0,
            revision: 0,
            messaging,
            invite: None,
            profiles,
            public_cache,
            profile: None,
            profile_request: 0,
            followers_request: 0,
            followers_cancel: None,
            local_curation: None,
            remote_ai_cancel: None,
            remote_ai_is_check: false,
            buying_request: 0,
            search_request: 0,
            profile_listings: None,
        };
        if demo {
            seed_preview(&mut state)?;
        }
        let state = Arc::new(Mutex::new(state));
        let notify = Arc::new(Notify::new());
        let stopped = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        if !demo {
            runtime.spawn(rates::run(state.clone(), stopped.clone()));
            runtime.spawn(network::run(state.clone(), notify.clone(), stopped.clone()));
            runtime.spawn(search_discovery::run(
                state.clone(),
                notify.clone(),
                stopped.clone(),
            ));
            runtime.spawn(network::run_private(
                state.clone(),
                notify.clone(),
                stopped.clone(),
            ));
        }
        if !demo {
            Self::spawn_profiles(&runtime, state.clone(), None);
        }
        Ok(Self {
            state,
            runtime: Mutex::new(Some(runtime)),
            notify,
            stopped,
        })
    }
    pub fn snapshot(&self) -> Result<String> {
        Ok(serde_json::to_string(
            &self.state.lock().unwrap().snapshot()?,
        )?)
    }
    pub fn command(&self, request: &str) -> Result<String> {
        if request.len() > 32768 {
            bail!("Request is too large");
        }
        let command: Command = serde_json::from_str(request).context("Invalid request")?;
        let outcome = self.apply(command);
        if let Err(error) = outcome {
            let mut state = self.state.lock().unwrap();
            state.error = Some(error.to_string());
            state.revision += 1;
            return Err(error);
        }
        self.snapshot()
    }
    fn apply(&self, command: Command) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            bail!("Profile is closed");
        }
        match command {
            Command::Curate { api_key } => return self.curate(&api_key, false, None, None, None),
            Command::CheckAi {
                api_key,
                test,
                expected,
                token,
                clear,
            } => {
                if let Some(token) = &token {
                    anyhow::ensure!(
                        !token.is_empty()
                            && token.len() <= 64
                            && token
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
                        "Invalid test token"
                    );
                }
                if clear {
                    let mut s = self.state.lock().unwrap();
                    if s.remote_ai_is_check {
                        s.cancel_remote_ai();
                    }
                    s.ai_test_token = token;
                    s.ai_test_result = None;
                    s.ai_message = None;
                    s.ai_check += 1;
                    s.revision += 1;
                    return Ok(());
                }
                return self.curate(&api_key, true, test, expected, token);
            }
            Command::Contact { author, listing_id } => return self.contact(&author, &listing_id),
            Command::AcceptInvite { invite } => return self.accept_invite(&invite),
            Command::LoadProfile { author } => return self.load_profile(Some(author)),
            Command::LoadProfileFollowers { author } => {
                return self.load_profile_followers(&author);
            }
            Command::CancelProfileFollowers { author } => {
                let author = nostr::PublicKey::parse(&author)?.to_hex();
                let mut s = self.state.lock().unwrap();
                if s.profile
                    .as_ref()
                    .is_some_and(|p| p.person.author == author)
                {
                    Self::cancel_followers(&mut s);
                    s.revision += 1;
                }
                return Ok(());
            }
            Command::LoadMoreProfileListings { author } => {
                return self.load_profile_listings(&author, true);
            }
            Command::CloseProfile { author } => {
                let mut s = self.state.lock().unwrap();
                if s.profile_listings
                    .as_ref()
                    .is_some_and(|feed| feed.author == author)
                {
                    if let Some(feed) = s.profile_listings.take() {
                        feed.cancel();
                    }
                    Self::cancel_followers(&mut s);
                    s.profile = None;
                    s.profile_request += 1;
                    s.revision += 1;
                }
                return Ok(());
            }
            Command::LoadContext => return self.load_profile(None),
            _ => {}
        }
        let mut s = self.state.lock().unwrap();
        s.error = None;
        match command {
            Command::BeginLocalCuration => local_ai::begin(&mut s)?,
            Command::ApplyLocalCuration { id, decisions } => {
                local_ai::apply(&mut s, &id, decisions)?
            }
            Command::CancelLocalCuration { id } => {
                if s.local_curation
                    .as_ref()
                    .is_some_and(|pending| pending.batch.id == id)
                {
                    s.local_curation = None;
                }
            }
            Command::SetFilter {
                query,
                side,
                ai_search,
            } => {
                if query.len() > 300 || !["all", "offer", "request"].contains(&side.as_str()) {
                    bail!("Invalid search");
                }
                // Search mode cannot bypass the durable provider opt-in. Native
                // clients separately gate platform model availability.
                let ai_search = ai_search && s.settings.ai.enabled;
                if s.query != query || s.ai_search != ai_search || s.side != side {
                    s.cancel_remote_ai();
                    s.local_curation = None;
                    s.store.clear_relevance()?;
                    if side == "request" {
                        s.buying_request += 1;
                        self.notify.notify_waiters();
                    }
                }
                s.query = query;
                s.side = side;
                s.ai_search = ai_search;
                // A submitted query may retrieve older public inventory even
                // when its local filter did not change (explicit retry).
                s.search_request = s.search_request.wrapping_add(1);
                self.notify.notify_waiters();
            }
            Command::SetSort { sort } => {
                if !["suggested", "newest"].contains(&sort.as_str()) {
                    bail!("Choose Suggested or Newest");
                }
                s.sort = sort;
            }
            Command::Save { id } => s.store.toggle_saved(&id)?,
            Command::UpdateProfile { name } => {
                anyhow::ensure!(!s.demo, "Leave Preview to create your profile");
                let name = name.trim();
                anyhow::ensure!(
                    !name.is_empty()
                        && name.chars().count() <= 100
                        && !name.chars().any(char::is_control),
                    "Enter a name of up to 100 characters"
                );
                let owner = s.owner.to_hex();
                let previous = s.profiles.metadata_event(&owner).cloned();
                anyhow::ensure!(
                    s.profile_name_required || previous.is_some(),
                    "Load your profile before editing its name"
                );
                let mut metadata = match &previous {
                    Some(event) => serde_json::from_str::<serde_json::Value>(&event.content)?
                        .as_object()
                        .cloned()
                        .context("Existing profile metadata cannot be edited")?,
                    None => serde_json::Map::new(),
                };
                metadata.insert("name".into(), name.into());
                metadata.insert("display_name".into(), name.into());
                let at = listing::now().max(
                    previous
                        .as_ref()
                        .map(|event| event.created_at.as_secs().saturating_add(1))
                        .unwrap_or(0),
                );
                anyhow::ensure!(
                    at <= listing::now() + 600,
                    "The latest profile date is ahead. Try again later"
                );
                let event = nostr::EventBuilder::new(
                    nostr::Kind::Metadata,
                    serde_json::to_string(&metadata)?,
                )
                .custom_created_at(nostr::Timestamp::from(at))
                .sign_with_keys(
                    s.owner_keys
                        .as_ref()
                        .context("Approve this change with your profile key")?,
                )?;
                s.store.queue_profile_metadata(&event)?;
                let _ = s.profiles.ingest_public(event);
                s.profile_name_required = false;
                s.status = "Profile saved".into();
                self.notify.notify_one();
            }
            Command::Publish { draft } => {
                if s.demo {
                    bail!("Leave Preview to publish your own listing");
                }
                let event = listing::build(
                    s.owner_keys
                        .as_ref()
                        .context("Approve listing signing with your profile key")?,
                    &draft,
                    &uuid::Uuid::new_v4().to_string(),
                    listing::now(),
                    false,
                )?;
                s.store.ingest(&event, listing::now(), true)?;
                let contact = s
                    .messaging
                    .as_mut()
                    .context("Private messaging unavailable")?
                    .public_contact_event()
                    .map_err(anyhow::Error::msg)?;
                s.store.queue_event(&contact)?;
                s.status = "Saved · publishing".into();
                self.notify.notify_waiters();
            }
            Command::Close { id } => {
                if s.demo {
                    bail!("Preview listings cannot be changed");
                }
                let previous = s.store.event(&id)?;
                if previous.pubkey != s.owner {
                    bail!("Only your own listings can be closed");
                }
                let l = listing::parse(&previous, listing::now())?;
                let identifier = id.split_once(':').context("Invalid listing")?.1;
                let event = listing::build(
                    s.owner_keys
                        .as_ref()
                        .context("Approve listing signing with your profile key")?,
                    &listing::draft_from(&l),
                    identifier,
                    listing::now().max(l.created_at + 1),
                    true,
                )?;
                s.store.ingest(&event, listing::now(), true)?;
                self.notify.notify_one();
            }
            Command::Refresh => {
                if !s.demo {
                    s.search_request = s.search_request.wrapping_add(1);
                    if s.side == "request" {
                        s.buying_request += 1;
                    }
                    s.status = "Refreshing".into();
                    self.notify.notify_waiters();
                }
            }
            Command::SetSettings { settings } => {
                network::validate_relays(&settings.relays)?;
                ai::validate(&settings.ai)?;
                image_proxy::validate(&settings.image_proxy)?;
                rates::validate_currency(&settings.currency)?;
                let changed_relays = s.settings.relays != settings.relays;
                s.store.save_settings(&settings)?;
                s.cancel_remote_ai();
                s.ai_message = None;
                s.ai_test_result = None;
                s.ai_test_token = None;
                s.ai_check += 1;
                s.ai_configured = true;
                s.local_curation = None;
                if !settings.ai.enabled {
                    s.ai_search = false;
                }
                s.settings = settings;
                s.status = "Settings saved".into();
                self.notify.notify_one();
                if changed_relays {
                    Self::cancel_followers(&mut s);
                    if let Some(feed) = s.profile_listings.take() {
                        feed.cancel();
                    }
                    s.profiles = profiles::Profiles::from_public_cache(s.public_cache.clone());
                    s.profile = None;
                    s.revision += 1;
                    drop(s);
                    return self.load_profile(None);
                }
            }
            Command::CreateInvite => {
                s.invite = Some(
                    s.messaging
                        .as_ref()
                        .context("Leave Preview to create an invitation")?
                        .invite()
                        .map_err(anyhow::Error::msg)?,
                );
            }
            Command::SendMessage { peer_id, text } => {
                s.messaging
                    .as_mut()
                    .context("Leave Preview to send messages")?
                    .send(&peer_id, &text)
                    .map_err(anyhow::Error::msg)?;
                self.notify.notify_waiters();
            }
            Command::RequestOrder {
                listing_id,
                quantity,
                note,
            } => {
                let event = s.store.event(&listing_id)?;
                let listing = listing::parse(&event, listing::now())?;
                s.messaging
                    .as_mut()
                    .context("Leave Preview to request an order")?
                    .request_order(&listing, quantity, &note)
                    .map_err(anyhow::Error::msg)?;
                self.notify.notify_waiters();
            }
            Command::UpdateOrder { order_id, patch } => {
                s.messaging
                    .as_mut()
                    .context("Private orders unavailable")?
                    .update_order(&order_id, patch)
                    .map_err(anyhow::Error::msg)?;
                self.notify.notify_waiters();
            }
            Command::ArchiveOrder { order_id, archived } => {
                s.messaging
                    .as_mut()
                    .context("Private orders unavailable")?
                    .archive_order(&order_id, archived)
                    .map_err(anyhow::Error::msg)?;
            }
            Command::Contact { .. }
            | Command::AcceptInvite { .. }
            | Command::LoadProfile { .. }
            | Command::LoadContext
            | Command::LoadProfileFollowers { .. }
            | Command::CancelProfileFollowers { .. }
            | Command::LoadMoreProfileListings { .. }
            | Command::CloseProfile { .. } => {
                unreachable!()
            }
            Command::Curate { .. } | Command::CheckAi { .. } => unreachable!(),
        }
        s.revision += 1;
        Ok(())
    }
    fn load_profile(&self, author: Option<String>) -> Result<()> {
        let author = author
            .map(|p| nostr::PublicKey::parse(&p).map(|p| p.to_hex()))
            .transpose()?;
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        if let Some(author) = &author {
            profile_listings::start(runtime, self.state.clone(), author, false)?;
        }
        Self::spawn_profiles(runtime, self.state.clone(), author);
        Ok(())
    }
    fn cancel_followers(state: &mut State) {
        state.followers_request += 1;
        if let Some(cancel) = state.followers_cancel.take() {
            cancel.notify_one();
        }
        if let Some(profile) = state.profile.as_mut() {
            profile.followers_loading = false;
        }
    }
    fn load_profile_followers(&self, author: &str) -> Result<()> {
        let author = nostr::PublicKey::parse(author)?.to_hex();
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        let (relays, cache, cancel, request) = {
            let mut s = self.state.lock().unwrap();
            anyhow::ensure!(!s.demo, "Followers are unavailable in offline preview");
            let profile = s.profile.as_ref().context("Open this profile first")?;
            anyhow::ensure!(profile.person.author == author, "This profile has changed");
            if profile.followers_loaded || profile.followers_loading {
                return Ok(());
            }
            Self::cancel_followers(&mut s);
            let cancel = Arc::new(Notify::new());
            s.followers_cancel = Some(cancel.clone());
            let profile = s.profile.as_mut().unwrap();
            profile.followers_loading = true;
            profile.followers_error = None;
            s.revision += 1;
            (
                s.settings.relays.clone(),
                s.profiles.clone(),
                cancel,
                s.followers_request,
            )
        };
        let state = self.state.clone();
        runtime.spawn(async move {
            let result = profiles::fetch_followers(relays, author.clone(), cache, cancel).await;
            let mut s = state.lock().unwrap();
            if s.followers_request != request
                || s.profile
                    .as_ref()
                    .is_none_or(|profile| profile.person.author != author)
            {
                return;
            }
            s.followers_cancel = None;
            match result {
                Ok(mut cache) => {
                    cache.retain_from(&s.profiles);
                    let previous = s.profile.as_ref().unwrap();
                    let mut profile = cache.profile(&author);
                    profile.loading = previous.loading;
                    profile.error = previous.error.clone();
                    profile.followers_loaded = true;
                    s.profiles = cache;
                    s.profile = Some(profile);
                }
                Err(_) => {
                    let profile = s.profile.as_mut().unwrap();
                    profile.followers_loading = false;
                    profile.followers_error =
                        Some("Could not refresh followers. Try again when connected.".into());
                }
            }
            s.revision += 1;
        });
        Ok(())
    }
    fn load_profile_listings(&self, author: &str, more: bool) -> Result<()> {
        let author = nostr::PublicKey::parse(author)?.to_hex();
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        profile_listings::start(runtime, self.state.clone(), &author, more)
    }
    fn spawn_profiles(runtime: &Runtime, state: Arc<Mutex<State>>, author: Option<String>) {
        let (relays, request, demo, public_cache) = {
            let mut s = state.lock().unwrap();
            s.profile_request += 1;
            Self::cancel_followers(&mut s);
            if let Some(author) = author.as_deref() {
                let mut profile = s.profiles.profile(author);
                profile.loading = !s.demo;
                if s.demo {
                    profile.error = Some("Profiles are unavailable in offline preview.".into());
                }
                s.profile = Some(profile);
            }
            s.revision += 1;
            (
                s.settings.relays.clone(),
                s.profile_request,
                s.demo,
                s.public_cache.clone(),
            )
        };
        if demo {
            return;
        }
        runtime.spawn(async move {
            let result = profiles::fetch_cached(relays, author.clone(), public_cache).await;
            let mut s = state.lock().unwrap();
            if s.profile_request != request {
                return;
            }
            match result {
                Ok(mut cache) => {
                    cache.retain_from(&s.profiles);
                    if let Some(author) = author {
                        let mut profile = cache.profile(&author);
                        if let Some(previous) = &s.profile {
                            profile.followers_loaded = previous.followers_loaded;
                            profile.followers_loading = previous.followers_loading;
                            profile.followers_error = previous.followers_error.clone();
                        }
                        s.profile = Some(profile);
                    }
                    s.profiles = cache;
                }
                Err(_) => {
                    if let Some(profile) = s.profile.as_mut() {
                        profile.loading = false;
                        profile.error = Some(
                            "Could not refresh this profile. Loaded connections may be incomplete."
                                .into(),
                        );
                    }
                }
            }
            s.revision += 1;
        });
    }
    fn contact(&self, author: &str, listing_id: &str) -> Result<()> {
        let author = nostr::PublicKey::parse(author)?;
        let relays = {
            let s = self.state.lock().unwrap();
            if s.demo {
                bail!("Leave Preview to contact someone");
            }
            let event = s.store.event(listing_id)?;
            if event.pubkey != author {
                bail!("Listing author does not match");
            }
            s.settings.relays.clone()
        };
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        let discovery = runtime.block_on(network::discover_contact(&relays, author))?;
        let mut s = self.state.lock().unwrap();
        let messaging = s
            .messaging
            .as_mut()
            .context("Private messaging unavailable")?;
        for event in &discovery.authorization {
            messaging
                .ingest_authorization(event)
                .map_err(anyhow::Error::msg)?;
        }
        let mut accepted = false;
        for event in &discovery.invitations {
            if messaging
                .accept_public_contact_event(event, &author.to_hex())
                .is_ok()
            {
                accepted = true;
            }
        }
        if !accepted {
            bail!("This person's device authorization could not be verified");
        }
        s.error = None;
        s.status = "Private conversation ready".into();
        s.revision += 1;
        self.notify.notify_waiters();
        Ok(())
    }
    fn accept_invite(&self, invite: &str) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        if s.demo {
            bail!("Leave Preview to connect");
        }
        let accepted = s
            .messaging
            .as_mut()
            .context("Private messaging unavailable")?
            .accept_invite_locally(invite)
            .map_err(anyhow::Error::msg)?;
        s.error = None;
        s.status = if accepted {
            "Private conversation ready"
        } else {
            "Invitation saved · waiting for device approval"
        }
        .into();
        s.revision += 1;
        self.notify.notify_waiters();
        Ok(())
    }

    fn curate(
        &self,
        key: &str,
        check: bool,
        sample: Option<ai::TestInput>,
        expected: Option<ai::TestProvider>,
        token: Option<String>,
    ) -> Result<()> {
        let (settings, original_settings, search, candidates, ai_check, cancel) = {
            let mut s = self.state.lock().unwrap();
            if check
                && sample.is_some()
                && (token
                    .as_ref()
                    .is_some_and(|value| s.ai_test_token.as_ref() != Some(value))
                    || expected
                        .as_ref()
                        .is_some_and(|value| !value.matches(&s.settings.ai)))
            {
                return Ok(());
            }
            if check && sample.is_some() && s.remote_ai_cancel.is_some() && !s.remote_ai_is_check {
                bail!("Stop the current search before testing.");
            }
            if check {
                s.ai_message = None;
                s.ai_test_result = None;
                if sample.is_none() {
                    s.error = None;
                }
                s.ai_check += 1;
                s.revision += 1;
            }
            if s.demo {
                bail!("Leave Preview to connect an AI provider");
            }
            if let Some(sample) = &sample {
                sample.validate()?;
                anyhow::ensure!(
                    !ai::is_local(&s.settings.ai),
                    "Use the on-device model in the native app"
                );
            }
            if !check && !s.settings.ai.enabled {
                bail!("Enable AI in settings first");
            }
            if !check && (!s.ai_search || s.query.trim().is_empty()) {
                bail!("Type what you are looking for in the search field");
            }
            let listings = if check {
                Vec::new()
            } else {
                s.snapshot()?.listings
            };
            let candidates = listings
                .into_iter()
                .filter(|l| l.relevance.is_none())
                .take(12)
                .map(|l| {
                    let event = s.store.event(&l.id)?;
                    Ok((l, event.id.to_hex()))
                })
                .collect::<Result<Vec<_>>>()?;
            let mut ai = s.settings.ai.clone();
            ai.interests = s.query.clone();
            if check {
                ai.enabled = true;
            }
            s.cancel_remote_ai();
            let cancel = Arc::new(Notify::new());
            s.remote_ai_cancel = Some(cancel.clone());
            s.remote_ai_is_check = check;
            (
                ai,
                s.settings.ai.clone(),
                (s.query.clone(), s.side.clone(), s.ai_search),
                candidates,
                s.ai_check,
                cancel,
            )
        };
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        if check {
            let started = std::time::Instant::now();
            let result = runtime.block_on(async {
                tokio::select! { biased;
                    _ = cancel.notified() => None,
                    result = async {
                        if let Some(sample) = &sample { ai::test(&settings,key,sample).await.map(Some) }
                        else { ai::probe(&settings,key).await.map(|()| None) }
                    } => Some(result)
                }
            });
            let Some(result) = result else {
                return Ok(());
            };
            let mut s = self.state.lock().unwrap();
            if s.settings.ai != original_settings
                || s.ai_check != ai_check
                || !s.remote_ai_current(&cancel)
            {
                return Ok(());
            }
            s.remote_ai_cancel = None;
            s.remote_ai_is_check = false;
            if sample.is_some() {
                s.ai_test_result = Some(ai::TestResult {
                    matched: result.as_ref().ok().copied().flatten(),
                    elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    provider: settings.provider.clone(),
                    model: settings.model.clone(),
                    error: result.is_err().then(|| {
                        "Test failed. Check the provider settings and try again.".to_owned()
                    }),
                });
                s.revision += 1;
                return Ok(());
            }
            match result {
                Ok(_) => {
                    let message = format!("Model connected · {} ms", started.elapsed().as_millis());
                    s.ai_message = Some(message.clone());
                    s.status = message;
                    s.error = None;
                }
                Err(_) => {
                    // Provider responses and validation errors may contain user
                    // input. Keep the durable UI result independent and generic.
                    let message =
                        "Connection test failed. Check the provider settings and try again."
                            .to_owned();
                    s.ai_message = Some(message.clone());
                    s.error = Some(message);
                }
            }
            s.revision += 1;
            return Ok(());
        }
        if settings.interests.trim().is_empty() {
            bail!("Type what you are looking for in the search field");
        }
        let mut count = 0;
        for (l, event_id) in candidates {
            let result = runtime.block_on(async {
                tokio::select! { biased; _ = cancel.notified() => None, result = ai::classify(&settings, key, &l) => Some(result) }
            });
            let Some(result) = result else {
                return Ok(());
            };
            let mut s = self.state.lock().unwrap();
            // A settings change invalidates in-flight decisions.
            if s.settings.ai != original_settings
                || (s.query.clone(), s.side.clone(), s.ai_search) != search
                || !s.remote_ai_current(&cancel)
            {
                return Ok(());
            }
            match result {
                Ok(decision) => {
                    s.store.relevance(&l.id, &event_id, &decision)?;
                    count += 1;
                }
                Err(error) => {
                    s.remote_ai_cancel = None;
                    s.error = Some(error.to_string());
                    s.status = "Curation paused · all listings remain available".into();
                    s.revision += 1;
                    return Ok(());
                }
            }
        }
        let mut s = self.state.lock().unwrap();
        if !s.remote_ai_current(&cancel) {
            return Ok(());
        }
        s.remote_ai_cancel = None;
        s.status = format!("Reviewed {count} listings");
        s.error = None;
        s.revision += 1;
        Ok(())
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.state.lock().unwrap().cancel_remote_ai();
        Self::cancel_followers(&mut self.state.lock().unwrap());
        self.notify.notify_waiters();
        if let Some(feed) = self.state.lock().unwrap().profile_listings.as_ref() {
            feed.cancel();
        }
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.shutdown_background();
        }
        // Release the private writer lock before opening another secure account.
        self.state.lock().unwrap().messaging = None;
    }
    pub fn ingest_event(&self, event: &nostr::Event) -> Result<bool> {
        let mut s = self.state.lock().unwrap();
        let changed = s.store.ingest(event, listing::now(), false)?;
        if changed {
            s.revision += 1;
        }
        Ok(changed)
    }
}
impl Drop for Market {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn generate_secret_key() -> String {
    Keys::generate().secret_key().to_secret_hex()
}

fn seed_preview(state: &mut State) -> Result<()> {
    let samples = [
        (
            "A little more green",
            "Large monstera, happy and healthy. Comes with its terracotta pot.",
            "offer",
            "24",
            "Home",
            "Helsinki",
        ),
        (
            "The everyday camera",
            "A well-loved mirrorless camera. Ready for its next adventure.",
            "offer",
            "280",
            "Photography",
            "Espoo",
        ),
        (
            "A ride across town",
            "Looking for someone to bring a small desk home this Saturday.",
            "request",
            "35",
            "Transport",
            "Helsinki",
        ),
        (
            "Music, everywhere",
            "Comfortable wireless headphones with the original case.",
            "offer",
            "85",
            "Electronics",
            "Tampere",
        ),
        (
            "Made for slow Sundays",
            "A comfortable reading chair in warm oak and woven fabric.",
            "offer",
            "120",
            "Home",
            "Turku",
        ),
        (
            "Your next city bike",
            "A simple city bicycle, recently serviced and ready to go.",
            "offer",
            "160",
            "Outdoors",
            "Helsinki",
        ),
        (
            "An extra pair of hands",
            "Need help putting together a bookshelf. Tools provided.",
            "request",
            "45",
            "Help",
            "Espoo",
        ),
        (
            "Coffee worth waking for",
            "Manual coffee grinder in excellent condition.",
            "offer",
            "40",
            "Home",
            "Helsinki",
        ),
    ];
    let preview_keys = Keys::new(SecretKey::from_slice(&[1u8; 32])?);
    for (i, (title, description, side, price, category, location)) in samples.iter().enumerate() {
        let d = Draft {
            title: (*title).into(),
            description: (*description).into(),
            side: (*side).into(),
            price: (*price).into(),
            currency: "EUR".into(),
            location: (*location).into(),
            category: (*category).into(),
            tags: Vec::new(),
            service_areas: None,
            image_url: None,
            expires_at: None,
        };
        let event = listing::build(
            &preview_keys,
            &d,
            &format!("preview-{i}"),
            listing::now() - i as u64 * 600,
            false,
        )?;
        state.store.ingest(&event, listing::now(), false)?;
    }
    Ok(())
}
