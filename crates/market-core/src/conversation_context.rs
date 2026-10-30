//! Optional marketplace context carried only inside encrypted kind-14 rumors.
use nostr::{PublicKey, Tag, UnsignedEvent};
use serde::{Deserialize, Serialize};

pub const CONTEXT_TAG: &str = "iris-market-context";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageContext {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<String>,
}
impl MessageContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        if uuid::Uuid::parse_str(&self.thread_id).is_err() || self.thread_id.len() != 36 { return Err("Invalid conversation thread"); }
        if self.order_id.as_ref().is_some_and(|id| id.split_once(':').is_none_or(|(owner, thread)| owner.len() != 64 || PublicKey::from_hex(owner).is_err() || thread != self.thread_id)) {
            return Err("Invalid order conversation");
        }
        if let Some(reference) = &self.listing {
            let mut fields = reference.splitn(3, ':');
            if reference.len() > 512 || fields.next() != Some("30402")
                || fields.next().is_none_or(|key| PublicKey::from_hex(key).is_err())
                || fields.next().is_none_or(|identifier| identifier.is_empty() || identifier.chars().any(char::is_control)) {
                return Err("Invalid listing reference");
            }
        }
        Ok(())
    }
    pub fn for_order(id: &str) -> Self {
        Self { thread_id: id.rsplit(':').next().unwrap_or(id).into(), order_id: Some(id.into()), listing: None }
    }
    pub fn tag(&self) -> Result<Tag, String> {
        self.validate().map_err(str::to_string)?;
        Tag::parse([CONTEXT_TAG.to_string(), "1".into(), serde_json::to_string(self).map_err(|_| "Invalid conversation context")?])
            .map_err(|_| "Invalid conversation context".into())
    }
}

/// Unknown or malformed optional context must not discard an otherwise valid message.
pub fn from_rumor(rumor: &UnsignedEvent) -> Option<MessageContext> {
    let mut tags = rumor.tags.iter().filter(|tag| tag.as_slice().first().is_some_and(|name| name == CONTEXT_TAG));
    let tag = tags.next()?.as_slice();
    if tags.next().is_some() || tag.len() != 3 || tag[1] != "1" || tag[2].len() > 1024 { return None; }
    let context: MessageContext = serde_json::from_str(&tag[2]).ok()?;
    context.validate().ok()?;
    Some(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{JsonUtil, Keys};
    #[test]
    fn private_context_round_trips_and_rejects_ambiguous_or_unsafe_references() {
        let id = format!("{}:{}", Keys::generate().public_key(), uuid::Uuid::new_v4());
        let mut context = MessageContext::for_order(&id);
        context.listing = Some(format!("30402:{}:bicycle", Keys::generate().public_key()));
        let mut rumor = UnsignedEvent::from_json(serde_json::json!({"pubkey":Keys::generate().public_key(),"created_at":1,"kind":14,"content":"When can I collect it?","tags":[]}).to_string()).unwrap();
        rumor.tags = nostr::Tags::from_list(vec![context.tag().unwrap()]);
        assert_eq!(from_rumor(&rumor), Some(context.clone()));
        rumor.tags = nostr::Tags::from_list(vec![context.tag().unwrap(), context.tag().unwrap()]);
        assert_eq!(from_rumor(&rumor), None);
        context.order_id = Some(uuid::Uuid::new_v4().to_string());
        assert!(context.validate().is_err());
        context.order_id = None;
        context.listing = Some("https://example.invalid/tracker".into());
        assert!(context.validate().is_err());
    }
}
