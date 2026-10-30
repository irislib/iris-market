//! Platform inference only receives bounded public listing text. The core owns
//! the batch and checks context and signed revisions before storing decisions.
use crate::{
    State, ai, listing,
    model::{AiSettings, Listing, Relevance},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub listing: Listing,
    pub event_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Batch {
    pub id: String,
    pub interests: String,
    pub candidates: Vec<Candidate>,
}
#[derive(Debug, Deserialize)]
pub struct Decision {
    pub event_id: String,
    pub show: bool,
    pub reason: String,
}
pub(crate) struct Pending {
    pub batch: Batch,
    settings: AiSettings,
    query: String,
    side: String,
    ai_search: bool,
    started: u64,
}

pub(crate) fn begin(state: &mut State) -> Result<()> {
    ensure!(
        state.settings.ai.enabled && ai::is_local(&state.settings.ai),
        "Choose and enable an on-device model first"
    );
    ensure!(
        state.ai_search && !state.query.trim().is_empty(),
        "Type what you are looking for in the search field"
    );
    let interests = state.query.clone();
    let mut listings = state.snapshot()?.listings;
    crate::search_plan::prioritize(&mut listings, &state.search_terms);
    let candidates = listings
        .into_iter()
        .filter(|l| l.relevance.is_none())
        .take(24)
        .map(|listing| {
            let event_id = state.store.event(&listing.id)?.id.to_hex();
            Ok(Candidate { listing, event_id })
        })
        .collect::<Result<Vec<_>>>()?;
    if !candidates.is_empty() {
        state.search_plan_locked = true;
    }
    state.local_curation = Some(Pending {
        batch: Batch {
            id: uuid::Uuid::new_v4().to_string(),
            interests: interests.clone(),
            candidates,
        },
        settings: state.settings.ai.clone(),
        query: state.query.clone(),
        side: state.side.clone(),
        ai_search: state.ai_search,
        started: listing::now(),
    });
    Ok(())
}

pub(crate) fn apply(
    state: &mut State,
    id: &str,
    decisions: Vec<Decision>,
    partial: bool,
) -> Result<()> {
    let pending = state
        .local_curation
        .as_ref()
        .context("This search has changed; try again")?;
    ensure!(
        pending.batch.id == id
            && pending.settings == state.settings.ai
            && pending.query == state.query
            && pending.side == state.side
            && pending.ai_search == state.ai_search
            && listing::now().saturating_sub(pending.started) <= 300,
        "This search has changed; try again"
    );
    ensure!(
        decisions.len() <= 24
            && if partial {
                !decisions.is_empty() && decisions.len() <= pending.batch.candidates.len()
            } else {
                decisions.len() == pending.batch.candidates.len()
            },
        "Incomplete model response; listings remain visible"
    );
    let mut seen = HashSet::new();
    // Validate the entire supplied subset before writing any decision. Stale signed
    // revisions are omitted, never applied to their replacements.
    let mut accepted = Vec::new();
    for decision in decisions {
        ensure!(
            decision.reason.len() <= 720 && seen.insert(decision.event_id.clone()),
            "Invalid model response; listings remain visible"
        );
        let candidate = pending
            .batch
            .candidates
            .iter()
            .find(|candidate| candidate.event_id == decision.event_id)
            .context("Unknown model result; listings remain visible")?;
        if let Ok(event) = state.store.event(&candidate.listing.id)
            && event.id.to_hex() == candidate.event_id
            && listing::parse(&event, listing::now()).is_ok_and(|listing| {
                listing.status == "active"
                    && listing
                        .expires_at
                        .is_none_or(|expiry| expiry > crate::listing::now())
            })
        {
            accepted.push((
                candidate.listing.id.clone(),
                candidate.event_id.clone(),
                Relevance {
                    show: decision.show,
                    reason: decision.reason.chars().take(180).collect(),
                },
            ));
        }
    }
    state.store.relevance_batch(&accepted)?;
    if partial {
        let pending = state.local_curation.as_mut().unwrap();
        pending
            .batch
            .candidates
            .retain(|candidate| !seen.contains(&candidate.event_id));
        if pending.batch.candidates.is_empty() {
            state.local_curation = None;
        }
    } else {
        state.local_curation = None;
    }
    state.status = format!("Reviewed {} listings", accepted.len());
    Ok(())
}
