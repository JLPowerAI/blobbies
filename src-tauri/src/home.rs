//! Per-Blob file workspace ("home") under the app data directory.
//!
//! Every Blob gets `<data>/blobs/<uuid>/home/`; the agent's file tools operate
//! only inside it. Same fail-closed posture as `store.rs`: UUID-validated ids,
//! relative paths only, `..` rejected up front, and the canonical path is
//! re-checked against the canonical home root so a symlink cannot escape.
//!
//! No shell access here by design: `blob_home_shell` deliberately does not
//! exist. A command runner on the user's machine is a different risk class and
//! needs its own review before it is ever added.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::store::data_root;

/// Cap on a single file the model may read or write (bytes). Matches the
/// budget reasoning in `store.rs`: a small local model cannot use more.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// Cap on directory entries returned to the model.
const MAX_LIST_ENTRIES: usize = 500;

/// Total workspace budget per Blob (bytes) so a looping agent cannot fill the
/// disk: 64 MiB is hundreds of text files, far beyond what a turn needs.
const MAX_HOME_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeEntry {
    name: String,
    size: u64,
    modified_ms: u128,
    is_dir: bool,
}

/// True when `id` looks like a hyphenated lowercase UUID. Duplicated from
/// `store.rs` (private there); the two must stay in lockstep.
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

/// The Blob's home directory, created on first use.
fn home_root(data_root: &Path, id: &str) -> Result<PathBuf> {
    if !is_valid_blob_id(id) {
        return Err(Error::InvalidSliceKey);
    }
    let root = data_root.join("blobs").join(id).join("home");
    fs::create_dir_all(&root).map_err(|error| Error::Io(error.to_string()))?;
    Ok(root)
}

/// Resolve a model-supplied relative path inside the home, fail-closed.
///
/// Rejects absolute paths, drive prefixes, `..` and empty input before any
/// filesystem access; then verifies the canonicalized parent still lives
/// under the canonicalized home so symlinks cannot escape either.
fn resolve_in_home(home: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() || relative.len() > 512 {
        return Err(Error::PathOutsideHome);
    }
    let candidate = Path::new(relative);
    if candidate
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(Error::PathOutsideHome);
    }
    let joined = home.join(candidate);
    // Canonicalize the deepest existing ancestor: the file itself may not
    // exist yet on a write, but every symlink on the way to it does.
    let mut existing = joined.clone();
    let mut suffix = PathBuf::new();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            return Err(Error::PathOutsideHome);
        };
        suffix = match existing.file_name() {
            // Joining an empty PathBuf appends a trailing separator, which
            // macOS treats as "must be a directory" — so only join non-empty.
            Some(name) if suffix.as_os_str().is_empty() => PathBuf::from(name),
            Some(name) => Path::new(name).join(suffix),
            None => return Err(Error::PathOutsideHome),
        };
        existing = parent.to_path_buf();
    }
    let canonical_home = home
        .canonicalize()
        .map_err(|error| Error::Io(error.to_string()))?;
    let canonical = existing
        .canonicalize()
        .map_err(|error| Error::Io(error.to_string()))?;
    if !canonical.starts_with(&canonical_home) {
        return Err(Error::PathOutsideHome);
    }
    if suffix.as_os_str().is_empty() {
        return Ok(canonical);
    }
    Ok(canonical.join(suffix))
}

/// Recursive size of the home dir; symlinks are not followed.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(metadata) = entry.path().symlink_metadata() else {
                return 0;
            };
            if metadata.is_dir() {
                dir_size(&entry.path())
            } else {
                metadata.len()
            }
        })
        .sum()
}

fn read_entry(entry: &fs::DirEntry) -> Option<HomeEntry> {
    let metadata = entry.path().symlink_metadata().ok()?;
    // Symlinks are invisible to the model: it cannot create them through
    // these commands, so any present were planted externally.
    if metadata.file_type().is_symlink() {
        return None;
    }
    Some(HomeEntry {
        name: entry.file_name().into_string().ok()?,
        size: metadata.len(),
        modified_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_millis()),
        is_dir: metadata.is_dir(),
    })
}

fn list_dir(home: &Path, dir: Option<&str>) -> Result<Vec<HomeEntry>> {
    let target = match dir {
        None | Some("" | ".") => home.to_path_buf(),
        Some(relative) => resolve_in_home(home, relative)?,
    };
    let entries = match fs::read_dir(&target) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    let mut rows: Vec<HomeEntry> = entries
        .flatten()
        .filter_map(|entry| read_entry(&entry))
        .take(MAX_LIST_ENTRIES)
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

fn read_file(home: &Path, relative: &str) -> Result<String> {
    let path = resolve_in_home(home, relative)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::FileNotFound);
        }
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    if metadata.is_dir() {
        return Err(Error::FileNotFound);
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(Error::FileTooLarge);
    }
    let raw = fs::read(&path).map_err(|error| Error::Io(error.to_string()))?;
    String::from_utf8(raw).map_err(|_| Error::NotText)
}

