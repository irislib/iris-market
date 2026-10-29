//! Display estimates only. Signed listing prices and private order amounts are unchanged.
//! Source/publisher schema matches web/src/currency.ts and its pinned Snort references.
use anyhow::{Result, ensure};
use nostr::{Event, Filter, JsonUtil, Kind, PublicKey, Timestamp};
use nostr_pubsub::{EventBus, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub const CURRENCIES: &[&str] = &[
    "EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "CAD", "AUD", "JPY", "CNY", "INR", "SATS",
    "BTC",
];
pub const FRESH_SECONDS: u64 = 900;
pub const MAX_AGE_SECONDS: u64 = 14400;
pub const CACHE_BYTES: usize = 262144;
const MAX_HTTP_BYTES: usize = 131072;
const MAX_RATES: usize = 1024;
const SNORT_PUBLISHER: &str = "84de35e2584d2b144aae823c9ed0b0f3deda09648530b93d1a2a146d1dea9864";
const COINBASE_URL: &str = "https://api.coinbase.com/v2/exchange-rates?currency=BTC";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeRate {
    pub value: f64,
    pub source: String,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}
impl ExchangeRate {
    fn usable(&self, now: u64) -> bool {
        self.value.is_finite()
            && self.value > 0.0
            && self.value <= 1e18
            && self.updated_at <= now.saturating_add(60)
            && now.saturating_sub(self.updated_at) <= MAX_AGE_SECONDS
            && match self.source.as_str() {
                "Snort" => self.event_id.as_ref().is_some_and(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                }),
                "Coinbase" => self.event_id.is_none(),
                _ => false,
            }
    }
    fn fresh(&self, now: u64) -> bool {
        self.usable(now) && now.saturating_sub(self.updated_at) <= FRESH_SECONDS
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RateBook {
    rates: BTreeMap<String, ExchangeRate>,
}
#[derive(Debug, Clone, Serialize)]
pub struct RateSnapshot {
    pub rates: BTreeMap<String, ExchangeRate>,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayPrice {
    pub amount: f64,
    pub currency: String,
    pub approximate: bool,
    pub source: Option<String>,
    pub updated_at: Option<u64>,
    pub stale: bool,
}

pub fn normalize_currency(value: &str) -> Option<String> {
    let code = value.trim().to_ascii_uppercase();
    let code = match code.as_str() {
        "SAT" | "SATS" | "SATOSHI" | "SATOSHIS" => "SATS",
        "XBT" => "BTC",
        _ => &code,
    };
    ((3..=12).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_uppercase()))
        .then(|| code.to_owned())
}
pub fn validate_currency(value: &str) -> Result<()> {
    ensure!(
        CURRENCIES.contains(&value),
        "Choose a supported display currency"
    );
    Ok(())
}
fn number(value: &Value) -> Option<f64> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if !s.starts_with('-') => s.parse().ok()?,
        _ => return None,
    };
    (n.is_finite() && n >= 0.0).then_some(n)
}
fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|n| *n > 0.0 && *n <= 1e18)
}

