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
pub struct Settings {
    pub relays: Vec<String>,
    pub ai: AiSettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            relays: vec!["wss://relay.damus.io".into(), "wss://nos.lol".into()],
            ai: AiSettings::default(),
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
    pub demo: bool,
    pub status: String,
    pub error: Option<String>,
    pub query: String,
    pub side: String,
    pub revision: u64,
    pub listings: Vec<Listing>,
    pub saved_count: usize,
    pub settings: Settings,
    pub conversations: Vec<Conversation>,
    pub invite: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    SetFilter {
        query: String,
        side: String,
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
