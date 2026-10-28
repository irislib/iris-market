use iris_chat_protocol::{
    AppKeys, DeviceEntry, InMemoryStorage, ProtocolAcceptInviteOutcome, ProtocolEffect,
    ProtocolEngine,
};
use iris_market_core::{
    identity::{DeviceLink, prepare_registration},
    messaging::Messaging,
};
use nostr::Keys;
use std::sync::Arc;
use tempfile::TempDir;
fn roster(owner: &Keys, devices: &[nostr::PublicKey], time: u64) -> nostr::Event {
    AppKeys::new(
        devices
            .iter()
            .map(|key| DeviceEntry::new(*key, time))
            .collect(),
    )
    .get_event_at(owner.public_key(), time)
    .sign_with_keys(owner)
    .unwrap()
}
#[test]
fn registration_preserves_existing_devices_and_rejects_conflicts() {
    let owner = Keys::generate();
    let first = Keys::generate();
    let second = Keys::generate();
    let time = nostr::Timestamp::now().as_secs();
    let previous = roster(&owner, &[first.public_key()], time);
    let next = prepare_registration(
        owner.public_key(),
        second.public_key(),
        std::slice::from_ref(&previous),
        time,
    )
    .unwrap()
    .sign_with_keys(&owner)
    .unwrap();
    let devices = AppKeys::from_event(&next).unwrap();
    assert!(devices.get_device(&first.public_key()).is_some());
    assert!(devices.get_device(&second.public_key()).is_some());
    let conflict = roster(&owner, &[], time);
    assert!(
        prepare_registration(
            owner.public_key(),
            second.public_key(),
            &[previous, conflict],
            time
        )
        .is_err()
    );
}
#[test]
fn owner_secret_cannot_override_revoked_device_or_restore_stale_approval() {
    let owner = Keys::generate();
    let device = Keys::generate();
    let directory = TempDir::new().unwrap();
    let time = nostr::Timestamp::now().as_secs();
    let approval = roster(&owner, &[device.public_key()], time);
    let mut chat = Messaging::open_identity(
        directory.path(),
        owner.public_key(),
        Some(owner.clone()),
        device.clone(),
        Some(&approval),
    )
    .unwrap();
    assert!(chat.can_send());
    let contact = chat.registered_contact_event().unwrap().unwrap();
    assert_eq!(contact.pubkey, device.public_key());
    assert_eq!(
        contact.kind.as_u16() as u32,
        iris_chat_protocol::INVITE_EVENT_KIND
    );
    chat.ingest_authorization(&roster(&owner, &[], time + 1))
        .unwrap();
    assert!(!chat.can_send());
    assert!(chat.registered_contact_event().unwrap().is_none());
    assert!(chat.invite().is_err());
    assert!(chat.public_contact_event().is_err());
    drop(chat);
    let chat = Messaging::open_identity(
        directory.path(),
        owner.public_key(),
        Some(owner),
        device,
        Some(&approval),
    )
    .unwrap();
    assert!(!chat.can_send());
}
#[test]
fn standard_device_link_needs_private_handshake_and_current_owner_authorization() {
    let owner = Keys::generate();
    let approver = Keys::generate();
    let device = Keys::generate();
    let root = TempDir::new().unwrap();
    let time = nostr::Timestamp::now().as_secs();
    let mut link = DeviceLink::new(
        &device.secret_key().to_secret_hex(),
        None,
        vec!["wss://temp.iris.to".into()],
    )
    .unwrap();
    let bootstrap = link.bootstrap().unwrap();
    let restored = DeviceLink::new(
        &device.secret_key().to_secret_hex(),
        Some(&bootstrap),
        vec!["wss://temp.iris.to".into()],
    )
    .unwrap();
    assert_eq!(link.invitation().unwrap(), restored.invitation().unwrap());
    let proof = roster(&owner, &[device.public_key(), approver.public_key()], time);
    assert!(
        link.apply_approval(root.path(), std::slice::from_ref(&proof))
            .unwrap()
            .is_none()
    );
    let mut chat = ProtocolEngine::load_or_create_for_local_device(
        Arc::new(InMemoryStorage::new()),
        owner.public_key(),
        &approver,
    )
    .unwrap();
    chat.ingest_app_keys_event(&proof).unwrap();
    let ProtocolAcceptInviteOutcome::Accepted(accepted) = chat
        .accept_invite(link.pairing_invite(), Some(device.public_key()))
        .unwrap()
    else {
        panic!("standard pairing rejected")
    };
    for ProtocolEffect::Publish(publish) in accepted.effects {
        link.receive_response(publish.event).unwrap();
    }
    let revoked = roster(&owner, &[approver.public_key()], time + 1);
    assert!(
        link.apply_approval(root.path(), &[revoked])
            .unwrap()
            .is_none()
    );
    assert!(
        link.apply_approval(root.path(), &[proof])
            .unwrap()
            .is_none()
    );
    let renewed = roster(
        &owner,
        &[device.public_key(), approver.public_key()],
        time + 2,
    );
    let approved = link
        .apply_approval(root.path(), &[renewed])
        .unwrap()
        .unwrap();
    assert!(approved.contains(&owner.public_key().to_hex()));
    let chat = Messaging::open_identity(
        &root.path().join(owner.public_key().to_hex()),
        owner.public_key(),
        None,
        device,
        None,
    )
    .unwrap();
    assert!(chat.can_send());
}

