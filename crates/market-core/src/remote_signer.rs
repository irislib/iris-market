//! NIP-46 requests use an isolated relay client. The account credential is saved
//! only by the native secure store. RPC handling follows Iris Chat (MIT).
use anyhow::{Context, Result, ensure};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, Filter, JsonUtil, Keys, Kind, PublicKey, Tag, UnsignedEvent};
use nostr_sdk::{Client, RelayPoolNotification};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use url::Url;

const SIGNED_KINDS: [u16; 7] = [0, 7368, 24242, 30402, 30405, 37368, 38383];

pub type Approval = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteSigner {
    server: PublicKey,
    relays: Vec<String>,
    client_key: String,
    owner: PublicKey,
}

struct Channel {
    server: PublicKey,
    relays: Vec<String>,
    keys: Keys,
}

impl Channel {
    async fn request(
        &self,
        method: &str,
        params: Vec<String>,
        approval: &Approval,
    ) -> Result<String> {
        let client = Client::default();
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            for relay in &self.relays {
                client.add_relay(relay).await?;
            }
            client.connect().await;
            client.wait_for_connection(Duration::from_secs(5)).await;
            let mut notifications = client.notifications();
            let filter = Filter::new()
                .kind(Kind::NostrConnect)
                .author(self.server)
                .pubkey(self.keys.public_key())
                .limit(0);
            let subscribed = client.subscribe(filter, None).await?;
            ensure!(!subscribed.success.is_empty(), "Could not reach the signer");
            let id = uuid::Uuid::new_v4().to_string();
            let content = nip44::encrypt(
                self.keys.secret_key(),
                &self.server,
                json!({"id":id, "method":method, "params":params}).to_string(),
                nip44::Version::V2,
            )?;
            let event = EventBuilder::new(Kind::NostrConnect, content)
                .tag(Tag::public_key(self.server))
                .sign_with_keys(&self.keys)?;
            // A slow second relay must not keep a fast signer's reply waiting.
            let mut sends = tokio::task::JoinSet::new();
            for relay in client.relays().await.into_values() {
                let event = event.clone();
                sends.spawn(async move { relay.send_event(&event).await.is_ok() });
            }
            let mut accepted = false;
            while let Some(result) = sends.join_next().await {
                if matches!(result, Ok(true)) {
                    accepted = true;
                    break;
                }
            }
            ensure!(accepted, "Could not reach the signer");
            loop {
                let RelayPoolNotification::Event { event, .. } = notifications.recv().await? else {
                    continue;
                };
                if event.pubkey != self.server
                    || event.kind != Kind::NostrConnect
                    || event.content.len() > 128_000
                    || !event
                        .tags
                        .public_keys()
                        .any(|pk| *pk == self.keys.public_key())
                    || event.verify().is_err()
                {
                    continue;
                }
                let Ok(clear) =
                    nip44::decrypt(self.keys.secret_key(), &self.server, &event.content)
                else {
                    continue;
                };
                let Ok(reply) = serde_json::from_str::<serde_json::Value>(&clear) else {
                    continue;
                };
                if reply.get("method").is_some() || reply["id"].as_str() != Some(&id) {
                    continue;
                }
                if reply["result"].as_str() == Some("auth_url") {
                    let url = Url::parse(reply["error"].as_str().unwrap_or_default())?;
                    ensure!(
                        url.scheme() == "https"
                            && url.host().is_some()
                            && url.username().is_empty()
                            && url.password().is_none(),
                        "Invalid approval link"
                    );
                    approval(url.to_string());
                    continue;
                }
                ensure!(
                    reply["error"].as_str().unwrap_or_default().is_empty(),
                    "Signer declined the request"
                );
                return reply["result"]
                    .as_str()
                    .map(String::from)
                    .context("Invalid signer reply");
            }
        })
        .await;
        client.shutdown().await;
        result.context("The signer did not respond. Open it and try again.")?
    }
}

impl RemoteSigner {
    pub async fn pair(input: &str, approval: &Approval) -> Result<Self> {
        let url = Url::parse(input.trim()).context("Paste a bunker:// link from your signer")?;
        ensure!(
            input.len() <= 8192
                && url.scheme() == "bunker"
                && url.path().is_empty()
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
                && url.fragment().is_none(),
            "Invalid signer link"
        );
        let server = PublicKey::from_hex(url.host_str().unwrap_or_default())
            .context("Invalid signer link")?;
        let relays = url
            .query_pairs()
            .filter(|(name, _)| name == "relay")
            .map(|(_, v)| v.into_owned())
            .collect::<Vec<_>>();
        validate_relays(&relays)?;
        let secrets = url
            .query_pairs()
            .filter(|(name, _)| name == "secret")
            .map(|(_, v)| v.into_owned())
            .collect::<Vec<_>>();
        ensure!(secrets.len() <= 1, "Invalid signer link");
        let secret = secrets.into_iter().next().unwrap_or_default();
        let mut channel = Channel {
            server,
            relays,
            keys: Keys::generate(),
        };
        let confirmation = channel
            .request(
                "connect",
                vec![
                    server.to_hex(),
                    secret.clone(),
                    SIGNED_KINDS
                        .iter()
                        .map(|kind| format!("sign_event:{kind}"))
                        .collect::<Vec<_>>()
                        .join(","),
                    json!({"name":"Iris Market","url":"https://market.iris.to"}).to_string(),
                ],
                approval,
            )
            .await?;
        ensure!(
            confirmation == "ack" || (!secret.is_empty() && confirmation == secret),
            "Invalid signer confirmation"
        );
        // A signer may move this client from public pairing relays to private relays.
        // Older signers may ignore the optional request.
        if let Ok(Ok(value)) = tokio::time::timeout(
            Duration::from_secs(3),
            channel.request("switch_relays", vec![], approval),
        )
        .await
            && value != "null"
        {
            let next: Vec<String> =
                serde_json::from_str(&value).context("Invalid signer relay list")?;
            validate_relays(&next)?;
            channel.relays = next;
        }
        let owner =
            PublicKey::from_hex(&channel.request("get_public_key", vec![], approval).await?)
                .context("Invalid profile from signer")?;
        Ok(Self {
            server,
            relays: channel.relays,
            client_key: channel.keys.secret_key().to_secret_hex(),
            owner,
        })
    }
    pub fn owner(&self) -> PublicKey {
        self.owner
    }
    pub async fn sign(&self, mut draft: UnsignedEvent, approval: &Approval) -> Result<Event> {
        ensure!(
            draft.pubkey == self.owner,
            "Signer does not match this profile"
        );
        ensure!(
            SIGNED_KINDS.contains(&draft.kind.as_u16()),
            "This action cannot use the Market signer"
        );
        validate_relays(&self.relays)?;
        let channel = Channel {
            server: self.server,
            relays: self.relays.clone(),
            keys: Keys::parse(&self.client_key)?,
        };
        let expected = draft.id();
        let raw = channel
            .request("sign_event", vec![draft.as_json()], approval)
            .await?;
        let event = Event::from_json(raw)?;
        ensure!(
            event.pubkey == self.owner && event.id == expected && event.verify().is_ok(),
            "Signer returned a different event"
        );
        Ok(event)
    }
}

fn validate_relays(relays: &[String]) -> Result<()> {
    ensure!(
        !relays.is_empty() && relays.len() <= 8,
        "Invalid signer relays"
    );
    for relay in relays {
        let url = Url::parse(relay)?;
        ensure!(
            matches!(url.scheme(), "wss" | "ws")
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "Invalid signer relay"
        );
    }
    Ok(())
}
