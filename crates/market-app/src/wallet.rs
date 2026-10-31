//! Feature-gated private wallet boundary; not part of MarketApp snapshots.
use super::{MarketError, error};
use iris_market_core::wallet::{self, Wallet};
use std::{path::Path, sync::Arc};

#[uniffi::export]
pub fn generate_wallet_seed() -> String {
    wallet::generate_seed()
}
#[uniffi::export]
pub fn wallet_has_data(
    base_dir: String,
    owner_public_key: String,
    device_public_key: String,
) -> Result<bool, MarketError> {
    let path =
        wallet::wallet_directory(Path::new(&base_dir), &owner_public_key, &device_public_key)
            .map_err(error)?;
    Ok(wallet::has_wallet_data(&path))
}
#[uniffi::export]
pub fn preview_cashu_token(token: String) -> Result<String, MarketError> {
    serde_json::to_string(&wallet::preview_token(&token).map_err(error)?).map_err(error)
}
/// These explicit private backup operations never participate in Market snapshots.
#[uniffi::export]
pub fn native_wallet_backup_seed(
    backup: String,
    password: String,
    expected_owner: String,
) -> Result<String, MarketError> {
    wallet::native_backup_seed(&backup, &password, &expected_owner).map_err(error)
}
#[uniffi::export]
pub fn restore_native_wallet_backup(
    base_dir: String,
    owner_public_key: String,
    device_public_key: String,
    backup: String,
    password: String,
    saved_seed: String,
) -> Result<(), MarketError> {
    let directory =
        wallet::wallet_directory(Path::new(&base_dir), &owner_public_key, &device_public_key)
            .map_err(error)?;
    wallet::restore_native_backup(
        &directory,
        &owner_public_key,
        &backup,
        &password,
        &saved_seed,
    )
    .map_err(error)
}
#[derive(uniffi::Object)]
pub struct MarketWallet {
    owner_public_key: String,
    inner: Wallet,
    runtime: tokio::runtime::Runtime,
}
#[uniffi::export]
impl MarketWallet {
    #[uniffi::constructor]
    pub fn new(
        base_dir: String,
        owner_public_key: String,
        device_public_key: String,
        seed: String,
    ) -> Result<Arc<Self>, MarketError> {
        let path =
            wallet::wallet_directory(Path::new(&base_dir), &owner_public_key, &device_public_key)
                .map_err(error)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(error)?;
        let inner = runtime
            .block_on(Wallet::open(&path, &seed))
            .map_err(error)?;
        Ok(Arc::new(Self {
            owner_public_key,
            inner,
            runtime,
        }))
    }
    pub fn snapshot(&self, refresh: bool) -> Result<String, MarketError> {
        let snapshot = self
            .runtime
            .block_on(self.inner.snapshot(refresh))
            .map_err(error)?;
        serde_json::to_string(&snapshot).map_err(error)
    }
    pub fn top_up(&self, mint: String, amount: u64) -> Result<String, MarketError> {
        let result = self
            .runtime
            .block_on(self.inner.top_up(&mint, amount))
            .map_err(error)?;
        serde_json::to_string(&result).map_err(error)
    }
    pub fn receive(&self, token: String, approved_mint: String) -> Result<String, MarketError> {
        let result = self
            .runtime
            .block_on(self.inner.receive(&token, &approved_mint))
            .map_err(error)?;
        serde_json::to_string(&result).map_err(error)
    }
    pub fn send(&self, mint: String, amount: u64) -> Result<String, MarketError> {
        let result = self
            .runtime
            .block_on(self.inner.send(&mint, amount))
            .map_err(error)?;
        serde_json::to_string(&result).map_err(error)
    }
    pub fn preview_send(
        &self,
        mint: String,
        amount: u64,
        request_id: String,
    ) -> Result<String, MarketError> {
        serde_json::to_string(
            &self
                .runtime
                .block_on(self.inner.preview_send(&mint, amount, &request_id))
                .map_err(error)?,
        )
        .map_err(error)
    }
    pub fn send_reviewed(
        &self,
        mint: String,
        amount: u64,
        max_fee: u64,
        request_id: String,
    ) -> Result<String, MarketError> {
        serde_json::to_string(
            &self
                .runtime
                .block_on(
                    self.inner
                        .send_reviewed(&mint, amount, max_fee, &request_id),
                )
                .map_err(error)?,
        )
        .map_err(error)
    }
    pub fn preview_lightning(&self, mint: String, invoice: String) -> Result<String, MarketError> {
        serde_json::to_string(
            &self
                .runtime
                .block_on(self.inner.preview_lightning(&mint, &invoice))
                .map_err(error)?,
        )
        .map_err(error)
    }
    pub fn pay_lightning(
        &self,
        mint: String,
        quote_id: String,
        max_fee: u64,
    ) -> Result<String, MarketError> {
        serde_json::to_string(
            &self
                .runtime
                .block_on(self.inner.pay_lightning(&mint, &quote_id, max_fee))
                .map_err(error)?,
        )
        .map_err(error)
    }
    pub fn export_backup(&self, password: String) -> Result<String, MarketError> {
        self.runtime
            .block_on(self.inner.export_backup(&self.owner_public_key, &password))
            .map_err(error)
    }
    pub fn pending_token(&self, operation_id: String) -> Result<String, MarketError> {
        let result = self
            .runtime
            .block_on(self.inner.pending_token(&operation_id))
            .map_err(error)?;
        serde_json::to_string(&result).map_err(error)
    }
    pub fn reclaim(&self, mint: String, operation_id: String) -> Result<u64, MarketError> {
        self.runtime
            .block_on(self.inner.reclaim(&mint, &operation_id))
            .map_err(error)
    }
}

#[uniffi::export]
pub fn lightning_invoice_qr(invoice: String) -> Result<String, MarketError> {
    serde_json::to_string(&wallet::lightning_invoice_qr(&invoice).map_err(error)?).map_err(error)
}
