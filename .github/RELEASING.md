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

## Signing (optional secrets)

Without secrets everything still builds and releases — unsigned. macOS users
see Gatekeeper ("right-click → Open" the first time); Windows shows
SmartScreen. Adding a secret to
[Settings → Secrets and variables → Actions](https://github.com/KenKaiii/blobbies/settings/secrets/actions)
turns the matching behavior on automatically; every signing step checks for
its secret and skips when absent.

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
