//! Per-match aliases for private-match introductions.
//!
//! Agreeing to a suggestion creates a fresh identity for that match only. Its
//! secret is derived on demand from this device's secret (held in platform
//! secure storage) and a random salt, so no alias secret is ever persisted.
//! The invitation and ratchet state are encrypted at rest with the other
//! protocol state and never appear in views, logs or exports.
//!
//! Alias traffic never uses the account or device key, public invitations,
//! device lists or account subscription scopes. Each alias scope gets its own
//! anonymous receive connection, and every publish its own send connection.
use super::*;
use nostr_double_ratchet::{
    Session, SessionState, UnixSeconds as NdrSeconds, invite_response_event, message_event,
    parse_message_event,
};
use uuid::Uuid;

const INFO: &[u8] = b"iris-market/private-match-alias-v1";
const ROOT: &str = "https://market.iris.to/invite";
const CAP: usize = 128;
pub(crate) const PREFIX: &str = "match:";
pub(crate) const HELLO: &str = "Hi! Our helper introduced us privately.";
/// A profile reveal travels only inside the encrypted alias chat. Its proof
/// uses an ephemeral kind so a relay would never keep it if one were leaked.
const REVEAL_TAG: &str = "iris-market/reveal";
const REVEAL_KIND: u16 = 27_412;
pub(crate) const REVEALED: &str = "Shared their profile";
pub(crate) const SHARED: &str = "You shared your profile";

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Alias {
    salt: [u8; 32],
    pubkey: PublicKey,
    invite: Invite,
    title: String,
    expires_at: u64,
    #[serde(default)]
    peer: Option<PublicKey>,
    /// Replies that arrived before the helper's introduction named the peer.
    #[serde(default)]
    early: Vec<Event>,
    #[serde(default)]
    session: Option<SessionState>,
    #[serde(default)]
    messages: Vec<Message>,
    /// This person chose to show their profile in this chat.
    #[serde(default)]
    shared: bool,
    /// The other person's verified profile, once they chose to share it.
    #[serde(default)]
    revealed: Option<PublicKey>,
}

