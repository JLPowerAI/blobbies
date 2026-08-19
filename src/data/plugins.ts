/**
 * The app catalog, keyed by Composio toolkit slug.
 *
 * Two rules decide what may appear here, and both are load-bearing:
 *
 * 1. **`id` is the Composio slug, verbatim.** It is passed to `composio link`
 *    as argv, and the Rust side refuses anything outside `[a-z0-9_]`. The
 *    hyphenated ids this catalog used to carry (`google-calendar`,
 *    `google-drive`, `apollo-io`) are not slugs, so every one of those tiles
 *    answered "That is not a valid app name." The real ones are
 *    `googlecalendar`, `googledrive` and `apollo`.
 *
 * 2. **Composio must be able to finish the connect on its own.** Measured
 *    against the CLI: a toolkit whose only auth scheme is OAuth that Composio
 *    does *not* manage (Docusign, Twitter/X) answers `link` with a *dashboard*
 *    URL — the user would have to register their own OAuth app first — so the
 *    Connect button is dead on arrival. Toolkits Composio manages, and
 *    key-based ones it collects on its own hosted page (Apollo, Ashby), both
 *    return a real connect link. Only those belong here.
 *
 * The catalog is two files. This one holds the hand-curated shortlist every
 * user sees first, and every entry here wins over its generated twin. The long
 * tail — every other connectable app Composio publishes — is generated into
 * `plugins.generated.ts` by `scripts/sync-plugins.mjs` (`pnpm plugins`), which
 * also checks rule 2 for them from `dev toolkits info` metadata, so a fresh
 * sync cannot ship a dead Connect button.
 *
 * Icons are each vendor's own logo, fetched from Composio and committed under
 * `public/logos/<id>.svg` by the same script.
 *
 * `plugins.test.ts` holds rule 1 and the generated file's invariants
 * automatically. Rule 2 was established per app against the CLI (curated) and
 * is read from auth metadata at sync time (generated).
 */

export interface PluginDef {
  /** Composio toolkit slug. Doubles as the icon filename and the link target. */
  id: string;
  name: string;
  description: string;
  category: (typeof PLUGIN_CATEGORIES)[number];
}

/**
 * Section order in the marketplace. Featured is the shortlist most people
 * reach for; the rest are grouped by the job rather than by vendor, because
 * someone looking for a place to put a file does not think "Microsoft".
 */
export const PLUGIN_CATEGORIES = [
  "Featured",
  "Email & calendar",
  "Files & docs",
  "Messaging",
  "Project management",
  "CRM & support",
  "Developer",
  "Finance",
  "Marketing",
  "Design & social",
  "AI & search",
  "E-commerce",
  "Data & analytics",
  "Media & entertainment",
  "Productivity",
  "More apps",
] as const;

// AUTO-GENERATED — every connectable app beyond the curated shortlist above.
// Kept in a separate file so a sync can rewrite the whole long tail without
// ever touching a hand-written entry. Regenerate with `pnpm plugins`.

