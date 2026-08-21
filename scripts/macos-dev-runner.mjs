#!/usr/bin/env node
// A `cargo` stand-in that launches the dev build from inside a real `.app`.
//
// macOS refuses to hand a notification center to a process with no app bundle:
// `UNUserNotificationCenter.currentNotificationCenter()` raises
// `NSInternalInconsistencyException` ("bundleProxyForCurrentProcess is nil"),
// and because that is an Objective-C exception it aborts the process rather
// than returning an error Rust could handle. `cargo run` produces exactly that
// — a bare binary at `target/debug/Blobbies` — so `notifications.rs` guards
// every entry point and reports "unavailable" instead of dying.
//
// That guard keeps dev alive but makes Allow do nothing, which means the
// notification path cannot be exercised until a release build. Wrapping the
// same binary in a minimal bundle gives it the identity macOS is asking for,
// and the feature behaves in dev exactly as it will in production.
//
// Tauri invokes the runner as `<runner> run --no-default-features --color
// always --`, so this script swaps `run` for `build` and takes over launching.
// A symlink, not a copy: cargo rewrites the binary on every edit, and a copy
// would silently run the previous build.
//
// macOS only. Windows and Linux need none of this and stay on plain cargo —
// `tauri-dev.mjs` only passes `--runner` on darwin.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_TAURI = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri");
/** `[[bin]] name` in Cargo.toml, and so the filename cargo writes. */
const BIN = "Blobbies";
/** Matches `identifier` in tauri.conf.json: the same app to macOS either way,
 *  so a permission granted in dev is the one production reads back. Keep the
 *  two in step — a mismatch silently splits the permission in half. */
const IDENTIFIER = "com.blobbies.app";

/** `run` becomes `build`; everything after the `--` separator is for the app,
 *  not for cargo, so it is dropped from the build invocation. */
export function toBuildArgs(runnerArgs) {
  const end = runnerArgs.indexOf("--");
  const cargoArgs = end === -1 ? runnerArgs : runnerArgs.slice(0, end);
  return cargoArgs.map((arg) => (arg === "run" ? "build" : arg));
}

/** Whether cargo put the binary under `target/debug` or `target/release`. */
export function profileDir(runnerArgs) {
  return runnerArgs.includes("--release") ? "release" : "debug";
}

/** Build the smallest bundle macOS accepts as an app identity, around the
 *  binary cargo just wrote. Rebuilt every launch so a changed identifier or
 *  binary path can never leave a stale bundle behind. */
function writeBundle(profile) {
  const target = join(SRC_TAURI, "target", profile);
  const app = join(target, `${BIN}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key><string>${BIN}</string>
\t<key>CFBundleIdentifier</key><string>${IDENTIFIER}</string>
\t<key>CFBundleName</key><string>${BIN}</string>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
\t<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
  );
  symlinkSync(join(target, BIN), join(app, "Contents", "MacOS", BIN));
  return join(app, "Contents", "MacOS", BIN);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const runnerArgs = process.argv.slice(2);
  const profile = profileDir(runnerArgs);

  const build = spawnSync("cargo", toBuildArgs(runnerArgs), {
    cwd: SRC_TAURI,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const executable = writeBundle(profile);
  const appArgs = runnerArgs.slice(runnerArgs.indexOf("--") + 1);
  const child = spawn(executable, runnerArgs.includes("--") ? appArgs : [], {
    stdio: "inherit",
  });
  // Tauri stops a dev run by signalling this process; the app is a separate
  // child, so the signal has to be passed along or the window outlives it.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`could not launch the dev bundle: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
