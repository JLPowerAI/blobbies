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
    build_acp_relay();
    tauri_build::build();
}

/// Build the ACP relay into the `externalBin` path Tauri expects.
///
/// `tauri_build::build()` refuses to run at all while
/// `binaries/blobbies-acp-<target-triple>` is missing, so this cannot be left
/// to a wrapper script: `cargo build`, `cargo clippy` and `cargo test` are all
/// entry points CI and a fresh clone use directly, and every one of them would
/// otherwise fail on a checkout that had never run the npm build.
///
/// Safe to nest inside a build script because the relay crate has **no
/// dependencies** — nothing to resolve and no registry lock to contend for —
/// and it compiles into its own target directory, so it never races the outer
/// build for the lock on this one.
fn build_acp_relay() {
    let crate_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo always sets this"));
    let manifest = crate_dir.join("acp-relay").join("Cargo.toml");
    println!(
        "cargo:rerun-if-changed={}",
        crate_dir.join("acp-relay").join("src").display()
    );
    println!("cargo:rerun-if-changed={}", manifest.display());

    let target = std::env::var("TARGET").expect("cargo always sets TARGET");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo always sets OUT_DIR"));
    let relay_target = out_dir.join("acp-relay");
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };

    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut command = std::process::Command::new(cargo);
    command
        .args(["build", "--release", "--manifest-path"])
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&relay_target)
        .args(["--target", &target]);
    // Cargo exports the *parent* build's flags and target selection into a
    // build script's environment. Inherited, they would rebuild the relay with
    // the wrong settings, or point it back at this crate.
    for leaked in [
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTFLAGS",
        "CARGO_BUILD_TARGET",
        "CARGO_BUILD_RUSTFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
    ] {
        command.env_remove(leaked);
    }

    let status = command
        .status()
        .unwrap_or_else(|error| panic!("could not run cargo to build the ACP relay: {error}"));
    assert!(status.success(), "building the ACP relay failed");

    let built = relay_target
        .join(&target)
        .join("release")
        .join(format!("blobbies-acp{suffix}"));
    let bundled = crate_dir
        .join("binaries")
        .join(format!("blobbies-acp-{target}{suffix}"));
    std::fs::create_dir_all(bundled.parent().expect("joined a file name"))
        .unwrap_or_else(|error| panic!("creating the binaries directory: {error}"));
    std::fs::copy(&built, &bundled).unwrap_or_else(|error| {
        panic!(
            "copying {} to {}: {error}",
            built.display(),
            bundled.display()
        )
    });
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
