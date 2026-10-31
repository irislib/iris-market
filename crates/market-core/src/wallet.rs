//! Optional native Cashu adapter. Account snapshots never contain wallet state.
//! Platform callers own the independent 64-byte seed in secure storage, scoped
//! by owner and device. This module never derives money keys from Nostr keys.
use anyhow::{Context, Result, bail, ensure};
use cashu::{CurrencyUnit, Token};
use cashu_service::{CashuWalletSeedStore, CashuWalletService};
use nostr::PublicKey;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
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
pub const TEST_MINT: &str = "https://testnut.cashu.space";
fn test_mint(mint: &str) -> bool {
    mint.trim_end_matches('/') == TEST_MINT || mint.starts_with("http://127.0.0.1:")
}

#[derive(Serialize)]
pub struct Balance {
    pub mint: String,
    pub test_only: bool,
    pub unit: String,
    pub amount: u64,
}
#[derive(Serialize)]
pub struct Activity {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub mint: String,
    pub test_only: bool,
    pub amount: u64,
    pub fee: Option<u64>,
    pub created_at: u64,
    pub operation_id: Option<String>,
}
#[derive(Serialize)]
pub struct WalletSnapshot {
    pub balances: Vec<Balance>,
    pub total_sats: u64,
    pub test_sats: u64,
    pub activity: Vec<Activity>,
    pub warning_count: usize,
    pub review_required: bool,
}
#[derive(Serialize)]
pub struct TokenPreview {
    pub mint: String,
    pub test_only: bool,
    pub amount: u64,
    pub unit: String,
}
#[derive(Serialize)]
pub struct TopUp {
    pub mint: String,
    pub test_only: bool,
    pub amount: u64,
    pub invoice: String,
    pub expires_at: u64,
}
/// A private result of an explicit send action. Never include it in snapshots,
/// tracing, analytics or public Nostr events; only the user may share this token.
#[derive(Serialize)]
pub struct SentToken {
    pub mint: String,
    pub test_only: bool,
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
        test_only: test_mint(&entry.mint_url),
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
    developer_mint: Option<String>,
    seed: Zeroizing<[u8; 64]>,
}
struct FixedSeedStore(Zeroizing<[u8; 64]>);
impl CashuWalletSeedStore for FixedSeedStore {
    fn load_seed(&self) -> Result<Option<[u8; 64]>> {
        Ok(Some(*self.0))
    }
    fn store_seed(&self, seed: &[u8; 64]) -> Result<()> {
        ensure!(seed == &*self.0, "Wallet recovery key does not match");
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
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use a secure mint address"
    );
    cashu_service::normalize_mint_url(value)
}
fn normalize_mint(value: &str, developer_mint: Option<&str>) -> Result<String> {
    if developer_mint == Some(value) {
        let url = url::Url::parse(value)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none(),
            "Invalid local test mint"
        );
        return Ok(value.trim_end_matches('/').into());
    }
    mint_url(value)
}
pub fn preview_token(encoded: &str) -> Result<TokenPreview> {
    preview_token_with_mint(encoded, None)
}
fn preview_token_with_mint(encoded: &str, developer_mint: Option<&str>) -> Result<TokenPreview> {
    ensure!(encoded.len() <= MAX_TOKEN_BYTES, "Ecash token is too large");
    let token = Token::from_str(normalize_token(encoded)).context("Invalid ecash token")?;
    ensure!(
        token
            .token_secrets()
            .iter()
            .all(|secret| !secret.to_string().trim_start().starts_with('[')),
        "Locked ecash spending conditions are not supported by this wallet"
    );
    ensure!(
        token.unit().unwrap_or_default() == CurrencyUnit::Sat,
        "This wallet accepts sats"
    );
    Ok(TokenPreview {
        test_only: test_mint(&token.mint_url()?.to_string()),
        mint: normalize_mint(&token.mint_url()?.to_string(), developer_mint)?,
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
        let backup_seed = Zeroizing::new(*seed);
        let service =
            CashuWalletService::open_with_seed_store(directory, Arc::new(FixedSeedStore(seed)))
                .await?;
        Ok(Self {
            service,
            developer_mint: None,
            seed: backup_seed,
        })
    }
    pub async fn snapshot(&self, refresh: bool) -> Result<WalletSnapshot> {
        // A refresh is an explicit Wallet action. CDK retains and recovers its
        // own durable operations; no separate generic Market outbox is used.
        if refresh {
            self.service.review_restored_wallet().await?;
        }
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
                .entries
                .iter()
                .filter(|entry| entry.unit == "sat" && !test_mint(&entry.mint_url))
                .try_fold(0u64, |sum, entry| sum.checked_add(entry.balance))
                .context("Wallet balance is too large")?,
            test_sats: overview
                .entries
                .iter()
                .filter(|entry| entry.unit == "sat" && test_mint(&entry.mint_url))
                .try_fold(0u64, |sum, entry| sum.checked_add(entry.balance))
                .context("Test wallet balance is too large")?,
            balances: overview
                .entries
                .into_iter()
                .map(|entry| Balance {
                    test_only: test_mint(&entry.mint_url),
                    mint: entry.mint_url,
                    unit: entry.unit,
                    amount: entry.balance,
                })
                .collect(),
            activity,
            warning_count: overview.warnings.len() + recovery_warnings,
            review_required: self.service.restored_review_required(),
        })
    }
    pub async fn top_up(&self, mint: &str, amount: u64) -> Result<TopUp> {
        ensure!(amount > 0, "Enter an amount");
        let quote = self
            .service
            .create_topup_quote(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                amount,
            )
            .await?;
        Ok(TopUp {
            test_only: test_mint(&quote.mint_url),
            mint: quote.mint_url,
            amount: quote.amount,
            invoice: quote.payment_request,
            expires_at: quote.expiry_unix,
        })
    }
    pub async fn receive(&self, encoded: &str, approved_mint: &str) -> Result<TokenPreview> {
        let preview = preview_token_with_mint(encoded, self.developer_mint.as_deref())?;
        ensure!(
            preview.mint == normalize_mint(approved_mint, self.developer_mint.as_deref())?,
            "Confirm the mint before receiving this token"
        );
        let received = self
            .service
            .receive_payment_token(normalize_token(encoded))
            .await?;
        Ok(TokenPreview {
            test_only: test_mint(&received.mint_url),
            mint: received.mint_url,
            amount: received.amount_sat,
            unit: received.unit,
        })
    }
    pub async fn send(&self, mint: &str, amount: u64) -> Result<SentToken> {
        ensure!(amount > 0, "Enter an amount");
        let payment = self
            .service
            .send_payment_token(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                amount,
            )
            .await?;
        Ok(SentToken {
            test_only: test_mint(&payment.mint_url),
            mint: payment.mint_url,
            amount: payment.amount_sat,
            fee: payment.send_fee_sat,
            operation_id: payment.operation_id,
            token: payment.token,
        })
    }
    pub async fn preview_send(
        &self,
        mint: &str,
        amount: u64,
        request_id: &str,
    ) -> Result<cashu_service::CashuSendReview> {
        self.service
            .preview_payment_token_reviewed(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                amount,
                request_id,
            )
            .await
    }
    pub async fn send_reviewed(
        &self,
        mint: &str,
        amount: u64,
        max_fee: u64,
        request_id: &str,
    ) -> Result<SentToken> {
        let payment = self
            .service
            .send_payment_token_reviewed(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                amount,
                max_fee,
                request_id,
            )
            .await?;
        Ok(SentToken {
            test_only: test_mint(&payment.mint_url),
            mint: payment.mint_url,
            amount: payment.amount_sat,
            fee: payment.send_fee_sat,
            operation_id: payment.operation_id,
            token: payment.token,
        })
    }
    pub async fn preview_lightning(
        &self,
        mint: &str,
        invoice: &str,
    ) -> Result<cashu_service::CashuLightningReview> {
        ensure!(
            !test_mint(mint) || self.developer_mint.as_deref() == Some(mint),
            "Test invoices must not be paid with real Lightning funds"
        );
        self.service
            .preview_lightning_payment_reviewed(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                invoice,
            )
            .await
    }
    pub async fn pay_lightning(
        &self,
        mint: &str,
        quote_id: &str,
        max_fee: u64,
    ) -> Result<cashu_service::CashuLightningResult> {
        ensure!(
            !test_mint(mint) || self.developer_mint.as_deref() == Some(mint),
            "Test invoices cannot be paid as real Lightning payments"
        );
        self.service
            .confirm_lightning_payment_reviewed(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                quote_id,
                max_fee,
            )
            .await
    }
    pub async fn export_backup(&self, owner: &str, password: &str) -> Result<String> {
        let database = self.service.export_wallet_database().await?;
        encrypt_native_backup(owner, &self.seed, &database, password)
    }
    /// Pending bearer tokens remain recoverable after closing the share screen.
    /// This explicit private action is separate from the redacted history view.
    pub async fn pending_token(&self, operation_id: &str) -> Result<SentToken> {
        ensure!(
            !self
                .service
                .payment_token_is_reclaiming(operation_id)
                .await?,
            "This payment is reclaiming or reclaimed"
        );
        ensure!(
            !self.service.restored_review_required(),
            "Refresh the restored wallet before sharing a saved token"
        );
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
            test_only: test_mint(&entry.mint_url),
            mint: entry.mint_url,
            amount: entry.amount_sat,
            fee: entry.fee_sat.unwrap_or_default(),
            operation_id: operation_id.into(),
            token,
        })
    }
    pub async fn reclaim(&self, mint: &str, operation_id: &str) -> Result<u64> {
        self.service
            .revoke_pending_payment(
                &normalize_mint(mint, self.developer_mint.as_deref())?,
                operation_id,
            )
            .await
    }
}

