use iris_market_core::{listing, model::Draft};
use nostr::{EventBuilder, Keys, Tag, Timestamp};
use serde_json::json;

#[test]
fn explicit_courier_topics_round_trip_in_signed_listings_and_closed_revisions() {
    let keys = Keys::generate();
    let draft: Draft = serde_json::from_value(json!({"title":"Parcel delivery","description":"Small parcels","side":"offer","category":"transport","tags":["#Courier","parcel","COURIER","Transport"]})).unwrap();
    let event = listing::build(&keys, &draft, "delivery", 100, false).unwrap();
    let tags: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice()[0] == "t")
        .map(|tag| tag.as_slice()[1].clone())
        .collect();
    assert_eq!(tags, ["transport", "courier", "parcel"]);
    let parsed = listing::parse(&event, 100).unwrap();
    assert_eq!(parsed.tags, tags);
    let closed =
        listing::build(&keys, &listing::draft_from(&parsed), "delivery", 101, true).unwrap();
    assert_eq!(listing::parse(&closed, 101).unwrap().tags, tags);
}

#[test]
fn older_drafts_need_no_tags_and_invalid_or_excess_topics_are_rejected() {
    let mut draft: Draft =
        serde_json::from_value(json!({"title":"Old listing","description":"","side":"offer"}))
            .unwrap();
    assert!(draft.tags.is_empty());
    assert!(draft.service_areas.is_none());
    assert!(listing::validate(&draft).is_ok());
    draft.tags = vec!["courier".into(); 25];
    assert!(listing::validate(&draft).is_err());
    for bad in [
        "",
        "two words",
        "courier\npassenger",
        "https://private.example",
    ] {
        draft.tags = vec![bad.into()];
        assert!(listing::validate(&draft).is_err());
    }
}

#[test]
fn courier_area_indexes_are_not_displayed_as_listing_point_locations() {
    let keys = Keys::generate();
    let draft: Draft = serde_json::from_value(json!({"title":"Delivery service","description":"Parcels","side":"offer","tags":["courier","parcel"]})).unwrap();
    let base = listing::build(&keys, &draft, "courier", 100, false).unwrap();
    let tags: Vec<Tag> = base
        .tags
        .iter()
        .cloned()
        .chain([
            Tag::parse(["g", "u60", "pickup"]).unwrap(),
            Tag::parse(["g", "u601", "destination"]).unwrap(),
        ])
        .collect();
    let area = EventBuilder::new(base.kind, base.content.clone())
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(100))
        .sign_with_keys(&keys)
        .unwrap();
    assert!(listing::parse(&area, 100).unwrap().coordinates.is_none());
    let point = EventBuilder::new(base.kind, base.content)
        .tags(tags.into_iter().chain([Tag::parse(["g", "u60"]).unwrap()]))
        .custom_created_at(Timestamp::from(101))
        .sign_with_keys(&keys)
        .unwrap();
    assert_eq!(
        listing::parse(&point, 101).unwrap().coordinates,
        iris_market_core::geo::decode("u60")
    );
}

#[test]
fn signed_service_areas_survive_listing_and_closed_revision_roundtrips() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/service-areas-v1.json")).unwrap();
    let areas: iris_market_core::service_area::ServiceAreas =
        serde_json::from_value(fixtures["cases"][0]["areas"].clone()).unwrap();
    let keys = Keys::generate();
    let draft: Draft = serde_json::from_value(json!({"title":"Parcel courier","description":"Within the advertised areas","side":"offer","category":"transport","tags":["courier","parcel"],"serviceAreas":areas})).unwrap();
    let event = listing::build(&keys, &draft, "areas", 100, false).unwrap();
    let parsed = listing::parse(&event, 100).unwrap();
    assert_eq!(parsed.service_areas.as_ref(), Some(&areas));
    assert!(parsed.coordinates.is_none());
    let tags: Vec<_> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    assert_eq!(
        iris_market_core::service_area::parse_tags(&tags),
        Some(areas.clone())
    );
    assert!(
        tags.iter()
            .filter(|tag| tag[0] == "g")
            .all(|tag| tag.len() == 3)
    );
    let closed = listing::build(&keys, &listing::draft_from(&parsed), "areas", 101, true).unwrap();
    let closed = listing::parse(&closed, 101).unwrap();
    assert_eq!(closed.service_areas, Some(areas));
    assert_eq!(closed.status, "sold");
}

#[test]
fn publisher_rejects_invalid_area_geometry_and_oversized_signed_payloads() {
    let keys = Keys::generate();
    let mut draft: Draft = serde_json::from_value(json!({"title":"Courier","description":"","side":"offer","service_areas":{"pickup":{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,1],[0,0]]]},"destination":{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}}})).unwrap();
    assert!(listing::build(&keys, &draft, "invalid", 100, false).is_err());
    draft.service_areas = None;
    // The plain description fits its input bound but JSON escaping exceeds the signed-event limit.
    draft.description = "\0".repeat(12_000);
    assert!(listing::validate(&draft).is_ok());
    assert!(
        listing::build(&keys, &draft, "oversized", 100, false)
            .unwrap_err()
            .to_string()
            .contains("too large")
    );
}

#[test]
fn indexed_buying_marker_preserves_category_and_legacy_side_authority() {
    let keys = Keys::generate();
    let draft:Draft=serde_json::from_value(json!({"title":"Wanted bicycle","description":"","side":"request","category":"transport","tags":["bicycle"]})).unwrap();
    let indexed = listing::build(&keys, &draft, "wanted", 100, false).unwrap();
    let parsed = listing::parse(&indexed, 100).unwrap();
    assert_eq!(parsed.side, "request");
    assert_eq!(parsed.category, "transport");
    assert_eq!(parsed.tags, ["transport", "bicycle"]);
    let marker_only = EventBuilder::new(indexed.kind, indexed.content.clone())
        .tags(
            indexed
                .tags
                .iter()
                .filter(|tag| tag.as_slice()[0] != "market")
                .cloned(),
        )
        .custom_created_at(Timestamp::from(100))
        .sign_with_keys(&keys)
        .unwrap();
    assert_eq!(listing::parse(&marker_only, 100).unwrap().side, "request");
    let explicit_offer = EventBuilder::new(marker_only.kind, marker_only.content.clone())
        .tags(
            marker_only
                .tags
                .iter()
                .cloned()
                .chain([Tag::parse(["market", "offer"]).unwrap()]),
        )
        .custom_created_at(Timestamp::from(100))
        .sign_with_keys(&keys)
        .unwrap();
    assert_eq!(listing::parse(&explicit_offer, 100).unwrap().side, "offer");
}
