// Build the plugin catalog from Composio's own toolkit registry.
//
// Run by hand when the catalog should grow (`pnpm plugins`), not during the
// build: the catalog and its logos are committed, so a build never depends on
// the network or on the CLI being logged in.
//
// What it does, end to end:
//
// 1. `composio dev toolkits list --limit 1000` — every toolkit Composio
//    publishes, with name, description and tool count.
// 2. Filters to toolkits whose Connect button can actually finish. The catalog
//    header's rule 2, once checked per app by hand, is now read straight from
//    `dev toolkits info`: a toolkit is connectable when Composio manages one of
//    its OAuth schemes (`composio_managed_auth_schemes`) or when it offers a
//    key-based scheme, which Composio collects on its own hosted page. An
//    unmanaged-OAuth-only toolkit (Twitter, Snowflake) answers `link` with a
//    dashboard URL — a dead button — and a `NO_AUTH` toolkit has no account to
//    connect at all. All three cases are dropped here. This is deliberately
//    read from metadata rather than probed with `composio link`: a probe mints
//    a real pending connection record for every toolkit tried (measured), so
//    probing a thousand of them would litter the account list.
// 3. Writes `src/data/plugins.generated.ts` for everything that passed, minus
//    the hand-curated entries in `src/data/plugins.ts` (those keep their
//    hand-written names, descriptions and categories; this script never
//    touches that file).
// 4. Fetches each new app's logo into `public/logos/<slug>.svg` under the same
//    vetting the old fetch-logos script applied. An SVG is a document, not a
//    picture — anything scriptable in it is rejected and a plain monogram tile
//    is written instead (marked in the cache so a later run retries the real
//    mark).
//
// Auth verdicts are cached in `.plugin-sync-cache.json` (gitignored) because
// the per-toolkit `info` call is the slow part — a fresh run costs ~1000 CLI
// calls, a cached one a handful. Descriptions come from
// `scripts/plugin-descriptions.json`, reviewed by hand; anything without an
// entry falls back to Composio's own description, trimmed to house style.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedFile = join(root, "src", "data", "plugins.generated.ts");
const curatedFile = join(root, "src", "data", "plugins.ts");
const descriptionsFile = join(root, "scripts", "plugin-descriptions.json");
const cacheFile = join(root, "scripts", ".plugin-sync-cache.json");
const logosDir = join(root, "public", "logos");

/** Composio's public logo endpoint. One official mark per toolkit slug. */
const LOGO_URL = "https://logos.composio.dev/api/";

/**
 * Anything that makes an SVG active rather than a picture.
 *
 * The tiles render through <img>, which does not execute script — but a file
 * containing any of this has no business in the bundle either way, so it is
 * rejected and a monogram written instead.
 */
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

/** A logo far outside this range is a placeholder or a mistake, not a mark.
 * The upper bound is loose on purpose: real brand marks run heavy (Cal.com's
 * is 174 KB) and a monogram tile is the worse trade for a recognisable app. */
const MIN_BYTES = 120;
const MAX_BYTES = 200 * 1024;

/** How many `dev toolkits info` probes run at once. */
const PROBE_CONCURRENCY = 10;

/** A cached auth verdict older than this is re-checked. Composio does flip
 * toolkits between managed and unmanaged OAuth, and a stale keep would ship a
 * dead Connect button until the next cache wipe. */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Categories for generated entries, in marketplace order. This must match
 * `PLUGIN_CATEGORIES` in `src/data/plugins.ts` — the catalog test fails loudly
 * if the two drift apart, since a generated entry would land in a section the
 * modal never renders.
 */
const CATEGORY_ORDER = [
  "Featured",
  "Email & calendar",
  "Files & docs",
  "Messaging",
  "Project management",
  "CRM & support",
  "Developer",
  "Finance",
  "Marketing",
  "Design & social",
  "AI & search",
  "E-commerce",
  "Data & analytics",
  "Media & entertainment",
  "Productivity",
  "More apps",
];

