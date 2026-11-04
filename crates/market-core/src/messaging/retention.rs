//! Conversation timers travel inside authenticated NDR messages. The retention
//! policy is an encrypted, device-local preference and never enters a rumor.
use super::*;
use nostr_double_ratchet_pairwise_codec as codec;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Retention {
    #[default]
    Follow,
    Keep,
    Expire {
        seconds: u32,
    },
}
impl Retention {
    fn deadline(self, created: u64, shared: Option<u64>) -> Option<u64> {
        match self {
            Self::Follow => shared,
            Self::Keep => None,
            Self::Expire { seconds } => Some(created.saturating_add(u64::from(seconds))),
        }
    }
    pub(super) fn visible(self, created: u64, shared: Option<u64>, at: u64) -> bool {
        self.deadline(created, shared).is_none_or(|end| end > at)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Timer {
    seconds: Option<u64>,
    ms: u64,
    id: String,
}

impl Messaging {
    pub fn retention(&self) -> Retention {
        self.state.retention
    }
    pub fn chat_timer(&self, peer: &str) -> Option<u64> {
        self.state.timers.get(peer).and_then(|t| t.seconds)
    }
    pub fn set_retention(&mut self, policy: Retention) -> MessagingResult<()> {
        if policy == (Retention::Expire { seconds: 0 }) {
            return Err("Choose a positive duration".into());
        }
        self.transaction(|this| {
            this.prune_history(now()); // A new policy cannot restore previously expired copies.
            this.state.retention = policy;
            this.prune_history(now());
            Ok(())
        })
    }
    pub(crate) fn expire_history(&mut self) -> MessagingResult<bool> {
        let at = now();
        if !self.history_due(at) {
            return Ok(false);
        }
        self.transaction(|this| {
            this.prune_history(at);
            Ok(true)
        })
    }

    pub(super) fn history_due(&self, at: u64) -> bool {
        let p = self.retention();
        self.state.conversations.values().any(|c| {
            c.messages
                .iter()
                .any(|m| !p.visible(m.created_at, m.expires_at, at))
        }) || self
            .state
            .notice_history
            .values()
            .flatten()
            .any(|&created| !p.visible(created, None, at))
            || self
                .state
                .outbox
                .values()
                .any(|q| q.expires_at.is_some_and(|t| t <= at))
    }
    pub(super) fn prune_history(&mut self, at: u64) {
        let p = self.retention();
        for c in self.state.conversations.values_mut() {
            c.messages
                .retain(|m| p.visible(m.created_at, m.expires_at, at));
        }
        self.state.notice_history.retain(|_, items| {
            items.retain(|&t| p.visible(t, None, at));
            !items.is_empty()
        });
        self.state
            .outbox
            .retain(|_, q| q.expires_at.is_none_or(|t| t > at));
    }
    pub fn set_chat_timer(&mut self, peer: &str, seconds: Option<u32>) -> MessagingResult<()> {
        self.require_authorization()?;
        if seconds == Some(0) {
            return Err("Choose a positive duration or turn the timer off".into());
        }
        let peer = PublicKey::from_hex(peer).map_err(protocol_error)?;
        if peer == self.owner {
            return Err("Choose another person".into());
        }
        let id = peer.to_hex();
        if !self.state.conversations.contains_key(&id) {
            return Err("Open a private conversation first".into());
        }
        self.transaction(|this| {
            let ms = this.next_message_millis();
            let ttl = seconds.map_or(codec::ChatSettingsTtl::DisablePeerExpiration, |s| {
                codec::ChatSettingsTtl::Seconds(s.into())
            });
            let mut rumor = codec::chat_settings_event(this.keys.public_key(), ttl, ms / 1000, ms)
                .map_err(protocol_error)?;
            rumor.tags.push(nostr::Tag::public_key(peer));
            rumor.id = None;
            rumor.ensure_id();
            this.apply_timer(peer, &rumor)?;
            if this.contact_recipient_ready(peer) {
                let batch = this
                    .engine
                    .send_direct_unsigned_event(peer, &id, rumor, UnixSeconds(now()))
                    .map_err(protocol_error)?;
                this.queue_effects(batch.effects)?;
            } else {
                // Only the newest unsent setting for a peer needs delivery.
                this.state.pending_contact_messages.retain(|_, q| {
                    q.peer_id != id || q.rumor.kind.as_u16() != codec::CHAT_SETTINGS_KIND as u16
                });
                if this.state.pending_contact_messages.len() + this.state.outbox.len() >= MAX_OUTBOX
                {
                    return Err("Private message queue is full".into());
                }
                this.state.pending_contact_messages.insert(
                    rumor.id.unwrap().to_hex(),
                    PendingContactMessage {
                        peer_id: id,
                        rumor,
                        expires_at: None,
                    },
                );
            }
            Ok(())
        })
    }
    pub(super) fn apply_timer(
        &mut self,
        peer: PublicKey,
        rumor: &UnsignedEvent,
    ) -> MessagingResult<()> {
        let Ok(decoded) = codec::decode(rumor.as_json().as_bytes()) else {
            return Ok(());
        };
        let codec::PairwiseRumorKind::ChatSettings { message_ttl } = decoded.kind else {
            return Ok(());
        };
        let seconds = match message_ttl {
            codec::ChatSettingsTtl::Seconds(s) if s <= u32::MAX as u64 => Some(s),
            codec::ChatSettingsTtl::Seconds(_) => return Ok(()),
            _ => None,
        };
        let id = rumor.id.ok_or("Missing timer identity")?.to_hex();
        let ms = message_millis(rumor);
        if rumor.created_at.as_secs() > now() + 300 {
            return Ok(());
        }
        let key = peer.to_hex();
        if self
            .state
            .timers
            .get(&key)
            .is_none_or(|old| (ms, &id) > (old.ms, &old.id))
        {
            self.ensure_conversation(&key)?;
            self.state.timers.insert(key, Timer { seconds, ms, id });
        }
        Ok(())
    }
}
