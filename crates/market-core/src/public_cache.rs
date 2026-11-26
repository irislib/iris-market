//! Bounded, verified public profile records. Never a private inbox or outbox.
//! Signed inactive winners are retained as authority; capacity never evicts them.
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use fs2::FileExt;
use nostr::{Event, Filter, JsonUtil, Kind};
use nostr_pubsub::{
    EventBus, EventSource, MatchEventOptions, PublishReport, PubsubError, QueryEvent, QueryOptions,
    QueryReport, SOURCE_PRIORITY_LOCAL_INDEX, VerifiedEvent,
};
use rusqlite::{Connection, params};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

/// Take an exclusive lock, retrying for up to half a second. A child process
/// that is starting can briefly hold an inherited copy of the descriptor before
/// exec closes it, which must not be mistaken for another open store.
pub(crate) fn lock_exclusive_briefly(file: &File) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(error) if std::time::Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
}

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
    by_coordinate: HashMap<String, String>,
    deletions_by_author: HashMap<nostr::PublicKey, Vec<Event>>,
    sizes: HashMap<String, usize>,
    total_bytes: usize,
    ordinary_count: usize,
    deletion_count: usize,
    disabled: bool,
    revision: u64,
}
impl Cache {
    fn index_insert(&mut self, id: String, key: Option<String>, size: usize, event: Event) {
        if let Some(coord) = key {
            self.by_coordinate.insert(coord, id.clone());
            self.ordinary_count += 1;
        } else {
            self.deletions_by_author
                .entry(event.pubkey)
                .or_default()
                .push(event.clone());
            self.deletion_count += 1;
        }
        self.total_bytes += size;
        self.sizes.insert(id.clone(), size);
        self.events.insert(id, event);
    }
    fn index_remove(&mut self, id: &str) {
        if let Some(old) = self.events.remove(id) {
            if let Some(size) = self.sizes.remove(id) {
                self.total_bytes = self.total_bytes.saturating_sub(size);
            }
            if let Some(coord) = coordinate(&old) {
                if self.by_coordinate.get(&coord).map(String::as_str) == Some(id) {
                    self.by_coordinate.remove(&coord);
                }
                self.ordinary_count = self.ordinary_count.saturating_sub(1);
            } else {
                if let Some(list) = self.deletions_by_author.get_mut(&old.pubkey) {
                    list.retain(|e| e.id != old.id);
                    if list.is_empty() {
                        self.deletions_by_author.remove(&old.pubkey);
                    }
                }
                self.deletion_count = self.deletion_count.saturating_sub(1);
            }
        }
    }
    fn allows(&self, event: &Event, now: u64) -> bool {
        if !current(event, now) {
            return false;
        }
        if let Some(key) = coordinate(event)
            && let Some(existing_id) = self.by_coordinate.get(&key)
            && let Some(old) = self.events.get(existing_id)
            && supersedes(old, event)
        {
            return false;
        }
        self.deletions_by_author
            .get(&event.pubkey)
            .is_none_or(|list| !list.iter().any(|del| deletes(del, event)))
    }
}

