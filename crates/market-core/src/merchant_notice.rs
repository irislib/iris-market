//! A fixed, one-way invitation. Never use an account or device signer here.
use crate::{Market, State, identity, listing, messaging::Messaging, network};
use anyhow::{Context, Result, ensure};
use iris_chat_protocol::{
    APP_KEYS_EVENT_KIND, AppKeys, INVITE_EVENT_KIND, INVITE_LIST_LABEL, parse_invite_event,
};
use nostr::{Event, EventBuilder, Filter, Keys, Kind, PublicKey};
use nostr_double_ratchet::VerifiedAppKeysIndex;
use nostr_pubsub_relay::RelayEventBus;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const MESSAGE: &str = "Someone wants to buy from you on market.iris.to. Open Iris Market to set up private messaging.";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Notice {
    pub until: u64,
    status: String,
    event: Option<Event>,
}

fn eligible_listing(state: &State, id: &str) -> Result<PublicKey> {
    ensure!(!state.demo, "Sample listings cannot receive notifications");
    let event = state.store.event(id)?;
    let offer = listing::parse(&event, listing::now())?;
    ensure!(
        offer.id == id
            && offer.side == "offer"
            && offer.status == "active"
            && offer.expires_at.is_none_or(|t| t > listing::now())
            && offer.external_order.is_none()
            && event.pubkey != state.owner,
        "This offer is unavailable"
    );
    Ok(event.pubkey)
}

fn destinations(
    merchant: PublicKey,
    records: &[Event],
    discovery: &[String],
) -> Result<Option<Vec<String>>> {
    let mut rosters = VerifiedAppKeysIndex::default();
    let mut invites = BTreeMap::new();
    let mut inbox = None;
    let now = listing::now();
    for event in records.iter().filter(|e| e.pubkey == merchant) {
        event.verify()?;
        ensure!(
            event.created_at.as_secs() <= now + 300,
            "Seller settings could not be verified"
        );
        if iris_chat_protocol::is_app_keys_event(event) {
            rosters.ingest(event.clone(), now)?;
        } else if event.kind == Kind::InboxRelays {
            keep_latest(&mut inbox, event);
        } else if event.kind.as_u16() == INVITE_EVENT_KIND as u16
            && let Some(d) = event
                .tags
                .identifier()
                .filter(|d| d.starts_with("double-ratchet/invites/"))
        {
            keep_latest(invites.entry(d).or_default(), event);
        }
    }
    let heads = rosters.events_for_owner(merchant);
    ensure!(heads.len() <= 1, "Conflicting seller device lists");
    for head in heads {
        if !AppKeys::from_event(&head)?.get_all_devices().is_empty() {
            return Ok(None);
        }
    }
    if invites.values().flatten().any(|e| {
        e.tags
            .iter()
            .any(|t| t.as_slice() == ["l", INVITE_LIST_LABEL])
            && !e.is_expired()
            && parse_invite_event(e).is_ok()
    }) {
        return Ok(None);
    }
    let Some(inbox) = inbox.filter(|e| !e.is_expired()) else {
        return Ok(Some(vec![]));
    };
    let mut urls = Vec::new();
    for tag in inbox.tags.iter().map(|t| t.as_slice()) {
        if tag.first().is_none_or(|t| t != "relay") {
            continue;
        }
        let Some(raw) = tag.get(1) else {
            continue;
        };
        let Ok(url) = url::Url::parse(raw) else {
            continue;
        };
        if url.fragment().is_some()
            || url.query().is_some()
            || network::validate_relays(std::slice::from_ref(raw)).is_err()
            || url.scheme() == "ws"
                && !discovery
                    .iter()
                    .any(|r| url::Url::parse(r).ok().as_ref() == Some(&url))
        {
            continue;
        }
        let url = url.to_string();
        if !urls.contains(&url) {
            urls.push(url);
        }
        if urls.len() == 8 {
            break;
        }
    }
    Ok(Some(urls))
}

fn keep_latest<'a>(slot: &mut Option<&'a Event>, event: &'a Event) {
    if slot.is_none_or(|old| {
        event.created_at > old.created_at || event.created_at == old.created_at && event.id < old.id
    }) {
        *slot = Some(event);
    }
}

async fn discover(merchant: PublicKey, relays: &[String]) -> Result<Option<Vec<String>>> {
    let filter = Filter::new()
        .author(merchant)
        .kinds([
            Kind::from(APP_KEYS_EVENT_KIND as u16),
            Kind::from(INVITE_EVENT_KIND as u16),
            Kind::InboxRelays,
        ])
        .limit(1024);
    let (mut records, complete, partial) =
        identity::fetch_owner_events(relays, filter.clone()).await?;
    let inbox = destinations(merchant, &records, relays)?;
    if !partial || inbox.is_none() {
        return Ok(inbox);
    }
    let urls = inbox.unwrap_or_default();
    ensure!(
        complete > 0 && !urls.is_empty(),
        "Could not check seller messaging"
    );
    let (confirmed, count, partial) = identity::fetch_owner_events(&urls, filter).await?;
    ensure!(count > 0 && !partial, "Could not check seller messaging");
    records.extend(confirmed);
    destinations(merchant, &records, relays)
}

