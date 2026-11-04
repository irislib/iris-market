use super::super::ProtocolDecryptedMessage;
use super::*;
use nostr::{JsonUtil, Keys};

fn id(n: u32) -> EventId {
    let mut bytes = [0u8; 32];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    EventId::from_byte_array(bytes)
}

struct Trade {
    chat: Messaging,
    buyer: PublicKey,
    provider: PublicKey,
    deal: Value,
    dir: tempfile::TempDir,
}

impl Trade {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let chat = Messaging::open(dir.path(), Keys::generate()).unwrap();
        let buyer = Keys::generate().public_key();
        let provider = Keys::generate().public_key();
        let deal = json!({
            "title":"Lamp","sats":120,"buyer":buyer,"funder":buyer,"taker":buyer,
            "seller":chat.owner,"beneficiary":chat.owner,"maker":chat.owner,"provider":provider,
            "listing_id":"lamp","revision":id(73),"mint":"https://mint.example",
        });
        Self {
            chat,
            buyer,
            provider,
            deal,
            dir,
        }
    }

    fn step(&self, action: &str) -> Value {
        let mut step = json!({"v":1,"trade_id":id(0),"action":action});
        if action == "invite" {
            step["deal"] = self.deal.clone();
        } else {
            step["deal_hash"] = invitation_hash(&self.deal).into();
        }
        step
    }

    fn send_join(&mut self) {
        self.chat
            .send_trade_step([self.buyer, self.provider].into(), id(2), self.step("join"))
            .unwrap();
    }

    fn receive(&mut self, actor: PublicKey, op: u32, step: &Value) {
        let rumor = rumor(actor, self.chat.owner, id(op), step);
        self.chat
            .transaction(|chat| {
                chat.receive_trade_step(actor, &rumor);
                Ok(())
            })
            .unwrap();
    }

    fn rows(&self) -> usize {
        self.chat.state.trade_steps.len()
    }
}

fn rumor(author: PublicKey, recipient: PublicKey, op: EventId, step: &Value) -> UnsignedEvent {
    let mut event = EventBuilder::new(Kind::from(14), "Private escrow update")
        .tags([
            Tag::public_key(recipient),
            Tag::parse([TAG, "1", &op.to_hex(), &step.to_string()]).unwrap(),
        ])
        .build(author);
    event.ensure_id();
    event
}

#[test]
fn trade_fanout_is_durable_and_retries_do_not_reassign_an_operation() {
    let mut t = Trade::new();
    let step = t.step("join");
    let peers = BTreeSet::from([t.buyer, t.provider]);
    t.send_join();
    let rows = t.chat.trade_steps(true);
    assert_eq!(rows.len(), 2);
    for record in &t.chat.state.trade_steps {
        let queued = &t.chat.state.pending_contact_messages[&record.id.to_hex()];
        assert!(peers.contains(&record.peer));
        assert_eq!(queued.peer_id, record.peer.to_hex());
        assert_eq!(queued.rumor.pubkey, t.chat.owner);
        assert!(queued.rumor.tags.public_keys().copied().eq([record.peer]));
        assert!(queued.rumor.verify_id().is_ok());
    }
    let keys = t.chat.keys.clone();
    drop(t.chat);
    let mut chat = Messaging::open(t.dir.path(), keys).unwrap();
    chat.send_trade_step(peers.clone(), id(2), step.clone())
        .unwrap();
    assert!(
        chat.send_trade_step([t.buyer].into(), id(2), step.clone())
            .is_err()
    );
    let mut changed = step;
    changed["action"] = "approve".into();
    assert!(chat.send_trade_step(peers, id(2), changed).is_err());
    assert_eq!(chat.trade_steps(true), rows);
    assert_eq!(chat.state.pending_contact_messages.len(), 2);
}

