//! Wallet-owned, retryable funding and settlement of a private escrow agreement.
//! Only NUT-03 inputs and blinded outputs are exchanged. Blinding factors and
//! new bearer secrets stay in an authenticated journal inside the wallet database.
use super::{Wallet, normalize_mint};
use crate::escrow::Terms;
use anyhow::{Context, Result, bail, ensure};
use cashu::{
    Amount, BlindSignature, CheckStateRequest, CheckStateResponse, CurrencyUnit, KeysetResponse,
    MintInfo, PreMintSecrets, Proof, PublicKey, RestoreRequest, RestoreResponse, SecretKey, State,
    SwapRequest, SwapResponse, Token, Witness, amount::SplitTarget,
    nut10::SpendingConditionVerification, secret::Secret,
};
use cdk::{
    cdk_database::WalletDatabase,
    wallet::{
        SendOptions, Wallet as CdkWallet,
        types::{KeysetLoadPolicy, OperationData, SendSagaState, WalletSagaState},
    },
};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    op: String,
    trade_id: String,
    terms: Option<Terms>,
    token: Option<String>,
    max_fee: Option<u64>,
    swap: Option<SwapRequest>,
    recipient_key: Option<PublicKey>,
    direction: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Journal {
    terms: Option<Terms>,
    funding: Option<Funding>,
    choice: Option<Choice>,
    received: Option<u64>,
}
#[derive(Serialize, Deserialize)]
struct Funding {
    operation: uuid::Uuid,
    #[serde(default)]
    created_at: u64,
    swap_inputs: Vec<Proof>,
    send_inputs: Vec<Proof>,
    swap_fee: Amount,
    send_fee: Amount,
    active_keyset: cashu::Id,
    fee_rates: HashMap<cashu::Id, u64>,
    token: Option<String>,
    #[serde(default)]
    checked: bool,
}
impl Funding {
    fn fee(&self) -> Result<u64> {
        self.swap_fee
            .to_u64()
            .checked_add(self.send_fee.to_u64())
            .context("Fee overflow")
    }
}
#[derive(Serialize, Deserialize)]
struct Choice {
    token_hash: [u8; 32],
    direction: String,
    recipient: PublicKey,
    swap: SwapRequest,
    // Only the beneficiary generates and retains these secrets.
    output_secrets: Option<Vec<(Secret, String)>>,
}

