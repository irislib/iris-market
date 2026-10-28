//! Optional native Cashu adapter. Account snapshots never contain wallet state.
//! Platform callers own the independent 64-byte seed in secure storage, scoped
//! by owner and device. This module never derives money keys from Nostr keys.
use anyhow::{Context, Result, bail, ensure};
use cashu::{CurrencyUnit, Token};
use cashu_service::{CashuWalletSeedStore, CashuWalletService};
use nostr::PublicKey;
use rand::{RngCore, rngs::OsRng};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};
use zeroize::Zeroizing;

const MAX_TOKEN_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MINT: &str = "https://mint.coinos.io";

#[derive(Serialize)]
pub struct Balance {
    pub mint: String,
    pub unit: String,
    pub amount: u64,
}
#[derive(Serialize)]
pub struct Activity {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub mint: String,
    pub amount: u64,
    pub fee: Option<u64>,
    pub created_at: u64,
    pub operation_id: Option<String>,
}
#[derive(Serialize)]
pub struct WalletSnapshot {
    pub balances: Vec<Balance>,
    pub total_sats: u64,
    pub activity: Vec<Activity>,
    pub warning_count: usize,
}
#[derive(Serialize)]
pub struct TokenPreview {
    pub mint: String,
    pub amount: u64,
    pub unit: String,
}
#[derive(Serialize)]
pub struct TopUp {
    pub mint: String,
    pub amount: u64,
    pub invoice: String,
    pub expires_at: u64,
}
/// A private result of an explicit send action. Never include it in snapshots,
/// tracing, analytics or public Nostr events; only the user may share this token.
#[derive(Serialize)]
pub struct SentToken {
    pub mint: String,
    pub amount: u64,
    pub fee: u64,
    pub operation_id: String,
    pub token: String,
}

fn redact_activity(entry: cashu_service::CashuWalletActivityEntry) -> Activity {
    use cashu_service::{CashuWalletActivityKind as Kind, CashuWalletActivityStatus as Status};
    Activity {
        id: entry.id,
        kind: match entry.kind {
            Kind::TopUp => "top_up",
            Kind::LightningPayment => "lightning_payment",
            Kind::TokenSend => "token_send",
            Kind::TokenReceive => "token_receive",
            Kind::ChannelCollect => "channel_collect",
        }
        .into(),
        status: match entry.status {
            Status::Pending => "pending",
            Status::Complete => "complete",
            Status::Reclaimed => "reclaimed",
            Status::Expired => "expired",
        }
        .into(),
        mint: entry.mint_url,
        amount: entry.amount_sat,
        fee: entry.fee_sat,
        created_at: entry.created_at_unix,
        operation_id: entry.operation_id,
        // Never forward the service's token, invoice, quote ID or proofs.
    }
}

pub struct Wallet {
    service: CashuWalletService,
}
struct FixedSeedStore(Zeroizing<[u8; 64]>);
impl CashuWalletSeedStore for FixedSeedStore {
    fn load_seed(&self) -> Result<Option<[u8; 64]>> {
        Ok(Some(*self.0))
    }
    fn store_seed(&self, seed: &[u8; 64]) -> Result<()> {
        ensure!(
            seed == self.0.as_ref(),
            "Wallet recovery key does not match"
        );
        Ok(())
    }
}

