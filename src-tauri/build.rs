// A build script reports failure by panicking — that is the interface cargo
// gives it. The crate-wide denials exist for the shipped binary, where a panic
// is a crash in front of a user; here it is a build error in a terminal.
#![allow(clippy::expect_used, clippy::panic)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// OCR model weights, fetched at build time and embedded in the binary.
///
/// Kept out of git (12 MB of binary blobs) and out of the *runtime* too: the
/// app has to OCR offline, and must never fetch anything while handling a
/// user's file. Each entry is pinned by SHA-256, so a swapped or truncated
/// download fails the build instead of silently shipping.
const MODELS: [(&str, &str, &str); 2] = [
    (
        "text-detection.rten",
        "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten",
        "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca",
    ),
    (
        "text-recognition.rten",
        "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten",
        "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e",
    ),
];

fn main() {
    fetch_models();
    tauri_build::build();
}

/// Put every model in `OUT_DIR`, fetching only what is missing or wrong.
///
/// `OCRS_MODEL_DIR` points at already-downloaded copies for offline and
/// air-gapped builds. The checksum is still enforced, so it is a cache, not a
/// bypass.
fn fetch_models() {
    println!("cargo:rerun-if-env-changed=OCRS_MODEL_DIR");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo always sets OUT_DIR"));
    let local = std::env::var("OCRS_MODEL_DIR").ok().map(PathBuf::from);

    for (name, url, sha256) in MODELS {
        let target = out_dir.join(name);
        if file_matches(&target, sha256) {
            continue;
        }
        let bytes = match local.as_ref().map(|dir| dir.join(name)) {
            Some(path) if path.exists() => std::fs::read(&path)
                .unwrap_or_else(|error| panic!("reading {}: {error}", path.display())),
            _ => download(url),
        };
        let found = hex_sha256(&bytes);
        assert!(
            found == sha256,
            "{name} failed its checksum.\n  expected {sha256}\n  found    {found}\n\
             Refusing to embed an OCR model that is not the pinned one."
        );
        std::fs::write(&target, &bytes)
            .unwrap_or_else(|error| panic!("writing {}: {error}", target.display()));
    }
}

fn file_matches(path: &Path, sha256: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| hex_sha256(&bytes) == sha256)
}

/// Fetch with the platform's own HTTP client, so downloading at build time
/// does not pull a second TLS stack into the dependency tree.
fn download(url: &str) -> Vec<u8> {
    let output = std::process::Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--output",
            "-",
            url,
        ])
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "could not run curl to fetch {url}: {error}\n\
                 Set OCRS_MODEL_DIR to a directory holding the model files to build offline."
            )
        });
    assert!(
        output.status.success(),
        "downloading {url} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    output.stdout
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}
