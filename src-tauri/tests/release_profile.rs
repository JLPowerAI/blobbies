//! `panic = "abort"` must never come back to this manifest.
//!
//! `WebKit` raises an Objective-C exception whenever a custom-protocol response
//! reaches a `WKURLSchemeTask` the page already stopped — a cancelled request,
//! a re-render mid-flight. wry wraps every `didReceiveResponse:`,
//! `didReceiveData:` and `didFinish` in `objc2::exception::catch` precisely so
//! that race stays recoverable. `panic = "abort"` marks the
//! `extern "C-unwind"` message-send boundary nounwind, the exception trips
//! `panic_cannot_unwind`, and the process aborts before the `@catch` runs.
//! That shipped in 0.5.0 and crashed the app mid-conversation.
//!
//! The setting looks like a harmless size win, so nothing but this test stops
//! it being re-added. Failing here is cheaper than another crash report.

/// Compiled in, so editing the manifest re-runs this test.
const MANIFEST: &str = include_str!("../Cargo.toml");

#[test]
fn manifest_never_sets_panic_abort() {
    let offenders: Vec<&str> = MANIFEST
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter(|line| {
            let Some(value) = line.strip_prefix("panic") else {
                return false;
            };
            value
                .trim_start()
                .strip_prefix('=')
                .is_some_and(|value| value.contains("abort"))
        })
        .collect();

    assert!(
        offenders.is_empty(),
        "src-tauri/Cargo.toml sets panic = \"abort\" ({offenders:?}). It turns every \
         Objective-C exception wry catches — notably a response to a stopped \
         WKURLSchemeTask — into an abort() of the whole app. Leave unwinding on."
    );
}
