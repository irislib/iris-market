mod args;

use anyhow::{Context, Result, bail};
use args::{Invocation, Mode};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    time::{Duration, Instant},
};

fn tools() -> Value {
    json!([
     {"name":"market_search","description":"Search this user's verified public marketplace listings. This does not publish or contact anyone.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"side":{"type":"string","enum":["all","offer","request"]}},"additionalProperties":false},"annotations":{"readOnlyHint":true}},
     {"name":"market_publish","description":"Publish an offer or request publicly and enable private enquiries. Confirm the exact listing with the user before calling.","inputSchema":{"type":"object","properties":{"draft":{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"side":{"type":"string","enum":["offer","request"]},"price":{"type":"string"},"currency":{"type":"string"},"location":{"type":"string"},"category":{"type":"string"},"image_url":{"type":["string","null"]}},"required":["title","description","side"]}},"required":["draft"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"openWorldHint":true}},
     {"name":"market_save","description":"Toggle a local bookmark for a listing.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}},
     {"name":"market_contact","description":"Start a private ratcheted conversation with the verified listing author. Requires user authorisation to contact that person.","inputSchema":{"type":"object","properties":{"author":{"type":"string"},"listing_id":{"type":"string"}},"required":["author","listing_id"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"openWorldHint":true}},
     {"name":"market_send_message","description":"Send a private message in an existing conversation. Obtain user authorisation before contacting someone.","inputSchema":{"type":"object","properties":{"peer_id":{"type":"string"},"text":{"type":"string"}},"required":["peer_id","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"openWorldHint":true}}
    ])
}
fn mcp(app: &iris_market_core::Market, request: Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let response = match request["method"].as_str().unwrap_or("") {
        "initialize" => Ok(
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"iris-market","version":env!("CARGO_PKG_VERSION")}}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":tools()})),
        "tools/call" => {
            let mut args = request["params"]["arguments"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let action = match request["params"]["name"].as_str() {
                Some("market_search") => "set_filter",
                Some("market_publish") => "publish",
                Some("market_save") => "save",
                Some("market_contact") => "contact",
                Some("market_send_message") => "send_message",
                _ => "",
            };
            if action.is_empty() {
                Err((-32602, "Unknown tool".to_string()))
            } else {
                args.insert("type".into(), action.into());
                if action == "set_filter" {
                    args.entry("query").or_insert(json!(""));
                    args.entry("side").or_insert(json!("all"));
                }
                match app.command(&Value::Object(args).to_string()) {
                    Ok(state) => {
                        // Search never exposes private inbox history to a listing-discovery tool.
                        let text = if action == "set_filter" {
                            let s: Value = serde_json::from_str(&state).unwrap_or_default();
                            json!({"listings":s["listings"],"status":s["status"]}).to_string()
                        } else {
                            let s: Value = serde_json::from_str(&state).unwrap_or_default();
                            json!({"status":s["status"],"error":s["error"]}).to_string()
                        };
                        Ok(json!({"content":[{"type":"text","text":text}],"isError":false}))
                    }
                    Err(e) => {
                        Ok(json!({"content":[{"type":"text","text":e.to_string()}],"isError":true}))
                    }
                }
            }
        }
        _ => Err((-32601, "Method not found".into())),
    };
    Some(match response {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
        }
    })
}
const MAX_INPUT: usize = 32768;

fn read_input(reader: impl Read) -> Result<String> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INPUT {
        bail!("Input is too large");
    }
    String::from_utf8(bytes).context("Input must be UTF-8 text")
}

fn input(source: &str, file: bool, stdin: &mut impl Read) -> Result<String> {
    if source == "-" {
        read_input(stdin)
    } else if file {
        read_input(std::fs::File::open(source).context("Could not read input file")?)
    } else {
        Ok(source.into())
    }
}

fn action(mode: &Mode, stdin: &mut impl Read) -> Result<Option<Value>> {
    Ok(Some(match mode {
        Mode::Search { query, side } => json!({"type":"set_filter","query":query,"side":side}),
        Mode::Publish { source } => {
            let draft: iris_market_core::model::Draft =
                serde_json::from_str(&input(source, true, stdin)?)
                    .map_err(|_| anyhow::anyhow!("Invalid draft JSON"))?;
            iris_market_core::listing::validate(&draft)?;
            json!({"type":"publish","draft":draft})
        }
        Mode::Save { id } => json!({"type":"save","id":id}),
        Mode::Close { id } => json!({"type":"close","id":id}),
        Mode::Contact { id, author } => json!({"type":"contact","author":author,"listing_id":id}),
        Mode::Invite => json!({"type":"create_invite"}),
        Mode::Accept { source } => {
            let invite = input(source, true, stdin)?;
            if invite.trim().is_empty() {
                bail!("Invitation is empty");
            }
            json!({"type":"accept_invite","invite":invite.trim()})
        }
        Mode::Send { peer, text } => {
            let text = input(text, false, stdin)?;
            if text.trim().is_empty() || text.len() > 8192 {
                bail!("Message needs 1 to 8192 bytes of text");
            }
            json!({"type":"send_message","peer_id":peer,"text":text})
        }
        Mode::Command { request } => {
            let value: Value = serde_json::from_str(&input(request, false, stdin)?)
                .map_err(|_| anyhow::anyhow!("Invalid action JSON"))?;
            serde_json::from_value::<iris_market_core::model::Command>(value.clone())
                .map_err(|_| anyhow::anyhow!("Invalid action JSON"))?;
            value
        }
        _ => return Ok(None),
    }))
}

fn snapshot(app: &iris_market_core::Market) -> Result<Value> {
    Ok(serde_json::from_str(&app.snapshot()?)?)
}

fn rows<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    state[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn listing<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    rows(state, "listings").iter().find(|row| row["id"] == id)
}

fn last_message<'a>(state: &'a Value, peer: &str) -> Option<&'a Value> {
    let conversation = rows(state, "conversations")
        .iter()
        .find(|row| row["id"] == peer)?;
    rows(conversation, "messages")
        .iter()
        .rev()
        .find(|row| row["mine"] == true)
}

fn published_listing<'a>(before: &Value, after: &'a Value) -> Option<&'a Value> {
    rows(after, "listings").iter().find(|row| {
        row["mine"] == true
            && !rows(before, "listings")
                .iter()
                .any(|old| old["id"] == row["id"])
    })
}

