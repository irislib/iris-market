use serde_json::Value;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
impl Fixture {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "iris-market-cli-test-{}-{suffix}-{}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_iris-market"));
    command.env_remove("IRIS_MARKET_SECRET_KEY");
    command
}

#[test]
fn help_tools_and_preview_need_no_credentials_or_live_profile() {
    assert!(cli().arg("--help").output().unwrap().status.success());
    let tools = cli().arg("tools").output().unwrap();
    assert!(tools.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&tools.stdout)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        9
    );
    let dir = Fixture::new();
    let output = cli().arg("preview").arg(&dir.0).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state["demo"], true);
    assert!(!state["listings"].as_array().unwrap().is_empty());
    assert!(state["conversations"].as_array().unwrap().is_empty());
    assert_eq!(state["invite"], Value::Null);
    assert!(dir.0.join("preview.sqlite").exists());
    assert!(!dir.0.join("market.sqlite").exists());
    assert!(!dir.0.join("private-messages").exists());
}

#[test]
fn rejected_input_does_not_open_a_profile_or_echo_private_input() {
    let dir = Fixture::new();
    let profile = dir.0.join("not-created");
    let output = cli()
        .arg("search")
        .arg(&profile)
        .args(["--wait", "61"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"].is_string());
    assert!(!profile.exists());
    let mut child = cli()
        .arg("publish")
        .arg(&profile)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"private-invalid-input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-invalid-input"));
    assert!(!profile.exists());
}

fn offline_profile(fixture: &Fixture, name: &str) -> PathBuf {
    let path = fixture.0.join(name);
    std::fs::create_dir(&path).unwrap();
    let store = iris_market_core::store::Store::open(&path.join("market.sqlite")).unwrap();
    let settings = iris_market_core::model::Settings {
        relays: Vec::new(),
        ..Default::default()
    };
    store.save_settings(&settings).unwrap();
    path
}

fn offline_command(
    profile: &std::path::Path,
    key: &str,
    command: &str,
    args: &[&str],
    input: Option<&str>,
) -> Value {
    let mut cmd = cli();
    cmd.env("IRIS_MARKET_SECRET_KEY", key)
        .arg(command)
        .arg(profile)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    } else {
        drop(child.stdin.take());
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn named_offline_flows_report_durable_queues_and_keep_private_results_scoped() {
    let fixture = Fixture::new();
    let alice = offline_profile(&fixture, "alice");
    let bob = offline_profile(&fixture, "bob");
    let alice_key = iris_market_core::generate_secret_key();
    let bob_key = iris_market_core::generate_secret_key();
    let published = offline_command(
        &alice,
        &alice_key,
        "publish",
        &["-", "--wait", "0"],
        Some(r#"{"title":"Oak chair","description":"Comfortable","side":"offer"}"#),
    );
    assert_eq!(published["listing"]["delivery"], "queued");
    let id = published["listing"]["id"].as_str().unwrap();
    let found = offline_command(
        &alice,
        &alice_key,
        "search",
        &["chair", "--wait", "0"],
        None,
    );
    assert_eq!(found["listings"].as_array().unwrap().len(), 1);
    assert!(found.get("conversations").is_none());
    let saved = offline_command(&alice, &alice_key, "save", &[id, "--wait", "0"], None);
    assert_eq!(saved["saved"], true);
    let invitation = offline_command(&alice, &alice_key, "invite", &[], None);
    let accepted = offline_command(
        &bob,
        &bob_key,
        "accept",
        &["-", "--wait", "0"],
        Some(invitation["invite"].as_str().unwrap()),
    );
    assert_eq!(accepted["delivery"], "unconfirmed");
    let peer = accepted["peer_ids"][0].as_str().unwrap();
    let sent = offline_command(
        &bob,
        &bob_key,
        "send",
        &[peer, "-", "--wait", "0"],
        Some("A private enquiry"),
    );
    assert_eq!(sent["delivery"], "pending");
    assert!(!sent.to_string().contains("A private enquiry"));
    let closed = offline_command(&alice, &alice_key, "close", &[id, "--wait", "0"], None);
    assert_eq!(closed["stored"], true);
    assert_eq!(closed["delivery"], "unconfirmed");
    let found = offline_command(&alice, &alice_key, "search", &["--wait", "0"], None);
    assert!(found["listings"].as_array().unwrap().is_empty());
}

#[test]
fn orders_are_local_first_restorable_archivable_and_scoped() {
    let fixture = Fixture::new();
    let seller = offline_profile(&fixture, "seller");
    let buyer = offline_profile(&fixture, "buyer");
    let seller_key = iris_market_core::generate_secret_key();
    let buyer_key = iris_market_core::generate_secret_key();
    let published = offline_command(
        &seller,
        &seller_key,
        "publish",
        &["-", "--wait", "0"],
        Some(
            r#"{"title":"Parcel delivery","description":"Local courier","side":"offer","price":"12","currency":"EUR"}"#,
        ),
    );
    let listing_id = published["listing"]["id"].as_str().unwrap();
    let seller_store = iris_market_core::store::Store::open(&seller.join("market.sqlite")).unwrap();
    let event = seller_store.event(listing_id).unwrap();
    drop(seller_store);
    let mut buyer_store =
        iris_market_core::store::Store::open(&buyer.join("market.sqlite")).unwrap();
    buyer_store
        .ingest(&event, iris_market_core::listing::now(), false)
        .unwrap();
    drop(buyer_store);
    let requested = offline_command(
        &buyer,
        &buyer_key,
        "order-request",
        &[listing_id, "-"],
        Some(r#"{"quantity":2,"note":"Ring once"}"#),
    );
    assert_eq!(requested["order"]["status"], "requested");
    assert_eq!(requested["order"]["sync"], "queued");
    assert_eq!(requested["order"]["items"][0]["quantity"], 2);
    assert!(requested.get("conversations").is_none());
    assert_eq!(requested["live_location_supported"], true);
    let id = requested["order"]["id"].as_str().unwrap();
    let restored = offline_command(&buyer, &buyer_key, "orders", &[], None);
    assert_eq!(restored["orders"][0]["id"], id);
    assert_eq!(restored["orders"][0]["sync"], "queued");
    let archived = offline_command(&buyer, &buyer_key, "order-archive", &[id], None);
    assert_eq!(archived["order"]["archived"], true);
    let restored = offline_command(&buyer, &buyer_key, "order-restore", &[id], None);
    assert_eq!(restored["order"]["archived"], false);
    let cancelled = offline_command(
        &buyer,
        &buyer_key,
        "order-update",
        &[id, "-"],
        Some(r#"{"status":"cancelled"}"#),
    );
    assert_eq!(cancelled["order"]["status"], "cancelled");
    let search = offline_command(&buyer, &buyer_key, "search", &["--wait", "0"], None);
    assert!(!search.to_string().contains("Ring once"));
    assert!(search.get("orders").is_none());
}
