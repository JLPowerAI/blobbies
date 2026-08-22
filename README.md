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

Little AI teammates called **Blobs**. Make one, name it, give it a job. One for email, one for research, one that hypes you up before meetings.

They remember you. They work in your apps. And **your data never touches an AI company.**

---

## 🚨 The mistake everyone is making

Everyone is plugging Gmail, Drive and Slack into AI agents right now. Nobody asks the one question that matters:

> Your agent reads your email. **Where does that email go?**

To an AI provider. Not a summary. The actual words, in plaintext, on their servers. That is the only way a model reads anything.

**Code is a different bet.** A repo is bounded and replaceable. Your inbox is not:

- Every password reset link you have ever been sent
- Contracts, invoices, tax docs, bank mail
- Medical results, legal threads, family arguments

That is your identity's master key. People hand it over in one OAuth click, for a to-do list summary.

### "But it has zero data retention"

ZDR describes what happens **after** they get your email. They still got it.

**It gets decrypted on their machines.** Not stored never meant not read.

**It usually gets logged first.** OpenAI's default is abuse-monitoring logs on all API usage, kept 30 days. Opting out needs their approval. ([docs](https://developers.openai.com/api/docs/guides/your-data))

**A judge can undo it.** In the NYT case a court ordered OpenAI to preserve logs it would normally have deleted, including chats users deleted themselves. True ZDR endpoints were exempt, because there was nothing to preserve.

