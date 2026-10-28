use anyhow::{Result, bail};
use std::path::PathBuf;

pub const HELP: &str = "Iris Market

  iris-market search <profile> [query] [--side all|offer|request] [--wait 5]
  iris-market publish <profile> <draft.json|-> [--wait 5]
  iris-market save <profile> <listing-id> [--wait 5]
  iris-market close <profile> <listing-id> [--wait 5]
  iris-market contact <profile> <listing-id> [--wait 5]
  iris-market invite <profile>
  iris-market accept <profile> <invite-file|-> [--wait 5]
  iris-market send <profile> <peer-id> <text|-> [--wait 5]
  iris-market snapshot <profile> [--wait 0]
  iris-market preview <isolated-directory>
  iris-market command <profile> '<JSON>' [--wait 2]
  iris-market command <profile> - [--wait 2]
  iris-market serve <profile>   JSON actions over stdin/stdout
  iris-market mcp <profile>     MCP tools over stdin/stdout
  iris-market tools            Tool discovery without a profile

Output is JSON. --wait accepts 0 through 60 seconds; 0 skips background waiting.
Use - to read a draft, invitation, private message, or action from stdin.
Invitation URLs are capabilities: pass them through stdin or a private file.
Live commands read IRIS_MARKET_SECRET_KEY from secure credential storage.
Do not put signing keys in arguments or shell history. One writer per profile.
Preview and help never connect to the network. Use -- before dash-prefixed text.";

#[derive(Debug, PartialEq)]
pub enum Mode {
    Preview,
    Snapshot,
    Search { query: String, side: String },
    Publish { source: String },
    Save { id: String },
    Close { id: String },
    Contact { id: String, author: String },
    Invite,
    Accept { source: String },
    Send { peer: String, text: String },
    Command { request: String },
    Serve,
    Mcp,
}

#[derive(Debug, PartialEq)]
pub enum Invocation {
    Help,
    Tools,
    Profile { dir: PathBuf, mode: Mode, wait: u64 },
}