const BACKUP_SCHEMA: &str = "iris-market-native-cashu-v1";
const BACKUP_ROUNDS: u32 = 600_000;
const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct BackupEnvelope {
    schema: String,
    rounds: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Serialize, Deserialize)]
struct BackupPayload {
    owner: String,
    seed: String,
    database: String,
}
impl Drop for BackupPayload {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.seed.zeroize();
        self.database.zeroize();
    }
}
fn backup_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    ensure!(
        password.len() >= 12 && password.len() <= 1024,
        "Use a backup password between 12 and 1024 bytes"
    );
    pbkdf2_backup_key(password, salt, BACKUP_ROUNDS)
}
fn pbkdf2_backup_key(password: &str, salt: &[u8], rounds: u32) -> Result<Zeroizing<[u8; 32]>> {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(password.as_bytes())
        .map_err(|_| anyhow::anyhow!("Invalid backup password"))?;
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut block = Zeroizing::new(<[u8; 32]>::from(mac.finalize().into_bytes()));
    let mut key = Zeroizing::new(*block);
    for _ in 1..rounds {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(password.as_bytes())
            .map_err(|_| anyhow::anyhow!("Invalid backup password"))?;
        mac.update(block.as_ref());
        *block = mac.finalize().into_bytes().into();
        for (value, byte) in key.iter_mut().zip(block.iter()) {
            *value ^= *byte;
        }
    }
    Ok(key)
}
fn encrypt_native_backup(
    owner: &str,
    seed: &[u8; 64],
    database: &[u8],
    password: &str,
) -> Result<String> {
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use chacha20poly1305::{
        XChaCha20Poly1305, XNonce,
        aead::{Aead, KeyInit, Payload},
    };
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = backup_key(password, &salt)?;
    let seed: String = seed.iter().map(|b| format!("{b:02x}")).collect();
    let owner = PublicKey::parse(owner)
        .context("Invalid backup profile")?
        .to_hex();
    let payload = Zeroizing::new(serde_json::to_vec(&BackupPayload {
        owner,
        seed,
        database: B64.encode(database),
    })?);
    ensure!(
        payload.len() <= MAX_BACKUP_BYTES,
        "Wallet backup is too large"
    );
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| anyhow::anyhow!("Could not encrypt backup"))?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &payload,
                aad: BACKUP_SCHEMA.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Could not encrypt backup"))?;
    Ok(serde_json::to_string(&BackupEnvelope {
        schema: BACKUP_SCHEMA.into(),
        rounds: BACKUP_ROUNDS,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })?)
}
type DecryptedNativeBackup = (Zeroizing<[u8; 64]>, Zeroizing<Vec<u8>>);