**A policy update can kill it.** On 9 June 2026 Anthropic started keeping 30 days on covered models, including orgs that had ZDR switched on. ([their notice](https://support.claude.com/en/articles/15425996-data-retention-practices-for-covered-models))

**ZDR is a receipt, not a lock.** Data they never received cannot be logged, subpoenaed, breached, or re-scoped later.

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

**Path 1, local.** Runs on your machine. Your email gets read by software you own, on hardware you own. Nothing to trust, nothing to leak. Free forever, works on a plane. Your GPU is the ceiling.

**Path 2, Tinfoil.** Need a bigger brain? This is the safest option I could find that still gives real power. The one cloud that doesn't ask you to take its word.

### Why Tinfoil specifically

Everyone else offers a **promise**: a policy page, a retention toggle, a "we don't train on API data" line. You cannot check any of it from outside.

Tinfoil swaps the promise for a **check your own machine runs, before every connection:**

1. **Hardware enclave.** The model sits in AMD SEV-SNP confidential compute. The CPU encrypts memory itself, so the host operator, Tinfoil included, sees ciphertext where your prompt should be. They cannot read it if they want to, or if a court tells them to.
2. **Attested before a single byte leaves you.** Your machine fetches the enclave's hardware attestation and checks it against the published open-source build, logged in Sigstore. Mismatch means **the request never sends.**
3. **Encrypted to the enclave, not to a company.** Bodies are HPKE-encrypted on your device and only open inside the enclave. Anything sitting in front of it sees noise.
4. **Open models, open protocol.** No closed weights, no lock-in.
5. **Your key, your bill.** Blobbies has no backend and no account, so there is no server of ours to breach.

One line version: **everyone else asks you to trust a policy. Tinfoil lets you verify a machine.** Subpoena Tinfoil, you get ciphertext. Subpoena a normal provider, you get your inbox.

**Honest bit:** you are trusting AMD's hardware root of trust, and attestation proves the *published* code ran, not that the code is harmless. Way smaller than a policy page. Not zero. Check it yourself: [verification docs](https://docs.tinfoil.sh/verification/verification-in-tinfoil), [the SDK that attests](https://github.com/tinfoilsh/tinfoil-js), [the encrypted-body protocol](https://github.com/tinfoilsh/encrypted-http-body-protocol).

### Not a policy. The build.

No OpenAI, no Anthropic, no OpenRouter. The Anthropic SDK is stubbed out (`src/lib/anthropic-stub.ts`) and the webview's `connect-src` allows **four network origins and no others**: `*.tinfoil.sh`, Sigstore's CDN, and Ollama on `localhost:11434` / `127.0.0.1:11434`. Adding a provider means editing `tauri.conf.json`, in public, in a fork, where you would see it.

---

## 🧠 Pick the right brain (this is where people burn money)

Biggest myth going: you need the smartest model on earth to read your email.

You don't. Sorting an inbox is not a maths olympiad.

Tinfoil serves **DeepSeek V4 Flash**, **Kimi K3**, **GLM 5.2**, **gpt-oss-120b** and friends. Any of them handle "check my calendar, flag anything urgent, draft a reply" without breaking a sweat.

| The job | The brain |
| --- | --- |
| Email, calendar, Slack, notes, reminders | A local model, or a small Tinfoil one |
| Research, long documents, proper writing | Mid-size Tinfoil model |
| Full coding agent going all night | Sure, go big. That is not this app |

This is not "use the weakest thing you can find". It is: **match the model to the task.** Today's mid-size open models are genuinely good.

Point a frontier model at labelling emails and you are renting a Ferrari for the school run. Works fine. Still daft. And your credit burns in a week.

---

## 💸 What it actually costs

| | Monthly |
| --- | --- |
| **Blobbies + local model** | **$0.** Forever. |
| **Blobbies + Tinfoil** | Roughly **$10 to $20** for normal use, on your own key |
| Grok Bot (cheapest) | $120/seat Premium Teams |
| Grok Bot (solo) | $200 Cursor Ultra, or $300 SuperGrok Heavy |

Privacy shouldn't be a thing only people with $200/month can buy.

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

**One honest caveat.** Connecting Gmail or Slack routes those API calls through Composio's cloud, on your own account. That is how the connector works, and it is the single path where app content leaves your machine.

It is a **transit** hop, not a model host. The email body lands on your disk and gets read by your local model or your enclave. It never goes to an AI provider, which is the exact thing this app exists to stop.

Want zero third parties? Skip plugins. Files, web search and local commands all still work.

---

## ⚔️ Blobbies vs Grok Bot

xAI's take on AI teammates: named Bots with jobs, on a cloud computer. In beta since 11 Aug 2026, and genuinely capable. It is also the clearest example of the trade this README is about, because your tools, logins and data live on their machine by design.

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
| **Works while you're away** | Yes, on your machine. Cloud runners are on the roadmap | Yes, on their cloud VM |
| **Platforms** | macOS, Windows, Linux | macOS, Windows, iOS. No Linux |

Grok Bot facts from [x.ai/bot](https://x.ai/bot) and xAI's docs, checked 22 Aug 2026. It's a beta; expect change.

**Fair is fair.** Grok Bots have a cloud computer, so they keep working with your laptop shut. Handy. Blobbies runs on your machine today, which means routines fire while it is on.

That is a deliberate starting point, not a wall. Renting a box to run Blobs around the clock is a normal thing to add, and it is on the roadmap. The bit that is hard to bolt on later is the part we built first: no server of ours holding your data, and no AI provider reading it.

Cheaper, open source, and private by construction. The always-on part is just scheduling.

---

## 🚀 Get it

Grab it from the [latest release](https://github.com/KenKaiii/blobbies/releases/latest): macOS (Apple Silicon + Intel `.dmg`), Windows (`.exe`), Linux x86_64 (`.deb` + AppImage). It updates itself after that.

Windows builds are unsigned, so SmartScreen will grumble at you.

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

**Platform quirks, so nothing surprises you:**

- The connector CLI's installer is a POSIX shell script, so Windows needs [WSL](https://learn.microsoft.com/en-us/windows/wsl/install). The in-app install button hides itself there, and the Plugins tab explains why.
- A Blob's file readers (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`) are implemented inside the app in Rust, not spawned, so they behave the same on all three platforms and need nothing installed.
- CI compiles and tests the Rust side on macOS, Linux and Windows every push. A [release workflow](.github/workflows/release.yml) builds installers for all three.

---

## 📄 Licence and trademarks

AGPL-3.0. Use it, change it, run it for yourself. Run a modified version as a service for others, and share your changes. Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

App logos in `public/logos` are trademarks of their owners, shown only to identify the matching integration. Blobbies isn't affiliated with any of them.

---

<p align="center">
  <strong>Your stuff stays yours. Your team does the rest.</strong>
</p>
