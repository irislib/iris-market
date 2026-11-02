//! Request conditional ecash from a compatible wallet and check it at the agreed mint.
//! Proofs, witnesses and spending keys never enter a public event or a check response.
use super::Terms;
use anyhow::{Context, Result, ensure};
use cashu::{
    CheckStateRequest, CheckStateResponse, CurrencyUnit, KeysResponse, KeysetResponse, MintInfo,
    Nut10Secret, PaymentRequest, State, Token,
};
use nostr::EventId;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

impl Terms {
    pub fn payment_request(&self, proposal_id: EventId) -> Result<PaymentRequest> {
        let secret = Nut10Secret::try_from(self.conditions()?)?;
        Ok(PaymentRequest::builder()
            .payment_id(proposal_id.to_hex())
            .single_use(true)
            .amount(self.sats)
            .unit(CurrencyUnit::Sat)
            .add_mint(self.mint.parse()?)
            .description("Iris escrow, two signatures required")
            .nut10(secret.into())
            .build())
    }

    /// The caller explicitly selects the private proposal before contacting its mint.
    pub async fn check_funding(&self, encoded: &str) -> Result<FundingCheck> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        self.check_at(encoded, &client, &self.mint).await
    }

    async fn check_at(
        &self,
        encoded: &str,
        client: &reqwest::Client,
        endpoint: &str,
    ) -> Result<FundingCheck> {
        let lock = self.conditions()?;
        ensure!(encoded.len() <= 32_768, "Token is too large");
        let token: Token = encoded
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid Cashu token"))?;
        ensure!(
            token.unit().unwrap_or_default() == CurrencyUnit::Sat
                && token.mint_url()?.to_string() == self.mint,
            "Token must use the agreed mint and sats"
        );
        let secrets = token.token_secrets();
        ensure!(
            (1..=128).contains(&secrets.len()),
            "Invalid number of proofs"
        );
        let mut first = None;
        let mut seen = HashSet::new();
        for secret in secrets {
            ensure!(seen.insert(secret), "Repeated proof");
            let parsed = Nut10Secret::try_from(secret).context("Expected locked ecash")?;
            ensure!(
                cashu::SpendingConditions::try_from(parsed.clone())
                    .context("Invalid escrow conditions")?
                    == lock,
                "Proof has different spending conditions"
            );
            let request = cashu::Nut10SecretRequest::from(parsed);
            ensure!(
                request.tags.as_ref().is_some_and(|tags| tags.len() == 3
                    && tags.iter().all(|t| matches!(
                        t.first().map(String::as_str),
                        Some("n_sigs" | "pubkeys" | "sigflag")
                    ))),
                "Unexpected escrow lock tags"
            );
            if let Some(expected) = &first {
                ensure!(
                    &request == expected,
                    "SIG_ALL inputs must have identical locking policies"
                );
            } else {
                first = Some(request);
            }
        }
        let info: MintInfo = response(client.get(format!("{endpoint}/v1/info"))).await?;
        ensure!(
            info.nuts.nut10.supported
                && info.nuts.nut11.supported
                && info.nuts.nut12.supported
                && info.nuts.nut07.supported,
            "Mint must support spending conditions, DLEQ and proof state checks"
        );
        let list: KeysetResponse = response(client.get(format!("{endpoint}/v1/keysets"))).await?;
        let proofs = token.proofs(&list.keysets)?;
        let ids: HashSet<_> = proofs.iter().map(|p| p.keyset_id).collect();
        ensure!(ids.len() <= 8, "Too many keysets");
        let mut keysets = HashMap::new();
        for id in ids {
            let info = list
                .keysets
                .iter()
                .find(|k| k.id == id && k.unit == CurrencyUnit::Sat)
                .context("Unknown sat keyset")?;
            let keys: KeysResponse =
                response(client.get(format!("{endpoint}/v1/keys/{id}"))).await?;
            let keys = keys
                .keysets
                .into_iter()
                .find(|k| k.id == id && k.unit == CurrencyUnit::Sat)
                .context("Missing sat keyset")?;
            keys.verify_id()?;
            keysets.insert(id, (keys.keys, info.input_fee_ppk));
        }
        let mut ppk = 0u64;
        let mut gross = 0u64;
        let mut ys = HashSet::new();
        for proof in &proofs {
            let (keys, fee) = &keysets[&proof.keyset_id];
            let key = keys
                .amount_key(proof.amount)
                .context("Invalid denomination")?;
            proof
                .verify_dleq(key)
                .context("Invalid or missing mint signature proof")?;
            ensure!(ys.insert(proof.y()?), "Repeated proof");
            ppk = ppk.checked_add(*fee).context("Invalid input fees")?;
            gross = gross
                .checked_add(proof.amount.to_u64())
                .context("Invalid total")?;
        }
        let fee = ppk.div_ceil(1000);
        let net = gross.checked_sub(fee).context("Fees exceed proof value")?;
        ensure!(
            net >= self.sats,
            "Net sats after mint fees are below the agreement"
        );
        let states: CheckStateResponse = response(
            client
                .post(format!("{endpoint}/v1/checkstate"))
                .json(&CheckStateRequest {
                    ys: ys.iter().copied().collect(),
                }),
        )
        .await?;
        ensure!(
            states
                .states
                .into_iter()
                .all(|s| s.state == State::Unspent && ys.remove(&s.y))
                && ys.is_empty(),
            "Mint did not confirm all escrow proofs unspent"
        );
        Ok(FundingCheck {
            sats: net,
            agreed_sats: self.sats,
            input_fee_sats: fee,
            checked_at: crate::listing::now(),
        })
    }
}

