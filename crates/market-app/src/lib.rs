#[cfg(feature = "cashu-wallet")]
mod wallet;
use nostr::{JsonUtil, Keys, PublicKey};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MarketError {
    #[error("{reason}")]
    Operation { reason: String },
}
// Keep errors intentionally simple at the native boundary.
fn error(e: impl std::fmt::Display) -> MarketError {
    MarketError::Operation {
        reason: e.to_string(),
    }
}

#[uniffi::export]
pub fn generate_secret_key() -> String {
    iris_market_core::generate_secret_key()
}

#[derive(uniffi::Object)]
pub struct MarketApp {
    inner: iris_market_core::Market,
}
#[uniffi::export]
impl MarketApp {
    #[uniffi::constructor]
    pub fn new(data_dir: String, secret_key: String, demo: bool) -> Result<Arc<Self>, MarketError> {
        Ok(Arc::new(Self {
            inner: iris_market_core::Market::open(Path::new(&data_dir), &secret_key, demo)
                .map_err(error)?,
        }))
    }
    /// Caller must use this only for a newly generated key, with a persisted bootstrap intent.
    #[uniffi::constructor]
    pub fn fresh_profile(data_dir: String, secret_key: String) -> Result<Arc<Self>, MarketError> {
        Ok(Arc::new(Self {
            inner: iris_market_core::Market::open_fresh(Path::new(&data_dir), &secret_key)
                .map_err(error)?,
        }))
    }
    #[uniffi::constructor]
    pub fn with_identity(
        data_dir: String,
        owner_public_key: String,
        owner_secret: Option<String>,
        device_secret: String,
        authorization: Option<String>,
    ) -> Result<Arc<Self>, MarketError> {
        let owner = PublicKey::parse(&owner_public_key).map_err(error)?;
        let owner_keys = owner_secret
            .map(|secret| Keys::parse(&secret))
            .transpose()
            .map_err(error)?;
        let device_keys = Keys::parse(&device_secret).map_err(error)?;
        let authorization = authorization
            .map(nostr::Event::from_json)
            .transpose()
            .map_err(error)?;
        Ok(Arc::new(Self {
            inner: iris_market_core::Market::open_identity(
                Path::new(&data_dir),
                owner,
                owner_keys,
                device_keys,
                authorization,
                false,
            )
            .map_err(error)?,
        }))
    }
    pub fn snapshot(&self) -> Result<String, MarketError> {
        self.inner.snapshot().map_err(error)
    }
    #[uniffi::constructor]
    pub fn with_shared_private_store(
        data_dir: String,
        private_data_dir: String,
        owner_public_key: String,
        owner_secret: Option<String>,
        device_secret: String,
        authorization: Option<String>,
    ) -> Result<Arc<Self>, MarketError> {
        let owner = PublicKey::parse(&owner_public_key).map_err(error)?;
        let owner_keys = owner_secret
            .map(|s| Keys::parse(&s))
            .transpose()
            .map_err(error)?;
        let keys = Keys::parse(&device_secret).map_err(error)?;
        let authorization = authorization
            .map(nostr::Event::from_json)
            .transpose()
            .map_err(error)?;
        Ok(Arc::new(Self {
            inner: iris_market_core::Market::open_identity_private(
                Path::new(&data_dir),
                Path::new(&private_data_dir),
                owner,
                owner_keys,
                keys,
                authorization,
                false,
            )
            .map_err(error)?,
        }))
    }
    pub fn push_snapshot(&self) -> Result<String, MarketError> {
        self.inner.push_snapshot().map_err(error)
    }
    pub fn ingest_push_payload(&self, payload: String) -> Result<(), MarketError> {
        self.inner.ingest_push_payload(&payload).map_err(error)
    }
    pub fn command(&self, request: String) -> Result<String, MarketError> {
        self.inner.command(&request).map_err(error)
    }
    pub fn upload_media(
        &self,
        bytes: Vec<u8>,
        name: String,
        mime: String,
    ) -> Result<String, MarketError> {
        self.inner.upload_media(bytes, name, mime).map_err(error)
    }
    pub fn reviews(
        &self,
        target: String,
        product: bool,
        refresh: bool,
    ) -> Result<String, MarketError> {
        self.inner.reviews(target, product, refresh).map_err(error)
    }
    pub fn publish_review(
        &self,
        target: String,
        rating: u8,
        body: String,
    ) -> Result<String, MarketError> {
        self.inner
            .publish_review(target, rating, body)
            .map_err(error)
    }
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

/// Read-only detached preview; never opens the private store's writer.
#[uniffi::export]
pub fn push_event_id(payload: String) -> Option<String> {
    iris_market_core::mobile_push::payload_event(&payload).map(|event| event.id.to_hex())
}

#[uniffi::export]
pub fn resolve_push_preview(
    data_dir: String,
    owner_public_key: String,
    device_secret: String,
    payload: String,
) -> String {
    let resolution = match (
        PublicKey::parse(&owner_public_key),
        Keys::parse(&device_secret),
    ) {
        (Ok(owner), Ok(keys)) => iris_market_core::messaging::mobile_push::resolve(
            Path::new(&data_dir),
            owner,
            &keys,
            &payload,
        ),
        _ => iris_market_core::mobile_push::Resolution::default(),
    };
    serde_json::to_string(&resolution).unwrap_or_else(|_| "{\"show\":false}".into())
}

#[uniffi::export]
pub fn build_push_request(
    registration_secret: String,
    method: String,
    endpoint: String,
    subscription_id: Option<String>,
    delivery_json: Option<String>,
) -> Result<String, MarketError> {
    let delivery = delivery_json
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(error)?;
    let request = iris_market_core::mobile_push::build_request(
        &registration_secret,
        &method,
        &endpoint,
        subscription_id.as_deref(),
        delivery,
    )
    .map_err(error)?;
    serde_json::to_string(&request).map_err(error)
}

#[uniffi::export]
pub fn public_key_for_secret(secret: String) -> Result<String, MarketError> {
    iris_market_core::identity::public_key(&secret).map_err(error)
}

#[uniffi::export]
pub fn register_identity_device(
    owner_secret: String,
    device_secret: String,
    relays_json: String,
) -> Result<String, MarketError> {
    let relays: Vec<String> = serde_json::from_str(&relays_json).map_err(error)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(error)?;
    let event = runtime
        .block_on(iris_market_core::identity::register_device(
            &owner_secret,
            &device_secret,
            &relays,
        ))
        .map_err(error)?;
    Ok(event.as_json())
}

#[derive(uniffi::Object)]
pub struct MarketDeviceLink {
    inner: Mutex<iris_market_core::identity::DeviceLink>,
}
#[uniffi::export]
impl MarketDeviceLink {
    #[uniffi::constructor]
    pub fn new(
        device_secret: String,
        restored_bootstrap: Option<String>,
        approval_relay: String,
    ) -> Result<Arc<Self>, MarketError> {
        Ok(Arc::new(Self {
            inner: Mutex::new(
                iris_market_core::identity::DeviceLink::new(
                    &device_secret,
                    restored_bootstrap.as_deref(),
                    vec![approval_relay],
                )
                .map_err(error)?,
            ),
        }))
    }
    pub fn invitation(&self) -> Result<String, MarketError> {
        self.inner
            .lock()
            .map_err(error)?
            .invitation()
            .map_err(error)
    }
    pub fn bootstrap(&self) -> Result<String, MarketError> {
        self.inner.lock().map_err(error)?.bootstrap().map_err(error)
    }
    /// Imports the verified pairing under account_root/<owner>; returns only public account evidence.
    pub fn poll(&self, account_root: String) -> Result<Option<String>, MarketError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(error)?;
        runtime
            .block_on(
                self.inner
                    .lock()
                    .map_err(error)?
                    .poll(Path::new(&account_root)),
            )
            .map_err(error)
    }
}
