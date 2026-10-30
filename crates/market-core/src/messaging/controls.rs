//! Private pairwise control rumors. All mutation runs in the encrypted checkpoint transaction.
use super::*;
use nostr::{EventId, Tag, Timestamp};
use nostr_double_ratchet_pairwise_codec::{self as codec, EncodeOptions, ReceiptType};

const MAX_JOBS: usize = 256;
const MAX_PENDING: usize = 256;
const MAX_HEADS: usize = 8192;
const MAX_TARGETS: usize = 256;
const RECEIPT_BATCH: usize = 128;
fn enabled() -> bool {
    true
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reaction {
    pub emoji: String,
    pub count: usize,
    pub reacted_by_me: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Controls {
    #[serde(default = "enabled")]
    pub delivery_receipts: bool,
    #[serde(default = "enabled")]
    pub read_receipts: bool,
    pub last_ms: u64,
    pub jobs: Vec<ControlJob>,
    pub pending: Vec<Incoming>,
    pub heads: BTreeMap<String, Head>,
    pub read: Vec<String>,
}
impl Default for Controls {
    fn default() -> Self {
        Self {
            delivery_receipts: true,
            read_receipts: true,
            last_ms: 0,
            jobs: Vec::new(),
            pending: Vec::new(),
            heads: BTreeMap::new(),
            read: Vec::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ControlJob {
    peer: String,
    rumor: UnsignedEvent,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Incoming {
    peer: String,
    author: String,
    id: String,
    ms: u64,
    kind: u16,
    content: String,
    targets: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Head {
    pub emoji: String,
    ms: u64,
    id: String,
}
fn head_key(peer: &str, target: &str, author: &str) -> String {
    format!("{peer}:{target}:{author}")
}
fn valid_emoji(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() > 32 || value.len() > 128 {
        return false;
    }
    if matches!(chars.first(), Some('0'..='9' | '#' | '*')) {
        return (chars.len() == 2 && chars[1] == '\u{20e3}')
            || (chars.len() == 3 && chars[1] == '\u{fe0f}' && chars[2] == '\u{20e3}');
    }
    let regional = |c: char| ('\u{1f1e6}'..='\u{1f1ff}').contains(&c);
    if chars.iter().any(|c| regional(*c)) {
        return chars.len() == 2 && chars.iter().all(|c| regional(*c));
    }
    let pictograph = |c: char| matches!(c as u32,0x1f000..=0x1faff|0x2300..=0x23ff|0x2600..=0x27ff|0x2b00..=0x2bff|0x2190..=0x21ff|0xa9|0xae|0x203c|0x2049|0x2122|0x2139|0x3030|0x303d|0x3297|0x3299);
    chars.iter().any(|c| pictograph(*c))
        && chars
            .iter()
            .all(|c| pictograph(*c) || matches!(*c as u32, 0x200d | 0xfe0f | 0xe0020..=0xe007f))
}

fn rank(value: &str) -> u8 {
    match value {
        "pending" | "queued" | "failed" => 0,
        "sent" => 1,
        "delivered" => 2,
        "seen" => 3,
        _ => 0,
    }
}
pub(super) fn advance_delivery(message: &mut Message, value: &str) {
    if message.mine && rank(value) > rank(&message.delivery) {
        message.delivery = value.into();
    }
}
fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
impl Messaging {
    pub fn set_receipt_preferences(&mut self, delivered: bool, seen: bool) -> MessagingResult<()> {
        if self.state.controls.delivery_receipts == delivered
            && self.state.controls.read_receipts == seen
        {
            return Ok(());
        }
        self.transaction(|this| {
            this.state.controls.delivery_receipts = delivered;
            this.state.controls.read_receipts = seen;
            this.state.controls.jobs.retain(|job| {
                job.rumor.kind != Kind::from(15)
                    || match job.rumor.content.as_str() {
                        "seen" => seen,
                        "delivered" => delivered,
                        _ => false,
                    }
            });
            Ok(())
        })
    }
    fn next_control_ms(&mut self) -> u64 {
        let next = millis().max(self.state.controls.last_ms.saturating_add(1));
        self.state.controls.last_ms = next;
        next
    }
    fn queue_receipt(
        &mut self,
        peer: &str,
        mut ids: Vec<String>,
        seen: bool,
    ) -> MessagingResult<()> {
        if ids.is_empty()
            || (seen && !self.state.controls.read_receipts)
            || (!seen && !self.state.controls.delivery_receipts)
        {
            return Ok(());
        }
        let content = if seen { "seen" } else { "delivered" };
        if !seen {
            ids.retain(|id| {
                !self.state.controls.jobs.iter().any(|job| {
                    job.peer == peer
                        && job.rumor.kind == Kind::from(15)
                        && job.rumor.content == "seen"
                        && job
                            .rumor
                            .tags
                            .iter()
                            .any(|tag| tag.as_slice().get(1) == Some(id))
                })
            });
        }
        let mut keep = Vec::new();
        for job in std::mem::take(&mut self.state.controls.jobs) {
            if job.peer == peer && job.rumor.kind == Kind::from(15) && job.rumor.content == content
            {
                ids.extend(
                    job.rumor
                        .tags
                        .iter()
                        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                        .filter_map(|tag| tag.as_slice().get(1).cloned()),
                );
            } else {
                keep.push(job);
            }
        }
        self.state.controls.jobs = keep;
        ids.sort();
        ids.dedup();
        if seen && !ids.is_empty() {
            let mut replacement = Vec::new();
            for job in std::mem::take(&mut self.state.controls.jobs) {
                if job.peer == peer
                    && job.rumor.kind == Kind::from(15)
                    && job.rumor.content == "delivered"
                {
                    let remaining = job
                        .rumor
                        .tags
                        .iter()
                        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                        .filter_map(|tag| tag.as_slice().get(1))
                        .filter(|id| !ids.contains(id))
                        .cloned()
                        .collect::<Vec<_>>();
                    if !remaining.is_empty() {
                        let ms = self.next_control_ms();
                        let rumor = codec::receipt_event(
                            self.owner,
                            ReceiptType::Delivered,
                            remaining,
                            EncodeOptions::new(ms / 1000, ms),
                        )
                        .map_err(protocol_error)?;
                        replacement.push(ControlJob {
                            peer: peer.into(),
                            rumor,
                        });
                    }
                } else {
                    replacement.push(job);
                }
            }
            self.state.controls.jobs = replacement;
        }
        let queued_ids = self
            .state
            .controls
            .jobs
            .iter()
            .filter(|job| job.rumor.kind == Kind::from(15))
            .map(|job| {
                job.rumor
                    .tags
                    .iter()
                    .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                    .count()
            })
            .sum::<usize>();
        ids.truncate(2048usize.saturating_sub(queued_ids));
        for chunk in ids.chunks(RECEIPT_BATCH) {
            // Receipts are optional: queue pressure never rolls back a received message/read action.
            if self.state.controls.jobs.len() >= MAX_JOBS {
                break;
            }
            let ms = self.next_control_ms();
            let rumor = codec::receipt_event(
                self.owner,
                if seen {
                    ReceiptType::Seen
                } else {
                    ReceiptType::Delivered
                },
                chunk.iter().cloned(),
                EncodeOptions::new(ms / 1000, ms),
            )
            .map_err(protocol_error)?;
            self.state.controls.jobs.push(ControlJob {
                peer: peer.into(),
                rumor,
            });
        }
        Ok(())
    }
    pub(super) fn has_control_work(&self) -> bool {
        self.state.outbox.len() < MAX_OUTBOX.saturating_sub(16)
            && self.state.controls.jobs.iter().any(|job| {
                PublicKey::from_hex(&job.peer).is_ok_and(|peer| self.contact_recipient_ready(peer))
            })
    }
    pub(super) fn send_control_jobs(&mut self) -> MessagingResult<()> {
        if !self.can_send() {
            return Ok(());
        }
        for job in self.state.controls.jobs.clone() {
            if self.state.outbox.len() >= MAX_OUTBOX.saturating_sub(16) {
                break;
            }
            let peer = PublicKey::from_hex(&job.peer).map_err(protocol_error)?;
            if !self.contact_recipient_ready(peer) {
                continue;
            }
            let result = self
                .engine
                .send_direct_unsigned_event(peer, &job.peer, job.rumor.clone(), UnixSeconds(now()))
                .map_err(protocol_error)?;
            self.queue_effects(result.effects)?;
            self.state
                .controls
                .jobs
                .retain(|value| value.rumor.id != job.rumor.id);
        }
        Ok(())
    }
    pub fn toggle_reaction(
        &mut self,
        peer_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> MessagingResult<()> {
        self.require_authorization()?;
        let peer = PublicKey::parse(peer_id).map_err(protocol_error)?.to_hex();
        if emoji.is_empty() || !valid_emoji(emoji) {
            return Err("Choose an emoji reaction".into());
        }
        self.transaction(|this| {
            if !this.state.conversations.get(&peer).is_some_and(|thread| {
                thread
                    .messages
                    .iter()
                    .any(|message| message.id == message_id)
            }) {
                return Err("Reaction target is not in this conversation".into());
            }
            if this.state.controls.jobs.len() >= MAX_JOBS {
                return Err("Private control queue is full".into());
            }
            let author = this.owner.to_hex();
            let key = head_key(&peer, message_id, &author);
            if this.state.controls.heads.len() >= MAX_HEADS
                && !this.state.controls.heads.contains_key(&key)
            {
                return Err("Private reaction storage is full".into());
            }
            let content = if this
                .state
                .controls
                .heads
                .get(&key)
                .is_some_and(|head| head.emoji == emoji)
            {
                ""
            } else {
                emoji
            };
            let ms = this.next_control_ms();
            let mut rumor = if content.is_empty() {
                UnsignedEvent::new(
                    this.owner,
                    Timestamp::from_secs(ms / 1000),
                    Kind::from(7),
                    vec![
                        Tag::parse(["e", message_id]).map_err(protocol_error)?,
                        Tag::parse(["ms", &ms.to_string()]).map_err(protocol_error)?,
                    ],
                    String::new(),
                )
            } else {
                codec::reaction_event(
                    this.owner,
                    message_id,
                    content,
                    EncodeOptions::new(ms / 1000, ms),
                )
                .map_err(protocol_error)?
            };
            rumor.ensure_id();
            let incoming = Incoming {
                peer: peer.clone(),
                author,
                id: rumor.id.ok_or("Reaction identity is missing")?.to_hex(),
                ms,
                kind: 7,
                content: content.into(),
                targets: vec![message_id.into()],
            };
            if !this.apply_control_target(&incoming, message_id)? {
                return Err("Reaction target is unavailable".into());
            }
            this.state.controls.jobs.push(ControlJob {
                peer: peer.clone(),
                rumor,
            });
            Ok(())
        })
    }
    pub fn mark_messages_read(&mut self, ids: &[String]) -> MessagingResult<()> {
        if ids.len() > MAX_TARGETS {
            return Err("Choose up to 256 messages".into());
        }
        self.transaction(|this| {
            let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for thread in this.state.conversations.values() {
                for message in &thread.messages {
                    if !message.mine
                        && ids.contains(&message.id)
                        && !this.state.controls.read.contains(&message.id)
                    {
                        grouped
                            .entry(thread.id.clone())
                            .or_default()
                            .push(message.id.clone());
                    }
                }
            }
            for (peer, ids) in grouped {
                this.queue_receipt(&peer, ids.clone(), true)?;
                this.state.controls.read.extend(ids);
            }
            if this.state.controls.read.len() > MAX_SEEN {
                this.state
                    .controls
                    .read
                    .drain(..this.state.controls.read.len() - MAX_SEEN);
            }
            this.mark_notification_messages_read(ids)
        })
    }
    pub(super) fn accept_control(
        &mut self,
        peer: &str,
        author: &str,
        inner: &UnsignedEvent,
    ) -> MessagingResult<()> {
        if author != peer && author != self.owner.to_hex() {
            return Ok(());
        }
        let kind = inner.kind.as_u16();
        let legacy = if inner.content.starts_with('{') {
            serde_json::from_str::<serde_json::Value>(&inner.content).ok()
        } else {
            None
        };
        let content = match (kind, legacy.as_ref()) {
            (7, Some(value)) if value.get("type").and_then(|v| v.as_str()) == Some("reaction") => {
                match value.get("emoji").and_then(|v| v.as_str()) {
                    Some(emoji) => emoji,
                    None => return Ok(()),
                }
            }
            (15, Some(value)) => match value.get("type").and_then(|v| v.as_str()) {
                Some("delivered") => "delivered",
                Some("seen") => "seen",
                _ => return Ok(()),
            },
            (_, None) => inner.content.as_str(),
            _ => return Ok(()),
        };
        if kind == 15 && (author == self.owner.to_hex() || !matches!(content, "delivered" | "seen"))
        {
            return Ok(());
        }
        if kind == 7 && !valid_emoji(content) {
            return Ok(());
        }
        let tags = inner
            .tags
            .iter()
            .map(|tag| tag.as_slice())
            .collect::<Vec<_>>();
        let targets = tags
            .iter()
            .filter(|tag| tag.first().is_some_and(|key| key == "e"))
            .map(|tag| {
                if tag.len() >= 2 {
                    EventId::from_hex(&tag[1]).ok().map(|id| id.to_hex())
                } else {
                    None
                }
            })
            .collect::<Option<Vec<_>>>();
        let Some(mut targets) = targets else {
            return Ok(());
        };
        if let Some(legacy) = legacy.as_ref() {
            if kind == 7
                && legacy
                    .get("messageId")
                    .and_then(|value| value.as_str())
                    .is_none_or(|id| targets.len() != 1 || targets[0] != id)
            {
                return Ok(());
            }
            if kind == 15 {
                let Some(ids) = legacy
                    .get("messageIds")
                    .and_then(|value| value.as_array())
                    .filter(|ids| ids.len() <= MAX_TARGETS)
                else {
                    return Ok(());
                };
                let Some(mut ids) = ids
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .and_then(|id| EventId::from_hex(id).ok())
                            .map(|id| id.to_hex())
                    })
                    .collect::<Option<Vec<_>>>()
                else {
                    return Ok(());
                };
                ids.sort();
                ids.dedup();
                targets.sort();
                targets.dedup();
                if targets.is_empty() {
                    targets = ids;
                } else if targets != ids {
                    return Ok(());
                }
            }
        }
        if targets.is_empty() || targets.len() > MAX_TARGETS || (kind == 7 && targets.len() != 1) {
            return Ok(());
        }
        let timestamps = tags
            .iter()
            .filter(|tag| tag.first().is_some_and(|key| key == "ms"))
            .collect::<Vec<_>>();
        // Legacy unmarked Iris Chat controls use created_at when ms is absent.
        let ms = if timestamps.is_empty() {
            inner.created_at.as_secs().saturating_mul(1000)
        } else if timestamps.len() == 1 && timestamps[0].len() == 2 {
            match timestamps[0][1].parse::<u64>() {
                Ok(ms) => ms,
                Err(_) => return Ok(()),
            }
        } else {
            return Ok(());
        };
        if ms > millis().saturating_add(300_000)
            || (!timestamps.is_empty() && kind == 7 && ms / 1000 != inner.created_at.as_secs())
        {
            return Ok(());
        }
        if author == self.owner.to_hex() {
            self.state.controls.last_ms = self.state.controls.last_ms.max(ms);
        }
        let incoming = Incoming {
            peer: peer.into(),
            author: author.into(),
            id: inner.id.ok_or("Control identity is missing")?.to_hex(),
            ms,
            kind,
            content: content.into(),
            targets,
        };
        let mut missing = Vec::new();
        for target in &incoming.targets {
            if !self.apply_control_target(&incoming, target)? {
                missing.push(target.clone());
            }
        }
        if !missing.is_empty()
            && self.state.controls.pending.len() < MAX_PENDING
            && !self
                .state
                .controls
                .pending
                .iter()
                .any(|control| control.id == incoming.id)
        {
            self.state.controls.pending.push(Incoming {
                targets: missing,
                ..incoming
            });
        }
        Ok(())
    }
    fn apply_control_target(&mut self, control: &Incoming, target: &str) -> MessagingResult<bool> {
        let Some(message) = self
            .state
            .conversations
            .get_mut(&control.peer)
            .and_then(|thread| {
                thread
                    .messages
                    .iter_mut()
                    .find(|message| message.id == target)
            })
        else {
            return Ok(false);
        };
        if control.kind == 15 {
            if control.author == control.peer {
                advance_delivery(message, &control.content);
            }
            return Ok(true);
        }
        let key = head_key(&control.peer, target, &control.author);
        if let Some(previous) = self.state.controls.heads.get(&key) {
            if (previous.ms, previous.id.as_str()) >= (control.ms, control.id.as_str()) {
                return Ok(true);
            }
        } else if self.state.controls.heads.len() >= MAX_HEADS {
            return Ok(true);
        }
        self.state.controls.heads.insert(
            key,
            Head {
                emoji: control.content.clone(),
                ms: control.ms,
                id: control.id.clone(),
            },
        );
        Ok(true)
    }
    pub(super) fn controls_after_append(
        &mut self,
        peer: &str,
        message: &Message,
    ) -> MessagingResult<()> {
        let pending = std::mem::take(&mut self.state.controls.pending);
        for control in pending {
            let mut missing = Vec::new();
            for target in &control.targets {
                if !self.apply_control_target(&control, target)? {
                    missing.push(target.clone());
                }
            }
            if !missing.is_empty() {
                self.state.controls.pending.push(Incoming {
                    targets: missing,
                    ..control
                });
            }
        }
        if !message.mine {
            // Optional receipt pressure must never reject an otherwise valid incoming chat.
            let _ = self.queue_receipt(peer, vec![message.id.clone()], false);
        }
        Ok(())
    }
    pub(super) fn reactions_for(&self, peer: &str, target: &str) -> Vec<Reaction> {
        let mut result: BTreeMap<String, Reaction> = BTreeMap::new();
        let owner = self.owner.to_hex();
        for author in [peer, owner.as_str()] {
            if let Some(head) = self
                .state
                .controls
                .heads
                .get(&head_key(peer, target, author))
                .filter(|head| !head.emoji.is_empty())
            {
                let reaction = result.entry(head.emoji.clone()).or_insert(Reaction {
                    emoji: head.emoji.clone(),
                    count: 0,
                    reacted_by_me: false,
                });
                reaction.count += 1;
                reaction.reacted_by_me |= author == owner;
            }
        }
        result.into_values().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn fixture() -> (TempDir, Keys, Keys, Messaging) {
        let dir = TempDir::new().unwrap();
        let owner = Keys::generate();
        let peer = Keys::generate();
        let mut messaging = Messaging::open(dir.path(), owner.clone()).unwrap();
        messaging
            .transaction(|m| m.ensure_conversation(&peer.public_key().to_hex()))
            .unwrap();
        (dir, owner, peer, messaging)
    }
    fn message(id: &str, mine: bool) -> Message {
        Message {
            id: id.into(),
            context: None,
            text: "private fixture".into(),
            mine,
            created_at: now(),
            created_at_ms: now() * 1000,
            delivery: if mine { "pending" } else { "received" }.into(),
            order_id: None,
            cashu: None,
            reactions: Vec::new(),
        }
    }
    fn rumor(author: PublicKey, kind: u16, target: &str, content: &str, ms: u64) -> UnsignedEvent {
        let mut event = UnsignedEvent::new(
            author,
            Timestamp::from_secs(ms / 1000),
            Kind::from(kind),
            vec![
                Tag::parse(["e", target]).unwrap(),
                Tag::parse(["ms", &ms.to_string()]).unwrap(),
            ],
            content,
        );
        event.ensure_id();
        event
    }
    fn deliver(m: &mut Messaging, sender: PublicKey, event: &UnsignedEvent) -> MessagingResult<()> {
        m.transaction(|m| {
            m.apply_delivery(ProtocolDecryptedMessage {
                sender,
                sender_device: None,
                conversation_owner: None,
                created_at_secs: now(),
                content: event.as_json(),
                event_id: None,
            })
        })
    }
    #[test]
    fn shared_emoji_compatibility_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/chat-reaction-emoji.json"
        ))
        .unwrap();
        for value in fixture["valid"].as_array().unwrap() {
            assert!(
                valid_emoji(value.as_str().unwrap()),
                "expected supported emoji"
            );
        }
        for value in fixture["invalid"].as_array().unwrap() {
            if let Some(text) = value.as_str() {
                assert!(!valid_emoji(text), "expected invalid emoji");
            }
        }
    }
    #[test]
    fn receipt_reaction_heads_replay_ownership_and_restart() {
        let (dir, owner, peer, mut m) = fixture();
        let p = peer.public_key().to_hex();
        let id = "11".repeat(32);
        let ts = millis();
        let seen = rumor(peer.public_key(), 15, &id, "seen", ts);
        deliver(&mut m, peer.public_key(), &seen).unwrap(); // before target
        m.transaction(|m| m.append(&p, message(&id, true))).unwrap();
        assert_eq!(m.conversations()[0].messages[0].delivery, "seen");
        let old = rumor(peer.public_key(), 15, &id, "delivered", ts - 1);
        deliver(&mut m, peer.public_key(), &old).unwrap();
        assert_eq!(m.conversations()[0].messages[0].delivery, "seen");
        let reaction = rumor(peer.public_key(), 7, &id, "❤️", ts);
        deliver(&mut m, peer.public_key(), &reaction).unwrap();
        deliver(&mut m, peer.public_key(), &reaction).unwrap();
        assert_eq!(m.conversations()[0].messages[0].reactions[0].count, 1);
        let removed = rumor(peer.public_key(), 7, &id, "", ts + 1);
        deliver(&mut m, peer.public_key(), &removed).unwrap();
        deliver(&mut m, peer.public_key(), &reaction).unwrap();
        assert!(m.conversations()[0].messages[0].reactions.is_empty());
        let stranger = Keys::generate();
        assert!(deliver(&mut m, stranger.public_key(), &reaction).is_err());
        let other_id = "22".repeat(32);
        m.transaction(|m| m.append(&p, message(&other_id, false)))
            .unwrap();
        deliver(
            &mut m,
            peer.public_key(),
            &rumor(peer.public_key(), 15, &other_id, "seen", ts),
        )
        .unwrap();
        assert_eq!(
            m.conversations()[0]
                .messages
                .iter()
                .find(|msg| msg.id == other_id)
                .unwrap()
                .delivery,
            "received"
        );
        m.toggle_reaction(&p, &id, "👍").unwrap();
        assert!(m.reactions_for(&p, &id)[0].reacted_by_me);
        m.toggle_reaction(&p, &id, "👍").unwrap();
        assert!(m.reactions_for(&p, &id).is_empty());
        drop(m);
        let mut m = Messaging::open(dir.path(), owner).unwrap();
        deliver(&mut m, peer.public_key(), &reaction).unwrap();
        assert!(m.reactions_for(&p, &id).is_empty());
        assert_eq!(m.state.controls.heads.len(), 2);
        assert_eq!(m.conversations()[0].messages.len(), 2);
        assert_eq!(
            m.conversations()[0]
                .messages
                .iter()
                .find(|msg| msg.id == id)
                .unwrap()
                .delivery,
            "seen"
        );
    }
    #[test]
    fn receipt_pressure_never_blocks_messages_or_exact_reads_and_settings_survive() {
        let (dir, owner, peer, mut m) = fixture();
        let p = peer.public_key().to_hex();
        m.transaction(|m| {
            for n in 0..600 {
                m.append(&p, message(&format!("{n:064x}"), false))?;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(m.conversations()[0].messages.len(), 600);
        assert!(m.state.controls.jobs.len() < 10);
        assert!(m.state.controls.jobs.iter().all(|job| {
            job.rumor
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                .count()
                <= RECEIPT_BATCH
        }));
        let all_read = (0..256).map(|n| format!("{n:064x}")).collect::<Vec<_>>();
        m.mark_messages_read(&all_read).unwrap();
        assert_eq!(
            m.state
                .controls
                .jobs
                .iter()
                .filter(|job| job.rumor.content == "seen")
                .count(),
            2
        );
        assert!(m.state.controls.jobs.iter().all(|job| {
            job.rumor
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                .count()
                <= RECEIPT_BATCH
        }));
        // Keep the subsequent exact-read assertion independent of the boundary action.
        m.state
            .controls
            .jobs
            .retain(|job| job.rumor.content != "seen");
        m.state.controls.read.clear();

        let selected = vec![format!("{:064x}", 9), format!("{:064x}", 15)];
        m.mark_messages_read(&selected).unwrap();
        let seen = m
            .state
            .controls
            .jobs
            .iter()
            .filter(|job| job.rumor.content == "seen")
            .flat_map(|job| {
                job.rumor
                    .tags
                    .iter()
                    .filter(|tag| tag.as_slice().first().is_some_and(|key| key == "e"))
                    .filter_map(|tag| tag.as_slice().get(1).cloned())
            })
            .collect::<Vec<_>>();
        assert_eq!(seen, selected);
        m.state
            .controls
            .jobs
            .resize(MAX_JOBS, m.state.controls.jobs[0].clone());
        m.transaction(|m| m.append(&p, message(&"ff".repeat(32), false)))
            .unwrap();
        m.mark_messages_read(&["ff".repeat(32)]).unwrap();
        m.set_receipt_preferences(false, false).unwrap();
        drop(m);
        let mut m = Messaging::open(dir.path(), owner).unwrap();
        assert!(!m.state.controls.delivery_receipts);
        assert!(!m.state.controls.read_receipts);
        let before = m.state.controls.jobs.len();
        m.transaction(|m| m.append(&p, message(&"ee".repeat(32), false)))
            .unwrap();
        assert_eq!(before, m.state.controls.jobs.len());
    }
    #[test]
    fn legacy_missing_ms_json_reactions_and_wrong_peer_targets() {
        let (_dir, _owner, peer, mut m) = fixture();
        let p = peer.public_key().to_hex();
        let id = "33".repeat(32);
        let ts = now() * 1000;
        m.transaction(|m| m.append(&p, message(&id, true))).unwrap();
        let mut legacy = rumor(
            peer.public_key(),
            7,
            &id,
            &serde_json::json!({"type":"reaction","messageId":id,"emoji":"🎉"}).to_string(),
            ts,
        );
        legacy.tags =
            nostr::Tags::from_list(vec![Tag::parse(["e", id.as_str(), "", "reply"]).unwrap()]);
        legacy.id = None;
        legacy.ensure_id();
        deliver(&mut m, peer.public_key(), &legacy).unwrap();
        assert_eq!(m.reactions_for(&p, &id)[0].emoji, "🎉");
        let other = Keys::generate();
        let o = other.public_key().to_hex();
        m.transaction(|m| m.ensure_conversation(&o)).unwrap();
        deliver(
            &mut m,
            other.public_key(),
            &rumor(other.public_key(), 15, &id, "seen", ts),
        )
        .unwrap();
        assert_eq!(m.state.conversations[&p].messages[0].delivery, "pending");
        assert_eq!(m.state.controls.pending.len(), 1);
        let mut bad = rumor(peer.public_key(), 7, &id, "🔥", ts + 1);
        bad.tags.push(Tag::parse(["ms", &ts.to_string()]).unwrap());
        bad.id = None;
        bad.ensure_id();
        deliver(&mut m, peer.public_key(), &bad).unwrap();
        assert_eq!(m.reactions_for(&p, &id)[0].emoji, "🎉");
    }
}
