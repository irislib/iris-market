use crate::model::{Draft, Listing};
use anyhow::{Context, Result, bail};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};

pub const LISTING_KIND: u16 = 30402;
pub const P2P_KIND: u16 = 38383;
pub fn kinds() -> [Kind; 2] {
    [Kind::Custom(LISTING_KIND), Kind::Custom(P2P_KIND)]
}
/// Keep coordinator-owned third-party orders out of the Iris private trade flow.
pub(crate) fn filters(base: nostr::Filter) -> Vec<nostr::Filter> {
    vec![
        base.clone().kind(Kind::Custom(LISTING_KIND)),
        base.kind(Kind::Custom(P2P_KIND)).custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::Y),
            "iris-market",
        ),
    ]
}
pub(crate) fn coordinate(
    author: nostr::PublicKey,
    identifier: &str,
    offer: Option<crate::escrow::Offer>,
) -> String {
    match offer {
        Some(crate::escrow::Offer::BitcoinFiat { .. }) => {
            format!("{P2P_KIND}:{author}:{identifier}")
        }
        _ => format!("{author}:{identifier}"),
    }
}

pub fn now() -> u64 {
    Timestamp::now().as_secs()
}

fn field(event: &Event, name: &str) -> Result<Option<String>> {
    let values: Vec<_> = event
        .tags
        .iter()
        .filter(|t| t.as_slice().first().is_some_and(|s| s == name))
        .collect();
    if values.len() > 1 {
        bail!("Duplicate {name} field");
    }
    Ok(values.first().and_then(|t| t.as_slice().get(1)).cloned())
}

fn classified_side(event: &Event) -> Result<&'static str> {
    let mut direction = None;
    let mut wanted = false;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let Some(value) = parts.get(1).map(String::as_str) else {
            continue;
        };
        match (parts[0].as_str(), value) {
            ("k", "buy" | "sell") => {
                if direction.is_some_and(|previous| previous != value) {
                    bail!("Conflicting listing directions");
                }
                direction = Some(value);
            }
            ("type", "want_buy" | "want_rent") => wanted = true,
            _ => {}
        }
    }
    Ok(
        if direction == Some("buy") || direction.is_none() && wanted {
            "request"
        } else {
            "offer"
        },
    )
}

fn normalized_tag(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('#').to_lowercase();
    (!value.is_empty()
        && value.chars().count() <= 60
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_')))
    .then_some(value)
}

pub fn validate(d: &Draft) -> Result<()> {
    if let Some(offer) = &d.escrow {
        offer.validate(d)?;
    }
    if let Some(areas) = &d.service_areas {
        crate::service_area::validate(&areas.pickup)?;
        crate::service_area::validate(&areas.destination)?;
    }
    if d.tags.len() > 24 || d.tags.iter().any(|tag| normalized_tag(tag).is_none()) {
        bail!("Use up to 24 short topic tags");
    }
    if d.title.trim().is_empty() || d.title.chars().count() > 160 {
        bail!("Add a title of up to 160 characters");
    }
    if d.description.len() > 12000 {
        bail!("Description is too long");
    }
    if !["offer", "request"].contains(&d.side.as_str()) {
        bail!("Choose Offer or Request");
    }
    if d.location.chars().count() > 160 || d.category.chars().count() > 60 {
        bail!("Location or category is too long");
    }
    if d.currency.len() < 3
        || d.currency.len() > 12
        || !d.currency.chars().all(|c| c.is_ascii_alphabetic())
    {
        bail!("Use a currency code such as EUR");
    }
    if !d.price.is_empty() {
        let price: f64 = d.price.parse().context("Enter a valid price")?;
        if !price.is_finite() || price < 0.0 || d.price.len() > 24 {
            bail!("Enter a non-negative price");
        }
    }
    if let Some(image) = &d.image_url
        && !image.is_empty()
    {
        let url = url::Url::parse(image).context("Use a full HTTPS image URL")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            bail!("Images need an HTTPS URL without credentials");
        }
    }
    Ok(())
}

