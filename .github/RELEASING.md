# Releasing

How installers get from a tag to a draft GitHub Release, and which optional
secrets turn on code signing.

## Cutting a release

```bash
# version lives in package.json AND src-tauri/tauri.conf.json — bump both,
# keep them identical
git tag v0.X.Y && git push origin v0.X.Y
```

Pushing a `v*` tag runs [release.yml](workflows/release.yml):

1. Bundles installers on all four targets — macOS arm64 + x64 (`.dmg`),
   Linux x64 (`.deb` + `.AppImage`), Windows x64 (NSIS `.exe`) — as workflow
   artifacts.
2. Creates a **draft** GitHub Release with every installer plus a
   `SHA256SUMS.txt`. Review the draft, then publish it.

Retagging re-runs safely: the release step uploads with `--clobber` if a
draft for the tag already exists. `workflow_dispatch` runs the bundles
without creating a release (artifact-only smoke test).

## Never change the bundle identifier

`identifier` in `tauri.conf.json` is `com.blobbies.app` and has to stay that
way. Tauri logs a warning that `.app` reads like the macOS bundle extension;
that is cosmetic — a `log::warn!` with no behaviour attached.

Renaming it is not cosmetic. macOS keys per-app state by bundle identifier, so
a new one hands every existing user an empty slate:

- **WebKit localStorage** moves to a fresh container, losing every `pref:*`:
  onboarding completion (first-run replays), theme, timezone, model, reasoning,
  sounds, plugin shortlist, section layout.
- **Notification permission** re-prompts, being keyed the same way.

Chats, Blobs and API keys survive — `~/.blobbies` and the keychain `SERVICE`
are keyed independently, and `SERVICE` is frozen for the same reason.

Caught by smoke-testing a signed 0.1.6 build against real data: it showed
onboarding on a machine that had long since finished it. If a rename ever
becomes genuinely necessary it needs a migration that reads the old
container's `localstorage.sqlite3` once at startup, not just a config edit.

## In-app updates

Every release ships `latest.json` (written by `scripts/update-manifest.mjs`)
so the in-app updater can find it. The app checks on launch and every 4h,
plus manually from Settings → Updates; a new version shows a green card in
the sidebar that downloads, then installs and restarts. The endpoint is
pinned in `tauri.conf.json` to this repo's `releases/latest/download/latest.json`.

Update packages are minisign-signed; the **private key lives in
`~/.blobbies-keys/updater.key` (back this up — losing it means no more
updates for existing installs) and as the `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the matching public key is
committed in `tauri.conf.json`** (`plugins.updater.pubkey`). A client that
cannot verify a signature refuses the update.

Testing the flow end-to-end: install release N (published), then publish
N+1 — the running app should find, download, install, and relaunch. The
endpoint only sees **published** releases, so drafts never trigger it.

## Installer branding

macOS DMG and Windows NSIS installers carry custom art, generated from the
app's own Blob geometry:

- `src-tauri/dmg/dmg-background.png` — 960×600, exactly the window's point
  size. Finder does NOT scale DMG backgrounds: a larger image is cropped,
  so the file must match `windowSize` pixel-for-pixel.
- `src-tauri/windows/nsis-header.bmp` (150×57) and
  `src-tauri/windows/nsis-sidebar.bmp` (164×314) — 24-bit BMP, exact sizes:
  Tauri's NSIS template sets `NOSTRETCH`, so other sizes crop, not stretch.

Source of truth is `scripts/installer-art.html` (transcribes the Blob
shapes/colours from `src/components/BlobAvatar.tsx`) — edit it, re-render
the three `?art=` variants with a browser at the sizes in its header, and
re-convert the BMPs with `sips`. The DMG layout lives in `tauri.conf.json`
(`bundle.macOS.dmg`); the icon positions there are the **centres** of the
128px Finder icons (verified via accessibility measurements — Finder
treats `position` as the icon-image centre) and must match the drop-zone
art. The Finder content view also starts ~32pt below the window top
(titlebar), so the top ~32px of the background sit behind the titlebar —
keep the top edge expendable.

`TAURI_BUNDLER_DMG_IGNORE_CI: "true"` in release.yml is load-bearing: CI
sets `CI=true`, which otherwise makes the bundler skip the Finder
AppleScript and ship a plain, unstyled DMG.

## Signing

macOS: **signed + notarized** — the six APPLE_*/KEYCHAIN secrets are set,
 and the shipped dmgs pass `spctl` ("accepted, source=Notarized Developer
 ID") and `stapler validate`.

Windows: **unsigned** — users see SmartScreen. Adding the three
 WINDOWS_* secrets below turns signing on automatically; every signing step
 checks for its secret and skips when absent.

### macOS (sign + notarize)

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the **Developer ID Application** `.p12` (`openssl base64 -A -in cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `KEYCHAIN_PASSWORD` | any password for the CI keychain (throwaway) |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | Team ID from the developer account membership page |

Procedure: [Tauri: macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/).
All six must be present; the import step runs only when `APPLE_CERTIFICATE`
is, and notarization keys are simply read by Tauri at build time.

### Windows (sign)

| Secret | What it is |
| --- | --- |
| `WINDOWS_CERTIFICATE` | base64 of the code-signing `.pfx` (`certutil -encode cert.pfx out.txt`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | the `.pfx` password |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | cert thumbprint (certmgr → Details), hex, no spaces |

Procedure: [Tauri: Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/).
The thumbprint reaches the build via `tauri build --config` — nothing
secret-shaped is committed to `tauri.conf.json`.

## What CI covers

Every push and PR: lint, types, frontend tests, the vite bundle + size
budget, and Rust fmt/clippy/tests on **macOS, Linux, and Windows** (so
`#[cfg(windows)]` paths are compiled, not just trusted), a `cargo audit`
against the RustSec database, a gitleaks secret scan, and a drift check on
`THIRD-PARTY-NOTICES.md` (regenerate with `pnpm notices` after any lockfile
change).

Dependabot keeps actions, crates, and npm packages current weekly.
