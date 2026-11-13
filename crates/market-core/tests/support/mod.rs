use iris_market_core::public_cache::PublicEventCache;
use nostr::{EventBuilder, Keys, Kind, PublicKey, Tag};
use std::path::Path;

pub fn cache_follows(dir: &Path, owner: &Keys, follows: &[PublicKey]) {
    let event = EventBuilder::new(Kind::ContactList, "")
        .tags(follows.iter().copied().map(Tag::public_key))
        .sign_with_keys(owner)
        .unwrap();
    PublicEventCache::open(&dir.join("public-events.sqlite"))
        .unwrap()
        .ingest(&event)
        .unwrap();
}
