//! Public, account-independent updates. Never shares a profile's keys or inbox.
use std::{
    fmt, fs,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use hashtree_updater::{
    DownloadCallback, DownloadEvent, DownloadOptions, SecurePubsubBlossomConfig, UpdateCheck,
    UpdateCheckOptions, UpdateEventCache, UpdateManifest, UpdateRef, UpdateTarget,
    build_secure_pubsub_blossom_updater, current_archive_target, write_downloaded_asset,
};
use nostr::JsonUtil;
use nostr_pubsub::InMemoryEventBus;
use nostr_pubsub_relay::RelayEventBus;
use serde::Serialize;
use tokio::time::Instant;

pub const UPDATE_REF: &str = "htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Firis-market/latest";
pub const CURRENT_VERSION: &str = match option_env!("MARKET_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const WINDOW: Duration = Duration::from_secs(8);
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

// Shown to people as is. Technical causes stay underneath for the CLI.
pub const CHECK_FAILED: &str = "Couldn't check for updates. Check your connection, then retry.";
pub const CHECK_BUSY: &str = "Another update check is running. Retry in a moment.";
pub const DOWNLOAD_FAILED: &str =
    "Couldn't download the update. Check your connection, then retry.";
pub const DOWNLOAD_STALLED: &str = "The download stopped. Check your connection, then retry.";
pub const SAVE_FAILED: &str = "Couldn't save the update. Free up disk space, then retry.";
pub const UP_TO_DATE: &str = "Iris Market is already up to date.";

/// How long a download may go without new bytes before it counts as stuck.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Finding the file in the release, before the first byte.
    pub start: Duration,
    /// No new bytes while the size is known.
    pub stall: Duration,
    /// Whole download, including sources that report no size.
    pub total: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            start: Duration::from_secs(60),
            stall: Duration::from_secs(45),
            total: Duration::from_secs(30 * 60),
        }
    }
}

