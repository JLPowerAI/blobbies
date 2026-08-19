// Regenerate THIRD-PARTY-NOTICES.md from the actually-installed dependency tree.
//
// `node scripts/generate-notices.mjs` — run whenever dependencies change.
// No new dependencies: npm data comes from `pnpm ls --prod` paths into
// node_modules, Rust data from `cargo metadata --locked`, so the notices can
// never drift from what is actually resolved.
//
// Scope is what ships in a built binary: production npm dependencies (Vite
// bundles these into dist/) and every crate in Cargo.lock (statically linked
// by the Rust build). Dev tooling is not distributed and is not listed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Paths resolve from the script's own location, so cwd does not matter.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Collect {name, version, path} for every production npm dependency. */
function npmPackages() {
  const out = execFileSync("pnpm", ["ls", "--json", "--prod", "--depth=Infinity"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
  });
  const seen = new Map();
  // pnpm ls emits two shapes: the top level is an array of project roots,
  // and every `dependencies` is a map keyed by package name whose values
  // carry version/path but no name of their own.
  const walkArray = (nodes) => {
    for (const entry of nodes ?? []) {
      if (entry.name && entry.name !== "blobbies") {
        seen.set(entry.name, { name: entry.name, ...entry });
      }
      walkMap(entry?.dependencies);
    }
  };
  const walkMap = (map) => {
    for (const [name, entry] of Object.entries(map ?? {})) {
      if (name !== "blobbies") {
        seen.set(name, { name, ...entry });
      }
      walkMap(entry?.dependencies);
    }
  };
  walkArray(JSON.parse(out));
  return [...seen.values()]
    .map((entry) => {
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"));
      } catch {
        // Listed by pnpm but not installed here, so not in the bundle either.
        return null;
      }
      // Platform binaries (napi .node packages, wasm zstd builds) declare
      // os/cpu, so the set of them varies by machine — including them would
      // make the file differ between macOS and the Linux CI that checks it.
      // Their portable wrapper package is still listed below.
      if (manifest.os || manifest.cpu) {
        return null;
      }
      const author =
        typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "");
      return {
        name: entry.name,
        version: entry.version,
        license: manifest.license ?? "UNKNOWN",
        author,
        repository:
          typeof manifest.repository === "string"
            ? manifest.repository
            : (manifest.repository?.url ?? manifest.homepage ?? ""),
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Collect {name, version, license, repository} for every resolved crate. */
function rustPackages() {
  const out = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: root },
  );
  const meta = JSON.parse(out);
  return meta.packages
    .filter((pkg) => pkg.name !== "blobbies")
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      author: pkg.authors?.join(", ") ?? "",
      repository: pkg.repository ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const columns = (rows) =>
  rows
    .map(
      (r) =>
        `| ${r.name} | ${r.version} | ${r.license}${r.author ? ` — ${r.author}` : ""} | ${r.repository || "—"} |`,
    )
    .join("\n");

const npm = npmPackages();
const rust = rustPackages();
const unknown = [...npm, ...rust].filter((r) => r.license === "UNKNOWN");
if (unknown.length > 0) {
  console.error(`generate-notices: UNKNOWN licence for: ${unknown.map((r) => r.name).join(", ")}`);
  console.error("Resolve before publishing a release — an unattributable dependency cannot ship.");
  process.exitCode = 1;
}

const text = `# Third-party notices

Blobbies is licensed under the GNU AGPL-3.0-only (see LICENSE). This file
lists the third-party software compiled or bundled into a Blobbies binary.
Regenerate with \`node scripts/generate-notices.mjs\`.

Third-party trademarks: the app logos under \`public/logos\` belong to their
respective owners and are used to identify the corresponding integrations.
Blobbies is not affiliated with, or endorsed by, any of them.

Licence texts: MIT, ISC, BSD, Zlib and Unlicense require the copyright and
permission notice reproduced below; per-package copyright holders are named
in each row. Apache-2.0, MPL-2.0, Unicode-3.0 and CDLA-Permissive-2.0 works
are licensed under the full text published at the canonical URL in each
licence name (e.g. <https://www.apache.org/licenses/LICENSE-2.0>). Choose
permissively-OR'd licences (e.g. "MIT OR Apache-2.0") under the MIT terms
reproduced here.

Bundled model weights: the OCR models (text-detection.rten,
text-recognition.rten) are from the ocrs project by Robert Knight
(<https://github.com/robertknight/ocrs>), Apache-2.0, and are embedded
unmodified at the pinned checksums recorded in src-tauri/build.rs.

## npm dependencies (bundled by Vite into the webview)

| Package | Version | Licence / copyright | Repository |
| --- | --- | --- | --- |
${columns(npm)}

## Rust crates (statically linked)

| Crate | Version | Licence / copyright | Repository |
| --- | --- | --- | --- |
${columns(rust)}

## MIT licence

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

## ISC licence

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies. THE SOFTWARE
IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO
THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.

## BSD 3-clause licence

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer; redistributions in binary
form must reproduce the above copyright notice, this list of conditions and
the following disclaimer in the documentation and/or other materials provided
with the distribution; neither the name of the copyright holder nor the names
of its contributors may be used to endorse or promote products derived from
this software without specific prior written permission. THIS SOFTWARE IS
PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Zlib licence

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software. Permission is granted to anyone to use this software for any
purpose, including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions: the origin of this software must
not be misrepresented; you must not claim that you wrote the original software.
If you use this software in a product, an acknowledgment in the product
documentation would be appreciated but is not required. Altered source
versions must be plainly marked as such, and must not be misrepresented as
being the original software. This notice may not be removed or altered from
any source distribution.
`;

writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), text);
// A maintenance script reports its progress on the console — that is the job.
// biome-ignore lint/suspicious/noConsole: see above.
console.log(
  `generate-notices: ${npm.length} npm packages, ${rust.length} crates -> THIRD-PARTY-NOTICES.md`,
);
