//! Public ratings, interoperable with the web fact envelopes and NIP-99 product reviews.
use anyhow::{Context, Result, ensure};
use nostr::{
    Alphabet, Event, EventBuilder, Filter, JsonUtil, Keys, Kind, PublicKey, SingleLetterTag, Tag,
    Timestamp,
};
use nostr_pubsub::{EventBus, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub author: String,
    pub subject: String,
    pub target: String,
    pub rating: f64,
    pub rating_max: u8,
    pub body: String,
    pub updated_at: u64,
}
fn tags(event: &Event) -> Vec<&[String]> {
    event.tags.iter().map(|tag| tag.as_slice()).collect()
}
fn one<'a>(event: &'a Event, name: &str) -> Result<&'a [String]> {
    let found: Vec<_> = event
        .tags
        .iter()
        .filter(|t| t.as_slice()[0] == name)
        .collect();
    ensure!(found.len() == 1, "Ambiguous review field");
    Ok(found[0].as_slice())
}
fn value<'a>(event: &'a Event, name: &str) -> Result<&'a str> {
    let t = one(event, name)?;
    ensure!(t.len() == 2, "Invalid review field");
    Ok(&t[1])
}
fn key(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn address(s: &str) -> bool {
    let p: Vec<_> = s.splitn(3, ':').collect();
    p.len() == 3
        && p[0] == "30402"
        && key(p[1])
        && !p[2].is_empty()
        && p[2].len() <= 512
        && !p[2].chars().any(char::is_control)
}
fn decimal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16 && value.bytes().all(|c| c.is_ascii_digit())
}
fn product_number(value: &str) -> bool {
    let parts: Vec<_> = value.split(['e', 'E']).collect();
    if parts.len() > 2 {
        return false;
    }
    if parts.len() == 2 {
        let exponent = parts[1].strip_prefix(['+', '-']).unwrap_or(parts[1]);
        if exponent.is_empty() || !exponent.bytes().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    let mantissa: Vec<_> = parts[0].split('.').collect();
    if mantissa.len() > 2 {
        return false;
    }
    if mantissa.len() == 1 {
        return !mantissa[0].is_empty() && mantissa[0].bytes().all(|c| c.is_ascii_digit());
    }
    mantissa[0].bytes().all(|c| c.is_ascii_digit())
        && !mantissa[1].is_empty()
        && mantissa[1].bytes().all(|c| c.is_ascii_digit())
}
fn valid_event(event: &Event, now: u64) -> bool {
    event.as_json().len() <= 8192
        && event.created_at.as_secs() <= now + 300
        && event.verify().is_ok()
        && event.tags.len() <= 64
        && tags(event)
            .iter()
            .all(|t| t.len() <= 4 && t.iter().all(|s| s.len() <= 12000))
}
pub fn parse_profile(event: &Event, target: &str, now: u64) -> Result<Review> {
    ensure!(
        valid_event(event, now)
            && event.kind.as_u16() == 7368
            && event.content.is_empty()
            && event.tags.len() <= 24,
        "Invalid review"
    );
    let author = event.pubkey.to_hex();
    ensure!(
        key(target)
            && target != author
            && value(event, "review_of")? == target
            && value(event, "reviewer")? == author,
        "Invalid reviewer"
    );
    let raw = tags(event);
    let subjects: Vec<_> = raw
        .iter()
        .filter(|t| t[0] == "i" && t.get(2).is_some_and(|s| s == "subject"))
        .collect();
    ensure!(
        subjects.len() == 1 && subjects[0].len() == 3,
        "Invalid review identifier"
    );
    let subject = &subjects[0][1];
    ensure!(
        uuid::Uuid::parse_str(subject).is_ok_and(|u| u.to_string() == *subject),
        "Invalid review identifier"
    );
    ensure!(
        value(event, "type")? == "review"
            && value(event, "source")? == "iris-market"
            && value(event, "source_id")? == format!("iris-market:review:{subject}"),
        "Invalid review source"
    );
    let rating = one(event, "rating")?;
    ensure!(
        rating.len() == 3
            && rating[2] == "5"
            && ["1", "2", "3", "4", "5"].contains(&rating[1].as_str()),
        "Invalid rating"
    );
    let body = if raw.iter().any(|t| t[0] == "body") {
        value(event, "body")?
    } else {
        ""
    };
    ensure!(body.chars().count() <= 3000, "Review is too long");
    let allowed = [
        "i",
        "p",
        "type",
        "reviewer",
        "review_of",
        "rating",
        "body",
        "source",
        "source_id",
        "published_at",
        "updated_at",
    ];
    ensure!(
        raw.iter().all(|t| allowed.contains(&t[0].as_str())),
        "Unsupported review fields"
    );
    let indexes: Vec<_> = raw
        .iter()
        .filter(|t| t[0] == "i" && t.get(2).is_none())
        .collect();
    let expected: BTreeSet<_> = [
        format!("iris-market:profile:{target}"),
        format!("iris-market:review:{subject}"),
        author.clone(),
    ]
    .into_iter()
    .collect();
    ensure!(
        indexes.len() == 3
            && indexes.iter().all(|t| t.len() == 2)
            && indexes
                .iter()
                .map(|t| t[1].clone())
                .collect::<BTreeSet<_>>()
                == expected,
        "Invalid review indexes"
    );
    let people: Vec<_> = raw.iter().filter(|t| t[0] == "p").collect();
    ensure!(
        people.len() == 2
            && people.iter().all(|t| t.len() == 2)
            && people.iter().map(|t| t[1].clone()).collect::<BTreeSet<_>>()
                == [target.to_owned(), author.clone()].into_iter().collect(),
        "Invalid review people"
    );
    ensure!(
        decimal(value(event, "published_at")?) && decimal(value(event, "updated_at")?),
        "Invalid review time"
    );
    let created: u64 = value(event, "published_at")?.parse()?;
    let updated: u64 = value(event, "updated_at")?.parse()?;
    ensure!(
        created <= updated
            && updated <= event.created_at.as_secs()
            && event.created_at.as_secs() - updated <= 300,
        "Invalid review time"
    );
    Ok(Review {
        id: event.id.to_hex(),
        author,
        subject: subject.clone(),
        target: target.into(),
        rating: rating[1].parse()?,
        rating_max: 5,
        body: body.into(),
        updated_at: updated,
    })
}
fn product_target(event: &Event) -> Option<String> {
    let d = value(event, "d").ok()?;
    let normalized = d.strip_prefix("a:").unwrap_or(d);
    if address(normalized) {
        Some(normalized.into())
    } else {
        value(event, "a")
            .ok()
            .filter(|s| address(s))
            .map(str::to_owned)
    }
}
fn product_hint(event: &Event) -> Option<String> {
    let first = |name: &str| {
        event
            .tags
            .iter()
            .find(|t| t.as_slice()[0] == name)
            .and_then(|t| t.as_slice().get(1))
    };
    for value in [first("d"), first("a")].into_iter().flatten() {
        let normalized = value.strip_prefix("a:").unwrap_or(value);
        if address(normalized) {
            return Some(normalized.into());
        }
    }
    None
}
fn coordinate(event: &Event) -> Option<String> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice()[0] == "d")
        .and_then(|t| t.as_slice().get(1))
        .filter(|d| !d.is_empty())
        .map(|d| format!("31555:{}:{d}", event.pubkey))
}
pub fn parse_product(event: &Event, target: &str, now: u64) -> Result<Review> {
    ensure!(
        valid_event(event, now)
            && event.kind.as_u16() == 31555
            && address(target)
            && tags(event)
                .iter()
                .all(|t| t.iter().all(|v| v.len() <= 2048)),
        "Invalid product review"
    );
    let d = value(event, "d")?;
    ensure!(
        !d.is_empty() && d.len() <= 1024 && product_target(event).as_deref() == Some(target),
        "Invalid product review target"
    );
    let from_d = d.strip_prefix("a:").unwrap_or(d);
    if tags(event).iter().any(|t| t[0] == "a") {
        let a = value(event, "a")?;
        ensure!(
            address(a) && a == target && (!address(from_d) || from_d == a),
            "Ambiguous product target"
        );
    }
    ensure!(
        target.split(':').nth(1) != Some(event.pubkey.to_hex().as_str()),
        "Self-review"
    );
    if tags(event).iter().any(|t| t[0] == "expiration") {
        ensure!(
            decimal(value(event, "expiration")?)
                && value(event, "expiration")?.parse::<u64>()? > now,
            "Expired review"
        );
    }
    ensure!(event.content.chars().count() <= 3000, "Review is too long");
    let mut dimensions = BTreeMap::new();
    for t in tags(event).iter().filter(|t| t[0] == "rating") {
        ensure!(
            t.len() == 3
                && t[2].len() <= 48
                && t[2].chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && t[2]
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'),
            "Invalid rating dimension"
        );
        ensure!(product_number(&t[1]), "Invalid rating number");
        let n: f64 = t[1].parse()?;
        ensure!(
            n.is_finite()
                && (0.0..=1.0).contains(&n)
                && dimensions.insert(t[2].clone(), n).is_none(),
            "Invalid rating"
        );
    }
    Ok(Review {
        id: event.id.to_hex(),
        author: event.pubkey.to_hex(),
        subject: d.into(),
        target: target.into(),
        rating: *dimensions.get("thumb").context("Missing rating")?,
        rating_max: 1,
        body: event.content.clone(),
        updated_at: event.created_at.as_secs(),
    })
}
pub fn project(events: &[Event], target: &str, product: bool, now: u64) -> Vec<Review> {
    let mut sorted: Vec<_> = events.iter().filter(|e| valid_event(e, now)).collect();
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    let mut result = Vec::new();
    let mut authors = BTreeSet::new();
    let mut coordinates = BTreeSet::new();
    for event in &sorted {
        if product {
            if event.kind.as_u16() != 31555 {
                continue;
            }
            let Some(coordinate) = coordinate(event) else {
                continue;
            };
            if !coordinates.insert(coordinate.clone()) {
                continue;
            }
            if product_hint(event).as_deref() != Some(target) || !authors.insert(event.pubkey) {
                continue;
            }
            if sorted.iter().any(|d| {
                d.kind.as_u16() == 5
                    && d.pubkey == event.pubkey
                    && tags(d).iter().any(|t| {
                        t.len() >= 2
                            && (t[0] == "e" && t[1] == event.id.to_hex()
                                || t[0] == "a"
                                    && t[1] == coordinate
                                    && event.created_at <= d.created_at)
                    })
            }) {
                continue;
            }
            if let Ok(review) = parse_product(event, target, now) {
                result.push(review);
            }
        } else if let Ok(review) = parse_profile(event, target, now)
            && authors.insert(event.pubkey)
        {
            result.push(review);
        }
        if result.len() == 128 {
            break;
        }
    }
    result
}
pub fn build_profile(keys: &Keys, target: &str, rating: u8, body: &str, now: u64) -> Result<Event> {
    let author = keys.public_key().to_hex();
    ensure!(
        key(target)
            && target != author
            && (1..=5).contains(&rating)
            && body.chars().count() <= 3000,
        "Choose a person, rating and review of up to 3000 characters."
    );
    let subject = uuid::Uuid::new_v4().to_string();
    let rating = rating.to_string();
    let at = now.to_string();
    let index = format!("iris-market:profile:{target}");
    let source = format!("iris-market:review:{subject}");
    let raw = vec![
        vec!["i", &subject, "subject"],
        vec!["i", &index],
        vec!["i", &source],
        vec!["i", &author],
        vec!["p", target],
        vec!["p", &author],
        vec!["type", "review"],
        vec!["reviewer", &author],
        vec!["review_of", target],
        vec!["rating", &rating, "5"],
        vec!["body", body.trim()],
        vec!["source", "iris-market"],
        vec!["source_id", &source],
        vec!["published_at", &at],
        vec!["updated_at", &at],
    ];
    let tags = raw
        .into_iter()
        .map(Tag::parse)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let event = EventBuilder::new(Kind::Custom(7368), "")
        .allow_self_tagging()
        .tags(tags)
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(keys)?;
    parse_profile(&event, target, now)?;
    Ok(event)
}
fn merged(old: Vec<Event>, new: Vec<Event>) -> Vec<Event> {
    let mut events: BTreeMap<_, _> = old
        .into_iter()
        .chain(new)
        .filter(|e| valid_event(e, crate::listing::now()))
        .map(|e| (e.id, e))
        .collect();
    let mut events: Vec<_> = std::mem::take(&mut events).into_values().collect();
    events.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    let mut bytes = 0;
    events
        .into_iter()
        .take(512)
        .take_while(|e| {
            bytes += e.as_json().len() + 1;
            bytes < 1_040_000
        })
        .collect()
}
async fn fetch(relays: Vec<String>, target: &str, product: bool) -> Result<Vec<Event>> {
    let bus = RelayEventBus::new(relays, Duration::from_secs(3)).await?;
    let result = tokio::time::timeout(Duration::from_secs(6), async {
        let tag = |c| SingleLetterTag::lowercase(c);
        let filters = if product {
            vec![
                Filter::new()
                    .kind(Kind::Custom(31555))
                    .custom_tags(tag(Alphabet::D), [target.to_owned(), format!("a:{target}")])
                    .limit(128),
                Filter::new()
                    .kind(Kind::Custom(31555))
                    .custom_tags(tag(Alphabet::A), [target.to_owned()])
                    .limit(128),
            ]
        } else {
            vec![
                Filter::new()
                    .kind(Kind::Custom(7368))
                    .custom_tags(tag(Alphabet::I), [format!("iris-market:profile:{target}")])
                    .limit(256),
            ]
        };
        let report = bus
            .query(filters, QueryOptions { limit: Some(256) })
            .await?;
        let mut events: Vec<Event> = report
            .events
            .into_iter()
            .map(|e| e.event.as_event().clone())
            .collect();
        if product {
            let known: Vec<_> = events
                .iter()
                .filter(|e| {
                    e.kind.as_u16() == 31555
                        && valid_event(e, crate::listing::now())
                        && product_hint(e).as_deref() == Some(target)
                })
                .cloned()
                .collect();
            if !known.is_empty() {
                let authors: Vec<PublicKey> = known.iter().map(|e| e.pubkey).collect();
                let identifiers: Vec<String> = known
                    .iter()
                    .filter_map(|e| value(e, "d").ok().map(str::to_owned))
                    .collect();
                let controls = bus
                    .query(
                        vec![
                            Filter::new()
                                .kind(Kind::Custom(31555))
                                .authors(authors.clone())
                                .custom_tags(tag(Alphabet::D), identifiers)
                                .limit(128),
                        ],
                        QueryOptions { limit: Some(128) },
                    )
                    .await?;
                let coordinates: BTreeSet<_> = known.iter().filter_map(coordinate).collect();
                events.extend(
                    controls
                        .events
                        .into_iter()
                        .map(|e| e.event.as_event().clone())
                        .filter(|e| coordinate(e).is_some_and(|c| coordinates.contains(&c))),
                );
                let ids: Vec<_> = events.iter().map(|e| e.id.to_hex()).collect();
                let deletes = bus
                    .query(
                        vec![
                            Filter::new()
                                .kind(Kind::EventDeletion)
                                .authors(authors.clone())
                                .custom_tags(tag(Alphabet::E), ids)
                                .limit(128),
                            Filter::new()
                                .kind(Kind::EventDeletion)
                                .authors(authors)
                                .custom_tags(tag(Alphabet::A), coordinates)
                                .limit(128),
                        ],
                        QueryOptions { limit: Some(256) },
                    )
                    .await?;
                events.extend(
                    deletes
                        .events
                        .into_iter()
                        .map(|e| e.event.as_event().clone()),
                );
            }
        }
        Ok::<_, anyhow::Error>(events)
    })
    .await;
    bus.client().shutdown().await;
    result.context("Reviews are still loading")?
}
impl crate::Market {
    pub fn reviews(&self, target: String, product: bool, refresh: bool) -> Result<String> {
        ensure!(
            if product {
                address(&target)
            } else {
                key(&target)
            },
            "Invalid review target"
        );
        let cache_key = format!("{}:{target}", if product { "product" } else { "profile" });
        let (cached, relays, demo) = {
            let s = self.state.lock().unwrap();
            (
                s.store.review_events(&cache_key)?,
                s.settings.relays.clone(),
                s.demo,
            )
        };
        let events = if refresh && !demo {
            let runtime = self
                .runtime
                .lock()
                .unwrap()
                .as_ref()
                .context("App is closed")?
                .handle()
                .clone();
            merged(
                cached,
                runtime
                    .block_on(fetch(relays, &target, product))
                    .unwrap_or_default(),
            )
        } else {
            cached
        };
        let s = self.state.lock().unwrap();
        s.store.save_review_events(&cache_key, &events)?;
        let reviews = project(&events, &target, product, crate::listing::now());
        let rows: Vec<_> = reviews
            .iter()
            .map(|review| {
                let person = s.profiles.profile(&review.author).person;
                let mut row = serde_json::to_value(review).unwrap();
                row["person"] = serde_json::to_value(person).unwrap();
                row
            })
            .collect();
        Ok(serde_json::to_string(&rows)?)
    }
    pub fn publish_review(&self, target: String, rating: u8, body: String) -> Result<String> {
        let mut s = self.state.lock().unwrap();
        ensure!(!s.demo, "Leave Preview to publish a review.");
        let keys = s
            .owner_keys
            .as_ref()
            .context("Sign in with your profile key to publish a review.")?;
        let event = build_profile(keys, &target, rating, &body, crate::listing::now())?;
        let cache_key = format!("profile:{target}");
        let events = merged(s.store.review_events(&cache_key)?, vec![event.clone()]);
        s.store.queue_event(&event)?;
        s.store.save_review_events(&cache_key, &events)?;
        s.revision += 1;
        self.notify.notify_one();
        drop(s);
        self.reviews(target, false, false)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_profile_review_is_one_voice_per_author() {
        let a = Keys::generate();
        let target = Keys::generate().public_key().to_hex();
        let first = build_profile(&a, &target, 2, "Old", 10).unwrap();
        let next = build_profile(&a, &target, 5, "New", 11).unwrap();
        let reviews = project(&[first, next], &target, false, 12);
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].rating, 5.0);
        assert!(build_profile(&a, &a.public_key().to_hex(), 5, "Self", 12).is_err());
    }
    #[test]
    fn invalid_signature_is_never_counted() {
        let a = Keys::generate();
        let target = Keys::generate().public_key().to_hex();
        let e = build_profile(&a, &target, 5, "Good", 10).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&e.as_json()).unwrap();
        raw["content"] = "edited".into();
        let changed = Event::from_json(raw.to_string()).unwrap();
        assert!(project(&[changed], &target, false, 12).is_empty());
    }
}