pub fn wallet_directory(base: &Path, owner: &str, device: &str) -> Result<PathBuf> {
    let owner = PublicKey::parse(owner).context("Invalid wallet account")?;
    let device = PublicKey::parse(device).context("Invalid wallet device")?;
    Ok(base.join(owner.to_hex()).join(device.to_hex()))
}
/// Check before generating a seed. A missing secure seed for an existing wallet
/// must be a recovery error, never an opportunity to initialize over its funds.
pub fn has_wallet_data(directory: &Path) -> bool {
    cashu_service::cashu_wallet_database_exists(directory)
        || directory.join("cashu/seed-binding").exists()
}
pub fn generate_seed() -> String {
    let mut seed = Zeroizing::new([0u8; 64]);
    OsRng.fill_bytes(seed.as_mut());
    seed.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn parse_seed(encoded: &str) -> Result<Zeroizing<[u8; 64]>> {
    ensure!(
        encoded.len() == 128 && encoded.is_ascii(),
        "Wallet recovery key must contain exactly 64 bytes"
    );
    let mut seed = Zeroizing::new([0u8; 64]);
    for (index, byte) in seed.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16)
            .context("Invalid wallet recovery key")?;
    }
    Ok(seed)
}
fn bind_seed(directory: &Path, seed: &[u8; 64]) -> Result<()> {
    let folder = directory.join("cashu");
    fs::create_dir_all(&folder)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700))?;
    }
    let mut hash = Sha256::new();
    hash.update(b"iris-market/cashu-seed-binding/v1");
    hash.update(seed);
    let expected = format!("{:x}", hash.finalize());
    let path = folder.join("seed-binding");
    if path.exists() {
        ensure!(
            fs::read_to_string(&path)? == expected,
            "Wallet recovery key does not match this wallet"
        );
        return Ok(());
    }
    ensure!(
        !cashu_service::cashu_wallet_database_exists(directory),
        "Existing wallet needs recovery; its seed binding is missing"
    );
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(expected.as_bytes())?;
            file.sync_data()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                fs::read_to_string(&path)? == expected,
                "Wallet recovery key does not match this wallet"
            );
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
fn mint_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).context("Invalid mint address")?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "Use a secure mint address"
    );
    cashu_service::normalize_mint_url(value)
}
pub fn preview_token(encoded: &str) -> Result<TokenPreview> {
    ensure!(encoded.len() <= MAX_TOKEN_BYTES, "Ecash token is too large");
    let token = Token::from_str(encoded.trim()).context("Invalid ecash token")?;
    ensure!(
        token.unit().unwrap_or_default() == CurrencyUnit::Sat,
        "This wallet accepts sats"
    );
    Ok(TokenPreview {
        mint: mint_url(&token.mint_url()?.to_string())?,
        amount: token.value()?.to_u64(),
        unit: "sat".into(),
    })
}
impl Wallet {
    /// Seed was already saved/read back by Keychain or Keystore before this call.
    /// Opening alone does not recover quotes or contact a mint.
    pub async fn open(directory: &Path, encoded_seed: &str) -> Result<Self> {
        let seed = parse_seed(encoded_seed)?;
        bind_seed(directory, &seed)?;
        let service =
            CashuWalletService::open_with_seed_store(directory, Arc::new(FixedSeedStore(seed)))
                .await?;
        Ok(Self { service })
    }
    pub async fn snapshot(&self, refresh: bool) -> Result<WalletSnapshot> {
        // A refresh is an explicit Wallet action. CDK retains and recovers its
        // own durable operations; no separate generic Market outbox is used.
        let recovery_warnings = if refresh {
            self.service.recover_startup_state().await.warnings.len()
        } else {
            0
        };
        let overview = self.service.load_wallet_overview(false).await?;
        let activity = self
            .service
            .load_wallet_activity()
            .await?
            .into_iter()
            .map(redact_activity)
            .collect();
        Ok(WalletSnapshot {
            total_sats: overview
                .totals
                .iter()
                .filter(|total| total.unit == "sat")
                .try_fold(0u64, |sum, total| sum.checked_add(total.balance))
                .context("Wallet balance is too large")?,
            balances: overview
                .entries
                .into_iter()
                .map(|entry| Balance {
                    mint: entry.mint_url,
                    unit: entry.unit,
                    amount: entry.balance,
                })
                .collect(),
            activity,
            warning_count: overview.warnings.len() + recovery_warnings,
        })
    }
    pub async fn top_up(&self, mint: &str, amount: u64) -> Result<TopUp> {
        ensure!(amount > 0, "Enter an amount");
        let quote = self
            .service
            .create_topup_quote(&mint_url(mint)?, amount)
            .await?;
        Ok(TopUp {
            mint: quote.mint_url,
            amount: quote.amount,
            invoice: quote.payment_request,
            expires_at: quote.expiry_unix,
        })
    }
    pub async fn receive(&self, encoded: &str, approved_mint: &str) -> Result<TokenPreview> {
        let preview = preview_token(encoded)?;
        ensure!(
            preview.mint == mint_url(approved_mint)?,
            "Confirm the mint before receiving this token"
        );
        let received = self.service.receive_payment_token(encoded.trim()).await?;
        Ok(TokenPreview {
            mint: received.mint_url,
            amount: received.amount_sat,
            unit: received.unit,
        })
    }
    pub async fn send(&self, mint: &str, amount: u64) -> Result<SentToken> {
        ensure!(amount > 0, "Enter an amount");
        let payment = self
            .service
            .send_payment_token(&mint_url(mint)?, amount)
            .await?;
        Ok(SentToken {
            mint: payment.mint_url,
            amount: payment.amount_sat,
            fee: payment.send_fee_sat,
            operation_id: payment.operation_id,
            token: payment.token,
        })
    }
    /// Pending bearer tokens remain recoverable after closing the share screen.
    /// This explicit private action is separate from the redacted history view.
    pub async fn pending_token(&self, operation_id: &str) -> Result<SentToken> {
        let entries = self.service.load_wallet_activity().await?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.operation_id.as_deref() == Some(operation_id))
            .context("Payment is unavailable")?;
        ensure!(
            entry.status == cashu_service::CashuWalletActivityStatus::Pending,
            "Payment is no longer pending"
        );
        let Some(token) = entry.token else {
            bail!("Payment token is unavailable");
        };
        Ok(SentToken {
            mint: entry.mint_url,
            amount: entry.amount_sat,
            fee: entry.fee_sat.unwrap_or_default(),
            operation_id: operation_id.into(),
            token,
        })
    }
    pub async fn reclaim(&self, mint: &str, operation_id: &str) -> Result<u64> {
        self.service
            .revoke_pending_payment(&mint_url(mint)?, operation_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_wallet_seed_binding_and_writer_lock_fail_closed() {
        let dir = tempfile::TempDir::new().unwrap();
        let seed = generate_seed();
        assert!(!has_wallet_data(dir.path()));
        let wallet = Wallet::open(dir.path(), &seed).await.unwrap();
        assert!(has_wallet_data(dir.path()));
        assert_eq!(wallet.snapshot(false).await.unwrap().total_sats, 0);
        assert!(Wallet::open(dir.path(), &generate_seed()).await.is_err());
        assert!(Wallet::open(dir.path(), &seed).await.is_err());
        drop(wallet);
        assert!(Wallet::open(dir.path(), &seed).await.is_ok());
    }
    #[test]
    fn snapshot_schema_contains_no_bearer_material() {
        let activity = cashu_service::CashuWalletActivityEntry {
            id: "entry".into(),
            kind: cashu_service::CashuWalletActivityKind::TokenSend,
            status: cashu_service::CashuWalletActivityStatus::Pending,
            mint_url: DEFAULT_MINT.into(),
            unit: "sat".into(),
            amount_sat: 1,
            fee_sat: None,
            created_at_unix: 0,
            expires_at_unix: None,
            operation_id: Some("operation".into()),
            quote_id: Some("private-quote".into()),
            payment_request: Some("private-invoice".into()),
            token: Some("private-bearer-token".into()),
        };
        let value = serde_json::to_string(&redact_activity(activity)).unwrap();
        for secret in ["private-quote", "private-invoice", "private-bearer-token"] {
            assert!(!value.contains(secret));
        }
        assert!(mint_url("http://mint.example").is_err());
        assert!(mint_url("https://secret@mint.example").is_err());
    }
}