#[test]
fn an_incoming_trade_requires_the_authenticated_author_and_its_intended_recipient() {
    let mut t = Trade::new();
    let outsider = Keys::generate().public_key();
    let invitation = t.step("invite");
    let receive = |chat: &mut Messaging, event: &UnsignedEvent, sender: PublicKey| {
        chat.apply_delivery(ProtocolDecryptedMessage {
            sender,
            sender_device: Some(sender),
            conversation_owner: None,
            created_at_secs: event.created_at.as_secs(),
            content: event.as_json(),
            event_id: None,
        })
    };
    let valid = rumor(t.buyer, t.chat.owner, id(1), &invitation);
    assert!(receive(&mut t.chat, &valid, outsider).is_err());
    let wrong_recipient = rumor(t.buyer, outsider, id(1), &invitation);
    receive(&mut t.chat, &wrong_recipient, t.buyer).unwrap();
    t.receive(outsider, 1, &invitation);
    assert_eq!(t.rows(), 0);
    receive(&mut t.chat, &valid, t.buyer).unwrap();
    receive(&mut t.chat, &valid, t.buyer).unwrap();
    assert_eq!(t.rows(), 1);
}

#[test]
fn joined_trade_admits_out_of_order_keys_and_only_pinned_participants_and_funder() {
    let mut t = Trade::new();
    let outsider = Keys::generate().public_key();
    let join = t.step("join");
    let mut funding = t.step("funded");
    funding["token"] = "synthetic confidential payment".into();
    t.receive(t.provider, 1, &join);
    t.receive(t.buyer, 3, &funding);
    assert_eq!(t.rows(), 1);
    let mut fake = t.step("invite");
    for role in ["taker", "buyer", "funder"] {
        fake["deal"][role] = json!(outsider);
    }
    t.receive(outsider, 4, &fake);
    t.receive(t.buyer, 5, &t.step("invite"));
    t.send_join();
    let joined = t.rows();
    assert_eq!(joined, 5);
    t.receive(outsider, 6, &funding);
    t.receive(t.provider, 7, &funding);
    let mut other_commitment = funding.clone();
    other_commitment["deal_hash"] = json!(invitation_hash(&fake["deal"]));
    t.receive(t.buyer, 8, &other_commitment);
    let mut amended = t.step("invite");
    amended["deal"]["sats"] = 121.into();
    t.receive(t.buyer, 9, &amended);
    assert_eq!(t.rows(), joined);
    t.receive(t.buyer, 10, &funding);
    t.receive(t.buyer, 10, &funding);
    t.receive(t.buyer, 11, &funding); // Same payload re-sent under a fresh operation.
    assert_eq!(t.rows(), joined + 1);
    assert_eq!(t.chat.trade_steps(true).last().unwrap()["step"], funding);
    assert!(
        !t.chat
            .trade_steps(false)
            .iter()
            .any(|r| r["step"].get("token").is_some())
    );
    assert!(
        t.chat
            .state
            .trade_steps
            .iter()
            .any(|r| r.peer == t.provider && r.step == join)
    );
}

#[test]
fn summary_omits_private_fields_and_malformed_or_oversized_deal_values() {
    let mut t = Trade::new();
    let mut invite = t.step("invite");
    invite["deal"]["listing_id"] = json!({"proof":"private"});
    invite["deal"]["revision"] = json!(10);
    invite["deal"]["mint"] = json!("x".repeat(2049));
    invite["deal"]["sats"] = json!(1_000_000_000_001u64);
    invite["deal"]["extra"] = json!({"proof":"private"});
    invite["swap"] = json!({"proof":"private"});
    // Older journal rows can predate current validation. They still need a safe summary.
    t.chat.state.trade_steps.push(Record {
        id: id(1),
        operation_id: id(2),
        peer: t.buyer,
        mine: false,
        created_at: now(),
        step: invite.clone(),
    });
    let summary = t.chat.trade_steps(false).remove(0);
    let deal = &summary["step"]["deal"];
    assert_eq!(deal["title"], "Lamp");
    assert_eq!(deal["seller"], json!(t.chat.owner));
    for key in ["listing_id", "revision", "mint", "sats", "extra"] {
        assert!(deal.get(key).is_none());
    }
    assert!(summary["step"].get("swap").is_none());
    assert_eq!(t.chat.trade_steps(true)[0]["step"], invite);
}

