//! Public, account-independent updates. Never shares a profile's keys or inbox.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use hashtree_updater::{
    DownloadOptions, SecurePubsubBlossomConfig, UpdateCheck, UpdateCheckOptions, UpdateEventCache,
    UpdateManifest, UpdateRef, UpdateTarget, build_secure_pubsub_blossom_updater,
    current_archive_target, write_downloaded_asset,
};
use nostr::JsonUtil;
use nostr_pubsub::InMemoryEventBus;
use nostr_pubsub_relay::RelayEventBus;
use serde::Serialize;

pub const UPDATE_REF: &str = "htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Firis-market/latest";
pub const CURRENT_VERSION: &str = match option_env!("MARKET_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const WINDOW: Duration = Duration::from_secs(8);
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub asset: String,
    pub verified: bool,
    pub release_cid: String,
    pub path: Option<String>,
}

pub struct Updater {
    directory: PathBuf,
    current_version: String,
    app: bool,
    selected: Option<UpdateCheck>,
}

impl Updater {
    pub fn new(directory: PathBuf, current_version: String, app: bool) -> Self {
        Self {
            directory,
            current_version,
            app,
            selected: None,
        }
    }

    /// Call off the UI thread. A failed refresh invalidates the old offer.
    pub fn check(&mut self) -> Result<UpdateInfo> {
        self.selected = None;
        let checked = on_worker(|| self.check_async())?;
        let info = self.info(&checked, None);
        self.selected = Some(checked);
        Ok(info)
    }

    pub fn download(&self, directory: &Path) -> Result<UpdateInfo> {
        let check = self
            .selected
            .as_ref()
            .context("Check for updates before downloading")?;
        ensure!(check.update_available, "Iris Market is already up to date");
        // Download the immutable release offered by check(), without rediscovery.
        let downloaded = on_worker(|| async {
            let updater =
                build_secure_pubsub_blossom_updater(Arc::new(InMemoryEventBus::new()), config())
                    .await?;
            tokio::time::timeout(
                Duration::from_secs(180),
                updater.download(
                    check,
                    DownloadOptions {
                        max_size: Some(MAX_DOWNLOAD),
                        ..Default::default()
                    },
                    None,
                ),
            )
            .await
            .context("Update download timed out")?
            .map_err(Into::into)
        })?;
        let asset = check.asset.as_ref().context("No update selected")?;
        // Exact canonical filenames are selected below; never accept a remote path.
        ensure!(
            Path::new(&asset.name).file_name().and_then(|s| s.to_str())
                == Some(asset.name.as_str()),
            "Invalid update filename"
        );
        fs::create_dir_all(directory)?;
        let destination = directory.join(&asset.name);
        save_download(&destination, &downloaded.bytes)?;
        Ok(self.info(check, Some(destination)))
    }

