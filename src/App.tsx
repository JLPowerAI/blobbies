import { isAbortError } from "@kenkaiiii/gg-agent";
import type { Message as AiMessage } from "@kenkaiiii/gg-ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPane } from "@/components/ChatPane";
import { ComposePane } from "@/components/ComposePane";
import { CreatorPane } from "@/components/CreatorPane";
import { DetailPanel } from "@/components/DetailPanel";
import { PluginsModal } from "@/components/PluginsModal";
import { RoutinePanel } from "@/components/RoutinePanel";
import {
  MAX_USER_NAME_LENGTH,
  SettingsModal,
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
  type Message,
  type Routine,
  agents as seedAgents,
  transcriptFor,
} from "@/data/agents";
import { blobSystemPrompt, streamBlobTurn, timeNote, trimHistory } from "@/lib/ai";
import {
  type Attachment,
  attachmentName,
  attachmentsPrompt,
  rejectionNote,
  saveAttachments,
} from "@/lib/attachments";
import type { BlobMemory, RosterAccess } from "@/lib/blob-tools";
import { homeFor } from "@/lib/home";
import { reconcileMemories } from "@/lib/intent";
import { type McpServerConfig, parseLoopbackUrl } from "@/lib/mcp";
import { notify, shouldNotify } from "@/lib/notify";
import { unloadOllamaModel } from "@/lib/ollama";
import { readPreference, writePreference } from "@/lib/preferences";
import { type ActiveRun, assertTransition, isTerminal, type RunTrigger } from "@/lib/run-state";
import { nextFireTime } from "@/lib/schedule";
import { startScheduler } from "@/lib/scheduler";
import * as store from "@/lib/store";
import { configureTinfoilFromKeychain, isTinfoilModel } from "@/lib/tinfoil";
import "./App.css";

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

  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Memories shared by every Blob ("All Blobs" scope), from the `user` slice. */
  const [userMemories, setUserMemories] = useState<BlobMemory[]>([]);
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
  };
  const turnSettings = useRef(currentTurnSettings);
  turnSettings.current = currentTurnSettings;

  // Configure Tinfoil only when the chosen model actually needs it: a
  // keychain read can prompt for the device password (macOS re-verifies the
  // app after every rebuild), so local-only setups must never touch it.
  useEffect(() => {
    if (isTinfoilModel(model)) {
      void configureTinfoilFromKeychain();
    }
  }, [model]);

  // Hydrate persisted state (roster, settings) once on startup. Legacy
  // localStorage prefs remain the synchronous initial values above; the disk
  // slices win when they exist.
  // biome-ignore lint/correctness/useExhaustiveDependencies(commitAgents): stable (useCallback, no deps)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [roster, settings, shared] = await Promise.all([
        store.loadRoster(),
        store.loadSettings(),
        store.loadUserMemories(),
      ]);
      if (cancelled) {
        return;
      }
      if (roster !== null && roster.length > 0) {
        commitAgents(() => roster);
      }
      if (shared !== null) {
        setUserMemories(shared);
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
          setSentByAgent((previous) =>
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
    setMode({ kind: "chat" });
    setDetailView({ kind: "info" });
  };

  const duplicateBlob = (id: string) => {
    const source = agents.find((candidate) => candidate.id === id);
    if (source === undefined) {
      return;
    }
    const copy: Agent = {
      ...source,
      id: newBlobId(),
      name: `${source.name} copy`.slice(0, MAX_BLOB_NAME_LENGTH),
      time: "Now",
      lastActivityAt: Date.now(),
      snippet: GREETING,
      unread: false,
      pinned: false,
      hidden: false,
    };
    void store.flushRoster(commitAgents((previous) => [copy, ...previous]));
    store.saveBlobConfig(copy.id, copy);
    openConversation(copy.id);
  };

  const deleteBlob = (id: string) => {
    const next = commitAgents((previous) => previous.filter((candidate) => candidate.id !== id));
    void store.flushRoster(next);
    if (selectedId === id) {
      const fallback = next.find((candidate) => candidate.hidden !== true);
      setSelectedId(fallback === undefined ? null : fallback.id);
      setMode(fallback === undefined ? { kind: "creator", initialName: "" } : { kind: "chat" });
    }
    setSentByAgent(({ [id]: _dropped, ...rest }) => rest);
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

  // Hydrate the Blob that is actually on screen — which is `agent`, not
  // `selectedId`. On a fresh launch nothing is selected yet, so `agent` falls
  // back to the first row and its conversation renders; keying this off
  // `selectedId` meant that transcript never loaded, so the chat reopened
  // empty and the model was sent no history at all.
  const activeBlobId = agent?.id;
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
        setSentByAgent((previous) =>
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

  const updateBlob = (id: string, patch: Partial<Agent>) => {
    const next = commitAgents((previous) =>
      previous.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)),
    );
    store.saveRoster(next);
    const updated = next.find((candidate) => candidate.id === id);
    if (updated !== undefined) {
      store.saveBlobConfig(id, updated);
    }
  };

  const createBlob = (name: string, tone: AvatarTone, shape: AgentShape) => {
    const blob: Agent = {
      id: newBlobId(),
      // Defense in depth: the creator already caps input length.
      name: name.slice(0, MAX_BLOB_NAME_LENGTH),
      time: "Now",
      lastActivityAt: Date.now(),
      snippet: GREETING,
      tone,
      shape,
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
        name,
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
  };

  const appendMessage = (agentId: string, message: Message) => {
    setSentByAgent((previous) => {
      const next = [...(previous[agentId] ?? []), message];
      store.saveBlobTranscript(agentId, next);
      return { ...previous, [agentId]: next };
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
   */
  const requestReply = async (
    target: Agent,
    history: Message[],
    turn?: { trigger: RunTrigger; routineId?: string; prompt?: string },
  ): Promise<"done" | "failed" | "cancelled"> => {
    const trigger = turn?.trigger ?? "user";
    const replyId = `agent-${Date.now()}`;
    // Read once, from the ref: a scheduled routine runs the mount-render
    // closure, where every one of these is still its mount-time value.
    const { model, userName, timezone, reasoning, userMemories, mcpServers } = turnSettings.current;
    if (model === "") {
      const text =
        "I don't have a model to think with yet \u2014 pick one in Settings \u2192 Model.";
      appendMessage(target.id, {
        id: replyId,
        kind: "text",
        author: "agent",
        segments: [{ text }],
        timestampMs: Date.now(),
      });
      touchActivity(target.id, text);
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
            runtime: isTinfoilModel(model) ? "enclave" : "local",
          },
        ),
      },
      // Attachment text is read back from the home folder and inlined into
      // the message that carried it — the chat catalog has no file tool, so
      // this is the only way an attachment reaches the model there. Per-message
      // and content-stable, so the cached prefix survives; trimHistory sizes
      // the result like any other history.
      ...trimHistory(
        await Promise.all(
          history
            .filter((entry): entry is Extract<Message, { kind: "text" }> => entry.kind === "text")
            .map(async (entry): Promise<AiMessage> => {
              const role = entry.author === "user" ? ("user" as const) : ("assistant" as const);
              const said = entry.segments.map((segment) => segment.text).join("");
              const block = await attachmentsPrompt(home, entry.attachments ?? []);
              // An attachment-only message has no words of its own; a leading
              // blank line in its place is noise the model has to read past.
              const content = [said, block].filter((part) => part !== "").join("\n\n");
              return { role, content };
            }),
        ),
      ),
    ];
    // Routine (and answer-to-routine) turns carry the instruction as the
    // prompt; it is not a visible transcript message — the event line is.
    if (turn?.prompt !== undefined) {
      aiMessages.push({ role: "user", content: turn.prompt });
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
    const patchReply = (content: string) => {
      setSentByAgent((previous) => {
        const current = previous[target.id] ?? [];
        const reply: Message = {
          id: replyId,
          kind: "text",
          author: "agent",
          segments: [{ text: content }],
          timestampMs: Date.now(),
          ...(askBox.value === null ? {} : { ask: askBox.value.kind }),
        };
        const next = current.some((entry) => entry.id === replyId)
          ? current.map((entry) => (entry.id === replyId ? reply : entry))
          : [...current, reply];
        return { ...previous, [target.id]: next };
      });
    };
    /** Flush the partial transcript at safe points (gg-agent checkpoints). */
    const flushTranscript = () => {
      setSentByAgent((previous) => {
        store.saveBlobTranscript(target.id, previous[target.id] ?? []);
        return previous;
      });
    };
    let outcome: "done" | "failed" | "cancelled" = "done";
    // Summed, not assigned: a turn can run the loop more than once (the
    // no-tools retry, the rescue round) and each reports its own total.
    const spent = { inputTokens: 0, outputTokens: 0 };
    setThinkingFor(target.id);
    try {
      text = await streamBlobTurn({
        model,
        messages: aiMessages,
        thinking: reasoning,
        forceConfigure:
          trigger === "user" && (target.title ?? "") === "" && (target.description ?? "") === "",
        scope: trigger === "user" ? "chat" : "routine",
        home,
        roster: { access: rosterAccess, selfName: target.name },
        mcpServers,
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
        onText: (fullText) => {
          text = fullText;
          patchReply(fullText);
        },
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
        patchReply(text);
      }
    } catch (error) {
      if (isAbortError(error)) {
        // Stopped by the user: keep whatever text already streamed.
        outcome = "cancelled";
        text = text.trim() === "" ? "(stopped)" : text;
        patchReply(text);
      } else {
        outcome = "failed";
        // Whitespace-only counts as nothing said, matching the check above.
        const unreachable = isTinfoilModel(model)
          ? "I couldn't reach Tinfoil. Check your connection and API key in Settings \u2192 Model."
          : "I couldn't reach the local model. Check that Ollama is running in Settings \u2192 Model.";
        text = text.trim() === "" ? unreachable : `${text}\u2026 (the model stopped responding)`;
        patchReply(text);
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
    touchActivity(target.id, text);
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

  /** Stop the in-flight turn (keeps any partial text). */
  const stopTurn = () => {
    activeTurn.current?.abort.abort();
  };

  /** The user's message, as it goes into the transcript. */
  const userMessage = (
    text: string,
    replyTo: string | undefined,
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
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(attachments.length === 0 ? {} : { attachments }),
  });

  /** Swap placeholder attachments for the ones that actually got saved. */
  const settleAttachments = (agentId: string, id: string, attachments: Attachment[]) => {
    setSentByAgent((previous) => {
      const next = (previous[agentId] ?? []).map((entry) =>
        entry.id === id && entry.kind === "text" ? { ...entry, attachments } : entry,
      );
      store.saveBlobTranscript(agentId, next);
      return { ...previous, [agentId]: next };
    });
  };

  /** Take back a message whose files all turned out to be unreadable. */
  const dropMessage = (agentId: string, id: string) => {
    setSentByAgent((previous) => {
      const next = (previous[agentId] ?? []).filter((entry) => entry.id !== id);
      store.saveBlobTranscript(agentId, next);
      return { ...previous, [agentId]: next };
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

  const sendMessage = (text: string, replyTo?: string, files?: readonly File[]) => {
    if (agent === undefined) {
      return;
    }
    const attaching = files !== undefined && files.length > 0;
    // Fat-finger guard: an identical send within half a second is a bounce.
    // Attachments are exempt — the same caption twice with different files is
    // two real messages.
    const now = Date.now();
    if (!attaching && lastSend.current?.text === text && now - lastSend.current.at < 500) {
      return;
    }
    lastSend.current = { text, at: now };
    const target = agent;
    if (!attaching) {
      const message = userMessage(text, replyTo, []);
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
    const pending = [...files].map((file) => {
      const base = attachmentName(file.name);
      let name = base;
      for (let suffix = 1; claimed.has(name); suffix++) {
        name = `${base}-${suffix}`;
      }
      claimed.add(name);
      return { name, bytes: file.size };
    });
    const message = userMessage(text, replyTo, pending);
    appendMessage(target.id, message);
    touchActivity(target.id, text.trim() === "" ? pending.map((p) => p.name).join(", ") : text);
    setReadingMessages((ids) => [...ids, message.id]);
    void saveAttachments(homeFor(target.id), files).then(({ saved, rejected }) => {
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
      setSentByAgent((previous) =>
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
        selectedId={composing ? null : (agent?.id ?? null)}
        composing={composing}
        userName={userName}
        onSelect={openConversation}
        onStartCompose={() => setMode({ kind: "palette" })}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPlugins={() => setPluginsOpen(true)}
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
          onCreate={createBlob}
        />
      ) : null}
      {activeMode.kind === "palette" ? (
        <ComposePane
          agents={agents}
          onOpen={openConversation}
          onCreate={(name) => setMode({ kind: "creator", initialName: name })}
          onCancel={() => setMode({ kind: "chat" })}
        />
      ) : null}
      {activeMode.kind === "chat" && agent !== undefined ? (
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
      {agent === undefined ? null : (
        <SlidePanel side="right" open={detailOpen && !composing}>
          {(() => {
            if (detailView.kind === "settings") {
              return (
                <SettingsPanel
                  agent={agent}
                  user={{ userName, timezone }}
                  runtime={isTinfoilModel(model) ? "enclave" : "local"}
                  onUpdate={(patch) => updateBlob(agent.id, patch)}
                  userMemories={userMemories}
                  mcpServers={mcpServers}
                  onChangeMcpServers={setMcpServers}
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
                userMemories={userMemories}
                lastRunTokens={
                  (runsByBlob[agent.id]?.inputTokens ?? 0) +
                  (runsByBlob[agent.id]?.outputTokens ?? 0)
                }
                filesKey={filesKey}
                onChangeMemories={(next) => {
                  if (next.blob !== undefined) {
                    updateBlob(agent.id, { memories: next.blob });
                  }
                  if (next.user !== undefined) {
                    setUserMemories(next.user);
                    store.saveUserMemories(next.user);
                  }
                }}
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
          onClose={() => setPluginsOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          userName={userName}
          onUserNameChange={changeUserName}
          theme={theme}
          onThemeChange={changeTheme}
          timezone={timezone}
          onTimezoneChange={changeTimezone}
          model={model}
          onModelChange={changeModel}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
