use cashu::{SecretKey, SpendingConditionVerification};
use iris_market_core::{
    escrow::{AgreementMessage, Offer, Proposal, Provider, Terms},
    listing,
    messaging::Messaging,
    model::Draft,
    reviews,
    store::Store,
};
use nostr::{EventBuilder, EventId, JsonUtil, Keys, Kind, Tag, Timestamp};
use serde_json::json;

fn draft(bitcoin: bool, side: &str, now: u64) -> Draft {
    serde_json::from_value(json!({
        "title":"Trade", "description":"A fixed offer", "side":side, "currency":"EUR","price":"12.50",
        "expires_at":now+3600, "escrow":if bitcoin { json!({"trade":"bitcoin_fiat","sats":63,"method":"cash"}) }
                          else {json!({"trade":"goods"})}
    })).unwrap()
}
fn terms() -> Terms {
    Terms {
        mint: "https://mint.example".into(),
        sats: 63,
        buyer_key: SecretKey::generate().public_key(),
        seller_key: SecretKey::generate().public_key(),
        provider: Provider::authorize(&Keys::generate(), SecretKey::generate().public_key()),
    }
}
#[test]
fn both_sides_of_each_trade_bind_the_correct_funder_to_the_signed_quote() {
    let now = listing::now();
    let maker = Keys::generate();
    let taker = Keys::generate().public_key();
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("listings.sqlite")).unwrap();
    for (bitcoin, side, maker_funds) in [
        (false, "offer", false),
        (false, "request", true),
        (true, "offer", true),
        (true, "request", false),
    ] {
        let d = draft(bitcoin, side, now);
        let event = listing::build(&maker, &d, side, now, false).unwrap();
        let listing = listing::parse(&event, now).unwrap();
        assert_eq!(event.kind.as_u16(), if bitcoin { 38383 } else { 30402 });
        assert_eq!(listing.side, side);
        assert_eq!(listing.escrow, d.escrow);
        assert!(store.ingest(&event, now, false).unwrap());
        let p = Proposal::for_event(&event, terms(), taker, now).unwrap();
        assert_eq!(p.revision, event.id);
        assert_eq!(
            p.funder,
            if maker_funds {
                maker.public_key()
            } else {
                taker
            }
        );
        assert_ne!(p.funder, p.beneficiary);
        let closed =
            listing::build(&maker, &listing::draft_from(&listing), side, now + 1, true).unwrap();
        assert!(store.ingest(&closed, now + 1, false).unwrap());
        assert!(!store.ingest(&event, now + 1, false).unwrap());
        assert_eq!(store.event(&p.listing_id).unwrap().id, closed.id);
        assert!(Proposal::for_event(&closed, terms(), taker, now + 1).is_err());
        assert!(Proposal::for_event(&event, terms(), taker, now + 3600).is_err());
    }
}
#[test]
fn native_checkout_requires_opt_in_and_retries_without_duplicating_the_order() {
    use iris_market_core::{Market, model::Settings};
    let directory = tempfile::tempdir().unwrap();
    let seller = Keys::generate();
    let now = listing::now();
    let event = listing::build(&seller, &draft(false, "offer", now), "goods", now, false).unwrap();
    let id = listing::parse(&event, now).unwrap().id;
    let mut db = Store::open(&directory.path().join("market.sqlite")).unwrap();
    assert!(db.ingest(&event, now, false).unwrap());
    let mut settings = Settings::default();
    settings.relays.clear();
    db.save_settings(&settings).unwrap();
    drop(db);
    let app = Market::open(
        directory.path(),
        &Keys::generate().secret_key().to_secret_hex(),
        false,
    )
    .unwrap();
    let provider = Keys::generate().public_key().to_hex();
    let trade = "a".repeat(64);
    let request=json!({"type":"request_order","listing_id":id,"quantity":2,"escrow_trade_id":trade,"escrow_provider":provider}).to_string();
    assert!(
        app.command(&request)
            .unwrap_err()
            .to_string()
            .contains("Enable escrow")
    );
    settings.escrow_ui = true;
    app.command(&json!({"type":"set_settings","settings":settings}).to_string())
        .unwrap();
    app.command(&request).unwrap();
    let state: serde_json::Value = serde_json::from_str(&app.command(&request).unwrap()).unwrap();
    let orders = state["orders"].as_array().unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0]["escrowProvider"], provider);
    assert_eq!(orders[0]["escrowTradeId"], trade);
    assert_eq!(orders[0]["items"][0]["quantity"], 2);
    app.shutdown();
}
#[test]
fn malformed_quotes_and_forged_or_collapsed_signer_sets_fail_closed() {
    let now = listing::now();
    let maker = Keys::generate();
    let event = listing::build(&maker, &draft(true, "offer", now), "btc", now, false).unwrap();
    let duplicate = EventBuilder::new(Kind::Custom(38383), "")
        .tags(
            event
                .tags
                .iter()
                .cloned()
                .chain([Tag::parse(["fa", "999.00"]).unwrap()]),
        )
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(&maker)
        .unwrap();
    assert!(listing::parse(&duplicate, now).is_err());
    let mut t = terms();
    t.sats += 1;
    assert!(Proposal::for_event(&event, t, Keys::generate().public_key(), now).is_err());
    let mut t = terms();
    t.provider.profile = Keys::generate().public_key();
    assert!(t.conditions().is_err());
    let mut t = terms();
    let mut opposite = t.buyer_key.to_bytes();
    opposite[0] ^= 1;
    t.seller_key = cashu::PublicKey::from_slice(&opposite).unwrap();
    assert!(t.conditions().is_err());
    let mut t = terms();
    t.mint = "https://user:pass@mint.example".into();
    assert!(t.conditions().is_err());
    assert!(
        serde_json::from_value::<Offer>(
            json!({"trade":"bitcoin_fiat","sats":63,"method":"cash","secret":"private"})
        )
        .is_err()
    );
}