/**
 * Keyword classifier, first match wins, checked over `${slug} ${name}
 * ${description}`. Hand-curated entries never pass through here, so a keyword
 * that misfiles a long-tail app is a cosmetic bug, not a data one — tune freely.
 * The traps to avoid: Composio's descriptions almost all say "AI agents" and
 * "via API", so bare `ai`/`api` keywords would file everything into two bins.
 */
const CATEGORY_RULES = [
  [
    "AI & search",
    /\b(llm|gpt|openai|anthropic|claude|gemini|perplexity|machine learning|embedding|vector|web search|search engine|serp|crawl|scrap|rag\b|transcrib|speech.to.text|text.to.speech|voice clon|translation|chatbot|voice agent)\b/i,
  ],
  [
    "E-commerce",
    /\b(shopify|e-?commerce|storefront|online store|dropship|inventory|fulfil?lment|product catalog|point of sale|etsy|woocommerce|marketplace)\b/i,
  ],
  [
    "Data & analytics",
    /\b(analytics|business intelligence|\bbi\b|dashboard|data warehouse|\bsql\b|database|bigquery|metrics|reporting|data visualization|enrichment|market data|data quality|verification|geocod|email verification)\b/i,
  ],
  [
    "Media & entertainment",
    /\b(music|spotify|podcast|streaming|\bvideo\b|movie|film|\btv\b|game|gaming|\bnews\b|radio|audiobook|comic|subtitl)\b/i,
  ],
  [
    "Marketing",
    /\b(marketing|campaign|newsletter|\bseo\b|\bads?\b|advertis|audience|landing page|survey|growth)\b/i,
  ],
  [
    "Email & calendar",
    /\b(email|e-mail|inbox|\bmail\b|calendar|schedul|meeting|booking|appointment)\b/i,
  ],
  [
    "Files & docs",
    /\b(document|file|pdf|\bnotes\b|wiki|knowledge base|storage|cloud drive|e-?sign|signature|signing)\b/i,
  ],
  [
    "Messaging",
    /\b(chat|messag|\bsms\b|texting|whatsapp|telegram|discord|irc|community|\bforum\b)\b/i,
  ],
  [
    "CRM & support",
    /\b(crm|customer relationship|customer support|helpdesk|ticketing|livechat|live chat|sales pipeline|\blead\b|prospect|contact enrichment|recruit|hiring|candidate|proposal|client management|talent)\b/i,
  ],
  [
    "Project management",
    /\b(task|project management|ticket|issue tracking|sprint|kanban|backlog|milestone|workflow|to.do)\b/i,
  ],
  [
    "Developer",
    /\b(code|coding|\bgit\b|github|repository|\brepo\b|deploy|deployment|ci\/cd|devops|terminal|bug tracking|webhook|cloudflare|\bcdn\b|hosting|observab|monitoring|performance|uptime|status page|feature flag|\bcms\b|headless)\b/i,
  ],
  [
    "Finance",
    /\b(payment|invoice|billing|accounting|bank|financ|\btax\b|payroll|crypto|wallet|subscription|invest|trading|stocks|currency|blockchain)\b/i,
  ],
  [
    "Design & social",
    /\b(design|social|instagram|tiktok|facebook|twitter|pinterest|photo|image|whiteboard|mockup)\b/i,
  ],
  [
    "Productivity",
    /\b(productivity|automation|no.code|reminder|habit|time track|pomodoro|clipboard|\bforms?\b)\b/i,
  ],
];

/** Toolkits that are plumbing, not apps a person connects. */
const SLUG_DENYLIST = new Set([
  "composio",
  "composio_search",
  "codeinterpreter",
  "browser",
  "browser_tool",
  "file_manager",
  "agentkit",
]);

/**
 * Descriptions for the apps someone has reviewed, keyed by slug.
 *
 * Composio's own descriptions are noun-led ("X is a platform that …"), while
 * the catalog's house style leads with what a Blob can do. Anything without an
 * entry here falls back to Composio's text, cleaned up.
 */
