# Third-party notices

Blobbies is licensed under the GNU AGPL-3.0-only (see LICENSE). This file
lists the third-party software compiled or bundled into a Blobbies binary.
Regenerate with `node scripts/generate-notices.mjs`.

Third-party trademarks: the app logos under `public/logos` belong to their
respective owners and are used to identify the corresponding integrations.
Blobbies is not affiliated with, or endorsed by, any of them.

Bundled GIFs: the onboarding decoration under `src/assets/onboarding-memes`
is third-party work, bundled unmodified. Each file's creator and source URL
is listed in `src/assets/onboarding-memes/CREDITS.md`.

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
| @agentclientprotocol/sdk | 1.4.0 | Apache-2.0 — Zed Industries | git+https://github.com/agentclientprotocol/typescript-sdk.git |
| @ai-sdk/openai-compatible | 3.0.30 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/provider | 4.0.7 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/provider-utils | 5.0.27 | Apache-2.0 | https://github.com/vercel/ai |
| @anthropic-ai/sdk | 0.94.0 | MIT — Anthropic <support@anthropic.com> | github:anthropics/anthropic-sdk-typescript |
| @babel/runtime | 7.29.7 | MIT — The Babel Team (https://babel.dev/team) | https://github.com/babel/babel.git |
| @bokuweb/zstd-wasm | 0.0.27 | MIT — <bokuweb12@gmail.com> | ssh://git@github.com/bokuweb/zstd-wasm.git |
| @freedomofpress/crypto-browser | 0.1.7 | Apache-2.0 — Giulio B. and Sacha Servan-Schreiber | https://github.com/freedomofpress/crypto-browser |
| @freedomofpress/sigstore-browser | 0.1.14 | MIT — Giulio B | https://github.com/freedomofpress/sigstore-browser |
| @freedomofpress/tuf-browser | 0.1.11 | MIT — Giulio B | https://github.com/freedomofpress/tuf-browser |
| @kenkaiiii/gg-agent | 5.49.3 | MIT | git+https://github.com/kenkaiiii/gg-framework.git |
| @kenkaiiii/gg-ai | 5.49.3 | MIT | git+https://github.com/kenkaiiii/gg-framework.git |
| @napi-rs/canvas | 1.0.6 | MIT | git+https://github.com/Brooooooklyn/canvas.git |
| @noble/ciphers | 2.3.0 | MIT — Paul Miller (https://paulmillr.com) | git+https://github.com/paulmillr/noble-ciphers.git |
| @noble/curves | 2.3.0 | MIT — Paul Miller (https://paulmillr.com) | git+https://github.com/paulmillr/noble-curves.git |
| @noble/hashes | 2.3.0 | MIT — Paul Miller (https://paulmillr.com) | git+https://github.com/paulmillr/noble-hashes.git |
| @noble/post-quantum | 0.7.0 | MIT — Paul Miller (https://paulmillr.com) | git+https://github.com/paulmillr/noble-post-quantum.git |
| @panva/hpke-noble | 1.1.4 | MIT — Filip Skokan <panva.ip@gmail.com> | panva/hpke |
| @standard-schema/spec | 1.1.0 | MIT — Colin McDonnell | https://github.com/standard-schema/standard-schema |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | git+https://github.com/tauri-apps/tauri.git |
| @tauri-apps/plugin-http | 2.5.9 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-notification | 2.3.3 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-opener | 2.5.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tinfoilsh/verifier | 1.2.1 | Apache-2.0 — Tinfoil | git+https://github.com/tinfoilsh/tinfoil-js.git |
| @types/debug | 4.1.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/estree | 1.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/estree-jsx | 1.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/hast | 3.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/mdast | 4.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/ms | 2.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/node | 26.2.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/react | 19.2.18 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/unist | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @types/ws | 8.18.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| @ungap/structured-clone | 1.3.3 | ISC — Andrea Giammarchi | git+https://github.com/ungap/structured-clone.git |
| @workflow/serde | 4.1.0 | Apache-2.0 | https://github.com/vercel/workflow.git |
| bail | 2.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/bail |
| ccount | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/ccount |
| character-entities | 2.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/character-entities |
| character-entities-html4 | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/character-entities-html4 |
| character-entities-legacy | 3.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/character-entities-legacy |
| character-reference-invalid | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/character-reference-invalid |
| comma-separated-tokens | 2.0.3 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/comma-separated-tokens |
| csstype | 3.2.3 | MIT — Fredrik Nicol <fredrik.nicol@gmail.com> | https://github.com/frenic/csstype |
| debug | 4.4.3 | MIT — Josh Junon (https://github.com/qix-) | git://github.com/debug-js/debug.git |
| decode-named-character-reference | 1.3.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/decode-named-character-reference |
| dequal | 2.0.3 | MIT — Luke Edwards | lukeed/dequal |
| devlop | 1.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/devlop |
| ehbp | 0.3.2 | MIT — Tinfoil | git+https://github.com/tinfoilsh/encrypted-http-body-protocol.git |
| escape-string-regexp | 5.0.0 | MIT — Sindre Sorhus | sindresorhus/escape-string-regexp |
| estree-util-is-identifier-name | 3.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/estree-util-is-identifier-name |
| eventsource-parser | 3.1.1 | MIT — Espen Hovlandsdal <espen@hovlandsdal.com> | git+ssh://git@github.com/rexxars/eventsource-parser.git |
| extend | 3.0.2 | MIT — Stefan Thomas <justmoon@members.fsf.org> (http://www.justmoon.net) | https://github.com/justmoon/node-extend.git |
| hast-util-to-jsx-runtime | 2.3.6 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/hast-util-to-jsx-runtime |
| hast-util-whitespace | 3.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/hast-util-whitespace |
| hpke | 1.1.4 | MIT — Filip Skokan <panva.ip@gmail.com> | panva/hpke |
| html-url-attributes | 3.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes |
| inline-style-parser | 0.2.7 | MIT | git+https://github.com/remarkablemark/inline-style-parser.git |
| is-alphabetical | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/is-alphabetical |
| is-alphanumerical | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/is-alphanumerical |
| is-decimal | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/is-decimal |
| is-hexadecimal | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/is-hexadecimal |
| is-plain-obj | 4.1.0 | MIT — Sindre Sorhus | sindresorhus/is-plain-obj |
| json-schema | 0.4.0 | (AFL-2.1 OR BSD-3-Clause) — Kris Zyp | http://github.com/kriszyp/json-schema |
| json-schema-to-ts | 3.1.1 | MIT — Thomas Aribart | git+https://github.com/ThomasAribart/json-schema-to-ts.git |
| longest-streak | 3.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/longest-streak |
| lucide-react | 1.33.0 | ISC — Eric Fennis | https://github.com/lucide-icons/lucide.git |
| markdown-table | 3.0.4 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/markdown-table |
| mdast-util-find-and-replace | 3.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-find-and-replace |
| mdast-util-from-markdown | 2.0.3 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-from-markdown |
| mdast-util-gfm | 3.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm-autolink-literal |
| mdast-util-gfm-footnote | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm-footnote |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm-strikethrough |
| mdast-util-gfm-table | 2.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm-table |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-gfm-task-list-item |
| mdast-util-mdx-expression | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-mdx-expression |
| mdast-util-mdx-jsx | 3.2.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-mdx-jsx |
| mdast-util-mdxjs-esm | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-mdxjs-esm |
| mdast-util-phrasing | 4.1.0 | MIT — Victor Felder <victor@draft.li> (https://draft.li) | syntax-tree/mdast-util-phrasing |
| mdast-util-to-hast | 13.2.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-to-hast |
| mdast-util-to-markdown | 2.1.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-to-markdown |
| mdast-util-to-string | 4.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/mdast-util-to-string |
| micromark | 4.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark |
| micromark-core-commonmark | 2.0.3 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark |
| micromark-extension-gfm | 3.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-autolink-literal |
| micromark-extension-gfm-footnote | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-footnote |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-strikethrough |
| micromark-extension-gfm-table | 2.1.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-table |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-tagfilter |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | micromark/micromark-extension-gfm-task-list-item |
| micromark-factory-destination | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination |
| micromark-factory-label | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label |
| micromark-factory-space | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space |
| micromark-factory-title | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title |
| micromark-factory-whitespace | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace |
| micromark-util-character | 2.1.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-character |
| micromark-util-chunked | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked |
| micromark-util-classify-character | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character |
| micromark-util-combine-extensions | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference |
| micromark-util-decode-string | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string |
| micromark-util-encode | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode |
| micromark-util-html-tag-name | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name |
| micromark-util-normalize-identifier | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier |
| micromark-util-resolve-all | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all |
| micromark-util-sanitize-uri | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri |
| micromark-util-subtokenize | 2.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize |
| micromark-util-symbol | 2.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol |
| micromark-util-types | 2.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/micromark/micromark/tree/main/packages/micromark-util-types |
| ms | 2.1.3 | MIT | vercel/ms |
| openai | 6.49.0 | Apache-2.0 — OpenAI <support@openai.com> | github:openai/openai-node |
| parse-entities | 4.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/parse-entities |
| pdfjs-dist | 6.2.108 | Apache-2.0 | git+https://github.com/mozilla/pdf.js.git |
| property-information | 7.2.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/property-information |
| react | 19.2.8 | MIT | https://github.com/react/react.git |
| react-dom | 19.2.8 | MIT | https://github.com/react/react.git |
| react-markdown | 10.1.0 | MIT — Espen Hovlandsdal <espen@hovlandsdal.com> | remarkjs/react-markdown |
| remark-gfm | 4.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | remarkjs/remark-gfm |
| remark-parse | 11.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/remarkjs/remark/tree/main/packages/remark-parse |
| remark-rehype | 11.1.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | remarkjs/remark-rehype |
| remark-stringify | 11.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | https://github.com/remarkjs/remark/tree/main/packages/remark-stringify |
| scheduler | 0.27.0 | MIT | https://github.com/facebook/react.git |
| space-separated-tokens | 2.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/space-separated-tokens |
| stringify-entities | 4.0.4 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/stringify-entities |
| style-to-js | 1.1.21 | MIT — Mark <mark@remarkablemark.org> | git+https://github.com/remarkablemark/style-to-js.git |
| style-to-object | 1.0.14 | MIT — Mark <mark@remarkablemark.org> | git+https://github.com/remarkablemark/style-to-object.git |
| tinfoil | 1.2.1 | Apache-2.0 — Tinfoil | git+https://github.com/tinfoilsh/tinfoil-js.git |
| trim-lines | 3.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/trim-lines |
| trough | 2.2.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/trough |
| ts-algebra | 2.0.0 | MIT — Thomas Aribart | git+https://github.com/ThomasAribart/ts-algebra.git |
| undici | 7.29.0 | MIT | git+https://github.com/nodejs/undici.git |
| undici-types | 8.3.0 | MIT | git+https://github.com/nodejs/undici.git |
| unified | 11.0.5 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | unifiedjs/unified |
| unist-util-is | 6.0.1 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/unist-util-is |
| unist-util-position | 5.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/unist-util-position |
| unist-util-stringify-position | 4.0.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/unist-util-stringify-position |
| unist-util-visit | 5.1.0 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/unist-util-visit |
| unist-util-visit-parents | 6.0.2 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | syntax-tree/unist-util-visit-parents |
| vfile | 6.0.3 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | vfile/vfile |
| vfile-message | 4.0.3 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | vfile/vfile-message |
| ws | 8.21.3 | MIT — Einar Otto Stangvik <einaros@gmail.com> (http://2x.io) | git+https://github.com/websockets/ws.git |
| zod | 4.4.3 | MIT — Colin McDonnell <zod@colinhacks.com> | git+https://github.com/colinhacks/zod.git |
| zwitch | 2.0.4 | MIT — Titus Wormer <tituswormer@gmail.com> (https://wooorm.com) | wooorm/zwitch |

## Rust crates (statically linked)

| Crate | Version | Licence / copyright | Repository |
| --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 — Jonas Schievink <jonasschievink@gmail.com>, oyvindln <oyvindln@users.noreply.github.com> | https://github.com/oyvindln/adler2 |
| aho-corasick | 1.1.5 | Unlicense OR MIT — Andrew Gallant <jamslam@gmail.com> | https://github.com/BurntSushi/aho-corasick |
| alloc-no-stdlib | 2.0.4 | BSD-3-Clause — Daniel Reiter Horn <danielrh@dropbox.com> | https://github.com/dropbox/rust-alloc-no-stdlib |
| alloc-stdlib | 0.2.4 | BSD-3-Clause — Daniel Reiter Horn <danielrh@dropbox.com> | https://github.com/dropbox/rust-alloc-no-stdlib |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 — Nicolas Silva <nical@fastmail.com> | https://github.com/nical/android_system_properties |
| annotate-snippets | 0.11.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/annotate-snippets-rs |
| anstyle | 1.0.14 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| anyhow | 1.0.104 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/anyhow |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 — The Rust-Fuzz Project Developers, Nick Fitzgerald <fitzgen@gmail.com>, Manish Goregaokar <manishsmail@gmail.com>, Simonas Kazlauskas <arbitrary@kazlauskas.me>, Brian L. Troutwine <brian@troutwine.us>, Corey Farwell <coreyf@rwell.org> | https://github.com/rust-fuzz/arbitrary/ |
| async-broadcast | 0.7.2 | MIT OR Apache-2.0 — Stjepan Glavina <stjepang@gmail.com>, Yoshua Wuyts <yoshuawuyts@gmail.com>, Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/smol-rs/async-broadcast |
| async-channel | 2.5.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/async-channel |
| async-executor | 1.14.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, John Nunley <dev@notgull.net> | https://github.com/smol-rs/async-executor |
| async-io | 2.6.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/async-io |
| async-lock | 3.4.2 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/async-lock |
| async-process | 2.5.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/async-process |
| async-recursion | 1.1.1 | MIT OR Apache-2.0 — Robert Usher <266585+dcchut@users.noreply.github.com> | https://github.com/dcchut/async-recursion |
| async-signal | 0.2.14 | Apache-2.0 OR MIT — John Nunley <dev@notgull.net> | https://github.com/smol-rs/async-signal |
| async-task | 4.7.1 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/async-task |
| async-trait | 0.1.92 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/async-trait |
| atk | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| atk-sys | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, Contributors to futures-rs | https://github.com/smol-rs/atomic-waker |
| autocfg | 1.5.1 | Apache-2.0 OR MIT — Josh Stone <cuviper@gmail.com> | https://github.com/cuviper/autocfg |
| base64 | 0.21.7 | MIT OR Apache-2.0 — Alice Maz <alice@alicemaz.com>, Marshall Pierce <marshall@mpierce.org> | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.22.1 | MIT OR Apache-2.0 — Marshall Pierce <marshall@mpierce.org> | https://github.com/marshallpierce/rust-base64 |
| bindgen | 0.72.1 | BSD-3-Clause — Jyun-Yan You <jyyou.tw@gmail.com>, Emilio Cobos Álvarez <emilio@crisal.io>, Nick Fitzgerald <fitzgen@gmail.com>, The Servo project developers | https://github.com/rust-lang/rust-bindgen |
| bit-set | 0.8.0 | Apache-2.0 OR MIT — Alexis Beingessner <a.beingessner@gmail.com> | https://github.com/contain-rs/bit-set |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT — Alexis Beingessner <a.beingessner@gmail.com> | https://github.com/contain-rs/bit-vec |
| bitflags | 1.3.2 | MIT/Apache-2.0 — The Rust Project Developers | https://github.com/bitflags/bitflags |
| bitflags | 2.13.1 | MIT OR Apache-2.0 — The Rust Project Developers | https://github.com/bitflags/bitflags |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/utils |
| block2 | 0.6.2 | MIT — Mads Marquart <mads@marquart.dk> | https://github.com/madsmtm/objc2 |
| blocking | 1.6.2 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/blocking |
| brotli | 8.0.4 | BSD-3-Clause AND MIT — Daniel Reiter Horn <danielrh@dropbox.com>, The Brotli Authors | https://github.com/dropbox/rust-brotli |
| brotli-decompressor | 5.0.3 | BSD-3-Clause/MIT — Daniel Reiter Horn <danielrh@dropbox.com>, The Brotli Authors | https://github.com/dropbox/rust-brotli-decompressor |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 — Nick Fitzgerald <fitzgen@gmail.com> | https://github.com/fitzgen/bumpalo |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT — Lokathor <zefria@gmail.com> | https://github.com/Lokathor/bytemuck |
| bytemuck_derive | 1.12.0 | Zlib OR Apache-2.0 OR MIT — Lokathor <zefria@gmail.com> | https://github.com/Lokathor/bytemuck |
| byteorder | 1.5.0 | Unlicense OR MIT — Andrew Gallant <jamslam@gmail.com> | https://github.com/BurntSushi/byteorder |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | https://github.com/image-rs/byteorder-lite |
| bytes | 1.12.1 | MIT — Carl Lerche <me@carllerche.com>, Sean McArthur <sean@seanmonstar.com> | https://github.com/tokio-rs/bytes |
| cairo-rs | 0.18.5 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| cairo-sys-rs | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| camino | 1.2.5 | MIT OR Apache-2.0 — Without Boats <saoirse@without.boats>, Ashley Williams <ashley666ashley@gmail.com>, Steve Klabnik <steve@steveklabnik.com>, Rain <rain@sunshowers.io> | https://github.com/camino-rs/camino |
| cargo_metadata | 0.19.2 | MIT — Oliver Schneider <git-spam-no-reply9815368754983@oli-obk.de> | https://github.com/oli-obk/cargo_metadata |
| cargo_toml | 0.22.3 | Apache-2.0 OR MIT — Kornel <kornel@geekhood.net> | https://gitlab.com/lib.rs/cargo_toml |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/cargo |
| cc | 1.4.2 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| cesu8 | 1.1.0 | Apache-2.0/MIT — Eric Kidd <git@randomhacks.net> | https://github.com/emk/cesu8-rs |
| cexpr | 0.6.0 | Apache-2.0/MIT — Jethro Beekman <jethro@jbeekman.nl> | https://github.com/jethrogb/rust-cexpr |
| cfb | 0.7.3 | MIT — Matthew D. Steele <mdsteele@alum.mit.edu> | https://github.com/mdsteele/rust-cfb |
| cfg_aliases | 0.2.2 | MIT — Zicklag <zicklag@katharostech.com> | https://github.com/katharostech/cfg_aliases |
| cfg-expr | 0.15.8 | MIT OR Apache-2.0 — Embark <opensource@embark-studios.com>, Jake Shadle <jake.shadle@embark-studios.com> | https://github.com/EmbarkStudios/cfg-expr |
| cfg-expr | 0.20.9 | MIT OR Apache-2.0 — Embark <opensource@embark-studios.com>, Jake Shadle <jake.shadle@embark-studios.com> | https://github.com/EmbarkStudios/cfg-expr |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/rust-lang/cfg-if |
| chacha20 | 0.10.1 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/stream-ciphers |
| chrono | 0.4.45 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| clang-sys | 1.9.1 | Apache-2.0 — Kyle Mayes <kyle@mayeses.com> | https://github.com/KyleMayes/clang-sys |
| color_quant | 1.1.0 | MIT — nwin <nwin@users.noreply.github.com> | https://github.com/image-rs/color_quant.git |
| combine | 4.6.7 | MIT — Markus Westerlind <marwes91@gmail.com> | https://github.com/Marwes/combine |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, Taiki Endo <te316e89@gmail.com>, John Nunley <dev@notgull.net> | https://github.com/smol-rs/concurrent-queue |
| cookie | 0.18.2 | MIT OR Apache-2.0 — Sergio Benitez <sb@sergio.bz>, Alex Crichton <alex@alexcrichton.com> | https://github.com/SergioBenitez/cookie-rs |
| cookie_store | 0.22.1 | MIT OR Apache-2.0 — Patrick Fernie <patrick.fernie@gmail.com> | https://github.com/pfernie/cookie_store |
| cookie-factory | 0.3.3 | MIT — Geoffroy Couprie <geo.couprie@gmail.com>, Pierre Chifflier <chifflier@wzdftpd.net> | https://github.com/rust-bakery/cookie-factory |
| core-foundation | 0.9.4 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/core-foundation-rs |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/core-foundation-rs |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/core-foundation-rs |
| core-graphics | 0.25.0 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/core-foundation-rs |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/core-foundation-rs |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/utils |
| cpufeatures | 0.3.0 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/utils |
| crc32fast | 1.5.0 | MIT OR Apache-2.0 — Sam Rijs <srijs@airpost.net>, Alex Crichton <alex@alexcrichton.com> | https://github.com/srijs/rust-crc32fast |
| crossbeam-channel | 0.5.16 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-deque | 0.8.7 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-epoch | 0.9.20 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-utils | 0.8.22 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/traits |
| cssparser | 0.36.0 | MPL-2.0 — Simon Sapin <simon.sapin@exyr.org> | https://github.com/servo/rust-cssparser |
| cssparser-macros | 0.6.1 | MPL-2.0 — Simon Sapin <simon.sapin@exyr.org> | https://github.com/servo/rust-cssparser |
| ctor | 0.8.0 | Apache-2.0 OR MIT — Matt Mastracci <matthew@mastracci.com> | https://github.com/mmastrac/rust-ctor |
| ctor-proc-macro | 0.0.7 | Apache-2.0 OR MIT — Matt Mastracci <matthew@mastracci.com> | https://github.com/mmastrac/rust-ctor |
| darling | 0.21.3 | MIT — Ted Driggs <ted.driggs@outlook.com> | https://github.com/TedDriggs/darling |
| darling_core | 0.21.3 | MIT — Ted Driggs <ted.driggs@outlook.com> | https://github.com/TedDriggs/darling |
| darling_macro | 0.21.3 | MIT — Ted Driggs <ted.driggs@outlook.com> | https://github.com/TedDriggs/darling |
| data-url | 0.3.2 | MIT OR Apache-2.0 — Simon Sapin <simon.sapin@exyr.org> | https://github.com/servo/rust-url |
| dbus | 0.9.12 | Apache-2.0/MIT — David Henningsson <diwic@ubuntu.com> | https://github.com/diwic/dbus-rs |
| dbus-secret-service | 4.1.0 | MIT OR Apache-2.0 — Daniel Brotsky <dev@brotsky.com> | https://github.com/brotskydotcom/dbus-secret-service.git |
| deranged | 0.5.8 | MIT OR Apache-2.0 — Jacob Pratt <jacob@jhpratt.dev> | https://github.com/jhpratt/deranged |
| derive_arbitrary | 1.4.2 | MIT OR Apache-2.0 — The Rust-Fuzz Project Developers, Nick Fitzgerald <fitzgen@gmail.com>, Manish Goregaokar <manishsmail@gmail.com>, Andre Bogus <bogusandre@gmail.com>, Corey Farwell <coreyf@rwell.org> | https://github.com/rust-fuzz/arbitrary |
| derive_more | 2.1.1 | MIT — Jelte Fennema <github-tech@jeltef.nl> | https://github.com/JelteF/derive_more |
| derive_more-impl | 2.1.1 | MIT — Jelte Fennema <github-tech@jeltef.nl> | https://github.com/JelteF/derive_more |
| digest | 0.10.7 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/traits |
| dirs | 6.0.0 | MIT OR Apache-2.0 — Simon Ochsenreither <simon@ochsenreither.de> | https://github.com/soc/dirs-rs |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 — Simon Ochsenreither <simon@ochsenreither.de> | https://github.com/dirs-dev/dirs-sys-rs |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT — Mads Marquart <mads@marquart.dk>, Mary <mary@mary.zone> | https://github.com/madsmtm/objc2 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 — Jane Lusby <jlusby@yaah.dev> | https://github.com/yaahc/displaydoc |
| dlib | 0.5.3 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/elinorbgr/dlib |
| dlopen2 | 0.8.2 | MIT — Szymon Wieloch <szymon.wieloch@gmail.com>, Ahmed Masud <ahmed.masud@saf.ai>, OpenByte <development.openbyte@gmail.com> | https://github.com/OpenByteDev/dlopen2 |
| dlopen2_derive | 0.4.3 | MIT — Szymon Wieloch <szymon.wieloch@gmail.com>, OpenByte <development.openbyte@gmail.com> | https://github.com/OpenByteDev/dlopen2 |
| document-features | 0.2.12 | MIT OR Apache-2.0 — Slint Developers <info@slint.dev> | https://github.com/slint-ui/document-features |
| dom_query | 0.27.0 | MIT — niklak <morgenpurple@gmail.com>, importcjj <importcjj@gmail.com> | https://github.com/niklak/dom_query |
| downcast-rs | 1.2.1 | MIT/Apache-2.0 — Ashish Myles <marcianx@gmail.com>, Runji Wang <wangrunji0408@163.com> | https://github.com/marcianx/downcast-rs |
| dpi | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |
| drm | 0.14.1 | MIT — Tyler Slabinski <tslabinski@slabity.net>, Victoria Brekenfeld <crates-io@drakulix.de> | https://github.com/Smithay/drm-rs |
| drm | 0.15.0 | MIT — Tyler Slabinski <slabity@slabity.dev>, Victoria Brekenfeld <crates-io@drakulix.de> | https://github.com/Smithay/drm-rs |
| drm-ffi | 0.9.1 | MIT — Tyler Slabinski <tslabinski@slabity.net> | https://github.com/Smithay/drm-rs |
| drm-fourcc | 2.2.0 | MIT — Daniel Franklin <daniel@danielzfranklin.org> | https://github.com/danielzfranklin/drm-fourcc-rs |
| drm-sys | 0.8.1 | MIT — Tyler Slabinski <tslabinski@slabity.net> | https://github.com/Smithay/drm-rs |
| dtoa | 1.0.11 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/dtoa |
| dtoa-short | 0.3.5 | MPL-2.0 — Xidorn Quan <me@upsuper.org> | https://github.com/upsuper/dtoa-short |
| dtor | 0.3.0 | Apache-2.0 OR MIT — Matt Mastracci <matthew@mastracci.com> | https://github.com/mmastrac/rust-ctor |
| dtor-proc-macro | 0.0.6 | Apache-2.0 OR MIT — Matt Mastracci <matthew@mastracci.com> | https://github.com/mmastrac/rust-ctor |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 — Kornel <kornel@geekhood.net> | https://gitlab.com/kornelski/dunce |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/dyn-clone |
| either | 1.17.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/either |
| embed_plist | 1.2.2 | MIT OR Apache-2.0 — Nikolai Vazquez <hello@nikolaivazquez.com> | https://github.com/nvzqz/embed-plist-rs |
| embed-resource | 3.0.11 | MIT — наб <nabijaczleweli@nabijaczleweli.xyz>, Cat Plus Plus <piotrlegnica@piotrl.pl>, Liigo <liigo@qq.com>, azyobuzin <azyobuzin@users.sourceforge.jp>, Peter Atashian <retep998@gmail.com>, pravic <ehysta@gmail.com>, Gabriel Majeri <gabriel.majeri6@gmail.com>, SonnyX, Johan Andersson <repi@repi.se>, Jordan Poles <jpdev.noreply@gmail.com>, MSxDOS <melcodos@gmail.com>, Jim McGrath <jimmc2@gmail.com>, roblabla <unfiltered@roblab.la>, Jasper Bekkers <jasper@traverseresearch.nl>, Richard Markiewicz <rmarkiewicz@devolutions.net>, Emerson de Freitas Barcelos <emersonfxbx@gmail.com>, Li Keqing <me@kaze.ai>, Alexis Bourget <alexis.bourget@gmail.com>, Michael Farrell <micolous+git@gmail.com>, Jacob Okamoto <oko@oko.io>, Marijn Suijten <marijn@traverseresearch.nl>, Lucas Nogueira <lucas@tauri.app>, CharlesChen0823 <yongchen0823@gmail.com>, Daniel Schaefer <dhs@frame.work>, Rene Leonhardt, ssrlive, Kan-Ru Chen <kanru@kanru.info>, Tony <legendmastertony@gmail.com>, Berrysoft <Strawberry_Str@hotmail.com>, Marcus Ahlberg <marcus.ahlberg@kvaser.com> | https://github.com/nabijaczleweli/rust-embed-resource |
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause — Henri Sivonen <hsivonen@hsivonen.fi> | https://github.com/hsivonen/encoding_rs |
| endi | 1.1.1 | MIT — Zeeshan Ali Khan <zeenix@gmail.com> | https://github.com/zeenix/endi |
| enumflags2 | 0.7.12 | MIT OR Apache-2.0 — maik klein <maikklein@googlemail.com>, Maja Kądziołka <maya@compilercrim.es> | https://github.com/meithecatte/enumflags2 |
| enumflags2_derive | 0.7.12 | MIT OR Apache-2.0 — maik klein <maikklein@googlemail.com>, Maja Kądziołka <maya@compilercrim.es> | https://github.com/meithecatte/enumflags2 |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| erased-serde | 0.4.10 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/erased-serde |
| errno | 0.3.14 | MIT OR Apache-2.0 — Chris Wong <lambda.fairy@gmail.com>, Dan Gohman <dev@sunfishcode.online> | https://github.com/lambda-fairy/rust-errno |
| event-listener | 5.4.2 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, John Nunley <dev@notgull.net> | https://github.com/smol-rs/event-listener |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT — John Nunley <dev@notgull.net> | https://github.com/smol-rs/event-listener-strategy |
| fastrand | 2.5.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com> | https://github.com/smol-rs/fastrand |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/fdeflate |
| field-offset | 0.3.6 | MIT OR Apache-2.0 — Diggory Blake <diggsey@googlemail.com> | https://github.com/Diggsey/rust-field-offset |
| filetime | 0.2.29 | MIT/Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/alexcrichton/filetime |
| find-msvc-tools | 0.1.10 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| flatbuffers | 24.12.23 | Apache-2.0 — Robert Winslow <hello@rwinslow.com>, FlatBuffers Maintainers | https://github.com/google/flatbuffers |
| flate2 | 1.1.9 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com>, Josh Triplett <josh@joshtriplett.org> | https://github.com/rust-lang/flate2-rs |
| fnv | 1.0.7 | Apache-2.0 / MIT — Alex Crichton <alex@alexcrichton.com> | https://github.com/servo/rust-fnv |
| foldhash | 0.2.0 | Zlib — Orson Peters <orsonpeters@gmail.com> | https://github.com/orlp/foldhash |
| foreign-types | 0.5.0 | MIT/Apache-2.0 — Steven Fackler <sfackler@gmail.com> | https://github.com/sfackler/foreign-types |
| foreign-types-macros | 0.2.4 | MIT/Apache-2.0 — Steven Fackler <sfackler@gmail.com> | https://github.com/sfackler/foreign-types |
| foreign-types-shared | 0.3.1 | MIT/Apache-2.0 — Steven Fackler <sfackler@gmail.com> | https://github.com/sfackler/foreign-types |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 — The rust-url developers | https://github.com/servo/rust-url |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-io | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, Contributors to futures-rs | https://github.com/smol-rs/futures-lite |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| gbm | 0.18.0 | MIT — Victoria Brekenfeld <github@drakulix.de> | https://github.com/Smithay/gbm.rs |
| gbm-sys | 0.4.0 | MIT — Drakulix (Victor Brekenfeld) | https://github.com/Drakulix/gbm.rs/tree/master/gbm-sys |
| gdk | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gdk-pixbuf | 0.18.5 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| gdk-pixbuf-sys | 0.18.0 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| gdk-sys | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gdkwayland-sys | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gdkx11 | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gdkx11-sys | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| generic-array | 0.14.7 | MIT — Bartłomiej Kamiński <fizyk20@gmail.com>, Aaron Trent <novacrazy@gmail.com> | https://github.com/fizyk20/generic-array.git |
| getrandom | 0.2.17 | MIT OR Apache-2.0 — The Rand Project Developers | https://github.com/rust-random/getrandom |
| getrandom | 0.3.4 | MIT OR Apache-2.0 — The Rand Project Developers | https://github.com/rust-random/getrandom |
| getrandom | 0.4.3 | MIT OR Apache-2.0 — The Rand Project Developers | https://github.com/rust-random/getrandom |
| gif | 0.14.2 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/image-gif |
| gio | 0.18.4 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| gio-sys | 0.18.1 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| gl | 0.14.0 | Apache-2.0 — Brendan Zabarauskas <bjzaba@yahoo.com.au>, Corey Richardson, Arseny Kapoulkine | https://github.com/brendanzab/gl-rs/ |
| gl_generator | 0.14.0 | Apache-2.0 — Brendan Zabarauskas <bjzaba@yahoo.com.au>, Corey Richardson, Arseny Kapoulkine | https://github.com/brendanzab/gl-rs/ |
| glib | 0.18.5 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| glib-macros | 0.18.5 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| glib-sys | 0.18.1 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| glob | 0.3.4 | MIT OR Apache-2.0 — The Rust Project Developers | https://github.com/rust-lang/glob |
| gobject-sys | 0.18.0 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| gtk | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gtk-sys | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| gtk3-macros | 0.18.2 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk3-rs |
| h2 | 0.4.17 | MIT — Carl Lerche <me@carllerche.com>, Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/h2 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 — Amanieu d'Antras <amanieu@gmail.com> | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| heck | 0.4.1 | MIT OR Apache-2.0 — Without Boats <woboats@gmail.com> | https://github.com/withoutboats/heck |
| heck | 0.5.0 | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| hermit-abi | 0.5.2 | MIT OR Apache-2.0 — Stefan Lankes | https://github.com/hermit-os/hermit-rs |
| hex | 0.4.3 | MIT OR Apache-2.0 — KokaKiwi <kokakiwi@kokakiwi.net> | https://github.com/KokaKiwi/rust-hex |
| html5ever | 0.38.0 | MIT OR Apache-2.0 — The html5ever Project Developers | https://github.com/servo/html5ever |
| http | 1.5.0 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com>, Carl Lerche <me@carllerche.com>, Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/http |
| http-body | 1.1.0 | MIT — Carl Lerche <me@carllerche.com>, Lucio Franco <luciofranco14@gmail.com>, Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/http-body |
| http-body-util | 0.1.5 | MIT — Carl Lerche <me@carllerche.com>, Lucio Franco <luciofranco14@gmail.com>, Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/http-body |
| httparse | 1.10.1 | MIT OR Apache-2.0 — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/httparse |
| hyper | 1.11.0 | MIT — Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/hyper |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/hyper-rustls |
| hyper-util | 0.1.20 | MIT — Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/hyper-util |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 — Andrew Straw <strawman@astraw.com>, René Kijewski <rene.kijewski@fu-berlin.de>, Ryan Lopopolo <rjl@hyperbo.la> | https://github.com/strawlab/iana-time-zone |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 — René Kijewski <crates.io@k6i.de> | https://github.com/strawlab/iana-time-zone |
| ico | 0.5.0 | MIT — Matthew D. Steele <mdsteele@alum.mit.edu> | https://github.com/mdsteele/rust-ico |
| icu_collections | 2.1.1 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_locale_core | 2.1.1 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_normalizer | 2.1.1 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_normalizer_data | 2.1.1 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_properties | 2.1.2 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_properties_data | 2.1.2 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| icu_provider | 2.1.1 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| ident_case | 1.0.1 | MIT/Apache-2.0 — Ted Driggs <ted.driggs@outlook.com> | https://github.com/TedDriggs/ident_case |
| idna | 1.1.0 | MIT OR Apache-2.0 — The rust-url developers | https://github.com/servo/rust-url/ |
| idna_adapter | 1.2.1 | Apache-2.0 OR MIT — The rust-url developers | https://github.com/hsivonen/idna_adapter |
| image | 0.25.10 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/image |
| image-webp | 0.2.4 | MIT OR Apache-2.0 | https://github.com/image-rs/image-webp |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | https://github.com/bluss/indexmap |
| indexmap | 2.14.0 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| infer | 0.19.0 | MIT — Bojan <dbojan@gmail.com> | https://github.com/bojand/infer |
| ipnet | 2.12.1 | MIT OR Apache-2.0 — Kris Price <kris@krisprice.nz> | https://github.com/krisprice/ipnet |
| is-docker | 0.2.0 | MIT — Sean Larkin <TheLarkInn@users.noreply.github.com> | https://github.com/TheLarkInn/is-docker |
| is-wsl | 0.4.0 | MIT — Sean Larkin <TheLarkInn@users.noreply.github.com> | https://github.com/TheLarkInn/is-wsl |
| itertools | 0.13.0 | MIT OR Apache-2.0 — bluss | https://github.com/rust-itertools/itertools |
| itoa | 1.0.18 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/itoa |
| javascriptcore-rs | 1.1.2 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| javascriptcore-rs-sys | 1.1.1 | MIT — The Gtk-rs Project Developers | https://github.com/tauri-apps/javascriptcore-rs |
| jni | 0.21.1 | MIT/Apache-2.0 — Josh Chase <josh@prevoty.com> | https://github.com/jni-rs/jni-rs |
| jni | 0.22.4 | MIT OR Apache-2.0 — jni team | https://github.com/jni-rs/jni-rs |
| jni-macros | 0.22.4 | MIT OR Apache-2.0 | https://github.com/jni-rs/jni-rs |
| jni-sys | 0.3.1 | MIT OR Apache-2.0 — Steven Fackler <sfackler@gmail.com> | https://github.com/jni-rs/jni-sys |
| jni-sys | 0.4.1 | MIT OR Apache-2.0 — Steven Fackler <sfackler@gmail.com>, Robert Bragg <robert@sixbynine.org> | https://github.com/jni-rs/jni-sys |
| jni-sys-macros | 0.4.1 | MIT OR Apache-2.0 — Robert Bragg <robert@sixbynine.org> | https://github.com/jni-rs/jni-sys |
| js-sys | 0.3.104 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| json-patch | 3.0.1 | MIT/Apache-2.0 — Ivan Dubrov <dubrov.ivan@gmail.com> | https://github.com/idubrov/json-patch |
| jsonptr | 0.6.3 | MIT OR Apache-2.0 — chance dinkins, André Sá de Mello <codasm@pm.me> | https://github.com/chanced/jsonptr |
| keyboard-types | 0.7.0 | MIT OR Apache-2.0 — Pyfisch <pyfisch@posteo.org> | https://github.com/pyfisch/keyboard-types |
| keyring | 3.6.3 | MIT OR Apache-2.0 — Walther Chen <walther.chen@gmail.com>, Daniel Brotsky <dev@brotsky.com> | https://github.com/hwchen/keyring-rs.git |
| khronos_api | 3.1.0 | Apache-2.0 — Brendan Zabarauskas <bjzaba@yahoo.com.au>, Corey Richardson, Arseny Kapoulkine, Pierre Krieger <pierre.krieger1708@gmail.com> | https://github.com/brendanzab/gl-rs/ |
| khronos-egl | 6.0.0 | MIT/Apache-2.0 — Timothée Haudebourg <author@haudebourg.net>, Sean Kerr <sean@metatomic.io> | https://github.com/timothee-haudebourg/khronos-egl |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT | — |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT | — |
| libc | 0.2.189 | MIT OR Apache-2.0 | https://github.com/rust-lang/libc |
| libdbus-sys | 0.2.7 | Apache-2.0/MIT — David Henningsson <diwic@ubuntu.com> | https://github.com/diwic/dbus-rs |
| libloading | 0.7.4 | ISC — Simonas Kazlauskas <libloading@kazlauskas.me> | https://github.com/nagisa/rust_libloading/ |
| libloading | 0.8.9 | ISC — Simonas Kazlauskas <libloading@kazlauskas.me> | https://github.com/nagisa/rust_libloading/ |
| libredox | 0.1.19 | MIT — 4lDO2 <4lDO2@protonmail.com> | https://gitlab.redox-os.org/redox-os/libredox.git |
| libspa | 0.10.1 | MIT — Tom Wagner <tom.a.wagner@protonmail.com>, Guillaume Desmottes <guillaume.desmottes@collabora.com> | https://gitlab.freedesktop.org/pipewire/pipewire-rs |
| libspa-sys | 0.10.1 | MIT — Tom Wagner <tom.a.wagner@protonmail.com>, Guillaume Desmottes <guillaume.desmottes@collabora.com> | https://gitlab.freedesktop.org/pipewire/pipewire-rs |
| libwayshot-xcap | 0.3.3 | BSD-2-Clause — Shinyzenith <https://aakash.is-a.dev> | https://github.com/nashaofu/wayshot |
| linux-raw-sys | 0.4.15 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Dan Gohman <dev@sunfishcode.online> | https://github.com/sunfishcode/linux-raw-sys |
| linux-raw-sys | 0.9.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Dan Gohman <dev@sunfishcode.online> | https://github.com/sunfishcode/linux-raw-sys |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Dan Gohman <dev@sunfishcode.online> | https://github.com/sunfishcode/linux-raw-sys |
| litemap | 0.8.3 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| litrs | 1.0.0 | MIT OR Apache-2.0 — Lukas Kalbertodt <lukas.kalbertodt@gmail.com> | https://github.com/LukasKalbertodt/litrs |
| lock_api | 0.4.14 | MIT OR Apache-2.0 — Amanieu d'Antras <amanieu@gmail.com> | https://github.com/Amanieu/parking_lot |
| log | 0.4.33 | MIT OR Apache-2.0 — The Rust Project Developers | https://github.com/rust-lang/log |
| lru-slab | 0.1.2 | MIT OR Apache-2.0 OR Zlib — Benjamin Saunders <ben.e.saunders@gmail.com> | https://github.com/Ralith/lru-slab |
| mac-notification-sys | 0.6.15 | MIT/Apache-2.0 — Felix Döring <development@felixdoering.com>, Hendrik Sollich <hendrik@hoodie.de> | https://github.com/h4llow3En/mac-notification-sys |
| markup5ever | 0.38.0 | MIT OR Apache-2.0 — The html5ever Project Developers | https://github.com/servo/html5ever |
| memchr | 2.8.3 | Unlicense OR MIT — Andrew Gallant <jamslam@gmail.com>, bluss | https://github.com/BurntSushi/memchr |
| memmap2 | 0.9.11 | MIT OR Apache-2.0 — Dan Burkert <dan@danburkert.com>, Yevhenii Reizner <razrfalcon@gmail.com>, The Contributors | https://github.com/RazrFalcon/memmap2-rs |
| memoffset | 0.9.1 | MIT — Gilad Naaman <gilad.naaman@gmail.com> | https://github.com/Gilnaa/memoffset |
| mime | 0.3.17 | MIT OR Apache-2.0 — Sean McArthur <sean@seanmonstar.com> | https://github.com/hyperium/mime |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 — Alex Huszagh <ahuszagh@gmail.com> | https://github.com/Alexhuszagh/minimal-lexical |
| minisign-verify | 0.2.5 | MIT — Frank Denis <github@pureftpd.org> | https://github.com/jedisct1/rust-minisign-verify |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 — Frommi <daniil.liferenko@gmail.com>, oyvindln <oyvindln@users.noreply.github.com>, Rich Geldreich richgel99@gmail.com | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| mio | 1.2.2 | MIT — Carl Lerche <me@carllerche.com>, Thomas de Zeeuw <thomasdezeeuw@gmail.com>, Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/mio |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 — Radzivon Bartoshyk | https://github.com/awxkee/moxcms.git |
| muda | 0.19.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/muda |
| ndk | 0.9.0 | MIT OR Apache-2.0 — The Rust Mobile contributors | https://github.com/rust-mobile/ndk |
| ndk-sys | 0.6.0+11769913 | MIT OR Apache-2.0 — The Rust Windowing contributors | https://github.com/rust-mobile/ndk |
| new_debug_unreachable | 1.0.6 | MIT — Matt Brubeck <mbrubeck@limpet.net>, Jonathan Reem <jonathan.reem@gmail.com> | https://github.com/mbrubeck/rust-debug-unreachable |
| nom | 7.1.3 | MIT — contact@geoffroycouprie.com | https://github.com/Geal/nom |
| nom | 8.0.0 | MIT — contact@geoffroycouprie.com | https://github.com/rust-bakery/nom |
| notify-rust | 4.18.0 | MIT OR Apache-2.0 — Hendrik Sollich <hendrik@hoodie.de> | https://github.com/hoodie/notify-rust |
| num_cpus | 1.17.0 | MIT OR Apache-2.0 — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/num_cpus |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 — Daniel Wagner-Hall <dawagner@gmail.com>, Daniel Henry-Mantilla <daniel.henry.mantilla@gmail.com>, Vincent Esche <regexident@gmail.com> | https://github.com/illicitonion/num_enum |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 — Daniel Wagner-Hall <dawagner@gmail.com>, Daniel Henry-Mantilla <daniel.henry.mantilla@gmail.com>, Vincent Esche <regexident@gmail.com> | https://github.com/illicitonion/num_enum |
| num-conv | 0.2.2 | MIT OR Apache-2.0 — Jacob Pratt <jacob@jhpratt.dev> | https://github.com/jhpratt/num-conv |
| num-traits | 0.2.19 | MIT OR Apache-2.0 — The Rust Project Developers | https://github.com/rust-num/num-traits |
| objc2 | 0.6.4 | MIT — Mads Marquart <mads@marquart.dk> | https://github.com/madsmtm/objc2 |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-av-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-avf-audio | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-cloud-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-audio | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-audio-types | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-data | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-image | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-location | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-media | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-video | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-encode | 4.1.0 | MIT — Mads Marquart <mads@marquart.dk> | https://github.com/madsmtm/objc2 |
| objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT — Mads Marquart <mads@marquart.dk> | https://github.com/madsmtm/objc2 |
| objc2-foundation | 0.3.2 | MIT | https://github.com/madsmtm/objc2 |
| objc2-image-io | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-media-toolbox | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-metal | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-osa-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-ui-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-user-notifications | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| ocrs | 0.12.2 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/ocrs |
| once_cell | 1.21.4 | MIT OR Apache-2.0 — Aleksey Kladov <aleksey.kladov@gmail.com> | https://github.com/matklad/once_cell |
| open | 5.4.1 | MIT — Sebastian Thiel <byronimo@gmail.com> | https://github.com/Byron/open-rs |
| openssl-probe | 0.2.1 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/rustls/openssl-probe |
| option-ext | 0.2.0 | MPL-2.0 — Simon Ochsenreither <simon@ochsenreither.de> | https://github.com/soc/option-ext.git |
| ordered-stream | 0.2.0 | MIT OR Apache-2.0 — Daniel De Graaf <code@danieldg.net>, Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/danieldg/ordered-stream |
| osakit | 0.3.1 | MIT OR Apache-2.0 — Marat Dulin <mdevils@gmail.com> | https://github.com/mdevils/rust-osakit |
| pango | 0.18.3 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| pango-sys | 0.18.0 | MIT — The gtk-rs Project Developers | https://github.com/gtk-rs/gtk-rs-core |
| parking | 2.2.1 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, The Rust Project Developers | https://github.com/smol-rs/parking |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 — Amanieu d'Antras <amanieu@gmail.com> | https://github.com/Amanieu/parking_lot |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 — Amanieu d'Antras <amanieu@gmail.com> | https://github.com/Amanieu/parking_lot |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 — The rust-url developers | https://github.com/servo/rust-url/ |
| phf | 0.13.1 | MIT — Steven Fackler <sfackler@gmail.com> | https://github.com/rust-phf/rust-phf |
| phf_codegen | 0.13.1 | MIT — Steven Fackler <sfackler@gmail.com> | https://github.com/rust-phf/rust-phf |
| phf_generator | 0.13.1 | MIT — Steven Fackler <sfackler@gmail.com> | https://github.com/rust-phf/rust-phf |
| phf_macros | 0.13.1 | MIT — Steven Fackler <sfackler@gmail.com> | https://github.com/rust-phf/rust-phf |
| phf_shared | 0.13.1 | MIT — Steven Fackler <sfackler@gmail.com> | https://github.com/rust-phf/rust-phf |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| piper | 0.2.5 | MIT OR Apache-2.0 — Stjepan Glavina <stjepang@gmail.com>, John Nunley <dev@notgull.net> | https://github.com/smol-rs/piper |
| pipewire | 0.10.1 | MIT — Tom Wagner <tom.a.wagner@protonmail.com>, Guillaume Desmottes <guillaume.desmottes@collabora.com> | https://gitlab.freedesktop.org/pipewire/pipewire-rs |
| pipewire-sys | 0.10.1 | MIT — Tom Wagner <tom.a.wagner@protonmail.com>, Guillaume Desmottes <guillaume.desmottes@collabora.com> | https://gitlab.freedesktop.org/pipewire/pipewire-rs |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/rust-lang/pkg-config-rs |
| plist | 1.10.0 | MIT — Ed Barnard <eabarnard@gmail.com> | https://github.com/ebarnard/rust-plist/ |
| png | 0.17.16 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/image-png |
| png | 0.18.1 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/image-png |
| polling | 3.11.0 | Apache-2.0 OR MIT — Stjepan Glavina <stjepang@gmail.com>, John Nunley <dev@notgull.net> | https://github.com/smol-rs/polling |
| potential_utf | 0.1.6 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 — Jacob Pratt <jacob@jhpratt.dev> | https://github.com/jhpratt/powerfmt |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 — The CryptoCorrosion Contributors | https://github.com/cryptocorrosion/cryptocorrosion |
| precomputed-hash | 0.1.1 | MIT — Emilio Cobos Álvarez <emilio@crisal.io> | https://github.com/emilio/precomputed-hash |
| proc-macro-crate | 1.3.1 | MIT OR Apache-2.0 — Bastian Köcher <git@kchr.de> | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 2.0.2 | MIT OR Apache-2.0 — Bastian Köcher <git@kchr.de> | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 — Bastian Köcher <git@kchr.de> | https://github.com/bkchr/proc-macro-crate |
| proc-macro-error | 1.0.4 | MIT OR Apache-2.0 — CreepySkeleton <creepy-skeleton@yandex.ru> | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro-error-attr | 1.0.4 | MIT OR Apache-2.0 — CreepySkeleton <creepy-skeleton@yandex.ru> | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com>, Alex Crichton <alex@alexcrichton.com> | https://github.com/dtolnay/proc-macro2 |
| psl-types | 2.0.11 | MIT/Apache-2.0 — rushmorem <rushmore@webenchanter.com> | https://github.com/addr-rs/psl-types |
| publicsuffix | 2.3.0 | MIT/Apache-2.0 — rushmorem <rushmore@webenchanter.com> | https://github.com/rushmorem/publicsuffix |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 — Radzivon Bartoshyk | https://github.com/awxkee/pxfm |
| quick-error | 2.0.1 | MIT/Apache-2.0 — Paul Colomiets <paul@colomiets.name>, Colin Kiegel <kiegel@gmx.de> | http://github.com/tailhook/quick-error |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| quinn | 0.11.11 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quinn-proto | 0.11.16 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quinn-udp | 0.5.15 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quote | 1.0.47 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/quote |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| rand | 0.9.5 | MIT OR Apache-2.0 — The Rand Project Developers, The Rust Project Developers | https://github.com/rust-random/rand |
| rand | 0.10.2 | MIT OR Apache-2.0 — The Rand Project Developers, The Rust Project Developers | https://github.com/rust-random/rand |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 — The Rand Project Developers, The Rust Project Developers, The CryptoCorrosion Contributors | https://github.com/rust-random/rand |
| rand_core | 0.9.5 | MIT OR Apache-2.0 — The Rand Project Developers, The Rust Project Developers | https://github.com/rust-random/rand |
| rand_core | 0.10.1 | MIT OR Apache-2.0 — The Rand Project Developers | https://github.com/rust-random/rand_core |
| rand_pcg | 0.10.2 | MIT OR Apache-2.0 — The Rand Project Developers | https://github.com/rust-random/rngs |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib — Osspial <osspial@gmail.com> | https://github.com/rust-windowing/raw-window-handle |
| rayon | 1.12.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| redox_syscall | 0.5.18 | MIT — Jeremy Soller <jackpot51@gmail.com> | https://gitlab.redox-os.org/redox-os/syscall |
| redox_users | 0.5.2 | MIT — Jose Narvaez <goyox86@gmail.com>, Wesley Hershberger <mggmugginsmc@gmail.com> | https://gitlab.redox-os.org/redox-os/users |
| ref-cast | 1.0.26 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/ref-cast |
| ref-cast-impl | 1.0.26 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/ref-cast |
| regex | 1.13.1 | MIT OR Apache-2.0 — The Rust Project Developers, Andrew Gallant <jamslam@gmail.com> | https://github.com/rust-lang/regex |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 — The Rust Project Developers, Andrew Gallant <jamslam@gmail.com> | https://github.com/rust-lang/regex |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 — The Rust Project Developers, Andrew Gallant <jamslam@gmail.com> | https://github.com/rust-lang/regex |
| reqwest | 0.12.28 | MIT OR Apache-2.0 — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/reqwest |
| reqwest | 0.13.4 | MIT OR Apache-2.0 — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/reqwest |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| rten | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-base | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-gemm | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-imageproc | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-model-file | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-onnx | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-shape-inference | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-simd | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-tensor | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rten-vecmath | 0.24.0 | MIT OR Apache-2.0 — Robert Knight | https://github.com/robertknight/rten |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 | https://github.com/djc/rustc-version-rs |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT — The Rust Project Developers | https://github.com/rust-lang/rustc-hash |
| rustix | 0.38.44 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Dan Gohman <dev@sunfishcode.online>, Jakub Konka <kubkon@jakubkonka.com> | https://github.com/bytecodealliance/rustix |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Dan Gohman <dev@sunfishcode.online>, Jakub Konka <kubkon@jakubkonka.com> | https://github.com/bytecodealliance/rustix |
| rustls | 0.23.43 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| rustls-native-certs | 0.8.4 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls-native-certs |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 | https://github.com/rustls/pki-types |
| rustls-platform-verifier | 0.7.0 | MIT OR Apache-2.0 | https://github.com/rustls/rustls-platform-verifier |
| rustls-platform-verifier-android | 0.1.1 | MIT OR Apache-2.0 | https://github.com/rustls/rustls-platform-verifier |
| rustls-webpki | 0.103.14 | ISC | https://github.com/rustls/webpki |
| rustversion | 1.0.23 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/rustversion |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/ryu |
| same-file | 1.0.6 | Unlicense/MIT — Andrew Gallant <jamslam@gmail.com> | https://github.com/BurntSushi/same-file |
| schannel | 0.1.29 | MIT — Steven Fackler <sfackler@gmail.com>, Steffen Butzer <steffen.butzer@outlook.com> | https://github.com/steffengy/schannel-rs |
| schemars | 0.8.22 | MIT — Graham Esau <gesau@hotmail.co.uk> | https://github.com/GREsau/schemars |
| schemars | 0.9.0 | MIT — Graham Esau <gesau@hotmail.co.uk> | https://github.com/GREsau/schemars |
| schemars | 1.2.2 | MIT — Graham Esau <gesau@hotmail.co.uk> | https://github.com/GREsau/schemars |
| schemars_derive | 0.8.22 | MIT — Graham Esau <gesau@hotmail.co.uk> | https://github.com/GREsau/schemars |
| scoped-tls | 1.0.1 | MIT/Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/alexcrichton/scoped-tls |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 — bluss | https://github.com/bluss/scopeguard |
| security-framework | 2.11.1 | MIT OR Apache-2.0 — Steven Fackler <sfackler@gmail.com>, Kornel <kornel@geekhood.net> | https://github.com/kornelski/rust-security-framework |
| security-framework | 3.7.0 | MIT OR Apache-2.0 — Steven Fackler <sfackler@gmail.com>, Kornel <kornel@geekhood.net> | https://github.com/kornelski/rust-security-framework |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 — Steven Fackler <sfackler@gmail.com>, Kornel <kornel@geekhood.net> | https://github.com/kornelski/rust-security-framework |
| selectors | 0.36.1 | MPL-2.0 — The Servo Project Developers | https://github.com/servo/stylo |
| semver | 1.0.28 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/semver |
| serde | 1.0.229 | MIT OR Apache-2.0 — Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com> | https://github.com/serde-rs/serde |
| serde_core | 1.0.229 | MIT OR Apache-2.0 — Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com> | https://github.com/serde-rs/serde |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 — Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com> | https://github.com/serde-rs/serde |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 — Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com> | https://github.com/serde-rs/serde |
| serde_json | 1.0.151 | MIT OR Apache-2.0 — Erick Tryzelaar <erick.tryzelaar@gmail.com>, David Tolnay <dtolnay@gmail.com> | https://github.com/serde-rs/json |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/serde-repr |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| serde_spanned | 1.1.1 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 — Anthony Ramine <n.oxyde@gmail.com> | https://github.com/nox/serde_urlencoded |
| serde_with | 3.17.0 | MIT OR Apache-2.0 — Jonas Bushart, Marcin Kaźmierczak | https://github.com/jonasbb/serde_with/ |
| serde_with_macros | 3.17.0 | MIT OR Apache-2.0 — Jonas Bushart | https://github.com/jonasbb/serde_with/ |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/serde-untagged |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 — Chip Reed <chip@chip.sh> | https://github.com/chippers/serialize-to-javascript |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 — Chip Reed <chip@chip.sh> | https://github.com/chippers/serialize-to-javascript |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/stylo |
| sha2 | 0.10.9 | MIT OR Apache-2.0 — RustCrypto Developers | https://github.com/RustCrypto/hashes |
| shlex | 1.3.0 | MIT OR Apache-2.0 — comex <comexk@gmail.com>, Fenhl <fenhl@fenhl.net>, Adrian Taylor <adetaylor@chromium.org>, Alex Touchet <alextouchet@outlook.com>, Daniel Parks <dp+git@oxidized.org>, Garrett Berg <googberg@gmail.com> | https://github.com/comex/rust-shlex |
| shlex | 2.0.1 | MIT OR Apache-2.0 — comex <comexk@gmail.com>, Fenhl <fenhl@fenhl.net>, Adrian Taylor <adetaylor@chromium.org>, Alex Touchet <alextouchet@outlook.com>, Daniel Parks <dp+git@oxidized.org>, Garrett Berg <googberg@gmail.com> | https://github.com/comex/rust-shlex |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 — Michal 'vorner' Vaner <vorner@vorner.cz>, Masaki Hara <ackie.h.gmai@gmail.com> | https://github.com/vorner/signal-hook |
| simd_cesu8 | 1.2.0 | Apache-2.0 OR MIT — Sean C. Roach <me@seancroach.dev> | https://github.com/seancroach/simd_cesu8 |
| simd-adler32 | 0.3.10 | MIT — Marvin Countryman <me@maar.vin> | https://github.com/mcountryman/simd-adler32 |
| simdutf8 | 0.1.5 | MIT OR Apache-2.0 — Hans Kratz <hans@appfour.com> | https://github.com/rusticstuff/simdutf8 |
| siphasher | 1.0.3 | MIT/Apache-2.0 — Frank Denis <github@pureftpd.org> | https://github.com/jedisct1/rust-siphash |
| slab | 0.4.12 | MIT — Carl Lerche <me@carllerche.com> | https://github.com/tokio-rs/slab |
| smallvec | 1.15.2 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/rust-smallvec |
| socket2 | 0.6.5 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com>, Thomas de Zeeuw <thomasdezeeuw@gmail.com> | https://github.com/rust-lang/socket2 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | https://github.com/rust-windowing/softbuffer |
| soup3 | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| soup3-sys | 0.5.0 | MIT — The Gtk-rs Project Developers | https://gitlab.gnome.org/World/Rust/soup3-rs |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 — Robert Grosse <n210241048576@gmail.com> | https://github.com/storyyeller/stable_deref_trait |
| string_cache | 0.9.0 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/string-cache |
| string_cache_codegen | 0.6.1 | MIT OR Apache-2.0 — The Servo Project Developers | https://github.com/servo/string-cache |
| strsim | 0.11.1 | MIT — Danny Guo <danny@dannyguo.com>, maxbachmann <oss@maxbachmann.de> | https://github.com/rapidfuzz/strsim-rs |
| subtle | 2.6.1 | BSD-3-Clause — Isis Lovecruft <isis@patternsinthevoid.net>, Henry de Valence <hdevalence@hdevalence.ca> | https://github.com/dalek-cryptography/subtle |
| swift-rs | 1.0.7 | MIT OR Apache-2.0 — The swift-rs contributors | https://github.com/Brendonovich/swift-rs |
| syn | 1.0.109 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/syn |
| syn | 2.0.119 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/syn |
| syn | 3.0.3 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/syn |
| sync_wrapper | 1.0.2 | Apache-2.0 — Actyx AG <developer@actyx.io> | https://github.com/Actyx/sync_wrapper |
| synstructure | 0.13.2 | MIT — Nika Layzell <nika@thelayzells.com> | https://github.com/mystor/synstructure |
| system-configuration | 0.7.0 | MIT OR Apache-2.0 — Mullvad VPN | https://github.com/mullvad/system-configuration-rs |
| system-configuration-sys | 0.6.0 | MIT OR Apache-2.0 — Mullvad VPN | https://github.com/mullvad/system-configuration-rs |
| system-deps | 6.2.2 | MIT OR Apache-2.0 — Guillaume Desmottes <guillaume.desmottes@collabora.com>, Josh Triplett <josh@joshtriplett.org> | https://github.com/gdesmott/system-deps |
| system-deps | 7.0.8 | MIT OR Apache-2.0 — Guillaume Desmottes <guillaume.desmottes@collabora.com>, Josh Triplett <josh@joshtriplett.org> | https://github.com/gdesmott/system-deps |
| tao | 0.35.3 | Apache-2.0 — Tauri Programme within The Commons Conservancy, The winit contributors | https://github.com/tauri-apps/tao |
| tao-macros | 0.1.4 | MIT OR Apache-2.0 — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tao |
| tar | 0.4.46 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/composefs/tar-rs |
| target-lexicon | 0.12.16 | Apache-2.0 WITH LLVM-exception — Dan Gohman <sunfish@mozilla.com> | https://github.com/bytecodealliance/target-lexicon |
| target-lexicon | 0.13.5 | Apache-2.0 WITH LLVM-exception — Dan Gohman <sunfish@mozilla.com> | https://github.com/bytecodealliance/target-lexicon |
| tauri | 2.11.5 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-build | 2.6.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-codegen | 2.6.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-macros | 2.6.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-plugin | 2.6.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-plugin-fs | 2.5.1 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-http | 2.5.9 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-notification | 2.3.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-opener | 2.5.4 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-process | 2.3.1 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-updater | 2.10.1 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/plugins-workspace |
| tauri-runtime | 2.11.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-runtime-wry | 2.11.4 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-utils | 2.9.3 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri |
| tauri-winres | 0.3.6 | MIT — Tauri Programme within The Commons Conservancy, Max Resch <resch.max@gmail.com> | https://github.com/tauri-apps/winres |
| tauri-winrt-notification | 0.7.3 | MIT OR Apache-2.0 — allenbenz, Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/winrt-notification |
| tempfile | 3.27.0 | MIT OR Apache-2.0 — Steven Allen <steven@stebalien.com>, The Rust Project Developers, Ashley Mannix <ashleymannix@live.com.au>, Jason White <me@jasonwhite.io> | https://github.com/Stebalien/tempfile |
| tendril | 0.5.1 | MIT OR Apache-2.0 — Keegan McAllister <mcallister.keegan@gmail.com>, Simon Sapin <simon.sapin@exyr.org>, Chris Morgan <me@chrismorgan.info> | https://github.com/servo/html5ever |
| thiserror | 1.0.69 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/thiserror |
| thiserror | 2.0.20 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/thiserror |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/thiserror |
| thiserror-impl | 2.0.20 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/thiserror |
| time | 0.3.55 | MIT OR Apache-2.0 — Jacob Pratt <open-source@jhpratt.dev>, Time contributors | https://github.com/time-rs/time |
| time-core | 0.1.9 | MIT OR Apache-2.0 — Jacob Pratt <open-source@jhpratt.dev>, Time contributors | https://github.com/time-rs/time |
| time-macros | 0.2.32 | MIT OR Apache-2.0 — Jacob Pratt <open-source@jhpratt.dev>, Time contributors | https://github.com/time-rs/time |
| tinystr | 0.8.4 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| tinyvec | 1.12.0 | Zlib OR Apache-2.0 OR MIT — Lokathor <zefria@gmail.com> | https://github.com/Lokathor/tinyvec |
| tinyvec_macros | 0.1.1 | MIT OR Apache-2.0 OR Zlib — Soveu <marx.tomasz@gmail.com> | https://github.com/Soveu/tinyvec_macros |
| tokio | 1.53.1 | MIT — Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/tokio |
| tokio-macros | 2.7.2 | MIT — Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/tokio |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 | https://github.com/rustls/tokio-rustls |
| tokio-util | 0.7.19 | MIT — Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/tokio |
| toml | 0.8.2 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/toml-rs/toml |
| toml | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml | 1.1.4+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_datetime | 0.6.3 | MIT OR Apache-2.0 — Alex Crichton <alex@alexcrichton.com> | https://github.com/toml-rs/toml |
| toml_datetime | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_edit | 0.19.15 | MIT OR Apache-2.0 — Andronik Ordian <write@reusable.software>, Ed Page <eopage@gmail.com> | https://github.com/toml-rs/toml |
| toml_edit | 0.20.2 | MIT OR Apache-2.0 — Andronik Ordian <write@reusable.software>, Ed Page <eopage@gmail.com> | https://github.com/toml-rs/toml |
| toml_edit | 0.25.13+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| tower | 0.5.3 | MIT — Tower Maintainers <team@tower-rs.com> | https://github.com/tower-rs/tower |
| tower-http | 0.6.11 | MIT — Tower Maintainers <team@tower-rs.com> | https://github.com/tower-rs/tower-http |
| tower-layer | 0.3.3 | MIT — Tower Maintainers <team@tower-rs.com> | https://github.com/tower-rs/tower |
| tower-service | 0.3.3 | MIT — Tower Maintainers <team@tower-rs.com> | https://github.com/tower-rs/tower |
| tracing | 0.1.44 | MIT — Eliza Weisman <eliza@buoyant.io>, Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/tracing |
| tracing-attributes | 0.1.31 | MIT — Tokio Contributors <team@tokio.rs>, Eliza Weisman <eliza@buoyant.io>, David Barsky <dbarsky@amazon.com> | https://github.com/tokio-rs/tracing |
| tracing-core | 0.1.36 | MIT — Tokio Contributors <team@tokio.rs> | https://github.com/tokio-rs/tracing |
| tray-icon | 0.24.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tray-icon |
| try-lock | 0.2.5 | MIT — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/try-lock |
| typeid | 1.0.3 | MIT OR Apache-2.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/typeid |
| typenum | 1.20.1 | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| uds_windows | 1.2.1 | MIT — Azure IoT Edge Devs, Harald Hoyer <harald@redhat.com> | https://github.com/haraldh/rust_uds_windows |
| unic-char-property | 0.9.0 | MIT/Apache-2.0 — The UNIC Project Developers | https://github.com/open-i18n/rust-unic/ |
| unic-char-range | 0.9.0 | MIT/Apache-2.0 — The UNIC Project Developers | https://github.com/open-i18n/rust-unic/ |
| unic-common | 0.9.0 | MIT/Apache-2.0 — The UNIC Project Developers | https://github.com/open-i18n/rust-unic/ |
| unic-ucd-ident | 0.9.0 | MIT/Apache-2.0 — The UNIC Project Developers | https://github.com/open-i18n/rust-unic/ |
| unic-ucd-version | 0.9.0 | MIT/Apache-2.0 — The UNIC Project Developers | https://github.com/open-i18n/rust-unic/ |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/unicode-ident |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 — kwantam <kwantam@gmail.com>, Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-rs/unicode-segmentation |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 — kwantam <kwantam@gmail.com>, Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-rs/unicode-width |
| untrusted | 0.9.0 | ISC — Brian Smith <brian@briansmith.org> | https://github.com/briansmith/untrusted |
| url | 2.5.8 | MIT OR Apache-2.0 — The rust-url developers | https://github.com/servo/rust-url |
| urlpattern | 0.3.0 | MIT — the Deno authors, crowlKats <crowlkats@toaxl.com> | https://github.com/denoland/rust-urlpattern |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT — Henri Sivonen <hsivonen@hsivonen.fi> | https://github.com/hsivonen/utf8_iter |
| uuid | 1.24.0 | Apache-2.0 OR MIT — Ashley Mannix<ashleymannix@live.com.au>, Dylan DPC<dylan.dpc@gmail.com>, Hunar Roop Kahlon<hunar.roop@gmail.com> | https://github.com/uuid-rs/uuid |
| version_check | 0.9.5 | MIT/Apache-2.0 — Sergio Benitez <sb@sergio.bz> | https://github.com/SergioBenitez/version_check |
| version-compare | 0.2.1 | MIT — Tim Visee <3a4fb3964f@sinenomine.email> | https://gitlab.com/timvisee/version-compare |
| vswhom | 0.1.0 | MIT — nabijaczleweli <nabijaczleweli@gmail.com> | https://github.com/nabijaczleweli/vswhom.rs |
| vswhom-sys | 0.1.3 | MIT — наб <nabijaczleweli@nabijaczleweli.xyz>, forrestsmithfb <forrest.smith@fb.com> | https://github.com/nabijaczleweli/vswhom-sys.rs |
| walkdir | 2.5.0 | Unlicense/MIT — Andrew Gallant <jamslam@gmail.com> | https://github.com/BurntSushi/walkdir |
| want | 0.3.1 | MIT — Sean McArthur <sean@seanmonstar.com> | https://github.com/seanmonstar/want |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — The Cranelift Project Developers | https://github.com/bytecodealliance/wasi |
| wasip2 | 1.0.1+wasi-0.2.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi-rs |
| wasm-bindgen | 0.2.127 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen |
| wasm-bindgen-futures | 0.4.77 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| wasm-bindgen-macro | 0.2.127 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| wasm-bindgen-macro-support | 0.2.127 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| wasm-bindgen-shared | 0.2.127 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| wasm-streams | 0.5.0 | MIT OR Apache-2.0 — Mattias Buelens <mattias@buelens.com> | https://github.com/MattiasBuelens/wasm-streams/ |
| wayland-backend | 0.3.17 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-client | 0.31.15 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-protocols | 0.32.13 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-protocols-wlr | 0.3.12 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-scanner | 0.31.11 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-server | 0.31.14 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| wayland-sys | 0.31.11 | MIT — Elinor Berger <elinor@safaradeg.net> | https://github.com/smithay/wayland-rs |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 — The html5ever Project Developers | https://github.com/servo/html5ever |
| web-sys | 0.3.104 | MIT OR Apache-2.0 — The wasm-bindgen Developers | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| web-time | 1.1.0 | MIT OR Apache-2.0 | https://github.com/daxpedda/web-time |
| webkit2gtk | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webkit2gtk-sys | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webpki-root-certs | 1.0.9 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| webpki-roots | 1.0.9 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| webview2-com | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-macros | 0.8.1 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-sys | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| weezl | 0.1.12 | MIT OR Apache-2.0 — The image-rs Developers | https://github.com/image-rs/weezl |
| widestring | 1.2.1 | MIT OR Apache-2.0 | https://github.com/VoidStarKat/widestring-rs |
| winapi | 0.3.9 | MIT/Apache-2.0 — Peter Atashian <retep998@gmail.com> | https://github.com/retep998/winapi-rs |
| winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 — Peter Atashian <retep998@gmail.com> | https://github.com/retep998/winapi-rs |
| winapi-util | 0.1.11 | Unlicense OR MIT — Andrew Gallant <jamslam@gmail.com> | https://github.com/BurntSushi/winapi-util |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 — Peter Atashian <retep998@gmail.com> | https://github.com/retep998/winapi-rs |
| window-vibrancy | 0.6.0 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| windows | 0.61.3 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows | 0.62.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-collections | 0.2.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-core | 0.61.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-future | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-link | 0.1.3 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.2.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-registry | 0.6.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-result | 0.3.4 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-strings | 0.4.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.45.0 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-sys | 0.59.0 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.42.2 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-threading | 0.1.0 | MIT OR Apache-2.0 — Microsoft | https://github.com/microsoft/windows-rs |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| winnow | 0.5.40 | MIT | https://github.com/winnow-rs/winnow |
| winnow | 0.7.15 | MIT | https://github.com/winnow-rs/winnow |
| winnow | 1.0.4 | MIT | https://github.com/winnow-rs/winnow |
| winreg | 0.55.0 | MIT — Igor Shaula <gentoo90@gmail.com> | https://github.com/gentoo90/winreg-rs |
| wit-bindgen | 0.46.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT — Alex Crichton <alex@alexcrichton.com> | https://github.com/bytecodealliance/wit-bindgen |
| writeable | 0.6.4 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| wry | 0.55.1 | Apache-2.0 OR MIT — Tauri Programme within The Commons Conservancy | https://github.com/tauri-apps/wry |
| x11 | 2.21.0 | MIT — daggerbot <daggerbot@gmail.com>, Erle Pereira <erle@erlepereira.com>, AltF02 <contact@altf2.dev> | https://github.com/AltF02/x11-rs.git |
| x11-dl | 2.21.0 | MIT — daggerbot <daggerbot@gmail.com>, Erle Pereira <erle@erlepereira.com>, AltF02 <contact@altf2.dev> | https://github.com/AltF02/x11-rs.git |
| xattr | 1.6.1 | MIT OR Apache-2.0 — Steven Allen <steven@stebalien.com> | https://github.com/Stebalien/xattr |
| xcap | 0.9.8 | Apache-2.0 | https://github.com/nashaofu/xcap.git |
| xcb | 1.7.1 | MIT — Remi Thebault <remi.thebault@gmail.com> | https://github.com/rust-x-bindings/rust-xcb |
| xml-rs | 0.8.29 | MIT — Vladimir Matveev <vmatveev@citrine.cc> | https://github.com/kornelski/xml-rs |
| yoke | 0.8.3 | Unicode-3.0 — Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-org/icu4x |
| yoke-derive | 0.8.2 | Unicode-3.0 — Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-org/icu4x |
| zbus | 5.19.0 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zbus/ |
| zbus_macros | 5.19.0 | MIT — Marc-André Lureau <marcandre.lureau@redhat.com>, Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zbus/ |
| zbus_names | 4.3.4 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zbus/ |
| zcheapstr | 1.1.0 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zcheapstr/ |
| zerocopy | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerocopy-derive | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerofrom | 0.1.8 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| zerofrom-derive | 0.1.7 | Unicode-3.0 — Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-org/icu4x |
| zeroize | 1.9.0 | Apache-2.0 OR MIT — The RustCrypto Project Developers | https://github.com/RustCrypto/utils |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT — The RustCrypto Project Developers | https://github.com/RustCrypto/utils |
| zerotrie | 0.2.5 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| zerovec | 0.11.7 | Unicode-3.0 — The ICU4X Project Developers | https://github.com/unicode-org/icu4x |
| zerovec-derive | 0.11.4 | Unicode-3.0 — Manish Goregaokar <manishsmail@gmail.com> | https://github.com/unicode-org/icu4x |
| zip | 4.6.1 | MIT — Mathijs van de Nes <git@mathijs.vd-nes.nl>, Marli Frost <marli@frost.red>, Ryan Levick <ryan.levick@gmail.com>, Chris Hennick <hennickc@amazon.com> | https://github.com/zip-rs/zip2.git |
| zmij | 1.0.23 | MIT — David Tolnay <dtolnay@gmail.com> | https://github.com/dtolnay/zmij |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib — caleb <etemesicaleb@gmail.com> | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |
| zvariant | 5.15.0 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zbus/ |
| zvariant_derive | 5.15.0 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org> | https://github.com/z-galaxy/zbus/ |
| zvariant_utils | 4.2.0 | MIT — Zeeshan Ali Khan <zeeshanak@gnome.org>, turbocooler <turbocooler@cocaine.ninja> | https://github.com/z-galaxy/zbus/ |

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
