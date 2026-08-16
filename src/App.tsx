import { isAbortError } from "@kenkaiiii/gg-agent";
import type { Message as AiMessage } from "@kenkaiiii/gg-ai";
import { useEffect, useRef, useState } from "react";
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
import { homeFor } from "@/lib/home";
import { reconcileMemories } from "@/lib/intent";
import { unloadOllamaModel } from "@/lib/ollama";
import { readPreference, writePreference } from "@/lib/preferences";
import { type ActiveRun, assertTransition, type RunTrigger } from "@/lib/run-state";
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
  /** Latest roster for async callbacks (tool executes outlive a render). */
  const agentsRef = useRef<Agent[]>(agents);
  agentsRef.current = agents;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "chat" });
  // Details stay hidden until explicitly opened from the chat header.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailView, setDetailView] = useState<
    { kind: "info" } | { kind: "settings" } | { kind: "routine"; routineId: string }
  >({ kind: "info" });
  const [routinesByAgent, setRoutinesByAgent] = useState<Record<string, Routine[]>>({});
  const [sentByAgent, setSentByAgent] = useState<Record<string, Message[]>>({});
  /** Latest transcripts for queued turns (they run after state settles). */
  const sentRef = useRef(sentByAgent);
  sentRef.current = sentByAgent;

  const [settingsOpen, setSettingsOpen] = useState(false);
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
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [roster, settings] = await Promise.all([store.loadRoster(), store.loadSettings()]);
      if (cancelled) {
        return;
      }
      if (roster !== null && roster.length > 0) {
        setAgents(roster);
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
    store.saveSettings({ userName, theme, timezone, model, plugins: installedPlugins });
  }, [userName, theme, timezone, model, installedPlugins]);

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
    setAgents((previous) => {
      const next = [copy, ...previous];
      void store.flushRoster(next);
      return next;
    });
    store.saveBlobConfig(copy.id, copy);
    openConversation(copy.id);
  };

  const deleteBlob = (id: string) => {
    setAgents((previous) => {
      const next = previous.filter((candidate) => candidate.id !== id);
      void store.flushRoster(next);
      if (selectedId === id) {
        const fallback = next.find((candidate) => candidate.hidden !== true);
        setSelectedId(fallback === undefined ? null : fallback.id);
        setMode(fallback === undefined ? { kind: "creator", initialName: "" } : { kind: "chat" });
      }
      return next;
    });
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
    setAgents((previous) => {
      const next = previous.map((candidate) =>
        candidate.id === id ? { ...candidate, ...patch } : candidate,
      );
      store.saveRoster(next);
      const updated = next.find((candidate) => candidate.id === id);
      if (updated !== undefined) {
        store.saveBlobConfig(id, updated);
      }
      return next;
    });
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
    setAgents((previous) => {
      const next = [blob, ...previous];
      // Creation is not debounced: the roster and config must exist on disk
      // before anything else references the new id.
      void store.flushRoster(next);
      return next;
    });
    store.saveBlobConfig(blob.id, blob);
    openConversation(blob.id);
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
            runtime: isTinfoilModel(model) ? "enclave" : "local",
          },
        ),
      },
      ...trimHistory(
        history
          .filter((entry): entry is Extract<Message, { kind: "text" }> => entry.kind === "text")
          .map((entry): AiMessage => {
            const role = entry.author === "user" ? ("user" as const) : ("assistant" as const);
            return { role, content: entry.segments.map((segment) => segment.text).join("") };
          }),
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
    setThinkingFor(target.id);
    try {
      text = await streamBlobTurn({
        model,
        messages: aiMessages,
        thinking: reasoning,
        forceConfigure:
          trigger === "user" && (target.title ?? "") === "" && (target.description ?? "") === "",
        scope: trigger === "user" ? "chat" : "routine",
        home: homeFor(target.id),
        signal: abort.signal,
        getSteeringMessages: () => (steering.length === 0 ? null : steering.splice(0)),
        onAsk: (pending) => {
          askBox.value = pending;
        },
        onCheckpoint: flushTranscript,
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
        run = patchRun(run, "waiting_input", { question: asked.question, askKind: asked.kind });
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
    if (run.status === "running") {
      run = patchRun(run, outcome);
    } else if (run.status === "waiting_input" && outcome === "cancelled") {
      run = patchRun(run, "cancelled");
    }
    touchActivity(target.id, text);
    // Persist once the reply settled; per-delta saves would thrash the store.
    flushTranscript();
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

  const sendMessage = (text: string, replyTo?: string) => {
    if (agent === undefined) {
      return;
    }
    // Fat-finger guard: an identical send within half a second is a bounce.
    const now = Date.now();
    if (lastSend.current?.text === text && now - lastSend.current.at < 500) {
      return;
    }
    lastSend.current = { text, at: now };
    const message: Message = {
      id: `sent-${now}`,
      kind: "text",
      author: "user",
      segments: [{ text }],
      timestampMs: now,
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    appendMessage(agent.id, message);
    touchActivity(agent.id, text);
    // Follow-up: this Blob is mid-turn, so the message steers the running
    // loop (gg-agent folds it in between tool rounds) — no second turn.
    if (activeTurn.current?.blobId === agent.id) {
      activeTurn.current.steering.push({ role: "user", content: text });
      return;
    }
    const target = agent;
    const waiting = runsRef.current[target.id];
    const answering = waiting !== undefined && waiting.status === "waiting_input";
    void queueTurn(() => {
      // Read history through the ref: this may run after other queued turns.
      const history = [...transcriptFor(target), ...(sentRef.current[target.id] ?? [])];
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