const reviewed = JSON.parse(readFileSync(descriptionsFile, "utf8"));

/** Run a composio CLI command and parse its JSON stdout. */
async function composioJson(args, timeoutMs = 30_000) {
  const { stdout } = await run("composio", args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (text === "") {
    throw new Error("empty output");
  }
  return JSON.parse(text);
}

/** Read the curated ids out of `plugins.ts` so they are never duplicated. */
function curatedIds() {
  const source = readFileSync(curatedFile, "utf8");
  const ids = [...source.matchAll(/^\s+id: "([a-z0-9_]+)",$/gm)].map((match) => match[1]);
  if (ids.length < 10) {
    // A silent empty read would duplicate every curated app in the generated
    // file; the duplicate-id catalog test catches that, but failing here with
    // the reason is kinder than failing there with a wall of ids.
    throw new Error(`read only ${ids.length} curated ids from ${curatedFile} — format changed?`);
  }
  return new Set(ids);
}

function loadCache() {
  if (!existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * Whether one toolkit can finish a connect on its own, per `dev toolkits info`.
 *
 * Measured against the CLI: managed OAuth and key-based schemes answer `link`
 * with a connect.composio.dev URL; unmanaged-OAuth-only answers with a
 * dashboard URL (dead button); NO_AUTH prints nothing (no account to connect).
 */
function connectable(info) {
  const managed = info.composio_managed_auth_schemes ?? [];
  const modes = info.auth_modes ?? [];
  const keyLike = modes.some((mode) => mode !== "NO_AUTH" && !String(mode).startsWith("OAUTH"));
  return managed.length > 0 || keyLike;
}

/**
 * Probe one toolkit, with retries and the cache in front.
 *
 * An `info` call that keeps failing means the toolkit is unverifiable, and an
 * unverifiable toolkit does not ship — same fail-closed rule the connect flow
 * itself applies.
 */
async function probe(slug, cache, stats) {
  const cached = cache[slug];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.keep;
  }
  let info = null;
  for (let attempt = 0; attempt < 3 && info === null; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
    try {
      info = await composioJson(["dev", "toolkits", "info", slug]);
    } catch {
      stats.retried += 1;
    }
  }
  const keep = info !== null && connectable(info);
  if (info === null) {
    // An unanswered probe is not a verdict — do not cache it, or a transient
    // CLI/API failure would hide a working app for the whole cache TTL.
    stats.unverifiable.push(slug);
    return false;
  }
  if (!keep) {
    stats.rejected.push(`${slug} (${(info.auth_modes ?? []).join(",")})`);
  }
  cache[slug] = { keep, at: Date.now() };
  saveCacheSoon();
  return keep;
}

/** Run `workers` promises over `items` without spawning them all at once. */
async function pool(items, workers, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}

/** Composio's description, nudged toward the catalog's house style. */
function fallbackDescription(name, raw) {
  let text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // "Foo is a platform that …" → "Platform that …". Without this the catalog
  // test rightly complains: the row already shows the name.
  const nameLead = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(is|are|was|were)\\s+(a|an|the)?\\s*`,
    "i",
  );
  text = text.replace(nameLead, "").replace(/^platform (that|which)\s*/i, "");
  if (text === "") {
    return "";
  }
  text = text[0].toUpperCase() + text.slice(1);
  if (
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text) ||
    /^connect(s|ing)?\s+to\s/i.test(text)
  ) {
    return "";
  }
  // First sentence, clamped at a word boundary. Rows truncate around 45
  // characters; the detail view shows the whole line, so the useful verbs
  // should be early and the line short.
  const sentence = text.split(/(?<=[.!?])\s/)[0];
  if (sentence.length > 110) {
    const cut = sentence.slice(0, 110);
    return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}.`;
  }
  return sentence;
}

function categorize(slug, name, description) {
  const haystack = `${slug} ${name} ${description}`;
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(haystack)) {
      return category;
    }
  }
  return "More apps";
}

