import { type FormEvent, useState } from "react";
import reactLogo from "@/assets/react.svg";
import { ExternalLink } from "@/components/ExternalLink";
import { greet } from "@/lib/tauri";
import "./App.css";

/**
 * Tauri rejects `invoke` with whatever the command's error type serialized to —
 * a plain string here, not an `Error`. Anything else is a transport failure.
 */
function describeIpcError(cause: unknown): string {
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return "Failed to reach the Rust backend.";
}

export function App() {
  const [greeting, setGreeting] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    greet(name).then(setGreeting, (cause: unknown) => {
      setGreeting("");
      setError(describeIpcError(cause));
    });
  };

  return (
    <main className="container">
      <h1>Welcome to Tauri + React</h1>

      <div className="row">
        <ExternalLink href="https://vite.dev/">
          <img src="/vite.svg" className="logo vite" alt="Vite logo" />
        </ExternalLink>
        <ExternalLink href="https://tauri.app/">
          <img src="/tauri.svg" className="logo tauri" alt="Tauri logo" />
        </ExternalLink>
        <ExternalLink href="https://react.dev/">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </ExternalLink>
      </div>
      <p>Click on the Tauri, Vite, and React logos to learn more.</p>

      <form className="row" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="greet-input">
          Name
        </label>
        <input
          id="greet-input"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>

      <p role="status">{greeting}</p>
      {error === null ? null : <p role="alert">{error}</p>}
    </main>
  );
}
