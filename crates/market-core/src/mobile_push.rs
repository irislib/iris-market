//! Native push transport is optional. Requests contain private delivery scopes,
//! never account/profile discovery or plaintext messages.
use base64::{Engine, engine::general_purpose::STANDARD};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct PushSnapshot {
    pub filters: Vec<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    pub platform: String,
    pub token: String,
    pub apns_topic: Option<String>,
    pub production: bool,
    #[serde(default)]
    pub filters: Vec<serde_json::Value>,
}
#[derive(Debug, Serialize)]
pub struct PushRequest {
    pub method: String,
    pub url: String,
    pub authorization: String,
    pub body: Option<String>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Resolution {
    pub show: bool,
    pub notification_id: String,
    pub message_id: Option<String>,
    pub peer_id: Option<String>,
    pub thread_id: Option<String>,
    pub order_id: Option<String>,
    pub title: String,
    pub body: String,
}
/// Reject unsigned, oversized and unrelated payloads before opening private data.
pub fn payload_event(payload: &str) -> Option<Event> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    for key in [
        "event",
        "outer_event",
        "outer_event_json",
        "nostr_event",
        "nostr_event_json",
    ] {
        let Some(value) = value.get(key) else {
            continue;
        };
        let raw = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        let Ok(event) = Event::from_json(raw) else {
            continue;
        };
        if [
            iris_chat_protocol::MESSAGE_EVENT_KIND,
            iris_chat_protocol::INVITE_RESPONSE_KIND,
        ]
        .contains(&(event.kind.as_u16() as u32))
            && event.verify().is_ok()
            && event.created_at.as_secs() <= crate::listing::now() + 300
        {
            return Some(event);
        }
    }
    None
}
fn private_filter(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object
        .keys()
        .any(|k| !["kinds", "authors", "#p"].contains(&k.as_str()))
    {
        return false;
    }
    let kinds = value.get("kinds").and_then(|v| v.as_array());
    if kinds.is_none_or(|ks| {
        ks.len() != 1
            || !ks[0].as_u64().is_some_and(|k| {
                k == iris_chat_protocol::MESSAGE_EVENT_KIND as u64
                    || k == iris_chat_protocol::INVITE_RESPONSE_KIND as u64
            })
    }) {
        return false;
    }
    let Some(keys) = value
        .get("authors")
        .or_else(|| value.get("#p"))
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    !keys.is_empty()
        && keys.len() <= 512
        && keys.iter().all(|k| {
            k.as_str()
                .is_some_and(|k| nostr::PublicKey::from_hex(k).is_ok())
        })
        && !(object.contains_key("authors") && object.contains_key("#p"))
}
/// registration_secret is a dedicated installation/account credential, not an account key.
pub fn build_request(
    registration_secret: &str,
    method: &str,
    endpoint: &str,
    subscription_id: Option<&str>,
    delivery: Option<Delivery>,
) -> anyhow::Result<PushRequest> {
    anyhow::ensure!(
        ["GET", "POST", "DELETE"].contains(&method),
        "Invalid notification operation"
    );
    let mut url = url::Url::parse(endpoint)?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    anyhow::ensure!(
        (url.scheme() == "https" || url.scheme() == "http" && local)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use a secure notification service URL"
    );
    if let Some(id) = subscription_id {
        anyhow::ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "Invalid notification subscription"
        );
    }
    let path = format!(
        "{}/subscriptions{}",
        url.path().trim_end_matches('/'),
        subscription_id
            .map(|id| format!("/{id}"))
            .unwrap_or_default()
    );
    url.set_path(&path);
    let body = if method == "POST" {
        let delivery = delivery.ok_or_else(|| anyhow::anyhow!("Missing notification delivery"))?;
        anyhow::ensure!(
            !delivery.token.is_empty()
                && delivery.token.len() <= 4096
                && !delivery.token.chars().any(char::is_control),
            "Invalid notification token"
        );
        anyhow::ensure!(
            !delivery.filters.is_empty()
                && delivery.filters.len() <= 64
                && delivery.filters.iter().all(private_filter),
            "Invalid private notification filters"
        );
        let mut body = serde_json::json!({"webhooks":[],"web_push_subscriptions":[],"filter":delivery.filters[0],"filters":delivery.filters,"fcm_tokens":[],"apns_tokens":[]});
        match delivery.platform.as_str() {
            "android" => body["fcm_tokens"] = serde_json::json!([delivery.token]),
            "ios" => {
                let topic = delivery
                    .apns_topic
                    .ok_or_else(|| anyhow::anyhow!("Missing application topic"))?;
                anyhow::ensure!(
                    topic.len() <= 200
                        && !topic.is_empty()
                        && topic
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'),
                    "Invalid application topic"
                );
                body["apns_tokens"] = serde_json::json!([delivery.token]);
                body["apns_topic"] = serde_json::json!(topic);
                body["apns_environment"] = serde_json::json!(if delivery.production {
                    "production"
                } else {
                    "development"
                });
            }
            _ => anyhow::bail!("Unsupported notification platform"),
        }
        Some(serde_json::to_string(&body)?)
    } else {
        None
    };
    let mut builder = EventBuilder::new(Kind::from(27235), "")
        .tag(Tag::parse(["u", url.as_str()])?)
        .tag(Tag::parse(["method", method])?);
    if let Some(body) = &body {
        builder = builder.tag(Tag::parse([
            "payload",
            &format!("{:x}", Sha256::digest(body.as_bytes())),
        ])?);
    }
    let event = builder.sign_with_keys(&Keys::parse(registration_secret)?)?;
    Ok(PushRequest {
        method: method.into(),
        url: url.to_string(),
        authorization: format!("Nostr {}", STANDARD.encode(event.as_json())),
        body,
    })
}
