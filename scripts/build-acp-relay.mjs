#!/usr/bin/env node
/**
 * Build `blobbies-acp` and put it where Tauri's `externalBin` expects it.
 *
 * An ACP editor is configured with a command path, so the relay has to ship
 * inside the app bundle next to the main binary. Tauri copies `externalBin`
 * entries there, but only finds them under a `-<target-triple>` suffix — and
 * its build script *refuses to build at all* until the file is present. So
 * this runs ahead of every cargo command on the app crate, not only releases.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, "src-tauri", "acp-relay", "Cargo.toml");

/** The triple Tauri is building for; the host's own when it is not cross-building. */
function targetTriple() {
  const declared = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (declared !== undefined && declared !== "") {
    return declared;
  }
  const report = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = /^host:\s*(\S+)$/m.exec(report)?.[1];
  if (host === undefined) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  return host;
}

const triple = targetTriple();
const cross = (process.env.TAURI_ENV_TARGET_TRIPLE ?? "") !== "";
const suffix = triple.includes("windows") ? ".exe" : "";
// One target directory for the whole project: already gitignored, and it keeps
// the relay's artifacts out of a second place nobody remembers to clean.
const targetDir = join(root, "src-tauri", "target");

execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    manifest,
    "--target-dir",
    targetDir,
    ...(cross ? ["--target", triple] : []),
  ],
  { stdio: "inherit" },
);

const built = join(targetDir, ...(cross ? [triple] : []), "release", `blobbies-acp${suffix}`);
const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
const bundled = join(binaries, `blobbies-acp-${triple}${suffix}`);
copyFileSync(built, bundled);
// biome-ignore lint/suspicious/noConsole: a build step reports what it produced — that is the job.
console.log(`acp relay: ${bundled}`);
