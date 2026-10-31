//! Private marketplace conversations over the shared Iris Chat NDR engine.
//!
//! Transport deliberately lives outside this module. `PrivateSubscription::scope`
//! identifies an isolated receive-only anonymous connection. Outbound events must
//! use fresh, send-only anonymous connections, never those used for public Market
//! listings or for receiving. Only acknowledge an outbound event after a relay OK.

mod controls;
pub mod mobile_push;
pub use controls::Reaction;

use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use fs2::FileExt;
use hkdf::Hkdf;
use iris_chat_protocol::{
    APP_KEYS_EVENT_KIND, INVITE_EVENT_KIND, INVITE_LIST_LABEL, INVITE_RESPONSE_KIND, Invite,
    MESSAGE_EVENT_KIND, ProtocolAcceptInviteOutcome, ProtocolDecryptedMessage, ProtocolEffect,
    ProtocolEngine, ProtocolInviteSessionImportOutcome, ProtocolRetryBatch, StorageAdapter,
    StorageError, StorageResult, UnixSeconds, app_keys_event_is_acceptable_for_owner,
    invite_unsigned_event, invite_url, parse_invite_event, parse_invite_response_event,
    parse_invite_url,
};
use nostr::{
    Alphabet, Event, Filter, JsonUtil, Keys, Kind, PublicKey, SingleLetterTag, UnsignedEvent,
};
use nostr_double_ratchet::{DeviceMembership, ProtocolContext, VerifiedAppKeysIndex};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub type MessagingResult<T> = Result<T, String>;
const APP_STATE: &str = "market/private-state-v1";
const MAX_STORED_VALUE: usize = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;
const MAX_OUTBOX: usize = 256;
const MAX_THREADS: usize = 256;
const MAX_THREAD_MESSAGES: usize = 10_000;
const MAX_SEEN: usize = 8192;
const INVITE_PREFIX: &str = "double-ratchet/invites/";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<crate::conversation_context::MessageContext>,
    pub id: String,
    pub text: String,
    pub mine: bool,
    pub created_at: u64,
    #[serde(default)]
    pub created_at_ms: u64,
    pub delivery: String,
    #[serde(default)]
    pub reactions: Vec<Reaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cashu: Option<CashuPayment>,
}

/// Parsing establishes structure and amount, not mint solvency or unspentness.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CashuPayment {
    pub token: String,
    pub amount: String,
    pub mint: String,
    pub unit: String,
    pub status: String,
}

pub fn cashu_content(text: &str) -> (String, Option<CashuPayment>) {
    use std::str::FromStr;
    let mut clean = String::new();
    let mut payment = None;
    let mut rest = text;
    while let Some(start) = rest.find("cashu") {
        clean.push_str(&rest[..start]);
        rest = &rest[start..];
        if !rest.starts_with("cashuA") && !rest.starts_with("cashuB") {
            clean.push_str("cashu");
            rest = &rest[5..];
            continue;
        }
        let end = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || b"_-=+/".contains(b))
            .count();
        let candidate = &rest[..end];
        if payment.is_none()
            && candidate.len() <= MAX_MESSAGE_BYTES
            && let Ok(token) = cashu::Token::from_str(candidate)
            && let (Ok(amount), Ok(mint)) = (token.value(), token.mint_url())
            && let Ok(url) = url::Url::parse(&mint.to_string())
            && url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
        {
            payment = Some(CashuPayment {
                token: candidate.into(),
                amount: amount.to_string(),
                mint: url.to_string(),
                unit: token
                    .unit()
                    .map(|u| u.to_string())
                    .unwrap_or_else(|| "sat".into()),
                status: "unverified".into(),
            });
        }
        // Never render bearer material, including malformed payment strings.
        clean.push_str("Cashu payment");
        rest = &rest[end..];
    }
    clean.push_str(rest);
    (clean, payment)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub messages: Vec<Message>,
}

