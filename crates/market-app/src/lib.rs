use std::{path::Path, sync::Arc};

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
    pub fn snapshot(&self) -> Result<String, MarketError> {
        self.inner.snapshot().map_err(error)
    }
    pub fn command(&self, request: String) -> Result<String, MarketError> {
        self.inner.command(&request).map_err(error)
    }
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}
