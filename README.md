# 🫧 Blobbies

<p align="center">
  <img src="assets/blobbies.png" alt="Blobbies">
</p>

<p align="center">
  <strong>Your own team of AI helpers. Living on your computer.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/blobbies/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/blobbies?style=for-the-badge&label=Download&color=brightgreen" alt="Download the latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://github.com/KenKaiii/blobbies"><img src="https://img.shields.io/github/stars/KenKaiii/blobbies?style=for-the-badge&label=Stars&color=yellow" alt="Star Blobbies on GitHub"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

<p align="center">
  macOS · Windows · Linux — installers on the <a href="https://github.com/KenKaiii/blobbies/releases/latest">release page</a>; the app updates itself afterwards.
</p>

---

Little AI teammates called **Blobs**. You make them, name them, give them jobs — one for email, one for research, one that hypes you up before meetings.

They remember you, they do real work in your apps, and they run on your machine.

---

## ✨ What Blobs do

- **Remember you** — per-Blob memories plus team-wide facts. Every entry viewable, editable, deletable.
- **Do stuff in your apps** — Gmail, Calendar, Slack, Notion, Spotify. 942 apps in the catalog, connected through your own Composio account.
- **Work while you're away** — routines that run every N minutes, daily, weekly, or once. Desktop notification when done.
- **Team up** — up to 6 Blobs per group chat. @mention one, or ask the room and let them sort it out.
- **Make more Blobs** — a Blob can spawn, edit, message, and retire other Blobs.
- **Read your files** — PDFs, screenshots, photos. Text extraction and OCR run on your machine, in Rust, never uploaded.
- **Search and read the web** — DuckDuckGo Lite, falling back to Bing. No setup.
- **Run local commands** — allowlisted programs only, argv never a shell string, sandboxed to that Blob's folder.
- **Learn skills and MCP servers** — drop a folder in `~/.blobbies/skills/`; connect loopback MCP servers for more tools.

---

## 🔒 Two AI paths. That's it.

Most AI apps need everything — inbox, docs, calendar — shipped to a server you can't audit, kept for as long as their policy says today. Blobbies allows exactly two model paths:

| | **Local (Ollama)** | **Tinfoil** |
| --- | --- | --- |
| Where it runs | Your CPU/GPU | Cloud, inside a secure enclave |
| Cost | Free | Your own API key, usage-based |
| Works offline | Yes | No |
| Brains | Limited by your hardware | Frontier open-weight models |
| Who can read your prompt | You | Only the enclave — verified, not promised |

No OpenAI, no Anthropic, no OpenRouter — and it isn't a policy, it's the build. The Anthropic SDK is stubbed out (`src/lib/anthropic-stub.ts`) and the webview's `connect-src` allows four network origins and no others: `*.tinfoil.sh`, Sigstore's CDN, and Ollama on `localhost:11434` / `127.0.0.1:11434`. Adding a provider means editing `tauri.conf.json`, in public, in a fork.

### Why Tinfoil and not a normal provider

Every mainstream provider offers a **promise**: a privacy policy, a retention toggle, a "we don't train on API data" line. You cannot check any of it. Tinfoil replaces the promise with a check your machine performs before each connection:

1. **Runs in a hardware enclave (TEE).** Model and inference server sit in AMD SEV-SNP confidential compute. Memory is encrypted by the CPU, so the host operator — Tinfoil included — sees ciphertext, not your prompt.
2. **Attested before the first byte leaves.** The `tinfoil` SDK pulls the enclave's hardware attestation and matches its measurement against the published open-source build, recorded in a Sigstore transparency log. Mismatch → the request never sends.
3. **Encrypted to the enclave, not to a server.** Bodies are HPKE-encrypted on your device (EHBP) and decrypt only inside the enclave. A TLS terminator or proxy in front of it sees nothing useful.
4. **Open models, OpenAI-compatible API.** No closed weights, no lock-in.
5. **Your key, your bill.** Blobbies has no backend, no proxy, no account of yours to leak.

