//! Signed marketplace product collections (kind 30405). Membership belongs to the curator.
use crate::{State, listing, model::Listing};
use anyhow::{Context, Result, ensure};
use nostr::{Event, EventBuilder, JsonUtil, Kind, PublicKey, Tag, Timestamp};
use serde::Serialize;
use std::collections::HashSet;

pub const KIND: u16 = 30405;
pub(crate) const PROFILE_LIMIT: usize = 32;
const MAX_MEMBERS: usize = 64;

#[derive(Clone, Debug, Serialize)]
pub struct ProductCollection {
    pub identifier: String,
    pub event_id: String,
    pub title: String,
    pub delivery: &'static str,
    pub members: Vec<Member>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Member {
    pub id: String,
    pub listing: Option<Listing>,
}

pub(crate) struct Data {
    pub identifier: String,
    pub title: String,
    pub ids: Vec<String>,
    pub expiration: Option<u64>,
}

fn field<'a>(event: &'a Event, name: &str) -> Result<Option<&'a str>> {
    let mut matches = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|tag| tag[0] == name);
    let Some(tag) = matches.next() else {
        return Ok(None);
    };
    ensure!(
        tag.len() == 2 && matches.next().is_none(),
        "Invalid {name} field"
    );
    Ok(Some(&tag[1]))
}

fn identifier(id: &str) -> Result<&str> {
    ensure!(
        !id.is_empty() && id.len() <= 160 && !id.chars().any(char::is_control),
        "Invalid product identifier"
    );
    Ok(id)
}

pub(crate) fn listing_parts(id: &str) -> Result<(PublicKey, &str)> {
    let (author, key) = id.split_once(':').context("Invalid product reference")?;
    let pubkey = PublicKey::from_hex(author)?;
    ensure!(pubkey.to_hex() == author, "Invalid product author");
    Ok((pubkey, identifier(key)?))
}

pub(crate) fn validate_envelope(event: &Event, at: u64) -> Result<()> {
    ensure!(
        event.as_json().len() <= 32768 && event.tags.len() <= 256,
        "Collection is too large"
    );
    ensure!(
        event.created_at.as_secs() <= at.saturating_add(300),
        "Collection timestamp is too far in the future"
    );
    event.verify()?;
    Ok(())
}

pub(crate) fn collection_id(event: &Event) -> Result<&str> {
    ensure!(event.kind.as_u16() == KIND, "Expected a product collection");
    identifier(field(event, "d")?.context("Missing collection identifier")?)
}

fn title(value: &str) -> Result<&str> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.chars().count() <= 160 && !value.chars().any(char::is_control),
        "Enter a collection name of up to 160 characters"
    );
    Ok(value)
}

pub(crate) fn parse(event: &Event) -> Result<Data> {
    let identifier = collection_id(event)?;
    let name = title(field(event, "title")?.context("Missing collection name")?)?;
    let expiration = field(event, "expiration")?
        .map(|value| {
            let digits = value.strip_prefix('+').unwrap_or(value);
            ensure!(
                !digits.is_empty()
                    && digits.len() <= 20
                    && digits.bytes().all(|c| c.is_ascii_digit()),
                "Invalid collection expiry"
            );
            Ok::<u64, anyhow::Error>(digits.parse()?)
        })
        .transpose()?;
    ensure!(
        field(event, "status")?.is_none_or(|v| v == "active")
            && field(event, "visibility")?.is_none_or(|v| matches!(v, "on-sale" | "pre-order")),
        "Collection is hidden"
    );
    let mut ids = Vec::new();
    let mut unique = HashSet::new();
    for id in product_references(event) {
        listing_parts(id)?;
        if unique.insert(id) {
            ids.push(id.to_owned());
        }
    }
    ensure!(
        (1..=MAX_MEMBERS).contains(&ids.len()),
        "Choose between 1 and {MAX_MEMBERS} products"
    );
    Ok(Data {
        identifier: identifier.into(),
        title: name.into(),
        ids,
        expiration,
    })
}

fn product_references(event: &Event) -> impl Iterator<Item = &str> {
    event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        (parts[0] == "a")
            .then(|| parts.get(1)?.strip_prefix("30402:"))
            .flatten()
    })
}

pub(crate) fn save(
    state: &mut State,
    id: Option<String>,
    previous_event_id: Option<String>,
    name: &str,
    ids: &[String],
) -> Result<()> {
    ensure!(!state.demo, "Leave Preview to publish a collection");
    ensure!(
        !state.profile_name_required,
        "Finish profile setup before publishing"
    );
    let keys = state
        .owner_keys
        .as_ref()
        .context("Approve collection signing with your profile key")?;
    let at = listing::now();
    let owner = state.owner.to_hex();
    let previous = match (&id, &previous_event_id) {
        (None, None) => {
            ensure!(
                state
                    .store
                    .collection_targets(&owner, &owner, None, at)?
                    .len()
                    < PROFILE_LIMIT,
                "Your profile can show up to {PROFILE_LIMIT} collections. Edit an existing collection."
            );
            None
        }
        (Some(id), Some(expected)) => {
            let previous = state
                .store
                .visible_collection_event(&owner, identifier(id)?, at)?
                .context("This collection is no longer available")?;
            ensure!(
                previous.id.to_hex() == *expected,
                "This collection changed. Reopen it before editing"
            );
            Some(previous)
        }
        _ => anyhow::bail!("Reopen the collection before editing"),
    };
    let identifier = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let title = title(name)?;
    ensure!(
        (1..=MAX_MEMBERS).contains(&ids.len()),
        "Choose between 1 and {MAX_MEMBERS} products"
    );
    let retained: HashSet<_> = previous.iter().flat_map(product_references).collect();
    let mut seen = HashSet::new();
    for id in ids {
        listing_parts(id)?;
        ensure!(seen.insert(id), "Each product can appear only once");
        if !retained.contains(id.as_str()) {
            ensure!(
                state.store.collection_member(id, &owner, at)?.is_some(),
                "Choose an available product"
            );
        }
    }
    // Preserve external metadata (including shipping references), the description,
    // and relay hints on existing product references.
    let mut tags = Vec::new();
    let mut reference_tags = std::collections::HashMap::new();
    if let Some(previous) = &previous {
        for tag in previous.tags.iter() {
            let parts = tag.as_slice();
            if matches!(parts[0].as_str(), "title" | "d") {
                continue;
            }
            if parts[0] == "a"
                && let Some(id) = parts.get(1).and_then(|v| v.strip_prefix("30402:"))
            {
                reference_tags.entry(id).or_insert(tag);
            } else {
                tags.push(tag.clone());
            }
        }
    }
    tags.push(Tag::identifier(identifier));
    tags.push(Tag::parse(["title", title])?);
    for id in ids {
        tags.push(match reference_tags.get(&id.as_str()) {
            Some(tag) => (*tag).clone(),
            None => Tag::parse(["a", &format!("30402:{id}")])?,
        });
    }
    let timestamp = previous
        .as_ref()
        .map_or(at, |e| at.max(e.created_at.as_secs().saturating_add(1)));
    let content = previous
        .as_ref()
        .map(|e| e.content.clone())
        .unwrap_or_default();
    let event = EventBuilder::new(Kind::Custom(KIND), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(timestamp))
        .sign_with_keys(keys)?;
    ensure!(
        state
            .store
            .ingest_collection(&event, at, true, previous.as_ref().map(|e| e.id))?,
        "Could not save the latest collection revision"
    );
    state.status = "Collection saved · queued".into();
    Ok(())
}
