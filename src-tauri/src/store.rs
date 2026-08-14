//! Versioned JSON slice storage under the app data directory.
//!
//! One JSON file per slice, each wrapped as `{"schemaVersion": N, "value": …}`.
//! All writes are atomic (tmp file + rename) and every path is validated
//! against an allowlist before touching the filesystem, so the webview can
//! never escape the data root or invent new files.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Newest slice schema this build understands.
const SCHEMA_VERSION: u64 = 1;

/// Upper bound on any slice file we are willing to read (bytes).
const MAX_SLICE_BYTES: u64 = 8 * 1024 * 1024;

/// Trash entries older than this are purged on startup (30 days).
const TRASH_TTL_MS: u128 = 30 * 24 * 60 * 60 * 1000;

/// Wire format for every slice file.
#[derive(Debug, Serialize, Deserialize)]
struct Slice {
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    value: serde_json::Value,
}

/// Marker dropped into a trashed Blob directory.
#[derive(Debug, Serialize, Deserialize)]
struct TrashMarker {
    #[serde(rename = "deletedAt")]
    deleted_at_ms: u128,
}

/// Slices that live at the data root.
const ROOT_SLICES: [&str; 3] = ["settings", "ui-layout", "roster"];

/// Slices that live inside a Blob directory.
const BLOB_SLICES: [&str; 3] = ["config", "routines", "transcript"];

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// True when `id` looks like a hyphenated UUID (lowercase hex, 8-4-4-4-12).
fn is_valid_blob_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
    })
}

/// Resolve a slice key to its on-disk path, rejecting anything not on the
/// allowlist. Keys are either `<root-slice>` or `blobs/<uuid>/<blob-slice>`.
fn resolve_slice_path(data_root: &Path, key: &str) -> Result<PathBuf> {
    if ROOT_SLICES.contains(&key) {
        return Ok(data_root.join(format!("{key}.json")));
    }
    if let Some(rest) = key.strip_prefix("blobs/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
        && BLOB_SLICES.contains(&slice)
    {
        return Ok(data_root
            .join("blobs")
            .join(id)
            .join(format!("{slice}.json")));
    }
    Err(Error::InvalidSliceKey)
}

/// Read and validate a slice file. `Ok(None)` when it does not exist yet.
fn read_slice_file(path: &Path) -> Result<Option<serde_json::Value>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    if metadata.len() > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }
    let raw = fs::read(path).map_err(|error| Error::Io(error.to_string()))?;
    let slice: Slice =
        serde_json::from_slice(&raw).map_err(|error| Error::Corrupt(error.to_string()))?;
    if slice.schema_version > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: slice.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(Some(slice.value))
}

/// Atomically write a slice file: serialize to `<path>.tmp`, fsync, rename.
fn write_slice_file(path: &Path, value: serde_json::Value) -> Result<()> {
    let parent = path.parent().ok_or(Error::InvalidSliceKey)?;
    fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;

    let slice = Slice {
        schema_version: SCHEMA_VERSION,
        value,
    };
    let serialized =
        serde_json::to_vec_pretty(&slice).map_err(|error| Error::Corrupt(error.to_string()))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|error| Error::Io(error.to_string()))?;
        file.write_all(&serialized)
            .and_then(|()| file.sync_all())
            .map_err(|error| Error::Io(error.to_string()))?;
    }
    fs::rename(&tmp, path).map_err(|error| Error::Io(error.to_string()))
}

/// Move a Blob directory into the trash with a deletion timestamp.
fn delete_blob_dir(data_root: &Path, id: &str) -> Result<()> {
    if !is_valid_blob_id(id) {
        return Err(Error::InvalidSliceKey);
    }
    let source = data_root.join("blobs").join(id);
    if !source.is_dir() {
        return Err(Error::BlobNotFound);
    }
    let trash_root = data_root.join("trash");
    fs::create_dir_all(&trash_root).map_err(|error| Error::Io(error.to_string()))?;
    let target = trash_root.join(id);
    if target.exists() {
        // Re-deleting the same id: replace the stale trash entry.
        fs::remove_dir_all(&target).map_err(|error| Error::Io(error.to_string()))?;
    }
    fs::rename(&source, &target).map_err(|error| Error::Io(error.to_string()))?;

    let marker = TrashMarker {
        deleted_at_ms: now_ms(),
    };
    let serialized =
        serde_json::to_vec_pretty(&marker).map_err(|error| Error::Corrupt(error.to_string()))?;
    fs::write(target.join("deleted.json"), serialized).map_err(|error| Error::Io(error.to_string()))
}

