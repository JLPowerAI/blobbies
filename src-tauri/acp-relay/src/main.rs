//! `blobbies-acp` — the executable an editor spawns to talk to Blobbies.
//!
//! The Agent Client Protocol is JSON-RPC over the agent's stdio, so a client
//! needs a command to run. This is that command, and it is deliberately the
//! dumbest part of the bridge: it reads the loopback port and token the app
//! wrote to `~/.blobbies/acp.json`, presents the token, and then copies bytes
//! between stdio and the socket. Every protocol decision happens in the app,
//! where the Blobs, groups and transcripts are.
//!
//! Being a byte pump is the whole point. A relay that parsed ACP would be a
//! second implementation to keep in step with the first, and a second thing to
//! get wrong on a surface that can run shell tools.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How long to wait for the app after launching it. Cold start on a laptop is
/// a few seconds; past this the honest answer is that it did not come up.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

/// What the app published for us.
struct Config {
    port: u16,
    token: String,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(std::env::home_dir)?;
    Some(home.join(".blobbies").join("acp.json"))
}

/// Read the port and token.
///
/// Hand-parsed rather than pulled through serde: this binary exists to move
/// bytes, and two fields do not justify making a JSON parser part of a
/// separately shipped executable's attack surface.
fn read_config() -> Option<Config> {
    let raw = std::fs::read_to_string(config_path()?).ok()?;
    let field = |name: &str| -> Option<String> {
        let start = raw.find(&format!("\"{name}\""))? + name.len() + 3;
        let rest = raw
            .get(start..)?
            .trim_start()
            .trim_start_matches(':')
            .trim_start();
        let value: String = if let Some(quoted) = rest.strip_prefix('"') {
            quoted
                .chars()
                .take_while(|character| *character != '"')
                .collect()
        } else {
            rest.chars().take_while(char::is_ascii_digit).collect()
        };
        (!value.is_empty()).then_some(value)
    };
    Some(Config {
        port: field("port")?.parse().ok()?,
        token: field("token")?,
    })
}

/// Connect and present the token. The app closes the socket if it is wrong.
fn connect(config: &Config) -> io::Result<TcpStream> {
    let mut socket = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, config.port)))?;
    socket.write_all(format!("{}\n", config.token).as_bytes())?;
    socket.flush()?;
    Ok(socket)
}

/// Start Blobbies from beside this binary — the sidecar ships next to the app.
fn launch_app() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    // macOS: the app bundle three levels up (`Blobbies.app/Contents/MacOS/`)
    // must be opened, not exec'd, or it starts without its bundle identity.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = dir.ancestors().nth(2)
        && bundle
            .extension()
            .is_some_and(|extension| extension == "app")
    {
        return std::process::Command::new("/usr/bin/open")
            .arg(bundle)
            .status()
            .is_ok_and(|status| status.success());
    }
    let name = if cfg!(windows) {
        "Blobbies.exe"
    } else {
        "Blobbies"
    };
    let app = dir.join(name);
    app.exists() && std::process::Command::new(app).spawn().is_ok()
}

/// Connect, launching the app once and waiting for it if nothing is listening.
fn connect_or_launch() -> Result<TcpStream, String> {
    if let Some(config) = read_config()
        && let Ok(socket) = connect(&config)
    {
        return Ok(socket);
    }
    if !launch_app() {
        return Err(
            "Blobbies is not running, and this relay could not start it. \
             Open Blobbies, then enable Settings \u{2192} Plugins \u{2192} Editors (ACP)."
                .into(),
        );
    }
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(config) = read_config()
            && let Ok(socket) = connect(&config)
        {
            return Ok(socket);
        }
    }
    Err("Blobbies started but never opened its editor bridge. \
         Check Settings \u{2192} Plugins \u{2192} Editors (ACP)."
        .into())
}

/// Copy one stream into another until either end goes away.
fn pump(mut from: impl Read, mut to: impl Write) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let Ok(read) = from.read(&mut buffer) else {
            return;
        };
        if read == 0 {
            return;
        }
        let Some(chunk) = buffer.get(..read) else {
            return;
        };
        if to.write_all(chunk).is_err() || to.flush().is_err() {
            return;
        }
    }
}

fn main() {
    let socket = match connect_or_launch() {
        Ok(socket) => socket,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    let Ok(inbound) = socket.try_clone() else {
        eprintln!("could not open the connection to Blobbies");
        std::process::exit(1);
    };
    // The app's replies go out on stdout on their own thread; this one carries
    // the editor's requests in.
    let outbound = std::thread::spawn(move || pump(inbound, io::stdout()));
    pump(io::stdin(), &socket);
    // Half-close, not a full teardown: the editor closing stdin means "no more
    // requests", and a reply already on the wire still belongs on stdout.
    let _ = socket.shutdown(std::net::Shutdown::Write);
    let _ = outbound.join();
}
