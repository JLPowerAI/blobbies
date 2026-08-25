import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { AcpBridge } from "@/lib/acp/useAcpBridge";

interface AcpSettingsProps {
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  bridge: AcpBridge;
  /** Clients approved in the past, which connect without asking again. */
  pairedClients: string[];
  onForgetClient: (name: string) => void;
  /** Mint a new token and drop every connection using the old one. */
  onRotateToken: () => void;
}

/** The editor's config, ready to paste — one snippet per editor's own format. */
function snippetFor(editor: "zed" | "jetbrains", relayPath: string): string {
  return editor === "zed"
    ? JSON.stringify({ agent_servers: { Blobbies: { command: relayPath, args: [] } } }, null, 2)
    : JSON.stringify({ blobbies: { command: relayPath, args: [] } }, null, 2);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="modal-button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={label}
    >
      {copied ? (
        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The Editors (ACP) section of Settings.
 *
 * Deliberately shows the *actual* relay path the running app reports rather
 * than a documented guess: it differs per platform and per install, and a
 * wrong path is a support ticket that looks like a broken protocol.
 */
export function AcpSettings({
  enabled,
  onEnabledChange,
  bridge,
  pairedClients,
  onForgetClient,
  onRotateToken,
}: AcpSettingsProps) {
  const relayPath = bridge.info?.relayPath ?? "";
  return (
    <>
      <p className="modal-section-label">Editors (ACP)</p>
      <div className="modal-card">
        <div className="modal-row modal-row-multiline">
          <span className="modal-row-text">
            <label className="modal-row-title" htmlFor="acp-toggle">
              Let editors talk to your Blobs
            </label>
            <span className="modal-row-blurb">
              Zed, JetBrains, Neovim and other Agent Client Protocol editors can chat with the same
              Blobs you see here, with the same memories and tools. Off unless you turn it on;
              nothing leaves this machine, and every new editor asks your permission first.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            id="acp-toggle"
            className={enabled ? "toggle toggle-on" : "toggle"}
            onClick={() => onEnabledChange(!enabled)}
          >
            <span className="toggle-knob" aria-hidden="true" />
          </button>
        </div>

        {enabled && bridge.error !== null ? (
          <div className="modal-row modal-row-multiline">
            <span className="modal-row-text">
              <span className="modal-row-title">Could not start</span>
              <span className="modal-row-blurb">{bridge.error}</span>
            </span>
          </div>
        ) : null}

        {enabled && relayPath !== "" ? (
          <>
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                <span className="modal-row-title">Command</span>
                <span className="modal-row-blurb modal-row-mono">{relayPath}</span>
              </span>
              <CopyButton text={relayPath} label="Copy the command path" />
            </div>
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                <span className="modal-row-title">Zed</span>
                <span className="modal-row-blurb">
                  Add this to <code>settings.json</code>.
                </span>
              </span>
              <CopyButton text={snippetFor("zed", relayPath)} label="Copy the Zed snippet" />
            </div>
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                <span className="modal-row-title">JetBrains</span>
                <span className="modal-row-blurb">
                  Add this to <code>~/.jetbrains/acp.json</code>.
                </span>
              </span>
              <CopyButton
                text={snippetFor("jetbrains", relayPath)}
                label="Copy the JetBrains snippet"
              />
            </div>
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                <span className="modal-row-title">Connected</span>
                <span className="modal-row-blurb">
                  {bridge.connected.length === 0
                    ? "No editor is connected right now."
                    : bridge.connected.join(", ")}
                </span>
              </span>
              <button type="button" className="modal-button" onClick={onRotateToken}>
                Rotate token
              </button>
            </div>
            {pairedClients.map((name) => (
              <div key={name} className="modal-row">
                <span className="modal-row-text">
                  <span className="modal-row-title">{name}</span>
                  <span className="modal-row-blurb">Approved — connects without asking.</span>
                </span>
                <button type="button" className="modal-button" onClick={() => onForgetClient(name)}>
                  Revoke
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}
