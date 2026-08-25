//! Loopback front door for the Agent Client Protocol.
//!
//! An external editor (Zed, `JetBrains`, Neovim) speaks ACP over stdio to the
//! `blobbies-acp` relay, which forwards the bytes here; this module hands them
//! to the webview, where the Blobs, groups, memories and transcripts already
//! live. Nothing in this file understands ACP — it is a framed, authenticated
//! pipe, and `src/lib/acp/host.ts` is the agent.
//!
//! It exists at all because the running app *is* the agent: turns are
//! serialized app-wide against one local model and `~/.blobbies` has a single
//! writer. A second process speaking ACP would be a second writer and a second
//! orchestrator.
//!
//! This is a new local control surface — anything that reaches it can drive a
//! Blob's shell tools, files and MCP credentials — so it is careful about:
//!
//! - **Off unless the user turns it on.** No listener exists otherwise.
//! - **127.0.0.1 only, never the wildcard**, so nothing off-machine can reach it.
//! - **A 32-byte CSPRNG token as the first line**, compared in constant time,
//!   read from a file only the user can read. A connection that does not send
//!   it within a few seconds is closed having done nothing.
//! - **Bounded frames.** A client that opens a socket and streams forever
//!   cannot take the app's memory.
//! - **No parsing.** Frames are opaque lines here; the webview validates them
//!   as JSON-RPC and treats every string in them as untrusted text.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

/// Longest single ACP frame accepted, in bytes.
///
/// A prompt carrying a few files is tens of kilobytes; a megabyte is already
/// far past anything an editor sends, and the cap is what stops an
/// unauthenticated socket from growing a buffer without bound.
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// How long a fresh connection has to present its token, in total.
///
/// A wall-clock budget rather than a per-read timeout: a client dribbling one
/// byte at a time would otherwise hold a thread for as many timeouts as the
/// token has bytes.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Sockets that may exist at once, authenticated or not.
///
/// An editor opens one. The cap is what stops a local process from spending
/// the app's threads by connecting in a loop and never speaking.
const MAX_CONNECTIONS: usize = 16;

/// Token length in bytes, before hex encoding.
const TOKEN_BYTES: usize = 32;

/// Event names the webview listens on. Payloads are `FramePayload`/`ConnPayload`.
const EVENT_FRAME: &str = "acp://frame";
const EVENT_OPEN: &str = "acp://open";
const EVENT_CLOSE: &str = "acp://close";

#[derive(Debug, Clone, Serialize)]
struct FramePayload {
    id: u64,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct ConnPayload {
    id: u64,
}

/// What the Settings panel needs to show, and what the relay needs to connect.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AcpInfo {
    /// Loopback port the listener is on.
    port: u16,
    /// Absolute path of the file holding the port and token.
    #[serde(rename = "configPath")]
    config_path: String,
}

#[derive(Debug)]
struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    config_path: String,
}

#[derive(Debug, Default)]
struct AcpState {
    server: Option<Server>,
    next_id: u64,
    /// Write halves of live connections, by id.
    connections: HashMap<u64, TcpStream>,
    /// Sockets accepted and not yet finished, including unauthenticated ones.
    open: usize,
}

static STATE: OnceLock<Mutex<AcpState>> = OnceLock::new();

/// The shared state, recovering a poisoned lock rather than panicking: a
/// relay thread that died mid-write must not take the whole bridge with it.
fn state() -> std::sync::MutexGuard<'static, AcpState> {
    STATE
        .get_or_init(|| Mutex::new(AcpState::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Compare two secrets without leaking their common prefix through timing.
fn secret_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// A hex token from the OS CSPRNG.
fn mint_token() -> Result<String> {
    use std::fmt::Write as _;
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| Error::Io(error.to_string()))?;
    Ok(bytes.iter().fold(String::new(), |mut token, byte| {
        let _ = write!(token, "{byte:02x}");
        token
    }))
}

/// Read one newline-terminated frame, refusing anything past `max` bytes.
///
/// `Ok(None)` is a clean end of stream. The newline is not returned.
fn read_frame<R: BufRead>(reader: &mut R, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut frame: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if frame.is_empty() { None } else { Some(frame) });
        }
        if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
            frame.extend_from_slice(available.get(..index).unwrap_or_default());
            reader.consume(index + 1);
            if frame.len() > max {
                return Err(std::io::Error::new(
                    ErrorKind::InvalidData,
                    "frame too large",
                ));
            }
            return Ok(Some(frame));
        }
        let len = available.len();
        frame.extend_from_slice(available);
        reader.consume(len);
        if frame.len() > max {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "frame too large",
            ));
        }
    }
}