impl Market {
    /// A read never creates a notice. An explicit send durably queues one envelope per seller.
    pub fn merchant_notice(&self, id: &str, send: bool) -> Result<String> {
        let (merchant, relays) = {
            let s = self.state.lock().unwrap();
            let merchant = eligible_listing(&s, id)?;
            let chat = s
                .messaging
                .as_ref()
                .context("Private storage unavailable")?;
            if chat.knows_merchant_chat(merchant) {
                return Ok("unavailable".into());
            }
            if let Some(row) = chat
                .merchant_notices()
                .get(&merchant)
                .filter(|r| r.until > listing::now())
            {
                return Ok(row.status.clone());
            }
            (merchant, s.settings.relays.clone())
        };
        let runtime = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .context("App has closed")?
            .handle()
            .clone();
        if !send {
            return Ok(match runtime.block_on(discover(merchant, &relays))? {
                None => "unavailable",
                Some(urls) if urls.is_empty() => "no-inbox",
                Some(_) => "available",
            }
            .into());
        }
        let event = runtime.block_on(EventBuilder::private_msg(
            &Keys::generate(),
            merchant,
            MESSAGE,
            [],
        ))?;
        let mut s = self.state.lock().unwrap();
        ensure!(merchant == eligible_listing(&s, id)?, "Offer has changed");
        let chat = s
            .messaging
            .as_mut()
            .context("Private storage unavailable")?;
        if let Some(row) = chat
            .merchant_notices()
            .get(&merchant)
            .filter(|r| r.until > listing::now())
        {
            return Ok(row.status.clone());
        }
        chat.save_merchant_notice(
            merchant,
            Notice {
                until: listing::now() + 86400,
                status: "queued".into(),
                event: Some(event),
            },
        )
        .map_err(anyhow::Error::msg)?;
        self.notify.notify_waiters();
        Ok("queued".into())
    }
}

async fn deliver(
    state: &Mutex<State>,
    stopped: &AtomicBool,
    merchant: PublicKey,
    event: &Event,
) -> Result<&'static str> {
    let relays = state.lock().unwrap().settings.relays.clone();
    let Some(urls) = discover(merchant, &relays).await? else {
        return Ok("unavailable");
    };
    if urls.is_empty() {
        return Ok("no-inbox");
    }
    let sender = RelayEventBus::new(urls, Duration::from_secs(5)).await?;
    let allowed = {
        let s = state.lock().unwrap();
        !stopped.load(Ordering::Acquire)
            && relays == s.settings.relays
            && s.messaging.as_ref().is_some_and(|m| {
                !m.knows_merchant_chat(merchant)
                    && m.merchant_notices()
                        .get(&merchant)
                        .is_some_and(|r| r.until > listing::now())
            })
    };
    let result = if allowed {
        tokio::time::timeout(Duration::from_secs(8), sender.client().send_event(event))
            .await
            .is_ok_and(|r| r.is_ok_and(|receipt| !receipt.success.is_empty()))
    } else {
        false
    };
    sender.client().shutdown().await;
    ensure!(result, "No seller inbox accepted the notice");
    Ok("sent")
}