fn exchange(a: &mut Messaging, b: &mut Messaging) {
    for _ in 0..10 {
        a.retry().unwrap();
        b.retry().unwrap();
        for event in a.pending_outbound() {
            b.receive(&event).unwrap();
            a.acknowledge_published(&event.id.to_hex()).unwrap();
        }
        for event in b.pending_outbound() {
            a.receive(&event).unwrap();
            b.acknowledge_published(&event.id.to_hex()).unwrap();
        }
    }
}

#[test]
fn private_agreement_survives_restart_then_produces_a_wallet_request_and_rateable_profile() {
    let now = listing::now();
    let maker = Keys::generate();
    let taker = Keys::generate();
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let mut a = Messaging::open(dir_a.path(), maker.clone()).unwrap();
    let mut b = Messaging::open(dir_b.path(), taker.clone()).unwrap();
    let (maker_id, taker_id) = (maker.public_key().to_hex(), taker.public_key().to_hex());
    let d = draft(true, "request", now);
    let event = listing::build(&maker, &d, "btc", now, false).unwrap();
    b.accept_invite(&a.invite().unwrap()).unwrap();
    exchange(&mut a, &mut b);
    let t = terms();
    b.propose_escrow(&event, t.clone()).unwrap();
    assert!(b.propose_escrow(&event, t.clone()).is_err());
    for e in b.pending_outbound() {
        assert!(!e.as_json().contains(&t.provider.profile.to_hex()));
    }
    exchange(&mut a, &mut b);
    let message = a
        .conversations()
        .remove(0)
        .messages
        .into_iter()
        .find(|m| matches!(m.escrow, Some(AgreementMessage::Propose(_))))
        .unwrap();
    let id = EventId::from_hex(&message.id).unwrap();
    assert!(a.agreed_escrow(&taker_id, id).is_err());
    assert!(b.accept_escrow(&maker_id, id, &event).is_err());
    let changed = listing::build(&maker, &d, "btc", now + 1, false).unwrap();
    assert!(a.accept_escrow(&taker_id, id, &changed).is_err());
    a.accept_escrow(&taker_id, id, &event).unwrap();
    a.accept_escrow(&taker_id, id, &event).unwrap();
    exchange(&mut a, &mut b);
    drop(b);
    let b = Messaging::open(dir_b.path(), taker.clone()).unwrap();
    let agreed = b.agreed_escrow(&maker_id, id).unwrap();
    assert_eq!(agreed, a.agreed_escrow(&taker_id, id).unwrap());
    let req = agreed.terms.payment_request(id).unwrap();
    let decoded: cashu::PaymentRequest = req.to_string().parse().unwrap();
    assert_eq!(req, decoded);
    assert_eq!(decoded.payment_id.as_deref(), Some(message.id.as_str()));
    assert_eq!(decoded.amount.unwrap().to_u64(), 63);
    let lock: cashu::Nut10Secret = decoded.nut10.unwrap().into();
    assert_eq!(
        cashu::SpendingConditions::try_from(lock).unwrap(),
        t.conditions().unwrap()
    );
    let target = t.provider.profile.to_hex();
    drop(b);
    let db = Store::open(&dir_b.path().join("market.sqlite")).unwrap();
    let mut settings = db.settings().unwrap();
    settings.relays.clear();
    db.save_settings(&settings).unwrap();
    drop(db);
    let app =
        iris_market_core::Market::open(dir_b.path(), &taker.secret_key().to_secret_hex(), false)
            .unwrap();
    assert_eq!(app.escrow_terms(&maker_id, id).unwrap(), t);
    app.command(&json!({"type":"rate_escrow_provider","peer_id":maker_id,"proposal_id":id,"rating":5,"body":"Clear communication"}).to_string()).unwrap();
    let reviews: serde_json::Value =
        serde_json::from_str(&app.reviews(target.clone(), false, false).unwrap()).unwrap();
    assert_eq!(reviews[0]["rating"], 5.0);
    app.shutdown();
    let db = Store::open(&dir_b.path().join("market.sqlite")).unwrap();
    let review = db
        .pending()
        .unwrap()
        .into_iter()
        .find(|e| e.kind.as_u16() == 7368)
        .unwrap();
    assert_eq!(
        reviews::parse_profile(&review, &target, listing::now())
            .unwrap()
            .rating,
        5.
    );
    for private in [
        maker_id,
        message.id,
        t.mint,
        t.provider.key.to_hex(),
        event.id.to_hex(),
    ] {
        assert!(!review.as_json().contains(&private));
    }
}
#[test]
fn cashu_requires_two_distinct_signers_and_binds_the_selected_outputs() {
    let buyer = SecretKey::generate();
    let seller = SecretKey::generate();
    let provider = SecretKey::generate();
    let mut t = terms();
    t.buyer_key = buyer.public_key();
    t.seller_key = seller.public_key();
    t.provider = Provider::authorize(&Keys::generate(), provider.public_key());
    let id = "009a1f293253e41e".parse().unwrap();
    let proof = cashu::Proof::new(
        64.into(),
        id,
        t.conditions().unwrap().try_into().unwrap(),
        SecretKey::generate().public_key(),
    );
    let out = cashu::BlindedMessage::new(63.into(), id, SecretKey::generate().public_key());
    let unsigned = cashu::SwapRequest::new(vec![proof], vec![out]);
    for (one, two) in [(&buyer, &seller), (&buyer, &provider), (&seller, &provider)] {
        let mut tx = unsigned.clone();
        tx.sign_sig_all(one.clone()).unwrap();
        assert!(tx.verify_spending_conditions().is_err());
        tx.sign_sig_all(two.clone()).unwrap();
        tx.verify_spending_conditions().unwrap();
        tx.outputs_mut()[0].blinded_secret = SecretKey::generate().public_key();
        assert!(tx.verify_spending_conditions().is_err());
    }
}