#[test]
fn pending_admission_bounds_size_and_evicts_by_arrival_without_removing_joined_trades() {
    let mut t = Trade::new();
    t.receive(t.buyer, 1, &t.step("invite"));
    t.send_join();
    let joined_rows = t.chat.trade_steps(true);
    let mut join = t.step("join");
    join["trade_id"] = json!(id(5));
    join["padding"] = json!("x".repeat(MAX_PENDING_STEP));
    t.receive(t.buyer, 10, &join);
    assert_eq!(t.rows(), joined_rows.len());
    join.as_object_mut().unwrap().remove("padding");
    for n in 0..=MAX_PENDING_ROWS as u32 {
        join["trade_id"] = json!(id(n + 10));
        t.receive(t.buyer, n + 10, &join);
    }
    let rows = t.chat.trade_steps(true);
    assert_eq!(&rows[..joined_rows.len()], &joined_rows);
    assert_eq!(rows.len(), joined_rows.len() + MAX_PENDING_ROWS);
    assert_eq!(rows[joined_rows.len()]["step"]["trade_id"], json!(id(11)));
    assert_eq!(rows.last().unwrap()["step"], join);
}

#[test]
fn receipt_hint_requires_recipient_and_corroborating_dispute_signature() {
    let mut t = Trade::new();
    t.receive(t.buyer, 1, &t.step("invite"));
    t.send_join();
    let local = [t.buyer, t.provider].into();
    let action = |name: &str| {
        let mut s = t.step(name);
        s["terms_hash"] = id(11).to_hex().into();
        s
    };
    let approve = action("approve");
    let funded = action("funded");
    let dispute = action("dispute");
    let directed = |name: &str| {
        let mut s = action(name);
        s["direction"] = "refund".into();
        s
    };
    let payout = directed("payout");
    let settled = directed("settled");
    let cosign = directed("cosign");
    t.chat.send_trade_step(local, id(3), approve).unwrap();
    t.receive(t.buyer, 4, &funded);
    t.receive(t.buyer, 5, &payout);
    t.receive(t.provider, 6, &settled);
    t.receive(t.provider, 7, &cosign);
    assert!(t.chat.trade_steps(false)[0]["step"]["outcome"].is_null());
    t.receive(t.buyer, 9, &dispute);
    assert_eq!(t.chat.trade_steps(false)[0]["step"]["outcome"], "disputed");
    t.receive(t.buyer, 8, &settled);
    assert_eq!(t.chat.trade_steps(false)[0]["step"]["outcome"], "refund");
}

#[test]
fn provider_declines_and_discussion_stay_with_the_exact_trade() {
    let mut t = Trade::new();
    let invitation = t.step("invite");
    t.receive(t.buyer, 90, &invitation);
    let outsider = Keys::generate().public_key();
    let decline = t.step("decline");
    t.receive(outsider, 91, &decline);
    assert!(t.chat.trade_steps(false)[0]["step"]["outcome"].is_null());
    t.receive(t.provider, 92, &decline);
    assert_eq!(t.chat.trade_steps(false)[0]["step"]["outcome"], "declined");

    let mut t = Trade::new();
    let invitation = t.step("invite");
    t.receive(t.buyer, 90, &invitation);
    t.send_join();
    let mut comment = t.step("comment");
    comment["text"] = json!("When can we collect the lamp?");
    comment["message_id"] = json!(id(55));
    let peers = BTreeSet::from([t.buyer, t.provider]);
    assert!(
        t.chat
            .send_trade_step(peers.clone(), id(9), comment.clone())
            .is_err()
    );
    t.receive(t.provider, 93, &t.step("join"));
    t.receive(t.buyer, 94, &t.step("join"));
    assert!(
        t.chat
            .send_trade_step([outsider, t.buyer].into(), id(9), comment.clone())
            .is_err()
    );
    t.chat
        .send_trade_step(peers, id(9), comment.clone())
        .unwrap();
    let count = t.rows();
    t.receive(outsider, 95, &comment);
    assert_eq!(t.rows(), count);
    for i in 0..3 {
        comment["message_id"] = json!(id(100 + i));
        t.receive(t.provider, 100 + i, &comment);
    }
    t.receive(t.provider, 111, &comment);
    assert_eq!(t.rows(), count + 3);
    assert!(
        !json!(t.chat.trade_steps(false))
            .to_string()
            .contains("collect the lamp")
    );
    assert!(
        json!(t.chat.trade_steps(true))
            .to_string()
            .contains("collect the lamp")
    );
}

