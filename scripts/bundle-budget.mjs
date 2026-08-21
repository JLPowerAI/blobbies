// Bundle budget: the startup chunk (dist/assets/index-*.js) must stay small —
// it is parsed and compiled before the first paint of every launch. The
// provider stack (gg-ai, OpenAI SDK, Tinfoil) is deliberately a lazy chunk;
// this gate fails the build if it (or anything like it) sneaks back in.
//
// Run after `vite build` (wired into `pnpm build`). gzip, not raw, since that
// is what crosses the wire in a browser dev context and approximates parse
// cost well enough for a regression gate.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Budget for the startup chunk, gzip bytes. Measured 160 kB on 2026-08-21
 *  (zod moved out of the eager graph — was 188 kB, 168 kB on 2026-08-17).
 *  Headroom is deliberately loose: zlib output for byte-identical files
 *  differs across platforms (measured: same chunk hash, 185 kB on macOS,
 *  186 kB on Linux), so the gate must not sit at the boundary. It exists to
 *  catch a whole SDK landing in the startup chunk (+20 kB or more), not
 *  ±1 kB compression variance. */
const STARTUP_GZIP_BUDGET_KB = 190;

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
const startup = readdirSync(assetsDir).filter((file) => /^index-[^/]+\.js$/.test(file));

if (startup.length === 0) {
  console.error("bundle-budget: no dist/assets/index-*.js found — run vite build first");
  process.exit(1);
}

let failed = false;
for (const file of startup) {
  const gz = gzipSync(readFileSync(join(assetsDir, file))).length;
  const kb = Math.round(gz / 1024);
  const verdict = kb <= STARTUP_GZIP_BUDGET_KB ? "ok" : "OVER";
  // biome-ignore lint/suspicious/noConsole: a build gate reports its result on the console — that is the job.
  console.log(`bundle-budget: ${file} ${kb} kB gzip / ${STARTUP_GZIP_BUDGET_KB} kB — ${verdict}`);
  if (kb > STARTUP_GZIP_BUDGET_KB) failed = true;
}

if (failed) {
  console.error(
    "bundle-budget: startup chunk over budget. Keep heavy modules (gg-ai, SDKs, zod, tinfoil) behind dynamic import() — see src/App.tsx loadAi().",
  );
  process.exit(1);
}
