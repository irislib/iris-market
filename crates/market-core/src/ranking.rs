//! Marketplace relevance uses the same lexical/AI weights as web/src/ranking.ts.
use crate::{literal_search::normalize, model::Listing, profiles::Profiles};
use std::collections::{BTreeMap, BinaryHeap, HashSet, VecDeque};

struct Head {
    score: f64,
    order: usize,
    author: usize,
}
impl PartialEq for Head {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}
impl Eq for Head {}
impl PartialOrd for Head {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Head {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .total_cmp(&other.score)
            .then_with(|| other.order.cmp(&self.order))
    }
}

fn words(text: &str, max: usize) -> Vec<String> {
    normalize(&text.chars().take(max).collect::<String>())
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}
fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    words(query, 500)
        .into_iter()
        .filter(|word| {
            !matches!(
                word.as_str(),
                "a" | "an"
                    | "the"
                    | "and"
                    | "or"
                    | "for"
                    | "with"
                    | "to"
                    | "in"
                    | "on"
                    | "at"
                    | "of"
                    | "from"
                    | "by"
                    | "near"
                    | "under"
                    | "over"
                    | "my"
                    | "me"
                    | "i"
                    | "want"
                    | "looking"
                    | "find"
                    | "show"
                    | "please"
            ) && seen.insert(word.clone())
        })
        .take(16)
        .collect()
}
fn lexical(listing: &Listing, terms: &[String]) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let title = words(&listing.title, 300);
    let tags = words(
        &std::iter::once(listing.category.as_str())
            .chain(listing.tags.iter().take(16).map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        1200,
    );
    let body = words(&listing.description, 2000);
    let coverage = |values: &[String]| {
        terms.iter().filter(|term| values.contains(term)).count() as f64 / terms.len() as f64
    };
    let phrase = format!(" {} ", title.join(" ")).contains(&format!(" {} ", terms.join(" ")));
    (0.65 * coverage(&title)
        + 0.2 * coverage(&tags)
        + 0.1 * coverage(&body)
        + if phrase { 0.25 } else { 0.0 })
    .min(1.0)
}
fn relevance(listing: &Listing, terms: &[String], query: &str, use_ai: bool) -> f64 {
    let literal = listing
        .search_text_cache
        .lexical(listing, query, || lexical(listing, terms));
    let score = use_ai
        .then_some(listing.relevance.as_ref())
        .flatten()
        .and_then(|r| r.score)
        .filter(|score| score.is_finite() && (0.0..=1.0).contains(score));
    score.map_or(literal, |score| {
        if terms.is_empty() {
            score
        } else {
            0.85 * score + 0.15 * literal
        }
    })
}

