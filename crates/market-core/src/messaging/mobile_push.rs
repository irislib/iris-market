//! Read-only notification preview: protocol writes are confined to an overlay.
//! The main app remains the sole writer of encrypted message/ratchet state.
use super::*;
use crate::mobile_push::{PushSnapshot, Resolution};
use std::collections::BTreeSet;
const POLICY_KEY: &str = "market/notifications/policy-v1";
const CACHE_KEY: &str = "market/notifications/previews-v1";
const MAX_READ: usize = 8192;
const MAX_PRESENTED: usize = 2048;
#[derive(Default, Serialize, Deserialize)]
struct Policy {
    enabled: bool,
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    presented: Vec<String>,
    #[serde(default)]
    muted: Vec<String>,
}
impl Messaging {
    /// Retain authenticated local routing when the relay wins the race with APNs/FCM.
    /// Called inside the existing receive transaction; no second ratchet or writer.
    pub(super) fn cache_notification(
        &self,
        outer_id: Option<&str>,
        peer: &str,
        message: &Message,
    ) -> MessagingResult<()> {
        if message.mine || !self.notification_policy()?.enabled {
            return Ok(());
        }
        let Some(id) = outer_id.filter(|id| nostr::EventId::from_hex(id).is_ok()) else {
            return Ok(());
        };
        let mut cached: Vec<Resolution> = self
            .store
            .get(CACHE_KEY)
            .map_err(storage_error)?
            .map(|v| serde_json::from_str(&v))
            .transpose()
            .map_err(protocol_error)?
            .unwrap_or_default();
        cached.retain(|r| r.notification_id != id);
        cached.push(Resolution {
            show: true,
            notification_id: id.into(),
            message_id: Some(message.id.clone()),
            peer_id: Some(peer.into()),
            thread_id: message.context.as_ref().map(|c| c.thread_id.clone()),
            order_id: message.order_id.clone(),
            title: "Iris Market".into(),
            body: "New private activity".into(),
        });
        if cached.len() > MAX_PRESENTED {
            cached.drain(..cached.len() - MAX_PRESENTED);
        }
        self.store
            .put(
                CACHE_KEY,
                serde_json::to_string(&cached).map_err(protocol_error)?,
            )
            .map_err(storage_error)
    }
    pub fn push_snapshot(&self) -> MessagingResult<PushSnapshot> {
        let policy = self.notification_policy()?;
        if !policy.enabled || !self.can_send() {
            return Ok(PushSnapshot::default());
        }
        // Do not reuse subscriptions(): it also contains public account discovery.
        let mut filters = Vec::new();
        let authors: Vec<_> = self
            .engine
            .known_message_author_pubkeys()
            .into_iter()
            .filter(|key| {
                *key != self.owner && !self.state.conversations.contains_key(&key.to_hex())
            })
            .map(|key| key.to_hex())
            .collect();
        for authors in authors.chunks(512) {
            filters.push(serde_json::json!({"kinds":[MESSAGE_EVENT_KIND],"authors":authors}));
        }
        // Legacy owner=device profiles must not register their public account as an inbox tag.
        if self.keys.public_key() != self.owner {
            filters.push(serde_json::json!({"kinds":[MESSAGE_EVENT_KIND],"#p":[self.keys.public_key().to_hex()]}));
        }
        let mut invite_keys = BTreeSet::new();
        if let Some(key) = self.engine.local_invite_response_pubkey() {
            invite_keys.insert(key.to_hex());
        }
        if let Some(invite) = &self.state.public_invite
            && let Ok(key) = PublicKey::from_slice(&invite.inviter_ephemeral_public_key.to_bytes())
        {
            invite_keys.insert(key.to_hex());
        }
        if !invite_keys.is_empty() {
            filters.push(serde_json::json!({"kinds":[INVITE_RESPONSE_KIND],"#p":invite_keys}));
        }
        Ok(PushSnapshot { filters })
    }
    fn notification_policy(&self) -> MessagingResult<Policy> {
        self.store
            .get(POLICY_KEY)
            .map_err(storage_error)?
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|_| "Notification preferences could not be read".into())
            })
            .transpose()
            .map(Option::unwrap_or_default)
    }
    pub fn set_push_enabled(&mut self, enabled: bool) -> MessagingResult<()> {
        let mut policy = self.notification_policy()?;
        policy.enabled = enabled;
        self.store
            .put(
                POLICY_KEY,
                serde_json::to_string(&policy).map_err(protocol_error)?,
            )
            .map_err(storage_error)
    }
    pub(super) fn mark_notification_messages_read(
        &mut self,
        ids: &[String],
    ) -> MessagingResult<()> {
        if ids.len() > 256 {
            return Err("Choose up to 256 messages".into());
        }
        let known: BTreeSet<_> = self
            .state
            .conversations
            .values()
            .flat_map(|thread| thread.messages.iter())
            .filter(|m| !m.mine)
            .map(|m| m.id.as_str())
            .collect();
        let mut policy = self.notification_policy()?;
        for id in ids.iter().filter(|id| known.contains(id.as_str())) {
            if !policy.read.contains(id) {
                policy.read.push(id.clone());
            }
        }
        if policy.read.len() > MAX_READ {
            policy.read.drain(..policy.read.len() - MAX_READ);
        }
        self.store
            .put(
                POLICY_KEY,
                serde_json::to_string(&policy).map_err(protocol_error)?,
            )
            .map_err(storage_error)
    }
    pub fn mark_notifications_presented(&mut self, ids: &[String]) -> MessagingResult<()> {
        if ids.len() > 256 || ids.iter().any(|id| nostr::EventId::from_hex(id).is_err()) {
            return Err("Invalid notification receipts".into());
        }
        let mut policy = self.notification_policy()?;
        for id in ids {
            if !policy.presented.contains(id) {
                policy.presented.push(id.clone());
            }
        }
        if policy.presented.len() > MAX_PRESENTED {
            policy
                .presented
                .drain(..policy.presented.len() - MAX_PRESENTED);
        }
        self.store
            .put(
                POLICY_KEY,
                serde_json::to_string(&policy).map_err(protocol_error)?,
            )
            .map_err(storage_error)
    }
}
struct PreviewStore {
    conn: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
    writes: Mutex<BTreeMap<String, Option<String>>>,
}
impl PreviewStore {
    fn open(data_dir: &Path, keys: &Keys) -> Option<Self> {
        let conn = Connection::open_with_flags(
            data_dir.join("private-messages/messages.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        conn.busy_timeout(std::time::Duration::from_millis(200))
            .ok()?;
        conn.execute_batch("BEGIN DEFERRED").ok()?;
        let hkdf = Hkdf::<Sha256>::new(
            Some(b"iris-market-private-store-v1"),
            &keys.secret_key().to_secret_bytes(),
        );
        let mut key = [0; 32];
        hkdf.expand(keys.public_key().as_bytes(), &mut key).ok()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.fill(0);
        Some(Self {
            conn: Mutex::new(conn),
            cipher,
            writes: Mutex::new(BTreeMap::new()),
        })
    }
}
impl StorageAdapter for PreviewStore {
    fn get(&self, key: &str) -> StorageResult<Option<String>> {
        if let Some(value) = self
            .writes
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?
            .get(key)
        {
            return Ok(value.clone());
        }
        let bytes: Option<Vec<u8>> = self
            .conn
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?
            .query_row("SELECT value FROM sealed_state WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| StorageError::new("Preview unavailable"))?;
        bytes
            .map(|value| {
                if value.len() < 41 || value.len() > MAX_STORED_VALUE + 41 || value[0] != 1 {
                    return Err(StorageError::new("Invalid private state"));
                }
                let plain = self
                    .cipher
                    .decrypt(
                        XNonce::from_slice(&value[1..25]),
                        Payload {
                            msg: &value[25..],
                            aad: key.as_bytes(),
                        },
                    )
                    .map_err(|_| StorageError::new("Preview unavailable"))?;
                String::from_utf8(plain).map_err(|_| StorageError::new("Invalid private state"))
            })
            .transpose()
    }
    fn put(&self, key: &str, value: String) -> StorageResult<()> {
        let mut writes = self
            .writes
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?;
        if writes.len() >= 4096
            || value.len() > MAX_STORED_VALUE
            || writes
                .values()
                .filter_map(Option::as_ref)
                .map(String::len)
                .sum::<usize>()
                .saturating_add(value.len())
                > 32 * 1024 * 1024
        {
            return Err(StorageError::new("Preview limit reached"));
        }
        writes.insert(key.to_owned(), Some(value));
        Ok(())
    }
    fn del(&self, key: &str) -> StorageResult<()> {
        self.writes
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?
            .insert(key.to_owned(), None);
        Ok(())
    }
    fn list(&self, prefix: &str) -> StorageResult<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?;
        let mut stmt = conn
            .prepare(
                "SELECT key FROM sealed_state WHERE substr(key,1,?1)=?2 ORDER BY key LIMIT 16385",
            )
            .map_err(|_| StorageError::new("Preview unavailable"))?;
        let values = stmt
            .query_map(params![prefix.len(), prefix], |r| r.get::<_, String>(0))
            .map_err(|_| StorageError::new("Preview unavailable"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StorageError::new("Preview unavailable"))?;
        if values.len() > 16384 {
            return Err(StorageError::new("Preview limit reached"));
        }
        let mut values: BTreeSet<_> = values.into_iter().collect();
        for (key, value) in self
            .writes
            .lock()
            .map_err(|_| StorageError::new("Preview unavailable"))?
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
        {
            if value.is_some() {
                values.insert(key.clone());
            } else {
                values.remove(key);
            }
        }
        Ok(values.into_iter().collect())
    }
}
/// Failure, locked storage and unresolved/control envelopes suppress alerts.
/// No plaintext from the notification service is trusted or displayed.
pub fn resolve(data_dir: &Path, owner: PublicKey, keys: &Keys, payload: &str) -> Resolution {
    resolve_inner(data_dir, owner, keys, payload).unwrap_or_default()
}
fn resolve_inner(
    data_dir: &Path,
    owner: PublicKey,
    keys: &Keys,
    payload: &str,
) -> Option<Resolution> {
    let current = crate::mobile_push::payload_event(payload)?;
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let mut events = Vec::new();
    if let Some(pending) = value.get("pending_events").and_then(|v| v.as_array()) {
        if pending.len() > 16 {
            return None;
        }
        for event in pending {
            if let Some(event) =
                crate::mobile_push::payload_event(&serde_json::json!({"event":event}).to_string())
                && event.id != current.id
                && !events.iter().any(|e: &Event| e.id == event.id)
            {
                events.push(event);
            }
        }
    }
    if events.len() >= 16 {
        return None;
    }
    events.push(current.clone());
    events.retain(|e| e.created_at.as_secs().saturating_add(7 * 86400) >= now());
    // Handshake controls arrive on independent carrier deliveries. Reconstruct
    // those capabilities before trying encrypted messages, including reordering.
    events.sort_by_key(|e| {
        (
            e.kind.as_u16() as u32 != INVITE_RESPONSE_KIND,
            e.created_at,
            e.id,
        )
    });
    let store = Arc::new(PreviewStore::open(data_dir, keys)?);
    if store.get("market/account-owner-v1").ok()?? != owner.to_hex() {
        return None;
    }
    let policy: Policy = serde_json::from_str(&store.get(POLICY_KEY).ok()??).ok()?;
    if !policy.enabled {
        return None;
    }
    // A newly enabled inbox may have protocol keys but no conversation state yet.
    let mut state: PrivateState = store
        .get(APP_STATE)
        .ok()?
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .ok()?
        .unwrap_or_default();
    let cached: Vec<Resolution> = store
        .get(CACHE_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let engine_store: Arc<dyn StorageAdapter> = store;
    let mut engine =
        ProtocolEngine::load_or_create_for_local_device(engine_store, owner, keys).ok()?;
    engine.enter_batch();
    // Legacy owner=device accounts possess their own signing key. Linked devices
    // must continue to rely on the persisted signed roster, exactly as the main writer.
    if keys.public_key() == owner {
        engine.authenticate_local_owner_for_sending(keys).ok()?;
    }
    if let Some(heads) = state.authorization_heads.get(&owner.to_hex()) {
        if heads.len() != 1 {
            return None;
        }
        let mut verified = VerifiedAppKeysIndex::default();
        if verified.ingest(heads[0].clone(), now()).is_err()
            || verified.membership(owner, keys.public_key()) != DeviceMembership::Authorized
        {
            return None;
        }
    } else if keys.public_key() != owner && engine.signed_local_device_authorization() != Some(true)
    {
        return None;
    }
    let mut resolutions = Vec::new();
    for event in events {
        if let Some(resolution) = cached
            .iter()
            .find(|r| r.notification_id == event.id.to_hex())
            && permitted(resolution, &policy)
        {
            resolutions.push((
                event.id == current.id,
                event.created_at.as_secs(),
                resolution.clone(),
            ));
        }
        for message in preview_event(&mut engine, &mut state.public_invite, keys, &event) {
            let event_id = message
                .event_id
                .clone()
                .unwrap_or_else(|| event.id.to_hex());
            if let Some(resolution) =
                message_resolution(&mut state, owner, message, &event_id, &policy)
            {
                resolutions.push((
                    event_id == current.id.to_hex(),
                    event.created_at.as_secs(),
                    resolution,
                ));
            }
        }
    }
    resolutions
        .into_iter()
        .max_by_key(|(current, at, r)| (*current, *at, r.notification_id.clone()))
        .map(|(_, _, r)| r)
}
fn permitted(resolution: &Resolution, policy: &Policy) -> bool {
    !policy.presented.contains(&resolution.notification_id)
        && !resolution
            .message_id
            .as_ref()
            .is_some_and(|id| policy.read.contains(id))
        && !resolution
            .peer_id
            .as_ref()
            .is_some_and(|peer| policy.muted.contains(peer))
}
fn preview_event(
    engine: &mut ProtocolEngine,
    public_invite: &mut Option<Invite>,
    keys: &Keys,
    event: &Event,
) -> Vec<ProtocolDecryptedMessage> {
    if event.kind.as_u16() as u32 != INVITE_RESPONSE_KIND {
        return engine
            .process_direct_message_event(event)
            .ok()
            .flatten()
            .into_iter()
            .collect();
    }
    let Ok(envelope) = parse_invite_response_event(event) else {
        return Vec::new();
    };
    if let Some(invite) = public_invite
        .as_mut()
        .filter(|invite| invite.inviter_ephemeral_public_key == envelope.recipient)
    {
        // Same authenticated public-contact import as Messaging::receive, but
        // its engine and invite are detached and all writes stay in memory.
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(iris_chat_protocol::NdrUnixSeconds(now()), &mut rng);
        let Ok(response) =
            invite.process_response(&mut context, &envelope, keys.secret_key().to_secret_bytes())
        else {
            return Vec::new();
        };
        let Ok(device) = PublicKey::from_slice(&response.invitee_device_pubkey.to_bytes()) else {
            return Vec::new();
        };
        let owner = response.resolved_owner_pubkey();
        let Ok(proof) = engine.ingest_invite_response_owner_proof(invite, event, owner, device)
        else {
            return Vec::new();
        };
        let mut messages = proof.direct_messages;
        if let Ok(ProtocolInviteSessionImportOutcome::Imported(batch)) = engine
            .import_private_invite_session_once(
                &event.id.to_hex(),
                owner,
                device,
                response.session.state,
                UnixSeconds(now()),
            )
        {
            messages.extend(batch.direct_messages);
        }
        messages
    } else {
        engine
            .observe_invite_response_event(event)
            .ok()
            .map(|batch| batch.direct_messages)
            .unwrap_or_default()
    }
}
fn message_resolution(
    state: &mut PrivateState,
    owner: PublicKey,
    message: ProtocolDecryptedMessage,
    outer_id: &str,
    policy: &Policy,
) -> Option<Resolution> {
    let mut inner = UnsignedEvent::from_json(&message.content).ok()?;
    inner.ensure_id();
    inner.verify_id().ok()?;
    if inner.kind != Kind::from(14)
        || message.sender == owner
        || (inner.pubkey != message.sender && Some(inner.pubkey) != message.sender_device)
        || inner.content.len() > MAX_MESSAGE_BYTES
    {
        return None;
    }
    let id = inner.id?.to_hex();
    let peer = message.sender.to_hex();
    let mut context = crate::conversation_context::from_rumor(&inner);
    if context
        .as_ref()
        .and_then(|c| c.order_id.as_ref())
        .is_some_and(|id| !state.orders.context_participant(id, &owner.to_hex(), &peer))
    {
        context = None;
    }
    let mut order_id = context.as_ref().and_then(|c| c.order_id.clone());
    if crate::orders::is_order_message(&inner) {
        let (id, location) = state.orders.receive(
            &inner,
            &peer,
            &message.sender_device.unwrap_or(message.sender).to_hex(),
            &owner.to_hex(),
            now(),
        )?;
        if location {
            return None;
        }
        order_id = Some(id);
    }
    let resolution = Resolution {
        show: true,
        notification_id: outer_id.into(),
        message_id: Some(id),
        peer_id: Some(peer),
        thread_id: context.map(|c| c.thread_id),
        order_id,
        title: "Iris Market".into(),
        body: "New private activity".into(),
    };
    permitted(&resolution, policy).then_some(resolution)
}
