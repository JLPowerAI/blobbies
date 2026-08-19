# Compliance Register

Snapshot: 2026-08-19 · Reviewed by: GG Coder compliance-guard · **NOT LEGAL ADVICE**
Commit at review time: see `git log -1` when this file landed.

Product: Blobbies — free, open-source (AGPL-3.0-only), local-first Tauri 2 desktop
app. No server, no accounts, no payments, no telemetry. Distributed as source at
<https://github.com/KenKaiii/blobbies>.

## Assumed exposure profile

| Dimension | Value | Status |
| --- | --- | --- |
| Reach | Public source repo; anyone can build; no hosted service | Confirmed |
| Money | None — no payments, subscriptions, or balances | Confirmed |
| Personal data held by the project | None — no server, no accounts, no telemetry | Confirmed (grep + CSP) |
| User data in the app | Conversations, memories, files — all local in `~/.blobbies` | Confirmed |
| Third parties the app can call | Tinfoil (inference, user's key), local Ollama, Composio (user's own CLI account), Sigstore CDN | Confirmed (CSP + code) |
| Minors | No age gate; developer tool with no data collection | Assumed n/a |
| Entity | Individual maintainer, no company | Assumed |

If any of these change — hosted service, accounts, payments, telemetry — re-run
the review; most rows below flip at that point.

## Coverage ledger

Security baseline (pre-deploy blockers) — no server, no database, no accounts, so
most rows are structural n/a for this architecture:

| # | Checklist item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Secrets in repo/client/history | pass | gitleaks full-history in CI (CODE); `git log -S` scan clean (RUNTIME); `.env.*` gitignored, only `.env.example` tracked; API key in OS keychain |
| 2 | DB row-level security | n/a | no database; all state is local files |
| 3 | Service-role key reachable from client | n/a | no server-side keys exist |
| 4 | Object-level authorization server-side | n/a | single-user local app; webview→Rust IPC is the only boundary and it validates inputs (`commands.rs`) |
| 4a | Defaults that grant instead of deny | pass | capabilities are allowlists; shell is default-deny with user prompt; CSP `default-src 'self'` |
| 4b | Tenant isolation from client input | n/a | no multi-tenant anything |
| 5 | Mass assignment | n/a | no server records |
| 6 | String-built queries | n/a | no DB; shell uses literal argv, metacharacter test exists |
| 7 | Unauthenticated internal endpoints | n/a | app exposes no network endpoints; it is a client only |
| 8 | Public storage buckets | n/a | none |
| 9 | Rate limits on expensive endpoints | n/a | no shared endpoints; model spend is the user's own key |
| 10 | Password hashing | n/a | no passwords |
| 11 | Session cookies/token storage | n/a | no sessions; secrets in OS keychain, not localStorage |
| 12 | JWT verification | n/a | none |
| 13 | CORS \* + credentials | n/a | no web server |
| 14 | Card data in systems | n/a | no payments |
| 14b | Financial/identity columns | n/a | none |
| 15 | PII in logs/error trackers | n/a | no error tracker or central logs (grep-verified); local conversation files are the user's own |
| 16 | Transport security | pass | CSP allows `https:` + loopback `http:` (local Ollama/MCP only); no plaintext remote calls |
| 17 | SSRF via user-supplied URL | pass | capability layer denies private/link-local ranges for https; `mcp.ts` re-checks; tests cover redirect/lookalike attacks (`169.254.169.254`, `dashboard.composio.dev.evil.test` fixtures) |
| 18 | Backup / restore | n/a (backlog) | local-only data by design; see F6 |

Universal trigger rows:

| Item | Status | Evidence |
| --- | --- | --- |
| Privacy notice / lawful basis | n/a | project collects no personal data; app-level data flows documented in README "Where your data goes" |
| Third-party scripts on public page | n/a | no marketing site; no tags anywhere (grep) |
| Accounts/login | n/a | none |
| Public web UI accessibility | pass (after fixes) | desktop app, not a web page; WCAG defects found and fixed — see a11y rows |
| Email sending | n/a | none |
| Contact/support form | n/a | GitHub issues only |
| Error tracking | n/a | none installed |
| No entity / personal liability | lawyer (optional) | L1 |

Accessibility (static review of source; **not** a substitute for a manual
screen-reader/keyboard pass):