const curatedPlugins: PluginDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Triage the inbox, draft replies, search history, and manage labels.",
    category: "Featured",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search conversations, post to channels, and catch up on threads and DMs.",
    category: "Featured",
  },
  {
    id: "googlecalendar",
    name: "Google Calendar",
    description: "See what is on, schedule meetings, and find a slot that actually works.",
    category: "Featured",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search pages and databases, pull context, and write notes back.",
    category: "Featured",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search code, review pull requests, and triage issues across repositories.",
    category: "Featured",
  },
  {
    id: "googledrive",
    name: "Google Drive",
    description: "Find files, read their contents, and share or organise what matters.",
    category: "Featured",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Track issues and cycles, file bugs, and move work forward.",
    category: "Featured",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Look up contacts and deals, log activity, and keep the pipeline current.",
    category: "Featured",
  },

  {
    id: "outlook",
    name: "Outlook",
    description: "Search and send mail, and manage the calendar behind it.",
    category: "Email & calendar",
  },
  {
    id: "googlemeet",
    name: "Google Meet",
    description: "Set up meetings and pull the recordings and transcripts afterwards.",
    category: "Email & calendar",
  },
  {
    id: "zoom",
    name: "Zoom",
    description: "Schedule calls, list participants, and fetch recordings and summaries.",
    category: "Email & calendar",
  },
  {
    id: "calendly",
    name: "Calendly",
    description: "Share booking links, see what is scheduled, and manage invitees.",
    category: "Email & calendar",
  },

  {
    id: "googledocs",
    name: "Google Docs",
    description: "Draft documents, read them back, and edit them in place.",
    category: "Files & docs",
  },
  {
    id: "googlesheets",
    name: "Google Sheets",
    description: "Read ranges, append rows, and keep spreadsheets up to date.",
    category: "Files & docs",
  },
  {
    id: "excel",
    name: "Excel",
    description: "Read and write worksheets, tables, and ranges in the cloud.",
    category: "Files & docs",
  },
  {
    id: "one_drive",
    name: "OneDrive",
    description: "Find files, upload new ones, and share folders.",
    category: "Files & docs",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    description: "Search files, organise folders, and create sharing links.",
    category: "Files & docs",
  },
  {
    id: "box",
    name: "Box",
    description: "Search and manage files, folders, comments, and shared links.",
    category: "Files & docs",
  },

  {
    id: "discord",
    name: "Discord",
    description: "Read and send messages across servers and channels.",
    category: "Messaging",
  },
  {
    id: "discordbot",
    name: "Discord Bot",
    description: "Act as a bot: join servers, moderate, and answer in channels.",
    category: "Messaging",
  },
  {
    id: "microsoft_teams",
    name: "Microsoft Teams",
    description: "Post to channels and chats, and catch up on conversations.",
    category: "Messaging",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Send business messages, manage templates, and read the replies.",
    category: "Messaging",
  },

  {
    id: "jira",
    name: "Jira",
    description: "Search issues, move them through workflows, and run sprints.",
    category: "Project management",
  },
  {
    id: "confluence",
    name: "Confluence",
    description: "Search spaces, read pages, and publish or update documentation.",
    category: "Project management",
  },
  {
    id: "asana",
    name: "Asana",
    description: "Find tasks and projects, assign work, and track what is due.",
    category: "Project management",
  },
  {
    id: "trello",
    name: "Trello",
    description: "Manage boards, lists, and cards, and move work across them.",
    category: "Project management",
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Search tasks, update statuses, and manage lists and docs.",
    category: "Project management",
  },
  {
    id: "monday",
    name: "Monday",
    description: "Query boards, create items, and update columns.",
    category: "Project management",
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Capture tasks, organise projects, and close out what is due.",
    category: "Project management",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Query bases, filter records, and create or update rows.",
    category: "Project management",
  },

  {
    id: "salesforce",
    name: "Salesforce",
    description: "Query and update records, and traverse relationships across your org.",
    category: "CRM & support",
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description: "Search tickets, reply to customers, and manage users.",
    category: "CRM & support",
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Search conversations and contacts, and manage Help Center articles.",
    category: "CRM & support",
  },
  {
    id: "attio",
    name: "Attio",
    description: "Search records and lists, and keep CRM data current.",
    category: "CRM & support",
  },
  {
    id: "apollo",
    name: "Apollo",
    description: "Prospect search, contact and company enrichment, lists, and sequences.",
    category: "CRM & support",
  },
  {
    id: "gong",
    name: "Gong",
    description: "Account summaries, deal insights, and briefs from recorded calls.",
    category: "CRM & support",
  },
  {
    id: "ashby",
    name: "Ashby",
    description: "Search candidates and jobs, prep interviews, and manage the pipeline.",
    category: "CRM & support",
  },

  {
    id: "gitlab",
    name: "GitLab",
    description: "Search projects, review merge requests, and manage issues.",
    category: "Developer",
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    description: "Browse repositories, pull requests, and pipelines.",
    category: "Developer",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Search issues, read stack traces, and triage releases.",
    category: "Developer",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Inspect projects, run queries, and manage tables and keys.",
    category: "Developer",
  },

  {
    id: "stripe",
    name: "Stripe",
    description: "Look up customers, payments, invoices, and subscriptions.",
    category: "Finance",
  },
  {
    id: "square",
    name: "Square",
    description: "Read orders, payments, catalog, and customer records.",
    category: "Finance",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    description: "Query invoices, expenses, customers, and reports.",
    category: "Finance",
  },

  {
    id: "mailchimp",
    name: "Mailchimp",
    description: "Manage audiences, build campaigns, and read the reports.",
    category: "Marketing",
  },
  {
    id: "typeform",
    name: "Typeform",
    description: "List forms and pull responses as they come in.",
    category: "Marketing",
  },
  {
    id: "google_analytics",
    name: "Google Analytics",
    description: "Run reports on traffic, audiences, and conversions.",
    category: "Marketing",
  },
  {
    id: "googleads",
    name: "Google Ads",
    description: "Review campaigns, budgets, and performance metrics.",
    category: "Marketing",
  },

  {
    id: "figma",
    name: "Figma",
    description: "Browse files and frames, read comments, and export assets.",
    category: "Design & social",
  },
  {
    id: "canva",
    name: "Canva",
    description: "Find designs, create from templates, and export artwork.",
    category: "Design & social",
  },
  {
    id: "miro",
    name: "Miro",
    description: "Read and update boards, frames, and sticky notes.",
    category: "Design & social",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Publish posts and read profile and company information.",
    category: "Design & social",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Search videos, read analytics, and manage playlists.",
    category: "Design & social",
  },
];

/** Curated entries always win: if an id appears above, its generated twin is dropped. */
const curatedIds = new Set(curatedPlugins.map((plugin) => plugin.id));

/** The hand-picked shortlist, light enough for the startup chunk. */
export const plugins: PluginDef[] = curatedPlugins;

/**
 * The full catalog: curated plus the generated long tail.
 *
 * The generated file is ~90 KB of source, and importing it statically ships
 * the whole catalog in the startup chunk (measured: 271 kB gzip against the
 * 185 kB budget in `pnpm build`) — so it sits behind a dynamic import() that
 * Rolldown splits into its own chunk. It resolves locally, so the plugins
 * modal and the prompt's connected-app names wait milliseconds, not a round
 * trip. The promise is cached: the catalog is immutable for a page lifetime.
 */
let catalogPromise: Promise<PluginDef[]> | null = null;

export function loadPlugins(): Promise<PluginDef[]> {
  catalogPromise ??= import("./plugins.generated").then(({ generatedPlugins }) => [
    ...curatedPlugins,
    ...generatedPlugins.filter((plugin) => !curatedIds.has(plugin.id)),
  ]);
  return catalogPromise;
}