fn decrypt_native_backup(
    backup: &str,
    password: &str,
    expected_owner: &str,
) -> Result<DecryptedNativeBackup> {
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use chacha20poly1305::{
        XChaCha20Poly1305, XNonce,
        aead::{Aead, KeyInit, Payload},
    };
    ensure!(
        backup.len() <= MAX_BACKUP_BYTES,
        "Wallet backup is too large"
    );
    let value: BackupEnvelope =
        serde_json::from_str(backup).context("Invalid native wallet backup")?;
    ensure!(
        value.schema == BACKUP_SCHEMA && value.rounds == BACKUP_ROUNDS,
        "Unsupported wallet backup format"
    );
    let salt = B64.decode(value.salt)?;
    let nonce = B64.decode(value.nonce)?;
    ensure!(
        salt.len() == 16 && nonce.len() == 24,
        "Invalid wallet backup"
    );
    let key = backup_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| anyhow::anyhow!("Could not decrypt backup"))?;
    let ciphertext = Zeroizing::new(B64.decode(value.ciphertext)?);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: BACKUP_SCHEMA.as_bytes(),
                },
            )
            .map_err(|_| {
                anyhow::anyhow!("Backup password is incorrect or the backup was changed")
            })?,
    );
    let payload: BackupPayload = serde_json::from_slice(&plaintext)?;
    ensure!(
        payload.owner == PublicKey::parse(expected_owner)?.to_hex(),
        "This backup belongs to another profile; its wallet was preserved"
    );
    let seed = parse_seed(&payload.seed)?;
    let database = Zeroizing::new(B64.decode(&payload.database)?);
    ensure!(
        database.len() <= 32 * 1024 * 1024 && database.starts_with(b"SQLite format 3\0"),
        "Invalid wallet database backup"
    );
    Ok((seed, database))
}
/// Explicit private restore preview: platform writes/read-backs this seed in its
/// secure wallet store before installing database bytes. Never put it in a snapshot.
pub fn native_backup_seed(backup: &str, password: &str, expected_owner: &str) -> Result<String> {
    let (seed, _) = decrypt_native_backup(backup, password, expected_owner)?;
    Ok(seed.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn restore_native_backup(
    directory: &Path,
    expected_owner: &str,
    backup: &str,
    password: &str,
    saved_seed: &str,
) -> Result<()> {
    let (seed, database) = decrypt_native_backup(backup, password, expected_owner)?;
    ensure!(
        *seed == *parse_seed(saved_seed)?,
        "Save the imported recovery key securely before restoring"
    );
    // Validate an existing binding before installing any database. For a new
    // wallet, bind the already-secured seed first: bind_seed deliberately
    // refuses to create a binding beside an existing unbound database.
    bind_seed(directory, &seed)?;
    cashu_service::restore_wallet_database(directory, &database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_kdf_matches_pbkdf2_sha256_vectors() {
        let value = pbkdf2_backup_key("password", b"salt", 1).unwrap();
        assert_eq!(
            value.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        let value = pbkdf2_backup_key("password", b"salt", 2).unwrap();
        assert_eq!(
            value.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        assert!(backup_key("short", b"salt").is_err());
    }
    #[test]
    fn encrypted_backup_is_authenticated_randomized_and_owner_bound() {
        let owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let other = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        let seed = [42; 64];
        let database = b"SQLite format 3\0test-database";
        let password = "a private testing password";
        let backup = encrypt_native_backup(owner, &seed, database, password).unwrap();
        assert!(!backup.contains("test-database"));
        let (restored_seed, restored_database) =
            decrypt_native_backup(&backup, password, owner).unwrap();
        assert_eq!(*restored_seed, seed);
        assert_eq!(restored_database.as_slice(), database);
        assert!(decrypt_native_backup(&backup, password, other).is_err());
        assert!(decrypt_native_backup(&backup, "a wrong testing password", owner).is_err());
        let mut changed: serde_json::Value = serde_json::from_str(&backup).unwrap();
        changed["rounds"] = 1.into();
        assert!(decrypt_native_backup(&changed.to_string(), password, owner).is_err());
        changed["rounds"] = BACKUP_ROUNDS.into();
        changed["ciphertext"] = "AAAAAAAA".into();
        assert!(decrypt_native_backup(&changed.to_string(), password, owner).is_err());
    }
    #[tokio::test]
    async fn backup_restore_preflights_binding_and_supports_fresh_device() {
        let owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let password = "a private restore testing password";
        let source = tempfile::TempDir::new().unwrap();
        let seed = generate_seed();
        let wallet = Wallet::open(source.path(), &seed).await.unwrap();
        let backup = wallet.export_backup(owner, password).await.unwrap();
        let conflict = tempfile::TempDir::new().unwrap();
        bind_seed(conflict.path(), &parse_seed(&generate_seed()).unwrap()).unwrap();
        let original_binding = fs::read(conflict.path().join("cashu/seed-binding")).unwrap();
        assert!(restore_native_backup(conflict.path(), owner, &backup, password, &seed).is_err());
        assert!(!cashu_service::cashu_wallet_database_exists(
            conflict.path()
        ));
        assert!(!conflict.path().join("cashu/restore.pending").exists());
        assert_eq!(
            fs::read(conflict.path().join("cashu/seed-binding")).unwrap(),
            original_binding
        );
        let fresh = tempfile::TempDir::new().unwrap();
        restore_native_backup(fresh.path(), owner, &backup, password, &seed).unwrap();
        let restored = Wallet::open(fresh.path(), &seed).await.unwrap();
        assert!(restored.snapshot(false).await.unwrap().review_required);
        drop(restored);
        let installed = fs::read(cashu_service::cashu_wallet_db_path(fresh.path())).unwrap();
        assert!(restore_native_backup(fresh.path(), owner, &backup, password, &seed).is_err());
        assert_eq!(
            fs::read(cashu_service::cashu_wallet_db_path(fresh.path())).unwrap(),
            installed
        );
    }
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

fn normalize_token(encoded: &str) -> &str {
    let text = encoded.trim();
    if text
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cashu:"))
    {
        text[6..].trim_start_matches("//").trim()
    } else {
        text
    }
}
#[derive(Serialize)]
pub struct InvoiceQr {
    pub invoice: String,
    pub uri: String,
    pub modules: Vec<Vec<bool>>,
}
/// Parse a pasted BOLT11 invoice before handing it to an external wallet or QR renderer.
pub fn lightning_invoice_qr(input: &str) -> Result<InvoiceQr> {
    ensure!(input.len() <= 8192, "Lightning invoice is too large");
    let text = input.trim();
    let text = if text
        .get(..10)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("lightning:"))
    {
        &text[10..]
    } else {
        text
    };
    let invoice = cashu::Bolt11Invoice::from_str(text)
        .context("Invalid Lightning invoice")?
        .to_string();
    let code = qrcode::QrCode::new(invoice.to_uppercase().as_bytes())
        .context("Lightning invoice is too large for a QR code")?;
    let modules = (0..code.width())
        .map(|y| {
            (0..code.width())
                .map(|x| code[(x, y)] == qrcode::Color::Dark)
                .collect()
        })
        .collect();
    Ok(InvoiceQr {
        uri: format!("lightning:{invoice}"),
        invoice,
        modules,
    })
}

#[cfg(test)]
mod wallet_acceptance {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    const INVOICE: &str = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
    #[test]
    fn normalized_invoice_qr_and_locked_ecash_fail_closed() {
        let qr =
            lightning_invoice_qr(&format!("  LIGHTNING:{}  ", INVOICE.to_uppercase())).unwrap();
        assert_eq!(qr.invoice, INVOICE);
        assert_eq!(qr.uri, format!("lightning:{INVOICE}"));
        assert!(qr.modules.len() > 20);
        assert!(qr.modules.iter().all(|row| row.len() == qr.modules.len()));
        assert!(lightning_invoice_qr("lightning:https://wallet.example").is_err());
        let secret = serde_json::json!(["P2PK",{"nonce":"fixture","data":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}]);
        let token = serde_json::json!({"token":[{"mint":TEST_MINT,"proofs":[{"id":"009a1f293253e41e","amount":8,"secret":secret.to_string(),"C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}]}],"unit":"sat"});
        let encoded = format!("cashuA{}", URL_SAFE_NO_PAD.encode(token.to_string()));
        assert!(
            preview_token(&encoded)
                .err()
                .unwrap()
                .to_string()
                .contains("Locked ecash")
        );
        assert_eq!(normalize_token(&format!("cashu://{encoded}")), encoded);
        assert!(mint_url("http://127.0.0.1:3338").is_err());
        assert!(test_mint(TEST_MINT));
        assert!(!test_mint(DEFAULT_MINT));
    }
    /// Start a fresh owned CDK FakeWallet fixture, then explicitly opt into this test.
    #[tokio::test]
    #[ignore = "requires MARKET_TEST_MINT_URL pointing to an owned fresh loopback CDK test mint"]
    async fn local_mint_native_wallet_receive_reopen_and_reclaim_race() {
        let mint =
            std::env::var("MARKET_TEST_MINT_URL").expect("set the owned local CDK test mint URL");
        normalize_mint(&mint, Some(&mint)).unwrap();
        let source = tempfile::TempDir::new().unwrap();
        let recipient = tempfile::TempDir::new().unwrap();
        let seed = generate_seed();
        let mut sender = Wallet::open(source.path(), &seed).await.unwrap();
        sender.developer_mint = Some(mint.clone());
        let mut receiver = Wallet::open(recipient.path(), &generate_seed())
            .await
            .unwrap();
        receiver.developer_mint = Some(mint.clone());
        let quote = sender.top_up(&mint, 128).await.unwrap();
        assert!(quote.test_only);
        // Respect the service mint-poll budget instead of requiring issuance
        // to complete inside a four-second UI polling window.
        for attempt in 0..120 {
            if sender.snapshot(true).await.unwrap().test_sats == 128 {
                break;
            }
            assert!(attempt < 119, "local issuance did not complete");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        assert_eq!(sender.snapshot(false).await.unwrap().total_sats, 0);
        let review = sender
            .preview_send(&mint, 16, "native-order:reviewed")
            .await
            .unwrap();
        let sent = sender
            .send_reviewed(&mint, 16, review.fee_sat, "native-order:reviewed")
            .await
            .unwrap();
        assert_eq!(
            Token::from_str(&sent.token)
                .unwrap()
                .value()
                .unwrap()
                .to_u64(),
            16
        );
        drop(sender);
        let mut sender = Wallet::open(source.path(), &seed).await.unwrap();
        sender.developer_mint = Some(mint.clone());
        let resumed_review = sender
            .preview_send(&mint, 16, "native-order:reviewed")
            .await
            .unwrap();
        assert!(resumed_review.existing);
        let retried = sender
            .send_reviewed(&mint, 16, resumed_review.fee_sat, "native-order:reviewed")
            .await
            .unwrap();
        assert_eq!(retried.token, sent.token);
        assert_eq!(retried.operation_id, sent.operation_id);
        assert!(sent.test_only);
        assert!(
            sender
                .pending_token(&sent.operation_id)
                .await
                .unwrap()
                .token
                == sent.token
        );
        let received = receiver
            .receive(&format!("cashu://{}", sent.token), &mint)
            .await
            .unwrap();
        assert!(received.amount > 0 && received.amount <= 16);
        assert!(received.test_only);
        assert!(sender.reclaim(&mint, &sent.operation_id).await.is_err());
        let unclaimed = sender.send(&mint, 8).await.unwrap();
        let before = sender.snapshot(false).await.unwrap().test_sats;
        let returned = sender
            .reclaim(&mint, &unclaimed.operation_id)
            .await
            .unwrap();
        assert!(returned > 0 && returned <= 8);
        assert_eq!(
            sender.snapshot(false).await.unwrap().test_sats,
            before + returned
        );
        assert!(sender.pending_token(&unclaimed.operation_id).await.is_err());
        assert!(receiver.receive(&unclaimed.token, &mint).await.is_err());
        drop(sender);
        let mut sender = Wallet::open(source.path(), &seed).await.unwrap();
        sender.developer_mint = Some(mint.clone());
        assert_eq!(
            sender.snapshot(false).await.unwrap().test_sats,
            before + returned
        );
        let raced = sender.send(&mint, 8).await.unwrap();
        let (receive, reclaim) = tokio::join!(
            receiver.receive(&raced.token, &mint),
            sender.reclaim(&mint, &raced.operation_id)
        );
        assert_ne!(
            receive.is_ok(),
            reclaim.is_ok(),
            "only recipient or sender may claim the same proofs"
        );
        let backup_review = sender
            .preview_send(&mint, 4, "native-backup:pending")
            .await
            .unwrap();
        let backed_up_token = sender
            .send_reviewed(&mint, 4, backup_review.fee_sat, "native-backup:pending")
            .await
            .unwrap();
        let expected_balance = sender.snapshot(false).await.unwrap().test_sats;
        let owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let password = "a private local mint backup password";
        let backup = sender.export_backup(owner, password).await.unwrap();
        drop(sender); // Model explicit migration: stop using the original wallet.
        let target = tempfile::TempDir::new().unwrap();
        let imported_seed = native_backup_seed(&backup, password, owner).unwrap();
        assert_eq!(imported_seed, seed);
        restore_native_backup(target.path(), owner, &backup, password, &imported_seed).unwrap();
        let mut restored = Wallet::open(target.path(), &imported_seed).await.unwrap();
        restored.developer_mint = Some(mint.clone());
        assert!(restored.snapshot(false).await.unwrap().review_required);
        assert!(
            restored
                .preview_send(&mint, 1, "restore:blocked")
                .await
                .is_err()
        );
        restored.snapshot(true).await.unwrap();
        assert_eq!(
            restored.snapshot(false).await.unwrap().test_sats,
            expected_balance
        );
        let restored_retry = restored
            .send_reviewed(&mint, 4, backup_review.fee_sat, "native-backup:pending")
            .await
            .unwrap();
        assert_eq!(restored_retry.token, backed_up_token.token);
        assert!(
            restored
                .pending_token(&unclaimed.operation_id)
                .await
                .is_err()
        );
    }
}
