import { useEffect, useState } from "react";
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
  MAX_BLOB_NAME_LENGTH,
  type Message,
  type Routine,
  agents as seedAgents,
  transcriptFor,
} from "@/data/agents";
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
    store.saveSettings({ userName, theme, timezone, plugins: installedPlugins });
  }, [userName, theme, timezone, installedPlugins]);

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

  const openSettings = () => {
    setDetailView({ kind: "settings" });
    setDetailOpen(true);
  };

  // Lazily hydrate a Blob's routines and transcript when it becomes active.
  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [routines, transcript] = await Promise.all([
        store.loadBlobRoutines(selectedId),
        store.loadBlobTranscript(selectedId),
      ]);
      if (cancelled) {
        return;
      }
      if (routines !== null) {
        setRoutinesByAgent((previous) =>
          previous[selectedId] === undefined ? { ...previous, [selectedId]: routines } : previous,
        );
      }
      if (transcript !== null) {
        setSentByAgent((previous) =>
          previous[selectedId] === undefined ? { ...previous, [selectedId]: transcript } : previous,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

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
      snippet: "New Blob. Say hello",
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

  const sendMessage = (text: string, replyTo?: string) => {
    if (agent === undefined) {
      return;
    }
    const message: Message = {
      id: `sent-${Date.now()}`,
      kind: "text",
      author: "user",
      segments: [{ text }],
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    setSentByAgent((previous) => {
      const next = [...(previous[agent.id] ?? []), message];
      store.saveBlobTranscript(agent.id, next);
      return { ...previous, [agent.id]: next };
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
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
