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
    pub tags: Vec<String>,
    #[serde(
        default,
        alias = "serviceAreas",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_areas: Option<crate::service_area::ServiceAreas>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_price: Option<crate::rates::DisplayPrice>,
    pub location: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_areas: Option<crate::service_area::ServiceAreas>,
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
    pub currency: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            relays: vec![
                "wss://temp.iris.to".into(),
                "wss://vault.iris.to".into(),
                "wss://relay.damus.io".into(),
                "wss://relay.snort.social".into(),
                "wss://relay.primal.net".into(),
                "wss://nos.lol".into(),
            ],
            ai: AiSettings::default(),
            image_proxy: ImageProxySettings::default(),
            currency: eur(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<crate::conversation_context::MessageContext>,
    pub id: String,
    pub text: String,
    pub mine: bool,
    pub created_at: u64,
    pub delivery: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cashu: Option<crate::messaging::CashuPayment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub search_discovery: crate::search_discovery::Status,
    pub search_generation: u64,
    pub search_plan_tags: Vec<String>,
    pub search_plan_pending: bool,
    pub exchange_rates: crate::rates::RateSnapshot,
    pub local_curation: Option<crate::local_ai::Batch>,
    pub public_key: String,
    pub can_sign: bool,
    pub ai_configured: bool,
    pub profile_name_required: bool,
    pub messaging_ready: bool,
    pub live_location_supported: bool,
    pub demo: bool,
    pub status: String,
    pub error: Option<String>,
    pub ai_message: Option<String>,
    pub ai_test_result: Option<crate::ai::TestResult>,
    pub query: String,
    pub side: String,
    pub ai_search: bool,
    pub sort: String,
    pub people: std::collections::BTreeMap<String, crate::profiles::Person>,
    pub revision: u64,
    pub listings: Vec<Listing>,
    pub saved_count: usize,
    pub saved_listings: Vec<Listing>,
    pub settings: Settings,
    pub conversations: Vec<Conversation>,
    pub orders: Vec<crate::orders::OrderView>,
    pub invite: Option<String>,
    pub profile: Option<crate::profiles::Profile>,
    pub profile_listings: Option<crate::profile_listings::Page>,
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
    LoadProfileFollowers {
        author: String,
    },
    CancelProfileFollowers {
        author: String,
    },
    UpdateProfile {
        name: String,
    },
    LoadMoreProfileListings {
        author: String,
    },
    CloseProfile {
        author: String,
    },
    SetSettings {
        settings: Settings,
    },
    BeginLocalCuration,
    ContinueSearch,
    CancelSearch,
    ApplySearchPlan {
        generation: u64,
        terms: Vec<String>,
    },
    ApplyLocalCuration {
        id: String,
        decisions: Vec<crate::local_ai::Decision>,
        #[serde(default)]
        partial: bool,
    },
    CancelLocalCuration {
        id: String,
    },
    Curate {
        #[serde(default)]
        api_key: String,
    },
    CheckAi {
        #[serde(default)]
        api_key: String,
        #[serde(default)]
        test: Option<crate::ai::TestInput>,
        #[serde(default)]
        expected: Option<crate::ai::TestProvider>,
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        clear: bool,
    },
    Contact {
        author: String,
        #[serde(default)]
        listing_id: Option<String>,
    },
    CreateInvite,
    AcceptInvite {
        invite: String,
    },
    MarkMessagesRead {
        message_ids: Vec<String>,
    },
    SetPushEnabled { enabled: bool },
    MarkNotificationsPresented { event_ids: Vec<String> },
    SendMessage {
        peer_id: String,
        text: String,
        #[serde(default)]
        context: Option<crate::conversation_context::MessageContext>,
    },
    RequestOrder {
        listing_id: String,
        #[serde(default = "one")]
        quantity: u16,
        #[serde(default)]
        note: String,
    },
    UpdateOrder {
        order_id: String,
        patch: serde_json::Value,
    },
    ArchiveOrder {
        order_id: String,
        archived: bool,
    },
}
fn one() -> u16 {
    1
}
