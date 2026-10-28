//! Bounded, read-only public profiles. Relationship presentation adapts Iris Chat (MIT).
//! Copyright (c) 2026 lauri000; see IRIS_CHAT_LICENSE.txt for the adapted projection.
//! Signatures are verified here: the graph library itself does not authenticate events.
use anyhow::{Result, bail};
use nostr::{Event, Filter, JsonUtil, Kind, PublicKey};
use nostr_pubsub::{EventBus, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use nostr_social_graph::{NostrEvent, SocialGraph};
use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};

pub const DEFAULT_ROOT: &str = "4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0";
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
}
impl Default for Profiles {
    fn default() -> Self {
        Self {
            events: BTreeMap::new(),
            graph: SocialGraph::new(DEFAULT_ROOT),
            bytes: 0,
            context_loaded: false,
        }
    }
}
impl Profiles {
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
            followers: followers.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            followed_by_known: known.into_iter().take(DISPLAY_LIMIT).map(|p| self.person(&p)).collect(),
            graph_root: DEFAULT_ROOT.into(), graph_label: "Connections through Sirius Business".into(), graph_context_loaded: self.context_loaded,
            coverage: "Observed public lists · up to 32 network lists, 64 follower candidates and 256 displayed people. Not a complete follower count or identity verification.".into(), loading: false, error: None,
        }
    }
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

async fn query(bus: &RelayEventBus, filters: Vec<Filter>, limit: usize) -> Result<Vec<Event>> {
    let report = bus
        .query(filters, QueryOptions { limit: Some(limit) })
        .await?;
    Ok(report
        .events
        .into_iter()
        .map(|q| q.event.into_event())
        .collect())
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
        let mut cache = Profiles::default();
        let initial = query(
            &bus,
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
            let hits = query(
                &bus,
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
