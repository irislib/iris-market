//! Bounded, verified public profile records. Never a private inbox or outbox.
//! Signed inactive winners are retained as authority; capacity never evicts them.
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use fs2::FileExt;
use nostr::{Event, Filter, JsonUtil};
use nostr_pubsub::{
    EventBus, EventSource, MatchEventOptions, PublishReport, PubsubError, QueryEvent, QueryOptions,
    QueryReport, SOURCE_PRIORITY_LOCAL_INDEX, VerifiedEvent,
};
use rusqlite::{Connection, params};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

pub const MAX_PUBLIC_CACHE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PUBLIC_CACHE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 1024 * 1024;
const MAX_COORDINATES: usize = 512;
const MAX_DELETIONS: usize = 256;

#[derive(Clone)]
pub struct PublicEventCache {
    inner: Arc<Mutex<Cache>>,
}
struct Cache {
    db: Connection,
    guard: File,
    events: BTreeMap<String, Event>,
    disabled: bool,
    revision: u64,
}

fn coordinate(event: &Event) -> Option<String> {
    matches!(event.kind.as_u16(), 0 | 3)
        .then(|| format!("{}:{}:", event.kind.as_u16(), event.pubkey))
}
fn supersedes(a: &Event, b: &Event) -> bool {
    a.created_at > b.created_at || a.created_at == b.created_at && a.id < b.id
}
fn validate(event: &Event) -> Result<()> {
    if !matches!(event.kind.as_u16(), 0 | 3 | 5)
        || event.as_json().len() > MAX_EVENT_BYTES
        || event.created_at.as_secs() > crate::listing::now().saturating_add(300)
    {
        bail!("Record is outside public profile storage");
    }
    event.verify()?;
    Ok(())
}
pub(crate) fn current(event: &Event, now: u64) -> bool {
    let expirations: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == "expiration"))
        .collect();
    expirations.is_empty()
        || expirations.len() == 1
            && expirations[0]
                .as_slice()
                .get(1)
                .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|v| v.parse::<u64>().ok())
                .is_some_and(|at| at > now)
}
fn deletes(deletion: &Event, event: &Event) -> bool {
    if deletion.kind.as_u16() != 5
        || deletion.pubkey != event.pubkey
        || deletion.created_at < event.created_at
        || event.kind.as_u16() == 5
    {
        return false;
    }
    let id = event.id.to_hex();
    let key = coordinate(event);
    deletion.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.len() >= 2
            && ((values[0] == "e" && values[1] == id)
                || (values[0] == "a" && key.as_deref() == Some(values[1].as_str())))
    })
}
fn allows(events: &BTreeMap<String, Event>, event: &Event, now: u64) -> bool {
    current(event, now)
        && !events.values().any(|old| {
            deletes(old, event)
                || coordinate(event).is_some_and(|key| {
                    coordinate(old).as_ref() == Some(&key) && supersedes(old, event)
                })
        })
}
fn mark(guard: &mut File, pending: bool) -> Result<()> {
    guard.seek(SeekFrom::Start(0))?;
    guard.write_all(if pending { b"1" } else { b"0" })?;
    guard.sync_all()?;
    Ok(())
}
impl PublicEventCache {
    /// One local profile owns the path. The fixed-size guard also holds the writer
    /// lease. A crash or failed commit leaves it set, suppressing stale replay.
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path.parent().context("Public cache needs a directory")?;
        std::fs::create_dir_all(parent)?;
        let mut guard_path = path.as_os_str().to_os_string();
        guard_path.push(".guard");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut guard = options.open(guard_path)?;
        guard
            .try_lock_exclusive()
            .context("Public cache is already open")?;
        let existing_db = path.exists();
        let mut byte = *b"1";
        let fresh_guard = guard.metadata()?.len() == 0;
        if fresh_guard {
            mark(&mut guard, existing_db)?;
            File::open(parent)?.sync_all()?;
            byte[0] = if existing_db { b'1' } else { b'0' };
        } else {
            guard.read_exact(&mut byte)?;
        }
        if existing_db && std::fs::metadata(path)?.len() > MAX_PUBLIC_CACHE_FILE_BYTES {
            mark(&mut guard, true)?;
            bail!("Public cache exceeds its file limit");
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_millis(100))?;
        db.execute_batch("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            PRAGMA journal_size_limit=0; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA max_page_count=4096;
            CREATE TABLE IF NOT EXISTS public_events (id TEXT PRIMARY KEY, coordinate TEXT UNIQUE, raw TEXT NOT NULL);")?;
        let page_size: u64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        let max_pages: u64 = db.query_row("PRAGMA max_page_count", [], |r| r.get(0))?;
        if page_size != 4096 || max_pages > 4096 {
            mark(&mut guard, true)?;
            bail!("Public cache has an unsupported page budget");
        }
        let mut cache = Cache {
            db,
            guard,
            events: BTreeMap::new(),
            disabled: byte[0] != b'0',
            revision: 1,
        };
        if !cache.disabled {
            let loaded = (|| -> Result<BTreeMap<String, Event>> {
                let mut statement = cache
                    .db
                    .prepare("SELECT id,coordinate,raw FROM public_events LIMIT 769")?;
                let rows = statement.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?;
                let mut events = BTreeMap::new();
                let mut coordinates = 0;
                let mut deletion_count = 0;
                let mut bytes = 0;
                for row in rows {
                    let (id, key, raw) = row?;
                    bytes += raw.len();
                    if raw.len() > MAX_EVENT_BYTES || bytes > MAX_PUBLIC_CACHE_BYTES {
                        bail!("Public cache exceeds its byte budget");
                    }
                    let event = Event::from_json(raw)?;
                    validate(&event)?;
                    if event.id.to_hex() != id || coordinate(&event) != key {
                        bail!("Public cache row does not match its signature");
                    }
                    if key.is_some() {
                        coordinates += 1;
                    } else {
                        deletion_count += 1;
                    }
                    if coordinates > MAX_COORDINATES || deletion_count > MAX_DELETIONS {
                        bail!("Public cache exceeds its record budget");
                    }
                    events.insert(id, event);
                }
                Ok(events)
            })();
            match loaded {
                Ok(events) => cache.events = events,
                Err(_) => {
                    cache.disabled = true;
                    mark(&mut cache.guard, true)?;
                }
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(cache)),
        })
    }
    pub fn revision(&self) -> u64 {
        self.inner
            .lock()
            .map(|cache| cache.revision)
            .unwrap_or(u64::MAX)
    }
    pub fn disabled(&self) -> bool {
        self.inner.lock().map(|c| c.disabled).unwrap_or(true)
    }
    /// Includes inactive signed winners and deletion proofs, for reducers which
    /// must reconcile an already-visible record. Never contains private kinds.
    pub fn authority(&self) -> Result<Vec<Event>> {
        let cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        if cache.disabled {
            return Ok(Vec::new());
        }
        Ok(cache.events.values().cloned().collect())
    }
    pub fn permits(&self, event: &Event) -> Result<bool> {
        let cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        Ok(!cache.disabled && allows(&cache.events, event, crate::listing::now()))
    }
    pub fn ingest(&self, event: &Event) -> Result<bool> {
        validate(event)?;
        let mut cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        if cache.disabled {
            bail!("Public cache is unavailable");
        }
        let id = event.id.to_hex();
        if cache.events.contains_key(&id) {
            return Ok(false);
        }
        let key = coordinate(event);
        let previous = key
            .as_ref()
            .and_then(|key| {
                cache
                    .events
                    .values()
                    .find(|old| coordinate(old).as_ref() == Some(key))
            })
            .cloned();
        if previous.as_ref().is_some_and(|old| !supersedes(event, old)) {
            return Ok(false);
        }
        let known = previous.is_some() || cache.events.values().any(|old| deletes(event, old));
        let ordinary = cache
            .events
            .values()
            .filter(|e| coordinate(e).is_some())
            .count();
        let deletion_count = cache.events.len() - ordinary;
        let total: usize = cache.events.values().map(|e| e.as_json().len()).sum();
        let fits = (key.is_none() || previous.is_some() || ordinary < MAX_COORDINATES)
            && (key.is_some() || deletion_count < MAX_DELETIONS)
            && total - previous.as_ref().map(|e| e.as_json().len()).unwrap_or(0)
                + event.as_json().len()
                <= MAX_PUBLIC_CACHE_BYTES;
        if !fits {
            if known {
                cache.disabled = true;
                cache.revision = cache.revision.saturating_add(1);
                mark(&mut cache.guard, true)?;
                bail!("Public cache is full; cached replay was paused");
            }
            return Ok(false);
        }
        // A fixed, already allocated byte can be dirtied even when SQLite has
        // reached its page limit. It is cleared only after the durable commit.
        cache.disabled = true;
        cache.revision = cache.revision.saturating_add(1);
        mark(&mut cache.guard, true)?;
        let transaction = cache.db.transaction()?;
        if let Some(old) = previous {
            transaction.execute("DELETE FROM public_events WHERE id=?1", [old.id.to_hex()])?;
        }
        transaction.execute(
            "INSERT INTO public_events(id,coordinate,raw) VALUES (?1,?2,?3)",
            params![id, key, event.as_json()],
        )?;
        transaction.commit()?;
        mark(&mut cache.guard, false)?;
        cache
            .events
            .retain(|_, old| key.is_none() || coordinate(old) != key);
        cache.events.insert(id, event.clone());
        cache.disabled = false;
        Ok(true)
    }
    pub fn query_local(&self, filters: &[Filter], limit: usize) -> Result<Vec<Event>> {
        if filters.len() > 64 {
            bail!("Public cache query exceeds its filter budget");
        }
        let cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        if cache.disabled {
            return Ok(Vec::new());
        }
        let mut events: Vec<_> = cache
            .events
            .values()
            .filter(|event| allows(&cache.events, event, crate::listing::now()))
            .cloned()
            .collect();
        events.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        let defaults = [Filter::new()];
        let filters = if filters.is_empty() {
            &defaults[..]
        } else {
            filters
        };
        let mut selected = std::collections::HashSet::new();
        for filter in filters {
            for event in events
                .iter()
                .filter(|e| filter.match_event(e, MatchEventOptions::new()))
                .take(filter.limit.unwrap_or(usize::MAX))
            {
                selected.insert(event.id);
            }
        }
        Ok(events
            .into_iter()
            .filter(|e| selected.contains(&e.id))
            .take(limit.min(MAX_COORDINATES + MAX_DELETIONS))
            .collect())
    }
}
fn storage(error: impl std::fmt::Display) -> PubsubError {
    PubsubError::Storage(error.to_string())
}
#[async_trait]
impl EventBus for PublicEventCache {
    async fn publish(
        &self,
        event: VerifiedEvent,
        _source: EventSource,
    ) -> nostr_pubsub::Result<PublishReport> {
        let cache = self.clone();
        let accepted = tokio::task::spawn_blocking(move || cache.ingest(event.as_event()))
            .await
            .map_err(storage)?
            .map_err(storage)?;
        Ok(PublishReport {
            accepted,
            priority: SOURCE_PRIORITY_LOCAL_INDEX,
            reason: (!accepted).then(|| "Public record unchanged or outside cache capacity".into()),
        })
    }
    async fn query(
        &self,
        filters: Vec<Filter>,
        options: QueryOptions,
    ) -> nostr_pubsub::Result<QueryReport> {
        let cache = self.clone();
        let events = tokio::task::spawn_blocking(move || {
            cache.query_local(
                &filters,
                options.limit.unwrap_or(MAX_COORDINATES + MAX_DELETIONS),
            )
        })
        .await
        .map_err(storage)?
        .map_err(storage)?;
        Ok(QueryReport {
            events: events
                .into_iter()
                .map(|event| {
                    Ok(QueryEvent {
                        event: VerifiedEvent::try_from(event)?,
                        source: EventSource::local_index("market-public-profiles"),
                        priority: SOURCE_PRIORITY_LOCAL_INDEX,
                    })
                })
                .collect::<nostr_pubsub::Result<_>>()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    fn signed(keys: &Keys, kind: u16, at: u64, content: &str, tags: Vec<Vec<String>>) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .custom_created_at(Timestamp::from(at))
            .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
            .sign_with_keys(keys)
            .unwrap()
    }
    fn db() -> (tempfile::TempDir, PublicEventCache) {
        let dir = tempfile::tempdir().unwrap();
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        (dir, cache)
    }
    #[test]
    fn reloads_verified_records_and_retains_expired_winner() {
        let (dir, cache) = db();
        let keys = Keys::generate();
        let at = crate::listing::now() - 100;
        let old = signed(&keys, 0, at, "{\"name\":\"Old\"}", vec![]);
        let latest = signed(
            &keys,
            0,
            at + 1,
            "{\"name\":\"Latest\"}",
            vec![vec!["expiration".into(), (at + 2).to_string()]],
        );
        assert!(cache.ingest(&old).unwrap());
        assert!(cache.ingest(&latest).unwrap());
        drop(cache);
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        assert!(cache.query_local(&[], 20).unwrap().is_empty());
        assert!(!cache.ingest(&old).unwrap());
        assert!(!cache.permits(&old).unwrap());
        assert_eq!(cache.authority().unwrap(), vec![latest]);
    }
    #[test]
    fn deletion_is_author_scoped_and_survives_reload() {
        let (dir, cache) = db();
        let owner = Keys::generate();
        let attacker = Keys::generate();
        let at = crate::listing::now() - 20;
        let profile = signed(
            &owner,
            3,
            at,
            "",
            vec![vec!["p".into(), attacker.public_key().to_hex()]],
        );
        cache.ingest(&profile).unwrap();
        let foreign = signed(
            &attacker,
            5,
            at + 1,
            "",
            vec![vec!["e".into(), profile.id.to_hex()]],
        );
        cache.ingest(&foreign).unwrap();
        assert!(cache.permits(&profile).unwrap());
        let removal = signed(
            &owner,
            5,
            at + 2,
            "",
            vec![vec!["a".into(), coordinate(&profile).unwrap()]],
        );
        cache.ingest(&removal).unwrap();
        drop(cache);
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        assert!(!cache.permits(&profile).unwrap());
        assert!(
            cache
                .query_local(&[Filter::new().kind(Kind::ContactList)], 10)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn signed_empty_list_supersedes_following_and_private_kinds_are_rejected() {
        let (_dir, cache) = db();
        let keys = Keys::generate();
        let at = crate::listing::now() - 10;
        cache
            .ingest(&signed(
                &keys,
                3,
                at,
                "",
                vec![vec!["p".into(), Keys::generate().public_key().to_hex()]],
            ))
            .unwrap();
        let empty = signed(&keys, 3, at + 1, "", vec![]);
        cache.ingest(&empty).unwrap();
        assert_eq!(cache.query_local(&[], 10).unwrap(), vec![empty]);
        for kind in [4, 14, 1059, 1060, 37368, 30402] {
            assert!(cache.ingest(&signed(&keys, kind, at, "", vec![])).is_err());
        }
    }
    #[test]
    fn untrusted_disk_and_interrupted_commit_fail_closed() {
        let (dir, cache) = db();
        let keys = Keys::generate();
        let at = crate::listing::now() - 10;
        let event = signed(&keys, 0, at, "{\"name\":\"Valid\"}", vec![]);
        cache.ingest(&event).unwrap();
        drop(cache);
        let path = dir.path().join("public.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE public_events SET raw=replace(raw,'Valid','Wrong')",
            [],
        )
        .unwrap();
        drop(db);
        let cache = PublicEventCache::open(&path).unwrap();
        assert!(cache.disabled());
        assert!(cache.query_local(&[], 10).unwrap().is_empty());
        drop(cache);
        let cache = PublicEventCache::open(&path).unwrap();
        assert!(cache.disabled());
    }
    #[test]
    fn sqlite_page_failure_cannot_replay_an_old_winner() {
        let (dir, cache) = db();
        let keys = Keys::generate();
        let at = crate::listing::now() - 10;
        cache.ingest(&signed(&keys, 0, at, "Old", vec![])).unwrap();
        {
            let inner = cache.inner.lock().unwrap();
            let pages: u64 = inner
                .db
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap();
            inner
                .db
                .pragma_update(None, "max_page_count", pages)
                .unwrap();
        }
        let huge = signed(&keys, 0, at + 1, &"x".repeat(100_000), vec![]);
        assert!(cache.ingest(&huge).is_err());
        assert!(cache.disabled());
        drop(cache);
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        assert!(cache.disabled());
        assert!(cache.query_local(&[], 10).unwrap().is_empty());
    }
    #[test]
    fn logical_byte_pressure_keeps_unknown_records_out_and_quarantines_failed_winner() {
        let (dir, cache) = db();
        let keys = Keys::generate();
        let at = crate::listing::now() - 10;
        cache.ingest(&signed(&keys, 0, at, "Old", vec![])).unwrap();
        for _ in 0..8 {
            assert!(
                cache
                    .ingest(&signed(
                        &Keys::generate(),
                        0,
                        at,
                        &"x".repeat(1_000_000),
                        vec![]
                    ))
                    .unwrap()
            );
        }
        assert!(
            !cache
                .ingest(&signed(
                    &Keys::generate(),
                    0,
                    at,
                    &"x".repeat(500_000),
                    vec![]
                ))
                .unwrap()
        );
        assert_eq!(cache.authority().unwrap().len(), 9);
        assert!(
            cache
                .ingest(&signed(&keys, 0, at + 1, &"x".repeat(900_000), vec![]))
                .is_err()
        );
        assert!(cache.disabled());
        drop(cache);
        let cache = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        assert!(cache.disabled());
        assert!(cache.query_local(&[], 10).unwrap().is_empty());
    }
    #[test]
    fn byte_and_record_budgets_reject_unknown_records_without_eviction() {
        let (dir, cache) = db();
        let at = crate::listing::now() - 10;
        let mut first = None;
        for _ in 0..MAX_COORDINATES {
            let event = signed(&Keys::generate(), 0, at, "{}", vec![]);
            first.get_or_insert(event.clone());
            assert!(cache.ingest(&event).unwrap());
        }
        assert!(
            !cache
                .ingest(&signed(&Keys::generate(), 0, at + 1, "{}", vec![]))
                .unwrap()
        );
        assert_eq!(cache.authority().unwrap().len(), MAX_COORDINATES);
        assert!(cache.permits(&first.unwrap()).unwrap());
        assert!(
            std::fs::metadata(dir.path().join("public.sqlite"))
                .unwrap()
                .len()
                <= MAX_PUBLIC_CACHE_FILE_BYTES
        );
    }
}
