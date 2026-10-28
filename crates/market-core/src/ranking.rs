//! A transparent marketplace ordering, shared in policy with web/src/ranking.js.
use crate::{model::Listing, profiles::Profiles};
use std::collections::BTreeMap;

pub fn saved_interests(listings: &[Listing]) -> BTreeMap<String, usize> {
    let mut interests = BTreeMap::new();
    for listing in listings.iter().filter(|l| l.saved) {
        let category = listing.category.trim().to_lowercase();
        if !category.is_empty() && category != "other" {
            *interests.entry(category).or_default() += 1;
        }
    }
    interests
}
pub fn rank(
    listings: &mut Vec<Listing>,
    profiles: &Profiles,
    interests: &BTreeMap<String, usize>,
    query: &str,
    now: u64,
) {
    let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut scored: Vec<_> = listings
        .drain(..)
        .map(|listing| {
            let connection = profiles.connection(&listing.author);
            let trust = match connection.follow_distance {
                Some(0 | 1) => 8.0,
                Some(2) => 4.0,
                Some(3) => 2.0,
                _ => 0.0,
            };
            let known = ((connection.followed_by_friends + 1) as f64)
                .log2()
                .min(2.0);
            let freshness = 4.0
                * 0.5_f64.powf(now.saturating_sub(listing.created_at) as f64 / (14.0 * 86400.0));
            let interest = (*interests
                .get(&listing.category.trim().to_lowercase())
                .unwrap_or(&0))
            .min(3) as f64;
            let title = listing.title.to_lowercase();
            let relevance = if terms.is_empty() {
                0.0
            } else {
                2.0 * terms
                    .iter()
                    .filter(|term| title.contains(term.as_str()))
                    .count() as f64
                    / terms.len() as f64
            };
            (listing, trust + known + freshness + interest + relevance)
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
    let mut authors = BTreeMap::<String, usize>::new();
    while !scored.is_empty() {
        let mut best = 0;
        let mut best_score = f64::NEG_INFINITY;
        for (index, (listing, score)) in scored.iter().enumerate() {
            let adjusted = score - 6.0 * *authors.get(&listing.author).unwrap_or(&0) as f64;
            if adjusted > best_score {
                best = index;
                best_score = adjusted;
            }
            if *score < best_score {
                break;
            }
        }
        let (listing, _) = scored.remove(best);
        *authors.entry(listing.author.clone()).or_default() += 1;
        listings.push(listing);
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
        rank(&mut items, &p, &BTreeMap::new(), "", now);
        rank(&mut reversed, &p, &BTreeMap::new(), "", now);
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
        rank(&mut items, &p, &interests, "", 100);
        assert_eq!(items[0].id, "b");
    }
}
