//! Account/device boundaries and the standard Iris Chat device-link bootstrap.
//! Signer roster normalization follows Iris Chat (MIT; IRIS_CHAT_LICENSE.txt).
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use iris_chat_protocol::{AppKeys, DeviceEntry, Invite, app_keys_event_is_acceptable_for_owner};
use nostr::{Event, Filter, JsonUtil, Keys, Kind, PublicKey, SecretKey, Tags};
use nostr_double_ratchet::{DeviceMembership, VerifiedAppKeysIndex};
use nostr_identity::{
    CreateNostrIdentityDeviceApprovalRequestOptions, NostrIdentityDeviceApprovalBootstrap,
    create_nostr_identity_device_approval_request, encode_nostr_identity_device_approval_bootstrap,
    nostr_identity_device_approval_bootstrap,
};
use nostr_pubsub::{EventBus, QueryOptions};
use nostr_pubsub_relay::RelayEventBus;
use std::{path::Path, time::Duration};

pub fn public_key(secret: &str) -> Result<String> {
    Ok(Keys::parse(secret)?.public_key().to_hex())
}

pub fn prepare_registration(
    owner: PublicKey,
    device: PublicKey,
    previous: &[Event],
    now: u64,
) -> Result<nostr::UnsignedEvent> {
    ensure!(previous.len() <= 16, "Device list is too large");
    let mut index = VerifiedAppKeysIndex::default();
    for event in previous {
        ensure!(
            app_keys_event_is_acceptable_for_owner(owner, event, now),
            "Invalid device authorization"
        );
        index.ingest(event.clone(), now)?;
    }
    let heads = index.events_for_owner(owner);
    ensure!(
        heads.len() <= 1,
        "Conflicting device authorizations; resolve them in Iris Chat first"
    );
    let mut keys = heads
        .first()
        .map(AppKeys::from_event)
        .transpose()?
        .unwrap_or_else(|| AppKeys::new(Vec::new()));
    let created = now.max(
        heads
            .first()
            .map_or(0, |event| event.created_at.as_secs().saturating_add(1)),
    );
    ensure!(
        created <= now.saturating_add(300),
        "Device list is dated too far ahead"
    );
    keys.add_device(DeviceEntry::new(device, now));
    ensure!(
        keys.get_all_devices().len() <= 64,
        "Too many linked devices"
    );
    let mut draft = keys.get_event_at(owner, created);
    let mut tags = draft.tags.iter().cloned().collect::<Vec<_>>();
    tags.push(nostr::Tag::public_key(owner));
    tags.sort_by(|a, b| a.as_slice().cmp(b.as_slice()));
    tags.dedup();
    draft.tags = Tags::from_list(tags);
    draft.id = None;
    draft.ensure_id();
    ensure!(
        serde_json::to_vec(&draft)?.len() < 32 * 1024 - 256,
        "Device list is too large"
    );
    Ok(draft)
}

/// EOSE is required before an empty result can mean a new account. This follows
/// Iris Chat's signer lookup: outages cannot erase an existing device list.
pub async fn fetch_authorization_complete(
    relays: &[String],
    owner: PublicKey,
) -> Result<Vec<Event>> {
    use nostr::{RelayMessage, SubscriptionId};
    use nostr_sdk::prelude::RelayNotification;
    use nostr_sdk::{Client, SubscribeOptions};
    ensure!(!relays.is_empty(), "No message servers available");
    let client = Client::default();
    let mut jobs = tokio::task::JoinSet::new();
    for url in relays {
        let client = client.clone();
        let url = url.clone();
        jobs.spawn(async move {
            let mut events = Vec::new();
            let mut exceeded = false;
            let result = tokio::time::timeout(Duration::from_secs(8), async {
                client.add_relay(url.clone()).await?;
                let relay = client.relay(url).await?;
                let mut notifications = relay.notifications();
                relay.connect();
                let subscription = SubscriptionId::generate();
                relay
                    .subscribe_with_id(
                        subscription.clone(),
                        Filter::new()
                            .author(owner)
                            .kind(Kind::from(iris_chat_protocol::APP_KEYS_EVENT_KIND as u16))
                            .limit(1024),
                        SubscribeOptions::default(),
                    )
                    .await?;
                loop {
                    match notifications.recv().await? {
                        RelayNotification::Message {
                            message:
                                RelayMessage::Event {
                                    subscription_id,
                                    event,
                                },
                        } if subscription_id.as_ref() == &subscription => {
                            if events.len() >= 1023 {
                                exceeded = true;
                                anyhow::bail!("Device list is too large");
                            }
                            events.push(event.into_owned());
                        }
                        RelayNotification::Message {
                            message: RelayMessage::EndOfStoredEvents(id),
                        } if id.as_ref() == &subscription => {
                            let _ = relay.unsubscribe(&subscription).await;
                            return Ok::<_, anyhow::Error>(());
                        }
                        RelayNotification::Message {
                            message:
                                RelayMessage::Closed {
                                    subscription_id, ..
                                },
                        } if subscription_id.as_ref() == &subscription => {
                            anyhow::bail!("Device lookup closed")
                        }
                        RelayNotification::AuthenticationFailed | RelayNotification::Shutdown => {
                            anyhow::bail!("Message server unavailable")
                        }
                        _ => {}
                    }
                }
            })
            .await;
            (events, matches!(result, Ok(Ok(()))), exceeded)
        });
    }
    let mut events = Vec::new();
    let mut complete = 0;
    let mut incomplete = false;
    let mut exceeded = false;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok((received, done, too_many)) => {
                events.extend(received);
                complete += usize::from(done);
                incomplete |= !done;
                exceeded |= too_many;
            }
            Err(_) => incomplete = true,
        }
    }
    client.shutdown().await;
    ensure!(!exceeded, "Device list is too large");
    let mut index = VerifiedAppKeysIndex::default();
    for event in events
        .into_iter()
        .filter(|event| event.pubkey == owner && iris_chat_protocol::is_app_keys_event(event))
    {
        index.ingest(event, crate::listing::now())?;
    }
    let heads = index.events_for_owner(owner);
    ensure!(
        complete > 0 && (!incomplete || !heads.is_empty()),
        "Could not check device authorization; try again"
    );
    Ok(heads)
}