/// Remove trash entries older than [`TRASH_TTL_MS`]. Best-effort: errors on
/// individual entries are ignored so one bad dir can't block startup.
fn purge_trash_dir(data_root: &Path) {
    let trash_root = data_root.join("trash");
    let Ok(entries) = fs::read_dir(&trash_root) else {
        return;
    };
    let now = now_ms();
    for entry in entries.flatten() {
        let dir = entry.path();
        let marker_path = dir.join("deleted.json");
        let expired = fs::read(&marker_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<TrashMarker>(&raw).ok())
            .is_none_or(|marker| now.saturating_sub(marker.deleted_at_ms) > TRASH_TTL_MS);
        if expired {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

/// List ids of all live (non-trashed) Blob directories.
fn list_blob_ids(data_root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(data_root.join("blobs")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_valid_blob_id(name))
        .collect();
    ids.sort();
    ids
}

fn data_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("data"))
        .map_err(|error| Error::Io(error.to_string()))
}

/// Purge expired trash on startup. Call once from `run()`.
pub(crate) fn startup_maintenance(app: &tauri::AppHandle) {
    if let Ok(root) = data_root(app) {
        purge_trash_dir(&root);
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_read(app: tauri::AppHandle, key: &str) -> Result<Option<serde_json::Value>> {
    let root = data_root(&app)?;
    read_slice_file(&resolve_slice_path(&root, key)?)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_write(
    app: tauri::AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<()> {
    let root = data_root(&app)?;
    write_slice_file(&resolve_slice_path(&root, key)?, value)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_delete_blob(app: tauri::AppHandle, id: &str) -> Result<()> {
    let root = data_root(&app)?;
    delete_blob_dir(&root, id)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_list_blobs(app: tauri::AppHandle) -> Result<Vec<String>> {
    let root = data_root(&app)?;
    Ok(list_blob_ids(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("blobbies-store-tests")
            .join(format!("{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap_or_else(|_| panic!("create temp dir"));
        dir
    }

    const BLOB_ID: &str = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";

    #[test]
    fn resolves_root_and_blob_slices() {
        let root = Path::new("/data");
        assert!(resolve_slice_path(root, "roster").is_ok());
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/config")).is_ok());
    }

    #[test]
    fn rejects_traversal_and_unknown_keys() {
        let root = Path::new("/data");
        for key in [
            "../roster",
            "settings/../../etc/passwd",
            "blobs/../evil/config",
            "blobs/not-a-uuid/config",
            &format!("blobs/{BLOB_ID}/unknown"),
            "unknown",
            "",
        ] {
            assert!(
                matches!(resolve_slice_path(root, key), Err(Error::InvalidSliceKey)),
                "expected rejection for {key:?}"
            );
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let root = temp_root("round-trip");
        let path = resolve_slice_path(&root, "roster").unwrap_or_else(|_| panic!("path"));
        let value = serde_json::json!({ "rows": [{ "id": BLOB_ID, "name": "Ken" }] });
        write_slice_file(&path, value.clone()).unwrap_or_else(|_| panic!("write"));
        let read = read_slice_file(&path).unwrap_or_else(|_| panic!("read"));
        assert_eq!(read, Some(value));
    }

    #[test]
    fn missing_slice_reads_as_none() {
        let root = temp_root("missing");
        let path = resolve_slice_path(&root, "settings").unwrap_or_else(|_| panic!("path"));
        assert_eq!(
            read_slice_file(&path).unwrap_or_else(|_| panic!("read")),
            None
        );
    }

    #[test]
    fn rejects_newer_schema_without_overwrite() {
        let root = temp_root("schema");
        let path = root.join("settings.json");
        fs::write(&path, br#"{"schemaVersion": 99, "value": {}}"#)
            .unwrap_or_else(|_| panic!("seed"));
        assert!(matches!(
            read_slice_file(&path),
            Err(Error::SchemaTooNew { found: 99, .. })
        ));
    }

    #[test]
    fn rejects_corrupt_json() {
        let root = temp_root("corrupt");
        let path = root.join("roster.json");
        fs::write(&path, b"not json").unwrap_or_else(|_| panic!("seed"));
        assert!(matches!(read_slice_file(&path), Err(Error::Corrupt(_))));
    }

    #[test]
    fn delete_moves_to_trash_and_purge_removes_expired() {
        let root = temp_root("delete");
        let config = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/config"))
            .unwrap_or_else(|_| panic!("path"));
        write_slice_file(&config, serde_json::json!({ "name": "Ken" }))
            .unwrap_or_else(|_| panic!("write"));

        delete_blob_dir(&root, BLOB_ID).unwrap_or_else(|_| panic!("delete"));
        assert!(!root.join("blobs").join(BLOB_ID).exists());
        let trashed = root.join("trash").join(BLOB_ID);
        assert!(trashed.join("config.json").exists());
        assert!(trashed.join("deleted.json").exists());

        // Fresh marker: purge keeps it.
        purge_trash_dir(&root);
        assert!(trashed.exists());

        // Expired marker: purge removes it.
        let marker = TrashMarker {
            deleted_at_ms: now_ms().saturating_sub(TRASH_TTL_MS + 1),
        };
        fs::write(
            trashed.join("deleted.json"),
            serde_json::to_vec(&marker).unwrap_or_else(|_| panic!("serialize")),
        )
        .unwrap_or_else(|_| panic!("seed marker"));
        purge_trash_dir(&root);
        assert!(!trashed.exists());
    }

    #[test]
    fn deleting_missing_blob_errors() {
        let root = temp_root("delete-missing");
        assert!(matches!(
            delete_blob_dir(&root, BLOB_ID),
            Err(Error::BlobNotFound)
        ));
    }

    #[test]
    fn lists_only_valid_blob_dirs() {
        let root = temp_root("list");
        let config = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/config"))
            .unwrap_or_else(|_| panic!("path"));
        write_slice_file(&config, serde_json::json!({})).unwrap_or_else(|_| panic!("write"));
        fs::create_dir_all(root.join("blobs").join("junk")).unwrap_or_else(|_| panic!("junk"));
        assert_eq!(list_blob_ids(&root), vec![BLOB_ID.to_owned()]);
    }

    #[test]
    fn blob_id_validation() {
        assert!(is_valid_blob_id(BLOB_ID));
        assert!(!is_valid_blob_id("61EC34F1-9BA5-4EFF-B8E1-7ACEFB2148EA"));
        assert!(!is_valid_blob_id("../../../etc"));
        assert!(!is_valid_blob_id("61ec34f19ba54effb8e17acefb2148ea"));
    }
}
