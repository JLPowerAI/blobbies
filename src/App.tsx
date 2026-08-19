import type { Message as AiMessage } from "@kenkaiiii/gg-ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPane } from "@/components/ChatPane";
import { ComposePane } from "@/components/ComposePane";
import { CreatorPane } from "@/components/CreatorPane";
import { DetailPanel } from "@/components/DetailPanel";
import { Onboarding } from "@/components/Onboarding";
import { PluginsModal } from "@/components/PluginsModal";
import { RoutinePanel } from "@/components/RoutinePanel";
import { SearchModal } from "@/components/SearchModal";
import {
  MAX_USER_NAME_LENGTH,
  SettingsModal,
  type SettingsTab,
  type ThemePreference,
} from "@/components/SettingsModal";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { SlidePanel } from "@/components/SlidePanel";
import {
  type Agent,
  type AgentShape,
  type AvatarTone,
  GREETING,
  MAX_BLOB_NAME_LENGTH,
  MAX_BLOBS,
  type Message,
  type Routine,
  SAMPLE_MEMORIES,
  SAMPLE_USER_MEMORIES,
  agents as seedAgents,
  transcriptFor,
  uniqueBlobName,
} from "@/data/agents";
import {
  type Attachment,
  attachmentName,
  attachmentsPrompt,
  type PickedFile,
  rejectionNote,
  saveAttachments,
} from "@/lib/attachments";
import type { BlobMemory, RosterAccess, RoutineAccess } from "@/lib/blob-tools";
import { connectedAppNames } from "@/lib/composio";
import { contextWindow } from "@/lib/context-window";
import {
  addressedResponders,
  type Group,
  groupConversationId,
  handoffTarget,
  isPass,
  MAX_GROUP_MEMBERS,
  namedResponders,
  owesAnswer,
  stripSelfMention,
} from "@/lib/groups";
import { homeFor } from "@/lib/home";
import type { Intent } from "@/lib/intent";
import { type McpServerConfig, parseLoopbackUrl } from "@/lib/mcp";
import { notify, shouldNotify } from "@/lib/notify";
import { unloadOllamaModel } from "@/lib/ollama";
import { readPreference, writePreference } from "@/lib/preferences";
import { blobSystemPrompt, timeNote, trimHistory } from "@/lib/prompt";
import { type ActiveRun, assertTransition, isTerminal, type RunTrigger } from "@/lib/run-state";
import { describeSchedule, nextFireTime } from "@/lib/schedule";
import { startScheduler } from "@/lib/scheduler";
import type { SearchResult } from "@/lib/search";
import { listSkills, type Skill, skillLine } from "@/lib/skills";
import * as store from "@/lib/store";
import { openExternal } from "@/lib/tauri";
import { isTinfoilModel } from "@/lib/tinfoil-model";
import "./App.css";

// The provider stack (`@/lib/ai` → gg-ai + the OpenAI SDK + zod + Tinfoil,
// several hundred KB minified) is only needed once a turn actually runs;
// loading it lazily keeps it out of the startup chunk. Memoized so every
// await shares one promise. Same shape for the intent router and Tinfoil's
// keychain probe, which pull the same lazy chunk.
let aiModule: Promise<typeof import("@/lib/ai")> | undefined;
const loadAi = () => (aiModule ??= import("@/lib/ai"));
let intentModule: Promise<typeof import("@/lib/intent")> | undefined;
const loadIntent = () => (intentModule ??= import("@/lib/intent"));
let tinfoilModule: Promise<typeof import("@/lib/tinfoil")> | undefined;
const loadTinfoil = () => (tinfoilModule ??= import("@/lib/tinfoil"));

/**
 * How many Blob → Blob hand-offs may chain before the next one is refused.
 *
 * Turns are serial against one local model, so two Blobs passing work back and
 * forth would pin it indefinitely with Stop as the user's only lever. Three is
 * the deepest chain that reads as deliberate (ask → specialist → reviewer).
 * Lives here, not in blob-tools: App must not import that module for a value
 * (startup-bundle budget).
 */
const MAX_HANDOFF_HOPS = 3;

/**
 * Transcript lines handed to the responder router, newest last.
 *
 * Enough to resolve what a bare follow-up refers to; `pickResponders` trims
 * further. Not the whole history: the router decides who a message is *for*,
 * and more context measurably drags a small model towards whoever appears in
 * the excerpt rather than whoever the message needs.
 */
const GROUP_ROUTER_CONTEXT = 5;

/** How much of the user's message is echoed back to a group responder. */
const GROUP_FOCUS_CHARS = 300;

type Mode = { kind: "chat" } | { kind: "palette" } | { kind: "creator"; initialName: string };

function isTheme(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** RFC-4122-shaped id; the Rust store validates this format on every path. */
function newBlobId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older webviews: random hex in the same shape.
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
    c === "x" ? hex() : (Math.floor(Math.random() * 4) + 8).toString(16),
  );
}

/**
 * Groups as they existed before group chats: sidebar "sections", a list of
 * names in localStorage. Run once, when the store has no group list yet.
 */