pub async fn register_device(
    owner_secret: &str,
    device_secret: &str,
    relays: &[String],
) -> Result<Event> {
    crate::network::validate_relays(relays)?;
    let owner = Keys::parse(owner_secret).context("Invalid account secret")?;
    let device = Keys::parse(device_secret).context("Invalid device secret")?;
    let previous = fetch_authorization_complete(relays, owner.public_key()).await?;
    let draft = prepare_registration(
        owner.public_key(),
        device.public_key(),
        &previous,
        crate::listing::now(),
    )?;
    let event = draft.sign_with_keys(&owner)?;
    let current = fetch_authorization_complete(relays, owner.public_key()).await?;
    ensure!(
        current.iter().map(|event| event.id).collect::<Vec<_>>()
            == previous.iter().map(|event| event.id).collect::<Vec<_>>(),
        "Your device list changed; sign in again"
    );
    let bus = RelayEventBus::new(relays.to_vec(), Duration::from_secs(5)).await?;
    bus.client()
        .wait_for_connection(Duration::from_secs(4))
        .await;
    let sent = tokio::time::timeout(Duration::from_secs(8), bus.client().send_event(&event)).await;
    bus.client().shutdown().await;
    ensure!(
        sent.is_ok_and(|result| result.is_ok_and(|output| !output.success.is_empty())),
        "Device authorization was not accepted by a message server"
    );
    Ok(event)
}