/** A plain monogram tile, for the rare app whose mark the CDN does not carry. */
function monogram(name, slug) {
  const palette = [
    "#0ea5e9",
    "#6366f1",
    "#8b5cf6",
    "#ec4899",
    "#f43f5e",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#14b8a6",
  ];
  let hash = 0;
  for (const byte of slug) {
    hash = (hash * 31 + byte.charCodeAt(0)) % 997;
  }
  const color = palette[hash % palette.length];
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="${color}"/><text x="20" y="21" font-family="system-ui, sans-serif" font-size="19" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initial}</text></svg>`;
}

/**
 * Ensure a vetted logo exists for one slug. Writes the real mark when the CDN
 * has one, a monogram when it does not, and never deletes by itself — stale
 * files are removed in one sweep after every entry has its file.
 */
async function ensureLogo(slug, name, cache, stats) {
  const path = join(logosDir, `${slug}.svg`);
  const cached = cache[slug]?.logo;
  const haveReal = existsSync(path) && cached !== "monogram";
  if (haveReal) {
    return;
  }
  let svg = null;
  try {
    const response = await fetch(`${LOGO_URL}${slug}`, { redirect: "follow" });
    if (response.ok) {
      const type = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (
        type.includes("svg") &&
        body.length >= MIN_BYTES &&
        body.length <= MAX_BYTES &&
        body.trimStart().startsWith("<") &&
        !HAZARDS.some((pattern) => pattern.test(body))
      ) {
        svg = body;
      }
    }
  } catch {
    // Falls through to the monogram below.
  }
  if (svg === null) {
    stats.monograms.push(slug);
    cache[slug] = { ...(cache[slug] ?? { keep: true, at: Date.now() }), logo: "monogram" };
    writeFileSync(path, monogram(name, slug));
    return;
  }
  cache[slug] = { ...(cache[slug] ?? { keep: true, at: Date.now() }), logo: "real" };
  writeFileSync(path, svg);
}

async function writeGenerated(entries) {
  // Quotes and backslashes are escaped; anything else in a vendor's name or
  // our own descriptions (unicode, ampersands) is safe inside a TS string.
  const ts = (value) => value.replace(/["\\]/g, "\\$&");
  const lines = entries.map((entry) => {
    return `  {\n    id: "${entry.id}",\n    name: "${ts(entry.name)}",\n    description: "${ts(entry.description)}",\n    category: "${entry.category}",\n  },`;
  });
  const banner = `// AUTO-GENERATED by scripts/sync-plugins.mjs — do not edit by hand.
//
// Every app Composio can connect without a dashboard detour, minus the
// hand-curated entries in plugins.ts (those always win). Regenerate with
// \`pnpm plugins\`; per-app descriptions live in scripts/plugin-descriptions.json.
// The catalog tests in plugins.test.ts hold the invariants this file must keep:
// real slugs, shipped logos, verb-led descriptions, rendered categories.
import type { PluginDef } from "./plugins";

export const generatedPlugins: PluginDef[] = [
`;
  mkdirSync(dirname(generatedFile), { recursive: true });
  writeFileSync(generatedFile, `${banner}${lines.join("\n")}\n];\n`);
  // Biome owns the final shape: its line-wrapping is subtler than any emitter
  // wants to reproduce, and the file is checked in like hand-written code.
  // Resolved through node_modules rather than PATH so a direct `node
  // scripts/sync-plugins.mjs` formats too, not just `pnpm plugins`.
  await run(join(root, "node_modules", ".bin", "biome"), ["check", "--write", generatedFile]).catch(
    () => {},
  );
}

/** A maintenance script reports its progress on the console — that is the job. */
// biome-ignore lint/suspicious/noConsole: see above.
const log = console.log;

