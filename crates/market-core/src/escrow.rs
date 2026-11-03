//! Public escrow advertisements and private, revision-bound Cashu agreements.
pub(crate) mod funding;
use crate::{listing, model::Draft};
use anyhow::{Context, Result, bail, ensure};
use cashu::{Conditions, PublicKey, SigFlag, SpendingConditions};
pub use funding::FundingCheck;
use nostr::{Event, EventId, Tag, UnsignedEvent};
use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "cashu-2of3-v1";
const TAG: &str = "iris-escrow";
/// A locally selected no-value mint in a development build. Relay input cannot enable it.
pub(crate) fn local_test_mint() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var("MARKET_ESCROW_TEST_MINT").ok()?;
    let url = url::Url::parse(&value).ok()?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.origin().ascii_serialization() == value)
        .then_some(value)
}
const MAX_SATS: u64 = 1_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FiatMethod {
    BankTransfer,
    Cash,
}
impl FiatMethod {
    fn wire(self) -> &'static str {
        match self {
            Self::BankTransfer => "bank transfer",
            Self::Cash => "cash in person",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "trade", rename_all = "snake_case", deny_unknown_fields)]
pub enum Offer {
    Goods,
    BitcoinFiat { sats: u64, method: FiatMethod },
}

impl Offer {
    pub(crate) fn validate(self, draft: &Draft) -> Result<()> {
        if let Self::BitcoinFiat { sats, .. } = self {
            ensure!(
                (1..=MAX_SATS).contains(&sats),
                "Choose a positive, fixed number of sats"
            );
            ensure!(
                crate::rates::CURRENCIES.contains(&draft.currency.to_ascii_uppercase().as_str())
                    && draft.currency.len() == 3
                    && !draft.currency.eq_ignore_ascii_case("BTC"),
                "Choose a supported fiat currency"
            );
            let (whole, fraction) = draft.price.split_once('.').unwrap_or((&draft.price, ""));
            ensure!(
                !whole.is_empty()
                    && whole.len() <= 12
                    && fraction.len() <= 2
                    && !draft.price.ends_with('.')
                    && whole
                        .bytes()
                        .chain(fraction.bytes())
                        .all(|b| b.is_ascii_digit())
                    && whole.bytes().chain(fraction.bytes()).any(|b| b != b'0'),
                "Use a positive fixed fiat price"
            );
            ensure!(draft.expires_at.is_some(), "Bitcoin offers need an expiry");
        }
        Ok(())
    }
    pub(crate) fn write_tags(
        self,
        tags: &mut Vec<Vec<String>>,
        draft: &Draft,
        closed: bool,
    ) -> Result<u16> {
        tags.push(vec![TAG.into(), PROTOCOL.into()]);
        let Self::BitcoinFiat { sats, method } = self else {
            return Ok(listing::LISTING_KIND);
        };
        tags.retain(|t| !matches!(t[0].as_str(), "price" | "status"));
        let expires = draft
            .expires_at
            .context("Bitcoin offers need an expiry")?
            .to_string();
        for (k, v) in [
            ("s", if closed { "canceled" } else { "pending" }),
            ("amt", &sats.to_string()),
            ("f", &draft.currency.to_uppercase()),
            ("fa", &draft.price),
            ("pm", method.wire()),
            ("premium", "0"),
            ("bond", "0"),
            ("network", "mainnet"),
            ("layer", "cashu"),
            ("y", "iris-market"),
            ("z", "order"),
            ("expires_at", &expires),
        ] {
            tags.push(vec![k.into(), v.into()]);
        }
        Ok(listing::P2P_KIND)
    }

    pub(crate) fn from_event(event: &Event) -> Result<Option<Self>> {
        if !event.tags.iter().any(|tag| tag.as_slice()[0] == TAG)
            && event.kind.as_u16() == listing::LISTING_KIND
        {
            return Ok(None);
        }
        ensure!(
            value(event, TAG)? == PROTOCOL,
            "Unsupported escrow protocol"
        );
        if event.kind.as_u16() == listing::LISTING_KIND {
            return Ok(Some(Self::Goods));
        }
        let sats = value(event, "amt")?
            .parse::<u64>()
            .context("Invalid bitcoin amount")?;
        let method = match value(event, "pm")? {
            "bank transfer" => FiatMethod::BankTransfer,
            "cash in person" => FiatMethod::Cash,
            _ => bail!("Unsupported fiat payment method"),
        };
        Ok(Some(Self::BitcoinFiat { sats, method }))
    }
}

fn value<'a>(event: &'a Event, name: &str) -> Result<&'a str> {
    let mut tags = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|t| t[0] == name);
    match (tags.next(), tags.next()) {
        (Some([_, value]), None) => Ok(value),
        _ => bail!("Missing or ambiguous {name} tag"),
    }
}

