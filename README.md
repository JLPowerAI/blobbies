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
  macOS · Windows · Linux. Installers on the <a href="https://github.com/KenKaiii/blobbies/releases/latest">release page</a>; the app updates itself afterwards.
</p>

---

Little AI teammates called **Blobs**. You make them, name them, give them jobs: one for email, one for research, one that hypes you up before meetings.

They remember you, they do real work in your apps, and **your data never reaches an AI company.**

---

## 🚨 The mistake almost everyone is making

People are connecting Gmail, Drive, Slack and Notion to AI agents at speed. Almost nobody asks the one question that matters:

> When the agent reads my email, **where does the text of that email go?**

To an AI provider. Not a summary, not metadata. **The actual words**, in plaintext, on someone else's servers, because that is the only way a model can read anything.

**Using an AI to write code is a different bet.** A repo is bounded, usually replaceable, and you chose what went in it. Your inbox is not:

- Every password reset and account recovery link you have ever been sent
- Contracts, invoices, tax documents, bank mail
- Medical results, legal threads, family arguments
- Every private thing someone told you and only you

Connect an agent to that and you have handed a company **your identity's master key**, in one OAuth click, for a to-do list summary.

### "But it has zero data retention"

ZDR is a promise about what happens *after* they receive it. The receiving already happened. Four things stay true:

**1. It gets decrypted on their machines.** Not persisted never meant not processed. Your email is plaintext in their RAM either way.

**2. It usually gets logged first.** OpenAI's documented default: abuse-monitoring logs on all API usage, kept up to 30 days. Exclusion needs their prior approval, so it is an enterprise carve-out, not your default. ([data controls](https://developers.openai.com/api/docs/guides/your-data))

**3. Someone who isn't you can reverse it.** In the NYT copyright case a federal court ordered OpenAI to preserve output logs that would normally have been deleted, including conversations users had deleted themselves. True zero-retention endpoints were exempt for one reason: **there was nothing to preserve.**

**4. Policy can revoke it.** On 9 June 2026 Anthropic began retaining prompts and outputs for 30 days on covered models, including for organizations that had ZDR configured. Yesterday's guarantee, gone by announcement. ([their notice](https://support.claude.com/en/articles/15425996-data-retention-practices-for-covered-models))

**ZDR is a receipt, not a lock.** The only data that cannot be logged, subpoenaed, breached, or re-scoped by a policy update is data they never received.

---

## ✅ The two ways out

Blobbies allows exactly two model paths and refuses everything else at the build level:

| | **Local (Ollama)** | **Tinfoil** |
| --- | --- | --- |
| Where it runs | Your CPU/GPU | Cloud, inside a hardware enclave |
| Cost | **Free** | Your own API key, usage-based |
| Works offline | Yes | No |
| Brains | Capped by your hardware | Frontier open-weight models |
| Who can read your prompt | You | Nobody. **Verified, not promised** |

**Path 1, local.** The model runs on your machine. Your email is read by software you own, on hardware you own. Nothing to trust, nothing to leak. Free forever, works on a plane. Your GPU is the ceiling.

**Path 2, Tinfoil.** When you need a frontier model, this is the safest option I could find that still gives real power. The one cloud that doesn't ask you to take its word.

### Why Tinfoil specifically

Every mainstream provider offers a **promise**: a policy page, a retention toggle, a "we don't train on API data" line. You cannot check any of it from outside. Tinfoil replaces the promise with a **check your machine runs before each connection:**

1. **Hardware enclave (TEE).** The model sits in AMD SEV-SNP confidential compute. The CPU encrypts memory itself, so the host operator, Tinfoil included, sees ciphertext where your prompt should be. They cannot read it if they want to, or if compelled.
2. **Attested before the first byte leaves.** The SDK fetches the enclave's hardware attestation and matches its measurement against the published open-source build, recorded in a Sigstore transparency log. Mismatch means **your request is never sent.**
3. **Encrypted to the enclave, not to a company.** Bodies are HPKE-encrypted on your device and decrypt only inside the enclave. A proxy or TLS terminator in front sees nothing usable.
4. **Open models, open protocol.** No closed weights, OpenAI-compatible API, no lock-in.
5. **Your key, your bill.** Blobbies has no backend and no account, so there is no server of ours to breach.