#[test]
fn three_ratchets_keep_the_trade_room_and_private_provider_dm_separate() {
    let dirs = [
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    ];
    let mut chats = dirs
        .each_ref()
        .map(|dir| Messaging::open(dir.path(), Keys::generate()).unwrap());
    let owners = chats.each_ref().map(|c| c.owner);
    let flush = |chats: &mut [Messaging; 3]| {
        for _ in 0..20 {
            let mut events = Vec::new();
            for (sender, c) in chats.iter_mut().enumerate() {
                c.retry().unwrap();
                events.extend(c.pending_outbound().into_iter().map(|e| (sender, e)));
            }
            if events.is_empty() {
                return;
            }
            for (sender, e) in events {
                for secret in ["shared collection time", "private access code"] {
                    assert!(!e.as_json().contains(secret));
                }
                for (i, c) in chats.iter_mut().enumerate() {
                    if i != sender {
                        c.receive(&e).unwrap();
                    }
                }
                chats[sender].acknowledge_published(&e.id.to_hex()).unwrap();
            }
        }
        panic!("Local ratchet delivery did not settle");
    };
    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        let invite = chats[b].invite().unwrap();
        chats[a].accept_invite(&invite).unwrap();
        flush(&mut chats);
    }
    let deal = json!({"buyer":owners[0],"seller":owners[1],"provider":owners[2],"funder":owners[0],"beneficiary":owners[1],"taker":owners[0],"maker":owners[1]});
    let request = json!({"v":1,"action":"invite","trade_id":id(444),"deal":deal});
    let others = |i: usize| {
        owners
            .into_iter()
            .filter(|p| *p != owners[i])
            .collect::<BTreeSet<_>>()
    };
    chats[0]
        .send_trade_step(others(0), id(401), request)
        .unwrap();
    flush(&mut chats);
    for (i, c) in chats.iter_mut().enumerate() {
        c.send_trade_step(
            others(i),
            id(402 + i as u32),
            json!({"v":1,"action":"join","trade_id":id(444),"deal_hash":invitation_hash(&deal)}),
        )
        .unwrap();
    }
    flush(&mut chats);
    let comment = json!({"v":1,"action":"comment","trade_id":id(444),"deal_hash":invitation_hash(&deal),"message_id":id(499),"text":"shared collection time"});
    chats[1]
        .send_trade_step(others(1), id(410), comment)
        .unwrap();
    chats[0]
        .send(&owners[2].to_hex(), "private access code")
        .unwrap();
    flush(&mut chats);
    for (i, c) in chats.iter().enumerate() {
        assert!(
            json!(c.trade_steps(true))
                .to_string()
                .contains("shared collection time")
        );
        assert!(
            !json!(c.trade_steps(false))
                .to_string()
                .contains("shared collection time")
        );
        let ordinary = json!(c.conversations()).to_string();
        assert!(!ordinary.contains("shared collection time"));
        assert_eq!(ordinary.contains("private access code"), i != 1);
    }
}