pub fn build(
    keys: &Keys,
    d: &Draft,
    identifier: &str,
    created_at: u64,
    closed: bool,
) -> Result<Event> {
    let event = builder(d, identifier, created_at, closed)?.sign_with_keys(keys)?;
    anyhow::ensure!(event.as_json().len() <= 65536, "Listing is too large");
    Ok(event)
}

pub(crate) fn builder(
    d: &Draft,
    identifier: &str,
    created_at: u64,
    closed: bool,
) -> Result<EventBuilder> {
    validate(d)?;
    let mut tags = vec![
        vec!["d".into(), identifier.into()],
        vec!["title".into(), d.title.trim().into()],
        vec!["location".into(), d.location.trim().into()],
        vec!["t".into(), d.category.trim().into()],
        vec![
            "k".into(),
            if d.side == "request" { "buy" } else { "sell" }.into(),
        ],
        vec![
            "status".into(),
            if closed { "sold" } else { "active" }.into(),
        ],
        vec!["client".into(), "Iris Market".into()],
    ];
    if let Some(hash) = d
        .location
        .split_whitespace()
        .last()
        .and_then(|s| s.strip_prefix('#'))
        && crate::geo::decode(hash).is_some()
    {
        let hash = hash.to_ascii_lowercase();
        for length in 1..=hash.len() {
            tags.push(vec!["g".into(), hash[..length].into()]);
        }
    }
    let mut topics = std::collections::HashSet::new();
    if let Some(category) = normalized_tag(&d.category) {
        topics.insert(category);
    }
    for topic in &d.tags {
        if let Some(topic) = normalized_tag(topic)
            && topics.insert(topic.clone())
        {
            tags.push(vec!["t".into(), topic]);
        }
    }
    if !d.price.is_empty() {
        tags.push(vec![
            "price".into(),
            d.price.clone(),
            d.currency.to_uppercase(),
        ]);
    }
    if let Some(image) = d.image_url.as_ref().filter(|x| !x.is_empty()) {
        tags.push(vec!["image".into(), image.clone()]);
    }
    if let Some(expiry) = d.expires_at {
        tags.push(vec!["expiration".into(), expiry.to_string()]);
    }
    if let Some(areas) = &d.service_areas {
        tags.extend(crate::service_area::to_tags(areas)?);
    }
    let kind = match d.escrow {
        Some(offer) => offer.write_tags(&mut tags, d, closed)?,
        None => LISTING_KIND,
    };
    let tags: Result<Vec<Tag>, _> = tags.into_iter().map(Tag::parse).collect();
    Ok(EventBuilder::new(Kind::Custom(kind), d.description.clone())
        .tags(tags?)
        .custom_created_at(Timestamp::from(created_at)))
}