/// A scope MUST NOT share a connection/authentication context with other scopes,
/// public listing traffic, or publishing. No account keys are needed by transport.
#[derive(Clone, Debug)]
pub struct PrivateSubscription {
    pub scope: String,
    pub filter: Filter,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct QueuedPublish {
    event: Event,
    inner_id: Option<String>,
    peer_id: String,
    #[serde(default)]
    recipient_device_owner: Option<PublicKey>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PendingContactMessage {
    peer_id: String,
    rumor: UnsignedEvent,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PrivateState {
    #[serde(default)]
    controls: controls::Controls,
    #[serde(default)]
    last_message_ms: u64,
    conversations: BTreeMap<String, Conversation>,
    outbox: BTreeMap<String, QueuedPublish>,
    seen: Vec<String>,
    #[serde(default)]
    public_invite: Option<Invite>,
    #[serde(default)]
    authorization_heads: BTreeMap<String, Vec<Event>>,
    #[serde(default)]
    orders: crate::orders::OrderBook,
    #[serde(default)]
    pending_invites: BTreeMap<String, Invite>,
    #[serde(default)]
    pending_contact_messages: BTreeMap<String, PendingContactMessage>,
}

/// All protocol keys, plaintext messages and queued ciphertext are encrypted at
/// rest. SQLite transaction boundaries cover both the protocol checkpoint and the
/// user-visible state/outbox, including rollback/reload on failed mutations.
pub struct Messaging {
    keys: Keys,
    owner: PublicKey,
    owner_keys: Option<Keys>,
    store: Arc<EncryptedStore>,
    engine: ProtocolEngine,
    state: PrivateState,
}

impl Messaging {
    pub fn open(data_dir: &Path, keys: Keys) -> MessagingResult<Self> {
        Self::open_identity(data_dir, keys.public_key(), Some(keys.clone()), keys, None)
    }

    pub fn open_identity(
        data_dir: &Path,
        owner: PublicKey,
        owner_keys: Option<Keys>,
        device_keys: Keys,
        authorization: Option<&Event>,
    ) -> MessagingResult<Self> {
        if owner_keys
            .as_ref()
            .is_some_and(|keys| keys.public_key() != owner)
        {
            return Err("The profile key does not match this profile".into());
        }
        // The existing key remains the at-rest key for legacy profiles. New
        // accounts use their stable device key, independent of owner signing.
        let store = Arc::new(EncryptedStore::open(data_dir, &device_keys)?);
        let owner_binding = "market/account-owner-v1";
        match store.get(owner_binding).map_err(storage_error)? {
            Some(stored) if stored != owner.to_hex() => {
                return Err("Existing conversations belong to a different profile".into());
            }
            Some(_) => {}
            None => {
                if owner != device_keys.public_key()
                    && !store.list("").map_err(storage_error)?.is_empty()
                {
                    return Err("Existing conversations belong to a different profile".into());
                }
                store
                    .put(owner_binding, owner.to_hex())
                    .map_err(storage_error)?;
            }
        }
        let mut engine = make_engine(Arc::clone(&store), owner, &device_keys)?;
        if let Some(keys) = &owner_keys {
            engine
                .authenticate_local_owner_for_sending(keys)
                .map_err(protocol_error)?;
        }
        let state = read_state(&store)?;
        let mut this = Self {
            owner,
            owner_keys,
            keys: device_keys,
            store,
            engine,
            state,
        };
        if let Some(event) = authorization {
            if event.pubkey != owner {
                return Err("Device authorization belongs to a different profile".into());
            }
            this.ingest_authorization(event)?;
        }
        Ok(this)
    }

    pub fn can_send(&self) -> bool {
        match self.engine.signed_local_device_authorization() {
            Some(authorized) => authorized,
            None => self.owner == self.keys.public_key(),
        }
    }
    pub fn import_link_session(
        &mut self,
        event_id: &str,
        owner: PublicKey,
        approver: PublicKey,
        session: iris_chat_protocol::SessionState,
    ) -> MessagingResult<()> {
        self.require_authorization()?;
        if owner != self.owner {
            return Err("Device link belongs to a different profile".into());
        }
        self.transaction(|this| {
            match this
                .engine
                .import_private_invite_session_once(
                    event_id,
                    owner,
                    approver,
                    session,
                    UnixSeconds(now()),
                )
                .map_err(protocol_error)?
            {
                ProtocolInviteSessionImportOutcome::Imported(batch) => this.apply_batch(batch),
                ProtocolInviteSessionImportOutcome::AlreadyImported => Ok(()),
                ProtocolInviteSessionImportOutcome::Blocked(_) => {
                    Err("Approving device is not authorized".into())
                }
            }
        })
    }
    pub fn device_public_key(&self) -> PublicKey {
        self.keys.public_key()
    }
    fn require_authorization(&self) -> MessagingResult<()> {
        if self.can_send() {
            Ok(())
        } else {
            Err("This device needs account approval before messaging".into())
        }
    }

    /// The returned link is a private capability; never publish it as a listing
    /// tag, put it in analytics, or append it to a download-site URL.
    pub fn invite(&self) -> MessagingResult<String> {
        self.require_authorization()?;
        let invite = self
            .engine
            .local_invite()
            .ok_or("Messaging invitation is unavailable")?;
        invite_url(&invite, "https://market.iris.to/invite").map_err(protocol_error)
    }

    /// Deliberate public-contact opt-in, normally paired with publishing a listing.
    /// This uses a different capability from the privately shared invitation.
    /// The caller publishes the returned standard contact record as public data;
    /// it must never put private invitation URLs into listing tags.
    pub fn public_contact_event(&mut self) -> MessagingResult<Event> {
        self.require_authorization()?;
        self.transaction(|this| {
            if this.state.public_invite.is_none() {
                let mut invite = Invite::create_new(
                    this.keys.public_key(),
                    Some(this.keys.public_key().to_hex()),
                    None,
                )
                .map_err(protocol_error)?;
                invite.owner_public_key = Some(this.owner);
                this.state.public_invite = Some(invite);
            }
            let invite = this
                .state
                .public_invite
                .as_ref()
                .ok_or("Public contact invitation is unavailable")?;
            invite_unsigned_event(invite)
                .map_err(protocol_error)?
                .sign_with_keys(&this.keys)
                .map_err(protocol_error)
        })
    }

    /// Approved devices advertise the canonical public contact capability on
    /// account open, including linked devices that cannot publish listings.
    /// Legacy owner=device profiles remain private until an explicit action.
    pub fn registered_contact_event(&mut self) -> MessagingResult<Option<Event>> {
        if self.engine.signed_local_device_authorization() != Some(true) {
            return Ok(None);
        }
        self.public_contact_event().map(Some)
    }

    /// Fetch this filter through its own anonymous discovery connection. The
    /// expected seller identity comes from the verified listing, never a model.
    pub fn contact_discovery_filter(author: &str) -> MessagingResult<PrivateSubscription> {
        let author = PublicKey::parse(author).map_err(|_| "Invalid listing author".to_string())?;
        Ok(PrivateSubscription {
            scope: format!("private-contact-discovery-{}", author.to_hex()),
            filter: Filter::new()
                .kind(Kind::from(INVITE_EVENT_KIND as u16))
                .author(author)
                .custom_tag(SingleLetterTag::lowercase(Alphabet::L), INVITE_LIST_LABEL)
                .limit(16),
        })
    }

    pub fn accept_public_contact_event(
        &mut self,
        event: &Event,
        expected_author: &str,
    ) -> MessagingResult<String> {
        if event.as_json().len() > 64 * 1024 {
            return Err("Contact invitation is too large".into());
        }
        let expected =
            PublicKey::parse(expected_author).map_err(|_| "Invalid listing author".to_string())?;
        event
            .verify()
            .map_err(|_| "Contact invitation signature is invalid".to_string())?;
        if event.kind.as_u16() as u32 != INVITE_EVENT_KIND {
            return Err("Contact invitation does not belong to this listing's author".into());
        }
        let mut invite = parse_invite_event(event).map_err(protocol_error)?;
        let claimed = invite.owner_public_key.is_some() || invite.inviter_owner_pubkey.is_some();
        if invite.inviter_device_pubkey.to_bytes() != event.pubkey.to_bytes()
            || (claimed && invite_owner(&invite)? != expected)
        {
            return Err("Contact invitation identity could not be verified".into());
        }
        if !event.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.len() == 2 && values[0] == "d" && values[1].starts_with(INVITE_PREFIX)
        }) {
            return Err("This is not an Iris Chat contact invitation".into());
        }
        // Public JS device invites deliberately omit an owner tag. The listing
        // identifies the expected owner; the engine must verify its signed roster.
        invite.owner_public_key = Some(expected);
        invite.inviter_owner_pubkey = Some(nostr_double_ratchet::OwnerPubkey::from_bytes(
            expected.to_bytes(),
        ));
        self.accept_invite(
            &invite_url(&invite, "https://market.iris.to/invite").map_err(protocol_error)?,
        )
    }

    pub fn accept_invite(&mut self, input: &str) -> MessagingResult<String> {
        self.accept_invite_inner(input, false).map(|(peer, _)| peer)
    }

    /// Explicit user invitation acceptance is durable before any discovery.
    /// Missing signed owner evidence queues the capability encrypted at rest;
    /// the normal isolated roster subscription wakes verified acceptance.
    pub fn accept_invite_locally(&mut self, input: &str) -> MessagingResult<bool> {
        self.accept_invite_inner(input, true)
            .map(|(_, accepted)| accepted)
    }

    fn accept_invite_inner(
        &mut self,
        input: &str,
        queue_missing: bool,
    ) -> MessagingResult<(String, bool)> {
        self.require_authorization()?;
        if input.len() > 64 * 1024 {
            return Err("Invitation is too large".into());
        }
        let invite = parse_invite_url(input.trim())
            .map_err(|_| "This invitation is not valid".to_string())?;
        let peer = invite_owner(&invite)?;
        if invite.inviter_device_pubkey.to_bytes() == self.keys.public_key().to_bytes() {
            return Err("This is this device’s own invitation".into());
        }
        self.transaction(move |this| this.accept_parsed_invite(&invite, peer, queue_missing))
    }

    fn accept_parsed_invite(
        &mut self,
        invite: &Invite,
        peer: PublicKey,
        queue_missing: bool,
    ) -> MessagingResult<(String, bool)> {
        let outcome = self
            .engine
            .accept_invite(invite, Some(peer))
            .map_err(protocol_error)?;
        match outcome {
            ProtocolAcceptInviteOutcome::Accepted(result) => {
                let id = result.owner_pubkey.to_hex();
                if result.owner_pubkey != self.owner {
                    self.ensure_conversation(&id)?;
                }
                self.queue_effects(result.effects)?;
                self.state.pending_invites.remove(&id);
                Ok((id, true))
            }
            ProtocolAcceptInviteOutcome::Blocked(
                iris_chat_protocol::ProtocolAcceptInviteBlock::MissingOwnerRoster { .. },
            ) => {
                if !queue_missing {
                    return Err(
                        "Load this person's signed device authorization before connecting".into(),
                    );
                }
                let id = peer.to_hex();
                if self.state.pending_invites.len() >= 32
                    && !self.state.pending_invites.contains_key(&id)
                {
                    return Err("Too many invitations are waiting for device approval".into());
                }
                if peer != self.owner {
                    self.ensure_conversation(&id)?;
                }
                self.state
                    .pending_invites
                    .insert(id.clone(), invite.clone());
                Ok((id, false))
            }
            ProtocolAcceptInviteOutcome::Blocked(
                iris_chat_protocol::ProtocolAcceptInviteBlock::UnauthorizedDevice { .. },
            ) => Err("This device is no longer authorized by its account".into()),
        }
    }

    fn retry_invitations(&mut self) -> MessagingResult<()> {
        if !self.can_send() {
            return Ok(());
        }
        for (id, invite) in self.state.pending_invites.clone() {
            let peer = PublicKey::from_hex(&id).map_err(protocol_error)?;
            let outcome = self
                .engine
                .accept_invite(&invite, Some(peer))
                .map_err(protocol_error)?;
            if let ProtocolAcceptInviteOutcome::Accepted(result) = outcome {
                self.queue_effects(result.effects)?;
                self.state.pending_invites.remove(&id);
            }
            // Missing, conflicting and revoked owner evidence never authorizes
            // a connection. Keep the encrypted intent for a later valid roster.
        }
        Ok(())
    }

    /// Public authorization is accepted only as exact signed evidence. The
    /// shared engine owns timestamp conflicts, revocations and persisted proofs.
    pub fn ingest_authorization(&mut self, event: &Event) -> MessagingResult<()> {
        if !app_keys_event_is_acceptable_for_owner(event.pubkey, event, now()) {
            return Err("Invalid signed device authorization".into());
        }
        self.transaction(|this| {
            let heads = this
                .state
                .authorization_heads
                .entry(event.pubkey.to_hex())
                .or_default();
            let newest = heads.first().map(|head| head.created_at);
            if newest.is_none_or(|time| event.created_at > time) {
                *heads = vec![event.clone()];
            } else if newest == Some(event.created_at)
                && !heads.iter().any(|head| head.id == event.id)
                && heads.len() < 2
            {
                // Two differing latest heads suffice to retain a conflict. Never
                // discard one in favor of arrival order or a cached roster.
                heads.push(event.clone());
            }
            let before = this
                .engine
                .known_device_identity_pubkeys_for_owner(event.pubkey);
            let batch = this
                .engine
                .ingest_app_keys_event(event)
                .map_err(protocol_error)?;
            let after = this
                .engine
                .known_device_identity_pubkeys_for_owner(event.pubkey);
            if before.iter().any(|device| !after.contains(device)) {
                // Already sealed envelopes cannot be retargeted. Preserve their
                // visible messages, but never retry a removed device's copies.
                let peer = event.pubkey.to_hex();
                this.state.outbox.retain(|_, queued| queued.peer_id != peer);
                this.state
                    .pending_contact_messages
                    .retain(|_, queued| queued.peer_id != peer);
                if let Some(thread) = this.state.conversations.get_mut(&peer) {
                    for message in &mut thread.messages {
                        if message.mine && message.delivery == "pending" {
                            message.delivery = "failed".into();
                        }
                    }
                }
            }
            this.apply_batch(batch)
        })
    }

    pub fn authorization_filter(owner: PublicKey) -> Filter {
        Filter::new()
            .kind(Kind::from(APP_KEYS_EVENT_KIND as u16))
            .author(owner)
            .limit(16)
    }

    pub fn invitation_owner(input: &str) -> MessagingResult<PublicKey> {
        if input.len() > 64 * 1024 {
            return Err("Invitation is too large".into());
        }
        invite_owner(&parse_invite_url(input.trim()).map_err(protocol_error)?)
    }

    /// An explicit contact action saves only local intent. The protocol engine
    /// still requires device approval and verified peer evidence before delivery.
    pub fn open_contact(&mut self, author: &str) -> MessagingResult<()> {
        let peer = PublicKey::parse(author).map_err(|_| "Invalid contact".to_string())?;
        if peer == self.owner || peer == self.keys.public_key() {
            return Err("Choose another person to contact".into());
        }
        self.transaction(|this| this.ensure_conversation(&peer.to_hex()))
    }

    fn next_message_millis(&mut self) -> u64 {
        let clock = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let next = clock.max(self.state.last_message_ms.saturating_add(1));
        self.state.last_message_ms = next;
        next
    }

    pub fn send(&mut self, peer_id: &str, text: &str) -> MessagingResult<()> {
        self.send_with_context(peer_id, text, None)
    }

    pub fn send_with_context(
        &mut self,
        peer_id: &str,
        text: &str,
        context: Option<crate::conversation_context::MessageContext>,
    ) -> MessagingResult<()> {
        self.require_authorization()?;
        if let Some(value) = &context {
            value.validate().map_err(str::to_string)?;
        }

        let peer = PublicKey::parse(peer_id).map_err(|_| "Invalid conversation".to_string())?;
        let id = peer.to_hex();
        if let Some(order_id) = context.as_ref().and_then(|c| c.order_id.as_ref())
            && !self
                .state
                .orders
                .context_participant(order_id, &self.owner.to_hex(), &id)
        {
            return Err("This order is not shared with this person".into());
        }
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("Write a message first".into());
        }
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("Message is too long".into());
        }
        if !self.state.conversations.contains_key(&id) {
            return Err("Accept a private invitation first".into());
        }
        self.transaction(move |this| {
            if this.state.outbox.len() + this.state.pending_contact_messages.len() >= MAX_OUTBOX {
                return Err("Connect to send queued messages before sending more".into());
            }
            let millis = this.next_message_millis();
            let now = millis / 1000;
            let mut rumor = UnsignedEvent::from_json(serde_json::json!({"pubkey":this.keys.public_key(),"kind":14,"created_at":now,"content":text,"tags":[["p",id],["ms",millis.to_string()]]}).to_string()).map_err(protocol_error)?;
            if let Some(value) = &context { rumor.tags.push(value.tag()?); }
            rumor.ensure_id();
            if !this.contact_recipient_ready(peer) {
                let message_id = rumor.id.as_ref().ok_or("Private message identity is unavailable")?.to_hex();
                this.state.pending_contact_messages.insert(message_id.clone(), PendingContactMessage { peer_id: id.clone(), rumor });
                return this.append(&id, Message { id:message_id, order_id:context.as_ref().and_then(|value|value.order_id.clone()), context, text, mine:true, created_at:now, created_at_ms:millis, delivery:"pending".into(), cashu:None, reactions:Vec::new() });
            }
            let result = this.engine.send_direct_unsigned_event(peer, &id, rumor, UnixSeconds(now)).map_err(protocol_error)?;
            this.queue_effects(result.effects)?;
            this.append(
                &id,
                Message {
                    id: result.message_id,
                    order_id: context.as_ref().and_then(|c| c.order_id.clone()),
                    context,
                    text,
                    mine: true,
                    created_at: now,
                    created_at_ms: millis,
                    delivery: "pending".into(),
                    cashu: None,
                reactions: Vec::new(),
                },
            )?;
            Ok(())
        })
    }

    pub fn receive(&mut self, event: &Event) -> MessagingResult<()> {
        if event.as_json().len() > 128 * 1024 {
            return Err("Private event is too large".into());
        }
        event
            .verify()
            .map_err(|_| "Private event signature is invalid".to_string())?;
        if event.kind.as_u16() as u32 == APP_KEYS_EVENT_KIND {
            if event.pubkey != self.owner
                && !self
                    .state
                    .conversations
                    .contains_key(&event.pubkey.to_hex())
            {
                return Err("Unrequested device authorization".into());
            }
            return self.ingest_authorization(event);
        }
        if event.kind.as_u16() as u32 == INVITE_EVENT_KIND {
            let invite = parse_invite_event(event).map_err(protocol_error)?;
            let owner =
                if invite.owner_public_key.is_some() || invite.inviter_owner_pubkey.is_some() {
                    invite_owner(&invite)?
                } else if self
                    .state
                    .conversations
                    .contains_key(&event.pubkey.to_hex())
                {
                    // A locally requested legacy owner may sign its own public
                    // invitation without a separate device-roster announcement.
                    event.pubkey
                } else {
                    let owners = self
                        .engine
                        .known_verified_peer_owner_pubkeys()
                        .into_iter()
                        .filter(|owner| {
                            self.engine
                                .owner_device_binding_is_verified(*owner, event.pubkey)
                        })
                        .collect::<Vec<_>>();
                    if owners.len() != 1 {
                        return Err("Device invitation has no unique verified account".into());
                    }
                    owners[0]
                };
            if let Some(heads) = self.state.authorization_heads.get(&owner.to_hex()) {
                let mut verified = VerifiedAppKeysIndex::default();
                if heads.len() != 1
                    || verified.ingest(heads[0].clone(), now()).is_err()
                    || verified.membership(owner, event.pubkey) != DeviceMembership::Authorized
                {
                    return Err("Device invitation is not authorized by its owner".into());
                }
            }
            if owner != self.owner
                && event.pubkey == owner
                && self.state.conversations.contains_key(&owner.to_hex())
                && !self.state.authorization_heads.contains_key(&owner.to_hex())
                && !self.contact_recipient_ready(owner)
            {
                // Reuse signature, invitation ownership, roster/revocation and
                // local authorization checks; never treat discovery as approval.
                return self
                    .accept_public_contact_event(event, &owner.to_hex())
                    .map(|_| ());
            }
            if (owner != self.owner && !self.state.conversations.contains_key(&owner.to_hex()))
                || !self
                    .engine
                    .owner_device_binding_is_verified(owner, event.pubkey)
            {
                return Err("Unrequested device invitation".into());
            }
            return self.transaction(|this| {
                let batch = this
                    .engine
                    .observe_invite_event(event)
                    .map_err(protocol_error)?;
                this.apply_batch(batch)
            });
        }
        if !matches!(
            event.kind.as_u16() as u32,
            INVITE_RESPONSE_KIND | MESSAGE_EVENT_KIND
        ) {
            return Err("Unsupported private event".into());
        }
        let id = event.id.to_hex();
        if self.state.seen.contains(&id) {
            return Ok(());
        }
        self.transaction(|this| {
            if event.kind.as_u16() as u32 == INVITE_RESPONSE_KIND {
                let envelope = parse_invite_response_event(event).map_err(protocol_error)?;
                let is_public_contact = this.state.public_invite.as_ref().is_some_and(|invite| {
                    invite.inviter_ephemeral_public_key == envelope.recipient
                });
                if is_public_contact {
                    this.receive_public_contact_response(event)?;
                } else {
                    let batch = this
                        .engine
                        .observe_invite_response_event(event)
                        .map_err(protocol_error)?;
                    this.apply_batch(batch)?;
                }
            } else if let Some(message) = this
                .engine
                .process_direct_message_event(event)
                .map_err(protocol_error)?
            {
                this.apply_delivery(message)?;
            }
            let batch = this
                .engine
                .retry_pending_protocol(iris_chat_protocol::NdrUnixSeconds(now()))
                .map_err(protocol_error)?;
            this.apply_batch(batch)?;
            this.engine
                .ack_pending_decrypted_deliveries()
                .map_err(protocol_error)?;
            this.state.seen.push(id);
            if this.state.seen.len() > MAX_SEEN {
                this.state.seen.drain(..this.state.seen.len() - MAX_SEEN);
            }
            Ok(())
        })
    }

    /// Call on reconnect or a paced retry tick; it never performs network I/O.
    pub fn retry(&mut self) -> MessagingResult<()> {
        if !self
            .engine
            .has_due_pending_retry_work(iris_chat_protocol::NdrUnixSeconds(now()))
            && !self.state.orders.jobs.iter().any(|job| !job.handed)
            && self.state.pending_invites.is_empty()
            && !self.has_control_work()
            && !self.state.pending_contact_messages.values().any(|queued| {
                PublicKey::from_hex(&queued.peer_id)
                    .is_ok_and(|peer| self.contact_recipient_ready(peer))
            })
        {
            return Ok(());
        }
        self.transaction(|this| {
            this.send_control_jobs()?;
            this.retry_invitations()?;
            this.send_pending_contacts()?;
            this.prepare_order_threads()?;
            this.send_order_jobs()?;
            let batch = this
                .engine
                .retry_pending_protocol(iris_chat_protocol::NdrUnixSeconds(now()))
                .map_err(protocol_error)?;
            this.apply_batch(batch)?;
            this.engine
                .ack_pending_decrypted_deliveries()
                .map_err(protocol_error)
        })
    }

    fn contact_recipient_ready(&self, peer: PublicKey) -> bool {
        let snapshot = self.engine.session_manager_snapshot();
        let Some(user) = snapshot
            .users
            .iter()
            .find(|user| user.owner_pubkey.to_bytes() == peer.to_bytes())
        else {
            return false;
        };
        let Some(roster) = &user.roster else {
            return false;
        };
        let verified_devices = self.engine.known_device_identity_pubkeys_for_owner(peer);
        let mut signed = VerifiedAppKeysIndex::default();
        let has_signed_heads =
            if let Some(heads) = self.state.authorization_heads.get(&peer.to_hex()) {
                if heads.len() != 1 || signed.ingest(heads[0].clone(), now()).is_err() {
                    return false;
                }
                true
            } else {
                false
            };
        // Preserve prepared legacy private-invitation handshakes, even before
        // their roster appears in the engine's signed-device projection. A
        // locally opened unknown profile has neither this roster nor a target.
        user.devices.iter().any(|device| {
            let key = PublicKey::from_slice(&device.device_pubkey.to_bytes()).ok();
            device.authorized
                && !device.is_stale
                && roster
                    .devices()
                    .iter()
                    .any(|entry| entry.device_pubkey == device.device_pubkey)
                && key.is_some_and(|key| {
                    if has_signed_heads {
                        signed.membership(peer, key) == DeviceMembership::Authorized
                    } else {
                        key == peer || verified_devices.contains(&key)
                    }
                })
                && (device.public_invite.is_some()
                    || device.active_session.is_some()
                    || !device.inactive_sessions.is_empty())
        })
    }

    fn send_pending_contacts(&mut self) -> MessagingResult<()> {
        if !self.can_send() {
            return Ok(());
        }
        for (id, queued) in self.state.pending_contact_messages.clone() {
            if self.state.outbox.len() >= MAX_OUTBOX.saturating_sub(16) {
                break;
            }
            let peer = PublicKey::from_hex(&queued.peer_id).map_err(protocol_error)?;
            if !self.contact_recipient_ready(peer) {
                continue;
            }
            if let Some(context) = crate::conversation_context::from_rumor(&queued.rumor)
                && let Some(order) = context.order_id
                && !self.state.orders.context_participant(
                    &order,
                    &self.owner.to_hex(),
                    &queued.peer_id,
                )
            {
                continue;
            }
            let result = self
                .engine
                .send_direct_unsigned_event(peer, &queued.peer_id, queued.rumor, UnixSeconds(now()))
                .map_err(protocol_error)?;
            self.queue_effects(result.effects)?;
            self.state.pending_contact_messages.remove(&id);
        }
        Ok(())
    }

    pub fn conversations(&self) -> Vec<Conversation> {
        let mut items = self
            .state
            .conversations
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for conversation in &mut items {
            for message in &mut conversation.messages {
                message.reactions = self.reactions_for(&conversation.id, &message.id);
                let (text, payment) = cashu_content(&message.text);
                message.text = text;
                if message.cashu.is_none() {
                    message.cashu = payment;
                }
            }
        }
        items.sort_by(|a, b| {
            b.messages
                .last()
                .map(message_sort_millis)
                .cmp(&a.messages.last().map(message_sort_millis))
                .then(a.id.cmp(&b.id))
        });
        items
    }

    pub fn orders(&self) -> Vec<crate::orders::OrderView> {
        self.state.orders.views(&self.owner.to_hex(), now())
    }

    pub fn request_order(
        &mut self,
        listing: &crate::model::Listing,
        quantity: u16,
        note: &str,
    ) -> MessagingResult<String> {
        self.request_order_with_delivery(listing, quantity, note, None)
    }
    pub fn request_order_with_delivery(
        &mut self,
        listing: &crate::model::Listing,
        quantity: u16,
        note: &str,
        delivery: Option<crate::orders::DeliveryRequest>,
    ) -> MessagingResult<String> {
        self.transaction(|this| {
            let id = this.state.orders.request_with_delivery(
                listing,
                quantity,
                note,
                delivery,
                &this.owner.to_hex(),
                &this.keys.public_key().to_hex(),
                now(),
            )?;
            this.prepare_order_threads()?;
            Ok(id)
        })
    }
    pub fn request_delivery(
        &mut self,
        source_id: &str,
        listing: &crate::model::Listing,
        destination: crate::orders::DeliveryPlace,
    ) -> MessagingResult<String> {
        self.transaction(|this| {
            let id = this.state.orders.request_delivery(
                source_id,
                listing,
                destination,
                &this.owner.to_hex(),
                &this.keys.public_key().to_hex(),
                now(),
            )?;
            this.prepare_order_threads()?;
            Ok(id)
        })
    }
    /// Only explicit isolated Rust fixtures opt into a numeric loopback mint.
    pub fn set_developer_mint(&mut self, mint: Option<&str>) -> MessagingResult<()> {
        self.state.orders.set_developer_mint(mint)
    }

    /// Metadata validation is not redemption. Only a seller confirmation changes payment status.
    pub fn send_order_payment_token(&mut self, id: &str, encoded: &str) -> MessagingResult<()> {
        use std::str::FromStr;
        let order = self.state.orders.get(id).ok_or("Order not found")?;
        if order.buyer != self.owner.to_hex() {
            return Err("Only the buyer can send this order payment".into());
        }
        let token = encoded.trim();
        if token.is_empty() || token.len() > MAX_MESSAGE_BYTES {
            return Err("Invalid payment token size".into());
        }
        let seller = order.seller.clone();
        if self.state.conversations.get(&seller).is_some_and(|thread| {
            thread.messages.iter().any(|message| {
                message.mine
                    && message.delivery != "failed"
                    && message
                        .context
                        .as_ref()
                        .is_some_and(|context| context.order_id.as_deref() == Some(id))
                    && message.text == token
            })
        }) {
            return Ok(());
        }
        let (seller, request) = self
            .state
            .orders
            .buyer_payment_request(id, &self.owner.to_hex())?;
        let parsed = cashu::Token::from_str(token).map_err(|_| "Invalid payment token")?;
        if parsed.unit().unwrap_or_default() != cashu::CurrencyUnit::Sat {
            return Err("Payment token unit does not match the order".into());
        }
        let mint = url::Url::parse(
            &parsed
                .mint_url()
                .map_err(|_| "Invalid payment mint")?
                .to_string(),
        )
        .map_err(|_| "Invalid payment mint")?;
        let mint = mint.as_str().strip_suffix('/').unwrap_or(mint.as_str());
        if mint != request.mint
            || parsed
                .value()
                .map_err(|_| "Invalid payment amount")?
                .to_u64()
                .to_string()
                != request.amount
        {
            return Err(
                "Payment token mint and amount must match the current order request".into(),
            );
        }
        self.send_with_context(
            &seller,
            token,
            Some(crate::conversation_context::MessageContext::for_order(id)),
        )
    }

    pub fn update_order(&mut self, id: &str, patch: serde_json::Value) -> MessagingResult<()> {
        self.transaction(|this| {
            this.state.orders.update(
                id,
                patch,
                &this.owner.to_hex(),
                &this.keys.public_key().to_hex(),
                now(),
            )?;
            this.prepare_order_threads()
        })
    }

    pub fn archive_order(&mut self, id: &str, archived: bool) -> MessagingResult<()> {
        self.transaction(|this| this.state.orders.archive(id, archived))
    }

    fn prepare_order_threads(&mut self) -> MessagingResult<()> {
        self.state.orders.prune(now());
        let orders = &self.state.orders;
        self.engine
            .retire_pending_local_sibling_events(|_, event| {
                event
                    .id
                    .as_ref()
                    .is_some_and(|id| !orders.can_publish(&id.to_hex()))
            })
            .map_err(protocol_error)?;
        self.state.outbox.retain(|_, queued| {
            queued
                .inner_id
                .as_deref()
                .is_none_or(|id| orders.can_publish(id))
        });
        for job in self.state.orders.jobs.clone() {
            if job.handed {
                continue;
            }
            self.ensure_conversation(&job.recipient)?;
            if job.action != "location" {
                let created_at_ms = message_millis(&job.rumor);
                self.append(
                    &job.recipient,
                    Message {
                        id: job.id,
                        context: Some(crate::conversation_context::MessageContext::for_order(
                            &job.order_id,
                        )),
                        text: job.rumor.content,
                        mine: true,
                        created_at: job.rumor.created_at.as_secs(),
                        created_at_ms,
                        delivery: "pending".into(),
                        order_id: Some(job.order_id),
                        cashu: None,
                        reactions: Vec::new(),
                    },
                )?;
            }
        }
        Ok(())
    }

    fn send_order_jobs(&mut self) -> MessagingResult<()> {
        if !self.can_send() {
            return Ok(());
        }
        for job in self.state.orders.jobs.clone() {
            if job.handed || !self.state.orders.can_publish(&job.id) {
                continue;
            }
            if self.state.outbox.len() >= MAX_OUTBOX.saturating_sub(16) {
                break;
            }
            let peer = PublicKey::from_hex(&job.recipient).map_err(protocol_error)?;
            if job.action == "location" {
                // Never leave superseded coordinates in the engine's unsent remote plaintext queue.
                let snapshot = self.engine.session_manager_snapshot();
                let Some(user) = snapshot
                    .users
                    .iter()
                    .find(|user| user.owner_pubkey.to_bytes() == peer.to_bytes())
                else {
                    continue;
                };
                let Some(roster) = user.roster.as_ref() else {
                    continue;
                };
                let targets = roster.devices();
                if targets.is_empty()
                    || !targets.iter().all(|target| {
                        user.devices.iter().any(|device| {
                            device.device_pubkey == target.device_pubkey
                                && device.authorized
                                && !device.is_stale
                                && device.active_session.as_ref().is_some_and(|session| {
                                    session.their_current_nostr_public_key.is_some()
                                })
                        })
                    })
                {
                    continue;
                }
                let result = self
                    .engine
                    .send_direct_unsigned_event_to_peer_only(
                        peer,
                        &job.recipient,
                        job.rumor.clone(),
                        UnixSeconds(now()),
                    )
                    .map_err(protocol_error)?;
                if result.event_ids.len() != targets.len() {
                    return Err(
                        "Location sharing waits for every authorized recipient ratchet".into(),
                    );
                }
                self.queue_effects(result.effects)?;
                let siblings = self
                    .engine
                    .send_local_sibling_unsigned_event(
                        peer,
                        &job.recipient,
                        job.rumor,
                        UnixSeconds(now()),
                    )
                    .map_err(protocol_error)?;
                self.queue_effects(siblings.effects)?;
                let id = job.id.clone();
                self.engine
                    .retire_pending_local_sibling_events(|_, event| {
                        event
                            .id
                            .as_ref()
                            .is_some_and(|event_id| event_id.to_hex() == id)
                    })
                    .map_err(protocol_error)?;
            } else {
                let result = self
                    .engine
                    .send_direct_unsigned_event(peer, &job.recipient, job.rumor, UnixSeconds(now()))
                    .map_err(protocol_error)?;
                self.queue_effects(result.effects)?;
            }
            if let Some(pending) = self
                .state
                .orders
                .jobs
                .iter_mut()
                .find(|pending| pending.id == job.id)
            {
                pending.handed = true;
            }
        }
        Ok(())
    }

    pub fn subscriptions(&self) -> Vec<PrivateSubscription> {
        let mut result = Vec::new();
        if let Some(key) = self.engine.local_invite_response_pubkey() {
            result.push(PrivateSubscription {
                scope: "private-invitations".into(),
                filter: Filter::new()
                    .kind(Kind::from(INVITE_RESPONSE_KIND as u16))
                    .pubkey(key)
                    .limit(128),
            });
        }
        if let Some(invite) = &self.state.public_invite
            && let Ok(key) = PublicKey::from_slice(&invite.inviter_ephemeral_public_key.to_bytes())
        {
            result.push(PrivateSubscription {
                scope: "private-public-contact-responses".into(),
                filter: Filter::new()
                    .kind(Kind::from(INVITE_RESPONSE_KIND as u16))
                    .pubkey(key)
                    .limit(128),
            });
        }
        for owner in std::iter::once(self.owner).chain(
            self.state
                .conversations
                .keys()
                .filter_map(|id| PublicKey::from_hex(id).ok()),
        ) {
            result.push(PrivateSubscription {
                scope: format!("private-authorization-{}", owner.to_hex()),
                filter: Filter::new()
                    .kinds([Kind::from(APP_KEYS_EVENT_KIND as u16), Kind::Metadata])
                    .author(owner)
                    .limit(20),
            });
            let mut devices = self.engine.known_device_identity_pubkeys_for_owner(owner);
            if owner != self.owner && !devices.contains(&owner) {
                devices.push(owner);
            }
            for device in devices {
                result.push(PrivateSubscription {
                    scope: format!("private-device-invites-{}", device.to_hex()),
                    filter: Self::contact_discovery_filter(&device.to_hex())
                        .expect("valid device")
                        .filter,
                });
            }
        }
        let existing: std::collections::BTreeSet<_> = self
            .state
            .conversations
            .keys()
            .cloned()
            .chain(std::iter::once(self.owner.to_hex()))
            .collect();
        for id in self
            .state
            .orders
            .participants()
            .into_iter()
            .filter(|id| !existing.contains(id))
            .take(MAX_THREADS)
        {
            if let Ok(owner) = PublicKey::from_hex(&id) {
                result.push(PrivateSubscription {
                    scope: format!("private-order-profile-{id}"),
                    filter: Filter::new().kind(Kind::Metadata).author(owner).limit(1),
                });
            }
        }
        // Cold-delivery envelopes disclose only the recipient. The sender uses
        // unlinkable session keys. Keep this scope separate from session authors.
        result.push(PrivateSubscription {
            scope: "private-cold-inbox".into(),
            filter: Filter::new()
                .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
                .pubkey(self.keys.public_key())
                .limit(256),
        });
        for author in self.engine.known_message_author_pubkeys() {
            result.push(PrivateSubscription {
                scope: format!("private-session-{}", author.to_hex()),
                filter: Filter::new()
                    .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
                    .author(author)
                    .limit(256),
            });
        }
        result
    }

    pub fn pending_outbound(&self) -> Vec<Event> {
        if !self.can_send() {
            return Vec::new();
        }
        self.state
            .outbox
            .values()
            .filter(|queued| self.outbound_is_authorized(queued))
            .filter(|queued| {
                queued
                    .inner_id
                    .as_deref()
                    .is_none_or(|id| self.state.orders.can_publish(id))
            })
            .map(|queued| queued.event.clone())
            .collect()
    }

    fn outbound_is_authorized(&self, queued: &QueuedPublish) -> bool {
        let Ok(peer) = PublicKey::from_hex(&queued.peer_id) else {
            return false;
        };
        let recipient = if queued.event.kind.as_u16() as u32 == MESSAGE_EVENT_KIND {
            queued.event.tags.public_keys().next().copied()
        } else {
            None
        };
        let owner = queued.recipient_device_owner.unwrap_or(peer);
        if let Some(heads) = self.state.authorization_heads.get(&owner.to_hex()) {
            if heads.len() != 1 {
                return false;
            }
            if let Some(device) = recipient {
                let mut index = VerifiedAppKeysIndex::default();
                if index.ingest(heads[0].clone(), now()).is_err() {
                    return false;
                }
                return index.membership(owner, device) == DeviceMembership::Authorized;
            }
            // A hot session may have no destination tag, but an empty or
            // conflicting peer roster still cannot authorize a retransmission.
            return iris_chat_protocol::AppKeys::from_event(&heads[0])
                .is_ok_and(|keys| !keys.get_all_devices().is_empty());
        }
        true // Legacy checkpoints retain their original engine authorization.
    }

    /// Relay acknowledgement means stored by a relay, not read by the peer.
    pub fn acknowledge_published(&mut self, event_id: &str) -> MessagingResult<()> {
        let id = event_id.to_string();
        self.transaction(|this| {
            if let Some(queued) = this.state.outbox.remove(&id)
                && let Some(inner_id) = queued.inner_id
            {
                let delivered_to_peer = queued
                    .recipient_device_owner
                    .is_some_and(|owner| owner.to_hex() == queued.peer_id);
                if delivered_to_peer {
                    this.state.orders.sent(&inner_id, &queued.peer_id);
                }
                let remaining = this
                    .state
                    .outbox
                    .values()
                    .any(|other| other.inner_id.as_ref() == Some(&inner_id));
                if !remaining
                    && delivered_to_peer
                    && let Some(thread) = this.state.conversations.get_mut(&queued.peer_id)
                    && let Some(message) = thread
                        .messages
                        .iter_mut()
                        .find(|message| message.id == inner_id)
                {
                    controls::advance_delivery(message, "sent");
                }
            }
            Ok(())
        })
    }

    fn receive_public_contact_response(&mut self, event: &Event) -> MessagingResult<()> {
        let mut invite = self
            .state
            .public_invite
            .clone()
            .ok_or("Public contact invitation is unavailable")?;
        let envelope = parse_invite_response_event(event).map_err(protocol_error)?;
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(iris_chat_protocol::NdrUnixSeconds(now()), &mut rng);
        let response = invite
            .process_response(
                &mut context,
                &envelope,
                self.keys.secret_key().to_secret_bytes(),
            )
            .map_err(protocol_error)?;
        let device = PublicKey::from_slice(&response.invitee_device_pubkey.to_bytes())
            .map_err(protocol_error)?;
        let owner = response.resolved_owner_pubkey();
        let proof = self
            .engine
            .ingest_invite_response_owner_proof(&invite, event, owner, device)
            .map_err(protocol_error)?;
        self.apply_batch(proof)?;
        self.ensure_conversation(&owner.to_hex())?;
        let outcome = self
            .engine
            .import_private_invite_session_once(
                &event.id.to_hex(),
                owner,
                device,
                response.session.state,
                UnixSeconds(now()),
            )
            .map_err(protocol_error)?;
        match outcome {
            ProtocolInviteSessionImportOutcome::Imported(batch) => self.apply_batch(batch)?,
            ProtocolInviteSessionImportOutcome::AlreadyImported => {}
            ProtocolInviteSessionImportOutcome::Blocked(_) => {
                return Err("Contact identity could not be verified".into());
            }
        }
        self.state.public_invite = Some(invite);
        Ok(())
    }

    fn ensure_conversation(&mut self, id: &str) -> MessagingResult<()> {
        if !self.state.conversations.contains_key(id) {
            if self.state.conversations.len() >= MAX_THREADS {
                return Err("Conversation limit reached".into());
            }
            self.state.conversations.insert(
                id.into(),
                Conversation {
                    id: id.into(),
                    name: "Private conversation".into(),
                    messages: Vec::new(),
                },
            );
        }
        Ok(())
    }

    fn append(&mut self, peer: &str, message: Message) -> MessagingResult<()> {
        self.ensure_conversation(peer)?;
        let thread = self
            .state
            .conversations
            .get_mut(peer)
            .ok_or("Conversation is unavailable")?;
        if thread
            .messages
            .iter()
            .any(|existing| existing.id == message.id)
        {
            return Ok(());
        }
        if thread.messages.len() >= MAX_THREAD_MESSAGES {
            return Err(
                "Conversation storage limit reached; existing messages were preserved".into(),
            );
        }
        thread.messages.push(message.clone());
        thread.messages.sort_by_key(message_sort_millis);
        self.controls_after_append(peer, &message)?;
        Ok(())
    }

    fn queue_effects(&mut self, effects: Vec<ProtocolEffect>) -> MessagingResult<()> {
        for effect in effects {
            let ProtocolEffect::Publish(publish) = effect;
            let event = publish.event;
            event
                .verify()
                .map_err(|_| "Invalid outgoing private event".to_string())?;
            if event.pubkey == self.keys.public_key() || event.pubkey == self.owner {
                return Err("Refusing identity-signed private publication".into());
            }
            if !matches!(
                event.kind.as_u16() as u32,
                INVITE_RESPONSE_KIND | MESSAGE_EVENT_KIND
            ) {
                return Err("Refusing unsupported private publication".into());
            }
            let id = event.id.to_hex();
            if publish
                .inner_event_id
                .as_deref()
                .is_some_and(|id| !self.state.orders.can_publish(id))
            {
                continue;
            }
            if !self.state.outbox.contains_key(&id) && self.state.outbox.len() >= MAX_OUTBOX {
                return Err("Private message queue is full".into());
            }
            // Own-device copies have the conversation peer in chat_id. Retain
            // the actual destination owner before a later revocation removes
            // that device from the current roster.
            let recipient_device_owner = if event.kind.as_u16() as u32 == MESSAGE_EVENT_KIND {
                event.tags.public_keys().next().and_then(|device| {
                    if self
                        .engine
                        .known_device_identity_pubkeys_for_owner(self.owner)
                        .contains(device)
                    {
                        Some(self.owner)
                    } else {
                        PublicKey::from_hex(&publish.chat_id).ok()
                    }
                })
            } else {
                PublicKey::from_hex(&publish.chat_id).ok()
            };
            self.state.outbox.insert(
                id,
                QueuedPublish {
                    event,
                    inner_id: publish.inner_event_id,
                    peer_id: publish.chat_id,
                    recipient_device_owner,
                },
            );
        }
        Ok(())
    }

    fn apply_batch(&mut self, batch: ProtocolRetryBatch) -> MessagingResult<()> {
        self.queue_effects(batch.effects)?;
        self.queue_effects(batch.group_result.effects)?;
        for message in batch.direct_messages {
            self.apply_delivery(message)?;
        }
        Ok(())
    }

    fn apply_delivery(&mut self, message: ProtocolDecryptedMessage) -> MessagingResult<()> {
        let mut inner = UnsignedEvent::from_json(&message.content)
            .map_err(|_| "Invalid private message".to_string())?;
        inner.ensure_id();
        inner
            .verify_id()
            .map_err(|_| "Invalid private message identity".to_string())?;
        // Iris Chat JS writes the authenticated device key into kind-14 rumors.
        // The shared engine has already resolved that device to its signed owner.
        if inner.pubkey != message.sender && Some(inner.pubkey) != message.sender_device {
            return Err("Private message author does not match the authenticated sender".into());
        }
        if matches!(inner.kind.as_u16(), 7 | 15) {
            let device = message.sender_device.unwrap_or(message.sender);
            if device != message.sender
                && !self
                    .engine
                    .owner_device_binding_is_verified(message.sender, device)
            {
                return Err(
                    "Private control device is not bound to its authenticated owner".into(),
                );
            }
            if let Some(heads) = self.state.authorization_heads.get(&message.sender.to_hex()) {
                let mut signed = VerifiedAppKeysIndex::default();
                if heads.len() != 1
                    || signed.ingest(heads[0].clone(), now()).is_err()
                    || signed.membership(message.sender, device) != DeviceMembership::Authorized
                {
                    return Err("Private control device is not authorized".into());
                }
            }
            let peer = if message.sender == self.owner {
                message.conversation_owner.or_else(|| {
                    let targets = inner
                        .tags
                        .iter()
                        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                        .filter_map(|tag| tag.as_slice().get(1))
                        .collect::<Vec<_>>();
                    if targets.len() != 1 {
                        return None;
                    }
                    let peers = self
                        .state
                        .conversations
                        .values()
                        .filter(|thread| {
                            thread
                                .messages
                                .iter()
                                .any(|stored| stored.id == *targets[0])
                        })
                        .filter_map(|thread| PublicKey::from_hex(&thread.id).ok())
                        .collect::<Vec<_>>();
                    if peers.len() == 1 {
                        Some(peers[0])
                    } else {
                        None
                    }
                })
            } else {
                Some(message.sender)
            };
            if let Some(peer) = peer {
                return self.accept_control(&peer.to_hex(), &message.sender.to_hex(), &inner);
            }
            return Ok(());
        }
        if inner.kind != Kind::from(14) {
            return Ok(());
        }
        if inner.content.len() > MAX_MESSAGE_BYTES {
            return Err("Received message is too long".into());
        }
        let mine = message.sender == self.owner;
        let peer = if mine {
            message.conversation_owner.unwrap_or(message.sender)
        } else {
            message.sender
        };
        let id = inner.id.ok_or("Private message has no ID")?.to_hex();
        let mut context = crate::conversation_context::from_rumor(&inner);
        if context
            .as_ref()
            .and_then(|c| c.order_id.as_ref())
            .is_some_and(|id| {
                !self
                    .state
                    .orders
                    .context_participant(id, &self.owner.to_hex(), &peer.to_hex())
            })
        {
            context = None;
        }
        let order_id = if crate::orders::is_order_message(&inner) {
            let sender_device = message.sender_device.unwrap_or(message.sender);
            let Some((order_id, location)) = self.state.orders.receive(
                &inner,
                &message.sender.to_hex(),
                &sender_device.to_hex(),
                &self.owner.to_hex(),
                now(),
            ) else {
                return Ok(());
            };
            self.prepare_order_threads()?;
            if location {
                return Ok(());
            }
            context = Some(crate::conversation_context::MessageContext::for_order(
                &order_id,
            ));
            Some(order_id)
        } else {
            context.as_ref().and_then(|c| c.order_id.clone())
        };
        let created_at_ms = message_millis(&inner);
        let stored = Message {
            id,
            context,
            // Retain the exact received text encrypted, including additional
            // payment tokens. conversations() hides bearer text in the UI.
            text: inner.content,
            mine,
            created_at: inner.created_at.as_secs(),
            created_at_ms,
            delivery: if mine { "sent" } else { "received" }.into(),
            order_id,
            cashu: None,
            reactions: Vec::new(),
        };
        self.append(&peer.to_hex(), stored.clone())?;
        // Optional notification caching must never roll back a valid private message.
        let _ = self.cache_notification(message.event_id.as_deref(), &peer.to_hex(), &stored);
        Ok(())
    }

    fn transaction<T>(
        &mut self,
        mutate: impl FnOnce(&mut Self) -> MessagingResult<T>,
    ) -> MessagingResult<T> {
        self.store.sql("BEGIN IMMEDIATE")?;
        let result = mutate(self).and_then(|result| {
            let state = serde_json::to_string(&self.state)
                .map_err(|_| "Unable to save conversations".to_string())?;
            self.store.put(APP_STATE, state).map_err(storage_error)?;
            self.store.sql("COMMIT")?;
            Ok(result)
        });
        if result.is_err() {
            let _ = self.store.sql("ROLLBACK");
            // Protocol operations may have mutated memory before SQLite failed.
            // Reload the committed snapshot instead of continuing a divergent ratchet.
            self.state = read_state(&self.store)?;
            self.engine = make_engine(Arc::clone(&self.store), self.owner, &self.keys)?;
            if let Some(keys) = &self.owner_keys {
                self.engine
                    .authenticate_local_owner_for_sending(keys)
                    .map_err(protocol_error)?;
            }
        }
        result
    }
}

