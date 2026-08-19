# 🫧 Blobbies

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Blobbies" width="160">
</p>

<p align="center">
  <strong>Your own team of AI helpers. Living on your computer.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://img.shields.io/badge/Price-Free-brightgreen?style=for-the-badge"><img src="https://img.shields.io/badge/Price-Free-brightgreen?style=for-the-badge" alt="Free"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

---

Blobbies gives you little AI teammates called Blobs. You make them, name them, and give them jobs. One for email. One for research. One that just hypes you up before big meetings.

They remember everything you tell them. They do actual work in your apps. And all of it runs on your machine, not on somebody's server.

No account. No cloud. No "we updated our privacy policy" emails.

---

## ✨ What your Blobs can do

### They remember you

Every Blob keeps its own memories, plus facts you share with the whole team. Tell your email Blob you hate Monday meetings once and it remembers for good. You can see, edit, and delete every single memory. It's your brain, you're in charge of it.

### They actually do stuff

Blobs plug into your apps. Gmail, Google Calendar, Slack, Notion, Spotify, hundreds more through Composio (an app-connecting service, your own account). "Clear my inbox and flag anything urgent" is a real request, not a demo.

### They work while you're away

Give a Blob a routine, like "every morning at 8, summarize my calendar and the news I care about". It runs on schedule, on your computer, and sends you a notification when it's done.

### They team up

Put up to six Blobs in one group chat. @mention the one you want, or ask the room and let them sort out who answers. They hand work to each other. You just watch it happen.

### They read your files

Drop in PDFs, screenshots, photos, notes, whatever. Text gets pulled out right on your machine, even from scanned PDFs and images. Nothing gets uploaded anywhere.

### They search the web

Blobs can search and read web pages when they need facts. Built in, no extra setup.

### Talk, don't type

Hit the mic and dictate. Way faster than typing, and the Blob never judges your spelling. It can't. That's the whole point of a Blob.

---

## 🔒 Your stuff stays yours

This is the whole point of Blobbies.

- **Everything lives on your computer**, in one folder you can find, back up, or delete whenever.
- **Zero telemetry.** No analytics, no crash reports, no phoning home. Ever. It's not in the app.
- **Two ways to run the AI, both private:**
  - **Local** (Ollama): the AI runs on your machine. Your words never leave it. Works fully offline.
  - **Tinfoil** (optional): cloud models locked inside end-to-end encrypted, hardware-verified enclaves. Even the company running them can't read your stuff.
- **Secrets go in your system keychain**, never in a plain file.
- **Deleting a Blob is a real delete.** It sits in a trash folder for 30 days in case you change your mind, then it's gone, memories and all.

---

## ⚔️ Blobbies vs Grok Bot

Grok Bot is xAI's take on AI teammates: named Bots with jobs that work on a cloud computer. It shipped in August 2026 and it's genuinely cool. Here's the honest difference:

|  | 🫧 **Blobbies** | **Grok Bot** |
| --- | --- | --- |
| **Price** | Free, open source | Top tiers only: SuperGrok Heavy ($300/mo) or Cursor Ultra ($200/mo) |
| **Runs on** | Your computer | xAI's cloud |
| **Your data** | Stays on your machine | Lives on a shared cloud computer |
| **Works offline** | Yes, with a local model | No, it needs the cloud |
| **The AI** | Your pick: free local models or Tinfoil's encrypted cloud | Grok models only |
| **Memory** | Per-Blob plus team-wide, all viewable and editable | Bots keep memory, files, and logins across turns |
| **Team chats** | Up to 6 Blobs per group, @mention who you want | Bots message each other and hand off tasks |
| **Your apps** | Hundreds via your own Composio account | Bots sign into your apps themselves, plus connectors |
| **Works while you're away** | Yes, on your machine | Yes, in the cloud |
| **Platforms** | macOS, Windows, Linux | macOS, Windows, iOS (no Linux) |
| **Source code** | Open, AGPL-3.0 | Closed |

Grok Bot facts are from xAI's own docs and pricing, August 2026. It's a beta, so expect change.

Fair is fair: Grok Bot's Bots each get a screen on a shared cloud computer and can use any website like a person would. If you're already deep in that world and want always-on cloud muscle, it rocks. Blobbies is for everyone who'd rather keep it local, private, and free.

---

## 🚀 Get it

Installers are on the way. Until then, anyone comfortable with a terminal can build it in a few minutes, setup steps at the bottom of this page.

---

## 👥 Come hang out

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai), tutorials and demos
- [Skool community](https://skool.com/kenkai), come hang out

---

## 👨‍💻 For devs

Setup steps, that's it:

**Requirements:** Node ≥ 22.12, pnpm 10 (`corepack enable`), Rust 1.90 (auto-installed from `rust-toolchain.toml`), plus the [Tauri platform deps](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/KenKaiii/blobbies.git
cd blobbies
pnpm install
cp .env.example .env.local   # optional: add a TINFOIL_API_KEY for dev
pnpm tauri:dev
```

```bash
pnpm tauri:build   # production bundle
pnpm check         # everything CI runs: lint, types, tests, clippy
```

---

## 📄 Licence and trademarks

AGPL-3.0. Use it, change it, run it for yourself. If you run a modified version as a service other people use, share your changes. Third-party notices live in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

App logos in `public/logos` are trademarks of their respective owners, shown only to identify the matching integration. Blobbies is not affiliated with any of them.

---

<p align="center">
  <strong>One AI is a chatbot. A team of them is a superpower.</strong>
</p>