impl RateBook {
    pub fn from_cache(raw: &str, now: u64) -> Result<Self> {
        ensure!(raw.len() <= CACHE_BYTES, "Exchange-rate cache is too large");
        let mut book: Self = serde_json::from_str(raw)?;
        ensure!(
            book.rates.len() <= MAX_RATES,
            "Too many cached exchange rates"
        );
        book.prune(now);
        Ok(book)
    }
    pub fn cache_json(&self) -> Result<String> {
        ensure!(self.rates.len() <= MAX_RATES, "Too many exchange rates");
        let raw = serde_json::to_string(self)?;
        ensure!(raw.len() <= CACHE_BYTES, "Exchange-rate cache is too large");
        Ok(raw)
    }
    fn prune(&mut self, now: u64) {
        self.rates.retain(|code, rate| {
            normalize_currency(code).as_ref() == Some(code)
                && !["BTC", "SATS"].contains(&code.as_str())
                && rate.usable(now)
        });
    }
    pub fn snapshot(&self, now: u64) -> RateSnapshot {
        let rates: BTreeMap<_, _> = self
            .rates
            .iter()
            .filter(|(_, rate)| rate.usable(now))
            .map(|(code, rate)| (code.clone(), rate.clone()))
            .collect();
        let status = if rates.values().any(|r| r.fresh(now)) {
            "fresh"
        } else if rates.is_empty() {
            "unavailable"
        } else {
            "stale"
        };
        RateSnapshot {
            rates,
            status: status.into(),
        }
    }
    fn ingest_snort(&mut self, event: &Event, now: u64) {
        if let Some((code, rate)) = parse_snort(event, now, SNORT_PUBLISHER) {
            let replace = self.rates.get(&code).is_none_or(|previous| {
                if previous.source == "Snort" {
                    rate.updated_at > previous.updated_at
                        || rate.updated_at == previous.updated_at
                            && rate.event_id < previous.event_id
                } else {
                    rate.fresh(now) || !previous.fresh(now)
                }
            });
            if replace {
                self.rates.insert(code, rate);
            }
        }
    }
    fn ingest_coinbase(&mut self, rates: BTreeMap<String, ExchangeRate>, now: u64) {
        for (code, rate) in rates {
            if self
                .rates
                .get(&code)
                .is_none_or(|previous| previous.source != "Snort" || !previous.fresh(now))
            {
                self.rates.insert(code, rate);
            }
        }
        self.prune(now);
    }
    fn needs_http(&self, now: u64) -> bool {
        CURRENCIES
            .iter()
            .filter(|code| !["BTC", "SATS"].contains(code))
            .any(|code| {
                self.rates.get(*code).is_none_or(|rate| {
                    !rate.fresh(now)
                        || rate.source == "Coinbase" && now.saturating_sub(rate.updated_at) >= 300
                })
            })
    }
    pub fn convert(&self, amount: &str, from: &str, to: &str, now: u64) -> Option<DisplayPrice> {
        let amount = number(&Value::String(amount.into()))?;
        let from = normalize_currency(from)?;
        let to = normalize_currency(to)?;
        if from == to {
            return None;
        } // Keep original precision and formatting.
        if amount == 0.0 {
            return Some(DisplayPrice {
                amount,
                currency: to,
                approximate: false,
                source: None,
                updated_at: None,
                stale: false,
            });
        }
        let unit = |code: &str| match code {
            "BTC" => Some(1.0),
            "SATS" => Some(100_000_000.0),
            _ => None,
        };
        let lookup = |code: &str| -> Option<(f64, Option<&ExchangeRate>)> {
            if let Some(value) = unit(code) {
                Some((value, None))
            } else {
                let rate = self.rates.get(code).filter(|r| r.usable(now))?;
                Some((rate.value, Some(rate)))
            }
        };
        let (base, base_record) = lookup(&from)?;
        let (quote, quote_record) = lookup(&to)?;
        let value = amount / base * quote;
        if !value.is_finite() || value <= 0.0 {
            return None;
        }
        let records: Vec<_> = [base_record, quote_record].into_iter().flatten().collect();
        let mut sources: Vec<_> = records.iter().map(|r| r.source.clone()).collect();
        sources.sort();
        sources.dedup();
        Some(DisplayPrice {
            amount: value,
            currency: to,
            approximate: !records.is_empty(),
            source: (!sources.is_empty()).then(|| sources.join(" + ")),
            updated_at: records.iter().map(|r| r.updated_at).min(),
            stale: records.iter().any(|r| !r.fresh(now)),
        })
    }
}

pub fn project(listing: &mut crate::model::Listing, rates: &RateBook, preferred: &str, now: u64) {
    listing.display_price = rates.convert(&listing.price, &listing.currency, preferred, now);
}

fn parse_snort(event: &Event, now: u64, expected: &str) -> Option<(String, ExchangeRate)> {
    let at = event.created_at.as_secs();
    if event.kind.as_u16() != 1009
        || event.pubkey.to_hex() != expected
        || at > now.saturating_add(60)
        || now.saturating_sub(at) > MAX_AGE_SECONDS
        || event.content.len() > 8192
        || event.tags.len() > 64
        || event.as_json().len() > 16384
        || event.verify().is_err()
    {
        return None;
    }
    if event.tags.iter().any(|tag| {
        tag.as_slice().len() > 12 || tag.as_slice().iter().any(|value| value.len() > 1024)
    }) {
        return None;
    }
    let mut quotes = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == "d"));
    let quote = quotes.next()?.as_slice();
    if quotes.next().is_some()
        || quote.len() < 6
        || quote[1].len() != 6
        || !quote[1].starts_with("BTC")
    {
        return None;
    }
    let code = &quote[1][3..];
    if code == "BTC" || !code.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let values: Vec<_> = quote[2..6]
        .iter()
        .map(|s| positive(&Value::String(s.clone())))
        .collect::<Option<_>>()?;
    if values[0] < values[1] || values[2] > values[3] {
        return None;
    }
    Some((
        code.into(),
        ExchangeRate {
            value: values[0],
            source: "Snort".into(),
            updated_at: at,
            event_id: Some(event.id.to_hex()),
        },
    ))
}