fn invite_owner(invite: &Invite) -> MessagingResult<PublicKey> {
    let device =
        PublicKey::from_slice(&invite.inviter_device_pubkey.to_bytes()).map_err(protocol_error)?;
    let tagged = invite
        .inviter_owner_pubkey
        .map(|owner| PublicKey::from_slice(&owner.to_bytes()))
        .transpose()
        .map_err(protocol_error)?;
    if let (Some(first), Some(second)) = (invite.owner_public_key, tagged)
        && first != second
    {
        return Err("Invitation owner claims do not match".into());
    }
    Ok(invite.owner_public_key.or(tagged).unwrap_or(device))
}

fn make_engine(
    store: Arc<EncryptedStore>,
    owner: PublicKey,
    keys: &Keys,
) -> MessagingResult<ProtocolEngine> {
    ProtocolEngine::load_or_create_for_local_device(store, owner, keys).map_err(protocol_error)
}
fn read_state(store: &EncryptedStore) -> MessagingResult<PrivateState> {
    match store.get(APP_STATE).map_err(storage_error)? {
        Some(json) => serde_json::from_str(&json).map_err(|_| {
            "Saved conversations could not be read; existing data was preserved".into()
        }),
        None => Ok(PrivateState::default()),
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn protocol_error(error: impl std::fmt::Display) -> String {
    format!("Private messaging: {error}")
}
fn storage_error(_: StorageError) -> String {
    "Private message storage is unavailable; existing data was preserved".into()
}

struct EncryptedStore {
    conn: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
    _lock: fs::File,
}
impl EncryptedStore {
    fn open(data_dir: &Path, keys: &Keys) -> MessagingResult<Self> {
        let directory = data_dir.join("private-messages");
        fs::create_dir_all(&directory).map_err(|_| "Unable to create private message storage")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Unable to protect private message storage")?;
        }
        let mut lock_options = fs::OpenOptions::new();
        lock_options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            lock_options.mode(0o600);
        }
        let lock = lock_options
            .open(directory.join(".writer-lock"))
            .map_err(|_| "Unable to open private message storage lock")?;
        lock.try_lock_exclusive()
            .map_err(|_| "This profile is already open in another process")?;
        let conn = Connection::open(directory.join("messages.sqlite3"))
            .map_err(|_| "Unable to open private message storage")?;
        conn.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|_| "Unable to configure private message storage")?;
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sealed_state (key TEXT PRIMARY KEY, value BLOB NOT NULL);").map_err(|_| "Unable to initialise private message storage")?;
        let hkdf = Hkdf::<Sha256>::new(
            Some(b"iris-market-private-store-v1"),
            &keys.secret_key().to_secret_bytes(),
        );
        let mut key = [0u8; 32];
        hkdf.expand(keys.public_key().as_bytes(), &mut key)
            .map_err(|_| "Unable to initialise private message encryption")?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.fill(0);
        Ok(Self {
            conn: Mutex::new(conn),
            cipher,
            _lock: lock,
        })
    }
    fn sql(&self, command: &str) -> MessagingResult<()> {
        self.conn
            .lock()
            .map_err(|_| "Private message storage is busy")?
            .execute_batch(command)
            .map_err(|_| "Private message storage could not be updated".into())
    }
    fn seal(&self, name: &str, value: &str) -> StorageResult<Vec<u8>> {
        if value.len() > MAX_STORED_VALUE {
            return Err(StorageError::new("Private state size limit reached"));
        }
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| StorageError::new("Private state encryption failed"))?;
        let mut sealed = vec![1];
        sealed.extend(nonce);
        sealed.extend(encrypted);
        Ok(sealed)
    }
    fn unseal(&self, name: &str, value: &[u8]) -> StorageResult<String> {
        if value.len() < 41 || value.len() > MAX_STORED_VALUE + 41 || value[0] != 1 {
            return Err(StorageError::new("Invalid private state"));
        }
        let plain = self
            .cipher
            .decrypt(
                XNonce::from_slice(&value[1..25]),
                Payload {
                    msg: &value[25..],
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| StorageError::new("Private state could not be unlocked"))?;
        String::from_utf8(plain).map_err(|_| StorageError::new("Invalid private state encoding"))
    }
}
impl StorageAdapter for EncryptedStore {
    fn get(&self, key: &str) -> StorageResult<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| StorageError::new("Storage lock failed"))?;
        let bytes: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM sealed_state WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StorageError::new("Storage read failed"))?;
        bytes.map(|value| self.unseal(key, &value)).transpose()
    }
    fn put(&self, key: &str, value: String) -> StorageResult<()> {
        let sealed = self.seal(key, &value)?;
        self.conn.lock().map_err(|_| StorageError::new("Storage lock failed"))?.execute("INSERT INTO sealed_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, sealed]).map_err(|_| StorageError::new("Storage write failed"))?;
        Ok(())
    }
    fn del(&self, key: &str) -> StorageResult<()> {
        self.conn
            .lock()
            .map_err(|_| StorageError::new("Storage lock failed"))?
            .execute("DELETE FROM sealed_state WHERE key=?1", [key])
            .map_err(|_| StorageError::new("Storage removal failed"))?;
        Ok(())
    }
    fn list(&self, prefix: &str) -> StorageResult<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| StorageError::new("Storage lock failed"))?;
        let mut statement = conn
            .prepare("SELECT key FROM sealed_state ORDER BY key")
            .map_err(|_| StorageError::new("Storage list failed"))?;
        let keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| StorageError::new("Storage list failed"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StorageError::new("Storage list failed"))?;
        Ok(keys
            .into_iter()
            .filter(|key| key.starts_with(prefix))
            .collect())
    }
}

