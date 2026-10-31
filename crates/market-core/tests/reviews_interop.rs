//! Signed, disposable local fixtures produced by the actual browser review codec.
//! No network, account credentials, public publication or mint is involved.
use iris_market_core::reviews;
use nostr::{Event, JsonUtil};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Fixtures {
    version: u8,
    now: u64,
    events: BTreeMap<String, Event>,
    cases: Vec<Case>,
    invalid: Vec<Invalid>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    product: bool,
    target: String,
    events: Vec<String>,
    expected: Vec<Expected>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    event: String,
    rating: f64,
    rating_max: u8,
    body: String,
}
#[derive(Deserialize)]
struct Invalid {
    event: String,
    product: bool,
    target: String,
}
fn fixtures() -> Fixtures {
    let fixtures: Fixtures =
        serde_json::from_str(include_str!("fixtures/reviews-interop.json")).unwrap();
    assert_eq!(fixtures.version, 1);
    fixtures
}
fn check_case(fixtures: &Fixtures, case: &Case) {
    let events = case
        .events
        .iter()
        .map(|name| fixtures.events[name].clone())
        .collect::<Vec<_>>();
    let mut actual = reviews::project(&events, &case.target, case.product, fixtures.now);
    actual.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(
        actual.len(),
        case.expected.len(),
        "{}: projection count",
        case.name
    );
    for (actual, expected) in actual.iter().zip(&case.expected) {
        assert_eq!(
            actual.id,
            fixtures.events[&expected.event].id.to_hex(),
            "{}: winner",
            case.name
        );
        assert_eq!(actual.target, case.target, "{}: exact subject", case.name);
        assert_eq!(
            actual.rating_max, expected.rating_max,
            "{}: native scale",
            case.name
        );
        assert!(
            (actual.rating - expected.rating).abs() < 1e-12,
            "{}: score",
            case.name
        );
        assert_eq!(actual.body, expected.body, "{}: body", case.name);
    }
    let mut reversed = events;
    reversed.reverse();
    let mut unordered = reviews::project(&reversed, &case.target, case.product, fixtures.now);
    unordered.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(
        actual.iter().map(|r| &r.id).collect::<Vec<_>>(),
        unordered.iter().map(|r| &r.id).collect::<Vec<_>>(),
        "{}: arrival order",
        case.name
    );
}
#[test]
fn actual_web_profile_drafts_keep_one_signed_voice_and_star_scale() {
    let fixtures = fixtures();
    for case in fixtures.cases.iter().filter(|case| !case.product) {
        check_case(&fixtures, case);
    }
}
#[test]
fn signed_product_formats_replacement_and_deletion_match_web_projection() {
    let fixtures = fixtures();
    for case in fixtures.cases.iter().filter(|case| case.product) {
        check_case(&fixtures, case);
    }
}
#[test]
fn self_reviews_forged_signatures_ambiguous_fields_and_wrong_scales_are_rejected() {
    let fixtures = fixtures();
    for invalid in &fixtures.invalid {
        let event = &fixtures.events[&invalid.event];
        // Serde retains invalid signatures for the parser to authenticate itself.
        let copied = Event::from_json(event.as_json()).unwrap();
        let result = if invalid.product {
            reviews::parse_product(&copied, &invalid.target, fixtures.now)
        } else {
            reviews::parse_profile(&copied, &invalid.target, fixtures.now)
        };
        assert!(result.is_err(), "{} must be rejected", invalid.event);
    }
}
#[test]
fn profile_stars_and_product_native_dimensions_never_mix() {
    let fixtures = fixtures();
    for case in fixtures
        .cases
        .iter()
        .filter(|case| case.name.contains("ignores_"))
    {
        check_case(&fixtures, case);
        assert!(case.expected.iter().all(|review| if case.product {
            review.rating_max == 1 && (0.0..=1.0).contains(&review.rating)
        } else {
            review.rating_max == 5 && (1.0..=5.0).contains(&review.rating)
        }));
    }
}