#[test]
fn linked_devices_send_without_owner_secret_and_revoke_only_the_actual_destination() {
    let owner = Keys::generate();
    let first = Keys::generate();
    let second = Keys::generate();
    let peer_keys = Keys::generate();
    let first_dir = TempDir::new().unwrap();
    let second_dir = TempDir::new().unwrap();
    let peer_dir = TempDir::new().unwrap();
    let time = nostr::Timestamp::now().as_secs();
    let approval = roster(&owner, &[first.public_key(), second.public_key()], time);
    let mut a = Messaging::open_identity(
        first_dir.path(),
        owner.public_key(),
        None,
        first.clone(),
        Some(&approval),
    )
    .unwrap();
    let mut b = Messaging::open_identity(
        second_dir.path(),
        owner.public_key(),
        None,
        second.clone(),
        Some(&approval),
    )
    .unwrap();
    let mut peer = Messaging::open(peer_dir.path(), peer_keys.clone()).unwrap();
    peer.ingest_authorization(&approval).unwrap();
    // Establish independent peer sessions and an own-device synchronization session.
    a.accept_invite(&peer.invite().unwrap()).unwrap();
    b.accept_invite(&peer.invite().unwrap()).unwrap();
    for device in [&mut a, &mut b] {
        for event in device.pending_outbound() {
            peer.receive(&event).unwrap();
            device.acknowledge_published(&event.id.to_hex()).unwrap();
        }
    }
    a.accept_public_contact_event(
        &b.public_contact_event().unwrap(),
        &owner.public_key().to_hex(),
    )
    .unwrap();
    for event in a.pending_outbound() {
        b.receive(&event).unwrap();
        a.acknowledge_published(&event.id.to_hex()).unwrap();
    }
    a.send(
        &peer_keys.public_key().to_hex(),
        "Linked device without owner key",
    )
    .unwrap();
    let pending = a.pending_outbound();
    assert!(pending.iter().any(|event| {
        event
            .tags
            .public_keys()
            .any(|key| *key == second.public_key())
    }));
    for event in &pending {
        peer.receive(event).unwrap();
        b.receive(event).unwrap();
    }
    assert!(
        peer.conversations()
            .iter()
            .flat_map(|chat| &chat.messages)
            .any(|message| message.text == "Linked device without owner key")
    );
    // The logical conversation peer is unchanged for an own-sibling envelope.
    // Removing the sibling must block that ciphertext while retaining peer delivery.
    a.ingest_authorization(&roster(&owner, &[first.public_key()], time + 1))
        .unwrap();
    assert!(a.can_send());
    let remaining = a.pending_outbound();
    assert!(!remaining.is_empty());
    assert!(!remaining.iter().any(|event| {
        event
            .tags
            .public_keys()
            .any(|key| *key == second.public_key())
    }));
    assert!(remaining.iter().any(|event| {
        event
            .tags
            .public_keys()
            .any(|key| *key == peer_keys.public_key())
    }));
}
