use anyhow::{Context, Result, bail};
use iris_market_core::{Market, escrow::authorize_provider_key};
use serde_json::json;

#[derive(Debug, PartialEq)]
pub enum Command {
    Key(String),
    Agreement {
        check: bool,
        dir: String,
        peer: String,
        proposal: String,
    },
}

pub fn parse(args: &[String]) -> Result<Command> {
    match args {
        [action, key] if action == "provider-key" => Ok(Command::Key(key.clone())),
        [action, dir, peer, proposal] if matches!(action.as_str(), "request" | "check") => {
            Ok(Command::Agreement {
                check: action == "check",
                dir: dir.clone(),
                peer: peer.clone(),
                proposal: proposal.clone(),
            })
        }
        _ => bail!(
            "Use escrow provider-key <public-key> or escrow request|check <profile> <peer> <proposal-id>"
        ),
    }
}

pub fn run(command: Command) -> Result<()> {
    let secret = std::env::var("IRIS_MARKET_SECRET_KEY")
        .context("Set IRIS_MARKET_SECRET_KEY using secure credential storage")?;
    let value = match command {
        Command::Key(key) => json!(authorize_provider_key(&secret, &key)?),
        Command::Agreement {
            check,
            dir,
            peer,
            proposal,
        } => {
            let id = proposal.parse().context("Invalid proposal ID")?;
            let app = Market::open(std::path::Path::new(&dir), &secret, false)?;
            let result = if check {
                let token = super::frame(&mut std::io::stdin().lock())?
                    .context("Read one Cashu token from stdin")?;
                json!(app.check_escrow_funding(&peer, id, &token)?)
            } else {
                let terms = app.escrow_terms(&peer, id)?;
                json!({"payment_request": terms.payment_request(id)?.to_string()})
            };
            app.shutdown();
            result
        }
    };
    println!("{value}");
    Ok(())
}
