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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