**Where the trust actually sits, honestly:** you're trusting AMD's hardware root of trust, and attestation proves the *published* code ran — it doesn't audit what that code does. A much smaller trust footprint than a policy page. Not zero. Check it yourself: [Tinfoil's verification docs](https://docs.tinfoil.sh/verification/verification-in-tinfoil), the [client SDK that does the attesting](https://github.com/tinfoilsh/tinfoil-js), and the [encrypted-body protocol](https://github.com/tinfoilsh/encrypted-http-body-protocol) — all open source.

### Where your data goes

| Data | Where it lives / goes |
| --- | --- |
| Chats, memories, Blob configs, files | `~/.blobbies` on your disk. Nothing else. |
| API keys | OS keychain (Keychain / Credential Manager / Secret Service) — never a plain file |
| Prompts, on a local model | Nowhere. Your machine. |
| Prompts, on Tinfoil | Encrypted to an attested enclave, using your key |
| Plugin actions (Gmail, Slack, …) | Through **Composio's cloud, on your own Composio account**. That's how the connector works — it's the one path where app content leaves your machine, and it's opt-in per app. |
| Web search | Query goes to DuckDuckGo Lite, then Bing if that's blocked |
| Update checks | App version → GitHub Releases. Signed with a minisign key; you click to install. |
| Telemetry, analytics, crash reports | **None.** No account, no server of ours, nothing to opt out of. |

---

## ⚔️ Blobbies vs Grok Bot

Grok Bot is xAI's take on AI teammates: named Bots with jobs, on a cloud computer. In beta since 11 Aug 2026, and genuinely cool. Two things separate us — **it's open source, and your data doesn't go to an AI company.** Everything else is detail:

|  | 🫧 **Blobbies** | **Grok Bot** |
| --- | --- | --- |
| **Source code** | Open, AGPL-3.0 — read it, fork it, verify these claims | Closed |
| **Price** | Free. Local models cost nothing; Tinfoil is your own key | No standalone plan. $300/mo SuperGrok Heavy, $200/mo Cursor Ultra, or $120/seat Premium Teams — plus metered usage past a weekly allowance |
| **Runs on** | Your computer | xAI's cloud VM |
| **Where your data sits** | `~/.blobbies` on your disk | xAI's cloud — required, not a setting |
| **Private by default** | Yes, architecturally: no server exists to send it to | No — Privacy Mode (Legacy) blocks the product entirely |
| **Works offline** | Yes, with a local model | No |
| **The AI** | Local models, or open models in attested enclaves | Grok models only, no model picker |
| **Memory** | Per-Blob plus team-wide, every entry viewable and editable | Bots keep memory, files, and logins across turns |
| **Team chats** | Up to 6 Blobs per group, @mention who you want | Bots message each other and hand off tasks |
| **Your apps** | 942 in the catalog, one browser sign-in each | Plugins for supported services, plus Bots signing into websites themselves |
| **Works while you're away** | Yes, on your machine — so your machine has to be on | Yes, in the cloud — genuinely always-on |
| **Platforms** | macOS, Windows, Linux | macOS, Windows, iOS — no Linux |

Grok Bot facts from [x.ai/bot](https://x.ai/bot) and xAI's docs, checked 22 Aug 2026. It's a beta; expect change.

**Fair is fair.** Grok Bots get a real screen on a cloud computer and drive any website like a person would, around the clock, whether your laptop is open or not. Blobbies can't do that and isn't trying to. What it does instead: costs nothing, runs where you can see it, and ships its whole source so "private" is something you check rather than something you're told.

---

## 🚀 Get it

Installers on the [latest release](https://github.com/KenKaiii/blobbies/releases/latest) — macOS (Apple Silicon + Intel `.dmg`), Windows (`.exe`), Linux x86_64 (`.deb` + AppImage). The app checks GitHub for updates and installs them when you click. Windows builds are unsigned, so SmartScreen will warn.

Then pick a brain in **Settings → Model**:

- **Free, offline** — install [Ollama](https://ollama.com), pull a model, done. Blobbies finds it on `localhost:11434`.
- **Bigger brain** — paste a [Tinfoil API key](https://tinfoil.sh). It goes to your OS keychain, not a file.

---

## 👥 Come hang out

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) — tutorials and demos
- [Skool community](https://skool.com/kenkai)

---

## 👨‍💻 For devs

**Requirements:** Node ≥ 22.12, pnpm 10 (`corepack enable`), Rust 1.90 (auto-installed from `rust-toolchain.toml`), plus the per-OS [Tauri platform deps](https://tauri.app/start/prerequisites/):

- **macOS** — Xcode command line tools: `xcode-select --install`
- **Linux** (Debian/Ubuntu) — `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`, plus a Secret Service provider (`gnome-keyring` on GNOME, KWallet on KDE). The Tinfoil API key lives in the OS keychain; without a provider running, saving it fails with a D-Bus error.
- **Windows** — Visual Studio 2022 Build Tools with the **Desktop development with C++** workload (WebView2 ships with Windows 10/11).

```bash
git clone https://github.com/KenKaiii/blobbies.git
cd blobbies
pnpm install
cp .env.example .env.local   # optional: add a TINFOIL_API_KEY for dev
pnpm tauri:dev   # loads .env.local on every OS
```

```bash
pnpm tauri:build   # production bundle (dmg / deb+AppImage / NSIS exe)
pnpm check         # everything CI runs: lint, types, tests, clippy
```

**Platform quirks, so nothing surprises you:** The connector CLI's installer is a POSIX shell script, so on Windows it needs [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) — the in-app install button hides itself there and the Plugins tab explains. A Blob's shell tools (`ls`, `cat`, `grep`, …) are POSIX binaries that mostly don't exist on Windows, so those commands fail with "not found" there. CI compiles and tests the Rust side on macOS, Linux, and Windows on every push, and a [release workflow](.github/workflows/release.yml) builds the installers for all three.

---

## 📄 Licence and trademarks

AGPL-3.0. Use it, change it, run it for yourself. Run a modified version as a service for others — share your changes. Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

App logos in `public/logos` are trademarks of their owners, shown only to identify the matching integration. Blobbies isn't affiliated with any of them.

---

<p align="center">
  <strong>Your stuff stays yours. Your team does the rest.</strong>
</p>