fn public_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn listing_author(value: &str) -> Result<String> {
    let Some((author, identifier)) = value.split_once(':') else {
        bail!("Use the complete listing ID returned by search");
    };
    if !public_key(author) || identifier.is_empty() || identifier.len() > 160 {
        bail!("Use the complete listing ID returned by search");
    }
    Ok(author.into())
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Invocation> {
    let args: Vec<String> = args.into_iter().collect();
    if args.len() > 32 || args.iter().any(|a| a.len() > 32768) {
        bail!("Command arguments are too large");
    }
    if args.is_empty()
        || args
            .iter()
            .take_while(|a| a.as_str() != "--")
            .any(|a| a == "--help" || a == "-h")
    {
        return Ok(Invocation::Help);
    }
    let command = args[0].as_str();
    if command == "help" {
        return Ok(Invocation::Help);
    }
    if command == "tools" {
        if args.len() != 1 {
            bail!("tools does not take arguments");
        }
        return Ok(Invocation::Tools);
    }
    if ![
        "preview", "snapshot", "search", "publish", "save", "close", "contact", "invite", "accept",
        "send", "command", "serve", "mcp",
    ]
    .contains(&command)
    {
        bail!("Unknown command; use --help");
    }
    let mut positional = Vec::new();
    let mut wait = None;
    let mut side = None;
    let mut options = true;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if options && arg == "--" {
            options = false;
            continue;
        }
        if options && (arg == "--wait" || arg.starts_with("--wait=")) {
            if wait.is_some() {
                bail!("Supply --wait only once");
            }
            let value = arg
                .strip_prefix("--wait=")
                .or_else(|| iter.next().map(String::as_str));
            wait = Some(
                value
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|v| *v <= 60)
                    .ok_or_else(|| anyhow::anyhow!("--wait needs a whole number from 0 to 60"))?,
            );
        } else if options && arg == "--side" {
            if side.is_some() {
                bail!("Supply --side only once");
            }
            side = Some(
                iter.next()
                    .ok_or_else(|| anyhow::anyhow!("--side needs all, offer or request"))?
                    .clone(),
            );
        } else if options && arg.starts_with('-') && arg != "-" {
            bail!("Unknown option; use --help or -- before text");
        } else {
            positional.push(arg.clone());
        }
    }
    if command != "search" && side.is_some() {
        bail!("--side applies to search");
    }
    if ["preview", "invite", "serve", "mcp"].contains(&command) && wait.is_some() {
        bail!("This command does not use --wait");
    }
    let count = positional.len();
    let expected = match command {
        "search" => 1..=2,
        "publish" | "save" | "close" | "contact" | "accept" | "command" => 2..=2,
        "send" => 3..=3,
        _ => 1..=1,
    };
    if !expected.contains(&count) {
        bail!("Wrong number of arguments; use --help");
    }
    if positional[0].is_empty() {
        bail!("Supply a profile directory");
    }
    let dir = PathBuf::from(&positional[0]);
    let argument = || positional[1].clone();
    let mode = match command {
        "preview" => Mode::Preview,
        "snapshot" => Mode::Snapshot,
        "search" => {
            let query = positional.get(1).cloned().unwrap_or_default();
            let side = side.unwrap_or_else(|| "all".into());
            if query.len() > 300 || !["all", "offer", "request"].contains(&side.as_str()) {
                bail!("Search needs a query up to 300 bytes and side all, offer or request");
            }
            Mode::Search { query, side }
        }
        "publish" => Mode::Publish { source: argument() },
        "save" => {
            listing_author(&argument())?;
            Mode::Save { id: argument() }
        }
        "close" => {
            listing_author(&argument())?;
            Mode::Close { id: argument() }
        }
        "contact" => Mode::Contact {
            author: listing_author(&argument())?,
            id: argument(),
        },
        "invite" => Mode::Invite,
        "accept" => {
            let source = argument();
            if source.contains("://") || source.contains('#') {
                bail!("Read the private invitation from stdin (-) or a private file");
            }
            Mode::Accept { source }
        }
        "send" => {
            if !public_key(&argument()) {
                bail!("Supply the peer ID from a conversation");
            }
            Mode::Send {
                peer: argument(),
                text: positional[2].clone(),
            }
        }
        "command" => Mode::Command {
            request: argument(),
        },
        "serve" => Mode::Serve,
        "mcp" => Mode::Mcp,
        _ => unreachable!(),
    };
    let default_wait = match &mode {
        Mode::Preview | Mode::Snapshot | Mode::Invite | Mode::Serve | Mode::Mcp => 0,
        Mode::Command { .. } => 2,
        _ => 5,
    };
    Ok(Invocation::Profile {
        dir,
        mode,
        wait: wait.unwrap_or(default_wait),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(args: &[&str]) -> Result<Invocation> {
        parse(args.iter().map(|a| (*a).into()))
    }
    #[test]
    fn help_and_tools_need_no_profile() {
        for args in [&[][..], &["--help"], &["-h"], &["publish", "--help"]] {
            assert_eq!(p(args).unwrap(), Invocation::Help);
        }
        assert_eq!(p(&["tools"]).unwrap(), Invocation::Tools);
        assert!(p(&["tools", "extra"]).is_err());
    }
    #[test]
    fn bounded_wait_and_search_options() {
        assert_eq!(
            p(&[
                "search", "profile", "chair", "--side", "request", "--wait=0"
            ])
            .unwrap(),
            Invocation::Profile {
                dir: "profile".into(),
                mode: Mode::Search {
                    query: "chair".into(),
                    side: "request".into()
                },
                wait: 0
            }
        );
        assert!(p(&["search", "profile", "--wait", "61"]).is_err());
        assert!(p(&["search", "profile", "--wait", "-1"]).is_err());
        assert!(p(&["search", "profile", "--wait", "0", "--wait", "1"]).is_err());
        assert!(p(&["search", "profile", "--side", "wrong"]).is_err());
        assert!(p(&["search", "profile", &"€".repeat(101)]).is_err());
        assert!(p(&["snapshot", "profile", "extra"]).is_err());
        assert!(p(&["mcp", "profile", "--wait", "1"]).is_err());
    }
    #[test]
    fn contact_derives_author_and_private_invite_is_never_an_argument() {
        let author = "a".repeat(64);
        let id = format!("{author}:item:variant");
        assert_eq!(
            p(&["contact", "profile", &id]).unwrap(),
            Invocation::Profile {
                dir: "profile".into(),
                mode: Mode::Contact { id, author },
                wait: 5
            }
        );
        assert!(p(&["contact", "profile", "bad:item"]).is_err());
        assert!(p(&["accept", "profile", "https://market.iris.to/invite#private"]).is_err());
        assert!(p(&["accept", "profile", "-"]).is_ok());
        assert!(p(&["send", "profile", &"b".repeat(64), "--", "--private-text"]).is_ok());
    }
}