fn parse_coinbase(body: &Value, now: u64) -> Result<BTreeMap<String, ExchangeRate>> {
    ensure!(
        body.pointer("/data/currency").and_then(Value::as_str) == Some("BTC"),
        "Invalid exchange-rate base"
    );
    let values = body
        .pointer("/data/rates")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("Invalid exchange-rate response"))?;
    ensure!(
        values.len() <= MAX_RATES && values.get("BTC").and_then(number) == Some(1.0),
        "Invalid exchange-rate base or size"
    );
    let rates: BTreeMap<_, _> = values
        .iter()
        .filter_map(|(code, raw)| {
            if normalize_currency(code).as_ref() != Some(code)
                || ["BTC", "SATS"].contains(&code.as_str())
            {
                return None;
            }
            Some((
                code.clone(),
                ExchangeRate {
                    value: positive(raw)?,
                    source: "Coinbase".into(),
                    updated_at: now,
                    event_id: None,
                },
            ))
        })
        .collect();
    ensure!(!rates.is_empty(), "No usable exchange rates");
    Ok(rates)
}

async fn fetch_coinbase(endpoint: &str, now: u64) -> Result<BTreeMap<String, ExchangeRate>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut response = client
        .get(endpoint)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "Exchange-rate lookup failed"
    );
    if let Some(length) = response.content_length() {
        ensure!(
            length <= MAX_HTTP_BYTES as u64,
            "Exchange-rate response is too large"
        );
    }
    if let Some(date) = response
        .headers()
        .get(reqwest::header::DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
    {
        let at = date.timestamp();
        ensure!(
            at >= 0
                && at as u64 <= now.saturating_add(60)
                && now.saturating_sub(at as u64) <= FRESH_SECONDS,
            "Exchange-rate response is stale"
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_HTTP_BYTES,
            "Exchange-rate response is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    parse_coinbase(&serde_json::from_slice(&bytes)?, now)
}

async fn fetch_snort(relays: &[String], now: u64) -> Vec<Event> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
    let Ok(Ok(bus)) = tokio::time::timeout_at(
        deadline,
        RelayEventBus::new(relays.to_vec(), Duration::from_millis(2500)),
    )
    .await
    else {
        return Vec::new();
    };
    let publisher = PublicKey::from_hex(SNORT_PUBLISHER).expect("reviewed publisher");
    let filter = Filter::new()
        .kind(Kind::Custom(1009))
        .author(publisher)
        .identifiers(
            CURRENCIES
                .iter()
                .filter(|code| code.len() == 3 && **code != "BTC")
                .map(|code| format!("BTC{code}")),
        )
        .since(Timestamp::from(now.saturating_sub(MAX_AGE_SECONDS)))
        .limit(64);
    let result = tokio::time::timeout_at(
        deadline,
        bus.query(vec![filter], QueryOptions { limit: Some(64) }),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(1), bus.client().shutdown()).await;
    match result {
        Ok(Ok(report)) if report.events.len() <= 64 => report
            .events
            .into_iter()
            .map(|received| received.event.into_event())
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) async fn run(state: Arc<Mutex<crate::State>>, stopped: Arc<AtomicBool>) {
    while !stopped.load(Ordering::Acquire) {
        let (relays, mut book, needed) = {
            let s = state.lock().unwrap();
            let needed = s
                .store
                .listings(&s.owner.to_hex(), crate::listing::now())
                .unwrap_or_default()
                .iter()
                .any(|listing| {
                    !listing.price.is_empty()
                        && normalize_currency(&listing.currency).as_deref()
                            != Some(&s.settings.currency)
                });
            (s.settings.relays.clone(), s.rates.clone(), needed)
        };
        // An explicitly offline profile must remain offline; cached prices still work.
        if !relays.is_empty() && needed {
            let now = crate::listing::now();
            for event in fetch_snort(&relays, now).await {
                book.ingest_snort(&event, crate::listing::now());
            }
            if book.needs_http(crate::listing::now())
                && !stopped.load(Ordering::Acquire)
                && let Ok(rates) = fetch_coinbase(COINBASE_URL, crate::listing::now()).await
            {
                book.ingest_coinbase(rates, crate::listing::now());
            }
            if !stopped.load(Ordering::Acquire) {
                let mut s = state.lock().unwrap();
                if s.settings.relays == relays {
                    book.prune(crate::listing::now());
                    let _ = s.store.save_exchange_rates(&book);
                    s.rates = book;
                    s.revision += 1;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(if needed && !relays.is_empty() {
            300
        } else {
            5
        }))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};
    use serde_json::json;

    #[test]
    fn rates_validate_signed_source_base_bounds_and_expiry() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(1009), "")
            .tags([Tag::parse(["d", "BTCEUR", "60000", "59999", "58000", "62000"]).unwrap()])
            .custom_created_at(Timestamp::from(1000))
            .sign_with_keys(&keys)
            .unwrap();
        let expected = keys.public_key().to_hex();
        assert_eq!(
            parse_snort(&event, 1000, &expected).unwrap().1.value,
            60000.0
        );
        assert!(parse_snort(&event, 1000, SNORT_PUBLISHER).is_none());
        assert!(parse_snort(&event, 939, &expected).is_none());
        assert!(parse_snort(&event, 1000 + MAX_AGE_SECONDS + 1, &expected).is_none());
        let mut forged = event.clone();
        forged.content = "changed".into();
        assert!(parse_snort(&forged, 1000, &expected).is_none());
        assert!(
            parse_coinbase(
                &json!({"data":{"currency":"USD","rates":{"BTC":"1","EUR":"60000"}}}),
                1000
            )
            .is_err()
        );
        assert!(
            parse_coinbase(
                &json!({"data":{"currency":"BTC","rates":{"BTC":"2","EUR":"60000"}}}),
                1000
            )
            .is_err()
        );
        let rates = parse_coinbase(&json!({"data":{"currency":"BTC","rates":{"BTC":"1","EUR":"60000","USD":"66000","BAD":"NaN","NEG":"-1"}}}),1000).unwrap();
        assert_eq!(rates.len(), 2);
        let book = RateBook { rates };
        assert_eq!(book.snapshot(1000).status, "fresh");
        assert_eq!(book.snapshot(1000 + FRESH_SECONDS + 1).status, "stale");
        assert_eq!(
            book.snapshot(1000 + MAX_AGE_SECONDS + 1).status,
            "unavailable"
        );
        assert!(RateBook::from_cache(&" ".repeat(CACHE_BYTES + 1), 1000).is_err());
    }

    #[test]
    fn cached_display_conversion_keeps_original_and_unavailable_prices() {
        let book = RateBook {
            rates: parse_coinbase(
                &json!({"data":{"currency":"BTC","rates":{"BTC":"1","EUR":"60000","USD":"66000"}}}),
                1000,
            )
            .unwrap(),
        };
        let restored = RateBook::from_cache(&book.cache_json().unwrap(), 1000).unwrap();
        let display = restored.convert("66", "USD", "EUR", 1000).unwrap();
        assert!((display.amount - 60.0).abs() < 1e-9);
        assert!(display.approximate);
        assert!(!display.stale);
        assert_eq!(
            restored
                .convert("100000000", "satoshi", "EUR", 1000)
                .unwrap()
                .amount,
            60000.0
        );
        assert_eq!(
            restored.convert("1", "BTC", "SATS", 1000).unwrap().amount,
            100000000.0
        );
        assert!(
            !restored
                .convert("1", "BTC", "SATS", 1000)
                .unwrap()
                .approximate
        );
        assert!(
            restored
                .convert("66", "USD", "EUR", 1000 + FRESH_SECONDS + 1)
                .unwrap()
                .stale
        );
        assert!(
            restored
                .convert("66", "USD", "EUR", 1000 + MAX_AGE_SECONDS + 1)
                .is_none()
        );
        assert!(restored.convert("66", "USD", "USD", 1000).is_none());
        assert!(restored.convert("66", "XYZ", "EUR", 1000).is_none());
        assert!(restored.convert("-1", "USD", "EUR", 1000).is_none());
        assert_eq!(
            restored.convert("0", "XYZ", "EUR", 1000).unwrap().amount,
            0.0
        );
    }
}
