//! Feature-gated private wallet boundary; not part of MarketApp snapshots.
use super::{MarketError, error};
use iris_market_core::wallet::{self, Wallet};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

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
    inner: Arc<Wallet>,
    runtime: tokio::runtime::Runtime,
}
// Keep one service, runtime, and operation lock per native wallet. The service retains
// its exclusive filesystem lock against other processes until the last handle closes.
static OPEN_WALLETS: LazyLock<Mutex<HashMap<PathBuf, Weak<MarketWallet>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
        std::fs::create_dir_all(&path).map_err(error)?;
        let path = path.canonicalize().map_err(error)?;
        let mut wallets = OPEN_WALLETS
            .lock()
            .map_err(|_| error("Wallet registry is unavailable"))?;
        wallets.retain(|_, wallet| wallet.strong_count() > 0);
        if let Some(wallet) = wallets.get(&path).and_then(Weak::upgrade) {
            wallet.inner.verify_seed(&seed).map_err(error)?;
            return Ok(wallet);
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_stack_size(4 * 1024 * 1024)
            .enable_all()
            .build()
            .map_err(error)?;
        let inner = runtime
            .block_on(Wallet::open(&path, &seed))
            .map_err(error)?;
        let wallet = Arc::new(Self {
            owner_public_key,
            inner: Arc::new(inner),
            runtime,
        });
        wallets.insert(path, Arc::downgrade(&wallet));
        Ok(wallet)
    }
    /// Private wallet action. Never add the response or submitted payment data to app snapshots.
    pub fn escrow(&self, request: String) -> Result<String, MarketError> {
        // Native UI executors can have a 512 KiB stack. Poll CDK's swap on a wallet
        // worker, including retries of a previously reserved funding operation.
        let wallet = Arc::clone(&self.inner);
        let operation = self
            .runtime
            .spawn(async move { wallet.escrow(&request).await });
        self.runtime
            .block_on(operation)
            .map_err(error)?
            .map_err(error)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_native_handles_share_the_wallet_and_verify_its_seed() {
        let owner = nostr::Keys::generate().public_key().to_hex();
        let dir = std::env::temp_dir().join(format!("iris-market-wallet-handles-{owner}"));
        let base = dir.to_str().unwrap();
        let seed = wallet::generate_seed();
        let open =
            |seed: &str| MarketWallet::new(base.into(), owner.clone(), owner.clone(), seed.into());
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                barrier.wait();
                open(&seed).unwrap()
            });
            barrier.wait();
            let regular = open(&seed).unwrap();
            let escrow = worker.join().unwrap();
            assert!(Arc::ptr_eq(&regular, &escrow));
            assert!(open(&wallet::generate_seed()).is_err());
            let key = scope.spawn(move || {
                escrow
                    .escrow(serde_json::json!({"op":"key", "trade_id":"00".repeat(32)}).to_string())
            });
            regular.snapshot(true).unwrap();
            assert!(key.join().unwrap().is_ok());
        });
        drop(open(&seed).unwrap()); // The last handle releases the service's filesystem lock.
        std::fs::remove_dir_all(dir).unwrap();
    }
}
