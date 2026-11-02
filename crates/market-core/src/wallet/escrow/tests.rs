use super::*;
use crate::escrow::Provider;
use serde_json::Value;

async fn call(w: &Wallet, op: &str, fields: Value) -> Result<Value> {
    let mut v = fields;
    v["op"] = op.into();
    v["trade_id"] = "ab".repeat(32).into();
    Ok(serde_json::from_str(&w.escrow(&v.to_string()).await?)?)
}
async fn public(w: &Wallet) -> Result<PublicKey> {
    Ok(serde_json::from_value(
        call(w, "key", json!({})).await?["key"].clone(),
    )?)
}
struct BrowserPeer {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}
impl BrowserPeer {
    fn start() -> Result<Self> {
        use std::process::{Command, Stdio};
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/tests/fixtures/escrow-wallet-peer.mjs");
        let mut child = Command::new("node")
            .arg(fixture)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        Ok(Self {
            input: child.stdin.take().context("wallet fixture stdin")?,
            output: std::io::BufReader::new(child.stdout.take().context("wallet fixture stdout")?),
            child,
        })
    }
    fn action(&mut self, op: &str, mut data: Value, id: &str) -> Result<Value> {
        use std::io::{BufRead, Write};
        data["op"] = op.into();
        data["trade_id"] = id.into();
        writeln!(self.input, "{data}")?;
        let mut line = String::new();
        ensure!(
            self.output.read_line(&mut line)? > 0,
            "Browser wallet closed early"
        );
        let result: Value = serde_json::from_str(&line)?;
        ensure!(
            result.get("error").is_none(),
            "Browser wallet {op} failed: {}",
            result["error"].as_str().unwrap_or("invalid response")
        );
        Ok(result)
    }
}
impl Drop for BrowserPeer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[tokio::test]
#[ignore = "requires a loopback CDK mint and the locked browser dependencies"]
async fn native_wallet_escrow_interoperates_with_browser_both_directions() -> Result<()> {
    let mint = crate::escrow::local_test_mint().context("Choose an isolated test mint")?;
    let dir = tempfile::tempdir()?;
    let mut web = BrowserPeer::start()?;
    let native = Wallet::open(dir.path(), &super::super::generate_seed()).await?;
    let id = "ab".repeat(32);
    web.action("topup_fixture", json!({"amount":256}), &id)?;
    native.top_up(&mint, 256).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while native.snapshot(true).await?.test_sats < 256 {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Test funds unavailable"
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    for browser_is_funder in [true, false] {
        let id = if browser_is_funder { "cd" } else { "ef" }.repeat(32);
        let native_action = |op: &str, mut data: Value| {
            data["op"] = op.into();
            data["trade_id"] = id.clone().into();
            let w = &native;
            async move {
                Ok::<Value, anyhow::Error>(serde_json::from_str(
                    &w.escrow(&data.to_string()).await?,
                )?)
            }
        };
        let wk = serde_json::from_value(web.action("key", json!({}), &id)?["key"].clone())?;
        let nk = serde_json::from_value(native_action("key", json!({})).await?["key"].clone())?;
        let provider =
            Provider::authorize(&nostr::Keys::generate(), SecretKey::generate().public_key());
        let terms = Terms {
            mint: mint.clone(),
            sats: 27,
            buyer_key: if browser_is_funder { wk } else { nk },
            seller_key: if browser_is_funder { nk } else { wk },
            provider,
        };
        let fund = json!({"terms":terms,"max_fee":7});
        let payment = if browser_is_funder {
            web.action("fund", fund, &id)?
        } else {
            native_action("fund", fund).await?
        };
        let mut data = json!({"terms":terms,"token":payment["token"],"direction":"release","recipient_key":terms.seller_key});
        let claiming = if browser_is_funder {
            native_action("prepare", data.clone()).await?
        } else {
            web.action("prepare", data.clone(), &id)?
        };
        data["swap"] = claiming["swap"].clone();
        let second = if browser_is_funder {
            web.action("cosign", data.clone(), &id)?
        } else {
            native_action("cosign", data.clone()).await?
        };
        data["swap"] = second["swap"].clone();
        let received = if browser_is_funder {
            native_action("complete", data).await?
        } else {
            web.action("complete", data, &id)?
        };
        ensure!(
            received["received"].as_u64().is_some_and(|s| s >= 27),
            "Cross-wallet payment failed"
        );
    }
    Ok(())
}
#[tokio::test]
#[ignore = "requires an explicitly selected and freshly started loopback test mint"]
async fn native_wallet_escrow_fund_reopen_release_and_replay() -> Result<()> {
    let mint = crate::escrow::local_test_mint()
        .context("Select MARKET_ESCROW_TEST_MINT for this isolated test")?;
    let buy = tempfile::tempdir()?;
    let sell = tempfile::tempdir()?;
    let admin = tempfile::tempdir()?;
    let seed = super::super::generate_seed();
    let sellseed = super::super::generate_seed();
    let buyer = Wallet::open(buy.path(), &seed).await?;
    let seller = Wallet::open(sell.path(), &sellseed).await?;
    let provider = Wallet::open(admin.path(), &super::super::generate_seed()).await?;
    let t = Terms {
        mint: mint.clone(),
        sats: 63,
        buyer_key: public(&buyer).await?,
        seller_key: public(&seller).await?,
        provider: Provider::authorize(&nostr::Keys::generate(), public(&provider).await?),
    };
    buyer.top_up(&mint, 256).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while buyer.snapshot(true).await?.test_sats < 256 {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Test invoice was not credited"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let review = call(&buyer, "preview_fund", json!({"terms":t})).await?;
    ensure!(
        call(&provider, "fund", json!({"terms":t,"max_fee":10}))
            .await
            .is_err(),
        "Provider was allowed to fund"
    );
    ensure!(call(&buyer, "recover_funding", json!({"terms":t})).await? == json!({"token":null}));
    let args = json!({"terms":t,"max_fee":review["fee"]});
    let (first, retry, snapshot) = tokio::join!(
        call(&buyer, "fund", args.clone()),
        call(&buyer, "fund", args.clone()),
        buyer.snapshot(true)
    );
    let paid = first?;
    ensure!(retry? == paid);
    snapshot?;
    let token = paid["token"].as_str().context("Missing funded token")?;
    drop(buyer);
    let buyer = Wallet::open(buy.path(), &seed).await?;
    ensure!(
        call(&buyer, "fund", args).await? == paid,
        "Retry created another payment"
    );
    ensure!(call(&buyer, "recover_funding", json!({"terms":t})).await? == paid);
    let debit = 256 - buyer.snapshot(false).await?.test_sats;
    ensure!(
        debit
            <= review["max_total"]
                .as_u64()
                .context("Missing approved total")?,
        "Debit exceeded reviewed fee limit"
    );
    let check = call(&seller, "check", json!({"terms":t,"token":token})).await?;
    ensure!(check["amount"].as_u64().unwrap_or_default() >= 63);
    let base = json!({"terms":t,"token":token,"direction":"release"});
    let unsigned = call(&seller, "prepare", base.clone()).await?;
    let mut sig = base.clone();
    sig["swap"] = unsigned["swap"].clone();
    sig["recipient_key"] = json!(t.seller_key);
    ensure!(
        call(&seller, "complete", sig.clone()).await.is_err(),
        "A single signer spent the payment"
    );
    let mut wrong = sig.clone();
    wrong["recipient_key"] = json!(t.buyer_key);
    ensure!(
        call(&provider, "cosign", wrong).await.is_err(),
        "Signer ignored intended recipient"
    );
    let signed = call(&buyer, "cosign", sig.clone()).await?;
    sig["swap"] = signed["swap"].clone();
    drop(seller);
    let seller = Wallet::open(sell.path(), &sellseed).await?;
    let (first, retry, snapshot) = tokio::join!(
        call(&seller, "complete", sig.clone()),
        call(&seller, "complete", sig.clone()),
        seller.snapshot(true)
    );
    let done = first?;
    ensure!(retry? == done);
    snapshot?;
    let credited = done["received"].as_u64().context("No settled amount")?;
    let seller_wallet = seller.snapshot(false).await?;
    ensure!(credited >= 63 && seller_wallet.test_sats == credited);
    ensure!(seller_wallet.balances.len() == 1 && seller_wallet.balances[0].unit == "sat");
    ensure!(
        seller_wallet
            .activity
            .iter()
            .filter(|row| row.kind == "escrow_received"
                && row.amount == credited
                && row.operation_id.is_none())
            .count()
            == 1
    );
    let buyer_activity = buyer.snapshot(false).await?.activity;
    let deposits: Vec<_> = buyer_activity
        .iter()
        .filter(|row| row.kind == "escrow_funded")
        .collect();
    ensure!(
        deposits.len() == 1 && deposits[0].amount == t.sats && deposits[0].operation_id.is_none()
    );
    let operation = deposits[0].id.strip_prefix("escrow-").unwrap();
    ensure!(buyer.pending_token(operation).await.is_err());
    ensure!(buyer.reclaim(&mint, operation).await.is_err());
    ensure!(
        call(&buyer, "check", json!({"terms":t,"token":token}))
            .await
            .is_err(),
        "Spent token was accepted"
    );
    let outgoing = seller.send(&mint, 16).await?;
    ensure!(outgoing.amount == 16);
    drop(seller);
    let seller = Wallet::open(sell.path(), &sellseed).await?;
    let before = seller.snapshot(false).await?.test_sats;
    ensure!(
        call(&seller, "complete", sig).await? == done
            && seller.snapshot(false).await?.test_sats == before,
        "Settlement replay changed the balance"
    );
    Ok(())
}
