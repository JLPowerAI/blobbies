import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * A crash inside the transcript rather than under the whole app: renders a
   * line where the messages were, so the roster, the header and an in-flight
   * turn all survive one bad message.
   */
  inline?: boolean;
  /**
   * Shown in place of the children instead of the full crash surface. Used
   * per message card, where the failure is one line in a conversation — not
   * something to offer Reload and Copy-error for.
   */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Which view threw. Only `componentDidCatch` ever sees this. */
  componentStack: string | null;
  copied: boolean;
}

/**
 * The last thing between a thrown render and a white window.
 *
 * A transcript is a plain JSON file the user is told they may edit, and a
 * message written by a newer build can reach a view that does not expect it.
 * Without a boundary React unmounts the entire tree on any such throw: the
 * sidebar, the roster and whatever turn was streaming all disappear, with no
 * way back but quitting the app.
 *
 * A class, because `componentDidCatch` has no hook equivalent — this is the
 * one part of React with no function-component form.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Blobbies crashed while rendering:", error, info.componentStack);
    // Kept, not just logged: which view threw is not on the error, and the
    // console is exactly what someone reporting this cannot reach.
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private copy = (): void => {
    const { error, componentStack } = this.state;
    if (error === null) {
      return;
    }
    // The component stack is the whole reason this button exists: without it
    // a report says only that something broke, not where.
    const text = [
      `${error.name}: ${error.message}`,
      `Stack trace:\n${error.stack?.trim() ?? "(unavailable)"}`,
      `Component stack:\n${componentStack?.trim() ?? "(unavailable)"}`,
    ].join("\n\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => this.setState({ copied: true }))
      .catch(() => {
        // Clipboard denied: say so instead of a button that silently does
        // nothing, since the point of this screen is getting the error out.
        this.setState({ copied: false });
      });
  };

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (error === null) {
      return this.props.children;
    }
    // A caller that supplied its own fallback is drawing something small
    // inside a working screen; the crash surface below would be louder than
    // whatever broke.
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }
    return (
      <div
        className={this.props.inline ? "crash-surface crash-inline" : "crash-surface"}
        role="alert"
      >
        <p className="crash-title">
          {this.props.inline === true
            ? "This conversation could not be shown."
            : "Blobbies hit a problem."}
        </p>
        <p className="crash-detail">{error.message}</p>
        <div className="crash-actions">
          <button type="button" className="crash-button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="crash-button" onClick={this.copy}>
            {copied ? "Copied" : "Copy error"}
          </button>
        </div>
      </div>
    );
  }
}
