//! Optional AI retrieval hints, never relevance decisions or literal expansion.
use crate::{State, literal_search, model::Listing};
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, HashSet};

pub(crate) fn catalog(listings: &[Listing]) -> Vec<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for listing in listings {
        let mut seen = HashSet::new();
        for tag in std::iter::once(&listing.category).chain(listing.tags.iter().take(24)) {
            if valid(tag) && seen.insert(tag) {
                *counts.entry(tag.clone()).or_default() += 1;
            }
        }
    }
    let mut values: Vec<_> = counts.into_iter().collect();
    values.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    values.into_iter().take(128).map(|(tag, _)| tag).collect()
}

pub(crate) fn valid(term: &str) -> bool {
    !term.trim().is_empty()
        && term.chars().count() <= 60
        && !term.chars().any(char::is_control)
        && term.chars().any(char::is_alphanumeric)
}

pub(crate) fn apply(state: &mut State, generation: u64, terms: Vec<String>) -> Result<()> {
    ensure!(
        state.ai_search
            && !state.query.trim().is_empty()
            && state.settings.ai.enabled
            && state.search_request == generation
            && !state.search_plan_applied
            && !state.search_plan_locked,
        "This search has changed; ignore the plan"
    );
    ensure!(
        terms.len() <= 8 && terms.iter().all(|term| valid(term)),
        "Invalid search plan"
    );
    let mut seen = HashSet::new();
    state.search_terms = terms
        .into_iter()
        .map(|term| term.trim().to_owned())
        .filter(|term| seen.insert(term.to_lowercase()))
        .collect();
    state.search_plan_applied = true;
    Ok(())
}

pub(crate) fn related_terms(query: &str, terms: &[String]) -> Vec<String> {
    if terms.is_empty() {
        return Vec::new();
    }
    let query = literal_search::normalize(query);
    let mut seen: HashSet<String> = query.split_whitespace().map(str::to_owned).collect();
    seen.insert(query);
    terms
        .iter()
        .filter(|term| seen.insert(literal_search::normalize(term)))
        .cloned()
        .collect()
}

pub(crate) fn prioritize(listings: &mut [Listing], terms: &[String]) {
    if terms.is_empty() {
        return;
    }
    // Stable sorting retains ordinary ranking within each evidence tier.
    // A title is stronger evidence than incidental description mentions.
    let phrases: Vec<_> = terms
        .iter()
        .map(|term| literal_search::normalize(term))
        .collect();
    listings.sort_by_cached_key(|listing| {
        let title = literal_search::normalize(&listing.title);
        let tags: Vec<_> = std::iter::once(&listing.category)
            .chain(&listing.tags)
            .map(|tag| literal_search::normalize(tag))
            .collect();
        let description = literal_search::normalize(&listing.description);
        let count = |text: &str| {
            phrases
                .iter()
                .filter(|phrase| literal_search::matches_normalized(text, phrase))
                .count()
        };
        let matched_tags = phrases
            .iter()
            .filter(|phrase| {
                tags.iter()
                    .any(|tag| literal_search::matches_normalized(tag, phrase))
            })
            .count();
        std::cmp::Reverse((count(&title), matched_tags, count(&description)))
    });
}