pub fn parse(event: &Event, at: u64) -> Result<Listing> {
    if event.as_json().len() > 65536 {
        bail!("Listing is too large");
    }
    event.verify()?;
    if !kinds().contains(&event.kind) {
        bail!("Not a classified listing");
    }
    if event.created_at.as_secs() > at + 300 {
        bail!("Listing timestamp is too far in the future");
    }
    let identifier = field(event, "d")?.context("Listing has no identifier")?;
    if identifier.is_empty() || identifier.len() > 160 {
        bail!("Invalid listing identifier");
    }
    if event.kind.as_u16() == P2P_KIND
        && field(event, "z")?.as_deref() == Some("order")
        && field(event, "y")?.as_deref() != Some("iris-market")
        && !event.tags.iter().any(|t| t.as_slice()[0] == "iris-escrow")
    {
        return crate::bitcoin_order::parse(event, &identifier);
    }
    let price_tag = event
        .tags
        .iter()
        .find(|t| t.as_slice().first().is_some_and(|s| s == "price"));
    let price = field(event, "price")?.unwrap_or_default();
    let currency = price_tag
        .and_then(|t| t.as_slice().get(2))
        .cloned()
        .unwrap_or_else(|| "EUR".into());
    let mut seen_topics = std::collections::HashSet::new();
    let topics = event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if parts.first().is_some_and(|kind| kind == "t") {
                parts.get(1).and_then(|value| normalized_tag(value))
            } else {
                None
            }
        })
        .filter(|topic| seen_topics.insert(topic.clone()))
        .take(24)
        .collect();
    let escrow = crate::escrow::Offer::from_event(event)?;
    let mut draft = Draft {
        escrow,
        title: field(event, "title")?.context("Listing has no title")?,
        description: event.content.clone(),
        side: classified_side(event)?.into(),
        price,
        currency,
        location: field(event, "location")?.unwrap_or_default(),
        // Multiple NIP-99 category tags are valid; display the first.
        category: event
            .tags
            .iter()
            .find(|t| t.as_slice().first().is_some_and(|s| s == "t"))
            .and_then(|t| t.as_slice().get(1))
            .cloned()
            .unwrap_or_else(|| "Other".into()),
        tags: topics,
        service_areas: crate::service_area::parse_tags(
            &event
                .tags
                .iter()
                .map(|tag| tag.as_slice().to_vec())
                .collect::<Vec<_>>(),
        ),
        image_url: event
            .tags
            .iter()
            .find(|t| t.as_slice().first().is_some_and(|s| s == "image"))
            .and_then(|t| t.as_slice().get(1))
            .cloned(),
        expires_at: field(event, "expiration")?
            .map(|v| v.parse())
            .transpose()
            .context("Invalid expiry")?,
    };
    let status = if event.kind.as_u16() == P2P_KIND {
        crate::escrow::read_bitcoin_quote(event, &mut draft)?
    } else {
        field(event, "status")?.unwrap_or_else(|| "active".into())
    };
    validate(&draft)?;
    if !["active", "sold"].contains(&status.as_str()) {
        bail!("Unknown listing status");
    }
    Ok(Listing {
        event_id: event.id.to_hex(),
        search_text_cache: Default::default(),
        id: coordinate(event.pubkey, &identifier, draft.escrow),
        escrow: draft.escrow,
        external_order: None,
        author: event.pubkey.to_hex(),
        title: draft.title,
        description: draft.description,
        side: draft.side,
        price: draft.price,
        currency: draft.currency,
        display_price: None,
        location: draft.location,
        category: draft.category,
        tags: draft.tags,
        service_areas: draft.service_areas,
        image_url: draft.image_url,
        created_at: event.created_at.as_secs(),
        expires_at: draft.expires_at,
        status,
        saved: false,
        mine: false,
        delivery: "published".into(),
        relevance: None,
        direct_match: false,
        coordinates: {
            let mut hashes: Vec<_> = event
                .tags
                .iter()
                .filter_map(|tag| {
                    let parts = tag.as_slice();
                    (parts.len() == 2 && parts.first().is_some_and(|v| v == "g"))
                        .then(|| parts.get(1))
                        .flatten()
                        .filter(|v| crate::geo::decode(v).is_some())
                        .map(|v| v.to_lowercase())
                })
                .collect();
            hashes.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
            hashes.first().and_then(|v| crate::geo::decode(v))
        },
    })
}

pub fn draft_from(l: &Listing) -> Draft {
    Draft {
        escrow: l.escrow,
        title: l.title.clone(),
        description: l.description.clone(),
        side: l.side.clone(),
        price: l.price.clone(),
        currency: l.currency.clone(),
        location: l.location.clone(),
        category: l.category.clone(),
        tags: l.tags.clone(),
        service_areas: l.service_areas.clone(),
        image_url: l.image_url.clone(),
        expires_at: l.expires_at,
    }
}