fn public_results(state: &Value) -> Value {
    json!({"listings":state["listings"],"status":state["status"],"error":state["error"]})
}

fn result(mode: &Mode, before: &Value, state: &Value) -> Value {
    let mut output = json!({"status":state["status"],"error":state["error"]});
    match mode {
        Mode::Preview | Mode::Snapshot | Mode::Command { .. } => return state.clone(),
        Mode::Search { .. } => return public_results(state),
        Mode::Publish { .. } => {
            output["listing"] = published_listing(before, state)
                .cloned()
                .unwrap_or(Value::Null);
        }
        Mode::Save { id } => {
            output["id"] = json!(id);
            output["saved"] = listing(state, id)
                .map(|l| l["saved"].clone())
                .unwrap_or(Value::Null);
        }
        Mode::Close { id } => {
            output["id"] = json!(id);
            output["stored"] = json!(true);
            output["delivery"] = json!("unconfirmed");
            output["note"] = json!(
                "Closing revision is stored locally. This response cannot confirm its relay acknowledgement; queued work resumes when this profile is opened."
            );
        }
        Mode::Contact { author, .. } => {
            output["peer_id"] = json!(author);
            output["delivery"] = json!("unconfirmed");
            output["note"] = json!(
                "Conversation is stored locally. Invitation delivery is not confirmed by this response."
            );
        }
        Mode::Invite => {
            output["invite"] = state["invite"].clone();
        }
        Mode::Accept { .. } => {
            let peers: Vec<&Value> = rows(state, "conversations")
                .iter()
                .filter(|row| {
                    !rows(before, "conversations")
                        .iter()
                        .any(|old| old["id"] == row["id"])
                })
                .map(|row| &row["id"])
                .collect();
            output["peer_ids"] = json!(peers);
            output["delivery"] = json!("unconfirmed");
            output["note"] = json!(
                "Invitation accepted locally. Response delivery is not confirmed by this output."
            );
        }
        Mode::Send { peer, .. } => {
            output["peer_id"] = json!(peer);
            if let Some(message) = last_message(state, peer) {
                output["message_id"] = message["id"].clone();
                output["delivery"] = message["delivery"].clone();
            }
            output["note"] = json!(
                "sent means relay acknowledgement, not recipient receipt. Pending work resumes when this profile is opened."
            );
        }
        Mode::Serve | Mode::Mcp => {}
    }
    output
}

fn sleep_remaining(deadline: Instant) {
    if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        std::thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

fn wait_for_listing(app: &iris_market_core::Market, id: &str, deadline: Instant) -> Result<()> {
    loop {
        if listing(&snapshot(app)?, id).is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("Listing is not in local inventory; retry search with a longer --wait");
        }
        sleep_remaining(deadline);
    }
}

fn wait_after(
    app: &iris_market_core::Market,
    mode: &Mode,
    before: &Value,
    deadline: Instant,
) -> Result<Value> {
    loop {
        let state = snapshot(app)?;
        let confirmed = match mode {
            Mode::Publish { .. } => {
                published_listing(before, &state).is_some_and(|row| row["delivery"] == "published")
            }
            Mode::Send { peer, .. } => {
                last_message(&state, peer).is_some_and(|row| row["delivery"] == "sent")
            }
            _ => false,
        };
        if confirmed || Instant::now() >= deadline {
            return Ok(state);
        }
        sleep_remaining(deadline);
    }
}

fn frame(reader: &mut impl BufRead) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_INPUT + 2) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.len() > MAX_INPUT {
        bail!("Request is too large");
    }
    Ok(Some(
        String::from_utf8(bytes).context("Request must be UTF-8")?,
    ))
}

