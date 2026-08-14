use crate::error::{Error, Result};

/// Upper bound on any free-text field arriving from the webview.
const MAX_INPUT_CHARS: usize = 128;

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
}