fn message_sort_millis(message: &Message) -> u64 {
    if message.created_at_ms == 0 {
        message.created_at.saturating_mul(1000)
    } else {
        message.created_at_ms
    }
}
fn message_millis(rumor: &UnsignedEvent) -> u64 {
    let values = rumor
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "ms"))
        .collect::<Vec<_>>();
    if values.len() == 1
        && values[0].as_slice().len() == 2
        && let Ok(ms) = values[0].as_slice()[1].parse::<u64>()
    {
        // Preserve private subsecond precision; malformed/implausible tags fall back to the signed second.
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        if ms <= wall_ms.saturating_add(300_000)
            && ms.abs_diff(rumor.created_at.as_secs().saturating_mul(1000)) <= 300_000
        {
            return ms;
        }
    }
    rumor.created_at.as_secs().saturating_mul(1000)
}

#[cfg(test)]
mod chronology_tests {
    use super::*;
    fn fixture_message(id: &str, text: &str, seconds: u64) -> Message {
        Message {
            id: id.into(),
            context: None,
            text: text.into(),
            mine: false,
            created_at: seconds,
            created_at_ms: 0,
            delivery: "received".into(),
            order_id: None,
            cashu: None,
            reactions: Vec::new(),
        }
    }
    #[test]
    fn millisecond_rows_and_legacy_ties_survive_out_of_order_delivery_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let peer = Keys::generate();
        let p = peer.public_key().to_hex();
        let seconds = now();
        let mut chat = Messaging::open(dir.path(), owner.clone()).unwrap();
        for (offset, text) in [(800, "later"), (100, "earlier")] {
            let mut rumor=UnsignedEvent::from_json(serde_json::json!({"pubkey":peer.public_key(),"kind":14,"created_at":seconds,"content":text,"tags":[["ms",(seconds*1000+offset).to_string()]]}).to_string()).unwrap();
            rumor.ensure_id();
            chat.transaction(|chat| {
                chat.apply_delivery(ProtocolDecryptedMessage {
                    sender: peer.public_key(),
                    sender_device: None,
                    conversation_owner: None,
                    created_at_secs: seconds,
                    content: rumor.as_json(),
                    event_id: None,
                })
            })
            .unwrap();
        }
        let rows = &chat.conversations()[0].messages;
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            vec!["earlier", "later"]
        );
        assert_eq!(rows[0].created_at_ms, seconds * 1000 + 100);
        let legacy_peer = Keys::generate().public_key().to_hex();
        chat.transaction(|chat| {
            chat.append(
                &legacy_peer,
                fixture_message(&"ff".repeat(32), "legacy-first", seconds),
            )?;
            chat.append(
                &legacy_peer,
                fixture_message(&"00".repeat(32), "legacy-second", seconds),
            )
        })
        .unwrap();
        drop(chat);
        let chat = Messaging::open(dir.path(), owner).unwrap();
        let rows = chat
            .conversations()
            .into_iter()
            .find(|thread| thread.id == p)
            .unwrap()
            .messages;
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            vec!["earlier", "later"]
        );
        let rows = chat
            .conversations()
            .into_iter()
            .find(|thread| thread.id == legacy_peer)
            .unwrap()
            .messages;
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            vec!["legacy-first", "legacy-second"]
        );
    }
    #[test]
    fn rapid_identical_outgoing_messages_keep_unique_monotonic_ms_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let peer = Keys::generate().public_key().to_hex();
        let mut chat = Messaging::open(dir.path(), owner.clone()).unwrap();
        chat.open_contact(&peer).unwrap();
        // Keep every allocation in one synthetic second even if the wall clock ticks.
        chat.transaction(|chat| {
            chat.state.last_message_ms = (now() + 2) * 1000;
            Ok(())
        })
        .unwrap();
        for _ in 0..20 {
            chat.send(&peer, "identical fast message").unwrap();
        }
        let rows = chat.conversations()[0].messages.clone();
        assert_eq!(rows.len(), 20);
        assert!(
            rows.windows(2)
                .all(|pair| pair[0].created_at_ms < pair[1].created_at_ms
                    && pair[0].id != pair[1].id)
        );
        let last = rows.last().unwrap().created_at_ms;
        drop(chat);
        let mut chat = Messaging::open(dir.path(), owner).unwrap();
        chat.send(&peer, "identical fast message").unwrap();
        let rows = chat.conversations()[0].messages.clone();
        assert_eq!(rows.len(), 21);
        assert!(rows.last().unwrap().created_at_ms > last);
        for message in rows {
            let queued = &chat.state.pending_contact_messages[&message.id];
            assert_eq!(message_millis(&queued.rumor), message.created_at_ms);
        }
    }
}