#[derive(Debug, Serialize)]
pub struct FundingCheck {
    pub sats: u64,
    pub agreed_sats: u64,
    pub input_fee_sats: u64,
    pub checked_at: u64,
}
async fn response<T: for<'a> Deserialize<'a>>(request: reqwest::RequestBuilder) -> Result<T> {
    let mut response = request.send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= 512 * 1024,
            "Mint response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("Invalid mint response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::escrow::Provider;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };

    #[tokio::test]
    #[ignore = "requires the pinned local CDK test mint and the locked web dependencies"]
    async fn real_mint_funding_single_signer_rejection_release_and_spent_replay() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/tests/fixtures/escrow-mint.mjs");
        let mut child = Command::new("node")
            .arg(fixture)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut read = || {
            serde_json::from_str::<serde_json::Value>(
                &output.next().expect("Wallet fixture exited").unwrap(),
            )
            .unwrap()
        };
        let ready = read();
        let endpoint = ready["endpoint"].as_str().unwrap();
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        let key = |n: usize| ready["publicKeys"][n].as_str().unwrap().parse().unwrap();
        let t = Terms {
            mint: "https://mint.example".into(),
            sats: 63,
            buyer_key: key(0),
            seller_key: key(1),
            provider: Provider::authorize(&nostr::Keys::generate(), key(2)),
        };
        let req = t.payment_request(EventId::all_zeros()).unwrap();
        writeln!(input, "{req}").unwrap();
        let payment = read();
        let token = payment["token"].as_str().unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let check = t.check_at(token, &client, endpoint).await.unwrap();
        assert_eq!(check.agreed_sats, 63);
        assert!(check.sats >= check.agreed_sats);
        let mut wrong = t.clone();
        wrong.sats = check.sats + 1;
        assert!(
            wrong
                .check_at(token, &client, endpoint)
                .await
                .unwrap_err()
                .to_string()
                .contains("Net sats")
        );
        writeln!(input, "release").unwrap();
        assert_eq!(read()["received"], check.sats);
        assert!(
            t.check_at(token, &client, endpoint)
                .await
                .unwrap_err()
                .to_string()
                .contains("unspent")
        );
        drop(input);
        assert!(child.wait().unwrap().success());
    }
}
