use std::net::{IpAddr, ToSocketAddrs};

use crate::error::{Error, Result};

/// Upper bound on any free-text field arriving from the webview.
const MAX_INPUT_CHARS: usize = 128;

/// Longest legal DNS name; anything longer cannot resolve, so reject early.
const MAX_HOST_CHARS: usize = 253;

/// Validate a free-text value coming from the frontend.
///
/// The webview is a hostile boundary even in a local app: anything rendered in
/// it (or injected into it) can call commands, so every string is length-bound
/// and trimmed here rather than deeper in the call stack.
fn validate_text(value: &str) -> Result<&str> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(Error::EmptyInput);
    }
    if trimmed.chars().count() > MAX_INPUT_CHARS {
        return Err(Error::InputTooLong {
            max: MAX_INPUT_CHARS,
        });
    }

    Ok(trimmed)
}

/// Example command. See <https://tauri.app/develop/calling-rust/>
#[tauri::command]
pub(crate) fn greet(name: &str) -> Result<String> {
    let name = validate_text(name)?;
    Ok(format!("Hello, {name}! You've been greeted from Rust!"))
}

/// Locate the Ollama CLI binary.
///
/// GUI-launched apps inherit a minimal `PATH` (especially on macOS), so the
/// well-known install locations are checked alongside it.
fn find_ollama_binary() -> Option<std::path::PathBuf> {
    let binary = if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    };

    if let Some(path) = std::env::var_os("PATH")
        && let Some(dir) = std::env::split_paths(&path).find(|dir| dir.join(binary).is_file())
    {
        return Some(dir.join(binary));
    }

    #[cfg(target_os = "macos")]
    {
        const FALLBACKS: &[&str] = &[
            "/opt/homebrew/bin/ollama",
            "/usr/local/bin/ollama",
            // The menu-bar app bundles the same CLI; using it directly starts
            // the server without opening the app's chat window.
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ];
        for candidate in FALLBACKS {
            let path = std::path::Path::new(candidate);
            if path.is_file() {
                return Some(path.to_path_buf());
            }
        }
    }

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let exe = std::path::Path::new(&local).join("Programs\\Ollama\\ollama.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }

    None
}

/// True when the macOS menu-bar app is installed (it bundles the server).
#[cfg(target_os = "macos")]
fn macos_ollama_app_installed() -> bool {
    std::path::Path::new("/Applications/Ollama.app").exists()
}

/// True when the Ollama CLI or app is present on this machine, whether or not
/// the server is currently running.
#[tauri::command]
pub(crate) fn ollama_installed() -> bool {
    #[cfg(target_os = "macos")]
    if macos_ollama_app_installed() {
        return true;
    }

    find_ollama_binary().is_some()
}

/// Start the local Ollama server without blocking.
///
/// Always spawns a headless `ollama serve` (never the GUI app, which would
/// open its own chat window). Returns once the process is launched — the
/// frontend polls the HTTP endpoint to learn when the server is actually up.
#[tauri::command]
pub(crate) fn ollama_start() -> Result<()> {
    use std::process::{Command, Stdio};

    let Some(binary) = find_ollama_binary() else {
        return Err(Error::Io("Ollama is not installed".into()));
    };
    Command::new(binary)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::Io(e.to_string()))
}

/// True when `ip` is on the public internet rather than this machine or the
/// local network.
///
/// The webview's HTTP capability can only match hostname patterns, so a public
/// name that resolves inward (`internal.example.com` → `192.168.1.1`, or a
/// rebinding host aimed at cloud metadata on 169.254.169.254) slips straight
/// past it. Everything not provably public is refused.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            // Neither predicate is stable in std: 100.64.0.0/10 is carrier-grade
            // NAT, and 0.0.0.0/8 ("this network") is not routable either.
            let carrier_grade_nat = a == 100 && (64..=127).contains(&b);
            let this_network = a == 0;
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || carrier_grade_nat
                || this_network)
        }
        IpAddr::V6(v6) => {
            let [first, ..] = v6.segments();
            // Unique-local fc00::/7 and link-local fe80::/10 are unstable in std.
            let unique_local = (first & 0xfe00) == 0xfc00;
            let link_local = (first & 0xffc0) == 0xfe80;
            // These must be refused before the IPv4 conversion below, which
            // would otherwise turn ::1 into the v4 address 0.0.0.1.
            if v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || unique_local
                || link_local
            {
                return false;
            }
            // Both ::ffff:192.168.1.1 (mapped) and ::192.168.1.1 (compatible)
            // are IPv4 addresses wearing a hat; judge them as IPv4.
            match v6.to_ipv4() {
                Some(v4) => is_public_ip(IpAddr::V4(v4)),
                None => true,
            }
        }
    }
}

