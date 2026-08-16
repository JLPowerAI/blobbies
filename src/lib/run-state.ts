/**
 * Durable run records: one active (or last) run per Blob, persisted to the
 * `runs` slice before the turn starts, so a crash mid-run is visible on the
 * next launch instead of silently vanishing.
 */

export type RunStatus = "queued" | "running" | "waiting_input" | "done" | "failed" | "cancelled";

export type RunTrigger = "user" | "routine" | "answer";

export interface ActiveRun {
  id: string;
  blobId: string;
  trigger: RunTrigger;
  /** The user prompt (or routine instruction) that started this run. */
  prompt: string;
  /** Set when a routine fired this run. */
  routineId?: string;
  /** The pending question while status is waiting_input. */
  question?: string;
  /** How the ask should render: a question, or an action the user must do. */
  askKind?: "question" | "action";
  startedAt: number;
  status: RunStatus;
  /**
   * Tokens this run spent in the agent loop. Optional because runs stored
   * before this existed have neither, and `parseRun` stays tolerant of them.
   * Excludes the router/reconcile/configure calls — see `onUsage` in ai.ts.
   */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Legal transitions. Terminal states have no exits — a done run is never
 * resurrected; a new run gets a new id.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_input", "done", "failed", "cancelled"],
  waiting_input: ["running", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Throws on an illegal jump so state bugs surface in dev, not as stuck runs. */
export function assertTransition(from: RunStatus, to: RunStatus): RunStatus {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal run transition: ${from} -> ${to}`);
  }
  return to;
}

/** Validate a value read from the store; null when it is not a run record. */
export function parseRun(value: unknown): ActiveRun | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const statuses: RunStatus[] = [
    "queued",
    "running",
    "waiting_input",
    "done",
    "failed",
    "cancelled",
  ];
  const triggers: RunTrigger[] = ["user", "routine", "answer"];
  if (
    typeof raw.id !== "string" ||
    typeof raw.blobId !== "string" ||
    typeof raw.prompt !== "string" ||
    typeof raw.startedAt !== "number" ||
    !statuses.includes(raw.status as RunStatus) ||
    !triggers.includes(raw.trigger as RunTrigger)
  ) {
    return null;
  }
  return raw as unknown as ActiveRun;
}
