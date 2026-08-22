// Build latest.json for the in-app updater from a flat dir of release assets
// (the release workflow's `dist/`). Writes dist/latest.json.
//
// The updater client (tauri-plugin-updater) fetches the endpoint pinned in
// tauri.conf.json — releases/latest/download/latest.json — and matches its
// platform key against this map. Signatures come from the .sig files produced
// next to each updater artifact when TAURI_SIGNING_PRIVATE_KEY is present at
// build time; the pubkey lives in tauri.conf.json, so a mismatched signature
// is rejected by the client, not trusted.
//
// Usage: node scripts/update-manifest.mjs <dist-dir> <version-without-v>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [distDir, rawVersion] = process.argv.slice(2);
if (!distDir || !rawVersion) {
  console.error("usage: node scripts/update-manifest.mjs <dist-dir> <version>");
  process.exit(1);
}
const version = rawVersion.replace(/^v/, "");

// platform key → file stems Tauri's bundler emits for this repo's matrix.
// darwin uses the .app.tar.gz updater artifact (not the dmg); linux the
// AppImage; windows the NSIS setup exe.
const PLATFORMS = {
  "darwin-aarch64": `Blobbies_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `Blobbies_${version}_x64.app.tar.gz`,
  "linux-x86_64": `Blobbies_${version}_amd64.AppImage`,
  "windows-x86_64": `Blobbies_${version}_x64-setup.exe`,
};

const files = new Set(readdirSync(distDir));
const base = `https://github.com/KenKaiii/blobbies/releases/download/v${version}`;

const platforms = {};
for (const [key, file] of Object.entries(PLATFORMS)) {
  const sigFile = `${file}.sig`;
  if (!files.has(file) || !files.has(sigFile)) {
    console.error(`update-manifest: missing ${file} or ${sigFile} in ${distDir}`);
    process.exit(1);
  }
  platforms[key] = {
    signature: readFileSync(join(distDir, sigFile), "utf8").trim(),
    url: `${base}/${file}`,
  };
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes: `Blobbies ${version}. Details: ${base}`,
  platforms,
};

writeFileSync(join(distDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// biome-ignore lint/suspicious/noConsole: a release gate reports its result on the console — that is the job.
console.log(
  `update-manifest: wrote latest.json for ${version} (${Object.keys(platforms).length} platforms)`,
);