fn write_file(home: &Path, relative: &str, content: &str) -> Result<()> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::FileTooLarge);
    }
    if dir_size(home) + content.len() as u64 > MAX_HOME_BYTES {
        return Err(Error::HomeFull);
    }
    let path = resolve_in_home(home, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;
    }
    // Atomic like store.rs: tmp + rename, so a crash never leaves half a file.
    let tmp = path.with_extension("blobtmp");
    fs::write(&tmp, content).map_err(|error| Error::Io(error.to_string()))?;
    fs::rename(&tmp, &path).map_err(|error| Error::Io(error.to_string()))
}

fn delete_file(home: &Path, relative: &str) -> Result<()> {
    let path = resolve_in_home(home, relative)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::FileNotFound);
        }
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| Error::Io(error.to_string()))
    } else {
        fs::remove_file(&path).map_err(|error| Error::Io(error.to_string()))
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn blob_home_list(
    app: tauri::AppHandle,
    id: &str,
    dir: Option<String>,
) -> Result<Vec<HomeEntry>> {
    let home = home_root(&data_root(&app)?, id)?;
    list_dir(&home, dir.as_deref())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn blob_home_read(app: tauri::AppHandle, id: &str, path: &str) -> Result<String> {
    let home = home_root(&data_root(&app)?, id)?;
    read_file(&home, path)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn blob_home_write(
    app: tauri::AppHandle,
    id: &str,
    path: &str,
    content: &str,
) -> Result<()> {
    let home = home_root(&data_root(&app)?, id)?;
    write_file(&home, path, content)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn blob_home_delete(app: tauri::AppHandle, id: &str, path: &str) -> Result<()> {
    let home = home_root(&data_root(&app)?, id)?;
    delete_file(&home, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOB_ID: &str = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("blobbies-home-tests")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default()
            ));
        home_root(&dir, BLOB_ID).unwrap_or_else(|_| panic!("home"))
    }

    #[test]
    fn rejects_bad_blob_ids() {
        let root = std::env::temp_dir();
        for id in [
            "",
            "not-a-uuid",
            "../escape",
            "61EC34F1-9BA5-4EFF-B8E1-7ACEFB2148EA",
        ] {
            assert!(
                home_root(&root, id).is_err(),
                "expected rejection for {id:?}"
            );
        }
    }

    #[test]
    fn rejects_escaping_paths() {
        let home = temp_home("escape");
        for path in [
            "../outside.txt",
            "notes/../../outside.txt",
            "/etc/passwd",
            "",
            ".",
            "./",
        ] {
            assert!(
                matches!(
                    resolve_in_home(&home, path),
                    Err(Error::PathOutsideHome | Error::Io(_))
                ),
                "expected rejection for {path:?}"
            );
        }
    }

    #[test]
    fn rejects_symlink_escape() {
        let home = temp_home("symlink");
        #[cfg(unix)]
        {
            let outside = home
                .parent()
                .and_then(Path::parent)
                .unwrap_or_else(|| panic!("parent"))
                .to_path_buf();
            std::os::unix::fs::symlink(&outside, home.join("link"))
                .unwrap_or_else(|_| panic!("symlink"));
            assert!(matches!(
                resolve_in_home(&home, "link/escaped.txt"),
                Err(Error::PathOutsideHome)
            ));
        }
    }

    #[test]
    fn write_read_list_delete_round_trip() {
        let home = temp_home("round-trip");
        write_file(&home, "notes/today.md", "hello").unwrap_or_else(|e| panic!("write: {e:?}"));
        assert_eq!(
            read_file(&home, "notes/today.md").unwrap_or_else(|_| panic!("read")),
            "hello"
        );
        let entries = list_dir(&home, Some("notes")).unwrap_or_else(|_| panic!("list"));
        assert_eq!(entries.len(), 1);
        let entry = entries.first().unwrap_or_else(|| panic!("entry"));
        assert_eq!(entry.name, "today.md");
        assert!(!entry.is_dir);
        delete_file(&home, "notes/today.md").unwrap_or_else(|_| panic!("delete"));
        assert!(matches!(
            read_file(&home, "notes/today.md"),
            Err(Error::FileNotFound)
        ));
    }

    #[test]
    fn missing_dir_lists_empty_and_missing_file_errors() {
        let home = temp_home("missing");
        assert!(
            list_dir(&home, Some("nope"))
                .unwrap_or_else(|_| panic!("list"))
                .is_empty()
        );
        assert!(matches!(
            read_file(&home, "nope.txt"),
            Err(Error::FileNotFound)
        ));
    }

    #[test]
    fn caps_file_size() {
        let home = temp_home("size");
        let big = "x".repeat(usize::try_from(MAX_FILE_BYTES + 1).unwrap_or_else(|_| panic!("cap")));
        assert!(matches!(
            write_file(&home, "big.txt", &big),
            Err(Error::FileTooLarge)
        ));
    }

    #[test]
    fn rejects_binary_reads() {
        let home = temp_home("binary");
        fs::write(home.join("raw.bin"), [0u8, 159, 146, 150]).unwrap_or_else(|_| panic!("seed"));
        assert!(matches!(read_file(&home, "raw.bin"), Err(Error::NotText)));
    }
}
