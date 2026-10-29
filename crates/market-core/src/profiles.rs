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
    graph: SocialGraph,
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
            graph: SocialGraph::new(DEFAULT_ROOT),
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
    /// Called once before a snapshot. Expiry/deletion can remove visible edges
    /// without a new relay reply, while signed authority remains on disk.
    pub fn refresh_public_cache(&mut self) {
        let backing = self.public_cache.clone();
        let revision = backing
            .as_ref()
            .map(PublicEventCache::revision)
            .unwrap_or(0);
        if revision == self.public_cache_revision
            && self
                .next_expiration
                .is_none_or(|at| at > crate::listing::now())
        {
            return;
        }
        self.public_cache_revision = revision;
        let before = self.events.len();
        self.events.retain(|_, event| {
            crate::public_cache::current(event, crate::listing::now())
                && backing
                    .as_ref()
                    .is_none_or(|cache| cache.permits(event).unwrap_or(false))
        });
        self.bytes = self
            .events
            .values()
            .map(|event| event.as_json().len())
            .sum();
        if before != self.events.len() {
            self.rebuild_graph();
        }
        if let Some(cache) = backing {
            for event in cache
                .query_local(
                    &[Filter::new().kinds([Kind::Metadata, Kind::ContactList])],
                    512,
                )
                .unwrap_or_default()
            {
                let _ = self.ingest(event);
            }
        }
        self.context_loaded = self.events.contains_key(&(DEFAULT_ROOT.into(), 3));
        self.next_expiration = self.events.values().filter_map(expiration).min();
    }
    /// Public discovery alone writes the public cache. Private-peer hydration
    /// may use ingest(), but cannot reveal its peer set through persistent indexes.
    pub fn ingest_public(&mut self, event: Event) -> Result<bool> {
        if let Some(cache) = &self.public_cache {
            cache.ingest(&event)?;
        }
        let accepted = if matches!(event.kind.as_u16(), 0 | 3) {
            self.ingest(event)?
        } else {
            false
        };
        self.refresh_public_cache();
        Ok(accepted)
    }
    pub fn metadata_event(&self, author: &str) -> Option<&Event> {
        self.events.get(&(author.into(), 0))
    }
    /// Winner checks preserve newer observations when independent profile requests finish.
    pub fn retain_from(&mut self, previous: &Self) {
        for event in previous.events.values() {
            let _ = self.ingest(event.clone());
        }
    }
    pub fn retain_metadata_from(&mut self, previous: &Self) {
        for event in previous
            .events
            .values()
            .filter(|event| event.kind == Kind::Metadata)
        {
            let _ = self.ingest(event.clone());
        }
    }
    pub fn ingest(&mut self, event: Event) -> Result<bool> {
        let kind = event.kind.as_u16();
        if ![0, 3].contains(&kind) || event.created_at.as_secs() > crate::listing::now() + 600 {
            bail!("Invalid profile event");
        }
        let size = event.as_json().len();
        if size > MAX_EVENT_BYTES {
            bail!("Profile event is too large");
        }
        event.verify()?;
        if !crate::public_cache::current(&event, crate::listing::now())
            || self
                .public_cache
                .as_ref()
                .is_some_and(|cache| !cache.permits(&event).unwrap_or(false))
        {
            return Ok(false);
        }
        if kind == 3
            && event
                .tags
                .iter()
                .filter(|t| t.as_slice().first().is_some_and(|v| v == "p"))
                .count()
                > MAX_FOLLOWS
        {
            bail!("Follow list is too large");
        }
        let key = (event.pubkey.to_hex(), kind);
        let previous = self.events.get(&key);
        if previous.is_some_and(|old| {
            old.created_at > event.created_at
                || old.created_at == event.created_at && old.id <= event.id
        }) {
            return Ok(false);
        }
        let old_size = previous.map(|e| e.as_json().len()).unwrap_or(0);
        if self.bytes - old_size + size > MAX_CACHE_BYTES
            || previous.is_none() && self.events.len() >= 512
        {
            bail!("Profile cache is full");
        }
        self.bytes = self.bytes - old_size + size;
        if let Some(at) = expiration(&event) {
            self.next_expiration = Some(self.next_expiration.map_or(at, |old| old.min(at)));
        }
        self.events.insert(key, event);
        if kind == 3 {
            self.rebuild_graph();
        }
        Ok(true)
    }
    fn rebuild_graph(&mut self) {
        self.graph = SocialGraph::new(DEFAULT_ROOT);
        for event in self.events.values().filter(|e| e.kind == Kind::ContactList) {
            self.graph.handle_event(
                &NostrEvent {
                    created_at: event.created_at.as_secs(),
                    content: String::new(),
                    kind: 3,
                    pubkey: event.pubkey.to_hex(),
                    id: event.id.to_hex(),
                    sig: event.sig.to_string(),
                    tags: event
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
                        .collect(),
                },
                true,
                1.0,
            );
        }
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
    pub fn person(&self, author: &str) -> Person {
        let metadata = self.metadata(author);
        let name = text(&metadata, "display_name", 100)
            .or_else(|| text(&metadata, "name", 100))
            .filter(|name| {
                !name.starts_with("npub1")
                    && !(name.len() == 64 && name.chars().all(|ch| ch.is_ascii_hexdigit()))
            })
            .unwrap_or_else(|| "Unnamed user".into());
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
            following_count: follows.len(), following_loaded: self.events.contains_key(&(author.into(), 3)),
            following: follows.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            followers_loaded: false, followers_loading: false, followers_error: None,
            followers: followers.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            followed_by_known: known.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            graph_root: DEFAULT_ROOT.into(), graph_label: "Connections through Sirius Business".into(), graph_context_loaded: self.context_loaded,
            coverage: "Observed public lists · up to 32 network lists, 64 follower candidates and 256 displayed people. Not a complete follower count or identity verification.".into(), loading: false, error: None,
        }
    }
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
            for event in deletions.events {
                let _ = cache.ingest(event.event.as_event());
            }
        }
        for event in &live {
            let _ = cache.ingest(event);
        }
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
    for event in events {
        if (authors.is_empty() || authors.contains(&event.pubkey))
            && kind.is_none_or(|k| k == event.kind)
        {
            let _ = cache.ingest(event);
        }
    }
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
    let bus = RelayEventBus::new(relays, Duration::from_secs(5)).await?;
    bus.client()
        .wait_for_connection(Duration::from_secs(4))
        .await;
    let result = async {
        let mut cache = Profiles::from_public_cache(public_cache.clone());
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
        cache.context_loaded = cache.events.contains_key(&(DEFAULT_ROOT.into(), 3));
        let context: Vec<PublicKey> = cache
            .graph
            .get_followed_by_user(DEFAULT_ROOT)
            .into_iter()
            .take(32)
            .filter_map(|p| PublicKey::from_hex(&p).ok())
            .collect();
        if !context.is_empty() {
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
}
