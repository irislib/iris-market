//! Read-only NIP-69 quotes. The coordinator signs the order and is not the trader.
use crate::model::Listing;
use anyhow::Result;
use nostr::{
    Event,
    nips::nip01::Coordinate,
    nips::nip19::{Nip19Coordinate, ToBech32},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub platform: String,
    pub amounts: Vec<String>,
    pub methods: String,
    pub link: String,
}

fn values<'a>(event: &'a Event, key: &str) -> &'a [String] {
    let mut rows = event
        .tags
        .iter()
        .map(|tag| tag.as_slice())
        .filter(|tag| tag[0] == key);
    match (rows.next(), rows.next()) {
        (Some(row), None) => &row[1..],
        _ => &[],
    }
}

fn decimal(value: &str) -> bool {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    (1..=15).contains(&whole.len())
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.len() <= 8
        && fraction.bytes().all(|b| b.is_ascii_digit())
        && !value.ends_with('.')
        && value.parse::<f64>().is_ok_and(|n| n > 0.)
}

/// Called after signature, coordinate and timestamp validation. Malformed or terminal
/// revisions still close an older active quote at the same replaceable address.
pub fn parse(event: &Event, id: &str) -> Result<Listing> {
    let text = |k: &str| values(event, k).first().map(String::as_str).unwrap_or("");
    let platform = text("y");
    let amounts = values(event, "fa");
    let currency = text("f");
    let buy = text("k") == "buy";
    let deadlines = ["expiration", "expires_at"]
        .into_iter()
        .filter(|key| event.tags.iter().any(|tag| tag.as_slice()[0] == *key))
        .map(|key| text(key).parse::<u64>())
        .collect::<Result<Vec<_>, _>>();
    let expires_at = deadlines.ok().and_then(|ds| ds.into_iter().min());
    let active = text("s") == "pending"
        && text("network") == "mainnet"
        && !platform.is_empty()
        && platform.len() <= 100
        && matches!(text("k"), "buy" | "sell")
        && expires_at.is_some_and(|t| t > 0)
        && currency.len() == 3
        && currency.bytes().all(|b| b.is_ascii_uppercase())
        && (1..=2).contains(&amounts.len())
        && amounts.iter().all(|s| decimal(s))
        && (amounts.len() == 1 || amounts[0].parse::<f64>()? <= amounts[1].parse::<f64>()?);
    let coordinate = Coordinate::new(event.kind, event.pubkey).identifier(id);
    let link = format!(
        "https://market.iris.to/{}",
        Nip19Coordinate::new(coordinate, []).to_bech32()?
    );
    let methods: String = values(event, "pm").join(" · ").chars().take(300).collect();
    let mut terms = vec![
        platform.to_string(),
        methods.clone(),
        text("layer").chars().take(40).collect(),
    ];
    if let Ok(sats) = text("amt").parse::<u64>()
        && sats > 0
    {
        terms.push(format!("{sats} sats"));
    }
    if let Ok(premium) = text("premium").parse::<f64>()
        && premium.is_finite()
    {
        terms.push(format!("Premium {premium}%"));
    }
    Ok(Listing {
        search_text_cache: Default::default(),
        event_id: event.id.to_hex(),
        id: format!("38383:{}:{id}", event.pubkey),
        author: event.pubkey.to_hex(),
        title: format!(
            "{} bitcoin for {currency}",
            if buy { "Buying" } else { "Selling" }
        ),
        description: terms
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
        side: if buy { "request" } else { "offer" }.into(),
        escrow: None,
        external_order: Some(Quote {
            platform: platform.into(),
            amounts: amounts.to_vec(),
            methods,
            link,
        }),
        price: amounts.first().cloned().unwrap_or_default(),
        currency: currency.into(),
        display_price: None,
        location: String::new(),
        category: "Other".into(),
        tags: vec![
            "bitcoin".into(),
            "btc".into(),
            "sats".into(),
            "satoshis".into(),
            currency.into(),
            platform.into(),
        ],
        service_areas: None,
        image_url: None,
        created_at: event.created_at.as_secs(),
        expires_at,
        status: if active { "active" } else { "sold" }.into(),
        saved: false,
        mine: false,
        delivery: "published".into(),
        relevance: None,
        direct_match: false,
        coordinates: None,
    })
}

#[cfg(test)]
mod tests {
    use crate::{listing, store::Store};
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    #[test]
    fn signed_order_revisions_drive_search_saved_and_unavailable() {
        let key = Keys::generate();
        let now = listing::now();
        let until = (now + 120).to_string();
        let event = |status: &str, side: &str, ts: u64| {
            EventBuilder::new(Kind::Custom(38383), "")
                .tags(
                    [
                        vec!["d", "a-test"],
                        vec!["z", "order"],
                        vec!["k", side],
                        vec!["s", status],
                        vec!["network", "mainnet"],
                        vec!["fa", "100", "250"],
                        vec!["f", "EUR"],
                        vec!["y", "new-place"],
                        vec!["pm", "SEPA"],
                        vec!["expires_at", &until],
                        vec!["source", "https://example.org/ignored"],
                    ]
                    .into_iter()
                    .map(|t| Tag::parse(t).unwrap()),
                )
                .custom_created_at(Timestamp::from(ts))
                .sign_with_keys(&key)
                .unwrap()
        };
        let original = event("pending", "sell", now);
        let row = listing::parse(&original, now).unwrap();
        let q = row.external_order.unwrap();
        assert!(q.link.starts_with("https://market.iris.to/naddr1"));
        assert_eq!(q.amounts, ["100", "250"]);
        assert!(!row.description.contains("https://"));
        assert_eq!(row.side, "offer");
        assert_eq!(row.expires_at, Some(now + 120));
        assert!(row.escrow.is_none());
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("market.sqlite")).unwrap();
        assert!(db.ingest(&original, now, true).is_err());
        db.ingest(&original, now, false).unwrap();
        db.toggle_saved(&row.id).unwrap();
        assert!(db.listings("", now).unwrap()[0].saved);
        assert!(db.listings("", now + 120).unwrap().is_empty());
        assert_eq!(
            listing::parse(&event("pending", "buy", now), now)
                .unwrap()
                .side,
            "request"
        );
        db.ingest(&event("canceled", "sell", now + 1), now + 1, false)
            .unwrap();
        assert!(!db.ingest(&original, now + 1, false).unwrap());
        assert!(db.listings("", now + 1).unwrap().is_empty());
    }
}
