pub mod ai;
pub mod listing;
pub mod messaging;
pub mod model;
pub mod network;
pub mod store;

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
    keys: Keys,
    settings: Settings,
    demo: bool,
    query: String,
    side: String,
    status: String,
    error: Option<String>,
    revision: u64,
    messaging: Option<messaging::Messaging>,
    invite: Option<String>,
}
impl State {
    fn snapshot(&self) -> Result<Snapshot> {
        let mut listings = self
            .store
            .listings(&self.keys.public_key().to_hex(), listing::now())?;
        let saved_count = listings.iter().filter(|l| l.saved).count();
        let query = self.query.to_lowercase();
        listings.retain(|l| {
            (self.side == "all" || l.side == self.side)
                && (query.is_empty()
                    || format!(
                        "{} {} {} {}",
                        l.title, l.description, l.location, l.category
                    )
                    .to_lowercase()
                    .contains(&query))
        });
        // Keep all results in the snapshot: UI can offer a curated view without making hidden items inaccessible.
        Ok(Snapshot {
            public_key: self.keys.public_key().to_hex(),
            demo: self.demo,
            status: self.status.clone(),
            error: self.error.clone(),
            query: self.query.clone(),
            side: self.side.clone(),
            revision: self.revision,
            listings,
            saved_count,
            settings: self.settings.clone(),
            conversations: self
                .messaging
                .as_ref()
                .map(|m| {
                    m.conversations()
                        .into_iter()
                        .map(|c| Conversation {
                            id: c.id,
                            name: c.name,
                            messages: c
                                .messages
                                .into_iter()
                                .map(|m| Message {
                                    id: m.id,
                                    text: m.text,
                                    mine: m.mine,
                                    created_at: m.created_at,
                                    delivery: m.delivery,
                                })
                                .collect(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            invite: self.invite.clone(),
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
        std::fs::create_dir_all(data_dir)?;
        let keys = Keys::new(SecretKey::parse(secret).context("Invalid account secret")?);
        let store = store::Store::open(&data_dir.join(if demo {
            "preview.sqlite"
        } else {
            "market.sqlite"
        }))?;
        let settings = store.settings()?;
        let messaging = if demo {
            None
        } else {
            Some(messaging::Messaging::open(data_dir, keys.clone()).map_err(anyhow::Error::msg)?)
        };
        let mut state = State {
            store,
            keys,
            settings,
            demo,
            query: String::new(),
            side: "all".into(),
            status: if demo {
                "Preview · sample listings"
            } else {
                "Connecting"
            }
            .into(),
            error: None,
            revision: 0,
            messaging,
            invite: None,
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
            runtime.spawn(network::run(state.clone(), notify.clone(), stopped.clone()));
            runtime.spawn(network::run_private(
                state.clone(),
                notify.clone(),
                stopped.clone(),
            ));
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
        match command {
            Command::Curate { api_key } => return self.curate(&api_key, false),
            Command::CheckAi { api_key } => return self.curate(&api_key, true),
            Command::Contact { author, listing_id } => return self.contact(&author, &listing_id),
            _ => {}
        }
        let mut s = self.state.lock().unwrap();
        s.error = None;
        match command {
            Command::SetFilter { query, side } => {
                if query.len() > 300 || !["all", "offer", "request"].contains(&side.as_str()) {
                    bail!("Invalid search");
                }
                s.query = query;
                s.side = side;
            }
            Command::Save { id } => s.store.toggle_saved(&id)?,
            Command::Publish { draft } => {
                if s.demo {
                    bail!("Leave Preview to publish your own listing");
                }
                let event = listing::build(
                    &s.keys,
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
                if previous.pubkey != s.keys.public_key() {
                    bail!("Only your own listings can be closed");
                }
                let l = listing::parse(&previous, listing::now())?;
                let identifier = id.split_once(':').context("Invalid listing")?.1;
                let event = listing::build(
                    &s.keys,
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
                    s.status = "Refreshing".into();
                    self.notify.notify_one();
                }
            }
            Command::SetSettings { settings } => {
                network::validate_relays(&settings.relays)?;
                ai::validate(&settings.ai)?;
                s.store.save_settings(&settings)?;
                s.settings = settings;
                s.status = "Settings saved".into();
                self.notify.notify_one();
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
            Command::AcceptInvite { invite } => {
                s.messaging
                    .as_mut()
                    .context("Leave Preview to connect")?
                    .accept_invite(&invite)
                    .map_err(anyhow::Error::msg)?;
                self.notify.notify_waiters();
            }
            Command::SendMessage { peer_id, text } => {
                s.messaging
                    .as_mut()
                    .context("Leave Preview to send messages")?
                    .send(&peer_id, &text)
                    .map_err(anyhow::Error::msg)?;
                self.notify.notify_waiters();
            }
            Command::Contact { .. } => unreachable!(),
            Command::Curate { .. } | Command::CheckAi { .. } => unreachable!(),
        }
        s.revision += 1;
        Ok(())
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
        let event = runtime.block_on(network::discover_contact(&relays, author))?;
        let mut s = self.state.lock().unwrap();
        s.messaging
            .as_mut()
            .context("Private messaging unavailable")?
            .accept_public_contact_event(&event, &author.to_hex())
            .map_err(anyhow::Error::msg)?;
        s.error = None;
        s.status = "Private conversation ready".into();
        s.revision += 1;
        self.notify.notify_waiters();
        Ok(())
    }
    fn curate(&self, key: &str, check: bool) -> Result<()> {
        let (settings, candidates) = {
            let s = self.state.lock().unwrap();
            if s.demo {
                bail!("Leave Preview to connect an AI provider");
            }
            let listings = s
                .store
                .listings(&s.keys.public_key().to_hex(), listing::now())?;
            let candidates = listings
                .into_iter()
                .take(12)
                .map(|l| {
                    let event = s.store.event(&l.id)?;
                    Ok((l, event.id.to_hex()))
                })
                .collect::<Result<Vec<_>>>()?;
            (s.settings.ai.clone(), candidates)
        };
        let runtime = self.runtime.lock().unwrap();
        let runtime = runtime.as_ref().context("App has closed")?;
        if check {
            runtime.block_on(ai::ask(
                &settings,
                key,
                "Reply with exactly OK. This is a connection test.",
                "Connection test",
            ))?;
            let mut s = self.state.lock().unwrap();
            s.status = "Model connected".into();
            s.error = None;
            s.revision += 1;
            return Ok(());
        }
        if settings.interests.trim().is_empty() {
            bail!("Add your interests in AI settings first");
        }
        let mut count = 0;
        for (l, event_id) in candidates {
            let result = runtime.block_on(ai::classify(&settings, key, &l));
            let mut s = self.state.lock().unwrap();
            // A settings change invalidates in-flight decisions.
            if s.settings.ai != settings {
                break;
            }
            match result {
                Ok(decision) => {
                    s.store.relevance(&l.id, &event_id, &decision)?;
                    count += 1;
                }
                Err(error) => {
                    s.error = Some(error.to_string());
                    s.status = "Curation paused · all listings remain available".into();
                    s.revision += 1;
                    return Ok(());
                }
            }
        }
        let mut s = self.state.lock().unwrap();
        s.status = format!("Reviewed {count} listings");
        s.error = None;
        s.revision += 1;
        Ok(())
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.notify.notify_waiters();
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.shutdown_background();
        }
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
