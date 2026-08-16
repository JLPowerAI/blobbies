//! OS-keychain storage for the few secrets the app holds.
//!
//! Same default-deny posture as `store.rs`: the webview can only touch
//! secrets whose names are on the allowlist below, so a compromised frontend
//! cannot enumerate or overwrite arbitrary keychain entries.

use crate::error::{Error, Result};

/// Keychain service the entries live under (shows up in Keychain Access).
const SERVICE: &str = "com.blobbies.app";

/// Every secret name the webview may read or write. Default-deny.
const ALLOWED_NAMES: [&str; 2] = ["tinfoil-api-key", "tinfoil-cache-secret"];

/// Upper bound on a stored secret (bytes). Keys and cache secrets are tiny;
/// anything bigger is a bug or abuse.
const MAX_SECRET_BYTES: usize = 4 * 1024;

fn ensure_allowed(name: &str) -> Result<()> {
    if ALLOWED_NAMES.contains(&name) {
        Ok(())
    } else {
        Err(Error::InvalidSliceKey)
    }
}

fn entry_for(name: &str) -> Result<keyring::Entry> {
    ensure_allowed(name)?;
    keyring::Entry::new(SERVICE, name).map_err(|error| Error::Io(error.to_string()))
}

/// Dev-only escape hatch from the keychain, compiled out of release builds.
///
/// macOS ties a keychain item's ACL to the code-signature hash of the binary
/// that created it, and `tauri dev` links a fresh ad-hoc signature on every
/// rebuild (`Signature=adhoc`, `TeamIdentifier=not set`). Each rebuild is
/// therefore a different program to the OS: it re-prompts for the device
/// password and "Always Allow" can never stick.
///
/// Exporting `TINFOIL_API_KEY` before `pnpm tauri:dev` switches secrets to the
/// environment plus a process-local map, so a debug build never touches the
/// keychain and never prompts. Unset, dev behaves exactly like release.
///
/// While active, saving or removing a key in Settings only edits the map: it
/// lasts for the session and leaves the real keychain entry untouched.
#[cfg(debug_assertions)]
mod dev {
    use std::collections::HashMap;
    use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

    /// Opt-in switch: the Tinfoil key the developer exported for this session.
    fn env_api_key() -> Option<String> {
        std::env::var("TINFOIL_API_KEY")
            .ok()
            .filter(|key| !key.is_empty())
    }

    /// True once the developer opted in; checked before every keychain call.
    pub(super) fn active() -> bool {
        env_api_key().is_some()
    }

    /// Seeded from the environment, then read/write for the life of the
    /// process. The cache secret is regenerated each launch as a result,
    /// costing dev one server-side prompt-cache miss and zero prompts.
    fn scratch() -> &'static Mutex<HashMap<String, String>> {
        static SCRATCH: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        SCRATCH.get_or_init(|| {
            let mut seeded = HashMap::new();
            if let Some(key) = env_api_key() {
                seeded.insert("tinfoil-api-key".to_owned(), key);
            }
            Mutex::new(seeded)
        })
    }

    /// A poisoned lock means another thread panicked mid-write; the map holds
    /// only dev secrets, so recovering beats taking the whole app down.
    fn map() -> MutexGuard<'static, HashMap<String, String>> {
        scratch().lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn get(name: &str) -> Option<String> {
        map().get(name).cloned()
    }

    pub(super) fn set(name: &str, value: &str) {
        map().insert(name.to_owned(), value.to_owned());
    }

    pub(super) fn delete(name: &str) {
        map().remove(name);
    }
}

#[tauri::command]
pub(crate) fn secret_get(name: &str) -> Result<Option<String>> {
    ensure_allowed(name)?;
    #[cfg(debug_assertions)]
    if dev::active() {
        return Ok(dev::get(name));
    }
    match entry_for(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(Error::Io(error.to_string())),
    }
}

#[tauri::command]
pub(crate) fn secret_set(name: &str, value: &str) -> Result<()> {
    ensure_allowed(name)?;
    if value.is_empty() {
        return Err(Error::EmptyInput);
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err(Error::InputTooLong {
            max: MAX_SECRET_BYTES,
        });
    }
    #[cfg(debug_assertions)]
    if dev::active() {
        dev::set(name, value);
        return Ok(());
    }
    entry_for(name)?
        .set_password(value)
        .map_err(|error| Error::Io(error.to_string()))
}

#[tauri::command]
pub(crate) fn secret_delete(name: &str) -> Result<()> {
    ensure_allowed(name)?;
    #[cfg(debug_assertions)]
    if dev::active() {
        dev::delete(name);
        return Ok(());
    }
    match entry_for(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::Io(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_off_the_allowlist() {
        for name in [
            "",
            "tinfoil-api-key-2",
            "TINFOIL-API-KEY",
            "../tinfoil-api-key",
            "openai-api-key",
        ] {
            assert!(
                matches!(entry_for(name), Err(Error::InvalidSliceKey)),
                "expected rejection for {name:?}"
            );
        }
    }

    #[test]
    fn accepts_allowlisted_names() {
        for name in ALLOWED_NAMES {
            assert!(entry_for(name).is_ok());
        }
    }

    /// Every command must reject an off-allowlist name before it reaches the
    /// keychain — or, in a debug build, the dev map. These names never touch
    /// either backend, so the test is safe to run unattended.
    #[test]
    fn commands_enforce_the_allowlist_before_any_backend() {
        for name in ["", "openai-api-key", "../tinfoil-api-key"] {
            assert!(matches!(secret_get(name), Err(Error::InvalidSliceKey)));
            assert!(matches!(secret_set(name, "x"), Err(Error::InvalidSliceKey)));
            assert!(matches!(secret_delete(name), Err(Error::InvalidSliceKey)));
        }
    }

    /// The dev backend is a plain per-process map: what goes in comes back and
    /// delete removes it, so Settings behaves the same as against the keychain.
    #[cfg(debug_assertions)]
    #[test]
    fn dev_backend_round_trips_without_the_keychain() {
        dev::set("tinfoil-cache-secret", "scratch-value");
        assert_eq!(
            dev::get("tinfoil-cache-secret"),
            Some("scratch-value".to_owned())
        );
        dev::delete("tinfoil-cache-secret");
        assert_eq!(dev::get("tinfoil-cache-secret"), None);
    }

    #[test]
    fn rejects_oversized_and_empty_values() {
        assert!(matches!(
            secret_set("tinfoil-api-key", ""),
            Err(Error::EmptyInput)
        ));
        let oversized = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(matches!(
            secret_set("tinfoil-api-key", &oversized),
            Err(Error::InputTooLong { .. })
        ));
    }
}