fn run(invocation: Invocation) -> Result<()> {
    let (dir, mode, wait) = match invocation {
        Invocation::Help => {
            println!("{}", args::HELP);
            return Ok(());
        }
        Invocation::Tools => {
            println!("{}", tools());
            return Ok(());
        }
        Invocation::Profile { dir, mode, wait } => (dir, mode, wait),
    };
    // Validate and bound input before opening a profile or connecting to relays.
    let request = action(&mode, &mut io::stdin().lock())?;
    let demo = mode == Mode::Preview;
    let secret = if demo {
        iris_market_core::generate_secret_key()
    } else {
        std::env::var("IRIS_MARKET_SECRET_KEY")
            .context("Set IRIS_MARKET_SECRET_KEY using secure credential storage")?
    };
    let app = iris_market_core::Market::open(&dir, &secret, demo)?;
    let deadline = Instant::now() + Duration::from_secs(wait);
    if matches!(mode, Mode::Serve | Mode::Mcp) {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        while let Some(line) = frame(&mut stdin)? {
            if mode == Mode::Mcp {
                match serde_json::from_str(&line) {
                    Ok(request) => {
                        if let Some(reply) = mcp(&app, request) {
                            println!("{reply}");
                        }
                    }
                    Err(_) => println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})
                    ),
                }
            } else {
                let reply = match app.command(&line) {
                    Ok(state) => state,
                    Err(e) => json!({"error":e.to_string()}).to_string(),
                };
                println!("{reply}");
            }
            io::stdout().flush()?;
        }
    } else {
        if let Mode::Save { id } | Mode::Close { id } | Mode::Contact { id, .. } = &mode {
            wait_for_listing(&app, id, deadline)?;
        }
        let before = snapshot(&app)?;
        if let Some(request) = request {
            app.command(&request.to_string())?;
        }
        let state = if demo || matches!(mode, Mode::Invite | Mode::Save { .. }) {
            snapshot(&app)?
        } else {
            wait_after(&app, &mode, &before, deadline)?
        };
        println!("{}", result(&mode, &before, &state));
    }
    app.shutdown();
    Ok(())
}

fn main() -> std::process::ExitCode {
    match args::parse(std::env::args().skip(1)).and_then(run) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"error":error.to_string()}));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_and_notifications_do_not_require_side_effects() {
        assert_eq!(tools().as_array().unwrap().len(), 5);
        assert!(tools()[0]["annotations"]["readOnlyHint"].as_bool().unwrap());
    }
    #[test]
    fn listing_search_projection_never_contains_private_state() {
        let state = json!({"listings":[{"title":"Chair"}],"status":"Connected","error":null,"conversations":[{"text":"private"}],"invite":"secret-capability","settings":{"ai":{"interests":"private interests"}}});
        let output = result(
            &Mode::Search {
                query: "".into(),
                side: "all".into(),
            },
            &json!({}),
            &state,
        );
        assert_eq!(output.as_object().unwrap().len(), 3);
        assert_eq!(output["listings"][0]["title"], "Chair");
        assert!(!output.to_string().contains("private"));
        assert!(!output.to_string().contains("capability"));
    }
    #[test]
    fn send_projection_reports_pending_without_disclosing_message_text() {
        let state = json!({"status":"Offline","conversations":[{"id":"peer","messages":[{"id":"m","mine":true,"text":"private text","delivery":"pending"}]}]});
        let output = result(
            &Mode::Send {
                peer: "peer".into(),
                text: "-".into(),
            },
            &json!({}),
            &state,
        );
        assert_eq!(output["delivery"], "pending");
        assert_eq!(output["message_id"], "m");
        assert!(!output.to_string().contains("private text"));
    }
    #[test]
    fn stdin_is_bounded_and_private_message_whitespace_is_preserved() {
        assert!(read_input(&vec![b'x'; MAX_INPUT + 1][..]).is_err());
        let mut text = &b"A private message\n"[..];
        let request = action(
            &Mode::Send {
                peer: "a".repeat(64),
                text: "-".into(),
            },
            &mut text,
        )
        .unwrap()
        .unwrap();
        assert_eq!(request["text"], "A private message\n");
        assert!(
            action(
                &Mode::Send {
                    peer: "a".repeat(64),
                    text: "-".into()
                },
                &mut &b"   "[..]
            )
            .is_err()
        );
        assert!(frame(&mut &vec![b'x'; MAX_INPUT + 1][..]).is_err());
    }
    #[test]
    fn publish_validates_before_opening_any_profile() {
        let good = br#"{"title":"Chair","description":"Oak","side":"offer"}"#;
        let request = action(&Mode::Publish { source: "-".into() }, &mut &good[..])
            .unwrap()
            .unwrap();
        assert_eq!(request["draft"]["currency"], "EUR");
        assert!(action(&Mode::Publish { source: "-".into() }, &mut &b"{}"[..]).is_err());
        assert!(
            action(
                &Mode::Publish { source: "-".into() },
                &mut &b"private invalid input"[..]
            )
            .unwrap_err()
            .to_string()
                == "Invalid draft JSON"
        );
    }
}