fn coordinate(event: &Event) -> Option<String> {
    matches!(event.kind.as_u16(), 0 | 3 | 10000)
        .then(|| format!("{}:{}:", event.kind.as_u16(), event.pubkey))
}
fn supersedes(a: &Event, b: &Event) -> bool {
    a.created_at > b.created_at || a.created_at == b.created_at && a.id < b.id
}
fn validate(event: &Event) -> Result<String> {
    let raw = event.as_json();
    if !matches!(event.kind.as_u16(), 0 | 3 | 5 | 10000)
        || raw.len() > MAX_EVENT_BYTES
        || event.created_at.as_secs() > crate::listing::now().saturating_add(300)
    {
        bail!("Record is outside public profile storage");
    }
    event.verify()?;
    Ok(raw)
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
        lock_exclusive_briefly(&guard).context("Public cache is already open")?;
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
            by_coordinate: HashMap::new(),
            deletions_by_author: HashMap::new(),
            sizes: HashMap::new(),
            total_bytes: 0,
            ordinary_count: 0,
            deletion_count: 0,
            disabled: byte[0] != b'0',
            revision: 1,
        };
        if !cache.disabled {
            struct LoadedRow {
                id: String,
                key: Option<String>,
                size: usize,
                event: Event,
            }
            let loaded = (|| -> Result<Vec<LoadedRow>> {
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
                let mut loaded = Vec::new();
                let mut coordinates = 0;
                let mut deletion_count = 0;
                let mut bytes = 0;
                for row in rows {
                    let (id, key, raw) = row?;
                    let size = raw.len();
                    bytes += size;
                    if size > MAX_EVENT_BYTES || bytes > MAX_PUBLIC_CACHE_BYTES {
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
                    loaded.push(LoadedRow {
                        id,
                        key,
                        size,
                        event,
                    });
                }
                Ok(loaded)
            })();
            match loaded {
                Ok(items) => {
                    for row in items {
                        cache.index_insert(row.id, row.key, row.size, row.event);
                    }
                }
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
        Ok(cache
            .events
            .values()
            .filter(|event| event.kind != Kind::MuteList)
            .cloned()
            .collect())
    }
    pub fn permits(&self, event: &Event) -> Result<bool> {
        let cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        Ok(!cache.disabled && cache.allows(event, crate::listing::now()))
    }
    pub fn ingest(&self, event: &Event) -> Result<bool> {
        anyhow::ensure!(
            event.kind != Kind::MuteList,
            "Mute lists require graph-scoped ingestion"
        );
        self.store_verified(event)
    }
    /// Persist a batch of verified public events in a single atomic transaction.
    pub fn ingest_batch(&self, events: &[Event]) -> Result<usize> {
        let mut validated = Vec::with_capacity(events.len());
        for event in events {
            if event.kind == Kind::MuteList {
                continue;
            }
            if let Ok(raw) = validate(event) {
                validated.push((event.clone(), raw));
            }
        }
        self.store_verified_batch(validated)
    }

    fn store_verified(&self, event: &Event) -> Result<bool> {
        let raw = validate(event)?;
        Ok(self.store_verified_batch(vec![(event.clone(), raw)])? > 0)
    }

    fn store_verified_batch(&self, validated: Vec<(Event, String)>) -> Result<usize> {
        if validated.is_empty() {
            return Ok(0);
        }
        let mut cache = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Public cache is unavailable"))?;
        if cache.disabled {
            bail!("Public cache is unavailable");
        }
        // Collapse duplicates and same-coordinate revisions in arrival order first.
        struct StagedRow {
            id: String,
            key: Option<String>,
            previous_id: Option<String>,
            event: Event,
            raw: String,
        }
        let mut candidates: Vec<StagedRow> = Vec::new();
        let mut by_coord: HashMap<String, usize> = HashMap::new();
        let mut seen_ids = std::collections::HashSet::new();
        for (event, raw) in validated {
            let id = event.id.to_hex();
            if cache.events.contains_key(&id) || !seen_ids.insert(id.clone()) {
                continue;
            }
            let key = coordinate(&event);
            if let Some(coord) = &key
                && let Some(&idx) = by_coord.get(coord)
            {
                if supersedes(&event, &candidates[idx].event) {
                    candidates[idx] = StagedRow {
                        id,
                        key,
                        previous_id: None,
                        event,
                        raw,
                    };
                }
                continue;
            }
            if let Some(coord) = &key {
                by_coord.insert(coord.clone(), candidates.len());
            }
            candidates.push(StagedRow {
                id,
                key,
                previous_id: None,
                event,
                raw,
            });
        }

        let mut staged: Vec<StagedRow> = Vec::new();
        let (mut ordinary, mut deletions, mut bytes) = (
            cache.ordinary_count,
            cache.deletion_count,
            cache.total_bytes,
        );
        for mut row in candidates {
            let previous_id = row
                .key
                .as_ref()
                .and_then(|k| cache.by_coordinate.get(k))
                .cloned();
            let previous = previous_id.as_deref().and_then(|id| cache.events.get(id));
            if previous.is_some_and(|old| !supersedes(&row.event, old)) {
                continue;
            }
            let old_len = previous_id
                .as_deref()
                .and_then(|id| cache.sizes.get(id))
                .copied()
                .unwrap_or(0);
            let known = previous.is_some()
                || (row.key.is_none()
                    && (cache.events.values().any(|old| deletes(&row.event, old))
                        || staged.iter().any(|s| deletes(&row.event, &s.event))));
            let fits = (row.key.is_none() || previous.is_some() || ordinary < MAX_COORDINATES)
                && (row.key.is_some() || deletions < MAX_DELETIONS)
                && bytes - old_len + row.raw.len() <= MAX_PUBLIC_CACHE_BYTES;
            if !fits {
                if known {
                    cache.disabled = true;
                    cache.revision = cache.revision.saturating_add(1);
                    mark(&mut cache.guard, true)?;
                    bail!("Public cache is full; cached replay was paused");
                }
                continue;
            }
            if row.key.is_some() {
                ordinary += usize::from(previous.is_none());
            } else {
                deletions += 1;
            }
            bytes = bytes - old_len + row.raw.len();
            row.previous_id = previous_id;
            staged.push(row);
        }
        if staged.is_empty() {
            return Ok(0);
        }
        // A fixed, already allocated byte can be dirtied even when SQLite has
        // reached its page limit. It is cleared only after the durable commit.
        cache.disabled = true;
        cache.revision = cache.revision.saturating_add(1);
        mark(&mut cache.guard, true)?;
        let transaction = cache.db.transaction()?;
        for row in &staged {
            if let Some(old_id) = &row.previous_id {
                transaction.execute("DELETE FROM public_events WHERE id=?1", [old_id])?;
            }
            transaction.execute(
                "INSERT INTO public_events(id,coordinate,raw) VALUES (?1,?2,?3)",
                params![row.id, row.key, row.raw],
            )?;
        }
        transaction.commit()?;
        mark(&mut cache.guard, false)?;
        let count = staged.len();
        for row in staged {
            if let Some(old_id) = row.previous_id {
                cache.index_remove(&old_id);
            }
            cache.index_insert(row.id, row.key, row.raw.len(), row.event);
        }
        cache.disabled = false;
        Ok(count)
    }
    /// Signed public list bodies stay local. The ordinary event bus never replays mute lists.
    pub(super) fn store_graph_list(&self, event: &Event) -> Result<bool> {
        anyhow::ensure!(
            matches!(event.kind, Kind::ContactList | Kind::MuteList),
            "Expected a graph list"
        );
        self.store_verified(event)
    }
    pub(super) fn profile_records(&self, limit: usize) -> Result<Vec<Event>> {
        self.query_records(
            &[Filter::new().kinds([Kind::Metadata, Kind::ContactList, Kind::MuteList])],
            limit,
            true,
        )
    }
    pub fn query_local(&self, filters: &[Filter], limit: usize) -> Result<Vec<Event>> {
        self.query_records(filters, limit, false)
    }
    fn query_records(&self, filters: &[Filter], limit: usize, graph: bool) -> Result<Vec<Event>> {
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
        let now = crate::listing::now();
        let mut events: Vec<_> = cache
            .events
            .values()
            .filter(|event| (graph || event.kind != Kind::MuteList) && cache.allows(event, now))
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
    #[test]
    fn brief_lock_waits_out_a_transient_holder_but_not_a_lasting_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("guard");
        let open = || {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .unwrap()
        };
        let holder = open();
        holder.try_lock_exclusive().unwrap();
        let started = std::time::Instant::now();
        assert!(lock_exclusive_briefly(&open()).is_err());
        assert!(started.elapsed() >= std::time::Duration::from_millis(500));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(holder);
        });
        lock_exclusive_briefly(&open()).unwrap();
        releaser.join().unwrap();
    }

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
    #[test]
    fn ingest_batch_collapses_revisions_enforces_budgets_and_fails_closed() {
        let (dir, cache) = db();
        let author = Keys::generate();
        let other = Keys::generate();
        let at = crate::listing::now() - 20;
        let old = signed(&author, 0, at, r#"{"name":"Old"}"#, vec![]);
        let mid = signed(&author, 0, at + 1, r#"{"name":"Mid"}"#, vec![]);
        let newest = signed(&author, 0, at + 2, r#"{"name":"Newest"}"#, vec![]);
        let other_ev = signed(&other, 0, at, r#"{"name":"Other"}"#, vec![]);
        let del = signed(
            &other,
            5,
            at + 1,
            "",
            vec![vec!["a".into(), coordinate(&other_ev).unwrap()]],
        );
        let rev_before = cache.revision();
        let written = cache
            .ingest_batch(&[
                newest.clone(),
                old.clone(),
                newest.clone(),
                mid,
                other_ev.clone(),
                del.clone(),
            ])
            .unwrap();
        assert_eq!(written, 3);
        assert_eq!(cache.revision(), rev_before + 1);
        assert_eq!(
            cache
                .query_local(&[Filter::new().kind(Kind::Metadata)], 10)
                .unwrap(),
            vec![newest.clone()]
        );
        assert!(!cache.permits(&other_ev).unwrap());
        drop(cache);
        let reopened = PublicEventCache::open(&dir.path().join("public.sqlite")).unwrap();
        assert_eq!(
            reopened
                .query_local(&[Filter::new().kind(Kind::Metadata)], 10)
                .unwrap(),
            vec![newest]
        );
        assert!(!reopened.permits(&other_ev).unwrap());

        // Fill cache close to byte cap and verify a known coordinate exceeding it fails closed.
        let mut fillers = Vec::new();
        for _ in 0..8 {
            fillers.push(signed(
                &Keys::generate(),
                0,
                at,
                &"x".repeat(1_000_000),
                vec![],
            ));
        }
        assert_eq!(reopened.ingest_batch(&fillers).unwrap(), 8);
        let oversized_update = signed(&author, 0, at + 3, &"x".repeat(900_000), vec![]);
        assert!(reopened.ingest_batch(&[oversized_update]).is_err());
        assert!(reopened.disabled());
    }
}