pub(crate) fn read_bitcoin_quote(event: &Event, draft: &mut Draft) -> Result<String> {
    for (k, v) in [
        ("network", "mainnet"),
        ("layer", "cashu"),
        ("y", "iris-market"),
        ("z", "order"),
        ("premium", "0"),
        ("bond", "0"),
    ] {
        ensure!(value(event, k)? == v, "Unsupported bitcoin offer terms");
    }
    draft.side = match value(event, "k")? {
        "buy" => "request",
        "sell" => "offer",
        _ => bail!("Invalid bitcoin offer side"),
    }
    .into();
    draft.price = value(event, "fa")?.into();
    draft.currency = value(event, "f")?.into();
    let expires = value(event, "expires_at")?.parse::<u64>()?;
    draft.expires_at = Some(draft.expires_at.unwrap_or(expires).min(expires));
    Ok(match value(event, "s")? {
        "pending" => "active",
        "canceled" | "expired" | "in-progress" | "success" => "sold",
        _ => bail!("Unknown bitcoin offer status"),
    }
    .into())
}
/// Private delegation of a Cashu signing key by a rateable market profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub profile: nostr::PublicKey,
    pub key: PublicKey,
    pub signature: nostr::secp256k1::schnorr::Signature,
}
impl Provider {
    fn digest(key: PublicKey) -> nostr::secp256k1::Message {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(b"iris-market/escrow-provider/cashu-2of3-v1\0");
        hash.update(key.to_bytes());
        nostr::secp256k1::Message::from_digest(hash.finalize().into())
    }
    pub fn authorize(profile: &nostr::Keys, key: PublicKey) -> Self {
        Self {
            profile: profile.public_key(),
            key,
            signature: profile.sign_schnorr(&Self::digest(key)),
        }
    }
    fn verify(&self) -> Result<()> {
        nostr::SECP256K1
            .verify_schnorr(
                &self.signature,
                &Self::digest(self.key),
                &self.profile.xonly()?,
            )
            .context("Invalid escrow provider key authorization")
    }
}

/// Keys are fresh, compressed Cashu spending keys, exchanged privately.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    pub mint: String,
    pub sats: u64,
    pub buyer_key: PublicKey,
    pub seller_key: PublicKey,
    pub provider: Provider,
}
impl Terms {
    pub fn conditions(&self) -> Result<SpendingConditions> {
        ensure!((1..=MAX_SATS).contains(&self.sats), "Invalid escrow amount");
        let mint = url::Url::parse(&self.mint).context("Invalid escrow mint")?;
        ensure!(
            self.mint.len() <= 2048
                && (mint.scheme() == "https"
                    || local_test_mint().as_deref() == Some(self.mint.as_str()))
                && mint.host_str().is_some()
                && mint.username().is_empty()
                && mint.password().is_none()
                && mint.query().is_none()
                && mint.fragment().is_none()
                && mint.as_str().trim_end_matches('/') == self.mint,
            "Use a canonical HTTPS mint URL without credentials, query or trailing slash"
        );
        self.provider.verify()?;
        let lock = SpendingConditions::new_p2pk(
            self.buyer_key,
            Some(Conditions {
                pubkeys: Some(vec![self.seller_key, self.provider.key]),
                num_sigs: Some(2),
                sig_flag: SigFlag::SigAll,
                ..Default::default()
            }),
        );
        lock.validate()
            .context("Escrow requires three distinct spending keys")?;
        Ok(lock)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proposal {
    pub listing_id: String,
    pub revision: EventId,
    pub funder: nostr::PublicKey,
    pub beneficiary: nostr::PublicKey,
    pub terms: Terms,
}

impl Proposal {
    pub fn for_event(
        event: &Event,
        terms: Terms,
        taker: nostr::PublicKey,
        now: u64,
    ) -> Result<Self> {
        let listing = listing::parse(event, now)?;
        let offer = listing
            .escrow
            .context("This listing does not offer escrow")?;
        ensure!(
            listing.status == "active" && listing.expires_at.is_none_or(|t| t > now),
            "This listing has closed or expired"
        );
        terms.conditions()?;
        if let Offer::BitcoinFiat { sats, .. } = offer {
            ensure!(
                terms.sats == sats,
                "The escrow amount must equal the bitcoin offer"
            );
        }
        let maker = event.pubkey;
        ensure!(
            maker != taker && terms.provider.profile != maker && terms.provider.profile != taker,
            "Choose an independent escrow provider"
        );
        for key in [terms.buyer_key, terms.seller_key, terms.provider.key] {
            let x = key.x_only_public_key().serialize();
            ensure!(
                [maker, taker, terms.provider.profile]
                    .iter()
                    .all(|identity| identity.as_bytes() != &x),
                "Use fresh spending keys separate from market profiles"
            );
        }
        let (buyer, seller) = if listing.side == "request" {
            (maker, taker)
        } else {
            (taker, maker)
        };
        let (funder, beneficiary) = match offer {
            Offer::Goods => (buyer, seller),
            Offer::BitcoinFiat { .. } => (seller, buyer),
        };
        Ok(Self {
            listing_id: listing.id,
            revision: event.id,
            funder,
            beneficiary,
            terms,
        })
    }
}

/// Only appears inside an authenticated double-ratchet message. Acceptances
/// reference the exact proposal rumor and therefore all of its spending keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgreementMessage {
    Propose(Box<Proposal>),
    Accept { proposal_id: EventId },
}
impl AgreementMessage {
    pub(crate) fn tag(&self) -> Result<Tag> {
        Ok(Tag::parse([TAG, PROTOCOL, &serde_json::to_string(self)?])?)
    }