/// What the match view shows about a local alias chat; never key material.
pub(super) struct AliasStatus {
    pub(super) connected: bool,
    pub(super) shared: bool,
    pub(super) revealed: Option<PublicKey>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Outbound {
    chat: Uuid,
    event: Event,
    #[serde(default)]
    inner_id: Option<String>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct Aliases {
    chats: BTreeMap<Uuid, Alias>,
    outbox: BTreeMap<String, Outbound>,
}

impl Aliases {
    /// Unanswered aliases end with their suggestion; connected chats remain.
    fn prune(&mut self, at: u64) {
        self.chats
            .retain(|_, c| c.session.is_some() || c.expires_at > at);
        let chats = &self.chats;
        self.outbox.retain(|_, q| chats.contains_key(&q.chat));
    }
    pub(super) fn forget_pending(&mut self) {
        self.prune(u64::MAX);
    }
    #[cfg(test)]
    pub(super) fn pubkey(&self, chat: Uuid) -> Option<PublicKey> {
        self.chats.get(&chat).map(|c| c.pubkey)
    }
}

fn chat_id(id: &str) -> MessagingResult<Uuid> {
    id.strip_prefix(PREFIX)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .ok_or_else(|| "Invalid conversation".to_string())
}
fn key(device: nostr_double_ratchet::DevicePubkey) -> Option<PublicKey> {
    PublicKey::from_slice(&device.to_bytes()).ok()
}
fn session_authors(state: &SessionState) -> Vec<PublicKey> {
    let mut authors: Vec<_> = [
        state.their_current_nostr_public_key,
        state.their_next_nostr_public_key,
    ]
    .into_iter()
    .flatten()
    .chain(state.skipped_keys.keys().copied())
    .filter_map(key)
    .collect();
    authors.sort();
    authors.dedup();
    authors
}

impl Messaging {
    fn alias_keys(&self, salt: &[u8; 32]) -> MessagingResult<Keys> {
        let device = self.keys.secret_key().to_secret_bytes();
        let mut okm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(salt), &device)
            .expand(INFO, &mut okm)
            .map_err(|_| "Could not create a private alias".to_string())?;
        let secret = nostr::SecretKey::from_slice(&okm)
            .map_err(|_| "Could not create a private alias".to_string())?;
        Ok(Keys::new(secret))
    }

    /// Local only: returns the invitation the helper forwards to the match.
    pub(super) fn create_alias(
        &mut self,
        chat: Uuid,
        title: &str,
        expires_at: u64,
    ) -> MessagingResult<String> {
        self.state.aliases.prune(now());
        if let Some(existing) = self.state.aliases.chats.get(&chat) {
            return invite_url(&existing.invite, ROOT).map_err(protocol_error);
        }
        if self.state.aliases.chats.len() >= CAP {
            return Err("Too many private matches on this device".into());
        }
        let mut salt = [0u8; 32];
        OsRng.fill_bytes(&mut salt);
        let keys = self.alias_keys(&salt)?;
        if keys.public_key() == self.owner || keys.public_key() == self.keys.public_key() {
            return Err("Could not create a private alias".into());
        }
        let invite =
            Invite::create_new(keys.public_key(), None, Some(1)).map_err(protocol_error)?;
        let url = invite_url(&invite, ROOT).map_err(protocol_error)?;
        self.state.aliases.chats.insert(
            chat,
            Alias {
                salt,
                pubkey: keys.public_key(),
                invite,
                title: title.chars().take(200).collect(),
                expires_at,
                peer: None,
                early: Vec::new(),
                session: None,
                messages: Vec::new(),
                shared: false,
                revealed: None,
            },
        );
        Ok(url)
    }

    /// The helper named the other alias. The lower key accepts the other
    /// invitation and says hello, so both sides can write immediately after.
    pub(super) fn alias_introduced(
        &mut self,
        chat: Uuid,
        peer: PublicKey,
        invite: &str,
    ) -> MessagingResult<()> {
        let Some(mut alias) = self.state.aliases.chats.get(&chat).cloned() else {
            return Ok(());
        };
        if alias.peer.is_some() || alias.session.is_some() || peer == alias.pubkey {
            return Ok(());
        }
        alias.peer = Some(peer);
        if alias.pubkey.to_hex() < peer.to_hex() {
            let theirs = parse_invite_url(invite).map_err(protocol_error)?;
            if key(theirs.inviter_device_pubkey) != Some(peer) {
                return Err("Private match invitation does not match".into());
            }
            let keys = self.alias_keys(&alias.salt)?;
            let (session, envelope) = theirs
                .accept(keys.public_key(), keys.secret_key().to_secret_bytes(), None)
                .map_err(protocol_error)?;
            let event = invite_response_event(&envelope).map_err(protocol_error)?;
            alias.session = Some(session.state);
            alias.early.clear();
            self.state.aliases.chats.insert(chat, alias);
            self.state.aliases.outbox.insert(
                event.id.to_hex(),
                Outbound {
                    chat,
                    event,
                    inner_id: None,
                },
            );
            return self.alias_send(chat, HELLO);
        }
        let early = std::mem::take(&mut alias.early);
        self.state.aliases.chats.insert(chat, alias);
        for event in early {
            // Only the named peer's reply can open the session.
            let _ = self.alias_response(chat, &event);
        }
        Ok(())
    }

    fn alias_response(&mut self, chat: Uuid, event: &Event) -> MessagingResult<()> {
        let envelope = parse_invite_response_event(event).map_err(protocol_error)?;
        let alias = self
            .state
            .aliases
            .chats
            .get(&chat)
            .cloned()
            .ok_or("Private match ended")?;
        if alias.session.is_some() {
            return Ok(());
        }
        let Some(peer) = alias.peer else {
            let alias = self.state.aliases.chats.get_mut(&chat).expect("present");
            if alias.early.len() < 4 && !alias.early.iter().any(|e| e.id == event.id) {
                alias.early.push(event.clone());
            }
            return Ok(());
        };
        let keys = self.alias_keys(&alias.salt)?;
        let mut invite = alias.invite.clone();
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(NdrSeconds(now()), &mut rng);
        let response = invite
            .process_response(&mut context, &envelope, keys.secret_key().to_secret_bytes())
            .map_err(protocol_error)?;
        if response.invitee_identity != peer {
            return Err("Unexpected private match reply".into());
        }
        let alias = self.state.aliases.chats.get_mut(&chat).expect("present");
        alias.invite = invite;
        alias.session = Some(response.session.state);
        Ok(())
    }

    fn alias_message(&mut self, chat: Uuid, event: &Event) -> MessagingResult<()> {
        let envelope = parse_message_event(event).map_err(protocol_error)?;
        let alias = self
            .state
            .aliases
            .chats
            .get(&chat)
            .ok_or("Private match ended")?;
        let mut session = Session::from_state(alias.session.clone().ok_or("Not connected")?);
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(NdrSeconds(now()), &mut rng);
        let plan = session
            .plan_receive(&mut context, &envelope)
            .map_err(protocol_error)?;
        let payload = session.apply_receive(plan).payload;
        let alias = self.state.aliases.chats.get_mut(&chat).expect("present");
        alias.session = Some(session.state);
        let Ok(inner) = std::str::from_utf8(&payload)
            .map_err(protocol_error)
            .and_then(|raw| UnsignedEvent::from_json(raw).map_err(protocol_error))
        else {
            return Ok(());
        };
        let reveals: Vec<_> = inner
            .tags
            .iter()
            .map(|t| t.as_slice())
            .filter(|t| t[0] == REVEAL_TAG)
            .collect();
        let revealed = match reveals.as_slice() {
            [] => None,
            [[_, proof]] => {
                // Only a proof bound to exactly these two aliases counts.
                match reveal_owner(proof, alias.peer, alias.pubkey) {
                    Some(owner) => Some(owner),
                    None => return Ok(()),
                }
            }
            _ => return Ok(()),
        };
        let text = if revealed.is_some() {
            REVEALED
        } else {
            inner.content.trim()
        };
        if inner.kind != Kind::from(14) || text.is_empty() || text.len() > MAX_MESSAGE_BYTES {
            return Ok(());
        }
        if revealed.is_some() {
            alias.revealed = revealed;
        }
        let created_at = inner.created_at.as_secs().min(now() + 60);
        let id = inner.id.map(|id| id.to_hex()).unwrap_or(event.id.to_hex());
        if alias.messages.iter().any(|m| m.id == id) || alias.messages.len() >= MAX_THREAD_MESSAGES
        {
            return Ok(());
        }
        alias.messages.push(Message {
            expires_at: None,
            context: None,
            id,
            text: text.to_owned(),
            mine: false,
            created_at,
            created_at_ms: message_millis(&inner).min((now() + 60) * 1000),
            delivery: "received".into(),
            reactions: Vec::new(),
            order_id: None,
            escrow: None,
            cashu: None,
        });
        alias.messages.sort_by_key(message_sort_millis);
        Ok(())
    }

    pub(super) fn alias_send(&mut self, chat: Uuid, text: &str) -> MessagingResult<()> {
        self.alias_send_tagged(chat, text, text, None)
    }

    /// Explicit only: proves to this chat's other alias that this account
    /// stands behind our alias. Nothing else links the two.
    pub(super) fn reveal_alias(&mut self, chat: Uuid) -> MessagingResult<()> {
        let alias = self
            .state
            .aliases
            .chats
            .get(&chat)
            .ok_or("This private match has ended")?;
        if alias.shared {
            return Ok(());
        }
        let peer = alias.peer.ok_or("Wait until you are connected")?;
        let owner = self
            .owner_keys
            .as_ref()
            .ok_or("Share your profile from the device that holds your profile key")?;
        let proof = nostr::EventBuilder::new(Kind::from(REVEAL_KIND), "")
            .tags([
                nostr::Tag::parse(["alias", &alias.pubkey.to_hex()]).map_err(protocol_error)?,
                nostr::Tag::public_key(peer),
            ])
            .sign_with_keys(owner)
            .map_err(protocol_error)?;
        let tag = nostr::Tag::parse([REVEAL_TAG, &proof.as_json()]).map_err(protocol_error)?;
        self.alias_send_tagged(chat, REVEALED, SHARED, Some(tag))?;
        if let Some(alias) = self.state.aliases.chats.get_mut(&chat) {
            alias.shared = true;
        }
        Ok(())
    }

    fn alias_send_tagged(
        &mut self,
        chat: Uuid,
        content: &str,
        local_text: &str,
        extra: Option<nostr::Tag>,
    ) -> MessagingResult<()> {
        let text = local_text;
        if self.state.outbox.len() + self.state.aliases.outbox.len() >= MAX_OUTBOX {
            return Err("Connect to send queued messages before sending more".into());
        }
        let millis = self.next_message_millis();
        let at = millis / 1000;
        let alias = self
            .state
            .aliases
            .chats
            .get_mut(&chat)
            .ok_or("This private match has ended")?;
        let mut session = Session::from_state(
            alias
                .session
                .clone()
                .ok_or("Waiting for the other person to connect")?,
        );
        if !session.can_send() {
            return Err("Waiting for the other person to say hello".into());
        }
        let peer = alias
            .peer
            .ok_or("Waiting for the other person to connect")?;
        let mut rumor = UnsignedEvent::from_json(
            serde_json::json!({"pubkey":alias.pubkey,"kind":14,"created_at":at,"content":text,
                "tags":[["p",peer.to_hex()],["ms",millis.to_string()]]})
            .to_string(),
        )
        .map_err(protocol_error)?;
        rumor.content = content.to_owned();
        if let Some(tag) = extra {
            rumor.tags.push(tag);
        }
        rumor.ensure_id();
        let id = rumor.id.ok_or("Missing message identity")?.to_hex();
        let plan = session
            .plan_send(rumor.as_json().as_bytes(), NdrSeconds(at))
            .map_err(protocol_error)?;
        let envelope = session.apply_send(plan).envelope;
        let event = message_event(&envelope).map_err(protocol_error)?;
        alias.session = Some(session.state);
        alias.messages.push(Message {
            expires_at: None,
            context: None,
            id: id.clone(),
            text: text.to_owned(),
            mine: true,
            created_at: at,
            created_at_ms: millis,
            delivery: "pending".into(),
            reactions: Vec::new(),
            order_id: None,
            escrow: None,
            cashu: None,
        });
        self.state.aliases.outbox.insert(
            event.id.to_hex(),
            Outbound {
                chat,
                event,
                inner_id: Some(id),
            },
        );
        Ok(())
    }

    pub(super) fn send_alias_text(&mut self, peer_id: &str, text: &str) -> MessagingResult<()> {
        self.require_authorization()?;
        let chat = chat_id(peer_id)?;
        let text = text.trim();
        if text.is_empty() {
            return Err("Write a message first".into());
        }
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("Message is too long".into());
        }
        self.transaction(|this| this.alias_send(chat, text))
    }