fn derive(seed: &[u8], domain: &[u8], id: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mut value = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(domain), seed)
        .expand(id.as_bytes(), value.as_mut())
        .map_err(|_| anyhow::anyhow!("Wallet key derivation failed"))?;
    Ok(value)
}
fn seal_key(wallet: &Wallet, id: &str) -> Result<XChaCha20Poly1305> {
    let key = derive(wallet.seed.as_ref(), b"iris-market/escrow/journal/v1", id)?;
    Ok(XChaCha20Poly1305::new((&*key).into()))
}
impl Wallet {
    // Most wallets never enable escrow. Reuse the CDK database opened and locked
    // by the service, and initialize this API handle only when first needed.
    async fn escrow_db(&self) -> Result<&std::sync::Arc<cdk_sqlite::WalletSqliteDatabase>> {
        self.escrow_database
            .get_or_try_init(|| async {
                Ok(std::sync::Arc::new(
                    cdk_sqlite::WalletSqliteDatabase::new(&self.database_path).await?,
                ))
            })
            .await
    }
    pub(super) async fn escrow_funding_activity(&self) -> Result<Vec<super::Activity>> {
        let db = self.escrow_db().await?;
        let mut activity = Vec::new();
        for id in db.kv_list("iris_market", "escrow").await? {
            let row = self.escrow_load(&id).await?;
            let (Some(terms), Some(funding)) = (row.terms, row.funding) else {
                continue;
            };
            if funding.token.is_some() {
                activity.push(super::Activity {
                    id: format!("escrow-{}", funding.operation),
                    kind: "escrow_funded".into(),
                    status: "complete".into(),
                    test_only: super::test_mint(&terms.mint),
                    mint: terms.mint,
                    amount: terms.sats,
                    fee: Some(funding.fee()?),
                    created_at: funding.created_at,
                    operation_id: None,
                });
            }
        }
        Ok(activity)
    }
    async fn escrow_load(&self, id: &str) -> Result<Journal> {
        let Some(bytes) = self
            .escrow_db()
            .await?
            .kv_read("iris_market", "escrow", id)
            .await?
        else {
            return Ok(Journal::default());
        };
        ensure!(
            bytes.len() > 24 && bytes.len() < 1_000_000,
            "Invalid private escrow record"
        );
        let data = seal_key(self, id)?
            .decrypt(
                XNonce::from_slice(&bytes[..24]),
                Payload {
                    msg: &bytes[24..],
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("Private escrow record could not be opened"))?;
        Ok(serde_json::from_slice(&Zeroizing::new(data))?)
    }
    async fn escrow_save(&self, id: &str, row: &Journal) -> Result<()> {
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let plain = Zeroizing::new(serde_json::to_vec(row)?);
        let body = seal_key(self, id)?
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("Private escrow record could not be saved"))?;
        let mut bytes = nonce.to_vec();
        bytes.extend(body);
        self.escrow_db()
            .await?
            .kv_write("iris_market", "escrow", id, &bytes)
            .await?;
        Ok(())
    }
    /// Call only on an explicit user action with a locally accepted trade.
    pub async fn escrow(&self, request: &str) -> Result<String> {
        ensure!(request.len() <= 128 * 1024, "Escrow request too large");
        let a: Action = serde_json::from_str(request).context("Invalid escrow wallet action")?;
        let id = &a.trade_id;
        ensure!(
            id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid trade ID"
        );
        let secret = SecretKey::from_slice(
            derive(self.seed.as_ref(), b"iris-market/escrow/wallet-key/v1", id)?.as_ref(),
        )?;
        let key = secret.public_key();
        if a.op == "key" {
            return Ok(json!({"key":key}).to_string());
        }
        let terms = a.terms.as_ref().context("Missing agreed escrow terms")?;
        let lock = terms.conditions()?;
        normalize_mint(&terms.mint, self.developer_mint.as_deref())?;
        ensure!(
            [terms.buyer_key, terms.seller_key, terms.provider.key].contains(&key),
            "This wallet does not hold a key for this trade"
        );
        let _guard = self.operation.lock().await;
        ensure!(
            !self.service.restored_review_required(),
            "Refresh this restored wallet before using escrow"
        );
        let mut row = self.escrow_load(id).await?;
        ensure!(
            row.terms.as_ref().is_none_or(|t| t == terms),
            "This trade already has different terms"
        );
        row.terms = Some(terms.clone());
        let client = reqwest::Client::builder()
            .https_only(self.developer_mint.as_deref() != Some(&terms.mint))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()?;
        let wallet = CdkWallet::new(
            &terms.mint,
            CurrencyUnit::Sat,
            self.escrow_db().await?.clone(),
            *self.seed,
            None,
        )?;
        if a.op == "recover_funding" {
            let Some(f) = row.funding.as_mut() else {
                return Ok(json!({"token":null}).to_string());
            };
            if f.token.is_none() {
                let saga = wallet
                    .localstore
                    .get_saga(&f.operation)
                    .await?
                    .context("Original funding operation needs recovery")?;
                match (saga.state, saga.data) {
                    (
                        WalletSagaState::Send(SendSagaState::TokenCreated),
                        OperationData::Send(data),
                    ) => f.token = data.token,
                    (WalletSagaState::Send(SendSagaState::ProofsReserved), _) => {
                        return Ok(json!({"token":null}).to_string());
                    }
                    _ => bail!("Mint confirmation is pending. Refresh the wallet and retry"),
                }
            }
            let raw = f.token.clone().context("Mint confirmation is pending")?;
            if !f.checked {
                terms.check_at(&raw, &client, &terms.mint).await?;
                f.checked = true;
                self.escrow_save(id, &row).await?;
            }
            return Ok(json!({"token":raw}).to_string());
        }
        if a.op == "fund" || a.op == "preview_fund" {
            ensure!(
                key != terms.provider.key,
                "A provider cannot fund on behalf of a trader"
            );
            let opts = SendOptions {
                conditions: Some(lock),
                include_fee: true,
                ..Default::default()
            };
            let result = self
                .fund_escrow(&a, terms, &client, &wallet, opts, &mut row)
                .await?;
            return Ok(result.to_string());
        }
        let token = a.token.as_deref().context("Missing locked payment")?;
        let direction = a.direction.as_deref().unwrap_or("");
        if a.op != "check" {
            ensure!(
                matches!(direction, "release" | "refund"),
                "Choose release or refund"
            )
        }
        if a.op == "complete" && row.received.is_some() {
            let choice = row.choice.as_ref().context("Missing original settlement")?;
            ensure!(
                direction == choice.direction
                    && choice.token_hash == <[u8; 32]>::from(Sha256::digest(token.as_bytes()))
                    && same_tx(
                        &choice.swap,
                        a.swap.as_ref().context("Missing signed payout")?
                    ),
                "Different settlement"
            );
            return Ok(json!({"received":row.received}).to_string());
        }
        // A mint may already have executed this exact settlement before a crash.
        if a.op == "complete" {
            let choice = row
                .choice
                .as_ref()
                .context("Prepare the recipient payout first")?;
            ensure!(
                choice.output_secrets.is_some()
                    && choice.direction == direction
                    && choice.recipient == key
                    && matches_token(token, &choice.swap, &terms.mint, &client).await?,
                "Different recipient or payment"
            );
            let signed = a.swap.as_ref().context("Missing signed payout")?;
            ensure!(same_tx(&choice.swap, signed), "The signed payout changed");
            ensure!(
                has_signature(signed, key)
                    && [terms.buyer_key, terms.seller_key, terms.provider.key]
                        .into_iter()
                        .any(|k| k != key && has_signature(signed, k)),
                "A second participant must sign this payout"
            );
            let credited = self
                .complete_escrow(terms, &client, &wallet, choice, signed)
                .await?;
            row.received = Some(credited);
            self.escrow_save(id, &row).await?;
            return Ok(json!({"received":credited}).to_string());
        }
        let checked = terms.check_at(token, &client, &terms.mint).await?;
        if a.op == "check" {
            return Ok(json!({"amount":checked.sats,"fee":checked.input_fee_sats}).to_string());
        }
        ensure!(
            a.op == "prepare" || a.op == "cosign",
            "Unknown wallet action"
        );
        let recipient = if a.op == "prepare" {
            key
        } else {
            a.recipient_key.context("Choose the intended recipient")?
        };
        ensure!(
            [terms.buyer_key, terms.seller_key].contains(&recipient),
            "Payout must go to a trader"
        );
        ensure!(
            a.recipient_key.is_none_or(|stated| stated == recipient),
            "Chosen recipient does not match the receiving wallet"
        );
        if let Some(chosen) = &row.choice {
            ensure!(
                chosen.direction == direction
                    && chosen.recipient == recipient
                    && matches_token(token, &chosen.swap, &terms.mint, &client).await?,
                "This wallet already signed a different payout"
            );
            if a.op == "cosign" {
                ensure!(
                    a.swap
                        .as_ref()
                        .is_some_and(|s| same_tx(&chosen.swap, s) && has_signature(s, recipient)),
                    "A different payout has already been signed"
                )
            }
            return Ok(json!({"swap":chosen.swap}).to_string());
        }
        let inputs = decode_token(token, &terms.mint, &client).await?;
        let active = wallet.active_keyset().await?;
        let (mut swap, secrets) = if a.op == "prepare" {
            let amounts = wallet.get_keyset_fees_and_amounts_by_id(active.id).await?;
            let outputs = PreMintSecrets::random(
                active.id,
                checked.sats.into(),
                &SplitTarget::None,
                &amounts,
            )?;
            let secrets = outputs
                .iter()
                .map(|o| (o.secret.clone(), o.r.to_secret_hex()))
                .collect();
            (
                SwapRequest::new(inputs, outputs.blinded_messages()),
                Some(secrets),
            )
        } else {
            let s = a.swap.as_ref().context("Missing recipient payout")?;
            ensure!(
                key != recipient && same_inputs(&inputs, s.inputs()) && has_signature(s, recipient),
                "Payout must be signed by the intended recipient and spend exactly this trade"
            );
            ensure!(
                s.output_amount()?.to_u64() == checked.sats
                    && !s.outputs().is_empty()
                    && s.outputs().len() <= 128,
                "Payout does not match the net amount"
            );
            let mut seen = HashSet::new();
            ensure!(
                s.outputs().iter().all(|o| o.keyset_id == active.id
                    && o.witness.is_none()
                    && active.keys.amount_key(o.amount).is_some()
                    && seen.insert(o.blinded_secret)),
                "Invalid payout outputs"
            );
            (s.clone(), None)
        };
        swap.sign_sig_all(secret)?;
        let result = json!({"swap":swap});
        row.choice = Some(Choice {
            token_hash: Sha256::digest(token.as_bytes()).into(),
            direction: direction.into(),
            recipient,
            swap,
            output_secrets: secrets,
        });
        self.escrow_save(id, &row).await?;
        Ok(result.to_string())
    }
    async fn fund_escrow(
        &self,
        a: &Action,
        t: &Terms,
        client: &reqwest::Client,
        wallet: &CdkWallet,
        opts: SendOptions,
        row: &mut Journal,
    ) -> Result<Value> {
        let preview = a.op == "preview_fund";
        if let Some(f) = row.funding.as_ref() {
            let fee = f.fee()?;
            if preview {
                return Ok(
                    json!({"amount":t.sats,"fee":fee,"max_total":t.sats.checked_add(fee).context("Total overflow")?}),
                );
            }
            ensure!(
                fee <= a.max_fee.context("Review the funding fee first")?,
                "Saved payment exceeds your fee limit"
            );
            if let Some(raw) = f.token.clone() {
                if !f.checked {
                    t.check_at(&raw, client, &t.mint).await?;
                    row.funding.as_mut().unwrap().checked = true;
                    self.escrow_save(&a.trade_id, row).await?;
                }
                return Ok(json!({"token":raw}));
            }
        }
        let info: MintInfo = fetch(client.get(format!("{}/v1/info", t.mint))).await?;
        ensure!(
            info.nuts.nut07.supported
                && info.nuts.nut09.supported
                && info.nuts.nut10.supported
                && info.nuts.nut11.supported
                && info.nuts.nut12.supported,
            "This mint cannot verify, lock and recover escrow payments"
        );
        let keysets = wallet.keysets(KeysetLoadPolicy::Refresh).await?;
        let active = wallet
            .active_keyset_with_policy(KeysetLoadPolicy::CacheOnly)
            .await?
            .id;
        let rates: HashMap<_, _> = keysets.iter().map(|k| (k.id, k.input_fee_ppk)).collect();
        if row.funding.is_none() {
            let plan = wallet.prepare_send(t.sats.into(), opts.clone()).await?;
            let fee = plan.fee().to_u64();
            if preview || !a.max_fee.is_some_and(|max| max >= fee) {
                plan.cancel().await?;
                ensure!(preview, "The funding fee changed. Review the payment again");
                return Ok(
                    json!({"amount":t.sats,"fee":fee,"max_total":t.sats.checked_add(fee).context("Total overflow")?}),
                );
            }
            let used: HashSet<_> = plan
                .proofs()
                .iter()
                .map(|p| p.keyset_id)
                .chain([active])
                .collect();
            row.funding = Some(Funding {
                operation: plan.operation_id(),
                created_at: crate::listing::now(),
                swap_inputs: plan.proofs_to_swap().clone(),
                send_inputs: plan.proofs_to_send().clone(),
                swap_fee: plan.swap_fee(),
                send_fee: plan.send_fee(),
                active_keyset: active,
                fee_rates: rates
                    .iter()
                    .filter(|(k, _)| used.contains(k))
                    .map(|(k, v)| (*k, *v))
                    .collect(),
                token: None,
                checked: false,
            });
            if let Err(e) = self.escrow_save(&a.trade_id, row).await {
                plan.cancel().await?;
                return Err(e);
            }
        }
        let f = row.funding.as_mut().context("No saved funding plan")?;
        let saga = wallet
            .localstore
            .get_saga(&f.operation)
            .await?
            .context("The original funding operation needs recovery")?;
        ensure!(
            saga.mint_url.to_string() == t.mint
                && saga.unit == CurrencyUnit::Sat
                && saga.amount.to_u64() == t.sats,
            "Original funding operation changed"
        );
        let raw = match saga.state {
            WalletSagaState::Send(SendSagaState::ProofsReserved) => {
                ensure!(
                    f.active_keyset == active
                        && f.fee_rates.iter().all(|(k, v)| rates.get(k) == Some(v)),
                    "Mint fees or keys changed since review"
                );
                wallet
                    .confirm_send(
                        f.operation,
                        t.sats.into(),
                        opts,
                        f.swap_inputs.clone(),
                        f.send_inputs.clone(),
                        f.swap_fee,
                        f.send_fee,
                        None,
                    )
                    .await?
                    .to_string()
            }
            WalletSagaState::Send(SendSagaState::TokenCreated) => match saga.data {
                OperationData::Send(saved) => {
                    saved.token.context("Funding token requires recovery")?
                }
                _ => bail!("Invalid funding operation"),
            },
            _ => bail!("The original escrow payment needs recovery. Refresh the wallet and retry"),
        };
        // Preserve the exact token before a live check that can fail independently.
        f.token = Some(raw.clone());
        self.escrow_save(&a.trade_id, row).await?;
        t.check_at(&raw, client, &t.mint).await?;
        row.funding.as_mut().unwrap().checked = true;
        self.escrow_save(&a.trade_id, row).await?;
        Ok(json!({"token":raw}))
    }
    async fn complete_escrow(
        &self,
        t: &Terms,
        client: &reqwest::Client,
        wallet: &CdkWallet,
        chosen: &Choice,
        signed: &SwapRequest,
    ) -> Result<u64> {
        let outputs = signed.outputs();
        // NUT-09 recovers the exact original private outputs if a response was lost.
        let restored: RestoreResponse = fetch(client.post(format!("{}/v1/restore", t.mint)).json(
            &RestoreRequest {
                outputs: outputs.clone(),
            },
        ))
        .await?;
        let signatures: Vec<BlindSignature> =
            if restored.outputs.is_empty() && restored.signatures.is_empty() {
                let result: SwapResponse =
                    fetch(client.post(format!("{}/v1/swap", t.mint)).json(signed)).await?;
                result.signatures
            } else {
                ensure!(
                    restored.outputs.len() == outputs.len()
                        && restored.signatures.len() == outputs.len(),
                    "Mint restored only part of the payout"
                );
                let mut pairs: HashMap<_, _> = restored
                    .outputs
                    .into_iter()
                    .zip(restored.signatures)
                    .map(|(o, s)| (o.blinded_secret, s))
                    .collect();
                outputs
                    .iter()
                    .map(|o| {
                        pairs
                            .remove(&o.blinded_secret)
                            .context("Incorrect restored output")
                    })
                    .collect::<Result<_>>()?
            };
        ensure!(
            !outputs.is_empty()
                && signatures.len() == outputs.len()
                && outputs
                    .iter()
                    .zip(&signatures)
                    .all(|(o, s)| s.keyset_id == o.keyset_id
                        && s.amount == o.amount
                        && s.dleq.is_some()),
            "Mint returned different payout amounts or keys"
        );
        let first = outputs[0].keyset_id;
        let keys = wallet.keyset(first).await?;
        keys.verify_id()?;
        let data = chosen
            .output_secrets
            .as_ref()
            .context("Missing local recipient wallet outputs")?;
        let secrets = data.iter().map(|(s, _)| s.clone()).collect();
        let rs = data
            .iter()
            .map(|(_, r)| r.parse())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let proofs = cashu::dhke::construct_proofs(signatures, rs, secrets, &keys.keys)?;
        for p in &proofs {
            ensure!(p.keyset_id == first, "Different payout keyset");
            p.verify_dleq(
                keys.keys
                    .amount_key(p.amount)
                    .context("Unknown denomination")?,
            )?;
        }
        let mut ys: HashSet<_> = proofs
            .iter()
            .map(Proof::y)
            .collect::<std::result::Result<_, _>>()?;
        let states: CheckStateResponse = fetch(
            client
                .post(format!("{}/v1/checkstate", t.mint))
                .json(&CheckStateRequest {
                    ys: ys.iter().copied().collect(),
                }),
        )
        .await?;
        // Never claim a new wallet credit for already-spent or uncertain outputs.
        // A lost local import acknowledgement can safely retry while these outputs
        // are unspent: the service leaves existing proof rows unchanged.
        ensure!(
            states
                .states
                .into_iter()
                .all(|s| s.state == State::Unspent && ys.remove(&s.y))
                && ys.is_empty(),
            "The mint could not confirm the payout outputs. Check wallet activity before retrying"
        );
        self.service
            .import_payment_proofs(&t.mint, "sat", &serde_json::to_string(&proofs)?)
            .await?;
        Ok(signed.output_amount()?.to_u64())
    }
}