In one line: **other providers ask you to trust a policy. Tinfoil lets you verify a machine.** Subpoena Tinfoil, you get ciphertext. Subpoena a normal provider, you get your inbox.

**Where the trust sits, honestly:** you are trusting AMD's hardware root of trust, and attestation proves the *published* code ran, not that the code is harmless. Far smaller than a policy page. Not zero. Check it yourself: [verification docs](https://docs.tinfoil.sh/verification/verification-in-tinfoil), [the client SDK that attests](https://github.com/tinfoilsh/tinfoil-js), [the encrypted-body protocol](https://github.com/tinfoilsh/encrypted-http-body-protocol).

### Not a policy. The build.

No OpenAI, no Anthropic, no OpenRouter. The Anthropic SDK is stubbed out (`src/lib/anthropic-stub.ts`) and the webview's `connect-src` allows **four network origins and no others**: `*.tinfoil.sh`, Sigstore's CDN, and Ollama on `localhost:11434` / `127.0.0.1:11434`. Adding a provider means editing `tauri.conf.json`, in public, in a fork, where you would see it.

---

## 💸 And it costs nothing

Privacy shouldn't be a thing only people with $200/month can buy.

| | Monthly |
| --- | --- |
| **Blobbies + a local model** | **$0** |
| **Blobbies + Tinfoil** | Your own key, pay per use |
| Grok Bot (cheapest) | $120/seat Premium Teams |
| Grok Bot (solo) | $200 Cursor Ultra, or $300 SuperGrok Heavy |

Free and private are not supposed to be a trade. Here they are the same choice.

---

## ✨ What Blobs do

- **Remember you.** Per-Blob memories plus team-wide facts. Every entry viewable, editable, deletable.
- **Do stuff in your apps.** Gmail, Calendar, Slack, Notion, Spotify. 942 apps in the catalog, through your own Composio account.
- **Work while you're away.** Routines every N minutes, daily, weekly, or once. Desktop notification when done.
- **Team up.** Up to 6 Blobs per group chat. @mention one, or ask the room and let them sort it out.
- **Make more Blobs.** A Blob can spawn, edit, message and retire other Blobs.
- **Read your files.** PDFs, screenshots, photos. Text extraction and OCR run on your machine, in Rust, never uploaded.
- **Search and read the web.** DuckDuckGo Lite, falling back to Bing. No setup.
- **Run local commands.** Allowlisted programs only, argv never a shell string, sandboxed to that Blob's folder.
- **Learn skills and MCP servers.** Drop a folder in `~/.blobbies/skills/`, or connect loopback MCP servers for more tools.

---

## 📍 Where your data goes

| Data | Where it lives / goes |
| --- | --- |
| Chats, memories, Blob configs, files | `~/.blobbies` on your disk. Nothing else. |
| API keys | OS keychain (Keychain / Credential Manager / Secret Service), never a plain file |
| Prompts, on a local model | Nowhere. Your machine. |
| Prompts, on Tinfoil | Encrypted to an attested enclave, using your key |
| Plugin actions (Gmail, Slack, …) | Through **Composio's cloud, on your own Composio account**. See below. |
| Web search | Query goes to DuckDuckGo Lite, then Bing if that's blocked |
| Update checks | App version → GitHub Releases. Signed with a minisign key; you click to install. |
| Telemetry, analytics, crash reports | **None.** No account, no server of ours, nothing to opt out of. |

**The honest caveat, stated plainly:** connecting Gmail or Slack routes those API calls through Composio's cloud on your own account. That's how the connector works, and it's the one path where app content leaves your machine. It is a **transit** hop, not a model host: the email body lands on your disk and is read by your local model or your enclave. It is never handed to an AI provider, which is the specific thing this app exists to prevent. Want zero third parties? Skip plugins and use files, web search and local commands; everything else still works.

---

## ⚔️ Blobbies vs Grok Bot

Grok Bot is xAI's take on AI teammates: named Bots with jobs, on a cloud computer. In beta since 11 Aug 2026, and genuinely capable. It is also the clearest example of the trade this README is about, because your tools, logins and data live on their machine by design:

|  | 🫧 **Blobbies** | **Grok Bot** |
| --- | --- | --- |
| **Source code** | Open, AGPL-3.0. Read it, fork it, verify these claims | Closed |
| **Price** | Free, or your own Tinfoil key | $120/seat Premium Teams, $200 Cursor Ultra, $300 SuperGrok Heavy, plus metered usage past a weekly allowance |
| **Runs on** | Your computer | xAI's cloud VM |
| **Where your data sits** | `~/.blobbies` on your disk | xAI's cloud. Required, not a setting |
| **Private by default** | Yes, architecturally: no server exists to send it to | No. Privacy Mode (Legacy) blocks the product entirely |
| **Works offline** | Yes, with a local model | No |
| **The AI** | Local models, or open models in attested enclaves | Grok models only, no model picker |
| **Memory** | Per-Blob plus team-wide, every entry viewable and editable | Bots keep memory, files, and logins across turns |
| **Team chats** | Up to 6 Blobs per group, @mention who you want | Bots message each other and hand off tasks |
| **Your apps** | 942 in the catalog, one browser sign-in each | Plugins for supported services, plus Bots signing into websites themselves |
| **Works while you're away** | Yes, on your machine, so your machine has to be on | Yes, in the cloud, genuinely always-on |
| **Platforms** | macOS, Windows, Linux | macOS, Windows, iOS. No Linux |

Grok Bot facts from [x.ai/bot](https://x.ai/bot) and xAI's docs, checked 22 Aug 2026. It's a beta; expect change.

**Fair is fair.** Grok Bots get a real screen on a cloud computer and drive any website like a person would, around the clock, whether your laptop is open or not. Blobbies can't do that and isn't trying to. What it does instead: costs nothing, runs where you can see it, and ships its whole source, so "private" is something you check rather than something you're told.

---

## 🚀 Get it

Installers on the [latest release](https://github.com/KenKaiii/blobbies/releases/latest): macOS (Apple Silicon + Intel `.dmg`), Windows (`.exe`), Linux x86_64 (`.deb` + AppImage). The app checks GitHub for updates and installs them when you click. Windows builds are unsigned, so SmartScreen will warn.

Then pick a brain in **Settings → Model**:

- **Free, offline.** Install [Ollama](https://ollama.com), pull a model, done. Blobbies finds it on `localhost:11434`.
- **Bigger brain.** Paste a [Tinfoil API key](https://tinfoil.sh). It goes to your OS keychain, not a file.

---

## 👥 Come hang out

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai), tutorials and demos
- [Skool community](https://skool.com/kenkai)

---

## 👨‍💻 For devs

**Requirements:** Node ≥ 22.12, pnpm 10 (`corepack enable`), Rust 1.90 (auto-installed from `rust-toolchain.toml`), plus the per-OS [Tauri platform deps](https://tauri.app/start/prerequisites/):

- **macOS**: Xcode command line tools, `xcode-select --install`
- **Linux** (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`, plus a Secret Service provider (`gnome-keyring` on GNOME, KWallet on KDE). The Tinfoil API key lives in the OS keychain; without a provider running, saving it fails with a D-Bus error.
- **Windows**: Visual Studio 2022 Build Tools with the **Desktop development with C++** workload (WebView2 ships with Windows 10/11).

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

**Platform quirks, so nothing surprises you:** The connector CLI's installer is a POSIX shell script, so on Windows it needs [WSL](https://learn.microsoft.com/en-us/windows/wsl/install). The in-app install button hides itself there, and the Plugins tab explains. A Blob's shell tools (`ls`, `cat`, `grep`, …) are POSIX binaries that mostly don't exist on Windows, so those commands fail with "not found" there. CI compiles and tests the Rust side on macOS, Linux, and Windows on every push, and a [release workflow](.github/workflows/release.yml) builds the installers for all three.

---

## 📄 Licence and trademarks

AGPL-3.0. Use it, change it, run it for yourself. Run a modified version as a service for others, and share your changes. Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

App logos in `public/logos` are trademarks of their owners, shown only to identify the matching integration. Blobbies isn't affiliated with any of them.

---

<p align="center">
  <strong>Your stuff stays yours. Your team does the rest.</strong>
</p>
