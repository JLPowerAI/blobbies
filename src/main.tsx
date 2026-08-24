import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { initAutoUpdate } from "@/lib/updater";

// Fire-and-forget: checks now and every few hours, no-op outside Tauri.
initAutoUpdate();

const container = document.getElementById("root");

if (container === null) {
  throw new Error('Root element "#root" is missing from index.html.');
}

/**
 * `VITE_NO_STRICT=1 pnpm tauri:dev` renders without StrictMode.
 *
 * StrictMode only double-invokes effects in a DEVELOPMENT build; in a release
 * build it is inert. So every layout effect in this app — including the chat
 * pane's scroll pin — runs twice in dev and once in release, and the second
 * run happens against layout that has already settled. That is a free do-over
 * release never gets, and it is the most likely reason the blank-chat bug
 * reproduces consistently in the shipped app and not in dev.
 *
 * This switch makes a dev build match release on the one axis that matters,
 * so the fault can be chased with hot reload instead of a 10-minute rebuild.
 * It changes nothing about the release bundle.
 */
const app =
  import.meta.env.VITE_NO_STRICT === "1" ? (
    <App />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  );

createRoot(container).render(app);