fn has_signature(s: &SwapRequest, key: PublicKey) -> bool {
    let msg = s.sig_all_msg_to_sign();
    s.inputs()
        .first()
        .and_then(|p| p.witness.as_ref())
        .and_then(Witness::signatures)
        .is_some_and(|sigs| {
            sigs.len() <= 3
                && sigs.iter().any(|sig| {
                    sig.parse()
                        .is_ok_and(|s| key.verify(msg.as_bytes(), &s).is_ok())
                })
        })
}
fn same_inputs(a: &[Proof], b: &[Proof]) -> bool {
    a.len() == b.len() && !a.is_empty() && {
        let mut base: HashMap<_, _> = a.iter().map(|p| (&p.secret, p)).collect();
        a.len() == base.len()
            && b.iter().all(|p| {
                base.remove(&p.secret).is_some_and(|q| {
                    q.amount == p.amount
                        && q.c == p.c
                        && q.keyset_id == p.keyset_id
                        && q.p2pk_e == p.p2pk_e
                })
            })
    }
}
fn same_tx(a: &SwapRequest, b: &SwapRequest) -> bool {
    same_inputs(a.inputs(), b.inputs())
        && a.outputs() == b.outputs()
        && a.sig_all_msg_to_sign() == b.sig_all_msg_to_sign()
}
async fn matches_token(
    raw: &str,
    s: &SwapRequest,
    mint: &str,
    client: &reqwest::Client,
) -> Result<bool> {
    Ok(same_inputs(
        &decode_token(raw, mint, client).await?,
        s.inputs(),
    ))
}
async fn decode_token(raw: &str, mint: &str, client: &reqwest::Client) -> Result<Vec<Proof>> {
    ensure!(raw.len() <= 32768, "Escrow token too large");
    let token: Token = raw
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid locked token"))?;
    ensure!(
        token.mint_url()?.to_string() == mint
            && token.unit().unwrap_or_default() == CurrencyUnit::Sat,
        "Mint or unit does not match"
    );
    let keysets: KeysetResponse = fetch(client.get(format!("{mint}/v1/keysets"))).await?;
    Ok(token.proofs(&keysets.keysets)?)
}
async fn fetch<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    crate::escrow::funding::response(request).await
}

#[cfg(test)]
mod tests;
