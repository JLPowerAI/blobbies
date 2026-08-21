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

/// Slices that live at the data root. `user` holds memories shared by every
/// Blob (per-Blob memories live in that Blob's `config`); `groups` holds the
/// group-chat list (names and ids only — transcripts are their own slices).
const ROOT_SLICES: [&str; 5] = ["settings", "ui-layout", "roster", "user", "groups"];

/// Slices that live inside a Blob directory.
const BLOB_SLICES: [&str; 4] = ["config", "routines", "transcript", "runs"];

/// Slices that live inside a group-chat directory.
const GROUP_SLICES: [&str; 1] = ["transcript"];

/// True for `transcript-1`, `transcript-2`, … — the sealed older halves of a
/// long conversation.
///
/// A conversation is rewritten in full on every save, so one ever-growing
/// slice makes each keystroke cost more than the last (measured: 14ms and 8MB
/// of disk per save at 7,000 messages, 83ms and 64MB at 55,000) and finally
/// trips `MAX_SLICE_BYTES`, at which point nothing saves at all. Rolling the
/// old messages into numbered slices keeps the live one small and cheap;
/// archives are written once and never touched again.
///
/// Deliberately not a general pattern: digits only, no separators, and a
/// length bound, so this widens the allowlist by exactly one shape and cannot
/// express a traversal.
fn is_transcript_archive(slice: &str) -> bool {
    slice.strip_prefix("transcript-").is_some_and(|number| {
        !number.is_empty()
            && number.len() <= 6
            && number.bytes().all(|byte| byte.is_ascii_digit())
            && !number.starts_with('0')
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// True when `id` looks like a hyphenated UUID (lowercase hex, 8-4-4-4-12).
/// Group ids are minted the same way and validated with this too.
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
/// allowlist. Keys are `<root-slice>`, `blobs/<uuid>/<blob-slice>` or
/// `groups/<uuid>/<group-slice>`.
fn resolve_slice_path(data_root: &Path, key: &str) -> Result<PathBuf> {
    if ROOT_SLICES.contains(&key) {
        return Ok(data_root.join(format!("{key}.json")));
    }
    if let Some(rest) = key.strip_prefix("blobs/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
        && (BLOB_SLICES.contains(&slice) || is_transcript_archive(slice))
    {
        return Ok(data_root
            .join("blobs")
            .join(id)
            .join(format!("{slice}.json")));
    }
    if let Some(rest) = key.strip_prefix("groups/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
        && (GROUP_SLICES.contains(&slice) || is_transcript_archive(slice))
    {
        return Ok(data_root
            .join("groups")
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
    // A slice too big to read back must never be written: `read_slice_file`
    // refuses anything over MAX_SLICE_BYTES, so writing it anyway would leave a
    // transcript that can never load again — and the next save, starting from
    // the now-empty state, would overwrite it and take the whole conversation
    // with it. Refusing here keeps the last good file on disk: the newest
    // change is not persisted, everything before it still is.
    if serialized.len() as u64 > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }

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

/// Everything the user owns lives here: rosters, chats, per-Blob home
/// folders. A visible dotfolder in `$HOME` rather than
/// `~/Library/Application Support/<bundle id>/` so the answer to "where is my
/// data" is one path the user can type, back up, sync or delete without
/// knowing the bundle identifier — and so it survives a rename of the app.
///
/// Pure: every store read and write resolves through here, so it stays a
/// path lookup with no filesystem side effects. The one-time migration below
/// runs from `startup_maintenance` instead.
pub(crate) fn data_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    app.path()
        .home_dir()
        .map(|dir| dir.join(".blobbies"))
        .map_err(|error| Error::Io(error.to_string()))
}

/// Bring a pre-`~/.blobbies` install across, once, at startup.
///
/// Copy, never move: the legacy tree is left untouched on disk, so a failure
/// halfway (full disk, permissions) costs the user nothing and the old data
/// is still there to retry from. An already-present root is what makes this
/// once — without that check a user who deleted something would find it
/// restored on the next launch.
fn migrate_legacy_root(app: &tauri::AppHandle, root: &Path) {
    use tauri::Manager;
    if root.exists() {
        return;
    }
    // Derived from the bundle identifier, which is why that identifier is not
    // free to change: renaming it moves this directory, and a user still
    // holding pre-`~/.blobbies` data under the old name would find nothing to
    // migrate — chats that look deleted while sitting safely on disk.
    let Ok(legacy) = app.path().app_data_dir().map(|dir| dir.join("data")) else {
        return;
    };
    if !legacy.is_dir() {
        return;
    }
    // Into a staging path first, renamed into place at the end: an interrupted
    // copy must not leave a half-populated `~/.blobbies` that the check above
    // would then treat as a finished migration.
    let staging = root.with_extension("migrating");
    let _ = fs::remove_dir_all(&staging);
    if copy_dir(&legacy, &staging).is_ok() {
        let _ = fs::rename(&staging, root);
    } else {
        let _ = fs::remove_dir_all(&staging);
    }
}

/// Recursive directory copy; files only, no symlink following.
pub(crate) fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // `file_type` does not follow symlinks, so a link inside the legacy
        // tree is skipped rather than copied through to somewhere else.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Migrate a legacy data root, then purge expired trash. Once, from `run()`,
/// before any command can touch the store.
pub(crate) fn startup_maintenance(app: &tauri::AppHandle) {
    if let Ok(root) = data_root(app) {
        migrate_legacy_root(app, &root);
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

/// Characters allowed in the filename built from a Blob's name.
///
/// The name is user-supplied and lands in a path, so it is filtered to an
/// allowlist rather than checked for the separators we happen to think of.
fn safe_file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = stem.trim_matches('-');
    if trimmed.is_empty() {
        "blob".to_owned()
    } else {
        trimmed.chars().take(40).collect()
    }
}

/// Collect every slice a Blob owns into one JSON object.
///
/// Home-folder *files* are not included: they are already plain files the
/// user can see in Finder, and inlining them would turn a readable export
/// into a base64 blob. Their location is named in the bundle instead.
///
/// Split out from the command so it can be tested without an `AppHandle`.
fn build_export_bundle(root: &Path, id: &str) -> Result<serde_json::Value> {
    if !is_valid_blob_id(id) {
        return Err(Error::InvalidSliceKey);
    }
    let mut bundle = serde_json::Map::new();
    bundle.insert("exportedAt".to_owned(), now_ms().to_string().into());
    bundle.insert("blobId".to_owned(), id.into());
    bundle.insert(
        "homeFolder".to_owned(),
        root.join("blobs")
            .join(id)
            .join("home")
            .to_string_lossy()
            .into_owned()
            .into(),
    );
    for slice in BLOB_SLICES {
        let path = resolve_slice_path(root, &format!("blobs/{id}/{slice}"))?;
        // A slice the Blob never wrote exports as null rather than being
        // absent, so the shape of the file does not depend on its history.
        bundle.insert(
            slice.to_owned(),
            read_slice_file(&path)?.unwrap_or(serde_json::Value::Null),
        );
    }
    // Sealed older halves of a long conversation. Enumerated from disk rather
    // than from a fixed list because their count grows with the conversation;
    // without this an export of a long chat would quietly contain only its
    // most recent messages, which is the data loss this whole mechanism
    // exists to prevent.
    for (index, archive) in transcript_archives(root, id)?.into_iter().enumerate() {
        bundle.insert(
            format!("transcript-{}", index + 1),
            read_slice_file(&archive)?.unwrap_or(serde_json::Value::Null),
        );
    }
    Ok(serde_json::Value::Object(bundle))
}

/// Every `transcript-<n>.json` a Blob owns, ordered oldest first.
///
/// Ordered by the number itself, not by filename: `transcript-10` sorts before
/// `transcript-9` as text, which would interleave a conversation's history.
fn transcript_archives(root: &Path, id: &str) -> Result<Vec<PathBuf>> {
    let dir = root.join("blobs").join(id);
    let mut found: Vec<(u32, PathBuf)> = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if !is_transcript_archive(stem) {
            continue;
        }
        if let Some(number) = stem
            .strip_prefix("transcript-")
            .and_then(|number| number.parse::<u32>().ok())
        {
            found.push((number, entry.path()));
        }
    }
    found.sort_by_key(|(number, _)| *number);
    Ok(found.into_iter().map(|(_, path)| path).collect())
}

/// Where an export lands: a filtered stem plus a fixed suffix, inside
/// `downloads`. Errors if the result would sit anywhere else.
fn export_target(downloads: &Path, name: &str) -> Result<PathBuf> {
    let target = downloads.join(format!(
        "blobbies-{}-{}.json",
        safe_file_stem(name),
        now_ms()
    ));
    // Belt and braces: `safe_file_stem` already strips separators, so this
    // can only fire if that guarantee is ever weakened.
    if target.parent() != Some(downloads) {
        return Err(Error::InvalidSliceKey);
    }
    Ok(target)
}

/// Bundle every slice a Blob owns into one JSON file in Downloads.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_export_blob(app: tauri::AppHandle, id: &str, name: &str) -> Result<PathBuf> {
    use tauri::Manager;

    let root = data_root(&app)?;
    let bundle = build_export_bundle(&root, id)?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| Error::Io(error.to_string()))?;
    let target = export_target(&downloads, name)?;
    let serialized =
        serde_json::to_vec_pretty(&bundle).map_err(|error| Error::Corrupt(error.to_string()))?;
    fs::write(&target, serialized).map_err(|error| Error::Io(error.to_string()))?;
    Ok(target)
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
        assert!(resolve_slice_path(root, "user").is_ok());
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/config")).is_ok());
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/runs")).is_ok());
        assert!(resolve_slice_path(root, "groups").is_ok());
        assert!(resolve_slice_path(root, &format!("groups/{BLOB_ID}/transcript")).is_ok());
        // Sealed halves of a long conversation, for Blobs and groups alike.
        assert_eq!(
            resolve_slice_path(root, &format!("blobs/{BLOB_ID}/transcript-1"))
                .unwrap_or_else(|_| panic!("archive")),
            root.join("blobs").join(BLOB_ID).join("transcript-1.json")
        );
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/transcript-42")).is_ok());
        assert!(resolve_slice_path(root, &format!("groups/{BLOB_ID}/transcript-7")).is_ok());
    }

    #[test]
    fn copies_the_legacy_tree_without_touching_it() {
        let base = temp_root("migrate");
        let legacy = base.join("legacy");
        fs::create_dir_all(legacy.join("blobs").join(BLOB_ID)).expect("legacy tree");
        fs::write(legacy.join("roster.json"), b"[]").expect("roster");
        fs::write(
            legacy.join("blobs").join(BLOB_ID).join("config.json"),
            b"{}",
        )
        .expect("config");

        let root = base.join("new");
        let staging = root.with_extension("migrating");
        copy_dir(&legacy, &staging).expect("copy");
        fs::rename(&staging, &root).expect("rename into place");

        // Every file arrived...
        assert_eq!(
            fs::read(root.join("roster.json")).expect("new roster"),
            b"[]"
        );
        assert!(
            root.join("blobs")
                .join(BLOB_ID)
                .join("config.json")
                .is_file()
        );
        // ...and the old copy is still there to fall back on.
        assert!(legacy.join("roster.json").is_file());
        assert!(!staging.exists());
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
            &format!("groups/{BLOB_ID}/config"),
            "groups/not-a-uuid/transcript",
            "groups/../evil/transcript",
            "unknown",
            "users",
            "user/x",
            "",
            // The archive suffix widens the allowlist by one shape, and only
            // that shape: anything else wearing the prefix stays out.
            &format!("blobs/{BLOB_ID}/transcript-"),
            &format!("blobs/{BLOB_ID}/transcript-0"),
            &format!("blobs/{BLOB_ID}/transcript-01"),
            &format!("blobs/{BLOB_ID}/transcript-1x"),
            &format!("blobs/{BLOB_ID}/transcript-1.1"),
            &format!("blobs/{BLOB_ID}/transcript-9999999"),
            &format!("blobs/{BLOB_ID}/transcript-1/../../evil"),
            &format!("blobs/{BLOB_ID}/routines-1"),
        ] {
            assert!(
                matches!(resolve_slice_path(root, key), Err(Error::InvalidSliceKey)),
                "expected rejection for {key:?}"
            );
        }
    }

    #[test]
    fn export_file_stem_cannot_escape_its_directory() {
        // The Blob name is user-supplied and ends up in a path.
        for name in [
            "../../etc/passwd",
            "..",
            "/absolute",
            "C:\\windows",
            "a/b\\c",
            "name\u{0}with-nul",
        ] {
            let stem = safe_file_stem(name);
            let joined = Path::new("/downloads").join(format!("blobbies-{stem}-1.json"));
            assert_eq!(
                joined.parent(),
                Some(Path::new("/downloads")),
                "escaped for {name:?}"
            );
            assert!(!stem.contains(['/', '\\', '.']), "unsafe stem for {name:?}");
        }
        assert_eq!(safe_file_stem("Ken's Coach"), "ken-s-coach");
        // A name with nothing usable still yields a filename.
        assert_eq!(safe_file_stem("???"), "blob");
        assert!(safe_file_stem(&"x".repeat(500)).len() <= 40);
    }

    #[test]
    fn export_bundle_carries_every_slice_the_blob_owns() {
        let root = temp_root("export-bundle");
        let write = |slice: &str, value: serde_json::Value| {
            let path = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/{slice}"))
                .unwrap_or_else(|_| panic!("path"));
            write_slice_file(&path, value).unwrap_or_else(|_| panic!("write"));
        };
        // Two of the four slices written; the export must still describe all
        // four, so the file's shape does not depend on what the Blob did.
        write("config", serde_json::json!({ "name": "Ken" }));
        write(
            "routines",
            serde_json::json!([{ "id": "r1", "name": "Morning" }]),
        );

        let bundle = build_export_bundle(&root, BLOB_ID).unwrap_or_else(|_| panic!("bundle"));
        let at = |pointer: &str| bundle.pointer(pointer).cloned().unwrap_or_default();
        assert_eq!(at("/blobId"), serde_json::json!(BLOB_ID));
        assert_eq!(at("/config/name"), serde_json::json!("Ken"));
        assert_eq!(at("/routines/0/name"), serde_json::json!("Morning"));
        // Never written, so exported as null rather than missing.
        assert_eq!(at("/transcript"), serde_json::Value::Null);
        assert_eq!(at("/runs"), serde_json::Value::Null);
        // Files are left on disk; the bundle only points at them.
        assert!(
            at("/homeFolder")
                .as_str()
                .unwrap_or_default()
                .ends_with("home")
        );
        // Secrets live in the keychain and settings are app-wide: neither is
        // a per-Blob slice, so neither can ride along in an exported file.
        assert!(bundle.get("settings").is_none());
    }

    #[test]
    fn export_carries_the_archived_half_of_a_long_conversation() {
        // The archives hold everything older than the last few hundred
        // messages, so an export that skipped them would hand the user their
        // most recent chat and call it their history.
        let root = temp_root("export-archives");
        let write = |slice: &str, value: serde_json::Value| {
            let path = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/{slice}"))
                .unwrap_or_else(|_| panic!("path"));
            write_slice_file(&path, value).unwrap_or_else(|_| panic!("write"));
        };
        // Written out of order, and past ten, so text sorting would interleave
        // them: `transcript-10` precedes `transcript-9` as a string.
        write("transcript-10", serde_json::json!([{ "id": "tenth" }]));
        write("transcript-1", serde_json::json!([{ "id": "first" }]));
        write("transcript-9", serde_json::json!([{ "id": "ninth" }]));
        write("transcript", serde_json::json!([{ "id": "live" }]));

        let bundle = build_export_bundle(&root, BLOB_ID).unwrap_or_else(|_| panic!("bundle"));
        let at = |pointer: &str| bundle.pointer(pointer).cloned().unwrap_or_default();
        // Renumbered densely in age order, whatever the files were called.
        assert_eq!(at("/transcript-1/0/id"), serde_json::json!("first"));
        assert_eq!(at("/transcript-2/0/id"), serde_json::json!("ninth"));
        assert_eq!(at("/transcript-3/0/id"), serde_json::json!("tenth"));
        assert_eq!(at("/transcript/0/id"), serde_json::json!("live"));
    }

    #[test]
    fn export_rejects_a_blob_id_that_is_not_a_uuid() {
        let root = temp_root("export-id");
        for id in ["../../etc", "not-a-uuid", ""] {
            assert!(build_export_bundle(&root, id).is_err(), "accepted {id:?}");
        }
    }

    #[test]
    fn export_target_stays_inside_downloads() {
        let downloads = Path::new("/downloads");
        for name in ["Ken", "../../etc/passwd", "/absolute", ".."] {
            let target = export_target(downloads, name).unwrap_or_else(|_| panic!("target"));
            assert_eq!(target.parent(), Some(downloads), "escaped for {name:?}");
            assert_eq!(
                target.extension().and_then(|value| value.to_str()),
                Some("json")
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
    fn an_oversized_write_is_refused_and_the_old_file_survives() {
        let root = temp_root("size-cap");
        let path = resolve_slice_path(&root, "roster").unwrap_or_else(|_| panic!("path"));
        let good = serde_json::json!({ "rows": [] });
        write_slice_file(&path, good.clone()).unwrap_or_else(|_| panic!("write"));

        // Past the cap once serialized pretty (the wrapper adds bytes, so pad
        // well beyond it).
        let huge = serde_json::json!({
            "rows": [],
            "pad": "x".repeat(usize::try_from(MAX_SLICE_BYTES).unwrap_or(usize::MAX) + 64),
        });
        let refused = write_slice_file(&path, huge).expect_err("must refuse");
        assert!(matches!(refused, Error::SliceTooLarge), "got: {refused}");

        // The load side still works and still holds the last good value — this
        // pair is the whole point of the write-side cap. Without it, the file
        // would be written, every future read would fail with SliceTooLarge,
        // and the next save from the (empty) loaded state would destroy it.
        let read = read_slice_file(&path).unwrap_or_else(|_| panic!("read"));
        assert_eq!(read, Some(good));
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