| Item | Status | Evidence |
| --- | --- | --- |
| Image alternatives | pass | all three real `<img>` elements carry `alt`; decorative logo tiles use `alt=""` + `aria-hidden` parent |
| Form labels | pass | 15 `<label>`/10 `htmlFor` pairs, 91 `aria-label`s (CODE) |
| Keyboard operability | pass (static) | zero `div onClick`; menus/dialogs use roles; 21 focus rules (CODE — manual pass not run) |
| Colour contrast | pass (after fix) | computed from source literals; two defects fixed (F3) |
| Focus visibility | pass (static) | `:focus`/`:focus-visible` styled throughout (CODE) |
| Media controls/captions | n/a | no audio/video elements |
| Page language | pass | `lang="en"` in `index.html` |

Mandatory status rows:

| Duty | Status | Reason |
| --- | --- | --- |
| Minors (COPPA/GDPR-K) | n/a | no collection by the project, no accounts, no child-directed design; **revisit immediately if a hosted service is added** |
| Consumer contract duties (US/EU) | n/a | nothing is sold |
| Platform/intermediary duties (DSA/DMCA/OSA) | n/a | no user content is hosted by the project |
| Money movement | n/a | none |

## Findings

| ID | Severity | Trigger | Evidence | Obligation | Status | Guard |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | MEDIUM→mitigated | 942 third-party brand logos redistributed in repo/binary | RUNTIME (`ls public/logos`) | Trademark nominative-use best practice: disclaim affiliation | Fixed: README "Trademarks" + notices header | — |
| F2 | MEDIUM→fixed | MIT/Apache/BSD require shipping notices when binaries are distributed | CODE (license fields of installed tree) | Include third-party notices with distributions | Fixed: `THIRD-PARTY-NOTICES.md` + `scripts/generate-notices.mjs` | CI drift check added |
| F3 | MEDIUM→fixed | WCAG AA contrast: white-on-accent pill 3.65/2.8:1; light warning dot 2.95:1 | CODE (computed from `App.css` literals) | 4.5:1 text, 3:1 non-text | Fixed in `App.css` with ratios in comments | Values documented inline; add a contrast unit test if the palette churns |
| F4 | LOW | AI chat surface (EU AI Act Art 50(1), US state chatbot laws) | CODE (onboarding copy) | Deployer discloses AI interaction | n/a-grade: product is explicitly an AI assistant the user configures; deployer is the end user | Revisit if a hosted/marketing surface appears |
| F5 | BACKLOG | Binary releases (when published) | DEDUCED (no releases yet) | SBOM + embed full Apache-2.0/MPL-2.0 texts in release artifacts; sign binaries | Open | Upgrade path in generate-notices |
| F6 | BACKLOG | User data durability | CODE (`store.rs`, local-only) | No duty for the project; consider document/export tooling as users accumulate local histories | Open | — |

No ILLEGAL or BLOCKER findings. Nothing in the product touches regulated
domains (health, finance, gambling, biometrics, minors' education, etc.); no
licensing gate applies.

## Implemented in this pass

- `THIRD-PARTY-NOTICES.md` — 144 npm + 553 crate attributions, generated from
  the installed tree (not from memory), with the generator failing on any
  UNKNOWN license and excluding os/cpu-tagged platform binaries so the file
  is identical on macOS and the Linux CI that verifies it.
- `scripts/generate-notices.mjs` — regenerates the above; exit 1 on
  unattributable dependencies.
- CI (`audit` job): notices regeneration must match the committed file, so a
  dependency change that isn't re-attributed fails the build.
- README: "Where your data goes" (local-first, no telemetry, per-vendor data
  flows) and "Trademarks" sections; license section links the notices file.
- `App.css`: two WCAG AA contrast fixes (`.new-messages-pill > button`
  background `#0a72d8`; light-theme `--status-warn` `#a87400`, ≥3:1 against
  the darkest light surface `#e9e9ec`).

## Open — needs a decision from you

1. Publish binary releases? Then F5 (SBOM, license texts in artifacts,
   code-signing) becomes real before the first release.
2. "Blobbies" name clearance: not checked here; a quick trademark search in
   your target markets is cheap insurance if the project grows.

## Needs a lawyer

- L1 (optional, not urgent): individual maintainer liability for a no-data,
   no-money OSS tool is minimal and the AGPL warranty disclaimer covers the
   code, but forming an entity is worth considering if the project takes
   sponsorships or a hosted component.

## Re-verify before relying (date-sensitive)

- Nothing date-critical asserted in this register. The AI Act Art 50 framing
  and US state chatbot-law landscape are as of the 2026-08 skill snapshot —
  re-check if a hosted surface is ever added.
- Re-run this review when: a server, accounts, telemetry, payments, or binary
  releases are added. This register's n/a rows assume their absence.