    /// Routes alias traffic before the account engine sees it.
    pub(super) fn receive_alias(&mut self, event: &Event) -> Option<MessagingResult<()>> {
        let kind = event.kind.as_u16() as u32;
        let chat = if kind == INVITE_RESPONSE_KIND {
            let recipient = parse_invite_response_event(event).ok()?.recipient;
            self.state.aliases.chats.iter().find_map(|(id, c)| {
                (c.session.is_none() && c.invite.inviter_ephemeral_public_key == recipient)
                    .then_some(*id)
            })?
        } else if kind == MESSAGE_EVENT_KIND {
            let sender = parse_message_event(event).ok()?.sender;
            self.state.aliases.chats.iter().find_map(|(id, c)| {
                c.session
                    .as_ref()
                    .is_some_and(|s| Session::from_state(s.clone()).matches_sender(sender))
                    .then_some(*id)
            })?
        } else {
            return None;
        };
        let seen = event.id.to_hex();
        if self.state.seen.contains(&seen) {
            return Some(Ok(()));
        }
        Some(self.transaction(|this| {
            if kind == INVITE_RESPONSE_KIND {
                this.alias_response(chat, event)?;
            } else {
                this.alias_message(chat, event)?;
            }
            this.state.seen.push(seen);
            if this.state.seen.len() > MAX_SEEN {
                this.state.seen.drain(..this.state.seen.len() - MAX_SEEN);
            }
            Ok(())
        }))
    }

