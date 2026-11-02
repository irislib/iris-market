//! Exercise the public command boundary, encrypted transport and public outbox offline.
use iris_market_core::{Market, listing, messaging::Messaging, model::Settings, store::Store};
use nostr::{JsonUtil, Keys, nips::nip19::ToBech32};
use serde_json::{Value, json};
use std::path::Path;
use tempfile::tempdir;

fn offline(path: &Path, keys: &Keys) -> Market {
    Store::open(&path.join("market.sqlite"))
        .unwrap()
        .save_settings(&Settings {
            relays: vec![],
            ..Default::default()
        })
        .unwrap();
    Market::open(path, &keys.secret_key().to_secret_hex(), false).unwrap()
}

fn request(helper: &Keys, side: &str) -> Value {
    json!({"type":"request_friend_post","helper":helper.public_key(),"request":{
        "draft":{"side":side,"title":"Cargo bike","description":"A longtail bike.","category":"Bikes"},
        "allowed_vouches":["know_personally"]
    }})
}

fn policy(sender: &Keys, sides: &[&str]) -> Value {
    json!({"type":"set_friend_post_policy","policy":{
        "allowed_senders":[sender.public_key()], "sides":sides, "categories":["bikes"]
    }})
}

#[test]
fn only_reviewed_copy_crosses_from_private_request_to_public_outbox() {
    for (side, bitcoin) in [("offer", false), ("request", false), ("request", true)] {
        let (origin_dir, helper_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let (origin, helper) = (Keys::generate(), Keys::generate());
        let author = origin.public_key().to_hex();
        let app = offline(origin_dir.path(), &origin);
        let mut post = request(&helper, side);
        if bitcoin {
            let draft = &mut post["request"]["draft"];
            draft["title"] = json!("Bitcoin");
            draft["price"] = json!("25.00");
            draft["currency"] = json!("EUR");
            draft["expires_at"] = json!(listing::now() + 3600);
            draft["escrow"] = json!({"trade":"bitcoin_fiat","sats":30000,"method":"bank_transfer"});
        }
        app.command(&post.to_string()).unwrap();
        drop(app);
        let helper_app = offline(helper_dir.path(), &helper);
        helper_app
            .command(&policy(&origin, &[side]).to_string())
            .unwrap();
        drop(helper_app);

        let mut sender = Messaging::open(origin_dir.path(), origin.clone()).unwrap();
        let mut recipient = Messaging::open(helper_dir.path(), helper.clone()).unwrap();
        sender.retry().unwrap();
        assert!(
            sender.pending_outbound().is_empty(),
            "a chosen helper still needs verified contact evidence"
        );
        sender
            .receive(&recipient.public_contact_event().unwrap())
            .unwrap();
        for _ in 0..8 {
            sender.retry().unwrap();
            for event in sender.pending_outbound() {
                let wire = event.as_json();
                for private in [&author, "Cargo bike", "know_personally"] {
                    assert!(
                        !wire.contains(private),
                        "encrypted delivery must hide the origin and request contents"
                    );
                }
                recipient.receive(&event).unwrap();
                recipient.receive(&event).unwrap();
                sender.acknowledge_published(&event.id.to_hex()).unwrap();
            }
            recipient.retry().unwrap();
            for event in recipient.pending_outbound() {
                sender.receive(&event).unwrap();
                recipient.acknowledge_published(&event.id.to_hex()).unwrap();
            }
        }
        drop((sender, recipient));
        let app = offline(helper_dir.path(), &helper);
        let inbox = app.friend_posts().unwrap();
        let rows = inbox["requests"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row["sender"], author);
        assert_eq!(row["status"], "pending");
        let id = row["id"].as_str().unwrap();
        let snapshot = app.snapshot().unwrap();
        assert!(!snapshot.contains("Cargo bike"));
        let store = Store::open(&helper_dir.path().join("market.sqlite")).unwrap();
        assert!(store.pending().unwrap().is_empty());

        app.command(&policy(&origin, &[]).to_string()).unwrap();
        let accept = json!({"type":"accept_friend_post","id":id, "vouches":["know_personally"]});
        assert!(
            app.command(&accept.to_string())
                .unwrap_err()
                .to_string()
                .contains("policy")
        );
        assert_eq!(
            app.friend_posts().unwrap()["requests"][0]["status"],
            "blocked"
        );
        app.command(&policy(&origin, &[side]).to_string()).unwrap();
        assert!(
            app.command(
                &json!({"type":"accept_friend_post","id":id,"vouches":["traded_before"]})
                    .to_string()
            )
            .is_err()
        );
        assert!(store.pending().unwrap().is_empty());
        app.command(&accept.to_string()).unwrap();
        drop(app);

        let app = offline(helper_dir.path(), &helper);
        app.command(&accept.to_string()).unwrap();
        let row = app.friend_posts().unwrap()["requests"][0].clone();
        assert_eq!(row["status"], "accepted");
        let listing_id = row["listing_id"].as_str().unwrap();
        let event = store.event(listing_id).unwrap();
        let public = listing::parse(&event, listing::now()).unwrap();
        assert_eq!(public.author, helper.public_key().to_hex());
        assert_eq!(public.side, side);
        assert_eq!(
            public.description,
            "Posted for a friend. I know this person personally.\n\nA longtail bike."
        );
        let queued = store.pending().unwrap();
        assert_eq!(
            queued.len(),
            2,
            "one listing and the helper's public contact"
        );
        for event in &queued {
            for private in [
                &author,
                &origin.public_key().to_bech32().unwrap(),
                id,
                "allowed_vouches",
                "allowed_senders",
            ] {
                assert!(!event.as_json().contains(private));
            }
        }
        app.command(&json!({"type":"close","id":listing_id}).to_string())
            .unwrap();
        app.command(&accept.to_string()).unwrap();
        assert_eq!(
            listing::parse(&store.event(listing_id).unwrap(), listing::now())
                .unwrap()
                .status,
            "sold"
        );
        assert!(
            Store::open(&origin_dir.path().join("market.sqlite"))
                .unwrap()
                .pending()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn refuses_identifying_copy_expired_requests_and_preview_actions() {
    let dir = tempdir().unwrap();
    let (origin, helper) = (Keys::generate(), Keys::generate());
    let app = offline(dir.path(), &origin);
    let req = request(&helper, "request");
    for (key, value) in [
        ("description", json!(origin.public_key().to_hex())),
        ("location", json!(origin.public_key().to_bech32().unwrap())),
        (
            "image_url",
            json!("https://example.invalid/identifying-image.jpg"),
        ),
        ("expires_at", json!(listing::now())),
    ] {
        let mut bad = req.clone();
        bad["request"]["draft"][key] = value;
        assert!(app.command(&bad.to_string()).is_err());
    }
    assert!(app.command(&request(&origin, "offer").to_string()).is_err());
    drop(app);
    let dir = tempdir().unwrap();
    let app = Market::open(dir.path(), &origin.secret_key().to_secret_hex(), true).unwrap();
    assert!(app.command(&req.to_string()).is_err());
    assert!(app.friend_posts().is_err());
}