pub struct DeviceLink {
    device: Keys,
    bootstrap: NostrIdentityDeviceApprovalBootstrap,
    invite: Invite,
    relays: Vec<String>,
    responses: Vec<Event>,
    authorization: VerifiedAppKeysIndex,
    authorization_owners: Vec<PublicKey>,
}
impl DeviceLink {
    pub fn new(
        device_secret: &str,
        restored_bootstrap: Option<&str>,
        relays: Vec<String>,
    ) -> Result<Self> {
        crate::network::validate_relays(&relays)?;
        ensure!(!relays.is_empty(), "Choose a device approval server");
        let device = Keys::new(SecretKey::parse(device_secret)?);
        let mut authorization = VerifiedAppKeysIndex::default();
        let mut authorization_owners = Vec::new();
        let bootstrap = if let Some(raw) = restored_bootstrap {
            ensure!(raw.len() < 1_048_576, "Device link is too large");
            let stored: serde_json::Value = serde_json::from_str(raw)?;
            if let Some(proofs) = stored
                .get("authorization")
                .and_then(|value| value.as_array())
            {
                ensure!(proofs.len() <= 32, "Too many device authorizations");
                for proof in proofs {
                    let event: Event = serde_json::from_value(proof.clone())?;
                    authorization_owners.push(event.pubkey);
                    authorization.ingest(event, crate::listing::now())?;
                }
            }
            serde_json::from_value(stored.get("bootstrap").cloned().unwrap_or(stored))?
        } else {
            let request = create_nostr_identity_device_approval_request(
                &device,
                CreateNostrIdentityDeviceApprovalRequestOptions {
                    request_keys: None,
                    request_secret: None,
                    requested_at: crate::listing::now() as i64,
                    request_type: Some("device_link".into()),
                    resources: Vec::new(),
                    expires_at: None,
                    profile_id: None,
                    admin_app_key_pubkey: None,
                    label: Some("Iris Market".into()),
                },
            )?;
            nostr_identity_device_approval_bootstrap(&request.request)?
        };
        ensure!(
            PublicKey::parse(&bootstrap.device_app_key_npub)? == device.public_key(),
            "Device link does not match this device"
        );
        let secret = URL_SAFE_NO_PAD.decode(&bootstrap.request_secret)?;
        ensure!(secret.len() == 32, "Invalid device link secret");
        let secret_hex = secret
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let invite = nostr_double_ratchet::deterministic_link_invite_for_device(
            device.public_key(),
            &secret_hex,
        )?;
        Ok(Self {
            device,
            bootstrap,
            invite,
            relays,
            responses: Vec::new(),
            authorization,
            authorization_owners,
        })
    }
    /// This private capability belongs in platform secure storage, never the feed snapshot.
    pub fn bootstrap(&self) -> Result<String> {
        let mut proofs = Vec::new();
        for owner in &self.authorization_owners {
            proofs.extend(self.authorization.events_for_owner(*owner));
        }
        proofs.sort_by_key(|event| event.id);
        proofs.dedup_by_key(|event| event.id);
        Ok(serde_json::json!({"bootstrap":self.bootstrap,"authorization":proofs}).to_string())
    }
    pub fn invitation(&self) -> Result<String> {
        Ok(encode_nostr_identity_device_approval_bootstrap(
            &self.bootstrap,
            None,
        )?)
    }
    pub fn pairing_invite(&self) -> &Invite {
        &self.invite
    }
    pub fn receive_response(&mut self, event: Event) -> Result<()> {
        ensure!(
            event.as_json().len() <= 64 * 1024 && event.verify().is_ok(),
            "Invalid approval response"
        );
        if self.responses.iter().all(|known| known.id != event.id) {
            ensure!(
                self.responses.len() < 16,
                "Too many device approval responses"
            );
            self.responses.push(event);
        }
        Ok(())
    }
    pub fn apply_approval(
        &mut self,
        directory: &Path,
        authorization: &[Event],
    ) -> Result<Option<String>> {
        for event in &self.responses {
            let Ok(Some(response)) = nostr_double_ratchet::process_invite_response_event(
                &self.invite,
                event,
                self.device.secret_key().to_secret_bytes(),
            ) else {
                continue;
            };
            let owner = match (response.owner_public_key, response.invitee_owner_pubkey) {
                (Some(owner), Some(claim)) if owner.to_bytes() == claim.to_bytes() => owner,
                (None, None) => response.invitee_identity,
                _ => continue,
            };
            if !self.authorization_owners.contains(&owner) {
                self.authorization_owners.push(owner);
            }
            for proof in authorization.iter().filter(|proof| proof.pubkey == owner) {
                let _ = self
                    .authorization
                    .ingest(proof.clone(), crate::listing::now());
            }
            let index = &self.authorization;
            let approver = response.invitee_identity;
            if index.membership(owner, self.device.public_key()) != DeviceMembership::Authorized
                || (approver != owner
                    && index.membership(owner, approver) != DeviceMembership::Authorized)
            {
                continue;
            }
            let proofs = index.events_for_owner(owner);
            ensure!(proofs.len() == 1, "Conflicting device authorization");
            let proof = &proofs[0];
            let account_directory = directory.join(owner.to_hex());
            let mut messaging = crate::messaging::Messaging::open_identity(
                &account_directory,
                owner,
                None,
                self.device.clone(),
                Some(proof),
            )
            .map_err(anyhow::Error::msg)?;
            messaging
                .import_link_session(&event.id.to_hex(), owner, approver, response.session.state)
                .map_err(anyhow::Error::msg)?;
            return Ok(Some(
                serde_json::json!({"owner_public_key":owner.to_hex(),"authorization":proof})
                    .to_string(),
            ));
        }
        Ok(None)
    }
    pub async fn poll(&mut self, directory: &Path) -> Result<Option<String>> {
        let recipient =
            PublicKey::from_slice(&self.invite.inviter_ephemeral_public_key.to_bytes())?;
        let bus = RelayEventBus::new(self.relays.clone(), Duration::from_secs(3)).await?;
        bus.client()
            .wait_for_connection(Duration::from_secs(3))
            .await;
        let fetched = bus
            .query(
                vec![
                    Filter::new()
                        .kind(Kind::from(iris_chat_protocol::INVITE_RESPONSE_KIND as u16))
                        .pubkey(recipient)
                        .limit(16),
                ],
                QueryOptions { limit: Some(16) },
            )
            .await;
        bus.client().shutdown().await;
        for received in fetched?.events {
            let _ = self.receive_response(received.event.into_event());
        }
        let mut owners = Vec::new();
        for event in &self.responses {
            if let Ok(Some(response)) = nostr_double_ratchet::process_invite_response_event(
                &self.invite,
                event,
                self.device.secret_key().to_secret_bytes(),
            ) {
                owners.push(response.resolved_owner_pubkey());
            }
        }
        owners.sort();
        owners.dedup();
        let mut authorization = Vec::new();
        for owner in owners {
            authorization
                .extend(crate::network::discover_authorization(&self.relays, owner).await?);
        }
        self.apply_approval(directory, &authorization)
    }
}
