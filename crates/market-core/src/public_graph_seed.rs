//! Restore a retained discovery seed or fetch one signed mobile projection for a
//! fresh default profile. Only ranking uses this seed. Signed local opinions and
//! account trust stay in Profiles' existing evidence store.
use super::{Settings, State, profiles::DEFAULT_ROOT};
use nostr_social_graph::{MOBILE_MIN_USERS, SocialGraph, public_snapshot};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub(crate) async fn run(state: Arc<Mutex<State>>, notify: Arc<Notify>, stopped: Arc<AtomicBool>) {
    let (cached, relays, may_download) = {
        let s = state.lock().unwrap();
        let Ok(cached) = s.store.public_graph_seed() else {
            return;
        };
        (
            cached,
            s.settings.relays.clone(),
            s.profiles.needs_public_seed(),
        )
    };
    if let Some(stored) = cached {
        if let Some(bytes) = stored {
            let result = tokio::task::spawn_blocking(move || {
                SocialGraph::from_mobile_binary(DEFAULT_ROOT, &bytes, MOBILE_MIN_USERS)
            })
            .await;
            if let Ok(Ok(graph)) = result {
                let mut s = state.lock().unwrap();
                s.profiles.accept_public_seed(graph);
                s.revision += 1;
            }
        }
        return;
    }
    if !may_download || !default_relays(&relays) || stopped.load(Ordering::Acquire) {
        return;
    }
    let read = public_snapshot::fetch(DEFAULT_ROOT, MOBILE_MIN_USERS);
    tokio::pin!(read);
    let result = loop {
        tokio::select! {
            biased;
            _ = notify.notified() => {
                if stopped.load(Ordering::Acquire) || state.lock().unwrap().settings.relays != relays {return;}
            },
            result = &mut read => break result,
        }
    };
    let Ok(seed) = result else { return };
    let mut s = state.lock().unwrap();
    if stopped.load(Ordering::Acquire)
        || s.settings.relays != relays
        || s.profiles.home_root() != DEFAULT_ROOT
    {
        return;
    }
    if s.store
        .store_new_public_graph_seed(&seed.bytes)
        .unwrap_or(false)
    {
        s.profiles.accept_public_seed(seed.graph);
        s.revision += 1;
    }
}

fn default_relays(relays: &[String]) -> bool {
    use std::collections::BTreeSet;
    let normalized = |urls: &[String]| {
        urls.iter()
            .map(|url| url.trim_end_matches('/').to_owned())
            .collect::<BTreeSet<_>>()
    };
    normalized(relays) == normalized(&Settings::default().relays)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{profiles::Profiles, store::Store};
    use nostr_social_graph::NostrEvent;

    #[test]
    fn projection_changes_ranking_without_granting_personal_trust() {
        let uid = "a".repeat(64);
        let mut graph = SocialGraph::new(DEFAULT_ROOT);
        graph.handle_event(
            &NostrEvent {
                kind: 3,
                pubkey: DEFAULT_ROOT.into(),
                id: "b".repeat(64),
                created_at: 1,
                content: String::new(),
                sig: String::new(),
                tags: vec![vec!["p".into(), uid.clone()]],
            },
            true,
            f64::INFINITY,
        );
        graph.recalculate_follow_distances();
        let mut profiles = Profiles::default();
        assert!(profiles.needs_public_seed());
        profiles.accept_public_seed(graph);
        assert_eq!(profiles.home_relation(&uid).0, Some(1));
        assert_eq!(profiles.connection(&uid).follow_distance, None);
        assert!(!profiles.needs_public_seed());
    }

    #[test]
    fn cached_or_malformed_records_win_over_a_new_public_seed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("market.sqlite");
        let store = Store::open(&path).unwrap();
        assert!(store.public_graph_seed().unwrap().is_none());
        assert!(store.store_new_public_graph_seed(b"old").unwrap());
        assert!(!store.store_new_public_graph_seed(b"replacement").unwrap());
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.public_graph_seed().unwrap(),
            Some(Some(b"old".to_vec()))
        );
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute(
            "UPDATE preferences SET value=zeroblob(?1) WHERE key='public-graph-v4'",
            [nostr_social_graph::MOBILE_MAX_BYTES + 1],
        )
        .unwrap();
        assert_eq!(store.public_graph_seed().unwrap(), Some(None));
        assert!(!store.store_new_public_graph_seed(b"replacement").unwrap());
    }

    #[test]
    fn only_the_shipped_relay_selection_admits_a_public_request() {
        let mut defaults = Settings::default().relays;
        defaults.reverse();
        for relay in &mut defaults {
            relay.push('/');
        }
        assert!(default_relays(&defaults));
        assert!(!default_relays(&[]));
        assert!(!default_relays(&["wss://custom.example".into()]));
    }
}