    fn info(&self, check: &UpdateCheck, path: Option<PathBuf>) -> UpdateInfo {
        UpdateInfo {
            current_version: self.current_version.clone(),
            latest_version: check.manifest.effective_version(),
            available: check.update_available,
            asset: check
                .asset
                .as_ref()
                .map(|a| a.name.clone())
                .unwrap_or_default(),
            verified: true,
            release_cid: check.release_cid.to_string(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
        }
    }

    async fn check_async(&self) -> Result<UpdateCheck> {
        fs::create_dir_all(&self.directory)?;
        let reference = UpdateRef::parse(UPDATE_REF)?;
        let cache_path = self.directory.join("announcement.json");
        // Serialize watermark writers across processes without touching the profile.
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.directory.join("check.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock).context("Another update check is running")?;
        let cache = load_cache(&cache_path, &reference)?;
        let bus = RelayEventBus::new(
            [
                "wss://temp.iris.to",
                "wss://vault.iris.to",
                "wss://relay.damus.io",
            ],
            WINDOW,
        )
        .await?;
        let result = async {
            let updater =
                build_secure_pubsub_blossom_updater(Arc::new(bus.clone()), config()).await?;
            for event in cache.resolver_events() {
                updater.resolver().ingest_event(event).await?;
            }
            let checked = tokio::time::timeout(
                Duration::from_secs(35),
                updater.check(UpdateCheckOptions {
                    reference: reference.clone(),
                    current_version: self.current_version.clone(),
                    target: UpdateTarget::new(current_target()),
                    ..Default::default()
                }),
            )
            .await;
            // Keep newer signed roots even when their manifest cannot be downloaded.
            if let Some(event) = updater
                .resolver()
                .latest_event(&reference.resolver_key())
                .await?
            {
                write_downloaded_asset(&cache_path, event.as_json().as_bytes())?;
            }
            let mut check = checked.context("Update check timed out")??;
            check.asset = Some(select_asset(&check.manifest, current_target(), self.app)?);
            Ok(check)
        }
        .await;
        bus.client().shutdown().await;
        result
    }
}

fn save_download(destination: &Path, verified_bytes: &[u8]) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            // Reopening a verified download after restarting the app is safe
            // only when it still contains the exact authenticated bytes.
            ensure!(
                metadata.is_file()
                    && metadata.len() == verified_bytes.len() as u64
                    && fs::read(destination)? == verified_bytes,
                "A different file already exists at the download location"
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_downloaded_asset(destination, verified_bytes)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn current_target() -> &'static str {
    // Market's Linux release uses glibc, unlike the library's musl default.
    if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        "x86_64-unknown-linux-gnu"
    } else {
        current_archive_target()
    }
}

fn load_cache(path: &Path, reference: &UpdateRef) -> Result<UpdateEventCache> {
    let mut cache = UpdateEventCache::new(reference)?;
    match fs::read(path) {
        Ok(bytes) => {
            ensure!(
                bytes.len() <= 64 * 1024,
                "Update announcement cache is too large"
            );
            let event =
                nostr::Event::from_json(bytes).context("Invalid saved update announcement")?;
            ensure!(
                cache.ingest_event(event)?,
                "Saved announcement does not match this update channel"
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(cache)
}

fn config() -> SecurePubsubBlossomConfig {
    SecurePubsubBlossomConfig {
        blossom_read_servers: [
            "https://cdn.iris.to",
            "https://upload.iris.to",
            "https://blossom.primal.net",
        ]
        .map(String::from)
        .to_vec(),
        manifest_timeout: WINDOW,
        download_timeout: Duration::from_secs(180),
    }
}

fn select_asset(
    manifest: &UpdateManifest,
    target: &str,
    app: bool,
) -> Result<hashtree_updater::UpdateAsset> {
    let version = manifest.effective_version();
    let suffix = if app {
        match target {
            "aarch64-apple-darwin" => "macos-arm64.zip".to_string(),
            "aarch64-linux-android" => "android-arm64.apk".to_string(),
            "x86_64-unknown-linux-gnu" => "linux-x64.deb".to_string(),
            _ => anyhow::bail!("No Iris Market app update is available for this platform"),
        }
    } else {
        let extension = if target.contains("windows") {
            "zip"
        } else {
            "tar.gz"
        };
        format!("cli-{target}.{extension}")
    };
    let name = format!("iris-market-v{version}-{suffix}");
    let asset = manifest
        .assets
        .iter()
        .find(|a| a.name == name)
        .context("This release has no compatible Iris Market update")?;
    asset.validate()?;
    ensure!(
        asset.target_values().is_empty() || asset.matches_target(&UpdateTarget::new(target)),
        "Update target does not match this device"
    );
    ensure!(
        manifest.assets.iter().filter(|a| a.name == name).count() == 1,
        "Ambiguous update artifact"
    );
    Ok(asset.clone())
}

// Native cooperative executors have small stacks. Construct and poll futures
// on a dedicated worker; this also works when called from another Tokio runtime.
fn on_worker<T: Send, F: std::future::Future<Output = Result<T>>>(
    operation: impl FnOnce() -> F + Send,
) -> Result<T> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("market-update".into())
            .stack_size(4 * 1024 * 1024)
            .spawn_scoped(scope, || {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?
                    .block_on(operation())
            })?
            .join()
            .map_err(|_| anyhow::anyhow!("Update worker stopped unexpectedly"))?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashtree_updater::UpdateAsset;

    fn manifest() -> UpdateManifest {
        UpdateManifest {
            tag: Some("v0.1.4-alpha.6".into()),
            assets: [
                "cli-aarch64-apple-darwin.tar.gz",
                "cli-x86_64-unknown-linux-gnu.tar.gz",
                "ios.ipa",
                "macos-arm64.zip",
                "android-arm64.apk",
                "linux-x64.deb",
            ]
            .map(|suffix| UpdateAsset {
                name: format!("iris-market-v0.1.4-alpha.6-{suffix}"),
                path: format!("assets/{suffix}"),
                ..Default::default()
            })
            .to_vec(),
            ..Default::default()
        }
    }

    #[test]
    fn selects_app_and_architecture_without_confusing_cli_archives() {
        let m = manifest();
        for (target, suffix) in [
            ("aarch64-apple-darwin", "macos-arm64.zip"),
            ("aarch64-linux-android", "android-arm64.apk"),
            ("x86_64-unknown-linux-gnu", "linux-x64.deb"),
        ] {
            assert!(
                select_asset(&m, target, true)
                    .unwrap()
                    .name
                    .ends_with(suffix)
            );
        }
        assert!(
            select_asset(&m, "aarch64-apple-darwin", false)
                .unwrap()
                .name
                .contains("cli-")
        );
        assert!(select_asset(&m, "x86_64-apple-darwin", true).is_err());
        assert!(select_asset(&m, "aarch64-apple-ios", true).is_err());
    }

    #[test]
    fn alpha_versions_advance_but_equal_and_older_releases_do_not() {
        let m = manifest();
        assert!(m.is_newer_than("0.1.4-alpha.5").unwrap());
        assert!(!m.is_newer_than("0.1.4-alpha.6").unwrap());
        assert!(!m.is_newer_than("0.1.4").unwrap());
    }

    #[test]
    fn refuses_ambiguous_mismatched_or_unsafe_assets() {
        let mut m = manifest();
        m.assets[3].target = Some("x86_64-apple-darwin".into());
        assert!(select_asset(&m, "aarch64-apple-darwin", true).is_err());
        m.assets[3].target = None;
        m.assets[3].path = "../update.zip".into();
        assert!(select_asset(&m, "aarch64-apple-darwin", true).is_err());
        let mut m = manifest();
        m.assets.push(m.assets[3].clone());
        assert!(select_asset(&m, "aarch64-apple-darwin", true).is_err());
    }

    #[test]
    fn download_requires_a_successful_check() {
        let dir = tempfile::tempdir().unwrap();
        let updater = Updater::new(dir.path().into(), "0.1.4-alpha.5".into(), true);
        assert!(updater.download(dir.path()).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn repeated_download_reuses_identical_bytes_without_overwriting_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("update.zip");
        save_download(&path, b"verified").unwrap();
        save_download(&path, b"verified").unwrap();
        fs::write(&path, b"changed!").unwrap();
        assert!(save_download(&path, b"verified").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"changed!");
        #[cfg(unix)]
        {
            let link = directory.path().join("link.zip");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(save_download(&link, b"changed!").is_err());
        }
    }

    #[test]
    fn saved_announcements_are_verified_and_bound_to_the_publisher() {
        use nostr::{EventBuilder, Keys, Kind, Tag, TagKind, Timestamp, ToBech32};
        let keys = Keys::generate();
        let reference = UpdateRef {
            npub: keys.public_key().to_bech32().unwrap(),
            tree_name: "releases/iris-market".into(),
            path: Some("latest".into()),
        };
        let event = EventBuilder::new(Kind::Custom(30064), "")
            .tags([
                Tag::identifier(&reference.tree_name),
                Tag::custom(TagKind::Custom("l".into()), ["hashtree"]),
                Tag::custom(TagKind::Custom("hash".into()), ["ab".repeat(32)]),
            ])
            .custom_created_at(Timestamp::from(100))
            .sign_with_keys(&keys)
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("announcement.json");
        fs::write(&path, event.as_json()).unwrap();
        assert_eq!(
            load_cache(&path, &reference)
                .unwrap()
                .latest()
                .unwrap()
                .as_event()
                .id,
            event.id
        );
        let other = UpdateRef {
            npub: Keys::generate().public_key().to_bech32().unwrap(),
            ..reference.clone()
        };
        assert!(load_cache(&path, &other).is_err());
        let mut tampered = serde_json::to_value(&event).unwrap();
        tampered["content"] = serde_json::json!("tampered");
        fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(load_cache(&path, &reference).is_err());
    }
}