/// Write the port and token where only this user can read them.
fn write_config(path: &std::path::Path, port: u16, token: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;
    }
    let body = serde_json::json!({ "port": port, "token": token }).to_string();

    // Unlink first, then create exclusively.
    //
    // `.mode(0o600)` is applied *only when the file is created*: opening an
    // existing path with `create(true)` silently keeps whatever permissions it
    // already had. A local process that pre-creates `acp.json` world-readable,
    // or points it at a file it can read, would then be handed the token — the
    // one secret standing between it and the Blobs' tools and credentials.
    // `create_new` is `O_EXCL|O_CREAT`, which both guarantees the mode applies
    // and refuses to follow a symlink at the final path component.
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        // A path that cannot be removed must not be written either: swallowing
        // this would turn a permissions problem into a confusing EEXIST below.
        Err(error) => return Err(Error::Io(error.to_string())),
    }

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // simplification: on Windows the file inherits the ACL of the user's
    // profile directory, which is already user-scoped; an explicit DACL would
    // need the Win32 security APIs for no gain on a single-user desktop.
    let mut file = options
        .open(path)
        .map_err(|error| Error::Io(error.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|error| Error::Io(error.to_string()))?;
    Ok(())
}

/// Serve one accepted socket: token first, then frames to the webview.
fn serve(app: &AppHandle, socket: &TcpStream, token: &str) {
    let Ok(peer_read) = socket.try_clone() else {
        return;
    };
    // Only the handshake is on a clock. After it, an idle editor is normal —
    // a session can sit open for hours between prompts.
    let deadline = std::time::Instant::now() + HANDSHAKE_TIMEOUT;
    let _ = socket.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let mut reader = BufReader::new(peer_read);
    let Ok(Some(offered)) = read_frame(&mut reader, TOKEN_BYTES * 2 + 1) else {
        return;
    };
    if std::time::Instant::now() > deadline {
        return;
    }
    let Ok(offered) = String::from_utf8(offered) else {
        return;
    };
    if !secret_eq(offered.trim(), token) {
        return;
    }
    let _ = socket.set_read_timeout(None);
    let id = {
        let mut state = state();
        state.next_id += 1;
        let id = state.next_id;
        if let Ok(write_half) = socket.try_clone() {
            state.connections.insert(id, write_half);
        }
        id
    };
    let _ = app.emit(EVENT_OPEN, ConnPayload { id });
    while let Ok(Some(frame)) = read_frame(&mut reader, MAX_FRAME_BYTES) {
        // Lossless or nothing: a frame that is not UTF-8 is not JSON-RPC, and
        // repairing it would hand the webview something the client never sent.
        let Ok(line) = String::from_utf8(frame) else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        if app.emit(EVENT_FRAME, FramePayload { id, line }).is_err() {
            break;
        }
    }
    state().connections.remove(&id);
    let _ = app.emit(EVENT_CLOSE, ConnPayload { id });
}

/// Take a connection slot, or refuse when the cap is already reached.
fn claim_slot() -> bool {
    let mut state = state();
    if state.open >= MAX_CONNECTIONS {
        return false;
    }
    state.open += 1;
    true
}

/// Start the listener, replacing any previous one, and report where it is.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn acp_start(app: AppHandle) -> Result<AcpInfo> {
    acp_stop();
    let token = mint_token()?;
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|error| Error::Io(error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| Error::Io(error.to_string()))?
        .port();
    let path = crate::store::data_root(&app)?.join("acp.json");
    write_config(&path, port, &token)?;
    let config_path = path.to_string_lossy().into_owned();
    let stop = Arc::new(AtomicBool::new(false));
    let accepting = Arc::clone(&stop);
    let handle = app.clone();
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if accepting.load(Ordering::SeqCst) {
                break;
            }
            let Ok(socket) = incoming else { continue };
            if !claim_slot() {
                // Refused before a thread exists, so the cost of a flood is
                // one accept and one close.
                let _ = socket.shutdown(std::net::Shutdown::Both);
                continue;
            }
            let app = handle.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                serve(&app, &socket, &token);
                let mut state = state();
                state.open = state.open.saturating_sub(1);
            });
        }
    });
    let mut state = state();
    state.server = Some(Server {
        port,
        stop,
        config_path: config_path.clone(),
    });
    Ok(AcpInfo { port, config_path })
}

