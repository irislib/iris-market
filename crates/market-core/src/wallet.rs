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
        let service =
            CashuWalletService::open_with_seed_store(directory, Arc::new(FixedSeedStore(seed)))
                .await?;
        Ok(Self {
            service,
            developer_mint: None,
        })
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
                .err().unwrap()
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
        for attempt in 0..40 {
            if sender.snapshot(true).await.unwrap().test_sats == 128 {
                break;
            }
            assert!(attempt < 39, "local issuance did not complete");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(sender.snapshot(false).await.unwrap().total_sats, 0);
        let sent = sender.send(&mint, 16).await.unwrap();
        assert!(sent.test_only);
        assert!(sender.pending_token(&sent.operation_id).await.unwrap().token == sent.token);
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
    }
}
