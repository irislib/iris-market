use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use iris_market_core::{
    messaging::{Messaging, cashu_content},
    model::Listing,
    orders::OrderStatus,
};
use nostr::{JsonUtil, Keys};
use serde_json::json;
use tempfile::TempDir;

fn listing(seller: &Keys) -> Listing {
    serde_json::from_value(json!({"id":format!("{}:delivery",seller.public_key().to_hex()),"author":seller.public_key().to_hex(),"title":"Delivery","description":"","side":"offer","price":"12","currency":"EUR","location":"","category":"transport","image_url":null,"created_at":nostr::Timestamp::now().as_secs(),"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"sent","relevance":null})).unwrap()
}
fn exchange(a: &mut Messaging, b: &mut Messaging) {
    for _ in 0..10 {
        a.retry().unwrap();
        b.retry().unwrap();
        let outgoing_a = a.pending_outbound();
        let outgoing_b = b.pending_outbound();
        if outgoing_a.is_empty() && outgoing_b.is_empty() {
            break;
        }
        for event in outgoing_a {
            b.receive(&event).unwrap();
            a.acknowledge_published(&event.id.to_hex()).unwrap();
        }
        for event in outgoing_b {
            a.receive(&event).unwrap();
            b.acknowledge_published(&event.id.to_hex()).unwrap();
        }
    }
}

#[test]
fn durable_local_order_actual_ndr_seller_accept_and_courier_route() {
    let bd = TempDir::new().unwrap();
    let sd = TempDir::new().unwrap();
    let cd = TempDir::new().unwrap();
    let bk = Keys::generate();
    let sk = Keys::generate();
    let ck = Keys::generate();
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    let mut s = Messaging::open(sd.path(), sk.clone()).unwrap();
    let mut c = Messaging::open(cd.path(), ck.clone()).unwrap();
    let id = b.request_order(&listing(&sk), 2, "Ring once").unwrap();
    assert_eq!(b.orders()[0].sync, "queued");
    assert!(b.pending_outbound().is_empty());
    drop(b);
    let mut b = Messaging::open(bd.path(), bk.clone()).unwrap();
    assert_eq!(b.orders()[0].order.id, id);
    b.accept_invite(&s.invite().unwrap()).unwrap();
    exchange(&mut b, &mut s);
    assert_eq!(s.orders()[0].order.items[0].quantity, 2);
    assert_eq!(b.orders()[0].sync, "sent");
    assert_eq!(
        s.conversations()[0].messages[0].order_id.as_deref(),
        Some(id.as_str())
    );
    s.update_order(&id, json!({"status":"accepted"})).unwrap();
    exchange(&mut s, &mut b);
    assert_eq!(b.orders()[0].order.status, OrderStatus::Accepted);
    c.accept_invite(&s.invite().unwrap()).unwrap();
    exchange(&mut c, &mut s);
    c.accept_invite(&b.invite().unwrap()).unwrap();
    exchange(&mut c, &mut b);
    s.update_order(&id,json!({"shipment":{"stops":[{"id":"pickup","label":"Shop","address":"Private collection address","courierPubkey":ck.public_key().to_hex(),"coordinates":[24.94,60.17]}],"trackingUrl":"https://tracking.example/package"}})).unwrap();
    s.retry().unwrap();
    for event in s.pending_outbound() {
        assert!(!event.as_json().contains("Private collection address"));
        assert!(!event.as_json().contains(&id));
    }
    // Deliver relay envelopes to both subscriptions; only the intended session
    // can decrypt each event, matching a relay with independent receive scopes.
    for _ in 0..5 {
        for event in s.pending_outbound() {
            b.receive(&event).unwrap();
            c.receive(&event).unwrap();
            s.acknowledge_published(&event.id.to_hex()).unwrap();
        }
        b.retry().unwrap();
        c.retry().unwrap();
        s.retry().unwrap();
    }
    assert_eq!(c.orders()[0].role.as_deref(), Some("courier"));
    c.update_order(&id, json!({"stopId":"pickup","status":"arrived"}))
        .unwrap();
    c.retry().unwrap();
    for _ in 0..5 {
        for event in c.pending_outbound() {
            b.receive(&event).unwrap();
            s.receive(&event).unwrap();
            c.acknowledge_published(&event.id.to_hex()).unwrap();
        }
        b.retry().unwrap();
        c.retry().unwrap();
        s.retry().unwrap();
    }
    assert_eq!(
        b.orders()[0].order.shipment.stops[0].status,
        iris_market_core::orders::StopStatus::Arrived
    );
    assert!(c.update_order(&id, json!({"status":"delivered"})).is_err());
    let before = c
        .conversations()
        .iter()
        .map(|t| t.messages.len())
        .sum::<usize>();
    c.update_order(&id, json!({"location":null})).unwrap();
    assert_eq!(
        c.conversations()
            .iter()
            .map(|t| t.messages.len())
            .sum::<usize>(),
        before
    );
    c.archive_order(&id, true).unwrap();
    assert!(c.orders()[0].archived);
    let raw = std::fs::read(cd.path().join("private-messages/messages.sqlite3")).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("Private collection address"));
    drop(c);
    let c = Messaging::open(cd.path(), ck).unwrap();
    assert!(c.orders()[0].archived);
}

#[test]
fn unsigned_device_can_durably_queue_but_cannot_publish_order() {
    let dir = TempDir::new().unwrap();
    let owner = Keys::generate();
    let device = Keys::generate();
    let seller = Keys::generate();
    let mut m =
        Messaging::open_identity(dir.path(), owner.public_key(), None, device.clone(), None)
            .unwrap();
    assert!(!m.can_send());
    m.request_order(&listing(&seller), 1, "").unwrap();
    m.retry().unwrap();
    assert!(m.pending_outbound().is_empty());
    assert_eq!(m.orders()[0].sync, "queued");
    drop(m);
    let m = Messaging::open_identity(dir.path(), owner.public_key(), None, device, None).unwrap();
    assert_eq!(m.orders().len(), 1);
    assert_eq!(m.orders()[0].sync, "queued");
}

#[test]
fn cashu_structural_metadata_is_unverified_and_bearer_is_hidden() {
    let token=format!("cashuA{}",URL_SAFE_NO_PAD.encode(json!({"token":[{"mint":"https://mint.example","proofs":[{"amount":8,"id":"009a1f293253e41e","secret":"synthetic-test-only","C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}]}],"unit":"sat"}).to_string()));
    let (text, parsed) = cashu_content(&format!("Here is {token}"));
    assert_eq!(text, "Here is Cashu payment");
    let parsed = parsed.unwrap();
    assert_eq!(parsed.amount, "8");
    assert_eq!(parsed.status, "unverified");
    assert_eq!(parsed.token, token);
    let (text, parsed) = cashu_content("cashuBmalformed");
    assert_eq!(text, "Cashu payment");
    assert!(parsed.is_none());
}
