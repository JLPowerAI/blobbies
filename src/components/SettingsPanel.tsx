import { ChevronLeft, ChevronsRight, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AvatarPicker } from "@/components/AvatarPicker";
import { BlobAvatar } from "@/components/BlobAvatar";
import { type Agent, MAX_BLOB_NAME_LENGTH } from "@/data/agents";
import { connect, type McpServerConfig, namespaceToolName, parseLoopbackUrl } from "@/lib/mcp";
import type { BlobMemory } from "@/lib/memory";
import { blobSystemPrompt, type UserContext } from "@/lib/prompt";
import { exportBlob } from "@/lib/store";

/**
 * Cap on hand-written instructions.
 *
 * ~500 tokens of a 16k window, at the very top of every request. Longer than
 * this and the role crowds out the conversation it is meant to shape.
 */
const MAX_INSTRUCTIONS_LENGTH = 2_000;

/**
 * Local MCP servers.
 *
 * App-wide rather than per-Blob, and reachable only from routine turns — the
 * chat catalog is tuned and measured, so third-party tools never enter it.
 * Only servers on this machine can be added: talking MCP to a remote endpoint
 * would put user content on someone else's server, which this app does not do.
 */
function ConnectionsSection({
  servers,
  onChange,
}: {
  servers: McpServerConfig[];
  onChange: (next: McpServerConfig[]) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const add = () => {
    const checked = parseLoopbackUrl(url);
    if ("error" in checked) {
      setStatus(checked.error);
      return;
    }
    const label = name.trim().slice(0, 40);
    if (label === "") {
      setStatus("Give the connection a name.");
      return;
    }
    // Adding the same server twice looks harmless but is not: tool names are
    // deduped across servers, so the second copy would silently contribute
    // nothing and read as a broken connection.
    if (servers.some((server) => server.url === checked.url)) {
      setStatus("That server is already connected.");
      return;
    }
    onChange([
      ...servers,
      { id: crypto.randomUUID(), name: label, url: checked.url, enabled: true },
    ]);
    setName("");
    setUrl("");
    setStatus(null);
  };

  const test = async (server: McpServerConfig) => {
    setStatus(`Connecting to ${server.name}…`);
    try {
      const { tools } = await connect(server.url);
      // Namespaced names, because those are what the Blob actually sees — and
      // truncated, because the server chose this text and could pad it out.
      setStatus(
        tools.length === 0
          ? `${server.name} connected but offers no tools.`
          : `${server.name} offers ${tools.length}: ${tools
              .map((tool) => namespaceToolName(server.name, tool.name))
              .join(", ")
              .slice(0, 300)}`,
      );
    } catch (error) {
      setStatus(`${server.name}: ${error instanceof Error ? error.message : "failed"}`);
    }
  };

  return (
    <div className="settings-field">
      <span className="settings-label">Connections</span>
      <ul className="routine-list">
        {servers.map((server) => (
          <li key={server.id} className="file-row-item">
            <button type="button" className="routine-row" onClick={() => void test(server)}>
              <span className="routine-text">
                <span className="routine-name">{server.name}</span>
                <span className="routine-schedule">{server.url}</span>
              </span>
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={server.enabled}
              aria-label={`Enable ${server.name}`}
              className={server.enabled ? "toggle toggle-on" : "toggle"}
              onClick={() =>
                onChange(
                  servers.map((candidate) =>
                    candidate.id === server.id
                      ? { ...candidate, enabled: !candidate.enabled }
                      : candidate,
                  ),
                )
              }
            >
              <span className="toggle-knob" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${server.name}`}
              onClick={() => onChange(servers.filter((candidate) => candidate.id !== server.id))}
            >
              <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <input
        className="settings-input"
        placeholder="Name"
        maxLength={40}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <input
        className="settings-input"
        placeholder="http://127.0.0.1:3000/mcp"
        maxLength={200}
        value={url}
        onChange={(event) => setUrl(event.currentTarget.value)}
      />
      <button type="button" className="settings-button" onClick={add}>
        Add connection
      </button>
      <span className="settings-hint">
        {status ??
          "Tools from enabled servers are available to routines. Tap a connection to test it."}
      </span>
    </div>
  );
}

interface SettingsPanelProps {
  agent: Agent;
  /** Name + timezone from app settings; completes the prompt preview. */
  user: UserContext;
  /** Where the selected model runs; keeps the preview's identity line honest. */
  runtime: "local" | "enclave";
  onUpdate: (patch: Partial<Agent>) => void;
  /** Shared memories, so the prompt preview matches what a turn actually sends. */
  userMemories: BlobMemory[];
  /** App-wide local MCP servers (not per-Blob). */
  mcpServers: McpServerConfig[];
  onChangeMcpServers: (next: McpServerConfig[]) => void;
  /** Back to the info (screen + routines) view. */
  onBack: () => void;
  onClose: () => void;
}

/** Per-Blob settings: identity fields and notification preference. */
export function SettingsPanel({
  agent,
  user,
  runtime,
  onUpdate,
  userMemories,
  mcpServers,
  onChangeMcpServers,
  onBack,
  onClose,
}: SettingsPanelProps) {
  const notifications = agent.notifications ?? true;
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [exported, setExported] = useState<string | null>(null);

  // Auto-grow the description so long text is fully visible, never clipped.
  // Re-runs on description change: the Blob can rewrite its own description
  // via configure_blob while this panel is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies(agent.description): height tracks the value, not the effect body
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [agent.description]);
  return (
    <aside className="detail-panel" aria-label={`${agent.name} settings`}>
      <header className="detail-header" data-tauri-drag-region>
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="detail-title">Settings</h2>
        <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
          <ChevronsRight size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="settings-body">
        <div className="settings-avatar">
          <BlobAvatar tone={agent.tone} shape={agent.shape} size={56} />
          <AvatarPicker
            tone={agent.tone}
            shape={agent.shape}
            group="settings"
            onChange={onUpdate}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-name">
            Name
          </label>
          <input
            id="settings-name"
            type="text"
            className="settings-input"
            maxLength={MAX_BLOB_NAME_LENGTH}
            value={agent.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-title">
            Title
          </label>
          <input
            id="settings-title"
            type="text"
            className="settings-input"
            placeholder="Describe what your agent does"
            value={agent.title ?? ""}
            onChange={(event) => onUpdate({ title: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-description">
            Description
          </label>
          <textarea
            id="settings-description"
            ref={descriptionRef}
            className="settings-input settings-textarea"
            placeholder="What this agent is for"
            rows={4}
            value={agent.description ?? ""}
            onChange={(event) => {
              onUpdate({ description: event.currentTarget.value });
              // Keep height tracking the content while typing.
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
            }}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-instructions">
            Instructions
          </label>
          <textarea
            id="settings-instructions"
            className="settings-input settings-textarea"
            placeholder="Write the role yourself, in your own words"
            rows={4}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            value={agent.instructions ?? ""}
            onChange={(event) => onUpdate({ instructions: event.currentTarget.value })}
          />
          {/* Title and description keep updating themselves but stop being
              rendered while this is set — say so, or that looks like a bug. */}
          <span className="settings-hint">
            Replaces the generated role above. Leave empty to use Title and Description.
          </span>
        </div>

        <details className="settings-field prompt-preview">
          <summary className="settings-label prompt-preview-summary">System prompt</summary>
          {/* Every extension the real turn passes, or this is a preview of a
              prompt that does not exist. */}
          <pre className="prompt-preview-body">
            {blobSystemPrompt(agent, user, {
              runtime,
              userMemories,
              mcpServers: mcpServers
                .filter((server) => server.enabled)
                .map((server) => server.name),
            })}
          </pre>
        </details>

        <div className="settings-card">
          <span className="settings-card-text">
            <span className="settings-card-title">Notifications</span>
            <span className="settings-card-blurb">
              Get notified when this agent finishes or needs input
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={notifications}
            aria-label="Notifications"
            className={notifications ? "toggle toggle-on" : "toggle"}
            onClick={() => onUpdate({ notifications: !notifications })}
          >
            <span className="toggle-knob" aria-hidden="true" />
          </button>
        </div>

        <ConnectionsSection servers={mcpServers} onChange={onChangeMcpServers} />

        <div className="settings-field">
          <span className="settings-label">Export</span>
          <button
            type="button"
            className="settings-button"
            onClick={() => {
              setExported("Exporting…");
              exportBlob(agent.id, agent.name)
                .then((path) =>
                  setExported(path === null ? "Export needs the desktop app." : `Saved ${path}`),
                )
                .catch(() => setExported("Could not write the export."));
            }}
          >
            Export {agent.name}
          </button>
          <span className="settings-hint">
            {exported ??
              "Saves this Blob's settings, routines, conversation and memories to Downloads as JSON. Its files stay in the home folder."}
          </span>
        </div>
      </div>
    </aside>
  );
}
