# unshackled-bot

Tauri 2 + React 19 + TypeScript 7 desktop app.

## Requirements

- Node ≥ 22.12 (`.nvmrc` pins 24 for CI) and pnpm 10 (`corepack enable`)
- Rust 1.90 (installed automatically from `rust-toolchain.toml`)
- Platform deps for Tauri: <https://tauri.app/start/prerequisites/>

## Getting started

```bash
pnpm install     # also installs git hooks via lefthook
pnpm tauri:dev   # run the desktop app with HMR
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm tauri:dev` | Desktop app in dev mode (Vite HMR + Rust watch) |
| `pnpm tauri:build` | Production bundle for the current platform |
| `pnpm dev` | Frontend only, in a browser at `localhost:1421` |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format + import sorting |
| `pnpm typecheck` | `tsc --build` over both TS projects |
| `pnpm test` / `pnpm test:coverage` | Vitest (jsdom + Testing Library) |
| `pnpm rs:fmt` / `pnpm rs:lint` / `pnpm rs:test` | rustfmt, clippy (`-D warnings`), cargo test |
| `pnpm check` | Everything CI runs, locally |

## Layout

```
src/                 React frontend
  lib/tauri.ts       the ONLY place that calls `invoke` — typed IPC boundary
  components/        UI components
  test/setup.ts      Vitest + Testing Library setup
src-tauri/
  src/commands.rs    #[tauri::command] handlers + input validation
  src/error.rs       error type serialized across IPC
  capabilities/      per-window permission allowlist
```

## Conventions

- **All IPC goes through `src/lib/tauri.ts`.** Adding a Rust command means adding a
  typed wrapper there, so a rename breaks one file instead of leaking `unknown`.
- **Commands validate their input.** The webview is a hostile boundary: every
  free-text argument is trimmed and length-bounded in `commands.rs` before use.
- **Permissions are allowlists.** `src-tauri/capabilities/default.json` grants only
  what the UI actually uses; the `opener` scope lists exact URLs. Widen deliberately.
- **The webview never navigates externally.** Use `ExternalLink`, which hands the URL
  to the OS browser — a navigated webview would keep the IPC bridge.
- **CSP is on** in `tauri.conf.json` (`default-src 'self'`, no `unsafe-eval`).
- Git hooks: Biome + rustfmt on commit, typecheck/tests/clippy on push (`lefthook.yml`).

## License

[GNU AGPL-3.0-only](LICENSE). Beyond the GPL, section 13 adds a network clause: if you
let users interact with a modified version remotely, you must offer them its source.
