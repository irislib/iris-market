use super::*;
use crate::collections::{self, Data, Member, ProductCollection};
use anyhow::ensure;
use nostr::PublicKey;

pub(super) type VerifiedCollection = (Arc<Event>, Option<Arc<Data>>);

pub(super) fn schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS collections (
        author TEXT NOT NULL, identifier TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        raw TEXT NOT NULL, PRIMARY KEY(author,identifier));
        CREATE INDEX IF NOT EXISTS collections_author_date ON collections(author,created_at DESC,event_id);
        CREATE TABLE IF NOT EXISTS collection_deletions (
        author TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(author,target));")?;
    Ok(())
}

/// A verified collection event, its parsed data and whether it is still queued.
type CollectionRow = (Arc<Event>, Arc<Data>, bool);

impl Store {
    pub(crate) fn ingest_collection(
        &mut self,
        event: &Event,
        at: u64,
        outgoing: bool,
        previous: Option<nostr::EventId>,
    ) -> Result<bool> {
        collections::validate_envelope(event, at)?;
        let identifier = collections::collection_id(event)?;
        if outgoing {
            collections::parse(event)?;
        }
        let tx = self.db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT event_id FROM collections WHERE author=?1 AND identifier=?2",
                params![event.pubkey.to_hex(), identifier],
                |row| row.get(0),
            )
            .optional()?;
        if outgoing {
            ensure!(
                old == previous.map(|id| id.to_hex()),
                "This collection changed. Reopen it before editing"
            );
        }
        let changed = tx.execute("INSERT INTO collections VALUES (?1,?2,?3,?4,?5)
            ON CONFLICT(author,identifier) DO UPDATE SET event_id=excluded.event_id,created_at=excluded.created_at,raw=excluded.raw
            WHERE excluded.created_at > created_at OR (excluded.created_at = created_at AND excluded.event_id < event_id)",
            params![event.pubkey.to_hex(),identifier,event.id.to_hex(),event.created_at.as_secs(),event.as_json()])? > 0;
        if changed && let Some(old) = old {
            tx.execute("DELETE FROM outbox WHERE event_id=?1", [old])?;
        }
        if changed && outgoing {
            tx.execute(
                "INSERT INTO outbox VALUES (?1,?2)",
                params![event.id.to_hex(), event.as_json()],
            )?;
        }
        tx.commit()?;
        Ok(changed)
    }
    pub(crate) fn ingest_collection_deletion(&mut self, event: &Event, at: u64) -> Result<bool> {
        ensure!(
            event.kind == nostr::Kind::EventDeletion,
            "Expected a deletion"
        );
        collections::validate_envelope(event, at)?;
        let author = event.pubkey.to_hex();
        let prefix = format!("30405:{author}:");
        let declared = event.tags.iter().any(|tag| {
            tag.as_slice().first().is_some_and(|t| t == "k")
                && tag.as_slice().get(1).is_some_and(|k| k == "30405")
        });
        let tx = self.db.transaction()?;
        let mut changed = false;
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            let Some(target) = parts.get(1) else { continue };
            let valid = match parts[0].as_str() {
                "a" => target.strip_prefix(&prefix).is_some_and(|id| !id.is_empty() && id.len() <= 160 && !id.chars().any(char::is_control)),
                "e" => nostr::EventId::from_hex(target).is_ok() && (declared || tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE author=?1 AND event_id=?2)", params![author,target], |r| r.get(0))?),
                _ => false,
            };
            if valid {
                changed |= tx.execute("INSERT INTO collection_deletions VALUES (?1,?2,?3)
                    ON CONFLICT(author,target) DO UPDATE SET created_at=excluded.created_at WHERE excluded.created_at>created_at",
                    params![author,target,event.created_at.as_secs()])? > 0;
            }
        }
        if changed {
            tx.execute("DELETE FROM outbox WHERE event_id IN (
                SELECT c.event_id FROM collections c JOIN collection_deletions d ON d.author=c.author
                AND d.created_at>=c.created_at AND d.target IN (c.event_id,'30405:' || c.author || ':' || c.identifier)
                WHERE c.author=?1)", [&author])?;
        }
        tx.commit()?;
        Ok(changed)
    }

    fn verified_collection(&self, raw: &str, at: u64) -> Result<VerifiedCollection> {
        let mut cache = self.verified_collections.borrow_mut();
        if let Some((event, data)) = cache.get(raw) {
            ensure!(
                event.created_at.as_secs() <= at.saturating_add(300),
                "Collection timestamp is too far in the future"
            );
            return Ok((event.clone(), data.clone()));
        }
        let event = Arc::new(Event::from_json(raw)?);
        collections::validate_envelope(&event, at)?;
        let data = collections::parse(&event).ok().map(Arc::new);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(raw.to_owned(), (event.clone(), data.clone()));
        Ok((event, data))
    }

    fn collection_rows(
        &self,
        author: &str,
        id: Option<&str>,
        owner: &str,
        at: u64,
    ) -> Result<Vec<CollectionRow>> {
        PublicKey::from_hex(author)?;
        let mut statement = self.db.prepare("SELECT raw,EXISTS(SELECT 1 FROM outbox WHERE event_id=c.event_id)
            FROM collections c WHERE author=?1 AND (?2 IS NULL OR identifier=?2)
            AND (c.author=?4 OR NOT EXISTS(SELECT 1 FROM outbox WHERE event_id=c.event_id))
            AND NOT EXISTS(SELECT 1 FROM collection_deletions d WHERE d.author=c.author AND d.created_at>=c.created_at
                AND d.target IN (c.event_id, '30405:' || c.author || ':' || c.identifier))
            ORDER BY c.created_at DESC,c.event_id LIMIT ?3")?;
        let mut collections = Vec::new();
        let rows = statement.query_map(
            params![author, id, crate::collections::PROFILE_LIMIT, owner],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
        )?;
        for row in rows {
            let (raw, queued) = row?;
            let (event, data) = self.verified_collection(&raw, at)?;
            if let Some(data) = data
                && event.pubkey.to_hex() == author
                && id.is_none_or(|id| data.identifier == id)
                && data.expiration.is_none_or(|expiry| expiry > at)
            {
                collections.push((event, data, queued));
            }
        }
        Ok(collections)
    }
    pub(crate) fn visible_collection_event(
        &self,
        author: &str,
        id: &str,
        at: u64,
    ) -> Result<Option<Event>> {
        Ok(self
            .collection_rows(author, Some(id), author, at)?
            .pop()
            .map(|(event, _, _)| (*event).clone()))
    }

    pub(crate) fn collection_member(
        &self,
        id: &str,
        owner: &str,
        at: u64,
    ) -> Result<Option<Listing>> {
        let row: Option<(String,bool,bool)> = self.db.query_row(
            "SELECT e.raw, s.coordinate IS NOT NULL, EXISTS(SELECT 1 FROM outbox WHERE event_id=e.event_id)
            FROM events e LEFT JOIN saved s ON s.coordinate=e.coordinate WHERE e.coordinate=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((raw, saved, queued)) = row else {
            return Ok(None);
        };
        let verified = self.verified_listings.borrow_mut().parse(&raw, at)?;
        if verified.kind.as_u16() != listing::LISTING_KIND {
            return Ok(None);
        }
        let mut listing = verified.listing.clone();
        if listing.id != id
            || listing.external_order.is_some()
            || listing.status != "active"
            || listing.expires_at.is_some_and(|expiry| expiry <= at)
        {
            return Ok(None);
        }
        listing.mine = listing.author == owner;
        listing.saved = saved;
        if queued {
            listing.delivery = "queued".into();
        }
        Ok(Some(listing))
    }
    pub(crate) fn profile_collections(
        &self,
        author: &str,
        owner: &str,
        selected: Option<&str>,
        at: u64,
    ) -> Result<Vec<ProductCollection>> {
        self.collection_rows(author, None, owner, at)?
            .into_iter()
            .map(|(event, data, queued)| {
                let members = data
                    .ids
                    .iter()
                    .map(|id| {
                        Ok(Member {
                            id: id.clone(),
                            listing: if selected == Some(&data.identifier) {
                                self.collection_member(id, owner, at)?
                            } else {
                                None
                            },
                        })
                    })
                    .collect::<Result<_>>()?;
                Ok(ProductCollection {
                    identifier: data.identifier.clone(),
                    event_id: event.id.to_hex(),
                    title: data.title.clone(),
                    delivery: if queued { "queued" } else { "published" },
                    members,
                })
            })
            .collect()
    }
    pub(crate) fn collection_targets(
        &self,
        author: &str,
        owner: &str,
        selected: Option<&str>,
        at: u64,
    ) -> Result<Vec<(String, String, Vec<String>)>> {
        Ok(self
            .collection_rows(author, selected, owner, at)?
            .into_iter()
            .map(|(event, data, _)| {
                (
                    data.identifier.clone(),
                    event.id.to_hex(),
                    if selected.is_some() {
                        data.ids.clone()
                    } else {
                        Vec::new()
                    },
                )
            })
            .collect())
    }
}
