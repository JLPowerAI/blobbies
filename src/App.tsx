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
import { blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import { reconcileMemories } from "@/lib/intent";
import { readPreference, writePreference } from "@/lib/preferences";
import * as store from "@/lib/store";
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Blob currently generating a reply; drives the thinking indicator. */
  const [thinkingFor, setThinkingFor] = useState<string | null>(null);
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
    })();
    return () => {
      cancelled = true;
    };
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
      current.map((candidate) =>
        candidate.id === routineId ? { ...candidate, ...patch } : candidate,
      ),
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

  /** Stream the Blob's reply from the local model into the transcript. */
  const requestReply = async (target: Agent, history: Message[]) => {
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
      return;
    }
    const aiMessages: AiMessage[] = [
      // Rebuilt per turn: carries the current time, so it must never be cached.
      { role: "system", content: blobSystemPrompt(target, { userName, timezone }) },
      ...history
        .filter((entry): entry is Extract<Message, { kind: "text" }> => entry.kind === "text")
        .map((entry): AiMessage => {
          const role = entry.author === "user" ? ("user" as const) : ("assistant" as const);
          return { role, content: entry.segments.map((segment) => segment.text).join("") };
        }),
    ];
    let text = "";
    const patchReply = (content: string) => {
      setSentByAgent((previous) => {
        const current = previous[target.id] ?? [];
        const reply: Message = {
          id: replyId,
          kind: "text",
          author: "agent",
          segments: [{ text: content }],
          timestampMs: Date.now(),
        };
        const next = current.some((entry) => entry.id === replyId)
          ? current.map((entry) => (entry.id === replyId ? reply : entry))
          : [...current, reply];
        return { ...previous, [target.id]: next };
      });
    };
    setThinkingFor(target.id);
    try {
      text = await streamBlobTurn({
        model,
        messages: aiMessages,
        thinking: reasoning,
        forceConfigure: (target.title ?? "") === "" && (target.description ?? "") === "",
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
      if (text.trim() === "") {
        // Every rescue inside streamBlobTurn has already been tried by here.
        text =
          "I couldn't put a reply together for that. Try asking again, or in " +
          "smaller pieces \u2014 smaller models sometimes stall on broad questions.";
        patchReply(text);
      }
    } catch {
      text =
        text === ""
          ? "I couldn't reach the local model. Check that Ollama is running in Settings \u2192 Model."
          : `${text}\u2026 (the model stopped responding)`;
      patchReply(text);
    } finally {
      setThinkingFor(null);
    }
    touchActivity(target.id, text);
    // Persist once the reply settled; per-delta saves would thrash the store.
    setSentByAgent((previous) => {
      store.saveBlobTranscript(target.id, previous[target.id] ?? []);
      return previous;
    });
  };

  const sendMessage = (text: string, replyTo?: string) => {
    if (agent === undefined) {
      return;
    }
    const message: Message = {
      id: `sent-${Date.now()}`,
      kind: "text",
      author: "user",
      segments: [{ text }],
      timestampMs: Date.now(),
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    appendMessage(agent.id, message);
    touchActivity(agent.id, text);
    const history = [...transcriptFor(agent), ...(sentByAgent[agent.id] ?? []), message];
    void requestReply(agent, history);
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
