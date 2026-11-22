use anyhow::{Result, bail, ensure};
use iris_market_core::updater::{CURRENT_VERSION, Progress, Updater};
use serde_json::json;
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
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
    // A download also writes `{"progress":…}` lines before its response.
    let mut input = io::stdin().lock();
    let output = Mutex::new(io::stdout());
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
            b"download\n" => {
                let directory = command.output.clone().unwrap();
                report_progress(&output, updater.progress(), || updater.download(&directory))
            }
            _ => bail!("Unknown update operation"),
        };
        let response = match result {
            Ok(info) => json!({"ok":true,"result":info}),
            // `error` is one plain sentence for people; `detail` keeps causes.
            Err(error) => {
                json!({"ok":false,"error":error.to_string(),"detail":format!("{error:#}")})
            }
        };
        let mut output = output
            .lock()
            .map_err(|_| anyhow::anyhow!("Output closed"))?;
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}

fn report_progress<T>(
    output: &Mutex<impl Write + Send>,
    progress: Arc<Progress>,
    work: impl FnOnce() -> T,
) -> T {
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut last = None;
            while !done.load(Ordering::Acquire) {
                let now = progress.snapshot();
                if last.as_ref() != Some(&now) {
                    if let Ok(mut output) = output.lock() {
                        let _ = writeln!(output, "{}", json!({ "progress": now }));
                        let _ = output.flush();
                    }
                    last = Some(now);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let result = work();
        done.store(true, Ordering::Release);
        result
    })
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

    #[test]
    fn downloads_report_each_stage_before_the_response() {
        use iris_market_core::updater::Stage;
        let output = Mutex::new(Vec::new());
        let progress = Arc::new(Progress::default());
        let result = report_progress(&output, progress.clone(), || {
            std::thread::sleep(Duration::from_millis(300));
            progress.start(Stage::Fetching);
            std::thread::sleep(Duration::from_millis(300));
            42
        });
        assert_eq!(result, 42);
        let lines = String::from_utf8(output.into_inner().unwrap()).unwrap();
        let stages: Vec<String> = lines
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .map(|line| line["progress"]["stage"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(stages, ["idle", "fetching"]);
    }
}