    pub(super) fn alias_subscriptions(&self, result: &mut Vec<PrivateSubscription>) {
        let at = now();
        for alias in self.state.aliases.chats.values() {
            match &alias.session {
                None if alias.expires_at > at => {
                    if let Some(ephemeral) = key(alias.invite.inviter_ephemeral_public_key) {
                        result.push(PrivateSubscription {
                            scope: format!("private-match-invite-{}", ephemeral.to_hex()),
                            filter: Filter::new()
                                .kind(Kind::from(INVITE_RESPONSE_KIND as u16))
                                .pubkey(ephemeral)
                                .limit(16),
                        });
                    }
                }
                Some(state) => {
                    for author in session_authors(state) {
                        result.push(PrivateSubscription {
                            scope: format!("private-match-session-{}", author.to_hex()),
                            filter: Filter::new()
                                .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
                                .author(author)
                                .limit(256),
                        });
                    }
                }
                None => {}
            }
        }
    }

    pub(super) fn alias_outbound(&self) -> impl Iterator<Item = Event> + '_ {
        self.state.aliases.outbox.values().map(|q| q.event.clone())
    }

    /// Returns whether the event belonged to an alias.
    pub(super) fn alias_published(&mut self, event_id: &str) -> bool {
        let Some(queued) = self.state.aliases.outbox.remove(event_id) else {
            return false;
        };
        if let Some(inner) = queued.inner_id
            && let Some(message) = self
                .state
                .aliases
                .chats
                .get_mut(&queued.chat)
                .and_then(|c| c.messages.iter_mut().find(|m| m.id == inner))
        {
            controls::advance_delivery(message, "sent");
        }
        true
    }

    /// Introduced chats appear in the inbox, labeled and never keyed by a person.
    pub(super) fn alias_conversations(&self) -> impl Iterator<Item = Conversation> + '_ {
        self.state
            .aliases
            .chats
            .iter()
            .filter(|(_, c)| c.peer.is_some() || c.session.is_some())
            .map(|(id, c)| Conversation {
                id: format!("{PREFIX}{id}"),
                name: format!(
                    "Private match · {}",
                    c.title.chars().take(60).collect::<String>()
                ),
                messages: c.messages.clone(),
            })
    }

    pub(super) fn alias_status(&self, chat: Uuid) -> Option<AliasStatus> {
        self.state.aliases.chats.get(&chat).map(|c| AliasStatus {
            connected: c
                .session
                .as_ref()
                .is_some_and(|s| Session::from_state(s.clone()).can_send())
                && c.peer.is_some(),
            shared: c.shared,
            revealed: c.revealed,
        })
    }

    #[cfg(test)]
    pub(super) fn alias_connected(&self, chat: Uuid) -> bool {
        self.state
            .aliases
            .chats
            .get(&chat)
            .is_some_and(|c| c.session.is_some())
    }
}