    pub(crate) fn from_rumor(rumor: &UnsignedEvent) -> Option<Self> {
        let mut tags = rumor.tags.iter().map(Tag::as_slice).filter(|t| t[0] == TAG);
        let [_, version, data] = tags.next()? else {
            return None;
        };
        if tags.next().is_some() || version != PROTOCOL || data.len() > 4096 {
            return None;
        }
        let message: Self = serde_json::from_str(data).ok()?;
        if let Self::Propose(p) = &message {
            if p.listing_id.len() > 260 {
                return None;
            }
            p.terms.conditions().ok()?;
        }
        Some(message)
    }
}

async fn fetch_trade_listing(relays: Vec<String>, id: &str) -> Result<Vec<Event>> {
    use nostr::{Filter, Kind};
    use nostr_pubsub::{EventBus, QueryOptions};
    use nostr_pubsub_relay::RelayEventBus;
    use std::time::Duration;
    let (kind, coordinate) = id
        .strip_prefix("38383:")
        .map_or((listing::LISTING_KIND, id), |value| {
            (listing::P2P_KIND, value)
        });
    let (author, identifier) = coordinate.split_once(':').context("Invalid listing")?;
    ensure!(
        !identifier.is_empty() && identifier.len() <= 160,
        "Invalid listing"
    );
    let filter = Filter::new()
        .kind(Kind::Custom(kind))
        .author(nostr::PublicKey::from_hex(author)?)
        .identifier(identifier)
        .limit(16);
    let bus = RelayEventBus::new(relays, Duration::from_secs(3)).await?;
    let report = tokio::time::timeout(
        Duration::from_secs(5),
        bus.query(vec![filter], QueryOptions { limit: Some(16) }),
    )
    .await;
    bus.client().shutdown().await;
    Ok(report
        .context("The listing check timed out. Reconnect and retry.")??
        .events
        .into_iter()
        .map(|entry| entry.event.as_event().clone())
        .collect())
}

impl crate::Market {
    /// Navigation uses the verified local copy. Consent and funding check the
    /// public listing separately, without revealing a private trade or its participants.
    pub fn trade_listing(&self, id: &str, refresh: bool) -> Result<String> {
        let relays = {
            let state = self.state.lock().unwrap();
            if !refresh {
                let event = state
                    .store
                    .event(id)
                    .context("Open the listing and retry")?;
                return Ok(serde_json::to_string(&listing::parse(
                    &event,
                    listing::now(),
                )?)?);
            }
            ensure!(
                !state.demo && !state.settings.relays.is_empty(),
                "Connect to check the current listing"
            );
            state.settings.relays.clone()
        };
        let handle = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .context("Market is closed")?
            .handle()
            .clone();
        let events = handle.block_on(fetch_trade_listing(relays, id))?;
        let mut state = self.state.lock().unwrap();
        let at = listing::now();
        let mut observed = false;
        for event in events {
            if listing::parse(&event, at).is_ok_and(|listing| listing.id == id) {
                observed = true;
                if state.store.ingest(&event, at, false)? {
                    state.revision += 1;
                }
            }
        }
        ensure!(
            observed,
            "No relay could confirm this listing. Reconnect and retry."
        );
        Ok(serde_json::to_string(&listing::parse(
            &state.store.event(id)?,
            at,
        )?)?)
    }
    /// Resolve only the private agreement explicitly selected by the caller.
    pub fn escrow_terms(&self, peer: &str, proposal: EventId) -> Result<Terms> {
        let s = self.state.lock().unwrap();
        let p = s
            .messaging
            .as_ref()
            .context("Private messaging unavailable")?
            .agreed_escrow(peer, proposal)
            .map_err(anyhow::Error::msg)?;
        Ok(p.terms.clone())
    }
    pub fn check_escrow_funding(
        &self,
        peer: &str,
        proposal: EventId,
        encoded: &str,
    ) -> Result<FundingCheck> {
        let terms = self.escrow_terms(peer, proposal)?;
        let handle = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .context("Market is closed")?
            .handle()
            .clone();
        handle.block_on(terms.check_funding(encoded))
    }
}

pub fn authorize_provider_key(profile_secret: &str, spending_key: &str) -> Result<Provider> {
    let profile = nostr::Keys::parse(profile_secret).context("Invalid profile key")?;
    Ok(Provider::authorize(&profile, spending_key.parse()?))
}
