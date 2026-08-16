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

fn entry_for(name: &str) -> Result<keyring::Entry> {
    if !ALLOWED_NAMES.contains(&name) {
        return Err(Error::InvalidSliceKey);
    }
    keyring::Entry::new(SERVICE, name).map_err(|error| Error::Io(error.to_string()))
}

#[tauri::command]
pub(crate) fn secret_get(name: &str) -> Result<Option<String>> {
    match entry_for(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(Error::Io(error.to_string())),
    }
}

#[tauri::command]
pub(crate) fn secret_set(name: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(Error::EmptyInput);
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err(Error::InputTooLong {
            max: MAX_SECRET_BYTES,
        });
    }
    entry_for(name)?
        .set_password(value)
        .map_err(|error| Error::Io(error.to_string()))
}

#[tauri::command]
pub(crate) fn secret_delete(name: &str) -> Result<()> {
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
