use crate::{State, listing};
use anyhow::{Context, Result, bail, ensure};
use nostr::{
    ClientMessage, Event, EventBuilder, Filter, JsonUtil, Kind, PublicKey, RelayMessage,
    SubscriptionId, Timestamp, UnsignedEvent,
};
use nostr_pubsub_relay::{RelaySession, RelaySessionEvent};
use serde_json::value::RawValue;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub(crate) fn draft(
    owner: PublicKey,
    name: &str,
    previous: Option<&Event>,
) -> Result<UnsignedEvent> {
    let mut fields: BTreeMap<String, Box<RawValue>> = match previous {
        Some(event) => {
            serde_json::from_str(&event.content).context("Existing profile is unreadable")?
        }
        None => BTreeMap::new(),
    };
    let encoded = RawValue::from_string(serde_json::to_string(name)?)?;
    if !fields.contains_key("name") {
        fields.insert("name".into(), encoded.clone());
    }
    fields.insert("display_name".into(), encoded);
    let now = listing::now();
    let at = now.max(previous.map_or(0, |event| event.created_at.as_secs().saturating_add(1)));
    ensure!(
        at <= now + 600,
        "Check the date of the latest profile before editing"
    );
    Ok(
        EventBuilder::new(Kind::Metadata, serde_json::to_string(&fields)?)
            .allow_self_tagging()
            .tags(previous.into_iter().flat_map(|e| e.tags.iter().cloned()))
            .custom_created_at(Timestamp::from(at))
            .build(owner),
    )
}

fn latest(events: impl IntoIterator<Item = Event>) -> Option<Event> {
    events.into_iter().max_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| b.id.cmp(&a.id))
    })
}

// An empty answer is authoritative only after the relay's own EOSE. The listing
// query API intentionally returns partial results and cannot make this distinction.
async fn relay_head(url: String, owner: PublicKey) -> Result<Option<Event>> {
    let mut session = RelaySession::connect(&url).await?;
    let id = SubscriptionId::generate();
    let mut winner = None;
    for _ in 0..64 {
        match session.next().await?.context("Relay closed")? {
            RelaySessionEvent::Connection(true) => {
                session
                    .send(ClientMessage::req(
                        id.clone(),
                        vec![Filter::new().kind(Kind::Metadata).author(owner).limit(1)],
                    ))
                    .await?
            }
            RelaySessionEvent::Message(message) => match *message {
                RelayMessage::Event {
                    subscription_id,
                    event,
                } if subscription_id.as_ref() == &id => {
                    ensure!(
                        event.pubkey == owner
                            && event.kind == Kind::Metadata
                            && event.as_json().len() <= 2 * 1024 * 1024,
                        "Unexpected profile event"
                    );
                    event.verify()?;
                    winner = latest(winner.into_iter().chain([event.into_owned()]));
                }
                RelayMessage::EndOfStoredEvents(received) if received.as_ref() == &id => {
                    return Ok(winner);
                }
                RelayMessage::Closed {
                    subscription_id, ..
                } if subscription_id.as_ref() == &id => bail!("Relay could not check the profile"),
                _ => {}
            },
            RelaySessionEvent::Connection(false) | RelaySessionEvent::Lagged(_) => {
                bail!("Relay history is incomplete")
            }
        }
    }
    bail!("Too many messages while checking the profile")
}

async fn latest_relay_head(owner: PublicKey, relays: &[String]) -> Result<Option<Event>> {
    ensure!(!relays.is_empty(), "Select a relay to publish your profile");
    let mut queries = tokio::task::JoinSet::new();
    for url in relays {
        queries.spawn(relay_head(url.clone(), owner));
    }
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut events = Vec::new();
        while let Some(result) = queries.join_next().await {
            events.extend(result??);
        }
        Ok(latest(events))
    })
    .await?
}

async fn save_pending(
    state: &Mutex<State>,
    stopped: &AtomicBool,
    owner: PublicKey,
    name: &str,
    relays: &[String],
) -> Result<()> {
    let relay_head = latest_relay_head(owner, relays).await?;
    let (previous, signer, remote) = {
        let s = state.lock().unwrap();
        ensure!(
            !stopped.load(Ordering::Acquire)
                && s.settings.relays == relays
                && s.pending_profile_name.as_deref() == Some(name),
            "Profile changed"
        );
        (
            latest(
                relay_head
                    .into_iter()
                    .chain(s.profiles.metadata_event(&owner.to_hex()).cloned()),
            ),
            s.owner_keys.clone(),
            s.remote_signer.clone(),
        )
    };
    let unsigned = draft(owner, name, previous.as_ref())?;
    let (signed, after_signing) = if let Some(keys) = signer {
        (unsigned.sign_with_keys(&keys)?, None)
    } else {
        let (signer, approval) = remote.context("Connect your profile signer")?;
        let signed = match signer.sign(unsigned, &approval).await {
            Ok(event) => event,
            Err(error) => {
                let mut s = state.lock().unwrap();
                if s.pending_profile_name.as_deref() == Some(name) {
                    s.profile_signing_paused = true;
                    s.status = "Profile signature declined. Save the name again to retry.".into();
                    s.revision += 1;
                }
                return Err(error);
            }
        };
        (signed, latest_relay_head(owner, relays).await?)
    };
    let mut s = state.lock().unwrap();
    let current = s.profiles.metadata_event(&owner.to_hex()).cloned();
    ensure!(
        !stopped.load(Ordering::Acquire)
            && s.settings.relays == relays
            && s.pending_profile_name.as_deref() == Some(name),
        "Profile changed while signing"
    );
    let base_id = previous.as_ref().map(|event| event.id);
    if let Some(head) = latest(current.into_iter().chain(after_signing).chain(previous))
        && Some(head.id) != base_id
    {
        // Keep the name pending. The worker will request a signature for the newer profile.
        s.profiles.ingest_public(head)?;
        s.revision += 1;
        return Ok(());
    }
    s.store.queue_profile_metadata(&signed)?;
    s.pending_profile_name = None;
    s.profiles.ingest_public(signed)?;
    s.status = "Profile saved · queued for delivery".into();
    s.revision += 1;
    Ok(())
}

pub(crate) async fn sync(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    while !stopped.load(Ordering::Acquire) {
        let pending = {
            let s = state.lock().unwrap();
            if s.profile_signing_paused || (s.owner_keys.is_none() && s.remote_signer.is_none()) {
                None
            } else {
                s.pending_profile_name
                    .clone()
                    .map(|name| (s.owner, name, s.settings.relays.clone()))
            }
        };
        if let Some((owner, name, relays)) = pending {
            match save_pending(&state, &stopped, owner, &name, &relays).await {
                Ok(()) => notify.notify_waiters(),
                Err(_) => tokio::time::sleep(Duration::from_secs(15)).await,
            }
        } else {
            tokio::select! { _ = notify.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(15)) => {} }
        }
    }
}
