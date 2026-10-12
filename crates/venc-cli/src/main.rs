mod ipc;
use anyhow::{bail, ensure, Context, Result};
use clap::{Parser, Subcommand};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, Read, Write},
    path::PathBuf,
};
use venc_vault::{Session, MAX_FILE_SIZE};
use zeroize::Zeroizing;

#[derive(Parser)]
#[command(
    version,
    about = "Two-password encrypted vault. Unlock opens an in-memory session."
)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Serve private newline-delimited JSON over stdin/stdout for the VS Code extension.
    Serve,
    /// Create a new vault; never overwrites an existing directory.
    Init { vault: PathBuf },
    /// Unlock and enter a command session; EOF or lock erases session keys.
    Unlock { vault: PathBuf },
}
fn password(prompt: &str) -> Result<Zeroizing<String>> {
    let password = Zeroizing::new(rpassword::prompt_password(prompt)?);
    ensure!(
        !password.is_empty() && password.len() <= 4096,
        "password must contain 1–4096 bytes"
    );
    Ok(password)
}
fn pair(confirm: bool) -> Result<(Zeroizing<String>, Zeroizing<String>)> {
    let a = password("Password A: ")?;
    let b = password("Password B: ")?;
    if confirm {
        ensure!(
            *a == *password("Confirm A: ")? && *b == *password("Confirm B: ")?,
            "password confirmation mismatch"
        );
    }
    Ok((a, b))
}
fn execute(session: &mut Session, args: &[String]) -> Result<bool> {
    match args.first().map(String::as_str) {
        Some("lock") if args.len() == 1 => {
            session.lock();
            return Ok(false);
        }
        Some("list") if args.len() == 1 => {
            for (path, size) in session.list()? {
                println!("{}\t{size}", serde_json::to_string(path)?);
            }
        }
        Some("add") if args.len() == 3 => {
            let mut plain = Zeroizing::new(Vec::new());
            File::open(&args[1])?
                .take(MAX_FILE_SIZE as u64 + 1)
                .read_to_end(&mut plain)?;
            session.add(&args[2], &plain)?;
            println!("Added.");
        }
        Some("extract") if args.len() == 3 => {
            // Explicit plaintext export. Authenticate fully before creating output.
            let plain = session.extract(&args[1])?;
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut output = opts
                .open(&args[2])
                .context("cannot create export (existing paths are refused)")?;
            output.write_all(&plain)?;
            output.sync_all()?;
            println!("Exported plaintext.");
        }
        Some("remove") if args.len() == 2 => {
            session.remove(&args[1])?;
            println!("Removed.");
        }
        Some("passwd") if args.len() == 1 => {
            eprintln!("Current passwords:");
            let (old_a, old_b) = pair(false)?;
            eprintln!("New passwords:");
            let (new_a, new_b) = pair(true)?;
            session.change_passwords(
                old_a.as_bytes(),
                old_b.as_bytes(),
                new_a.as_bytes(),
                new_b.as_bytes(),
            )?;
            println!("Passwords changed.");
        }
        Some("help") if args.len() == 1 => help(),
        _ => bail!("unknown command or wrong arguments; enter [\"help\"]"),
    }
    Ok(true)
}
fn help() {
    println!("Commands are JSON arrays (paths may contain spaces):\n[\"add\",\"local-file\",\"vault/path\"]\n[\"extract\",\"vault/path\",\"new-output-file\"] (writes plaintext)\n[\"list\"]\n[\"remove\",\"vault/path\"]\n[\"passwd\"]\n[\"lock\"]");
}
fn run() -> Result<()> {
    let args = Args::parse();
    match args.command {
        Command::Serve => ipc::serve(io::stdin().lock(), io::stdout().lock())?,
        Command::Init { vault } => {
            let (a, b) = pair(true)?;
            let mut s = Session::init(&vault, a.as_bytes(), b.as_bytes())?;
            s.lock();
            println!("Vault created and locked.");
        }
        Command::Unlock { vault } => {
            let mut session = {
                let (a, b) = pair(false)?;
                Session::unlock(&vault, a.as_bytes(), b.as_bytes())?
            };
            help();
            loop {
                print!("venc> ");
                io::stdout().flush()?;
                let mut line = String::new();
                if io::stdin().lock().read_line(&mut line)? == 0 {
                    break;
                }
                let result = serde_json::from_str::<Vec<String>>(&line)
                    .map_err(anyhow::Error::from)
                    .and_then(|args| execute(&mut session, &args));
                match result {
                    Ok(false) => break,
                    Ok(true) => (),
                    Err(err) => eprintln!("Error: {err}"),
                }
                if session.is_locked() {
                    break;
                }
            }
            session.lock();
            println!("Locked.");
        }
    }
    Ok(())
}
fn main() {
    if let Err(err) = run() {
        eprintln!("Error: {err:#}");
        std::process::exit(1);
    }
}
