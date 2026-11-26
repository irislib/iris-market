//! Bounded, read-only public profiles. Relationship presentation adapts Iris Chat (MIT).
//! Copyright (c) 2026 lauri000; see IRIS_CHAT_LICENSE.txt for the adapted projection.
//! Signatures are verified here: the graph library itself does not authenticate events.
use crate::public_cache::PublicEventCache;
use anyhow::{Result, bail};
use nostr::{Event, Filter, JsonUtil, Kind, PublicKey};
use nostr_pubsub::{EventBus, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use nostr_social_graph::{NostrEvent, SocialGraph};
use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};

pub const DEFAULT_ROOT: &str = "336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b";
const MAX_FOLLOWS: usize = 4096;
const DISPLAY_LIMIT: usize = 256;
const MAX_EVENT_BYTES: usize = 1_048_576;
const MAX_CACHE_BYTES: usize = 8 * 1_048_576;

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub badge: Option<String>,
    pub follow_distance: Option<u32>,
    pub followed_by_friends: usize,
    pub description: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct Person {
    pub author: String,
    pub name: String,
    pub picture_url: Option<String>,
    pub connection: Connection,
}
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub person: Person,
    pub about: String,
    pub website: Option<String>,
    pub following: Vec<Person>,
    pub following_count: usize,
    pub following_loaded: bool,
    pub followers: Vec<Person>,
    pub followers_loaded: bool,
    pub followers_loading: bool,
    pub followers_error: Option<String>,
    pub followed_by_known: Vec<Person>,
    pub graph_root: String,
    pub graph_label: String,
    pub graph_context_loaded: bool,
    pub coverage: String,
    pub loading: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct Profiles {
    events: BTreeMap<(String, u16), Event>,
    event_sizes: std::collections::HashMap<(String, u16), usize>,
    graph: SocialGraph,
    viewer: Option<String>,
    home_graph: std::sync::OnceLock<std::sync::Arc<SocialGraph>>,
    bytes: usize,
    pub context_loaded: bool,
    public_cache: Option<PublicEventCache>,
    public_cache_revision: u64,
    next_expiration: Option<u64>,
}
impl Default for Profiles {
    fn default() -> Self {
        Self {
            events: BTreeMap::new(),
            event_sizes: std::collections::HashMap::new(),
            graph: SocialGraph::new(DEFAULT_ROOT),
            viewer: None,
            home_graph: Default::default(),
            bytes: 0,
            context_loaded: false,
            public_cache: None,
            public_cache_revision: 0,
            next_expiration: None,
        }
    }
}
impl Profiles {
    pub fn from_public_cache(public_cache: Option<PublicEventCache>) -> Self {
        let mut profiles = Self {
            public_cache,
            ..Self::default()
        };
        profiles.refresh_public_cache();
        profiles
    }
    pub(crate) fn next_expiration(&self) -> Option<u64> {
        self.next_expiration
    }
    /// Called once before a snapshot. Expiry/deletion can remove visible edges
    /// without a new relay reply, while signed authority remains on disk.
    pub fn refresh_public_cache(&mut self) {
        let backing = self.public_cache.clone();
        let revision = backing
            .as_ref()
            .map(PublicEventCache::revision)
            .unwrap_or(0);
        let now = crate::listing::now();
        if revision == self.public_cache_revision && self.next_expiration.is_none_or(|at| at > now)
        {
            return;
        }
        self.public_cache_revision = revision;
        let mut graph_dirty = false;
        self.events.retain(|key, event| {
            let keep = crate::public_cache::current(event, now)
                && backing
                    .as_ref()
                    .is_none_or(|cache| cache.permits(event).unwrap_or(false));
            if !keep {
                if let Some(size) = self.event_sizes.remove(key) {
                    self.bytes = self.bytes.saturating_sub(size);
                }
                if key.1 == 3 {
                    graph_dirty = true;
                } else if key.1 == 10000 {
                    self.home_graph.take();
                }
            }
            keep
        });
        if let Some(cache) = backing {
            for event in cache.profile_records(512).unwrap_or_default() {
                let kind = event.kind.as_u16();
                if matches!(self.ingest_inner(event, false, false), Ok(true)) && kind == 3 {
                    graph_dirty = true;
                }
            }
        }
        if graph_dirty {
            self.rebuild_graph();
        }
        self.context_loaded = self
            .events
            .get(&(DEFAULT_ROOT.into(), 3))
            .is_some_and(supported_contacts);
        self.next_expiration = self.events.values().filter_map(expiration).min();
    }
    fn sync_public_cache(&mut self, prev_revision: u64, has_deletion: bool) {
        // A cache writer may finish outside the State mutex while this batch
        // is being projected. Only acknowledge a revision after reading all
        // its records, including deletions from other discovery requests.
        let revision = self
            .public_cache
            .as_ref()
            .map(PublicEventCache::revision)
            .unwrap_or(0);
        if !has_deletion
            && revision == prev_revision
            && self.public_cache_revision == prev_revision
            && self
                .next_expiration
                .is_none_or(|at| at > crate::listing::now())
        {
            self.public_cache_revision = revision;
            self.context_loaded = self
                .events
                .get(&(DEFAULT_ROOT.into(), 3))
                .is_some_and(supported_contacts);
        } else {
            self.refresh_public_cache();
        }
    }
    /// Public discovery alone writes the public cache. Private-peer hydration
    /// may use ingest(), but cannot reveal its peer set through persistent indexes.
    pub fn ingest_public(&mut self, event: Event) -> Result<bool> {
        let prev_revision = self
            .public_cache
            .as_ref()
            .map(PublicEventCache::revision)
            .unwrap_or(0);
        if let Some(cache) = &self.public_cache {
            cache.ingest(&event)?;
        }
        let is_deletion = event.kind == Kind::EventDeletion;
        let accepted = if matches!(event.kind.as_u16(), 0 | 3) {
            self.ingest(event)?
        } else {
            false
        };
        self.sync_public_cache(prev_revision, is_deletion);
        Ok(accepted)
    }
    /// Ingest a batch of public records with one cache transaction and one graph rebuild.
    pub fn ingest_public_batch(&mut self, events: Vec<Event>) -> Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }
        let prev_revision = self
            .public_cache
            .as_ref()
            .map(PublicEventCache::revision)
            .unwrap_or(0);
        if let Some(cache) = &self.public_cache {
            cache.ingest_batch(&events)?;
        }
        let has_deletion = events.iter().any(|e| e.kind == Kind::EventDeletion);
        let accepted = self.ingest_batch(
            events
                .into_iter()
                .filter(|e| matches!(e.kind.as_u16(), 0 | 3)),
        );
        self.sync_public_cache(prev_revision, has_deletion);
        Ok(accepted)
    }
    pub fn metadata_event(&self, author: &str) -> Option<&Event> {
        self.events.get(&(author.into(), 0))
    }
    /// Winner checks preserve newer observations when independent profile requests finish.
    pub fn retain_from(&mut self, previous: &Self) {
        self.refresh_public_cache();
        self.ingest_batch(previous.events.values().cloned());
        self.context_loaded = self
            .events
            .get(&(DEFAULT_ROOT.into(), 3))
            .is_some_and(supported_contacts);
    }
    pub fn retain_metadata_from(&mut self, previous: &Self) {
        self.ingest_batch(
            previous
                .events
                .values()
                .filter(|event| event.kind == Kind::Metadata)
                .cloned(),
        );
    }
    /// Ingest multiple events, rebuilding the social graph at most once at the end.
    pub fn ingest_batch(&mut self, events: impl IntoIterator<Item = Event>) -> usize {
        let mut accepted = 0;
        let mut graph_dirty = false;
        for event in events {
            let kind = event.kind.as_u16();
            if matches!(self.ingest_inner(event, true, false), Ok(true)) {
                accepted += 1;
                if kind == 3 {
                    graph_dirty = true;
                }
            }
        }
        if graph_dirty {
            self.rebuild_graph();
        }
        accepted
    }
    pub fn ingest(&mut self, event: Event) -> Result<bool> {
        self.ingest_inner(event, true, true)
    }
    fn ingest_inner(&mut self, event: Event, verify: bool, rebuild: bool) -> Result<bool> {
        let kind = event.kind.as_u16();
        if ![0, 3, 10000].contains(&kind)
            || event.created_at.as_secs() > crate::listing::now() + 600
        {
            bail!("Invalid profile event");
        }
        let key = (event.pubkey.to_hex(), kind);
        let previous = self.events.get(&key);
        // An identical event already verified and stored in memory needs no
        // re-serialization or re-verification. Any modified field still verifies.
        if previous == Some(&event) {
            return Ok(false);
        }
        let size = event.as_json().len();
        if size > MAX_EVENT_BYTES {
            bail!("Profile event is too large");
        }
        if verify {
            event.verify()?;
        }
        if !crate::public_cache::current(&event, crate::listing::now())
            || self
                .public_cache
                .as_ref()
                .is_some_and(|cache| !cache.permits(&event).unwrap_or(false))
        {
            return Ok(false);
        }
        // Retain the signed winner even when its list cannot be projected.
        // Otherwise an older edge could regain a Home boost from the snapshot.
        let unsupported = kind != 0 && !supported_contacts(&event);
        if previous.is_some_and(|old| {
            old.created_at > event.created_at
                || old.created_at == event.created_at && old.id <= event.id
        }) {
            return Ok(false);
        }
        let old_size = self.event_sizes.get(&key).copied().unwrap_or(0);
        if self.bytes - old_size + size > MAX_CACHE_BYTES
            || previous.is_none() && self.events.len() >= 512
        {
            bail!("Profile cache is full");
        }
        self.bytes = self.bytes - old_size + size;
        if let Some(at) = expiration(&event) {
            self.next_expiration = Some(self.next_expiration.map_or(at, |old| old.min(at)));
        }
        self.event_sizes.insert(key.clone(), size);
        self.events.insert(key, event);
        if kind == 3 && rebuild {
            self.rebuild_graph();
        }
        if kind == 10000 {
            self.home_graph.take();
        }
        if unsupported {
            bail!("Public list is too large");
        }
        Ok(true)
    }
    pub(super) fn ingest_graph_list(&mut self, event: Event) -> Result<bool> {
        if let Some(cache) = &self.public_cache {
            cache.store_graph_list(&event)?;
        }
        self.ingest(event)
    }
    pub(crate) fn set_viewer(&mut self, viewer: String) {
        if self.viewer.as_ref() != Some(&viewer) {
            self.viewer = Some(viewer);
            self.home_graph.take();
        }
    }

    pub(super) fn home_root(&self) -> &str {
        self.viewer
            .as_deref()
            .filter(|viewer| !self.graph.get_followed_by_user(viewer).is_empty())
            .unwrap_or(DEFAULT_ROOT)
    }

    fn rebuild_graph(&mut self) {
        self.home_graph.take();
        let mut graph = SocialGraph::new(DEFAULT_ROOT);
        self.overlay_lists(&mut graph, false);
        self.graph = graph;
    }

    fn overlay_lists(&self, graph: &mut SocialGraph, discovery: bool) {
        for event in self
            .events
            .values()
            .filter(|e| e.kind == Kind::ContactList || discovery && e.kind == Kind::MuteList)
        {
            let kind = u32::from(event.kind.as_u16());
            let author = event.pubkey.to_hex();
            graph.handle_event(
                &NostrEvent {
                    created_at: event.created_at.as_secs(),
                    content: String::new(),
                    kind,
                    pubkey: event.pubkey.to_hex(),
                    id: event.id.to_hex(),
                    sig: event.sig.to_string(),
                    tags: if !supported_contacts(event) {
                        Vec::new()
                    } else {
                        event
                            .tags
                            .iter()
                            .filter_map(|tag| {
                                let parts = tag.as_slice();
                                (parts.first().is_some_and(|s| s == "p"))
                                    .then(|| parts.get(1))
                                    .flatten()
                                    .and_then(|p| PublicKey::from_hex(p).ok())
                                    .map(|p| vec!["p".into(), p.to_hex()])
                            })
                            .collect()
                    },
                },
                true,
                if discovery { f64::INFINITY } else { 1.0 },
            );
            if !supported_contacts(event)
                && graph
                    .get_list_revision(&author, kind)
                    .is_some_and(|r| r.id == event.id.to_hex())
            {
                graph.mark_list_incomplete(&author, kind);
            }
        }
    }
    pub(super) fn discovery_graph(&self) -> &std::sync::Arc<SocialGraph> {
        self.home_graph.get_or_init(|| {
            let root = self.home_root();
            let mut graph = if root == DEFAULT_ROOT {
                // Preserve list timestamps and completeness from the signed directory's projection.
                // This is a discovery seed. Profile and escrow evidence still requires verified bodies.
                static BASE: std::sync::LazyLock<std::sync::Arc<SocialGraph>> =
                    std::sync::LazyLock::new(|| {
                        std::sync::Arc::new(
                            SocialGraph::from_binary(
                                DEFAULT_ROOT,
                                include_bytes!("../../../web/src/data/social-graph.bin"),
                            )
                            .expect("pinned public graph"),
                        )
                    });
                if !self
                    .events
                    .values()
                    .any(|e| matches!(e.kind, Kind::ContactList | Kind::MuteList))
                {
                    return std::sync::Arc::clone(&BASE);
                }
                BASE.as_ref().clone()
            } else {
                SocialGraph::new(root)
            };
            self.overlay_lists(&mut graph, true);
            graph.recalculate_follow_distances();
            std::sync::Arc::new(graph)
        })
    }

    pub(crate) fn in_listing_network(&self, author: &str) -> bool {
        self.discovery_graph().get_follow_distance(author) < 1000
    }

    pub(crate) fn home_relation(&self, author: &str) -> (Option<u32>, usize) {
        let graph = self.discovery_graph();
        let distance = graph.get_follow_distance(author);
        let known = graph
            .get_followers_by_user(author)
            .iter()
            .filter(|p| graph.get_follow_distance(p) == 1)
            .count();
        ((distance < 1000).then_some(distance), known)
    }

    pub fn connection(&self, author: &str) -> Connection {
        let distance = self.graph.get_follow_distance(author);
        let known = self
            .graph
            .get_followers_by_user(author)
            .iter()
            .filter(|p| self.graph.get_follow_distance(p) == 1)
            .count();
        let badge = match distance {
            0 | 1 => Some("following"),
            2 if known > 10 => Some("trusted"),
            2 => Some("friend"),
            _ => None,
        };
        let description = match distance {
            0 => "Sirius Business · graph starting point".into(),
            1 => "Followed by Sirius Business".into(),
            _ if known > 0 => format!(
                "Followed by {known} {} in this network",
                if known == 1 { "person" } else { "people" }
            ),
            3..=999 => format!("{distance} connections from Sirius Business"),
            _ => "No connection found in loaded lists".into(),
        };
        Connection {
            badge: badge.map(str::to_owned),
            follow_distance: (distance < 1000).then_some(distance),
            followed_by_friends: known,
            description,
        }
    }
    fn metadata(&self, author: &str) -> serde_json::Value {
        self.events
            .get(&(author.into(), 0))
            .and_then(|e| serde_json::from_str(&e.content).ok())
            .unwrap_or_default()
    }
    fn display_name(metadata: &serde_json::Value) -> String {
        text(metadata, "display_name", 100)
            .or_else(|| text(metadata, "name", 100))
            .filter(|name| {
                !name.starts_with("npub1")
                    && !(name.len() == 64 && name.chars().all(|ch| ch.is_ascii_hexdigit()))
            })
            .unwrap_or_else(|| "Unnamed user".into())
    }

    pub(crate) fn escrow_candidates(
        &self,
        buyer: PublicKey,
        merchant: PublicKey,
        advertised: std::collections::BTreeSet<String>,
    ) -> Vec<serde_json::Value> {
        // Only verified, winning kind-3 events establish a direct follow.
        let follows = |author: PublicKey| -> std::collections::BTreeSet<String> {
            self.events
                .get(&(author.to_hex(), 3))
                .filter(|event| supported_contacts(event))
                .into_iter()
                .flat_map(|event| event.tags.public_keys().map(PublicKey::to_hex))
                .collect()
        };
        let mutual: std::collections::BTreeSet<_> = follows(buyer)
            .intersection(&follows(merchant))
            .cloned()
            .collect();
        let buyer = buyer.to_hex();
        let merchant = merchant.to_hex();
        advertised
            .union(&mutual)
            .filter(|key| **key != buyer && **key != merchant)
            .map(|key| {
                serde_json::json!({
                    "id": key, "name": Self::display_name(&self.metadata(key)),
                    "advertised": advertised.contains(key), "mutual": mutual.contains(key)
                })
            })
            .collect()
    }
    pub fn person(&self, author: &str) -> Person {
        let metadata = self.metadata(author);
        let name = Self::display_name(&metadata);
        Person {
            author: author.into(),
            name,
            picture_url: safe_url(&metadata, "picture"),
            connection: self.connection(author),
        }
    }
    pub fn profile(&self, author: &str) -> Profile {
        let follows = self.graph.get_followed_by_user(author);
        let mut followers = self.graph.get_followers_by_user(author);
        followers.sort_by_key(|p| (self.graph.get_follow_distance(p), p.clone()));
        let known: Vec<_> = followers
            .iter()
            .filter(|p| self.graph.get_follow_distance(p) == 1)
            .cloned()
            .collect();
        let metadata = self.metadata(author);
        Profile {
            person: self.person(author), about: text(&metadata, "about", 2000).unwrap_or_default(), website: safe_url(&metadata, "website"),
            following_count: follows.len(), following_loaded: self.events.get(&(author.into(), 3)).is_some_and(supported_contacts),
            following: follows.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            followers_loaded: false, followers_loading: false, followers_error: None,
            followers: followers.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            followed_by_known: known.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            graph_root: DEFAULT_ROOT.into(), graph_label: "Connections through Sirius Business".into(), graph_context_loaded: self.context_loaded,
            coverage: "Observed public lists · up to 32 network lists, 64 follower candidates and 256 displayed people. Not a complete follower count or identity verification.".into(), loading: false, error: None,
        }
    }
}
fn supported_contacts(event: &Event) -> bool {
    event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|s| s == "p"))
        .nth(MAX_FOLLOWS)
        .is_none()
}
fn expiration(event: &Event) -> Option<u64> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().is_some_and(|v| v == "expiration"))
        .and_then(|tag| tag.as_slice().get(1))
        .and_then(|value| value.parse().ok())
}
fn text(value: &serde_json::Value, field: &str, max: usize) -> Option<String> {
    value
        .get(field)?
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control() || *c == '\n')
                .take(max)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
}
fn safe_url(value: &serde_json::Value, field: &str) -> Option<String> {
    let raw = value.get(field)?.as_str()?;
    if raw.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

async fn query(
    bus: &RelayEventBus,
    public_cache: Option<&PublicEventCache>,
    filters: Vec<Filter>,
    limit: usize,
) -> Result<Vec<Event>> {
    let local = public_cache
        .map(|cache| cache.query_local(&filters, limit).unwrap_or_default())
        .unwrap_or_default();
    let report = match bus
        .query(filters.clone(), QueryOptions { limit: Some(limit) })
        .await
    {
        Ok(report) => report,
        Err(_) if !local.is_empty() => return Ok(local),
        Err(error) => return Err(error.into()),
    };
    let live: Vec<Event> = report
        .events
        .into_iter()
        .map(|q| q.event.into_event())
        .collect();
    if let Some(cache) = public_cache {
        // Deletions are queried only for already-observed public discovery
        // authors. This lane never sees inbox participants or device rosters.
        let mut authors: Vec<_> = live
            .iter()
            .chain(local.iter())
            .map(|event| event.pubkey)
            .collect();
        authors.sort();
        authors.dedup();
        authors.truncate(64);
        let mut batch = Vec::new();
        if !authors.is_empty()
            && let Ok(deletions) = bus
                .query(
                    vec![
                        Filter::new()
                            .kind(Kind::EventDeletion)
                            .authors(authors)
                            .limit(256),
                    ],
                    QueryOptions { limit: Some(256) },
                )
                .await
        {
            batch.extend(deletions.events.into_iter().map(|q| q.event.into_event()));
        }
        batch.extend(live.iter().cloned());
        let _ = cache.ingest_batch(&batch);
        if cache.disabled() {
            return Ok(Vec::new());
        }
        let mut result = cache.query_local(&filters, limit)?;
        for event in live {
            if cache.permits(&event)? && !result.iter().any(|old| old.id == event.id) {
                result.push(event);
            }
        }
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        result.truncate(limit);
        return Ok(result);
    }
    Ok(live)
}

fn retain_events(
    cache: &mut Profiles,
    events: Vec<Event>,
    authors: &[PublicKey],
    kind: Option<Kind>,
) {
    cache.ingest_batch(events.into_iter().filter(|event| {
        (authors.is_empty() || authors.contains(&event.pubkey))
            && kind.is_none_or(|k| k == event.kind)
    }));
}
/// Fresh bounded context avoids unbounded growth across profiles and stale filtered follower hits.
pub async fn fetch(relays: Vec<String>, author: Option<String>) -> Result<Profiles> {
    fetch_cached(relays, author, None).await
}
pub async fn fetch_cached(
    relays: Vec<String>,
    author: Option<String>,
    public_cache: Option<PublicEventCache>,
) -> Result<Profiles> {
    fetch_viewer_context(relays, author, public_cache, None).await
}
pub(crate) async fn fetch_viewer_context(
    relays: Vec<String>,
    author: Option<String>,
    public_cache: Option<PublicEventCache>,
    viewer: Option<PublicKey>,
) -> Result<Profiles> {
    if relays.is_empty() {
        bail!("Connect to a message server to load profiles");
    }
    let root = PublicKey::from_hex(DEFAULT_ROOT)?;
    let target = author.as_deref().map(PublicKey::parse).transpose()?;
    let mut owners = vec![root];
    if let Some(target) = target
        && target != root
    {
        owners.push(target);
    }
    if let Some(viewer) = viewer
        && !owners.contains(&viewer)
    {
        owners.push(viewer);
    }
    let bus = RelayEventBus::new(relays, Duration::from_secs(5)).await?;
    bus.client()
        .wait_for_connection(Duration::from_secs(4))
        .await;
    let result = async {
        let mut cache = Profiles::from_public_cache(public_cache.clone());
        if let Some(viewer) = viewer {
            cache.set_viewer(viewer.to_hex());
        }
        let initial = query(
            &bus,
            public_cache.as_ref(),
            vec![
                Filter::new()
                    .authors(owners.clone())
                    .kinds([Kind::Metadata, Kind::ContactList])
                    .limit(16),
            ],
            16,
        )
        .await?;
        retain_events(&mut cache, initial, &owners, None);
        cache.context_loaded = cache
            .events
            .get(&(DEFAULT_ROOT.into(), 3))
            .is_some_and(supported_contacts);
        let context: Vec<PublicKey> = cache
            .graph
            .get_followed_by_user(cache.home_root())
            .into_iter()
            .take(32)
            .filter_map(|p| PublicKey::from_hex(&p).ok())
            .collect();
        if target.is_some() && !context.is_empty() {
            let events = query(
                &bus,
                public_cache.as_ref(),
                vec![
                    Filter::new()
                        .authors(context.clone())
                        .kind(Kind::ContactList)
                        .limit(128),
                ],
                128,
            )
            .await?;
            retain_events(&mut cache, events, &context, Some(Kind::ContactList));
        }
        if let Some(target) = target {
            let profile = cache.profile(&target.to_hex());
            let mut people: Vec<PublicKey> = profile
                .followed_by_known
                .iter()
                .chain(profile.followers.iter())
                .chain(profile.following.iter())
                .filter_map(|p| PublicKey::from_hex(&p.author).ok())
                .collect();
            people.sort();
            people.dedup();
            people.truncate(64);
            if !people.is_empty() {
                let events = query(
                    &bus,
                    public_cache.as_ref(),
                    vec![
                        Filter::new()
                            .authors(people.clone())
                            .kind(Kind::Metadata)
                            .limit(128),
                    ],
                    128,
                )
                .await?;
                retain_events(&mut cache, events, &people, Some(Kind::Metadata));
            }
        }
        Ok(cache)
    }
    .await;
    bus.client().shutdown().await;
    result
}

/// Only the explicit Followers view starts inbound discovery. Cancellation also shuts its bus down.
pub async fn fetch_followers(
    relays: Vec<String>,
    author: String,
    mut cache: Profiles,
    cancel: std::sync::Arc<tokio::sync::Notify>,
) -> Result<Profiles> {
    if relays.is_empty() {
        bail!("Connect to a message server to load followers");
    }
    let target = PublicKey::from_hex(&author)?;
    let public_cache = cache.public_cache.clone();
    let bus = RelayEventBus::new(relays, Duration::from_secs(5)).await?;
    let work = async {
        bus.client()
            .wait_for_connection(Duration::from_secs(4))
            .await;
        let hits = query(
            &bus,
            public_cache.as_ref(),
            vec![
                Filter::new()
                    .kind(Kind::ContactList)
                    .pubkey(target)
                    .limit(64),
            ],
            64,
        )
        .await?;
        // A #p query can return a historical follow. Refresh each candidate's unfiltered
        // latest kind-3 list before admitting it, so an observed unfollow wins.
        let mut candidates: Vec<PublicKey> = hits
            .into_iter()
            .filter(|e| e.kind == Kind::ContactList && e.verify().is_ok())
            .map(|e| e.pubkey)
            .collect();
        candidates.sort();
        candidates.dedup();
        candidates.truncate(64);
        if !candidates.is_empty() {
            let events = query(
                &bus,
                public_cache.as_ref(),
                vec![
                    Filter::new()
                        .authors(candidates.clone())
                        .kind(Kind::ContactList)
                        .limit(256),
                ],
                256,
            )
            .await?;
            retain_events(&mut cache, events, &candidates, Some(Kind::ContactList));
        }

        let people: Vec<_> = cache
            .profile(&author)
            .followers
            .iter()
            .take(64)
            .filter_map(|person| PublicKey::from_hex(&person.author).ok())
            .collect();
        if !people.is_empty() {
            let events = query(
                &bus,
                public_cache.as_ref(),
                vec![
                    Filter::new()
                        .authors(people.clone())
                        .kind(Kind::Metadata)
                        .limit(128),
                ],
                128,
            )
            .await?;
            retain_events(&mut cache, events, &people, Some(Kind::Metadata));
        }
        Ok(cache)
    };
    let result = tokio::select! { biased; _ = cancel.notified() => Err(anyhow::anyhow!("Follower lookup cancelled")), result = work => result };
    bus.client().shutdown().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag, Timestamp};
    fn follows(keys: &Keys, users: &[PublicKey], at: u64) -> Event {
        EventBuilder::new(Kind::ContactList, "")
            .tags(users.iter().map(|p| Tag::public_key(*p)))
            .custom_created_at(Timestamp::from(at))
            .sign_with_keys(keys)
            .unwrap()
    }
    #[test]
    fn escrow_candidates_require_two_current_signed_follow_lists() {
        let buyer = Keys::generate();
        let merchant = Keys::generate();
        let agent = Keys::generate().public_key();
        let mut profiles = Profiles::default();
        let advertised = std::collections::BTreeSet::from([agent.to_hex()]);
        let candidates = |profiles: &Profiles| {
            profiles.escrow_candidates(
                buyer.public_key(),
                merchant.public_key(),
                advertised.clone(),
            )
        };
        profiles.ingest(follows(&buyer, &[agent], 100)).unwrap();
        assert_eq!(candidates(&profiles)[0]["advertised"], true);
        assert_eq!(candidates(&profiles)[0]["mutual"], false);
        profiles.ingest(follows(&merchant, &[agent], 101)).unwrap();
        assert_eq!(candidates(&profiles)[0]["mutual"], true);
        profiles.ingest(follows(&buyer, &[], 102)).unwrap();
        assert_eq!(candidates(&profiles)[0]["mutual"], false);
    }

    #[test]
    fn home_uses_personal_verified_follows_and_returns_to_discovery_when_cleared() {
        let viewer = Keys::generate();
        let friend = Keys::generate();
        let seller = Keys::generate();
        let mut profiles = Profiles::default();
        profiles.set_viewer(viewer.public_key().to_hex());
        let bundled = profiles.home_relation(DEFAULT_ROOT);
        assert_eq!(bundled.0, Some(0));
        profiles
            .ingest(follows(&viewer, &[friend.public_key()], 100))
            .unwrap();
        profiles
            .ingest(follows(&friend, &[seller.public_key()], 100))
            .unwrap();
        assert_eq!(
            profiles.home_relation(&friend.public_key().to_hex()),
            (Some(1), 0)
        );
        assert_eq!(
            profiles.home_relation(&seller.public_key().to_hex()),
            (Some(2), 1)
        );
        assert_eq!(profiles.home_relation(DEFAULT_ROOT).0, None);
        profiles.ingest(follows(&viewer, &[], 101)).unwrap();
        assert_eq!(profiles.home_relation(DEFAULT_ROOT), bundled);
    }
    #[test]
    fn verified_public_names_and_empty_lists_survive_offline_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("public.sqlite");
        let keys = Keys::generate();
        let other = Keys::generate();
        let persistent = PublicEventCache::open(&path).unwrap();
        let name = EventBuilder::new(Kind::Metadata, r#"{"name":"Cached Merchant"}"#)
            .sign_with_keys(&keys)
            .unwrap();
        persistent.ingest(&name).unwrap();
        persistent
            .ingest(&follows(&keys, &[other.public_key()], 100))
            .unwrap();
        persistent.ingest(&follows(&keys, &[], 101)).unwrap();
        drop(persistent);
        let persistent = PublicEventCache::open(&path).unwrap();
        let mut profiles = Profiles::from_public_cache(Some(persistent.clone()));
        assert_eq!(
            profiles.person(&keys.public_key().to_hex()).name,
            "Cached Merchant"
        );
        assert_eq!(
            profiles
                .profile(&keys.public_key().to_hex())
                .following_count,
            0
        );
        assert!(
            !profiles
                .ingest(follows(&keys, &[other.public_key()], 100))
                .unwrap()
        );
        let deletion = EventBuilder::new(Kind::EventDeletion, "")
            .tags([Tag::parse(["e", &name.id.to_hex()]).unwrap()])
            .custom_created_at(Timestamp::from(crate::listing::now() + 1))
            .sign_with_keys(&keys)
            .unwrap();
        persistent.ingest(&deletion).unwrap();
        profiles.refresh_public_cache();
        assert_eq!(
            profiles.person(&keys.public_key().to_hex()).name,
            "Unnamed user"
        );
        assert!(!profiles.ingest(name).unwrap());
    }
    #[test]
    fn signed_latest_list_replaces_edges_and_old_filtered_hit_cannot_restore_them() {
        let a = Keys::generate();
        let b = Keys::generate();
        let mut cache = Profiles::default();
        let old = follows(&a, &[b.public_key()], 100);
        assert!(cache.ingest(old.clone()).unwrap());
        assert_eq!(cache.profile(&b.public_key().to_hex()).followers.len(), 1);
        assert!(cache.ingest(follows(&a, &[], 101)).unwrap());
        assert!(!cache.ingest(old).unwrap());
        assert!(cache.profile(&b.public_key().to_hex()).followers.is_empty());
    }
    #[test]
    fn discovery_keeps_snapshot_revision_order_and_active_viewer_during_hydration() {
        let owner = Keys::generate();
        let friend = Keys::generate();
        let stranger = Keys::generate();
        let mut incoming = Profiles::default();
        let old = follows(&owner, &[stranger.public_key()], 70);
        let new = follows(&owner, &[friend.public_key()], 80);
        incoming.ingest(new.clone()).unwrap();
        let mut seed = SocialGraph::new(&owner.public_key().to_hex());
        incoming.overlay_lists(&mut seed, true);
        let mut local = Profiles::default();
        local.set_viewer(owner.public_key().to_hex());
        local.ingest(old.clone()).unwrap();
        local.overlay_lists(&mut seed, true);
        assert_eq!(
            seed.get_list_revision(&owner.public_key().to_hex(), 3)
                .unwrap()
                .id,
            new.id.to_hex()
        );
        assert!(!seed.is_following(
            &owner.public_key().to_hex(),
            &stranger.public_key().to_hex()
        ));
        local.retain_from(&incoming);
        assert_eq!(local.home_root(), owner.public_key().to_hex());
        assert!(local.in_listing_network(&friend.public_key().to_hex()));
        assert!(!local.in_listing_network(&stranger.public_key().to_hex()));
        // A verified body can supply the exact missing revision without clearing its timestamp.
        seed.mark_list_incomplete(&owner.public_key().to_hex(), 3);
        local.overlay_lists(&mut seed, true);
        assert!(
            seed.get_list_revision(&owner.public_key().to_hex(), 3)
                .unwrap()
                .complete
        );
    }

    #[test]
    fn public_mute_tags_survive_restart_without_replaying_the_mute_body() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("graph.sqlite");
        let owner = Keys::generate();
        let peer = Keys::generate();
        let private = Keys::generate();
        let event = EventBuilder::new(Kind::MuteList, private.public_key().to_hex())
            .tags([Tag::public_key(peer.public_key())])
            .sign_with_keys(&owner)
            .unwrap();
        {
            let mut profiles =
                Profiles::from_public_cache(Some(PublicEventCache::open(&path).unwrap()));
            profiles.ingest_graph_list(event.clone()).unwrap();
        }
        let cache = PublicEventCache::open(&path).unwrap();
        assert!(cache.authority().unwrap().is_empty());
        assert!(
            cache
                .query_local(&[Filter::new().ids([event.id])], 128)
                .unwrap()
                .is_empty()
        );
        let profiles = Profiles::from_public_cache(Some(cache));
        assert_eq!(
            profiles
                .discovery_graph()
                .get_muted_by_user(&owner.public_key().to_hex()),
            vec![peer.public_key().to_hex()]
        );
    }

    #[test]
    fn rejects_tampered_metadata_and_unsafe_profile_urls() {
        let keys = Keys::generate();
        let mut cache = Profiles::default();
        let mut event = EventBuilder::new(
            Kind::Metadata,
            r#"{"name":"Ada","picture":"javascript:alert(1)","website":"https://example.org"}"#,
        )
        .sign_with_keys(&keys)
        .unwrap();
        cache.ingest(event.clone()).unwrap();
        let profile = cache.profile(&keys.public_key().to_hex());
        assert_eq!(profile.person.name, "Ada");
        assert!(profile.person.picture_url.is_none());
        assert!(profile.website.is_some());
        event.content = "changed".into();
        assert!(cache.ingest(event).is_err());
        assert!(profile.person.connection.follow_distance.is_none());
    }
    #[test]
    fn same_timestamp_lowest_event_id_wins_independent_of_arrival_order() {
        let keys = Keys::generate();
        let other = Keys::generate();
        let a = follows(&keys, &[], 100);
        let b = follows(&keys, &[other.public_key()], 100);
        let mut forward = Profiles::default();
        let mut reverse = Profiles::default();
        forward.ingest(a.clone()).unwrap();
        forward.ingest(b.clone()).unwrap();
        reverse.ingest(b).unwrap();
        reverse.ingest(a).unwrap();
        assert_eq!(
            forward.profile(&keys.public_key().to_hex()).following_count,
            reverse.profile(&keys.public_key().to_hex()).following_count
        );
    }
    #[test]
    fn batch_ingest_matches_sequential_and_rejects_tampered_events() {
        let dir_seq = tempfile::tempdir().unwrap();
        let dir_batch = tempfile::tempdir().unwrap();
        let mut seq = Profiles::from_public_cache(Some(
            PublicEventCache::open(&dir_seq.path().join("public.sqlite")).unwrap(),
        ));
        let mut batch = Profiles::from_public_cache(Some(
            PublicEventCache::open(&dir_batch.path().join("public.sqlite")).unwrap(),
        ));
        let a = Keys::generate();
        let b = Keys::generate();
        let now = crate::listing::now();
        let meta_a = EventBuilder::new(Kind::Metadata, r#"{"name":"Alice"}"#)
            .custom_created_at(Timestamp::from(now - 5))
            .tags([Tag::parse(["expiration", &(now + 300).to_string()]).unwrap()])
            .sign_with_keys(&a)
            .unwrap();
        let meta_b = EventBuilder::new(Kind::Metadata, r#"{"name":"Bob"}"#)
            .custom_created_at(Timestamp::from(now - 5))
            .sign_with_keys(&b)
            .unwrap();
        let contacts_a = follows(&a, &[b.public_key()], now - 5);
        let del_b = EventBuilder::new(Kind::EventDeletion, "")
            .custom_created_at(Timestamp::from(now - 2))
            .tags([Tag::parse(["a", &format!("0:{}:", b.public_key().to_hex())]).unwrap()])
            .sign_with_keys(&b)
            .unwrap();
        let events = vec![meta_a.clone(), meta_a.clone(), meta_b, contacts_a, del_b];
        for ev in &events {
            seq.ingest_public(ev.clone()).unwrap();
        }
        batch.ingest_public_batch(events).unwrap();
        assert_eq!(
            batch.person(&a.public_key().to_hex()).name,
            seq.person(&a.public_key().to_hex()).name
        );
        assert_eq!(
            batch.person(&b.public_key().to_hex()).name,
            seq.person(&b.public_key().to_hex()).name
        );
        assert_eq!(
            batch.profile(&a.public_key().to_hex()).following_count,
            seq.profile(&a.public_key().to_hex()).following_count
        );
        assert_eq!(batch.next_expiration(), Some(now + 300));
        let mut tampered = meta_a;
        tampered.content = r#"{"name":"Eve"}"#.into();
        assert!(batch.ingest(tampered).is_err());
    }

    #[test]
    fn concurrent_public_deletion_is_not_acknowledged_without_projection() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        let mut profiles = Profiles::from_public_cache(Some(cache.clone()));
        let alice = Keys::generate();
        let bob = Keys::generate();
        let now = crate::listing::now();
        let metadata = |keys: &Keys, name: &str| {
            EventBuilder::new(Kind::Metadata, format!(r#"{{"name":"{name}"}}"#))
                .custom_created_at(Timestamp::from(now - 5))
                .sign_with_keys(keys)
                .unwrap()
        };
        profiles.ingest_public(metadata(&alice, "Alice")).unwrap();

        // Pause one ingest_public call between persistence and projection.
        let before_write = cache.revision();
        let bob_metadata = metadata(&bob, "Bob");
        cache.ingest(&bob_metadata).unwrap();
        // An independent public query persists Alice's signed deletion while
        // the first call still owns the application state lock.
        let deletion = EventBuilder::new(Kind::EventDeletion, "")
            .custom_created_at(Timestamp::from(now - 1))
            .tags([Tag::parse(["a", &format!("0:{}:", alice.public_key().to_hex())]).unwrap()])
            .sign_with_keys(&alice)
            .unwrap();
        cache.ingest(&deletion).unwrap();
        profiles.ingest(bob_metadata).unwrap();
        profiles.sync_public_cache(before_write, false);
        profiles.refresh_public_cache();

        assert!(
            profiles
                .metadata_event(&alice.public_key().to_hex())
                .is_none()
        );
        assert!(
            profiles
                .metadata_event(&bob.public_key().to_hex())
                .is_some()
        );
    }
}
