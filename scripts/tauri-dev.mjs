// `tauri dev` with `.env.local` sourced into the environment, on every OS.
//
// The job used to be done with `bash -c 'set -a; . ./.env.local; exec tauri dev'`,
// which only works where bash is on PATH — macOS, Linux, and Windows machines
// with Git's bin directory configured by hand. Node is already a requirement,
// so the loader lives here instead and the script runs the same everywhere.
//
// Deliberate divergence from shell sourcing: no `$(...)` or variable expansion
// happens in values, and quotes are only stripped as matched pairs. This file
// holds a dev API key, so treating it as data rather than code is the posture.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENV_FILE = new URL("../.env.local", import.meta.url);
// tauri.js, not main.js: main.js only *exports* `run`, so node exits having
// done nothing. tauri.js is the executable entry .bin/tauri points at.
const CLI = new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url);

/** Parse `KEY=VALUE` lines into a map. Comments, blanks, and malformed lines
 *  (no `=`, empty key) are skipped; a value may contain `=`; matched single or
 *  double quotes around the value are stripped, exactly like dotenv. */
export function parseEnvFile(text) {
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/** Load `.env.local` into `process.env`, overwriting like `set -a; .` did. */
function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return;
  const entries = parseEnvFile(readFileSync(ENV_FILE, "utf8"));
  for (const [key, value] of entries) {
    process.env[key] = value;
  }
}

// Importable (and unit-testable) without launching anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  loadEnvFile();
  const child = spawn(process.execPath, [fileURLToPath(CLI), "dev", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`could not run the Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