pub fn saved_interests(listings: &[Listing]) -> BTreeMap<String, usize> {
    let mut interests = BTreeMap::new();
    let mut saved: Vec<_> = listings.iter().filter(|l| l.saved).collect();
    saved.sort_by(|a, b| a.id.cmp(&b.id));
    for listing in saved.into_iter().take(512) {
        let category = normalize(&listing.category);
        if !category.is_empty() && category != "other" {
            let count = interests.entry(category).or_insert(0usize);
            *count = (*count + 1).min(8);
        }
    }
    let mut entries: Vec<_> = interests.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    entries.into_iter().take(32).collect()
}
pub fn rank(
    listings: &mut Vec<Listing>,
    profiles: &Profiles,
    interests: &BTreeMap<String, usize>,
    query: &str,
    now: u64,
    use_ai: bool,
) {
    let terms = query_terms(query);
    let mut scored: Vec<_> = listings
        .drain(..)
        .map(|listing| {
            let connection = profiles.connection(&listing.author);
            let trust = match connection.follow_distance {
                Some(0 | 1) => 2.5,
                Some(2) => 1.5,
                Some(3) => 0.75,
                _ => 0.0,
            };
            let known = (((connection.followed_by_friends + 1) as f64).log2() / 4.0).min(1.25);
            let freshness = 2.5
                * 0.5_f64.powf(now.saturating_sub(listing.created_at) as f64 / (14.0 * 86400.0));
            let interest =
                (((1 + interests.get(&normalize(&listing.category)).unwrap_or(&0)) as f64).log2()
                    * 0.5)
                    .min(1.5);
            let relevance = relevance(&listing, &terms, query, use_ai);
            (
                listing,
                trust + known + freshness + interest + 32.0 * relevance,
            )
        })
        .collect();
    scored.sort_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    // Bound the diversity pass; older cached inventory remains accessible afterward.
    let remainder = if scored.len() > 1000 {
        scored.split_off(1000)
    } else {
        Vec::new()
    };
    // Only the next listing from each seller can win: every item in that
    // seller's queue has the same diversity penalty. Updating one heap head
    // preserves the greedy order without rescanning the catalogue per result.
    let mut author_indices = BTreeMap::new();
    let mut queues: Vec<VecDeque<(Listing, f64, usize)>> = Vec::new();
    for (order, (listing, score)) in scored.into_iter().enumerate() {
        let next = queues.len();
        let author = *author_indices
            .entry(listing.author.clone())
            .or_insert_with(|| {
                queues.push(VecDeque::new());
                next
            });
        queues[author].push_back((listing, score, order));
    }
    let mut emitted = vec![0; queues.len()];
    let mut heads: BinaryHeap<_> = queues
        .iter()
        .enumerate()
        .map(|(author, queue)| {
            let (_, score, order) = queue.front().unwrap();
            Head {
                score: *score,
                order: *order,
                author,
            }
        })
        .collect();
    while let Some(head) = heads.pop() {
        let queue = &mut queues[head.author];
        let (listing, _, _) = queue.pop_front().unwrap();
        listings.push(listing);
        emitted[head.author] += 1;
        if let Some((_, score, order)) = queue.front() {
            heads.push(Head {
                score: score - (1.5 * emitted[head.author] as f64).min(3.0),
                order: *order,
                author: head.author,
            });
        }
    }
    listings.extend(remainder.into_iter().map(|(listing, _)| listing));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listing(id: &str, author: &str, at: u64) -> Listing {
        serde_json::from_value(serde_json::json!({"id":id,"author":author,"title":"Bicycle","description":"","side":"offer","price":"0","currency":"EUR","location":"","category":"Transport","image_url":null,"created_at":at,"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"published","relevance":null})).unwrap()
    }
    #[test]
    fn cached_text_evidence_survives_snapshots_but_not_query_or_text_changes() {
        let original = listing("cache", &"a".repeat(64), 100);
        assert!(
            original
                .search_text_cache
                .direct(&original, "bicycle", || true)
        );
        assert_eq!(
            original
                .search_text_cache
                .lexical(&original, "bicycle", || 0.75),
            0.75
        );
        let mut next = original.clone();
        for _ in 0..20 {
            assert!(
                next.search_text_cache
                    .direct(&next, "bicycle", || panic!("Repeated direct normalization"))
            );
            assert_eq!(
                next.search_text_cache
                    .lexical(&next, "bicycle", || panic!("Repeated lexical scoring")),
                0.75
            );
        }
        assert!(!next.search_text_cache.direct(&next, "desk", || false));
        next.title = "Desk".into();
        assert!(next.search_text_cache.direct(&next, "desk", || true));
        next.tags.push("bicycle".into());
        assert_eq!(next.search_text_cache.lexical(&next, "desk", || 0.5), 0.5);
        assert!(
            serde_json::to_value(&next)
                .unwrap()
                .get("search_text_cache")
                .is_none()
        );
    }
    #[test]
    fn diverse_authors_remain_visible_and_order_is_deterministic() {
        let p = Profiles::default();
        let now = 1000000;
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let mut items = vec![
            listing("a1", &a, now),
            listing("a2", &a, now),
            listing("b", &b, now),
            listing("c", &c, now),
        ];
        let mut reversed = items.iter().rev().cloned().collect();
        rank(&mut items, &p, &BTreeMap::new(), "", now, false);
        rank(&mut reversed, &p, &BTreeMap::new(), "", now, false);
        assert_eq!(
            items
                .iter()
                .take(3)
                .map(|l| &l.author)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
        assert_eq!(
            items.iter().map(|l| &l.id).collect::<Vec<_>>(),
            reversed.iter().map(|l| &l.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn thousand_listing_catalogue_preserves_seller_diversity_and_stable_ties() {
        let source: Vec<_> = (0..1000)
            .map(|index| {
                listing(
                    &format!("{index:04}"),
                    &format!("{:064x}", index / 50),
                    1000,
                )
            })
            .collect();
        let mut first = source.clone();
        let mut reversed: Vec<_> = source.into_iter().rev().collect();
        for values in [&mut first, &mut reversed] {
            rank(
                values,
                &Profiles::default(),
                &BTreeMap::new(),
                "",
                1000,
                false,
            );
            assert_eq!(values.len(), 1000);
            assert_eq!(
                values
                    .iter()
                    .take(20)
                    .map(|l| &l.author)
                    .collect::<HashSet<_>>()
                    .len(),
                20
            );
        }
        assert_eq!(
            first.iter().map(|l| &l.id).collect::<Vec<_>>(),
            reversed.iter().map(|l| &l.id).collect::<Vec<_>>()
        );
    }
    #[test]
    fn saved_interests_help_and_price_does_not_buy_priority() {
        let p = Profiles::default();
        let mut items = vec![
            listing("a", &"a".repeat(64), 100),
            listing("b", &"b".repeat(64), 100),
        ];
        items[0].category = "Home".into();
        items[0].price = "1000000".into();
        items[1].saved = true;
        let interests = saved_interests(&items);
        rank(&mut items, &p, &interests, "", 100, false);
        assert_eq!(items[0].id, "b");
    }
    #[test]
    fn real_scores_rank_matches_without_turning_direct_hits_into_perfect_scores() {
        let mut direct = listing("direct", &"a".repeat(64), 100);
        direct.direct_match = true;
        direct.relevance = Some(crate::model::Relevance {
            show: false,
            reason: String::new(),
            score: Some(0.05),
            unavailable: false,
        });
        let mut semantic = listing("semantic", &"b".repeat(64), 100);
        semantic.title = "City cycle".into();
        semantic.relevance = Some(crate::model::Relevance {
            show: true,
            reason: String::new(),
            score: Some(0.95),
            unavailable: false,
        });
        let mut items = vec![direct, semantic];
        rank(
            &mut items,
            &Profiles::default(),
            &BTreeMap::new(),
            "bicycle",
            100,
            true,
        );
        assert_eq!(items[0].id, "semantic");
        assert_eq!(items[1].relevance.as_ref().unwrap().score, Some(0.05));
        rank(
            &mut items,
            &Profiles::default(),
            &BTreeMap::new(),
            "bicycle",
            100,
            false,
        );
        assert_eq!(items[0].id, "direct", "Text mode does not use AI decisions");
        let terms = query_terms("bicycle");
        assert!((lexical(&items[0], &terms) - 0.9).abs() < 1e-12);
        assert!(
            (relevance(&items[0], &terms, "bicycle", true) - (0.85 * 0.05 + 0.15 * 0.9)).abs()
                < 1e-12
        );
    }
}