/// A sentence safe to show people; generic step messages never replace it.
#[derive(Debug)]
struct Plain(&'static str);

impl fmt::Display for Plain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Plain {}

/// Put a plain sentence on top; the original error stays as its cause.
fn plain(error: anyhow::Error, fallback: &'static str) -> anyhow::Error {
    let message = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<Plain>())
        .map_or(fallback, |plain| plain.0);
    if error.to_string() == message {
        return error;
    }
    error.context(message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Idle,
    Checking,
    /// Finding the release and its file before bytes arrive.
    Fetching,
    Downloading,
    Verifying,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProgressInfo {
    pub stage: Stage,
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Readable while a check or download holds the updater.
#[derive(Debug, Default)]
pub struct Progress {
    stage: AtomicU8,
    downloaded: AtomicU64,
    // Zero means unknown; empty downloads finish without reporting a size.
    total: AtomicU64,
}

impl Progress {
    const STAGES: [Stage; 5] = [
        Stage::Idle,
        Stage::Checking,
        Stage::Fetching,
        Stage::Downloading,
        Stage::Verifying,
    ];

    pub fn snapshot(&self) -> ProgressInfo {
        let stage = Self::STAGES[usize::from(self.stage.load(Ordering::Acquire))];
        let total = self.total.load(Ordering::Acquire);
        ProgressInfo {
            stage,
            downloaded: self.downloaded.load(Ordering::Acquire),
            total: (total > 0).then_some(total),
        }
    }

    fn set(&self, stage: Stage) {
        let index = Self::STAGES.iter().position(|s| *s == stage).unwrap_or(0);
        self.stage.store(index as u8, Ordering::Release);
    }

    pub fn start(&self, stage: Stage) {
        self.downloaded.store(0, Ordering::Release);
        self.total.store(0, Ordering::Release);
        self.set(stage);
    }

    pub fn record(&self, event: &DownloadEvent) {
        match event {
            DownloadEvent::Started { content_length } => {
                self.total
                    .store(content_length.unwrap_or(0), Ordering::Release);
                self.set(Stage::Downloading);
            }
            DownloadEvent::Progress { downloaded, .. } => {
                self.downloaded.store(*downloaded, Ordering::Release);
            }
            DownloadEvent::Finished { total } => {
                self.downloaded.store(*total, Ordering::Release);
                self.set(Stage::Verifying);
            }
        }
    }
}

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
    progress: Arc<Progress>,
    limits: Limits,
}

impl Updater {
    pub fn new(directory: PathBuf, current_version: String, app: bool) -> Self {
        Self {
            directory,
            current_version,
            app,
            selected: None,
            progress: Arc::default(),
            limits: Limits::default(),
        }
    }

    /// Shared progress for the UI; reading it never waits for the updater.
    pub fn progress(&self) -> Arc<Progress> {
        self.progress.clone()
    }

    /// Call off the UI thread. A failed refresh invalidates the old offer.
    pub fn check(&mut self) -> Result<UpdateInfo> {
        self.progress.start(Stage::Checking);
        let result = self.refresh();
        self.progress.set(Stage::Idle);
        result
    }

    fn refresh(&mut self) -> Result<UpdateInfo> {
        self.selected = None;
        let checked = on_worker(|| self.check_async()).map_err(|e| plain(e, CHECK_FAILED))?;
        let info = self.info(&checked, None);
        self.selected = Some(checked);
        Ok(info)
    }

    /// Downloads the release offered by the last check, checking first when
    /// none is held (for example after the helper restarted).
    pub fn download(&mut self, directory: &Path) -> Result<UpdateInfo> {
        self.progress.start(Stage::Fetching);
        let result = self.fetch(directory);
        self.progress.set(Stage::Idle);
        result
    }

    fn fetch(&mut self, directory: &Path) -> Result<UpdateInfo> {
        if self.selected.is_none() {
            self.refresh()?;
            self.progress.set(Stage::Fetching);
        }
        let check = self
            .selected
            .as_ref()
            .context("Check for updates before downloading")?;
        if !check.update_available {
            return Err(Plain(UP_TO_DATE).into());
        }
        let progress = self.progress.clone();
        let limits = self.limits;
        // Download the immutable release offered by check(), without rediscovery.
        let downloaded = on_worker(|| async {
            let updater =
                build_secure_pubsub_blossom_updater(Arc::new(InMemoryEventBus::new()), config())
                    .await?;
            let observer = progress.clone();
            let callback: DownloadCallback = Arc::new(move |event| observer.record(&event));
            watch(
                updater.download(
                    check,
                    DownloadOptions {
                        max_size: Some(MAX_DOWNLOAD),
                        ..Default::default()
                    },
                    Some(callback),
                ),
                &progress,
                limits,
            )
            .await
        })
        .map_err(|e| plain(e, DOWNLOAD_FAILED))?;
        self.progress.set(Stage::Verifying);
        let asset = check.asset.as_ref().context("No update selected")?;
        // Exact canonical filenames are selected below; never accept a remote path.
        ensure!(
            Path::new(&asset.name).file_name().and_then(|s| s.to_str())
                == Some(asset.name.as_str()),
            "Invalid update filename"
        );
        let destination = directory.join(&asset.name);
        fs::create_dir_all(directory)
            .map_err(anyhow::Error::from)
            .and_then(|()| save_download(&destination, &downloaded.bytes))
            .map_err(|e| e.context(SAVE_FAILED))?;
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
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| Plain(CHECK_BUSY))?;
        // A damaged file proves nothing, so it cannot hold back newer roots;
        // start as a fresh install would. The next check replaces it.
        let cache =
            load_cache(&cache_path, &reference).or_else(|_| UpdateEventCache::new(&reference))?;
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

/// Fails with a plain message when bytes stop arriving. Time counts from the
/// last change, so slow but steady downloads finish.
async fn watch<T, E: Into<anyhow::Error>>(
    work: impl Future<Output = Result<T, E>>,
    progress: &Progress,
    limits: Limits,
) -> Result<T> {
    tokio::pin!(work);
    let started = Instant::now();
    let mut last = (progress.snapshot(), started);
    let mut tick =
        tokio::time::interval((limits.start.min(limits.stall) / 4).min(Duration::from_millis(500)));
    loop {
        tokio::select! {
            result = &mut work => return result.map_err(Into::into),
            _ = tick.tick() => {
                let now = progress.snapshot();
                if now != last.0 {
                    last = (now, Instant::now());
                }
                let quiet = last.1.elapsed();
                let stuck = match (last.0.stage, last.0.total) {
                    (Stage::Downloading, Some(_)) => quiet > limits.stall,
                    // Sources without a size report bytes only at the end.
                    (Stage::Downloading, None) | (Stage::Verifying, _) => false,
                    _ => quiet > limits.start,
                };
                if stuck || started.elapsed() > limits.total {
                    return Err(Plain(DOWNLOAD_STALLED).into());
                }
            }
        }
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

    fn checked(available: bool) -> UpdateCheck {
        let cid = hashtree_core::Cid {
            hash: [7; 32],
            key: None,
        };
        UpdateCheck {
            root_cid: cid.clone(),
            release_cid: cid,
            manifest_path: "release.json".into(),
            manifest: manifest(),
            asset: None,
            update_available: available,
        }
    }

    #[test]
    fn download_of_a_current_release_says_so_plainly_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut updater = Updater::new(dir.path().into(), "0.1.4-alpha.6".into(), true);
        updater.selected = Some(checked(false));
        let error = updater.download(&dir.path().join("out")).unwrap_err();
        assert_eq!(error.to_string(), UP_TO_DATE);
        assert!(!dir.path().join("out").exists());
        assert_eq!(updater.progress().snapshot().stage, Stage::Idle);
    }

    #[test]
    fn people_see_one_plain_sentence_while_causes_stay_for_the_cli() {
        let failed = plain(anyhow::anyhow!("relay closed: code 1006"), CHECK_FAILED);
        assert_eq!(failed.to_string(), CHECK_FAILED);
        assert!(format!("{failed:#}").contains("code 1006"));
        let busy = plain(
            anyhow::Error::new(Plain(CHECK_BUSY)).context("while locking"),
            CHECK_FAILED,
        );
        assert_eq!(busy.to_string(), CHECK_BUSY);
        let stalled = plain(Plain(DOWNLOAD_STALLED).into(), DOWNLOAD_FAILED);
        assert_eq!(stalled.to_string(), DOWNLOAD_STALLED);
        assert_eq!(format!("{stalled:#}"), DOWNLOAD_STALLED);
    }

    #[test]
    fn progress_moves_from_fetching_to_downloading_to_verifying() {
        let progress = Progress::default();
        progress.start(Stage::Fetching);
        assert_eq!(
            progress.snapshot(),
            ProgressInfo {
                stage: Stage::Fetching,
                downloaded: 0,
                total: None
            }
        );
        progress.record(&DownloadEvent::Started {
            content_length: Some(4096),
        });
        progress.record(&DownloadEvent::Progress {
            chunk_len: 1024,
            downloaded: 1024,
        });
        assert_eq!(
            progress.snapshot(),
            ProgressInfo {
                stage: Stage::Downloading,
                downloaded: 1024,
                total: Some(4096)
            }
        );
        progress.record(&DownloadEvent::Finished { total: 4096 });
        assert_eq!(progress.snapshot().stage, Stage::Verifying);
        assert_eq!(progress.snapshot().downloaded, 4096);
        progress.start(Stage::Checking);
        assert_eq!(progress.snapshot().total, None);
    }

    fn quick() -> Limits {
        Limits {
            start: Duration::from_millis(150),
            stall: Duration::from_millis(150),
            total: Duration::from_secs(10),
        }
    }

    #[tokio::test]
    async fn a_download_that_never_starts_times_out_plainly() {
        let progress = Progress::default();
        progress.start(Stage::Fetching);
        let error = watch(std::future::pending::<Result<()>>(), &progress, quick())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), DOWNLOAD_STALLED);
    }

    #[tokio::test]
    async fn a_download_that_stops_midway_times_out_plainly() {
        let progress = Progress::default();
        progress.start(Stage::Fetching);
        progress.record(&DownloadEvent::Started {
            content_length: Some(10),
        });
        progress.record(&DownloadEvent::Progress {
            chunk_len: 4,
            downloaded: 4,
        });
        let started = Instant::now();
        let error = watch(std::future::pending::<Result<()>>(), &progress, quick())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), DOWNLOAD_STALLED);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn slow_but_steady_downloads_are_not_cut_off() {
        let progress = Progress::default();
        progress.start(Stage::Fetching);
        let steady = async {
            progress.record(&DownloadEvent::Started {
                content_length: Some(8),
            });
            // Eight steps of 100 ms: longer than the stall limit in total.
            for downloaded in 1..=8 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                progress.record(&DownloadEvent::Progress {
                    chunk_len: 1,
                    downloaded,
                });
            }
            Ok::<_, anyhow::Error>(downloaded_bytes())
        };
        assert_eq!(watch(steady, &progress, quick()).await.unwrap(), b"bytes");
    }

    fn downloaded_bytes() -> &'static [u8] {
        b"bytes"
    }

    #[tokio::test]
    async fn sources_without_a_size_get_the_whole_download_limit() {
        let progress = Progress::default();
        progress.start(Stage::Fetching);
        progress.record(&DownloadEvent::Started {
            content_length: None,
        });
        let limits = Limits {
            total: Duration::from_millis(600),
            ..quick()
        };
        let slow = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            Ok::<_, anyhow::Error>(())
        };
        watch(slow, &progress, limits).await.unwrap();
        let error = watch(std::future::pending::<Result<()>>(), &progress, limits)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), DOWNLOAD_STALLED);
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

    #[tokio::test]
    async fn signed_updates_preserve_legacy_and_versioned_object_keys() -> Result<()> {
        use hashtree_core::{
            Cid, DirEntry, EncryptionMode, HashTree, HashTreeConfig, LinkType, MemoryStore, to_hex,
        };
        use hashtree_updater::build_secure_pubsub_store_updater;
        use nostr::{EventBuilder, Keys, Kind, Tag, TagKind, ToBech32};
        use nostr_pubsub::{EventBus, EventSource, VerifiedEvent};

        let keys = Keys::generate();
        let reference = UpdateRef {
            npub: keys.public_key().to_bech32()?,
            tree_name: "releases/iris-market".into(),
            path: Some("latest".into()),
        };
        let target = "x86_64-unknown-linux-gnu";
        let name = "iris-market-v0.1.4-alpha.8-linux-x64.deb";
        let payload = b"Market test package";
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": "0.1.4-alpha.8",
            "assets": [{"name": name, "path": name, "size": payload.len(), "target": target}]
        }))?;
        let directory = tempfile::tempdir()?;
        let app = Updater::new(directory.path().into(), "0.1.4-alpha.5".into(), true);

        for mode in [
            EncryptionMode::LegacyChk,
            EncryptionMode::ChkV1,
            EncryptionMode::RndV1,
        ] {
            let store = Arc::new(MemoryStore::new());
            let tree = HashTree::new(HashTreeConfig::new(store.clone())).with_encryption_mode(mode);
            let mut entries = Vec::new();
            for (path, bytes) in [
                ("release.json", manifest.as_slice()),
                (name, payload.as_slice()),
            ] {
                let (cid, size) = tree.put_file(bytes).await?;
                if mode == EncryptionMode::LegacyChk && path == name {
                    // Ciphertext digest produced by the pre-migration SDK for this file.
                    assert_eq!(
                        to_hex(&cid.hash),
                        "109dddc875ebda1eb9529c084b1859b109f433248000003955e0459e4d47a454"
                    );
                }
                entries.push(
                    DirEntry::from_cid(path, &cid)
                        .with_size(size)
                        .with_link_type(LinkType::File),
                );
            }
            let release = tree.put_directory(entries).await?;
            let root = tree
                .put_directory(vec![
                    DirEntry::from_cid("latest", &release).with_link_type(LinkType::Dir),
                ])
                .await?;
            let event = EventBuilder::new(Kind::Custom(30064), "")
                .tags([
                    Tag::identifier(&reference.tree_name),
                    Tag::custom(TagKind::Custom("hash".into()), [to_hex(&root.hash)]),
                    Tag::custom(TagKind::Custom("key".into()), [root.key.unwrap().to_hex()]),
                ])
                .sign_with_keys(&keys)?;
            let bus = Arc::new(InMemoryEventBus::new());
            let updater =
                build_secure_pubsub_store_updater(bus.clone(), store, Duration::from_millis(25));
            let check = updater.check(UpdateCheckOptions {
                reference: reference.clone(),
                current_version: app.current_version.clone(),
                target: UpdateTarget::new(target),
                ..Default::default()
            });
            tokio::pin!(check);
            // Register the live subscriber before announcing the signed root.
            assert!(futures_util::poll!(&mut check).is_pending());
            bus.publish(
                VerifiedEvent::try_from(event)?,
                EventSource::peer("fixture"),
            )
            .await?;
            let mut check = check.await?;
            assert!(check.update_available);
            check.asset = Some(select_asset(&check.manifest, target, app.app)?);
            assert_eq!(Cid::parse(&app.info(&check, None).release_cid)?, release);
            let progress = Arc::new(Progress::default());
            progress.start(Stage::Fetching);
            let observer = progress.clone();
            let downloaded = watch(
                updater.download(
                    &check,
                    DownloadOptions {
                        max_size: Some(MAX_DOWNLOAD),
                        progress_chunk: Some(4),
                    },
                    Some(Arc::new(move |event| observer.record(&event))),
                ),
                &progress,
                Limits::default(),
            )
            .await?;
            assert_eq!(downloaded.bytes, payload);
            assert_eq!(
                progress.snapshot(),
                ProgressInfo {
                    stage: Stage::Verifying,
                    downloaded: payload.len() as u64,
                    total: Some(payload.len() as u64)
                }
            );
        }
        Ok(())
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