function migrateSections(roster: Agent[]): Group[] {
  let names: unknown;
  try {
    names = JSON.parse(readPreference("pref:sections", "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(names)) {
    return [];
  }
  const seen = new Set<string>();
  return (
    names
      .filter((name): name is string => typeof name === "string" && name.trim() !== "")
      // An empty section still called "New section" is scaffolding the old add
      // button left behind, not a group anyone made — carrying it over would
      // seed every existing install with a placeholder chat.
      .filter(
        (name) =>
          !/^New section( \d+)?$/.test(name) ||
          roster.some((candidate) => candidate.section === name),
      )
      // The name IS the membership key, so two groups sharing one would both
      // claim the same Blobs and each show the other's members. The old
      // preference was a plain array with no uniqueness guarantee.
      .filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .map((name) => ({ id: newBlobId(), name }))
  );
}

/**
 * A duplicated routine: fresh id, no run history, and re-armed.
 *
 * `armRoutines` only runs at startup, so a copy that kept the source's
 * `nextRunAt` (already in the past, or absent) would silently never fire.
 */
function copyRoutine(routine: Routine): Routine {
  const {
    id: _id,
    lastRunAt: _lastRunAt,
    lastRunStatus: _lastRunStatus,
    nextRunAt: _nextRunAt,
    ...rest
  } = routine;
  return {
    ...rest,
    id: newBlobId(),
    ...(rest.schedule === undefined ? {} : { nextRunAt: nextFireTime(rest.schedule, Date.now()) }),
  };
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>(seedAgents);
  /**
   * Latest roster for async callbacks (tool executes outlive a render).
   *
   * Only `commitAgents` writes this. It is deliberately NOT re-assigned each
   * render: a render can be started with stale state and discarded, which
   * would walk the ref backwards over a write a tool just made.
   */
  const agentsRef = useRef<Agent[]>(agents);

  /**
   * The one way to mutate the roster: advances the ref and the state together.
   *
   * Waiting for the next render to refresh the ref is too late for the agent
   * loop — tool calls run back-to-back inside one turn, so a second call
   * would read the roster as it was *before* the first. That silently broke
   * `spawn_blob`'s duplicate-name refusal, which is the whole idempotency
   * mechanism: a retried call created a second Blob instead of no-oping.
   *
   * Every roster write goes through here, and `setAgents` appears nowhere
   * else. Mixing the two is what makes this dangerous rather than merely
   * redundant: a plain `setAgents(fn)` is queued and does not move the ref,
   * so the next commit would read a stale base and drop it.
   *
   * Stable (`useCallback`, no deps): it closes over nothing but the ref and
   * the setter, so effects may depend on it without re-running every render.
   */
  const commitAgents = useCallback((update: (previous: Agent[]) => Agent[]): Agent[] => {
    const next = update(agentsRef.current);
    agentsRef.current = next;
    setAgents(next);
    return next;
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Group chats. A Blob's membership is its `section` (the sidebar group it
   * was dragged into), so this list holds only names and ids — the id keys
   * the transcript slice, which can never be user text (see lib/groups).
   */
  const [groups, setGroups] = useState<Group[]>([]);
  /** The open group chat, or null while a Blob conversation is on screen. */
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // Both read inside queued turns, which run the closure they were queued in
  // — several exchanges after the render that created it.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const selectedGroupIdRef = useRef(selectedGroupId);
  selectedGroupIdRef.current = selectedGroupId;
  const [mode, setMode] = useState<Mode>({ kind: "chat" });
  // Details stay hidden until explicitly opened from the chat header.
  const [detailOpen, setDetailOpen] = useState(false);
  /** Bumped when the Blob's home folder changed, so the Files list re-reads. */
  const [filesKey, setFilesKey] = useState(0);
  /**
   * Messages whose attachments are still being read. Transient on purpose:
   * it describes work in this session, so it must never reach the transcript
   * on disk and outlive the read it refers to.
   */
  const [readingMessages, setReadingMessages] = useState<string[]>([]);
  const [detailView, setDetailView] = useState<
    { kind: "info" } | { kind: "settings" } | { kind: "routine"; routineId: string }
  >({ kind: "info" });
  const [routinesByAgent, setRoutinesByAgent] = useState<Record<string, Routine[]>>({});
  const [sentByAgent, setSentByAgent] = useState<Record<string, Message[]>>({});
  /** Latest transcripts for queued turns (they run after state settles). */
  const sentRef = useRef(sentByAgent);
  sentRef.current = sentByAgent;

  /**
   * Write a transcript, ref first.
   *
   * `sentRef` only refreshes on render, and queued turns run back to back:
   * in a group that means the second member answering without the first
   * member's line in front of it. Computing from the ref and assigning it
   * synchronously keeps every reader — turn or render — on the same version.
   *
   * Every transcript write goes through here, including hydration: one that
   * only landed in React state would be invisible to the next write's ref
   * read, which would then persist the transcript without it.
   */
  // useCallback with no deps, like `commitAgents`: it touches only a ref and
  // a setter, and effects hydrate through it — an identity that changed each
  // render would drag them into re-running.
  const mutateSent = useCallback(
    (update: (previous: Record<string, Message[]>) => Record<string, Message[]>) => {
      const next = update(sentRef.current);
      sentRef.current = next;
      setSentByAgent(next);
    },
    [],
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [searchOpen, setSearchOpen] = useState(false);
  /** Memories shared by every Blob ("All Blobs" scope), from the `user` slice. */
  const [userMemories, setUserMemories] = useState<BlobMemory[]>([]);
  // Read inside queued turns, which run the closure they were queued in: a
  // group's shared-memory write must see what the previous exchange saved.
  const userMemoriesRef = useRef(userMemories);
  userMemoriesRef.current = userMemories;
  /** Blob currently generating a reply; drives the thinking indicator. */
  const [thinkingFor, setThinkingFor] = useState<string | null>(null);
  /** Last (or active) run per Blob; drives ask/answer routing and recovery. */
  const [runsByBlob, setRunsByBlob] = useState<Record<string, ActiveRun>>({});
  const runsRef = useRef(runsByBlob);
  runsRef.current = runsByBlob;
  /** Routines mirror for the scheduler (reads outside the render cycle). */
  const routinesRef = useRef<Record<string, Routine[]>>({});
  /**
   * The one in-flight turn app-wide. Turns are serial — a single local model
   * serves them — so user sends and routine fires share this slot and the
   * FIFO `turnQueue`. Steering carries mid-run follow-up messages.
   */
  const activeTurn = useRef<{
    blobId: string;
    abort: AbortController;
    steering: AiMessage[];
  } | null>(null);
  const turnQueue = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Bumped by Stop. A turn can queue more turns behind it — one per member of
   * a group, or a Blob's hand-off to another — and each drops out when this
   * has moved since it was queued. The abort signal only reaches whoever is
   * already speaking, so without this, Stop leaves the queue running.
   */
  const queuedTurnEpoch = useRef(0);
  /** Drop an identical double-send within this window (fat-finger guard). */
  const lastSend = useRef<{ text: string; at: number } | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(readPreference("pref:plugins", "[]"));
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  /** Local MCP servers; only enabled ones are contacted, on routine turns. */
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  /**
   * Installed skills, named in every Blob's prompt.
   *
   * Loaded once at startup rather than per turn: the list only changes when
   * the user adds or removes a folder, and it sits in the prompt's cached
   * prefix, so re-reading it mid-session would risk moving that boundary for
   * no benefit.
   */
  const [skills, setSkills] = useState<Skill[]>([]);
  /**
   * Display names of apps connected through Composio.
   *
   * Read at startup and refreshed when the Plugins modal closes, which is the
   * only place a connection can change. Names rather than slugs: the prompt is
   * read by a model that will repeat them back to the user.
   */
  const [connectedApps, setConnectedApps] = useState<string[]>([]);
  const [userName, setUserName] = useState(() =>
    readPreference("pref:userName", "Ken Kai").slice(0, MAX_USER_NAME_LENGTH),
  );
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const stored = readPreference("pref:theme", "system");
    return isTheme(stored) ? stored : "system";
  });
  const [timezone, setTimezone] = useState(() => readPreference("pref:timezone", "auto"));
  // Ollama model tag (e.g. "llama3.2:latest"); empty until one is chosen.
  const [model, setModel] = useState(() => readPreference("pref:model", ""));
  // Chain-of-thought toggle; off by default because it multiplies reply time.
  const [reasoning, setReasoning] = useState(
    () => readPreference("pref:reasoning", "off") === "on",
  );
  // First-run flow. Shown until it is completed once, or for as long as the
  // dev switch below is on. An install that predates onboarding sees it once.
  const [forceOnboarding, setForceOnboarding] = useState(
    () => readPreference("pref:forceOnboarding", "off") === "on",
  );
  const [onboarding, setOnboarding] = useState(
    () =>
      forceOnboarding ||
      // Dev escape hatch: `VITE_ONBOARDING=1 pnpm tauri dev` replays the flow
      // without writing a preference, which is the only way back in once the
      // flag is set, since the webview owns the storage it lives in. Guarded
      // by DEV because Vite *inlines* env vars at build time — unguarded, a
      // stray `VITE_ONBOARDING=1 pnpm build` would ship onboarding-on to
      // every user, and the constant folds away in release either way.
      (import.meta.env.DEV && import.meta.env.VITE_ONBOARDING === "1") ||
      readPreference("pref:onboarded", "false") !== "true",
  );

  /**
   * Everything a turn reads that is not passed into it — mirrored for turns
   * that start outside the render cycle.
   *
   * The scheduler is built in a mount-once effect, so a routine it fires runs
   * the *mount-render* closure of `requestReply`. Every value here is either
   * hydrated from disk after mount or changed later in Settings, so reading
   * the closure hands a scheduled routine the mount-time value forever: no
   * model (the turn bails with “pick one in Settings”), no shared memories,
   * and no MCP servers — which is the only scope that offers those tools.
   *
   * Assigned every render, so a turn always sees the newest values.
   */
  const currentTurnSettings = {
    model,
    userName,
    timezone,
    reasoning,
    userMemories,
    // Only enabled servers are ever contacted.
    mcpServers: mcpServers.filter((server) => server.enabled),
    skills,
    connectedApps,
  };
  const turnSettings = useRef(currentTurnSettings);
  turnSettings.current = currentTurnSettings;

  // Configure Tinfoil only when the chosen model actually needs it: a
  // keychain read can prompt for the device password (macOS re-verifies the
  // app after every rebuild), so local-only setups must never touch it.
  useEffect(() => {
    if (isTinfoilModel(model)) {
      void loadTinfoil().then((tinfoil) => tinfoil.configureTinfoilFromKeychain());
    }
  }, [model]);

  // Hydrate persisted state (roster, settings) once on startup. Legacy
  // localStorage prefs remain the synchronous initial values above; the disk
  // slices win when they exist.
  // biome-ignore lint/correctness/useExhaustiveDependencies(commitAgents): stable (useCallback, no deps)
  // biome-ignore lint/correctness/useExhaustiveDependencies(mutateSent): stable (useCallback, no deps)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [roster, settings, shared, savedGroups] = await Promise.all([
        store.loadRoster(),
        store.loadSettings(),
        store.loadUserMemories(),
        store.loadGroups(),
      ]);
      if (cancelled) {
        return;
      }
      if (roster !== null && roster.length > 0) {
        commitAgents(() => roster);
      }
      // One-time lift of the old localStorage sections into real groups; the
      // Blobs already in them carry the name, so membership survives.
      if (savedGroups !== null) {
        setGroups(savedGroups);
      } else {
        const migrated = migrateSections(roster ?? []);
        setGroups(migrated);
        if (migrated.length > 0) {
          store.saveGroups(migrated);
        }
      }
      if (shared !== null) {
        setUserMemories(shared);
      } else if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
        // Dev server only, and only when nothing is saved yet: something to
        // look at in the Memories dialog, including for a Blob created before
        // the per-Blob samples existed. Not persisted — editing one writes the
        // list for real, but until then a restart brings back a clean slate.
        setUserMemories(SAMPLE_USER_MEMORIES);
      }
      if (settings !== null) {
        if (typeof settings.userName === "string") {
          setUserName(settings.userName.slice(0, MAX_USER_NAME_LENGTH));
        }
        if (typeof settings.theme === "string" && isTheme(settings.theme)) {
          setTheme(settings.theme);
        }
        if (typeof settings.timezone === "string") {
          setTimezone(settings.timezone);
        }
        if (typeof settings.model === "string") {
          setModel(settings.model);
        }
        if (Array.isArray(settings.mcpServers)) {
          // Stored config is re-validated on load: the file is editable, and
          // an entry that is no longer loopback must never be contacted.
          setMcpServers(
            settings.mcpServers.filter(
              (server): server is McpServerConfig =>
                typeof server?.url === "string" && !("error" in parseLoopbackUrl(server.url)),
            ),
          );
        }
        if (Array.isArray(settings.plugins)) {
          setInstalledPlugins(
            settings.plugins.filter((id): id is string => typeof id === "string"),
          );
        }
      }

      // Skills are seeded by Rust at startup, so this reads whatever is on
      // disk by the time the app shell is up — bundled and user-added alike.
      const installedSkills = await listSkills();
      if (!cancelled) {
        setSkills(installedSkills);
      }

      // Named in the prompt so a Blob knows what the user has connected; the
      // tools themselves are not built yet, which the prompt says outright.
      const apps = await connectedAppNames();
      if (!cancelled) {
        setConnectedApps(apps);
      }

      // Scheduler + recovery need every Blob's routines and last run — the
      // per-conversation effect only hydrates the Blob on screen.
      const ids = (roster ?? agentsRef.current).map((entry) => entry.id);
      const loaded = await Promise.all(
        ids.map(async (id) => ({
          id,
          routines: await store.loadBlobRoutines(id),
          run: await store.loadBlobRun(id),
        })),
      );
      if (cancelled) {
        return;
      }
      setRoutinesByAgent((previous) => {
        const next = { ...previous };
        for (const entry of loaded) {
          if (next[entry.id] === undefined && entry.routines !== null) {
            next[entry.id] = entry.routines;
          }
        }
        routinesRef.current = next;
        return next;
      });
      for (const entry of loaded) {
        if (entry.run === null) {
          continue;
        }
        // A run still marked active did not survive the last session: say so
        // in the transcript and close it out. waiting_input survives — the
        // question is in the transcript and the next message answers it.
        if (entry.run.status === "running" || entry.run.status === "queued") {
          const failed: ActiveRun = { ...entry.run, status: "failed" };
          void store.saveBlobRun(entry.id, failed);
          setRunsByBlob((previous) => ({ ...previous, [entry.id]: failed }));
          const transcript = (await store.loadBlobTranscript(entry.id)) ?? [];
          const note: Message = {
            id: `event-${Date.now()}`,
            kind: "event",
            text: "A task didn't finish \u2014 the app closed while it was running.",
            timestampMs: Date.now(),
          };
          store.saveBlobTranscript(entry.id, [...transcript, note]);
          mutateSent((previous) =>
            previous[entry.id] === undefined
              ? { ...previous, [entry.id]: [...transcript, note] }
              : previous,
          );
        } else {
          setRunsByBlob((previous) => ({ ...previous, [entry.id]: entry.run as ActiveRun }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The routine scheduler lives for the whole app session. Its host reads
  // refs (not state) so the interval sees fresh data without re-subscribing;
  // claims are written to the ref synchronously — that write is the CAS that
  // prevents a double fire (see scheduler.ts).
  // biome-ignore lint/correctness/useExhaustiveDependencies(fireRoutine): mount-once; the host reads refs
  // biome-ignore lint/correctness/useExhaustiveDependencies(queueTurn): stable
  // biome-ignore lint/correctness/useExhaustiveDependencies(setAgentRoutines): stable
  useEffect(() => {
    const host = {
      routines: () => new Map(Object.entries(routinesRef.current)),
      update: (blobId: string, routineId: string, patch: Partial<Routine>) => {
        routinesRef.current = {
          ...routinesRef.current,
          [blobId]: (routinesRef.current[blobId] ?? []).map((candidate) =>
            candidate.id === routineId ? { ...candidate, ...patch } : candidate,
          ),
        };
        // Persist + render through the normal path (also rewrites the ref
        // from state; the map above keeps the claim visible in between).
        setAgentRoutines(blobId, (current) =>
          current.map((candidate) =>
            candidate.id === routineId ? { ...candidate, ...patch } : candidate,
          ),
        );
      },
      busy: () => activeTurn.current !== null,
      fire: (blobId: string, routine: Routine) => queueTurn(() => fireRoutine(blobId, routine)),
    };
    return startScheduler(host);
  }, []);

  // Resolve and apply the theme; track the OS while set to "system".
  useEffect(() => {
    const root = document.documentElement;
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media?.matches === true);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (theme === "system" && media !== null) {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    return undefined;
  }, [theme]);

  // Persist settings whenever any part changes (debounced in the store).
  useEffect(() => {
    store.saveSettings({
      userName,
      theme,
      timezone,
      model,
      plugins: installedPlugins,
      mcpServers,
    });
  }, [userName, theme, timezone, model, installedPlugins, mcpServers]);

  const changeUserName = (name: string) => {
    const capped = name.slice(0, MAX_USER_NAME_LENGTH);
    setUserName(capped);
    writePreference("pref:userName", capped);
  };

  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    writePreference("pref:theme", next);
  };

  const changeTimezone = (next: string) => {
    setTimezone(next);
    writePreference("pref:timezone", next);
  };

  const changeReasoning = (on: boolean) => {
    setReasoning(on);
    writePreference("pref:reasoning", on ? "on" : "off");
  };

  const changeModel = (next: string) => {
    // Free the outgoing model's memory right away: Ollama keeps multiple
    // models resident, so without this the old one idles in RAM beside the
    // new one for the rest of its 30-minute keep_alive. Fire-and-forget —
    // an in-flight reply on the old model still completes first (the
    // scheduler queues the unload), and any failure just leaves the timer.
    // Tinfoil models are not Ollama-resident, so only local ones unload.
    if (model !== "" && model !== next && !isTinfoilModel(model)) {
      void unloadOllamaModel(model);
    }
    setModel(next);
    writePreference("pref:model", next);
  };

  /**
   * Dev switch: keep showing the first-run flow on every launch even though
   * it has been completed. Turning it on opens the flow right away, so the
   * change is visible where it was made rather than at the next launch.
   */
  const changeForceOnboarding = (on: boolean) => {
    setForceOnboarding(on);
    writePreference("pref:forceOnboarding", on ? "on" : "off");
    if (on) {
      setSettingsOpen(false);
    }
    setOnboarding(on);
  };

  const finishOnboarding = () => {
    writePreference("pref:onboarded", "true");
    setOnboarding(false);
    // The flow ends *on* the app's own Blob creator rather than carrying a
    // second copy of it. With an empty roster this is what would render
    // anyway; on a replay (dev toggle) it is the screen the last step
    // promised.
    setMode({ kind: "creator", initialName: "" });
  };

  const setPluginInstalled = (id: string, isInstalled: boolean) => {
    setInstalledPlugins((previous) =>
      isInstalled
        ? [...new Set([...previous, id])]
        : previous.filter((candidate) => candidate !== id),
    );
  };

  const agent = agents.find((candidate) => candidate.id === selectedId) ?? agents[0];
  // With no Blobs yet, the creator is the only possible view.
  const activeMode: Mode = agent === undefined ? { kind: "creator", initialName: "" } : mode;

  const openConversation = (id: string) => {
    setSelectedId(id);
    setSelectedGroupId(null);
    setMode({ kind: "chat" });
    setDetailView({ kind: "info" });
  };

  /** Open a group chat. The details panel is per-Blob, so it closes. */
  const openGroup = (id: string) => {
    setSelectedGroupId(id);
    setMode({ kind: "chat" });
    setDetailOpen(false);
    // Reading it is what clears the dot.
    if (groupsRef.current.some((group) => group.id === id && group.unread === true)) {
      changeGroups(
        groupsRef.current.map((group) => (group.id === id ? { ...group, unread: false } : group)),
      );
    }
  };

  /**
   * Flag a group as having unheard replies.
   *
   * Through the ref: this fires from inside a queued turn, where the
   * render-time `groups` may be several exchanges stale — writing that back
   * would resurrect a group the user deleted while the Blobs were talking.
   */
  const markGroupUnread = (id: string) => {
    // Removed while its Blobs were still talking: nothing to flag, and
    // `.map` over a list that no longer holds it would rewrite the whole
    // group list for no reason.
    if (!groupsRef.current.some((group) => group.id === id)) {
      return;
    }
    changeGroups(
      groupsRef.current.map((group) => (group.id === id ? { ...group, unread: true } : group)),
    );
  };

  /**
   * The one way to write the group list.
   *
   * Enforces unique names here rather than at each caller, because the name
   * is the membership key: two groups sharing one would each claim the
   * other's Blobs, and the sidebar's reorder — which maps name back to group
   * — would silently drop whichever it matched second.
   */
  const changeGroups = (next: Group[]) => {
    const seen = new Set<string>();
    const unique = next.filter((group) => {
      const key = group.name.trim().toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    setGroups(unique);
    groupsRef.current = unique;
    store.saveGroups(unique);
    // A group the user removed cannot stay on screen. Its transcript stays on
    // disk: "remove group" tidies the sidebar, it does not delete a chat.
    if (selectedGroupId !== null && !unique.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(null);
    }
  };

  /**
   * Start a group chat and open it. Blobs join by being dragged into the
   * group in the sidebar, which is also how one leaves — membership is a
   * Blob's `section`, and there is only ever one way to set it.
   */
  const createGroup = (typed: string) => {
    const wanted = typed.trim().slice(0, MAX_BLOB_NAME_LENGTH) || "New Group";
    // The name is the membership key, so two groups cannot share one — and a
    // request for a taken name gets a suffix rather than being dropped by
    // `changeGroups`, which is the last line of defence, not the UX.
    let name = wanted;
    for (
      let suffix = 2;
      groups.some((group) => group.name.toLowerCase() === name.toLowerCase());
      suffix += 1
    ) {
      name = `${wanted} ${suffix}`;
    }
    const group: Group = { id: newBlobId(), name };
    changeGroups([...groups, group]);
    openGroup(group.id);
  };

  /**
   * Rename a group, and every member with it: membership is the Blob's
   * `section` field, so the two names have to move together or the group
   * empties itself.
   */
  const renameGroup = (id: string, raw: string) => {
    const name = raw.trim().slice(0, MAX_BLOB_NAME_LENGTH);
    const group = groups.find((candidate) => candidate.id === id);
    if (
      group === undefined ||
      name === "" ||
      name === group.name ||
      // Case-insensitive, matching `changeGroups`: "launch" and "Launch" are
      // one membership key, so allowing the rename would drop a group.
      groups.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
    ) {
      return;
    }
    changeGroups(
      groups.map((candidate) => (candidate.id === id ? { ...candidate, name } : candidate)),
    );
    const next = commitAgents((previous) =>
      previous.map((candidate) =>
        candidate.section === group.name ? { ...candidate, section: name } : candidate,
      ),
    );
    store.saveRoster(next);
    for (const member of next.filter((candidate) => candidate.section === name)) {
      store.saveBlobConfig(member.id, member);
    }
  };

  /**
   * Copy a Blob's profile and routines into a new Blob.
   *
   * What a copy does NOT carry: learned memories, lifetime usage, the
   * conversation, and the home folder — those are the original's history, not
   * its job description. It lands in Edit Profile so the copy is renamed and
   * re-scoped before its (armed) routines fire.
   */
  const duplicateBlob = (id: string) => {
    const source = agents.find((candidate) => candidate.id === id);
    if (source === undefined || agents.length >= MAX_BLOBS) {
      return;
    }
    const { memories: _memories, usage: _usage, ...profile } = source;
    const copy: Agent = {
      ...profile,
      id: newBlobId(),
      name: uniqueBlobName(
        `${source.name} copy`,
        agents.map((candidate) => candidate.name),
      ),
      time: "Now",
      lastActivityAt: Date.now(),
      snippet: GREETING,
      unread: false,
      pinned: false,
      hidden: false,
    };
    void store.flushRoster(commitAgents((previous) => [copy, ...previous]));
    store.saveBlobConfig(copy.id, copy);
    void (async () => {
      // The ref only holds Blobs hydrated this session; fall back to disk.
      const routines = routinesRef.current[id] ?? (await store.loadBlobRoutines(id)) ?? [];
      if (routines.length > 0) {
        setAgentRoutines(copy.id, () => routines.map(copyRoutine));
      }
    })();
    editBlobProfile(copy.id);
  };

  const deleteBlob = (id: string) => {
    const next = commitAgents((previous) => previous.filter((candidate) => candidate.id !== id));
    void store.flushRoster(next);
    if (selectedId === id) {
      const fallback = next.find((candidate) => candidate.hidden !== true);
      setSelectedId(fallback === undefined ? null : fallback.id);
      setMode(fallback === undefined ? { kind: "creator", initialName: "" } : { kind: "chat" });
    }
    mutateSent(({ [id]: _dropped, ...rest }) => rest);
    setRoutinesByAgent(({ [id]: _dropped, ...rest }) => rest);
    void store.deleteBlobData(id);
  };

  /** Open a Blob's profile (name/title/description) in the details panel. */
  const editBlobProfile = (id: string) => {
    openConversation(id);
    setDetailView({ kind: "settings" });
    setDetailOpen(true);
  };

  const openSettings = () => {
    setDetailView({ kind: "settings" });
    setDetailOpen(true);
  };

  /**
   * Persist a memory edit from the Memories dialog.
   *
   * Either scope may be absent: a write touches one list at a time, except a
   * promotion, which moves a fact between both in a single call.
   */
  const changeMemories = (next: { blob?: BlobMemory[]; user?: BlobMemory[] }) => {
    if (agent !== undefined && next.blob !== undefined) {
      updateBlob(agent.id, { memories: next.blob });
    }
    if (next.user !== undefined) {
      setUserMemories(next.user);
      store.saveUserMemories(next.user);
    }
  };

  const openSettingsModal = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  /** Perform whatever a search palette row points at, then close the palette. */
  const openSearchResult = (result: SearchResult) => {
    setSearchOpen(false);
    switch (result.kind) {
      case "message":
      case "blob":
        openConversation(result.blobId);
        break;
      case "group":
        openGroup(result.groupId);
        break;
      case "file":
        openConversation(result.blobId);
        setDetailOpen(true);
        break;
      case "routine":
        openConversation(result.blobId);
        setDetailView({ kind: "routine", routineId: result.routineId });
        setDetailOpen(true);
        break;
      case "link":
        // Same hand-off as clicking the link in a transcript: the OS browser,
        // never this webview. `opener`'s scope allowlist has the final say and
        // rejects anything outside it, which leaves the user where they are.
        openExternal(result.url).catch(() => {});
        break;
      case "action":
        if (result.action === "plugins") {
          setPluginsOpen(true);
        } else if (result.action === "chat-settings") {
          openSettings();
        } else {
          openSettingsModal(
            result.action === "settings-model"
              ? "model"
              : result.action === "settings-updates"
                ? "updates"
                : "general",
          );
        }
        break;
    }
  };

  // Hydrate the Blob that is actually on screen — which is `agent`, not
  // `selectedId`. On a fresh launch nothing is selected yet, so `agent` falls
  // back to the first row and its conversation renders; keying this off
  // `selectedId` meant that transcript never loaded, so the chat reopened
  // empty and the model was sent no history at all.
  const activeBlobId = agent?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies(mutateSent): stable (useCallback, no deps)
  useEffect(() => {
    if (activeBlobId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [routines, transcript] = await Promise.all([
        store.loadBlobRoutines(activeBlobId),
        store.loadBlobTranscript(activeBlobId),
      ]);
      if (cancelled) {
        return;
      }
      if (routines !== null) {
        setRoutinesByAgent((previous) =>
          previous[activeBlobId] === undefined
            ? { ...previous, [activeBlobId]: routines }
            : previous,
        );
      }
      if (transcript !== null) {
        mutateSent((previous) =>
          previous[activeBlobId] === undefined
            ? { ...previous, [activeBlobId]: transcript }
            : previous,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBlobId]);

  const selectedGroup = groups.find((candidate) => candidate.id === selectedGroupId);
  /**
   * The Blobs in a group, in roster order — which is also the order they
   * answer in. Hidden Blobs are not participants: a group chat with an
   * invisible member would be a conversation the user cannot audit.
   *
   * Through the roster ref, not render state: this is called per speaker from
   * inside a queued turn, and membership is exactly what may have changed
   * while the exchange waited its turn.
   */
  const membersOf = (group: Group): Agent[] =>
    agentsRef.current
      .filter((candidate) => candidate.hidden !== true && candidate.section === group.name)
      .slice(0, MAX_GROUP_MEMBERS);

  // Hydrate the open group's transcript, mirroring the per-Blob effect above.
  const activeGroupId = selectedGroup?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies(mutateSent): stable (useCallback, no deps)
  useEffect(() => {
    if (activeGroupId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const transcript = await store.loadGroupTranscript(activeGroupId);
      if (cancelled || transcript === null) {
        return;
      }
      const key = groupConversationId(activeGroupId);
      mutateSent((previous) =>
        previous[key] === undefined ? { ...previous, [key]: transcript } : previous,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [activeGroupId]);

  // Cmd/Ctrl+N starts a new Blob. Not bound while a modal owns the screen —
  // the palette would open behind it.
  useEffect(() => {
    if (searchOpen || settingsOpen || pluginsOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "n" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      setMode({ kind: "palette" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, settingsOpen, pluginsOpen]);

  const setAgentRoutines = (agentId: string, update: (current: Routine[]) => Routine[]) => {
    setRoutinesByAgent((previous) => {
      const next = update(previous[agentId] ?? []);
      store.saveBlobRoutines(agentId, next);
      // Keep the scheduler's mirror in sync in the same tick: it reads this
      // ref from a timer, outside React's render cycle.
      routinesRef.current = { ...routinesRef.current, [agentId]: next };
      return { ...previous, [agentId]: next };
    });
  };

  const createRoutine = (agentId: string) => {
    const routine: Routine = {
      id: `routine-${Date.now()}`,
      name: "",
      instruction: "",
      triggers: [],
      active: true,
    };
    setAgentRoutines(agentId, (current) => [...current, routine]);
    setDetailView({ kind: "routine", routineId: routine.id });
  };

  const updateRoutine = (agentId: string, routineId: string, patch: Partial<Routine>) => {
    setAgentRoutines(agentId, (current) =>
      current.map((candidate) => {
        if (candidate.id !== routineId) {
          return candidate;
        }
        const next = { ...candidate, ...patch };
        // (Re)arm on schedule edits; disarm when the schedule is removed.
        if ("schedule" in patch) {
          if (next.schedule === undefined) {
            delete next.nextRunAt;
          } else {
            next.nextRunAt = nextFireTime(next.schedule, Date.now());
          }
        }
        // Re-enabling a fired one-shot (or any disarmed routine) must re-arm
        // it, or it sits armed-less until the next app launch — armRoutines
        // only runs at startup.
        if (patch.active === true && next.schedule !== undefined && next.nextRunAt === undefined) {
          next.nextRunAt = nextFireTime(next.schedule, Date.now());
        }
        return next;
      }),
    );
  };

  const deleteRoutine = (agentId: string, routineId: string) => {
    setAgentRoutines(agentId, (current) =>
      current.filter((candidate) => candidate.id !== routineId),
    );
    setDetailView({ kind: "info" });
  };

  /**
   * Tool access to one Blob's routines: the write path when a Blob sets up
   * (or stops) its own scheduled work, from any turn's routine tools.
   *
   * Reads go through `routinesRef`, not state: a tool fires inside a turn,
   * outside the render cycle, and a render-scoped value would be stale the
   * moment two writes land in one turn. Writes go through `setAgentRoutines`,
   * which also flushes to disk and re-syncs the scheduler's mirror.
   */
  const routineAccess = (agentId: string): RoutineAccess => ({
    list: () => routinesRef.current[agentId] ?? [],
    create: (input) => {
      setAgentRoutines(agentId, (current) => [
        ...current,
        {
          id: `routine-${Date.now()}`,
          name: input.name,
          instruction: input.instruction,
          triggers: input.schedule === undefined ? [] : [describeSchedule(input.schedule)],
          active: true,
          ...(input.schedule === undefined
            ? {}
            : { schedule: input.schedule, nextRunAt: nextFireTime(input.schedule, Date.now()) }),
        },
      ]);
    },
    update: (name, patch) => {
      const wanted = name.trim().toLowerCase();
      const match = (routinesRef.current[agentId] ?? []).find(
        (candidate) => candidate.name.trim().toLowerCase() === wanted,
      );
      if (match === undefined) {
        return false;
      }
      setAgentRoutines(agentId, (current) =>
        current.map((candidate) => {
          if (candidate.id !== match.id) {
            return candidate;
          }
          const next: Routine = { ...candidate };
          if (patch.instruction !== undefined) {
            next.instruction = patch.instruction;
          }
          if (patch.schedule !== undefined) {
            next.schedule = patch.schedule;
            next.nextRunAt = nextFireTime(patch.schedule, Date.now());
            // A new schedule on a routine that fired its one-shot (or was
            // otherwise disarmed) is a request for it to run again: leaving it
            // inactive would have update_routine report a schedule that never
            // fires — the tool path's mirror of the panel's re-enable.
            if (!candidate.active && candidate.nextRunAt === undefined) {
              next.active = true;
            }
            // The trigger label is the schedule's display line; swap it so the
            // Routines list shows the new time, not the one it replaced.
            const oldLabel =
              candidate.schedule === undefined ? null : describeSchedule(candidate.schedule);
            next.triggers = [
              ...candidate.triggers.filter((label) => label !== oldLabel),
              describeSchedule(patch.schedule),
            ];
          }
          return next;
        }),
      );
      return true;
    },
    delete: (name) => {
      const wanted = name.trim().toLowerCase();
      const match = (routinesRef.current[agentId] ?? []).find(
        (candidate) => candidate.name.trim().toLowerCase() === wanted,
      );
      if (match === undefined) {
        return false;
      }
      setAgentRoutines(agentId, (current) => current.filter((c) => c.id !== match.id));
      return true;
    },
  });

  /**
   * Patch a Blob.
   *
   * `commitName` settles the name: unique, trimmed, addressable. It is the
   * *end* of a rename, not each keystroke of one — the name field is
   * controlled, so suffixing as the user types turns "Scout Two" into
   * "Scout 2" the moment it passes an existing "Scout", and strips the space
   * before the second word can be typed.
   */
  const updateBlob = (id: string, patch: Partial<Agent> & { commitName?: boolean }) => {
    const { commitName, ...fields } = patch;
    const named =
      commitName === true && fields.name !== undefined
        ? {
            ...fields,
            name:
              uniqueBlobName(
                fields.name,
                agentsRef.current
                  .filter((candidate) => candidate.id !== id)
                  .map((candidate) => candidate.name),
              ) ||
              // Blanked and left blank: a Blob with no name is unaddressable
              // and unreadable in the sidebar, so the old one stands.
              agentsRef.current.find((candidate) => candidate.id === id)?.name ||
              fields.name,
          }
        : fields;
    const next = commitAgents((previous) =>
      previous.map((candidate) => (candidate.id === id ? { ...candidate, ...named } : candidate)),
    );
    store.saveRoster(next);
    const updated = next.find((candidate) => candidate.id === id);
    if (updated !== undefined) {
      store.saveBlobConfig(id, updated);
    }
  };

  const createBlob = (name: string, tone: AvatarTone, shape: AgentShape) => {
    // The creator's submit is already disabled at the cap; this is the guard
    // for every other path into it.
    if (agents.length >= MAX_BLOBS) {
      return;
    }
    const blob: Agent = {
      id: newBlobId(),
      // Caps length (the creator does too) and keeps the name addressable.
      name: uniqueBlobName(
        name,
        agentsRef.current.map((candidate) => candidate.name),
      ),
      time: "Now",
      lastActivityAt: Date.now(),
      snippet: GREETING,
      tone,
      shape,
      // Dev server only: something to look at in the Memories dialog before a
      // Blob has learned anything. A production build must never claim to
      // remember things about a user it has never spoken to, and vitest also
      // runs with DEV set — seeding there would let this fixture define what
      // the tests think a fresh Blob knows.
      ...(import.meta.env.DEV && import.meta.env.MODE !== "test"
        ? { memories: SAMPLE_MEMORIES }
        : {}),
    };
    // Creation is not debounced: the roster and config must exist on disk
    // before anything else references the new id.
    void store.flushRoster(commitAgents((previous) => [blob, ...previous]));
    store.saveBlobConfig(blob.id, blob);
    openConversation(blob.id);
  };

  /**
   * The roster as a routine's tools may touch it (spawn_blob / delete_blob).
   * Reads go through the ref: a tool executes long after its render.
   *
   * A spawned Blob does NOT steal the view — the user may be reading another
   * conversation while a routine runs in the background. Deletion reuses
   * `deleteBlob`, whose store side is a soft delete to trash with a 30-day
   * TTL, so a wrong call is recoverable.
   */
  const rosterAccess: RosterAccess = {
    list: () => agentsRef.current.map(({ id, name }) => ({ id, name })),
    create: ({ name, title, description }) => {
      const blob: Agent = {
        id: newBlobId(),
        // Model-chosen, so the likeliest of all to collide with a sibling.
        name: uniqueBlobName(
          name,
          agentsRef.current.map((candidate) => candidate.name),
        ),
        title,
        description,
        time: "Now",
        lastActivityAt: Date.now(),
        snippet: GREETING,
        tone: "gray",
        shape: "sphere",
      };
      const next = commitAgents((previous) => [blob, ...previous]);
      // Not debounced: the id is referenced the moment the tool returns.
      void store.flushRoster(next);
      store.saveBlobConfig(blob.id, blob);
    },
    delete: deleteBlob,
    // Replaced per turn in `requestReply`, which is where the sender and its
    // hop count are known. Unreachable in practice; a refusal beats a throw.
    message: () => "Messaging another Blob is not available in this turn.",
  };

  /**
   * Deliver one Blob's hand-off to another: the request lands in the target's
   * own conversation and wakes it there, and the sender's turn moves on
   * without waiting (`turnQueue` runs the woken turn after the current one).
   *
   * `hop` is how many hand-offs deep this chain already is. Two Blobs that
   * keep passing work back would otherwise pin the one local model forever,
   * and the user's only lever is Stop.
   */
  const handOff = (
    from: Agent,
    targetId: string,
    message: { text: string; prompt: string },
    hop: number,
  ): string => {
    if (hop >= MAX_HANDOFF_HOPS) {
      return `That is ${MAX_HANDOFF_HOPS} hand-offs in a row. Finish this yourself or tell the user what is blocking it.`;
    }
    const target = agentsRef.current.find((candidate) => candidate.id === targetId);
    if (target === undefined) {
      return "That Blob no longer exists.";
    }
    const epoch = queuedTurnEpoch.current;
    void queueTurn(async () => {
      // Stop, pressed while the sender was still speaking, means this never
      // starts — otherwise another Blob picks up the work the user just
      // stopped, in a conversation they are not even looking at.
      if (queuedTurnEpoch.current !== epoch) {
        return "cancelled" as const;
      }
      // A hand-off can reach a Blob whose transcript was never opened this
      // session; hydrate through the ref first, exactly as `fireRoutine`
      // does, or the append below writes over real history.
      let sent = sentRef.current[target.id];
      if (sent === undefined) {
        sent = (await store.loadBlobTranscript(target.id)) ?? [];
        const loaded = sent;
        mutateSent((previous) =>
          previous[target.id] === undefined ? { ...previous, [target.id]: loaded } : previous,
        );
      }
      // Visible in the receiving conversation, so a hand-off is never work the
      // user cannot see happening.
      appendMessage(target.id, {
        id: `event-${crypto.randomUUID()}`,
        kind: "event",
        text: `${from.name}: ${message.text}`,
        timestampMs: Date.now(),
      });
      if (agent?.id !== target.id) {
        updateBlob(target.id, { unread: true });
      }
      // The fenced form, built beside `wrapUntrusted` in blob-tools — the
      // receiver must read this as data, not as orders from its user.
      return requestReply(target, [...transcriptFor(target), ...sent], {
        trigger: "routine",
        prompt: message.prompt,
        hop: hop + 1,
      });
    });
    return `Sent to ${target.name}. They will answer in their own conversation.`;
  };

  /**
   * Append to a conversation — a Blob's or a group's, addressed by the same
   * kind of id throughout (`sentByAgent` is keyed by conversation, not Blob).
   */
  const appendMessage = (conversationId: string, message: Message) => {
    mutateSent((previous) => {
      const next = [...(previous[conversationId] ?? []), message];
      store.saveConversation(conversationId, next);
      return { ...previous, [conversationId]: next };
    });
  };

  /** Reflect the newest message in the sidebar (timestamp + snippet). */
  const touchActivity = (agentId: string, snippet: string) => {
    updateBlob(agentId, {
      lastActivityAt: Date.now(),
      snippet: snippet.slice(0, 80),
    });
  };

  /** Record a run transition in state and on disk (fire-and-forget write). */
  const patchRun = (run: ActiveRun, status: ActiveRun["status"], extra?: Partial<ActiveRun>) => {
    const next: ActiveRun = { ...run, ...extra, status: assertTransition(run.status, status) };
    setRunsByBlob((previous) => ({ ...previous, [run.blobId]: next }));
    void store.saveBlobRun(run.blobId, next);
    return next;
  };

  /**
   * Stream the Blob's reply into the transcript. One of these runs at a time
   * app-wide (see `turnQueue`); `trigger` decides the tool scope — routine
   * and answer turns are autonomous, user turns are the tuned chat path.
   *
   * `group` moves the *conversation* without moving the Blob: the reply lands
   * in the group's transcript, while the run record, memories, usage and home
   * folder stay the speaking Blob's own.
   */
  const requestReply = async (
    target: Agent,
    history: Message[],
    turn?: {
      trigger: RunTrigger;
      routineId?: string;
      prompt?: string;
      group?: { id: string; name: string; members: readonly Agent[] };
      /**
       * The user named this Blob (`@Name`, or a reply to its message). Being
       * called on by name is an obligation — a Blob that stays out after
       * being asked directly reads as broken. Being picked by the router is
       * only an invitation.
       */
      mustAnswer?: boolean;
      /** Hand-offs deep this turn already is; caps Blob → Blob ping-pong. */
      hop?: number;
      /** Pre-made classification (groups): skips this turn's router and write. */
      intent?: Intent;
    },
  ): Promise<"done" | "failed" | "cancelled"> => {
    const trigger = turn?.trigger ?? "user";
    const group = turn?.group;
    // Where the words go. Everything else in this function stays keyed to the
    // Blob: one Blob can be mid-turn in a group and own a run of its own.
    const convoId = group === undefined ? target.id : groupConversationId(group.id);
    // Unique rather than time-based: bubble ids address individual messages
    // below, and two turns inside the same millisecond would collide.
    const replyId = `agent-${crypto.randomUUID()}`;
    // Read once, from the ref: a scheduled routine runs the mount-render
    // closure, where every one of these is still its mount-time value.
    const {
      model,
      userName,
      timezone,
      reasoning,
      userMemories,
      mcpServers,
      skills,
      connectedApps,
    } = turnSettings.current;
    if (model === "") {
      const text =
        "I don't have a model to think with yet \u2014 pick one in Settings \u2192 Model.";
      appendMessage(convoId, {
        id: replyId,
        kind: "text",
        author: "agent",
        segments: [{ text }],
        timestampMs: Date.now(),
        ...(group === undefined ? {} : { authorId: target.id }),
      });
      if (group === undefined) {
        touchActivity(target.id, text);
      }
      return "failed";
    }
    // One backend for the whole turn: attachment reads below and the fs tools
    // a routine turn gets both point at this Blob's sandbox.
    const home = homeFor(target.id);
    const aiMessages: AiMessage[] = [
      // Byte-stable across turns (no clock inside): the system prompt plus the
      // untrimmed history form the request prefix, and Ollama's KV cache only
      // hits while that prefix is identical to the previous turn's.
      {
        role: "system",
        content: blobSystemPrompt(
          target,
          { userName, timezone },
          {
            userMemories,
            // Named in the prompt for both scopes so the Blob knows what it
            // has; the tools themselves stay routine-only.
            mcpServers: mcpServers.map((server) => server.name),
            // Already sorted by the Rust side; passed through untouched so
            // the cached prompt prefix stays byte-identical between turns.
            skills: skills.map(skillLine),
            connectedApps,
            ...(group === undefined
              ? {}
              : {
                  group: {
                    name: group.name,
                    others: group.members
                      .filter((member) => member.id !== target.id)
                      .map((member) => member.name),
                  },
                }),
          },
        ),
      },
      // Attachment text is read back from the home folder and inlined into
      // the message that carried it — the chat catalog has no file tool, so
      // this is the only way an attachment reaches the model there. Per-message
      // and content-stable, so the cached prefix survives; trimHistory sizes
      // the result like any other history, against this model's own window.
      ...trimHistory(
        await Promise.all(
          history
            .filter((entry): entry is Extract<Message, { kind: "text" }> => entry.kind === "text")
            .map(async (entry): Promise<AiMessage> => {
              // In a group, another Blob's line is not this Blob's own output:
              // it arrives in the user role, labelled with who said it (the
              // system prompt explains the labels). Only this Blob's own
              // messages are the assistant.
              const own =
                entry.author === "agent" && (group === undefined || entry.authorId === target.id);
              const role = own ? ("assistant" as const) : ("user" as const);
              const speaker =
                own || entry.author === "user" || group === undefined
                  ? undefined
                  : group.members.find((member) => member.id === entry.authorId)?.name;
              const body = entry.segments.map((segment) => segment.text).join("");
              const said = speaker === undefined ? body : `[${speaker}]: ${body}`;
              const block = await attachmentsPrompt(home, entry.attachments ?? []);
              // An attachment-only message has no words of its own; a leading
              // blank line in its place is noise the model has to read past.
              const content = [said, block].filter((part) => part !== "").join("\n\n");
              return { role, content };
            }),
        ),
        contextWindow(model),
      ),
    ];
    // Routine (and answer-to-routine) turns carry the instruction as the
    // prompt; it is not a visible transcript message — the event line is.
    if (turn?.prompt !== undefined) {
      aiMessages.push({ role: "user", content: turn.prompt });
    }
    // In a group, the newest message is often another Blob's reply, and a
    // model answers the newest thing it sees: measured at 50% on qwen3.5:2b,
    // the second and third speakers greeted each other while the person who
    // actually spoke was left out. The system prompt says whose message to
    // answer; this repeats it where the model is looking. Same mechanism as
    // a routine's prompt — a trailing instruction, not a transcript message.
    if (group !== undefined) {
      const asked = [...history]
        .reverse()
        .find((entry) => entry.kind === "text" && entry.author === "user");
      if (asked?.kind === "text") {
        const said = asked.segments
          .map((segment) => segment.text)
          .join("")
          .replace(/\s+/g, " ")
          .slice(0, GROUP_FOCUS_CHARS);
        aiMessages.push({
          role: "user",
          content:
            `[Answer ${userName}, who said: “${said}”. Anything after it is a ` +
            "colleague replying to that same message \u2014 never answer a " +
            "colleague." +
            // The PASS rule is repeated here, not only in the system prompt,
            // because this line is the last thing the model reads: on
            // qwen3.5:9b a bare "answer the user" here overrode it and all
            // three members said "210 euros" in turn, each having just read
            // the one before it say exactly that. Withheld when the user named
            // this Blob — with the reminder present, a directly asked Blob
            // passed instead of answering.
            // The hand-off offer rides with the obliged branch, because that
            // is when it is needed: the router picks one Blob for a two-task
            // message ("check X, then write it up"), so without this the
            // second job silently never happens. Fixing that in
            // `pickResponders` was tried three ways and regressed the 2b every
            // time (see intent.ts).
            //
            // "TWO different kinds of work" is load-bearing, not padding. The
            // broad version ("if part of this is another Blob's job") made the
            // 2b hand off a plain one-task question too, turning "what did
            // hosting cost?" into a wake-up call for a colleague. Measured on
            // :2b and :9b: broad won the two-task case and lost the one-task
            // case; this wording wins both on the 2b.
            (turn?.mustAnswer === true
              ? ` ${userName} asked you by name, so answer — do not pass. If it ` +
                "asks for TWO different kinds of work and one is a colleague's, do " +
                'your part, then end with "@Name" to hand over the rest. Otherwise ' +
                "just answer.]"
              : " If one of them has already answered it, or you would only be " +
                "agreeing or greeting, reply with exactly PASS.]"),
        });
      }
    }
    // The clock changes every minute, so it rides on the newest user message
    // ONLY — after everything cached, never in the system prompt and never on
    // an older history message, which would re-prefill the whole transcript
    // (see timeNote).
    const newest = aiMessages[aiMessages.length - 1];
    if (newest !== undefined && newest.role === "user" && typeof newest.content === "string") {
      newest.content = `${newest.content}\n\n${timeNote({ userName, timezone })}`;
    }

    // The run record exists on disk BEFORE the model runs, so a crash mid-turn
    // is visible on the next launch instead of silently vanishing.
    const waiting = runsRef.current[target.id];
    let run: ActiveRun =
      trigger === "answer" && waiting !== undefined && waiting.status === "waiting_input"
        ? patchRun(waiting, "running", { trigger, prompt: turn?.prompt ?? "" })
        : (() => {
            const fresh: ActiveRun = {
              id: `run-${Date.now()}`,
              blobId: target.id,
              trigger,
              prompt: turn?.prompt ?? "",
              ...(turn?.routineId === undefined ? {} : { routineId: turn.routineId }),
              startedAt: Date.now(),
              status: "running",
            };
            setRunsByBlob((previous) => ({ ...previous, [target.id]: fresh }));
            void store.saveBlobRun(target.id, fresh);
            return fresh;
          })();

    const abort = new AbortController();
    const steering: AiMessage[] = [];
    activeTurn.current = { blobId: target.id, abort, steering };

    let text = "";
    // Boxed, not a bare let: TS ignores assignments made inside the onAsk
    // callback and would otherwise narrow the variable to null for good.
    const askBox: { value: { question: string; kind: "question" | "action" } | null } = {
      value: null,
    };
    /** Bubbles appended so far; failure notes land on the newest one. */
    let bubbleCount = 0;
    /**
     * One bubble per completed speech segment. Segments arrive whole from
     * streamBlobTurn (never token by token), so each call appends a finished
     * bubble rather than patching a growing one.
     */
    const appendSegment = (rawContent: string) => {
      // A Blob signing its own name is dropped here rather than in the prompt:
      // qwen3.5:2b opens with “@Ken …” 3/3 however the rule is worded (measured,
      // both wordings, both prompt lengths). Only the first bubble is checked —
      // that is where a signature goes, and mid-reply the same text is far more
      // likely to be a real hand-off to a colleague.
      const content =
        group === undefined || bubbleCount > 0
          ? rawContent
          : stripSelfMention(rawContent, target.name);
      if (content.trim() === "") {
        return;
      }
      text = text === "" ? content : `${text}\n\n${content}`;
      const id = `${replyId}-${++bubbleCount}`;
      mutateSent((previous) => {
        const bubble: Message = {
          id,
          kind: "text",
          author: "agent",
          segments: [{ text: content }],
          timestampMs: Date.now(),
          // Who spoke, so a group transcript can show it — and so the next
          // member's turn can tell its own lines from everyone else's.
          ...(group === undefined ? {} : { authorId: target.id }),
          ...(askBox.value === null ? {} : { ask: askBox.value.kind }),
        };
        return { ...previous, [convoId]: [...(previous[convoId] ?? []), bubble] };
      });
    };
    /** Attach a failure note to the newest bubble, or open one when nothing was said. */
    const noteStopped = (note: string) => {
      if (bubbleCount === 0) {
        appendSegment(note);
        return;
      }
      const id = `${replyId}-${bubbleCount}`;
      mutateSent((previous) => {
        const next = (previous[convoId] ?? []).map((entry) =>
          entry.id === id && entry.kind === "text"
            ? { ...entry, segments: [{ text: `${entry.segments[0]?.text ?? ""}${note}` }] }
            : entry,
        );
        return { ...previous, [convoId]: next };
      });
    };
    /** Flush the partial transcript at safe points (gg-agent checkpoints). */
    const flushTranscript = () => {
      store.saveConversation(convoId, sentRef.current[convoId] ?? []);
    };
    let outcome: "done" | "failed" | "cancelled" = "done";
    // Summed, not assigned: a turn can run the loop more than once (the
    // no-tools retry, the rescue round) and each reports its own total.
    const spent = { inputTokens: 0, outputTokens: 0 };
    setThinkingFor(target.id);
    // First turn pays one lazy chunk fetch for the provider stack; after
    // that the memoized import resolves from the module cache.
    const [{ isAbortError, streamBlobTurn }, { reconcileMemories }] = await Promise.all([
      loadAi(),
      loadIntent(),
    ]);
    try {
      text = await streamBlobTurn({
        model,
        messages: aiMessages,
        thinking: reasoning,
        forceConfigure:
          trigger === "user" && (target.title ?? "") === "" && (target.description ?? "") === "",
        scope: trigger === "user" ? "chat" : "routine",
        ...(turn?.intent === undefined ? {} : { intent: turn.intent }),
        home,
        roster: {
          access: {
            ...rosterAccess,
            message: (id, message) => handOff(target, id, message, turn?.hop ?? 0),
          },
          selfName: target.name,
        },
        routines: routineAccess(target.id),
        mcpServers,
        // Three meta-tools, gated on having something to reach.
        hasConnectedApps: connectedApps.length > 0,
        signal: abort.signal,
        getSteeringMessages: () => (steering.length === 0 ? null : steering.splice(0)),
        onAsk: (pending) => {
          askBox.value = pending;
        },
        onCheckpoint: flushTranscript,
        onUsage: (usage) => {
          spent.inputTokens += usage.inputTokens;
          spent.outputTokens += usage.outputTokens;
        },
        memory: {
          // Read through the ref so mid-turn saves see the latest list.
          list: () =>
            agentsRef.current.find((candidate) => candidate.id === target.id)?.memories ?? [],
          save: (memories) => updateBlob(target.id, { memories }),
          // Let the model judge which saved facts a new one makes untrue, so
          // memory reflects the user's life now rather than a pile of history.
          reconcile: (fact, existing) => reconcileMemories({ model, fact, existing }),
        },
        onSegment: (segment) => appendSegment(segment),
        // The Blob configures itself: the same patch path the settings panel
        // uses, so title/description show up there immediately.
        onConfigure: (patch) => updateBlob(target.id, patch),
      });
      const asked = askBox.value;
      if (asked !== null) {
        // The reply IS the question; the run parks until the user answers.
        // Its tokens ride along, so the answer turn resumes from this total
        // instead of from zero — the settle block below adds to them.
        run = patchRun(run, "waiting_input", {
          question: asked.question,
          askKind: asked.kind,
          inputTokens: (run.inputTokens ?? 0) + spent.inputTokens,
          outputTokens: (run.outputTokens ?? 0) + spent.outputTokens,
        });
        spent.inputTokens = 0;
        spent.outputTokens = 0;
      } else if (text.trim() === "") {
        // Every rescue inside streamBlobTurn has already been tried by here.
        text =
          "I couldn't put a reply together for that. Try asking again, or in " +
          "smaller pieces \u2014 smaller models sometimes stall on broad questions.";
        appendSegment(text);
      }
    } catch (error) {
      if (isAbortError(error)) {
        // Stopped by the user: the completed bubbles stay as they are.
        outcome = "cancelled";
        if (text.trim() === "") {
          text = "(stopped)";
          appendSegment(text);
        }
      } else {
        outcome = "failed";
        // Whitespace-only counts as nothing said, matching the check above.
        const unreachable = isTinfoilModel(model)
          ? "I couldn't reach Tinfoil. Check your connection and API key in Settings \u2192 Model."
          : "I couldn't reach the local model. Check that Ollama is running in Settings \u2192 Model.";
        if (text.trim() === "") {
          text = unreachable;
          appendSegment(text);
        } else {
          text = `${text}\u2026 (the model stopped responding)`;
          noteStopped("\u2026 (the model stopped responding)");
        }
      }
    } finally {
      activeTurn.current = null;
      setThinkingFor(null);
    }
    // A run parked on a question resumes in a later turn (trigger "answer")
    // on the SAME run record, so this turn's spend is added to what earlier
    // legs already cost. Overwriting instead would drop every token spent
    // before the ask from both the per-run and the lifetime number.
    const runTotal = {
      inputTokens: (run.inputTokens ?? 0) + spent.inputTokens,
      outputTokens: (run.outputTokens ?? 0) + spent.outputTokens,
    };
    if (run.status === "running") {
      run = patchRun(run, outcome, runTotal);
    } else if (run.status === "waiting_input" && outcome === "cancelled") {
      run = patchRun(run, "cancelled", runTotal);
    }
    // Lifetime total, folded in once — at the run's terminal state, counting
    // every leg. A run still parked on a question is not counted yet.
    if (isTerminal(run.status) && runTotal.inputTokens + runTotal.outputTokens > 0) {
      const previous = agentsRef.current.find((candidate) => candidate.id === target.id)?.usage;
      updateBlob(target.id, {
        usage: {
          inputTokens: (previous?.inputTokens ?? 0) + runTotal.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + runTotal.outputTokens,
          runs: (previous?.runs ?? 0) + 1,
        },
      });
    }
    // Background work that settled while the user was elsewhere: a routine
    // that finished or failed, or a question now blocking the run. Focus is
    // read here, at the moment it settles, not when the turn started.
    if (
      shouldNotify({
        trigger,
        status: run.status,
        windowFocused: document.hasFocus(),
        blobOptedIn: target.notifications,
      })
    ) {
      void notify(target.name, run.status === "waiting_input" ? (run.question ?? text) : text);
    }
    // A group reply is not news about the Blob's own conversation, so it must
    // not overwrite that row's snippet in the sidebar.
    if (group === undefined) {
      touchActivity(target.id, text);
    }
    // Persist once the reply settled; per-delta saves would thrash the store.
    flushTranscript();
    // Only a routine turn carries file tools, so only it can have written
    // something the Files list is not showing yet.
    if (trigger !== "user") {
      setFilesKey((key) => key + 1);
    }
    return run.status === "waiting_input" ? "done" : outcome;
  };

  /** FIFO for turns: one model serves everything, so turns never overlap. */
  const queueTurn = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = turnQueue.current.then(work);
    turnQueue.current = next.catch(() => {});
    return next;
  };

  /**
   * Stop the in-flight turn (keeps any partial text) and everything queued
   * behind it — the rest of a group's members, a hand-off waiting to wake
   * another Blob. "Stop" has to mean the whole exchange, not just whoever
   * happens to be speaking.
   */
  const stopTurn = () => {
    queuedTurnEpoch.current += 1;
    activeTurn.current?.abort.abort();
  };

  /** The user's message, as it goes into the transcript. */
  const userMessage = (
    text: string,
    reply: { replyTo?: string; replyToId?: string } | undefined,
    attachments: Attachment[],
  ): Extract<Message, { kind: "text" }> => ({
    // Unique rather than time-based: this id addresses the message for the
    // attachment patch below, and two sends inside the same millisecond would
    // otherwise collide and patch each other.
    id: `sent-${crypto.randomUUID()}`,
    kind: "text",
    author: "user",
    segments: [{ text }],
    timestampMs: Date.now(),
    ...(reply?.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    ...(reply?.replyToId === undefined ? {} : { replyToId: reply.replyToId }),
    ...(attachments.length === 0 ? {} : { attachments }),
  });

  /** Swap placeholder attachments for the ones that actually got saved. */
  const settleAttachments = (conversationId: string, id: string, attachments: Attachment[]) => {
    mutateSent((previous) => {
      const next = (previous[conversationId] ?? []).map((entry) =>
        entry.id === id && entry.kind === "text" ? { ...entry, attachments } : entry,
      );
      store.saveConversation(conversationId, next);
      return { ...previous, [conversationId]: next };
    });
  };

  /** Take back a message whose files all turned out to be unreadable. */
  const dropMessage = (conversationId: string, id: string) => {
    mutateSent((previous) => {
      const next = (previous[conversationId] ?? []).filter((entry) => entry.id !== id);
      store.saveConversation(conversationId, next);
      return { ...previous, [conversationId]: next };
    });
  };

  /**
   * Get a reply going for a message already in the transcript.
   *
   * Any attachments are saved in the Blob's home folder by here; the message
   * carries only their names (see lib/attachments).
   */
  const startTurn = (target: Agent, message: Extract<Message, { kind: "text" }>) => {
    const text = message.segments.map((segment) => segment.text).join("");
    const attachments = message.attachments ?? [];
    // Follow-up: this Blob is mid-turn, so the message steers the running
    // loop (gg-agent folds it in between tool rounds) — no second turn.
    // The running loop never re-reads history, so a steering message has to
    // carry its own attachment text; with no files the push stays synchronous,
    // so a plain follow-up still reaches the very next tool round.
    if (activeTurn.current?.blobId === target.id) {
      const turn = activeTurn.current;
      if (attachments.length === 0) {
        turn.steering.push({ role: "user", content: text });
        return;
      }
      void attachmentsPrompt(homeFor(target.id), attachments).then((block) => {
        turn.steering.push({
          role: "user",
          content: [text, block].filter((part) => part !== "").join("\n\n"),
        });
      });
      return;
    }
    const waiting = runsRef.current[target.id];
    const answering = waiting !== undefined && waiting.status === "waiting_input";
    void queueTurn(() => {
      // Read history through the ref: this may run after other queued turns.
      const sent = sentRef.current[target.id] ?? [];
      // ...but the ref only refreshes on re-render, so the snapshot can either
      // be missing this message or still hold its pre-extraction copy, whose
      // attachments include files that were then rejected. The caller's copy
      // is the settled one, so it wins.
      const own = sent.some((entry) => entry.id === message.id)
        ? sent.map((entry) => (entry.id === message.id ? message : entry))
        : [...sent, message];
      const history = [...transcriptFor(target), ...own];
      return requestReply(
        target,
        history,
        answering
          ? {
              trigger: "answer",
              ...(waiting.routineId === undefined ? {} : { routineId: waiting.routineId }),
            }
          : undefined,
      );
    });
  };

  /**
   * Send into a group chat: one user message in the shared transcript, then
   * one turn per responder, in order, each seeing what the ones before it
   * said.
   *
   * Who is *brought in*, in order of authority: an `@mention` or a reply
   * (certain, no model call), else the router picks by job
   * (`pickResponders`), else — only if the router is unreachable — everyone.
   * A responder can then hand the next step to one teammate by *opening* its
   * reply with `@Name` (`handoffTarget`), which is how work crosses a group
   * visibly; each Blob speaks at most once, so the exchange always ends.
   *
   * Who actually *speaks* is then the Blob's own call: anyone but a Blob the
   * user named may answer `PASS`, and its bubbles come back off the screen.
   * Being brought in is an invitation — being named is not.
   *
   * Attachments are not carried here: a file is saved in one Blob's home
   * folder and inlined from there, and a group has no home of its own (the
   * composer hides the attach button for a group).
   */
  const sendToGroup = (
    group: Group,
    text: string,
    reply: { replyTo?: string; replyToId?: string },
  ) => {
    const convoId = groupConversationId(group.id);
    const members = membersOf(group);
    const message = userMessage(text, reply, []);
    appendMessage(convoId, message);
    if (members.length === 0) {
      appendMessage(convoId, {
        id: `event-${crypto.randomUUID()}`,
        kind: "event",
        text: "No Blobs in this group yet \u2014 drag some into it in the sidebar.",
        timestampMs: Date.now(),
      });
      return;
    }
    const repliedTo = (sentRef.current[convoId] ?? []).find(
      (entry) => entry.id === reply.replyToId,
    );
    const addressing = {
      text,
      ...(repliedTo?.kind === "text" && repliedTo.authorId !== undefined
        ? { replyToAuthorId: repliedTo.authorId }
        : {}),
    };
    const addressed = addressedResponders(members, addressing);
    // Addressed by name, by @everyone, or by a reply — those must answer.
    // Only a Blob the router *chose* may stay out.
    const spokenTo = namedResponders(members, addressing);
    const epoch = queuedTurnEpoch.current;
    // One queued task for the whole exchange, not one per member: the router
    // has to run before the first speaker is known, and a later speaker may
    // only be added once an earlier one has spoken.
    void queueTurn(async () => {
      if (queuedTurnEpoch.current !== epoch) {
        return "cancelled" as const;
      }
      // One classification for the whole exchange, applied to the SHARED
      // memory scope. Per-responder routing would have each Blob save its own
      // private copy of the same sentence, reconciled separately against its
      // own list — six drifting versions of one thing the user said once. A
      // fact told to a room belongs to the room, and every Blob already reads
      // the shared scope.
      let intent: Intent | undefined;
      if (turnSettings.current.model !== "") {
        const { routeIntent, applyGroupIntent } = await loadIntent();
        try {
          intent = await routeIntent({
            model,
            messages: [{ role: "user", content: text }],
            memories: userMemoriesRef.current,
          });
          const next = await applyGroupIntent(intent, {
            model,
            memories: userMemoriesRef.current,
          });
          if (next !== null) {
            userMemoriesRef.current = next;
            setUserMemories(next);
            store.saveUserMemories(next);
          }
        } catch {
          // A classifier problem must not swallow the message. Left
          // undefined, each responder falls back to routing for itself — the
          // pre-group behaviour, noisier but never silent.
          intent = undefined;
        }
      }
      let queue: Agent[];
      if (turnSettings.current.model === "") {
        // Nobody can answer without a model, and six Blobs each saying so is
        // six copies of one app-level problem. One speaker delivers it.
        queue = members.slice(0, 1);
      } else if (addressed !== null) {
        queue = addressed;
      } else {
        const { pickResponders } = await loadIntent();
        // Labelled lines, so "and what did that cost?" is routable at all:
        // the subject may be three messages back.
        const recent = (sentRef.current[convoId] ?? [])
          .filter((entry): entry is Extract<Message, { kind: "text" }> => entry.kind === "text")
          .slice(-GROUP_ROUTER_CONTEXT, -1)
          .map((entry) => {
            const who =
              entry.author === "user"
                ? userName
                : (members.find((candidate) => candidate.id === entry.authorId)?.name ?? "a Blob");
            return `${who}: ${entry.segments.map((segment) => segment.text).join("")}`;
          });
        const picked = await pickResponders({ model, text, members, recent });
        queue = members.filter((member) => picked.includes(member.name));
      }
      // Read before the loop: a hand-off appends to the queue, and a Blob that
      // was alone when asked does not stop being alone because it pulled
      // someone in afterwards.
      const pickedCount = queue.length;
      const note = (text: string) =>
        appendMessage(convoId, {
          id: `event-${crypto.randomUUID()}`,
          kind: "event",
          text,
          timestampMs: Date.now(),
        });
      // The router picked nobody at all — so no name to report, unlike a Blob
      // that ran and stayed out. Still said out loud: a group where nothing
      // happens is indistinguishable from a broken one, and the fix is one @
      // away.
      const nobodySpoke = () =>
        note("No one here picked this up \u2014 @ a Blob to ask them directly.");
      if (queue.length === 0) {
        nobodySpoke();
        return "done" as const;
      }
      const spoken = new Set<string>();
      /**
       * Members that ran and chose to stay out.
       *
       * Named on screen afterwards, because the thinking blob has already
       * appeared by then: a Blob that visibly starts and then vanishes with
       * no trace is indistinguishable from one that crashed.
       */
      const passed: string[] = [];
      let answered = false;
      let outcome: "done" | "failed" | "cancelled" = "done";
      while (queue.length > 0) {
        const member = queue.shift();
        if (member === undefined || spoken.has(member.id)) {
          continue;
        }
        spoken.add(member.id);
        if (queuedTurnEpoch.current !== epoch) {
          return "cancelled" as const;
        }
        // Membership re-read per speaker, never the list captured at send
        // time: an exchange runs several turns and may start well after the
        // message was sent, so a Blob can be dragged out, hidden, deleted or
        // renamed in between. Speaking on behalf of a group it has left — or
        // introducing itself to the model under a stale name — is worse than
        // one fewer voice.
        //
        // Read through the *live* group, because membership is keyed by name:
        // after a rename its members carry the new one, and the captured
        // group would match nobody at all.
        const live = groupsRef.current.find((candidate) => candidate.id === group.id) ?? group;
        const roster = membersOf(live);
        const speaker = roster.find((candidate) => candidate.id === member.id);
        if (speaker === undefined) {
          continue;
        }
        // Read at turn time, so each member sees the replies before it. The
        // ref only refreshes on render, so the first member may not find its
        // own prompt in there yet.
        const sent = sentRef.current[convoId] ?? [];
        const history = sent.some((entry) => entry.id === message.id) ? sent : [...sent, message];
        const obliged = spokenTo.has(member.id);
        outcome = await requestReply(speaker, history, {
          trigger: "user",
          group: { id: group.id, name: live.name, members: roster },
          // The sole picked Blob owes an answer as surely as a named one: PASS
          // means "someone else has this", and there is nobody else. Told up
          // front rather than caught after — qwen3.5:2b passed on "what did
          // hosting cost last month?" in 3 of 5 runs, leaving the room silent.
          ...(owesAnswer({ addressed: obliged, pickedCount }) ? { mustAnswer: true } : {}),
          ...(intent === undefined ? {} : { intent }),
        });
        // What this member just said, as its own bubbles.
        const bubbles = (sentRef.current[convoId] ?? [])
          .slice(sent.length)
          .filter((entry) => entry.kind === "text" && entry.authorId === member.id);
        const said = bubbles
          .flatMap((entry) => (entry.kind === "text" ? entry.segments : []))
          .map((segment) => segment.text)
          .join(" ");
        // It declined — which only a Blob the *router* picked may do. The
        // bubbles come off the screen rather than showing a bare "PASS", and
        // the Blob stays in `spoken` so a colleague cannot hand it the same
        // message again; the note below is what keeps it from looking like a
        // Blob that started and crashed.
        //
        // A Blob the user addressed (@Name, @everyone, a reply) owes an
        // answer. If the model emits the token anyway, that reply stands: a
        // visible stray "PASS" is a prompt problem the user can see, whereas
        // deleting it hides that the Blob answered at all.
        //
        // The sole picked Blob owes one too, for the same reason: PASS means
        // “someone else has this”, and there is nobody else. Measured on
        // qwen3.5:2b, which passed on “what did hosting cost last month?” in
        // 3 of 5 runs — the router had picked exactly one Blob, so the room
        // answered a direct question with silence.
        if (!owesAnswer({ addressed: obliged, pickedCount }) && isPass(said)) {
          for (const bubble of bubbles) {
            dropMessage(convoId, bubble.id);
          }
          passed.push(member.name);
          continue;
        }
        answered = true;
        // Somebody spoke here. An exchange runs several turns and the user
        // often switches away mid-way, so the sidebar has to show the room
        // moved on — unless they are looking straight at it.
        if (selectedGroupIdRef.current !== group.id) {
          markGroupUnread(group.id);
        }
        // If it handed the next step to a teammate, that teammate speaks next
        // — the visible hand-off a group is for. `handoffTarget` is
        // deliberately strict (sentence-opening, one at most) and `spoken`
        // caps each Blob at one turn, so an exchange always ends.
        const pulled = handoffTarget(said, roster, spoken);
        if (pulled !== null) {
          queue.push(pulled);
        }
      }
      if (outcome !== "done") {
        return outcome;
      }
      // Whoever stayed out has to leave a trace: its thinking blob already
      // appeared, and vanishing without one reads as a Blob that crashed. One
      // line for the exchange, not one per Blob.
      if (passed.length > 0) {
        const who =
          passed.length === 1
            ? passed[0]
            : `${passed.slice(0, -1).join(", ")} and ${passed.at(-1)}`;
        note(
          answered
            ? `${who} had nothing to add.`
            : `${who} had nothing to add \u2014 @ a Blob to ask them directly.`,
        );
      } else if (!answered) {
        nobodySpoke();
      }
      return outcome;
    });
  };

  const sendMessage = (
    text: string,
    options?: { replyTo?: string; replyToId?: string; files?: readonly PickedFile[] },
  ) => {
    const files = options?.files;
    const reply = {
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      ...(options?.replyToId === undefined ? {} : { replyToId: options.replyToId }),
    };
    const attaching = files !== undefined && files.length > 0;
    // Fat-finger guard: an identical send within half a second is a bounce.
    // Attachments are exempt — the same caption twice with different files is
    // two real messages.
    const now = Date.now();
    if (!attaching && lastSend.current?.text === text && now - lastSend.current.at < 500) {
      return;
    }
    lastSend.current = { text, at: now };
    if (selectedGroup !== undefined) {
      sendToGroup(selectedGroup, text, reply);
      return;
    }
    if (agent === undefined) {
      return;
    }
    const target = agent;
    if (!attaching) {
      const message = userMessage(text, reply, []);
      appendMessage(target.id, message);
      touchActivity(target.id, text);
      startTurn(target, message);
      return;
    }
    // The message goes up straight away, carrying the files it came with.
    // Reading them is the slow part — a PDF parse, or seconds per page of OCR
    // — and making the user watch their own message wait on that felt broken.
    // Names are made unique the way `saveAttachments` will make them unique
    // anyway: picking one file twice must not render as two identical chips.
    const claimed = new Set<string>();
    const pending = files.map(({ file, preview }) => {
      const base = attachmentName(file.name);
      let name = base;
      for (let suffix = 1; claimed.has(name); suffix++) {
        name = `${base}-${suffix}`;
      }
      claimed.add(name);
      // The composer's thumbnail rides along, so an image is a picture from the
      // first paint — it animates in with the message rather than replacing a
      // file card a moment later.
      return { name, bytes: file.size, ...(preview === undefined ? {} : { preview }) };
    });
    const message = userMessage(text, reply, pending);
    appendMessage(target.id, message);
    touchActivity(target.id, text.trim() === "" ? pending.map((p) => p.name).join(", ") : text);
    setReadingMessages((ids) => [...ids, message.id]);
    void saveAttachments(homeFor(target.id), files)
      .then(({ saved, rejected }) => {
        setReadingMessages((ids) => ids.filter((id) => id !== message.id));
        if (rejected.length > 0) {
          appendMessage(target.id, {
            id: `event-${Date.now()}`,
            kind: "event",
            text: rejectionNote(rejected),
            timestampMs: Date.now(),
          });
        }
        if (saved.length > 0) {
          setFilesKey((key) => key + 1);
        }
        // Nothing readable and nothing said: the message had no content of its
        // own, so it comes back out rather than sitting there empty.
        if (saved.length === 0 && text.trim() === "") {
          dropMessage(target.id, message.id);
          return;
        }
        settleAttachments(target.id, message.id, saved);
        startTurn(target, { ...message, attachments: saved });
      })
      .catch(() => {
        // saveAttachments is written not to throw, but if it ever does the chips
        // must not read "reading…" forever.
        setReadingMessages((ids) => ids.filter((id) => id !== message.id));
        appendMessage(target.id, {
          id: `event-${Date.now()}`,
          kind: "event",
          text: "Those files couldn't be read.",
          timestampMs: Date.now(),
        });
      });
  };

  /**
   * Fire one routine: event line in the transcript, then an autonomous turn
   * with the instruction as the prompt. Called by the scheduler (claimed
   * before this runs) and by the Test-run button.
   */
  const fireRoutine = async (
    blobId: string,
    routine: Routine,
  ): Promise<"done" | "failed" | "cancelled"> => {
    const target = agentsRef.current.find((candidate) => candidate.id === blobId);
    if (target === undefined || routine.instruction.trim() === "") {
      return "failed";
    }
    // A routine can fire for a Blob whose transcript was never opened this
    // session; hydrate it first so the reply lands in real history. Kept in a
    // local too: the ref only refreshes on re-render, after this function.
    let sent = sentRef.current[blobId];
    if (sent === undefined) {
      sent = (await store.loadBlobTranscript(blobId)) ?? [];
      const loaded = sent;
      // Through the ref, not setState: `appendMessage` below reads the ref,
      // and a hydration that only landed in React state would be overwritten
      // by the very next append — wiping the transcript it just loaded.
      mutateSent((previous) =>
        previous[blobId] === undefined ? { ...previous, [blobId]: loaded } : previous,
      );
    }
    appendMessage(blobId, {
      id: `event-${Date.now()}`,
      kind: "event",
      text: `Routine: ${routine.name.trim() === "" ? "unnamed" : routine.name}`,
      timestampMs: Date.now(),
    });
    // Unread dot for a Blob working in the background.
    if (agent?.id !== blobId) {
      updateBlob(blobId, { unread: true });
    }
    const history = [...transcriptFor(target), ...sent];
    return requestReply(target, history, {
      trigger: "routine",
      routineId: routine.id,
      prompt: routine.instruction,
    });
  };

  const composing = activeMode.kind !== "chat";

  return (
    <div className="app-shell">
      <Sidebar
        agents={agents}
        selectedId={composing || selectedGroup !== undefined ? null : (agent?.id ?? null)}
        groups={groups}
        selectedGroupId={selectedGroupId}
        onSelectGroup={openGroup}
        onChangeGroups={changeGroups}
        onRenameGroup={renameGroup}
        composing={composing}
        userName={userName}
        onSelect={openConversation}
        onStartCompose={() => setMode({ kind: "palette" })}
        onOpenSettings={() => openSettingsModal("general")}
        onOpenPlugins={() => setPluginsOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        onUpdateBlob={updateBlob}
        onEditProfile={editBlobProfile}
        onDuplicate={duplicateBlob}
        onDelete={deleteBlob}
      />
      {activeMode.kind === "creator" ? (
        <CreatorPane
          // Remount when the palette hands over a different prefill.
          key={activeMode.initialName}
          initialName={activeMode.initialName}
          atCapacity={agents.length >= MAX_BLOBS}
          onCreate={createBlob}
        />
      ) : null}
      {activeMode.kind === "palette" ? (
        <ComposePane
          agents={agents}
          onOpen={openConversation}
          onCreate={(name) => setMode({ kind: "creator", initialName: name })}
          onCreateGroup={createGroup}
          onCancel={() => setMode({ kind: "chat" })}
        />
      ) : null}
      {activeMode.kind === "chat" && selectedGroup !== undefined && agent !== undefined ? (
        (() => {
          const members = membersOf(selectedGroup);
          const speaking = members.find((member) => member.id === thinkingFor);
          return (
            <ChatPane
              agent={members[0] ?? agent}
              group={{ id: selectedGroup.id, name: selectedGroup.name, members }}
              onRenameGroup={(name) => renameGroup(selectedGroup.id, name)}
              messages={sentByAgent[groupConversationId(selectedGroup.id)] ?? []}
              thinking={speaking !== undefined}
              {...(speaking === undefined ? {} : { thinkingAgent: speaking })}
              model={model}
              onModelChange={changeModel}
              reasoning={reasoning}
              onReasoningChange={changeReasoning}
              onSend={sendMessage}
              onStop={stopTurn}
              detailOpen={false}
              onToggleDetail={() => {}}
              onOpenSettings={openSettings}
            />
          );
        })()
      ) : activeMode.kind === "chat" && agent !== undefined ? (
        <ChatPane
          // No key: remounting on agent switch would replay pane-fade-in over
          // the whole chat. ChatPane resets its own per-conversation state
          // when agent.id changes.
          agent={agent}
          messages={[...transcriptFor(agent), ...(sentByAgent[agent.id] ?? [])]}
          thinking={thinkingFor === agent.id}
          model={model}
          onModelChange={changeModel}
          reasoning={reasoning}
          onReasoningChange={changeReasoning}
          onSend={sendMessage}
          onStop={stopTurn}
          readingMessages={readingMessages}
          {...(runsByBlob[agent.id]?.status === "waiting_input" &&
          runsByBlob[agent.id]?.askKind !== undefined
            ? { waitingAsk: runsByBlob[agent.id]?.askKind }
            : {})}
          detailOpen={detailOpen}
          onToggleDetail={() => setDetailOpen((open) => !open)}
          onOpenSettings={openSettings}
        />
      ) : null}
      {agent === undefined || selectedGroup !== undefined ? null : (
        <SlidePanel side="right" open={detailOpen && !composing}>
          {(() => {
            if (detailView.kind === "settings") {
              return (
                <SettingsPanel
                  agent={agent}
                  user={{ userName, timezone }}
                  onUpdate={(patch) => updateBlob(agent.id, patch)}
                  userMemories={userMemories}
                  onChangeMemories={changeMemories}
                  mcpServers={mcpServers}
                  onBack={() => setDetailView({ kind: "info" })}
                  onClose={() => setDetailOpen(false)}
                />
              );
            }
            const agentRoutines = routinesByAgent[agent.id] ?? [];
            if (detailView.kind === "routine") {
              const routine = agentRoutines.find(
                (candidate) => candidate.id === detailView.routineId,
              );
              if (routine !== undefined) {
                return (
                  <RoutinePanel
                    routine={routine}
                    onUpdate={(patch) => updateRoutine(agent.id, routine.id, patch)}
                    onDelete={() => deleteRoutine(agent.id, routine.id)}
                    onTestRun={() => queueTurn(() => fireRoutine(agent.id, routine))}
                    onBack={() => setDetailView({ kind: "info" })}
                    onClose={() => setDetailOpen(false)}
                  />
                );
              }
            }
            return (
              <DetailPanel
                agent={agent}
                routines={agentRoutines}
                lastRunTokens={
                  (runsByBlob[agent.id]?.inputTokens ?? 0) +
                  (runsByBlob[agent.id]?.outputTokens ?? 0)
                }
                filesKey={filesKey}
                onClose={() => setDetailOpen(false)}
                onOpenSettings={openSettings}
                onCreateRoutine={() => createRoutine(agent.id)}
                onOpenRoutine={(routineId) => setDetailView({ kind: "routine", routineId })}
              />
            );
          })()}
        </SlidePanel>
      )}
      {pluginsOpen ? (
        <PluginsModal
          installed={installedPlugins}
          onSetInstalled={setPluginInstalled}
          onClose={() => {
            setPluginsOpen(false);
            // This modal is the only place a connection can change, so it is
            // the only place the prompt's app list needs re-reading.
            void connectedAppNames().then(setConnectedApps);
          }}
        />
      ) : null}
      {searchOpen ? (
        <SearchModal
          agents={agents}
          groups={groups.map((group) => ({
            id: group.id,
            name: group.name,
            memberNames: membersOf(group).map((member) => member.name),
          }))}
          transcripts={sentByAgent}
          routines={routinesByAgent}
          hasChat={agent !== undefined}
          onSelect={openSearchResult}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          initialTab={settingsTab}
          userName={userName}
          onUserNameChange={changeUserName}
          theme={theme}
          onThemeChange={changeTheme}
          timezone={timezone}
          onTimezoneChange={changeTimezone}
          model={model}
          onModelChange={changeModel}
          forceOnboarding={forceOnboarding}
          onForceOnboardingChange={changeForceOnboarding}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {onboarding ? <Onboarding onDone={finishOnboarding} /> : null}
    </div>
  );
}
