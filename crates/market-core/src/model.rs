use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub title: String,
    pub description: String,
    pub side: String,
    #[serde(default)]
    pub price: String,
    #[serde(default = "eur")]
    pub currency: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
}
fn eur() -> String {
    "EUR".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relevance {
    pub show: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listing {
    pub id: String,
    pub author: String,
    pub title: String,
    pub description: String,
    pub side: String,
    pub price: String,
    pub currency: String,
    pub location: String,
    pub category: String,
    pub image_url: Option<String>,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub status: String,
    pub saved: bool,
    pub mine: bool,
    pub delivery: String,
    pub relevance: Option<Relevance>,
    #[serde(default)]
    pub coordinates: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub interests: String,
    pub curate_feed: bool,
}
impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "compatible".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            interests: String::new(),
            curate_feed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ImageProxySettings {
    pub enabled: bool,
    pub url: String,
}
impl Default for ImageProxySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            url: crate::image_proxy::DEFAULT_URL.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub relays: Vec<String>,
    pub ai: AiSettings,
    pub image_proxy: ImageProxySettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            relays: vec![
                "wss://relay.damus.io".into(),
                "wss://nos.lol".into(),
                "wss://relay.primal.net".into(),
            ],
            ai: AiSettings::default(),
            image_proxy: ImageProxySettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub text: String,
    pub mine: bool,
    pub created_at: u64,
    pub delivery: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub public_key: String,
    pub can_sign: bool,
    pub messaging_ready: bool,
    pub demo: bool,
    pub status: String,
    pub error: Option<String>,
    pub query: String,
    pub side: String,
    pub ai_search: bool,
    pub sort: String,
    pub people: std::collections::BTreeMap<String, crate::profiles::Person>,
    pub revision: u64,
    pub listings: Vec<Listing>,
    pub saved_count: usize,
    pub settings: Settings,
    pub conversations: Vec<Conversation>,
    pub invite: Option<String>,
    pub profile: Option<crate::profiles::Profile>,
    pub graph_context_loaded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    SetFilter {
        query: String,
        side: String,
        #[serde(default)]
        ai_search: bool,
    },
    SetSort {
        sort: String,
    },
    Save {
        id: String,
    },
    Publish {
        draft: Draft,
    },
    Close {
        id: String,
    },
    Refresh,
    LoadProfile {
        author: String,
    },
    LoadContext,
    SetSettings {
        settings: Settings,
    },
    Curate {
        #[serde(default)]
        api_key: String,
    },
    CheckAi {
        #[serde(default)]
        api_key: String,
    },
    Contact {
        author: String,
        listing_id: String,
    },
    CreateInvite,
    AcceptInvite {
        invite: String,
    },
    SendMessage {
        peer_id: String,
        text: String,
    },
}
