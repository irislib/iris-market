use crate::{MarketError, error};
use std::sync::Arc;
#[cfg(not(target_os = "ios"))]
use std::{path::PathBuf, sync::Mutex};

/// Separate from MarketApp: updates work without a profile or private-store lock.
#[derive(uniffi::Object)]
pub struct MarketUpdater {
    #[cfg(not(target_os = "ios"))]
    inner: Mutex<iris_market_core::updater::Updater>,
    #[cfg(not(target_os = "ios"))]
    progress: Arc<iris_market_core::updater::Progress>,
}

#[uniffi::export]
impl MarketUpdater {
    #[uniffi::constructor]
    pub fn new(data_dir: String, current_version: String) -> Arc<Self> {
        #[cfg(target_os = "ios")]
        {
            let _ = (data_dir, current_version);
            Arc::new(Self {})
        }
        #[cfg(not(target_os = "ios"))]
        {
            let updater = iris_market_core::updater::Updater::new(
                PathBuf::from(data_dir),
                current_version,
                true,
            );
            Arc::new(Self {
                progress: updater.progress(),
                inner: Mutex::new(updater),
            })
        }
    }

    pub fn check(&self) -> Result<String, MarketError> {
        #[cfg(not(target_os = "ios"))]
        {
            serde_json::to_string(&self.inner.lock().map_err(error)?.check().map_err(error)?)
                .map_err(error)
        }
        #[cfg(target_os = "ios")]
        {
            Err(error("Updates are managed by TestFlight or the App Store"))
        }
    }

    /// Checks first when no release is held, then downloads it. Poll
    /// `progress` from another thread meanwhile.
    pub fn download(&self, directory: String) -> Result<String, MarketError> {
        #[cfg(not(target_os = "ios"))]
        {
            serde_json::to_string(
                &self
                    .inner
                    .lock()
                    .map_err(error)?
                    .download(&PathBuf::from(directory))
                    .map_err(error)?,
            )
            .map_err(error)
        }
        #[cfg(target_os = "ios")]
        {
            let _ = directory;
            Err(error("Updates are managed by TestFlight or the App Store"))
        }
    }

    /// `{"stage":"downloading","downloaded":1024,"total":4096}`; never waits.
    pub fn progress(&self) -> String {
        #[cfg(not(target_os = "ios"))]
        {
            serde_json::to_string(&self.progress.snapshot()).unwrap_or_default()
        }
        #[cfg(target_os = "ios")]
        {
            r#"{"stage":"idle","downloaded":0,"total":null}"#.into()
        }
    }
}