const stats = { retried: 0, unverifiable: [], rejected: [], monograms: [], removed: [] };
const cache = loadCache();
/** Save the cache as verdicts arrive: the probe phase is the slow part, and a
 * crash four minutes in should not have to redo all of it. */
let cacheWrites = 0;
function saveCacheSoon() {
  cacheWrites += 1;
  if (cacheWrites % 50 === 0) {
    saveCache(cache);
  }
}

log("sync-plugins: listing toolkits…");
const toolkits = await composioJson(["dev", "toolkits", "list", "--limit", "1000"]);
if (!Array.isArray(toolkits) || toolkits.length === 0) {
  throw new Error("composio dev toolkits list returned nothing usable");
}

const curated = curatedIds();
const candidates = toolkits.filter(
  (toolkit) =>
    typeof toolkit.slug === "string" &&
    /^[a-z0-9_]{1,64}$/.test(toolkit.slug) &&
    !toolkit.is_no_auth &&
    (toolkit.tools_count ?? 0) > 0 &&
    !SLUG_DENYLIST.has(toolkit.slug) &&
    !curated.has(toolkit.slug) &&
    typeof toolkit.name === "string" &&
    toolkit.name.trim() !== "" &&
    typeof toolkit.description === "string" &&
    toolkit.description.trim() !== "",
);

log(`sync-plugins: ${toolkits.length} toolkits, ${candidates.length} candidates, probing auth…`);
const keep = new Set();
await pool(
  candidates.map((toolkit) => toolkit.slug),
  PROBE_CONCURRENCY,
  async (slug) => {
    if (await probe(slug, cache, stats)) {
      keep.add(slug);
    }
  },
);

const entries = candidates
  .filter((toolkit) => keep.has(toolkit.slug))
  .map((toolkit) => {
    const description =
      reviewed[toolkit.slug] ?? fallbackDescription(toolkit.name, toolkit.description);
    return {
      id: toolkit.slug,
      name: toolkit.name.trim(),
      description:
        description !== ""
          ? description
          : `Have a Blob act on ${toolkit.name.trim()} through Composio.`,
      category: categorize(toolkit.slug, toolkit.name, toolkit.description),
    };
  })
  .sort(
    (left, right) =>
      CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category) ||
      left.name.localeCompare(right.name),
  );

log(`sync-plugins: ${entries.length} connectable; fetching missing logos…`);
mkdirSync(logosDir, { recursive: true });
await pool(
  entries.map((entry) => entry.id),
  12,
  async (slug) => {
    const name = entries.find((entry) => entry.id === slug)?.name ?? slug;
    await ensureLogo(slug, name, cache, stats);
  },
);

// One sweep of stale marks: files for slugs no longer in the catalog (dropped
// by Composio, or curated away) would otherwise ship forever.
const wanted = new Set([...curated, ...entries.map((entry) => entry.id)]);
for (const file of readdirSync(logosDir)) {
  const slug = file.replace(/\.svg$/, "");
  if (file.endsWith(".svg") && !wanted.has(slug)) {
    rmSync(join(logosDir, file));
    stats.removed.push(slug);
  }
}

await writeGenerated(entries);
saveCache(cache);

log(
  `sync-plugins: ${entries.length} generated entries across ${new Set(entries.map((e) => e.category)).size} categories`,
);
if (stats.monograms.length > 0) {
  log(
    `sync-plugins: monogram fallback for ${stats.monograms.length}: ${stats.monograms.join(", ")}`,
  );
}
if (stats.unverifiable.length > 0) {
  log(`sync-plugins: skipped, info unavailable: ${stats.unverifiable.join(", ")}`);
}
if ((stats.rejected?.length ?? 0) > 0) {
  log(`sync-plugins: ${stats.rejected.length} unconnectable (unmanaged OAuth or no auth)`);
}
if (stats.removed.length > 0) {
  // Deleting files is the one destructive thing this script does, so it says so.
  log(`sync-plugins: removed ${stats.removed.length} stale logos`);
}
