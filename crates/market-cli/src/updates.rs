use anyhow::{Result, bail, ensure};
use iris_market_core::updater::{CURRENT_VERSION, Updater};
use serde_json::json;
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

#[derive(Debug, PartialEq)]
pub struct Command {
    operation: String,
    directory: PathBuf,
    output: Option<PathBuf>,
    version: String,
    app: bool,
}

pub fn parse(args: &[String]) -> Result<Command> {
    ensure!(
        args.len() >= 2 && matches!(args[0].as_str(), "check" | "download" | "serve"),
        "Use update check, download or serve followed by an update-directory"
    );
    let mut command = Command {
        operation: args[0].clone(),
        directory: args[1].clone().into(),
        output: None,
        version: CURRENT_VERSION.into(),
        app: false,
    };
    let mut remaining = args[2..].iter();
    while let Some(argument) = remaining.next() {
        match argument.as_str() {
            "--app" if !command.app => command.app = true,
            "--output" if command.output.is_none() => {
                command.output = Some(
                    remaining
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--output needs a directory"))?
                        .into(),
                )
            }
            "--current-version" => {
                command.version = remaining
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--current-version needs a version"))?
                    .clone()
            }
            _ => bail!("Unknown or repeated update option"),
        }
    }
    ensure!(
        command.operation == "check" || command.output.is_some(),
        "Downloading updates requires --output DIRECTORY"
    );
    Ok(command)
}

pub fn run(command: Command) -> Result<()> {
    let mut updater = Updater::new(command.directory, command.version, command.app);
    if command.operation != "serve" {
        let mut info = updater.check()?;
        if command.operation == "download" && info.available {
            info = updater.download(command.output.as_deref().unwrap())?;
        }
        println!("{}", serde_json::to_string(&info)?);
        return Ok(());
    }
    // Fixed local operations, no credentials or marketplace state. Keeping this
    // process alive retains exactly the release shown before download is chosen.
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut bytes = Vec::new();
        use std::io::Read;
        let count = input.by_ref().take(129).read_until(b'\n', &mut bytes)?;
        if count == 0 {
            break;
        }
        ensure!(
            count <= 128 && bytes.ends_with(b"\n"),
            "Invalid update request"
        );
        let result = match bytes.as_slice() {
            b"check\n" => updater.check(),
            b"download\n" => updater.download(command.output.as_deref().unwrap()),
            _ => bail!("Unknown update operation"),
        };
        let response = match result {
            Ok(info) => json!({"ok":true,"result":info}),
            Err(error) => json!({"ok":false,"error":format!("{error:#}")}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn updates_do_not_require_a_market_profile_or_secret() {
        let command = parse(&args(&[
            "check",
            "/cache/updates",
            "--app",
            "--current-version",
            "0.1.4-alpha.5",
        ]))
        .unwrap();
        assert!(command.app);
        assert_eq!(command.version, "0.1.4-alpha.5");
        assert!(parse(&args(&["download", "/cache/updates"])).is_err());
        assert!(parse(&args(&["check", "/cache/updates", "--unknown"])).is_err());
    }
}