/// Resolve `host` and report whether every answer is a public-internet address.
///
/// Fails closed: an empty/oversized name, a DNS failure, no answers, or a
/// single private answer all return false. Residual risk this cannot close:
/// the HTTP client resolves the name again when it connects, so a record that
/// changes between the two lookups (DNS rebinding) is still possible.
#[tauri::command]
pub(crate) async fn host_is_public(host: String) -> bool {
    if host.is_empty() || host.chars().count() > MAX_HOST_CHARS {
        return false;
    }

    // Name resolution blocks; keep it off the async runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || {
        // The port is irrelevant to resolution, it only completes the socket addr.
        let Ok(addresses) = (host.as_str(), 443u16).to_socket_addrs() else {
            return false;
        };
        let mut resolved_any = false;
        for address in addresses {
            resolved_any = true;
            if !is_public_ip(address.ip()) {
                return false;
            }
        }
        resolved_any
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets_a_valid_name() {
        assert_eq!(
            greet("  Ada  ").unwrap(),
            "Hello, Ada! You've been greeted from Rust!"
        );
    }

    #[test]
    fn rejects_blank_input() {
        assert!(matches!(greet("   "), Err(Error::EmptyInput)));
    }

    #[test]
    fn rejects_oversized_input() {
        let long = "a".repeat(MAX_INPUT_CHARS + 1);
        assert!(matches!(greet(&long), Err(Error::InputTooLong { .. })));
    }

    #[test]
    fn counts_characters_not_bytes() {
        let emoji = "🦀".repeat(MAX_INPUT_CHARS);
        assert!(greet(&emoji).is_ok());
    }

    fn ip(text: &str) -> IpAddr {
        match text.parse() {
            Ok(address) => address,
            Err(_) => unreachable!("test address must parse: {text}"),
        }
    }

    #[test]
    fn accepts_public_addresses() {
        assert!(is_public_ip(ip("93.184.216.34")));
        assert!(is_public_ip(ip("1.1.1.1")));
        assert!(is_public_ip(ip("2606:4700:4700::1111")));
    }

    #[test]
    fn rejects_loopback_and_private_v4() {
        for address in [
            "127.0.0.1",
            "127.0.0.2",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "172.18.0.1",
            "172.31.255.254",
            "0.0.0.0",
        ] {
            assert!(!is_public_ip(ip(address)), "{address} must be refused");
        }
    }

    #[test]
    fn rejects_link_local_and_carrier_grade_nat() {
        // 169.254.169.254 is the cloud metadata endpoint.
        assert!(!is_public_ip(ip("169.254.169.254")));
        assert!(!is_public_ip(ip("100.64.0.1")));
        assert!(!is_public_ip(ip("100.127.255.255")));
        // 100.128.0.0 is outside the CGNAT block and stays public.
        assert!(is_public_ip(ip("100.128.0.1")));
    }

    #[test]
    fn rejects_local_v6_including_mapped_v4() {
        for address in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            // IPv4-mapped and the older IPv4-compatible spelling of the same
            // hosts; both must be judged as their IPv4 address.
            "::ffff:192.168.1.1",
            "::ffff:169.254.169.254",
            "::192.168.1.1",
            "::127.0.0.1",
        ] {
            assert!(!is_public_ip(ip(address)), "{address} must be refused");
        }
    }

    #[test]
    fn refuses_hosts_that_resolve_locally() {
        // Tauri's runtime, so the test needs no extra async dev-dependency.
        tauri::async_runtime::block_on(async {
            assert!(!host_is_public(String::new()).await);
            assert!(!host_is_public("localhost".into()).await);
            assert!(!host_is_public("127.0.0.1".into()).await);
            // .invalid never resolves (RFC 2606), so this needs no network.
            assert!(!host_is_public("no-such-host.invalid".into()).await);
        });
    }
}
