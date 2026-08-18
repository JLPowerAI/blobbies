import { siGmail, siGooglecalendar, siGoogledrive, siHubspot, siIntercom, siX } from "simple-icons";

/**
 * App-focused plugin catalog mirroring cursor/plugins (developer-tool plugins
 * intentionally excluded). Descriptions name what the app does, not how it
 * is reached: connections run through Composio, so a vendor's own MCP server
 * is not what a user (or a model reading this) is connecting to. Icons come from
 * simple-icons where the brand exists there; the rest keep branded monograms
 * (several brands were removed from simple-icons for trademark reasons).
 */

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  category: "Featured" | "Integrations";
  /** Tile: brand background plus either an official SVG glyph or a monogram. */
  tile: { bg: string; label: string; fg?: string; iconPath?: string };
  /** Source directory in the cursor/plugins repo. */
  sourceUrl: string;
}

/**
 * Where each plugin's source lives upstream.
 *
 * `third_party/` is part of the path, not decoration: without it every "View
 * Source" link 404s — measured against the whole catalog.
 */
const REPO = "https://github.com/cursor/plugins/tree/main/third_party";

export const plugins: PluginDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Connect to Gmail — search, read, draft, label, and manage email.",
    category: "Featured",
    tile: { bg: "#ea4335", label: "M", iconPath: siGmail.path },
    sourceUrl: `${REPO}/gmail`,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description:
      "Connect to Google Calendar — list calendars, search events, and create or update meetings.",
    category: "Featured",
    tile: { bg: "#4285f4", label: "31", iconPath: siGooglecalendar.path },
    sourceUrl: `${REPO}/google-calendar`,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Connect to Google Drive — search, read, create, share, and manage files.",
    category: "Featured",
    tile: { bg: "#34a853", label: "D", iconPath: siGoogledrive.path },
    sourceUrl: `${REPO}/google-drive`,
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description:
      "Connect to Salesforce — query, search, create, update, and traverse records in your org.",
    category: "Integrations",
    tile: { bg: "#00a1e0", label: "SF" },
    sourceUrl: `${REPO}/salesforce`,
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description:
      "Connect to HubSpot CRM — search and update contacts, companies, deals, and tickets; work with activities, conversations, and marketing emails.",
    category: "Integrations",
    tile: { bg: "#ff7a59", label: "H", iconPath: siHubspot.path },
    sourceUrl: `${REPO}/hubspot`,
  },
  {
    id: "gong",
    name: "Gong",
    description:
      "Connect to Gong — revenue intelligence: account summaries, deal insights, and call briefs.",
    category: "Integrations",
    tile: { bg: "#8039df", label: "G" },
    sourceUrl: `${REPO}/gong`,
  },
  {
    id: "apollo-io",
    name: "Apollo.io",
    description:
      "Connect to Apollo.io — prospect search, contact and company enrichment, lists, sequences, and one-off emails.",
    category: "Integrations",
    tile: { bg: "#f5a623", label: "A" },
    sourceUrl: `${REPO}/apollo-io`,
  },
  {
    id: "ashby",
    name: "Ashby",
    description:
      "Connect to Ashby — search candidates and jobs, prep for interviews, manage pipeline tasks, and take recruiting actions.",
    category: "Integrations",
    tile: { bg: "#4a3aff", label: "A" },
    sourceUrl: `${REPO}/ashby`,
  },
  {
    id: "intercom",
    name: "Intercom",
    description:
      "Connect to Intercom — search conversations and contacts, look up companies, and manage Help Center articles.",
    category: "Integrations",
    tile: { bg: "#286efa", label: "I", iconPath: siIntercom.path },
    sourceUrl: `${REPO}/intercom`,
  },
  {
    id: "circleback",
    name: "Circleback",
    description:
      "Connect to Circleback — search meetings, transcripts, action items, calendar events, and emails, and look up people and companies.",
    category: "Integrations",
    tile: { bg: "#0f172a", label: "C" },
    sourceUrl: `${REPO}/circleback`,
  },
  {
    id: "docusign",
    name: "Docusign",
    description:
      "Connect to Docusign — work with eSignature envelopes and templates, Maestro workflows, and Navigator agreements.",
    category: "Integrations",
    tile: { bg: "#4c00ff", label: "D" },
    sourceUrl: `${REPO}/docusign`,
  },
  {
    id: "x",
    name: "X",
    description:
      "Read-only access to the X API — search posts and users, read timelines and mentions, and pull trends and news.",
    category: "Integrations",
    tile: { bg: "#111111", label: "X", iconPath: siX.path },
    sourceUrl: `${REPO}/x`,
  },
  {
    id: "navan",
    name: "Navan",
    description:
      "Connect to Navan — query expenses, analyze travel bookings, check policies and approvals, and manage cards.",
    category: "Integrations",
    tile: { bg: "#ff3b30", label: "N" },
    sourceUrl: `${REPO}/navan`,
  },
  {
    id: "profound",
    name: "Profound",
    description:
      "Connect to Profound — retrieve AI visibility, sentiment, and citation reports, access agent analytics, and build or run Profound Agents.",
    category: "Integrations",
    tile: { bg: "#6d4aff", label: "P" },
    sourceUrl: `${REPO}/profound`,
  },
];

export const PLUGIN_CATEGORIES = ["Featured", "Integrations"] as const;