pub(crate) async fn deliver_pending(
    state: Arc<Mutex<State>>,
    stopped: Arc<AtomicBool>,
    notify: Arc<Notify>,
) {
    let mut retries = BTreeMap::new();
    while !stopped.load(Ordering::Acquire) {
        let pending = {
            let s = state.lock().unwrap();
            s.messaging
                .as_ref()
                .map(Messaging::merchant_notices)
                .into_iter()
                .flatten()
                .filter(|(_, r)| r.until > listing::now())
                .filter_map(|(key, r)| Some((*key, r.event.clone()?)))
                .collect::<Vec<_>>()
        };
        retries.retain(|key, _| pending.iter().any(|(merchant, _)| key == merchant));
        for (merchant, event) in pending {
            if retries.get(&merchant).is_some_and(|t| *t > listing::now()) {
                continue;
            }
            retries.insert(merchant, listing::now() + 60);
            if let Ok(status) = deliver(&state, &stopped, merchant, &event).await {
                let mut s = state.lock().unwrap();
                if let Some(chat) = &mut s.messaging
                    && let Some(mut row) = chat.merchant_notices().get(&merchant).cloned()
                    && row.event.as_ref().is_some_and(|e| e.id == event.id)
                {
                    row.status = status.into();
                    row.event = None;
                    let _ = chat.save_merchant_notice(merchant, row);
                }
            }
        }
        tokio::select! { _ = notify.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Draft, Settings};
    use crate::store::Store;
    use nostr::{Tag, Timestamp, nips::nip59::UnwrappedGift};

    fn inbox(seller: &Keys, relay: &str, at: u64) -> Event {
        EventBuilder::new(Kind::InboxRelays, "")
            .tags([Tag::parse(["relay", relay]).unwrap()])
            .custom_created_at(Timestamp::from(at))
            .sign_with_keys(seller)
            .unwrap()
    }

    #[test]
    fn signed_inbox_and_current_chat_setup_gate_the_fallback() {
        let seller = Keys::generate();
        let key = seller.public_key();
        let now = listing::now();
        let first = inbox(&seller, "wss://old.example", now - 2);
        let latest = inbox(&seller, "wss://new.example", now - 1);
        let foreign = inbox(&Keys::generate(), "wss://other.example", now);
        let records = [first, latest.clone(), foreign];
        assert_eq!(
            destinations(key, &records, &[]).unwrap().unwrap(),
            ["wss://new.example/"]
        );
        let roster = AppKeys::new(vec![iris_chat_protocol::DeviceEntry::new(
            Keys::generate().public_key(),
            now,
        )])
        .get_event_at(key, now)
        .sign_with_keys(&seller)
        .unwrap();
        assert!(
            destinations(key, &[latest.clone(), roster], &[])
                .unwrap()
                .is_none()
        );
        assert!(
            destinations(
                key,
                &[latest, inbox(&seller, "ws://localhost:42", now)],
                &[]
            )
            .unwrap()
            .unwrap()
            .is_empty()
        );
        let dir = tempfile::tempdir().unwrap();
        let mut merchant = Messaging::open(dir.path(), seller.clone()).unwrap();
        let contact = merchant.public_contact_event().unwrap();
        assert!(
            destinations(
                key,
                &[inbox(&seller, "wss://new.example", now), contact],
                &[]
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn click_queues_one_decryptable_anonymous_notice_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        Store::open(&dir.path().join("market.sqlite"))
            .unwrap()
            .save_settings(&Settings {
                relays: vec![],
                ..Default::default()
            })
            .unwrap();
        let seller = Keys::generate();
        let buyer = Keys::generate();
        let open = || Market::open(dir.path(), &buyer.secret_key().to_secret_hex(), false).unwrap();
        let app = open();
        let offer = Draft {
            title: "Desk".into(),
            description: "Private listing detail".into(),
            side: "offer".into(),
            category: "home".into(),
            price: "20".into(),
            currency: "EUR".into(),
            location: String::new(),
            tags: vec![],
            image_url: None,
            escrow: None,
            service_areas: None,
            expires_at: None,
        };
        let event = listing::build(&seller, &offer, "desk", listing::now(), false).unwrap();
        app.ingest_event(&event).unwrap();
        let id = format!("{}:desk", seller.public_key().to_hex());
        assert!(app.merchant_notice(&id, false).is_err()); // offline isn't evidence of missing messaging
        assert_eq!(app.merchant_notice(&id, true).unwrap(), "queued");
        assert_eq!(app.merchant_notice(&id, true).unwrap(), "queued");
        let read = |app: &Market| {
            let state = app.state.lock().unwrap();
            let rows = state.messaging.as_ref().unwrap().merchant_notices();
            assert_eq!(rows.len(), 1);
            rows[&seller.public_key()].event.clone().unwrap()
        };
        let wrap = read(&app);
        assert_eq!(wrap.kind, Kind::GiftWrap);
        assert_eq!(
            wrap.tags.as_slice(),
            &[Tag::public_key(seller.public_key())]
        );
        wrap.verify().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let inner = runtime
            .block_on(UnwrappedGift::from_gift_wrap(&seller, &wrap))
            .unwrap();
        assert_eq!(inner.rumor.kind, Kind::PrivateDirectMessage);
        assert_eq!(inner.rumor.content, MESSAGE);
        assert_eq!(inner.rumor.pubkey, inner.sender);
        assert_eq!(
            inner.rumor.tags.as_slice(),
            &[Tag::public_key(seller.public_key())]
        );
        assert_ne!(inner.sender, buyer.public_key());
        assert_ne!(inner.sender, wrap.pubkey);
        assert!(
            runtime
                .block_on(UnwrappedGift::from_gift_wrap(&buyer, &wrap))
                .is_err()
        );
        assert!(!app.snapshot().unwrap().contains(&wrap.id.to_hex()));
        app.shutdown();
        drop(app);
        let reopened = open();
        assert_eq!(read(&reopened).id, wrap.id);
        reopened.shutdown();
    }
}
