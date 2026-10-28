use crate::model::{Draft, Listing};
use anyhow::{Context, Result, bail};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};

pub const LISTING_KIND: u16 = 30402;
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

pub fn validate(d: &Draft) -> Result<()> {
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
    validate(d)?;
    let mut tags = vec![
        vec!["d".into(), identifier.into()],
        vec!["title".into(), d.title.trim().into()],
        vec!["location".into(), d.location.trim().into()],
        vec!["t".into(), d.category.trim().into()],
        vec!["market".into(), d.side.clone()],
        vec![
            "status".into(),
            if closed { "sold" } else { "active" }.into(),
        ],
        vec!["client".into(), "Iris Market".into()],
    ];
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
    let tags: Result<Vec<Tag>, _> = tags.into_iter().map(Tag::parse).collect();
    Ok(
        EventBuilder::new(Kind::Custom(LISTING_KIND), d.description.clone())
            .tags(tags?)
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(keys)?,
    )
}

pub fn parse(event: &Event, at: u64) -> Result<Listing> {
    if event.as_json().len() > 65536 {
        bail!("Listing is too large");
    }
    event.verify()?;
    if event.kind != Kind::Custom(LISTING_KIND) {
        bail!("Not a classified listing");
    }
    if event.created_at.as_secs() > at + 300 {
        bail!("Listing timestamp is too far in the future");
    }
    let identifier = field(event, "d")?.context("Listing has no identifier")?;
    if identifier.is_empty() || identifier.len() > 160 {
        bail!("Invalid listing identifier");
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
    let draft = Draft {
        title: field(event, "title")?.context("Listing has no title")?,
        description: event.content.clone(),
        side: field(event, "market")?.unwrap_or_else(|| "offer".into()),
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
    validate(&draft)?;
    let status = field(event, "status")?.unwrap_or_else(|| "active".into());
    if !["active", "sold"].contains(&status.as_str()) {
        bail!("Unknown listing status");
    }
    Ok(Listing {
        id: format!("{}:{identifier}", event.pubkey.to_hex()),
        author: event.pubkey.to_hex(),
        title: draft.title,
        description: draft.description,
        side: draft.side,
        price: draft.price,
        currency: draft.currency,
        location: draft.location,
        category: draft.category,
        image_url: draft.image_url,
        created_at: event.created_at.as_secs(),
        expires_at: draft.expires_at,
        status,
        saved: false,
        mine: false,
        delivery: "published".into(),
        relevance: None,
        coordinates: {
            let mut hashes: Vec<_> = event
                .tags
                .iter()
                .filter_map(|tag| {
                    let parts = tag.as_slice();
                    (parts.first().is_some_and(|v| v == "g"))
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
        title: l.title.clone(),
        description: l.description.clone(),
        side: l.side.clone(),
        price: l.price.clone(),
        currency: l.currency.clone(),
        location: l.location.clone(),
        category: l.category.clone(),
        image_url: l.image_url.clone(),
        expires_at: l.expires_at,
    }
}