/// The account that signed a reveal bound to sender alias `from` and recipient `to`.
fn reveal_owner(proof: &str, from: Option<PublicKey>, to: PublicKey) -> Option<PublicKey> {
    let proof = Event::from_json(proof).ok()?;
    let tags: Vec<_> = proof.tags.iter().map(|t| t.as_slice()).collect();
    let alias = from?.to_hex();
    (proof.verify().is_ok()
        && proof.kind == Kind::from(REVEAL_KIND)
        && proof.created_at.as_secs() <= now() + 300
        && proof.pubkey != from?
        && tags.len() == 2
        && tags.contains(&["alias".to_owned(), alias].as_slice())
        && tags.contains(&["p".to_owned(), to.to_hex()].as_slice()))
    .then_some(proof.pubkey)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The web implementation (web/src/private-match/aliases.ts) behind JSON lines.
    struct WebPeer {
        child: std::process::Child,
        input: std::process::ChildStdin,
        output: std::io::BufReader<std::process::ChildStdout>,
    }
    impl WebPeer {
        fn start() -> Option<Self> {
            use std::process::{Command, Stdio};
            let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web");
            if !web.join("node_modules/nostr-double-ratchet").exists() {
                assert!(
                    std::env::var_os("IRIS_REQUIRE_WEB_INTEROP").is_none(),
                    "web dependencies are missing"
                );
                eprintln!("skipping web interop: run npm ci in web/");
                return None;
            }
            let mut child = Command::new("node")
                .arg("tests/support/alias-peer.mjs")
                .current_dir(web)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .ok()?;
            let input = child.stdin.take()?;
            let output = std::io::BufReader::new(child.stdout.take()?);
            Some(Self {
                child,
                input,
                output,
            })
        }
        fn ask(&mut self, query: serde_json::Value) -> serde_json::Value {
            use std::io::{BufRead, Write};
            writeln!(self.input, "{query}").unwrap();
            let mut line = String::new();
            self.output.read_line(&mut line).unwrap();
            let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert!(reply.get("error").is_none(), "web peer: {reply}");
            reply
        }
        fn events(reply: &serde_json::Value) -> Vec<Event> {
            let mut events: Vec<Event> = reply["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| Event::from_json(e.to_string()).unwrap())
                .collect();
            events.sort_by_key(|e| e.kind.as_u16());
            events
        }
    }
    impl Drop for WebPeer {
        fn drop(&mut self) {
            let _ = self.child.kill();
        }
    }

    fn web_interop(core_accepts: bool) {
        let Some(mut web) = WebPeer::start() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let mut core = Messaging::open(dir.path(), Keys::generate()).unwrap();
        let end = now() + 3600;
        // Roles follow key order, so draw aliases until the wanted role comes up.
        let (chat, web_alias, web_url) = (0..64)
            .find_map(|_| {
                let chat = Uuid::new_v4();
                core.create_alias(chat, "Two-seat cargo bike", end).unwrap();
                let reply =
                    web.ask(serde_json::json!({"op":"create","title":"Bike","expires_at":end}));
                let theirs = PublicKey::from_hex(reply["pubkey"].as_str().unwrap()).unwrap();
                let ours = core.state.aliases.pubkey(chat).unwrap();
                ((ours.to_hex() < theirs.to_hex()) == core_accepts)
                    .then(|| (chat, theirs, reply["url"].as_str().unwrap().to_owned()))
            })
            .expect("alias order");
        let core_alias = core.state.aliases.pubkey(chat).unwrap();
        let core_url = invite_url(&core.state.aliases.chats[&chat].invite, ROOT).unwrap();
        let id = format!("{PREFIX}{chat}");

        core.transaction(|c| c.alias_introduced(chat, web_alias, &web_url))
            .unwrap();
        let reply = web
            .ask(serde_json::json!({"op":"introduced","peer":core_alias.to_hex(),"url":core_url}));
        let exchange = |core: &mut Messaging, web: &mut WebPeer, reply: &serde_json::Value| {
            for event in WebPeer::events(reply) {
                core.receive(&event).unwrap();
            }
            let mut outbound = core.pending_outbound();
            outbound.sort_by_key(|e| e.kind.as_u16());
            let mut last = serde_json::Value::Null;
            for event in outbound {
                assert_ne!(event.pubkey, core.owner);
                last = web.ask(serde_json::json!({"op":"deliver","event":event}));
                core.acknowledge_published(&event.id.to_hex()).unwrap();
            }
            last
        };
        exchange(&mut core, &mut web, &reply);
        let texts = |core: &Messaging| -> Vec<String> {
            core.conversations()
                .into_iter()
                .find(|c| c.id == id)
                .map(|c| c.messages.into_iter().map(|m| m.text).collect())
                .unwrap_or_default()
        };
        assert!(core.alias_connected(chat));
        assert_eq!(texts(&core), [HELLO]);

        let reply = web.ask(serde_json::json!({"op":"send","text":"Written on the web"}));
        exchange(&mut core, &mut web, &reply);
        assert!(texts(&core).contains(&"Written on the web".to_owned()));

        core.send(&id, "Written in the core").unwrap();
        let state = exchange(&mut core, &mut web, &serde_json::json!({"events":[]}));
        assert_eq!(state["connected"], true);
        let seen: Vec<_> = state["texts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        assert_eq!(seen, [HELLO, "Written on the web", "Written in the core"]);
    }

    #[test]
    fn only_a_reveal_bound_to_both_aliases_names_an_account() {
        let owner = Keys::generate();
        let (from, to) = (Keys::generate().public_key(), Keys::generate().public_key());
        let proof = |kind: u16, alias: PublicKey, p: PublicKey, signer: &Keys| {
            nostr::EventBuilder::new(Kind::from(kind), "")
                .tags([
                    nostr::Tag::parse(["alias", &alias.to_hex()]).unwrap(),
                    nostr::Tag::public_key(p),
                ])
                .sign_with_keys(signer)
                .unwrap()
                .as_json()
        };
        let good = proof(REVEAL_KIND, from, to, &owner);
        assert_eq!(
            reveal_owner(&good, Some(from), to),
            Some(owner.public_key())
        );
        // Replayed into another chat, or before the peer is known: ignored.
        assert_eq!(reveal_owner(&good, Some(to), from), None);
        assert_eq!(reveal_owner(&good, None, to), None);
        let other = Keys::generate().public_key();
        assert_eq!(reveal_owner(&good, Some(from), other), None);
        assert_eq!(
            reveal_owner(&proof(1, from, to, &owner), Some(from), to),
            None
        );
        // An alias cannot vouch for itself.
        let alias = Keys::generate();
        let own = proof(REVEAL_KIND, alias.public_key(), to, &alias);
        assert_eq!(reveal_owner(&own, Some(alias.public_key()), to), None);
        let mut forged: serde_json::Value = serde_json::from_str(&good).unwrap();
        forged["pubkey"] = serde_json::json!(other.to_hex());
        assert_eq!(reveal_owner(&forged.to_string(), Some(from), to), None);
    }

    #[test]
    fn core_accepts_a_web_alias_and_both_can_write() {
        web_interop(true);
    }

    #[test]
    fn web_accepts_a_core_alias_and_both_can_write() {
        web_interop(false);
    }

    #[test]
    fn web_shaped_wires_parse_in_the_core() {
        let url = invite_url(
            &Invite::create_new(Keys::generate().public_key(), None, Some(1)).unwrap(),
            ROOT,
        )
        .unwrap();
        let alias = Keys::generate().public_key();
        let proposal = Uuid::new_v4();
        // Exactly as web/src/private-matches.ts serializes them.
        for raw in [
            serde_json::json!({"op":"vote","proposal":proposal,"accept":true,"expires_at":5,"invite":url}),
            serde_json::json!({"op":"vote","proposal":proposal,"accept":false,"expires_at":5}),
            serde_json::json!({"op":"introduce","proposal":proposal,"contact":alias,"expires_at":5,"invite":url}),
            serde_json::json!({"op":"introduce","proposal":proposal,"contact":alias,"expires_at":5}),
        ] {
            let wire: super::super::private_matches::Wire =
                serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(serde_json::to_value(wire).unwrap(), raw);
        }
    }

    #[test]
    fn aliases_are_fresh_unlinkable_and_never_persist_their_secret() {
        let dir = tempfile::tempdir().unwrap();
        let device = Keys::generate();
        let mut chat = Messaging::open(dir.path(), device.clone()).unwrap();
        let (one, two) = (Uuid::new_v4(), Uuid::new_v4());
        let end = now() + 3600;
        let first = chat.create_alias(one, "Cargo bike", end).unwrap();
        let second = chat.create_alias(two, "Cargo bike", end).unwrap();
        // Repeating the request for the same match reuses its alias.
        assert_eq!(chat.create_alias(one, "Cargo bike", end).unwrap(), first);
        let a = chat.state.aliases.pubkey(one).unwrap();
        let b = chat.state.aliases.pubkey(two).unwrap();
        for alias in [a, b] {
            assert_ne!(alias, chat.owner);
            assert_ne!(alias, device.public_key());
        }
        assert_ne!(a, b);
        assert_ne!(first, second);
        let invite = parse_invite_url(&first).unwrap();
        assert_eq!(key(invite.inviter_device_pubkey), Some(a));
        for text in [&first, &second] {
            assert!(!text.contains(&chat.owner.to_hex()));
        }
        // Derivation is reproducible from the device secret alone.
        let salt = chat.state.aliases.chats[&one].salt;
        assert_eq!(chat.alias_keys(&salt).unwrap().public_key(), a);
        let stored = serde_json::to_string(&chat.state).unwrap();
        for alias in [one, two] {
            let salt = chat.state.aliases.chats[&alias].salt;
            let secret = chat.alias_keys(&salt).unwrap().secret_key().to_secret_hex();
            assert!(!stored.contains(&secret));
        }
        // Pending aliases end with the suggestion; nothing subscribes after that.
        chat.state.aliases.prune(end);
        assert!(chat.state.aliases.chats.is_empty());
    }
}
