use crate::{
    listing,
    model::{Listing, Relevance, Settings},
};
use anyhow::{Context, Result};
use nostr::{Event, JsonUtil};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub struct Store {
    db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS events (coordinate TEXT PRIMARY KEY, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, raw TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS saved (coordinate TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY, raw TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS relevance (coordinate TEXT PRIMARY KEY, event_id TEXT NOT NULL, value TEXT NOT NULL);")?;
        Ok(Self { db })
    }
    pub fn settings(&self) -> Result<Settings> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM preferences WHERE key='settings'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|v| serde_json::from_str(&v).context("Read settings"))
            .unwrap_or_else(|| Ok(Settings::default()))
    }
    /// Existing explicit Off is a choice too; never infer intent from default values.
    pub fn ai_configured(&self) -> Result<bool> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM preferences WHERE key='settings'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw
            .map(|raw| {
                serde_json::from_str::<serde_json::Value>(&raw)
                    .map(|value| value.get("ai").is_some())
            })
            .transpose()?
            .unwrap_or(false))
    }
    /// Local setup consent is independent of optional public profile metadata.
    pub fn profile_setup_complete(&self, owner: nostr::PublicKey) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT value='true' FROM preferences WHERE key=?1",
                [format!("profile-setup-complete:{}", owner.to_hex())],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    pub fn complete_profile_setup(&self, owner: nostr::PublicKey) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO preferences VALUES (?1,'true')",
            [format!("profile-setup-complete:{}", owner.to_hex())],
        )?;
        Ok(())
    }
    pub fn profile_metadata(&self, owner: &str) -> Result<Option<Event>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM preferences WHERE key=?1",
                [format!("profile-metadata:{owner}")],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| {
            let event = Event::from_json(raw)?;
            event.verify()?;
            anyhow::ensure!(
                event.kind == nostr::Kind::Metadata && event.pubkey.to_hex() == owner,
                "Invalid local profile metadata"
            );
            Ok(event)
        })
        .transpose()
    }
    /// Local name and exact publication intent commit together before network work.
    pub fn queue_profile_metadata(&mut self, event: &Event) -> Result<()> {
        event.verify()?;
        anyhow::ensure!(
            event.kind == nostr::Kind::Metadata,
            "Expected profile metadata"
        );
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO preferences VALUES (?1,?2)",
            params![
                format!("profile-metadata:{}", event.pubkey.to_hex()),
                event.as_json()
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO outbox VALUES (?1,?2)",
            params![event.id.to_hex(), event.as_json()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn exchange_rates(&self) -> Result<crate::rates::RateBook> {
        let raw: Option<String> = self.db.query_row("SELECT value FROM preferences WHERE key='exchange_rates' AND length(value)<=262144", [], |row| row.get(0)).optional()?;
        raw.map(|raw| crate::rates::RateBook::from_cache(&raw, crate::listing::now()))
            .unwrap_or_else(|| Ok(crate::rates::RateBook::default()))
    }
    pub fn save_exchange_rates(&self, book: &crate::rates::RateBook) -> Result<()> {
        let raw = book.cache_json()?;
        self.db.execute(
            "INSERT OR REPLACE INTO preferences VALUES ('exchange_rates', ?1)",
            [raw],
        )?;
        Ok(())
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO preferences VALUES ('settings', ?1)",
            [serde_json::to_string(settings)?],
        )?;
        self.db.execute("DELETE FROM relevance", [])?;
        Ok(())
    }
    pub(crate) fn review_events(&self, target: &str) -> Result<Vec<Event>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM preferences WHERE key=?1 AND length(value)<=1048576",
                [format!("reviews:{target}")],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }
    pub(crate) fn save_review_events(&self, target: &str, events: &[Event]) -> Result<()> {
        let raw = serde_json::to_string(events)?;
        anyhow::ensure!(raw.len() <= 1048576, "Review cache is full");
        self.db.execute(
            "INSERT OR REPLACE INTO preferences VALUES (?1,?2)",
            params![format!("reviews:{target}"), raw],
        )?;
        self.db.execute("DELETE FROM preferences WHERE key LIKE 'reviews:%' AND rowid NOT IN (SELECT rowid FROM preferences WHERE key LIKE 'reviews:%' ORDER BY rowid DESC LIMIT 16)",[])?;
        Ok(())
    }
    pub fn clear_relevance(&self) -> Result<()> {
        self.db.execute("DELETE FROM relevance", [])?;
        Ok(())
    }
    pub fn ingest(&mut self, event: &Event, at: u64, outgoing: bool) -> Result<bool> {
        let parsed = listing::parse(event, at)?;
        let tx = self.db.transaction()?;
        let previous: Option<(u64, String)> = tx
            .query_row(
                "SELECT created_at,event_id FROM events WHERE coordinate=?1",
                [&parsed.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let id = event.id.to_hex();
        if let Some((created, previous_id)) = previous
            && (created > parsed.created_at || (created == parsed.created_at && previous_id <= id))
        {
            return Ok(false);
        }
        tx.execute(
            "INSERT OR REPLACE INTO events VALUES (?1,?2,?3,?4)",
            params![parsed.id, id, parsed.created_at, event.as_json()],
        )?;
        tx.execute("DELETE FROM relevance WHERE coordinate=?1", [&parsed.id])?;
        if outgoing {
            tx.execute(
                "INSERT OR REPLACE INTO outbox VALUES (?1,?2)",
                params![id, event.as_json()],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }
    pub fn listings(&self, owner: &str, at: u64) -> Result<Vec<Listing>> {
        self.listings_for_scope(owner, at, None)
    }
    pub fn listings_for_author(&self, owner: &str, author: &str, at: u64) -> Result<Vec<Listing>> {
        let author = nostr::PublicKey::from_hex(author)?.to_hex();
        self.listings_for_scope(owner, at, Some(&author))
    }
    fn listings_for_scope(
        &self,
        owner: &str,
        at: u64,
        author: Option<&str>,
    ) -> Result<Vec<Listing>> {
        let lower = author.map(|author| format!("{author}:"));
        let upper = author.map(|author| format!("{author};"));
        let mut stmt = self.db.prepare("SELECT e.raw, s.coordinate IS NOT NULL, EXISTS(SELECT 1 FROM outbox o WHERE o.event_id=e.event_id), r.value FROM events e LEFT JOIN saved s ON s.coordinate=e.coordinate LEFT JOIN relevance r ON r.coordinate=e.coordinate AND r.event_id=e.event_id WHERE (?1 IS NULL OR (e.coordinate >= ?1 AND e.coordinate < ?2)) ORDER BY e.created_at DESC,e.event_id LIMIT 5000")?;
        let rows = stmt.query_map(params![lower, upper], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut listings = Vec::new();
        for row in rows {
            let (raw, saved, queued, relevance) = row?;
            let event = Event::from_json(raw)?;
            let mut l = listing::parse(&event, at)?;
            if l.status != "active" || l.expires_at.is_some_and(|x| x <= at) {
                continue;
            }
            l.saved = saved;
            l.mine = l.author == owner;
            if queued {
                l.delivery = "queued".into();
            }
            l.relevance = relevance.map(|r| serde_json::from_str(&r)).transpose()?;
            listings.push(l);
        }
        Ok(listings)
    }
    /// Raw local winning public events, including sold and expired authority.
    /// No outbox, keys, messages or derived visible-feed projection enters sync.
    pub(crate) fn reconciliation_snapshot(
        &self,
        since: u64,
        until: u64,
        max_records: usize,
        max_bytes: usize,
    ) -> Result<Vec<Event>> {
        let mut statement = self.db.prepare(
            "SELECT raw FROM events WHERE created_at>=?1 AND created_at<=?2 ORDER BY created_at,event_id LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![since, until, max_records.saturating_add(1)],
            |row| row.get::<_, String>(0),
        )?;
        let mut events = Vec::new();
        let mut bytes = 0usize;
        for raw in rows {
            let raw = raw?;
            bytes = bytes.saturating_add(raw.len());
            anyhow::ensure!(
                events.len() < max_records && bytes <= max_bytes,
                "Public reconciliation snapshot exceeds its budget"
            );
            events.push(Event::from_json(raw)?);
        }
        Ok(events)
    }

    pub fn event(&self, coordinate: &str) -> Result<Event> {
        let raw: String = self.db.query_row(
            "SELECT raw FROM events WHERE coordinate=?1",
            [coordinate],
            |r| r.get(0),
        )?;
        Ok(Event::from_json(raw)?)
    }
    pub fn toggle_saved(&self, coordinate: &str) -> Result<()> {
        self.event(coordinate)?;
        let removed = self
            .db
            .execute("DELETE FROM saved WHERE coordinate=?1", [coordinate])?;
        if removed == 0 {
            self.db
                .execute("INSERT INTO saved VALUES (?1)", [coordinate])?;
        }
        Ok(())
    }
    pub fn initial_authorization(&self) -> Result<Option<Event>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM preferences WHERE key='initial-owner-authorization'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| Event::from_json(raw).map_err(Into::into))
            .transpose()
    }
    /// One durable transaction preserves both fresh-profile proof and publication intent.
    pub fn queue_initial_authorization(&mut self, event: &Event) -> Result<()> {
        event.verify()?;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO preferences VALUES ('initial-owner-authorization', ?1)",
            [event.as_json()],
        )?;
        tx.execute(
            "INSERT INTO outbox VALUES (?1, ?2)",
            params![event.id.to_hex(), event.as_json()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn queue_event(&self, event: &Event) -> Result<()> {
        event.verify()?;
        self.db.execute(
            "INSERT OR REPLACE INTO outbox VALUES (?1,?2)",
            params![event.id.to_hex(), event.as_json()],
        )?;
        Ok(())
    }
    pub fn pending(&self) -> Result<Vec<Event>> {
        let mut stmt = self.db.prepare("SELECT raw FROM outbox LIMIT 100")?;
        let raws = stmt.query_map([], |r| r.get::<_, String>(0))?;
        raws.map(|r| Ok(Event::from_json(r?)?)).collect()
    }
    pub fn acknowledge(&self, event_id: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM outbox WHERE event_id=?1", [event_id])?;
        Ok(())
    }
    pub fn relevance(&self, coordinate: &str, event_id: &str, decision: &Relevance) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO relevance VALUES (?1,?2,?3)",
            params![coordinate, event_id, serde_json::to_string(decision)?],
        )?;
        Ok(())
    }
    /// A platform response is one batch. A write failure must not persist only
    /// the first few decisions and hide some listings after an interrupted run.
    pub fn relevance_batch(&mut self, decisions: &[(String, String, Relevance)]) -> Result<()> {
        let tx = self.db.transaction()?;
        for (coordinate, event_id, decision) in decisions {
            tx.execute(
                "INSERT OR REPLACE INTO relevance VALUES (?1,?2,?3)",
                params![coordinate, event_id, serde_json::to_string(decision)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
