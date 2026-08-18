// Fetch each app's own logo from Composio into public/logos/<slug>.svg.
//
// Run by hand when the catalog changes (`pnpm logos`), not during the build:
// the assets are committed, so a build never depends on the network, and the
// app never calls out to a CDN at runtime — which would otherwise tell
// Composio's edge which integrations a user is browsing.
//
// The SVGs come from a third party, so they are vetted before they are
// written. An SVG is a document, not a picture: it can carry <script>, event
// handlers, <foreignObject>, external references that fire on load, and
// entity declarations. Everything here renders through <img>, which does not
// execute script — but a file that contains any of that has no business being
// in the bundle either way, so it is rejected and the run fails rather than
// half-updating the icon set.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plugins } from "../src/data/plugins.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "logos");

/** Composio's public logo endpoint. One official mark per toolkit slug. */
const LOGO_URL = "https://logos.composio.dev/api/";

/** Anything that makes an SVG active rather than a picture. */
const HAZARDS = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /<!ENTITY/i,
  /<\s*iframe/i,
  /<\s*use[^>]+href\s*=\s*["']?https?:/i,
  /xlink:href\s*=\s*["']?https?:/i,
  /url\(\s*["']?https?:/i,
];

/** A logo far outside this range is a placeholder or a mistake, not a mark. */
const MIN_BYTES = 120;
const MAX_BYTES = 64 * 1024;

const failures = [];
const written = [];

for (const { id } of plugins) {
  // The slug reaches a URL, so it gets the same charset check the Rust side
  // applies before it reaches argv. Nothing else may become a path segment.
  if (!/^[a-z0-9_]+$/.test(id)) {
    failures.push(`${id}: not a Composio slug ([a-z0-9_] only)`);
    continue;
  }
  let response;
  try {
    response = await fetch(`${LOGO_URL}${id}`, { redirect: "follow" });
  } catch (error) {
    failures.push(`${id}: ${error.message}`);
    continue;
  }
  if (!response.ok) {
    failures.push(`${id}: HTTP ${response.status}`);
    continue;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("svg")) {
    failures.push(`${id}: served ${type || "no content-type"}, expected SVG`);
    continue;
  }
  const svg = await response.text();
  if (svg.length < MIN_BYTES || svg.length > MAX_BYTES) {
    failures.push(`${id}: ${svg.length} bytes is outside ${MIN_BYTES}–${MAX_BYTES}`);
    continue;
  }
  if (!svg.trimStart().startsWith("<")) {
    failures.push(`${id}: not markup`);
    continue;
  }
  const hazard = HAZARDS.find((pattern) => pattern.test(svg));
  if (hazard !== undefined) {
    failures.push(`${id}: rejected, matches ${hazard}`);
    continue;
  }
  written.push([id, svg]);
}

if (failures.length > 0) {
  console.error(`fetch-logos: ${failures.length} failed, nothing written`);
  for (const line of failures) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

// Only once every logo passed: a half-written set would ship blank tiles.
mkdirSync(outDir, { recursive: true });
const keep = new Set(written.map(([id]) => `${id}.svg`));
for (const stale of readdirSync(outDir)) {
  if (!keep.has(stale)) {
    rmSync(join(outDir, stale));
  }
}
for (const [id, svg] of written) {
  writeFileSync(join(outDir, `${id}.svg`), svg);
}
// biome-ignore lint/suspicious/noConsole: a maintenance script reports its result on the console — that is the job.
console.log(`fetch-logos: ${written.length} logos in public/logos`);