/// Stop listening, drop every live connection, and remove the token file.
#[tauri::command]
pub(crate) fn acp_stop() {
    let server = {
        let mut state = state();
        for (_, socket) in state.connections.drain() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
        state.server.take()
    };
    let Some(server) = server else { return };
    server.stop.store(true, Ordering::SeqCst);
    // Unblock the accept loop, which is parked inside `incoming()`.
    if let Ok(waker) = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, server.port))) {
        let _ = waker.shutdown(std::net::Shutdown::Both);
    }
    // The token is worthless from here on; leaving it on disk only invites a
    // stale client to keep trying.
    let _ = std::fs::remove_file(&server.config_path);
}

/// Send one frame to a connected client.
#[tauri::command]
pub(crate) fn acp_send(id: u64, line: String) -> Result<()> {
    let mut state = state();
    let Some(socket) = state.connections.get_mut(&id) else {
        return Err(Error::Io("that ACP client has disconnected".into()));
    };
    let mut framed = line.into_bytes();
    framed.push(b'\n');
    socket
        .write_all(&framed)
        .map_err(|error| Error::Io(error.to_string()))
}

/// Drop one connection — how the webview refuses a client the user did not pair.
#[tauri::command]
pub(crate) fn acp_close(id: u64) {
    if let Some(socket) = state().connections.remove(&id) {
        let _ = socket.shutdown(std::net::Shutdown::Both);
    }
}

/// Absolute path of the `blobbies-acp` relay, for the editor's config snippet.
///
/// Read from the running binary's own directory rather than guessed: the
/// sidecar is bundled beside the app executable, and that location differs on
/// every platform.
#[tauri::command]
pub(crate) fn acp_relay_path() -> Result<String> {
    let exe = std::env::current_exe().map_err(|error| Error::Io(error.to_string()))?;
    let name = if cfg!(windows) {
        "blobbies-acp.exe"
    } else {
        "blobbies-acp"
    };
    let path = exe
        .parent()
        .ok_or_else(|| Error::Io("could not locate the app directory".into()))?
        .join(name);
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{MAX_FRAME_BYTES, read_frame, secret_eq, write_config};
    use std::io::Cursor;

    #[test]
    fn matches_only_the_exact_token() {
        assert!(secret_eq("abc123", "abc123"));
        assert!(!secret_eq("abc123", "abc124"));
        assert!(!secret_eq("abc123", "abc1234"));
        assert!(!secret_eq("", "a"));
    }

    #[test]
    fn reads_one_frame_at_a_time() {
        let mut input = Cursor::new(b"one\ntwo\n".to_vec());
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(b"one".to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(b"two".to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), None);
    }

    #[test]
    fn returns_a_final_frame_with_no_newline() {
        let mut input = Cursor::new(b"tail".to_vec());
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(b"tail".to_vec()));
    }

    #[test]
    fn refuses_a_frame_past_the_cap() {
        let mut input = Cursor::new(vec![b'x'; 128]);
        let error = read_frame(&mut input, 16).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn refuses_an_endless_unterminated_stream() {
        let mut input = Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]);
        assert!(read_frame(&mut input, MAX_FRAME_BYTES).is_err());
    }

    /// The token file must be owner-only *even when the path already exists*.
    ///
    /// `.mode()` applies only at creation, so writing over a file another
    /// local process pre-created world-readable would hand it the token.
    #[cfg(unix)]
    #[test]
    fn rewrites_a_world_readable_token_file_as_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("acp-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("acp.json");

        // Someone got there first, with a file anyone can read.
        std::fs::write(&path, b"planted").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_config(&path, 1234, "secret-token").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "token file must not stay group/world readable");
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("secret-token")
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
