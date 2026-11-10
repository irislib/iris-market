//! The serialized client credential crosses this boundary only for native secure storage.
use super::{MarketApp, MarketError, error};
use iris_market_core::remote_signer::{Approval, RemoteSigner};
use nostr::JsonUtil;
use std::sync::Arc;

#[uniffi::export(callback_interface)]
pub trait SignerApproval: Send + Sync {
    fn show_approval(&self, url: String);
}

fn approval(observer: Box<dyn SignerApproval>) -> Approval {
    Arc::new(move |url| observer.show_approval(url))
}

#[derive(uniffi::Record)]
pub struct PairedMarketSigner {
    pub owner: String,
    pub credential: String,
}

#[derive(uniffi::Object)]
pub struct MarketSignerPairing {
    cancelled: tokio::sync::watch::Sender<bool>,
}

fn runtime() -> Result<tokio::runtime::Runtime, MarketError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(error)
}

#[uniffi::export]
impl MarketSignerPairing {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: tokio::sync::watch::channel(false).0,
        })
    }
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
    }
    pub fn pair(
        &self,
        connection: String,
        observer: Box<dyn SignerApproval>,
    ) -> Result<PairedMarketSigner, MarketError> {
        let mut cancelled = self.cancelled.subscribe();
        let approval = approval(observer);
        let signer=runtime()?.block_on(async {
            tokio::select! {
                _ = cancelled.wait_for(|value| *value) => Err(error("Signer request cancelled")),
                result = RemoteSigner::pair(&connection, &approval) => result.map_err(|_| error("Could not connect. Check the link and approve the request in your signer."))
            }
        })?;
        Ok(PairedMarketSigner {
            owner: signer.owner().to_hex(),
            credential: serde_json::to_string(&signer).map_err(error)?,
        })
    }
}

#[uniffi::export]
impl MarketApp {
    pub fn attach_remote_signer(
        &self,
        credential: String,
        observer: Box<dyn SignerApproval>,
    ) -> Result<(), MarketError> {
        let signer =
            serde_json::from_str(&credential).map_err(|_| error("Invalid signer session"))?;
        self.inner
            .attach_remote_signer(signer, approval(observer))
            .map_err(error)
    }
}

#[uniffi::export]
pub fn register_remote_identity_device(
    credential: String,
    device_secret: String,
    relays_json: String,
    observer: Box<dyn SignerApproval>,
) -> Result<String, MarketError> {
    let signer: RemoteSigner =
        serde_json::from_str(&credential).map_err(|_| error("Invalid signer session"))?;
    let relays: Vec<String> = serde_json::from_str(&relays_json).map_err(error)?;
    let approval = approval(observer);
    let event = runtime()?
        .block_on(iris_market_core::identity::register_with_signer(
            signer.owner(),
            &device_secret,
            &relays,
            async |draft| signer.sign(draft, &approval).await,
        ))
        .map_err(error)?;
    Ok(event.as_json())
}
