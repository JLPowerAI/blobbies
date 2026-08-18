import type { Message } from "@kenkaiiii/gg-ai";
import { afterAll, describe, expect, it } from "vitest";
import { blobSystemPrompt, streamBlobTurn, type ToolCallRecord } from "@/lib/ai";
import { reconcileMemories } from "@/lib/intent";
import { type SimBlob, scenarios, type TurnOutcome } from "./scenarios";

/**
 * Agent simulation: drives the real `streamBlobTurn` against a real local
 * model and scores what the Blob actually does — which tools it calls, how it
 * configures itself, whether it corrects a memory instead of duplicating it.
 *
 * This is a *tuning harness*, not a unit test: it needs Ollama running, it is
 * slow, and a small model is non-deterministic. It never runs in `pnpm check`.
 * Use it after changing a system prompt or a tool description:
 *
 *   pnpm sim                       # default model
 *   SIM_MODEL=llama3.1:8b pnpm sim # compare models
 *   SIM_RUNS=3 pnpm sim            # repeat each scenario, see flakiness
 */

// 9b is the floor, matching group.sim.ts: a 0.8b model fails these scenarios
// for reasons no prompt fixes, so tuning against it optimises for a setup
// nobody runs. Point SIM_MODEL at something smaller to watch it degrade.
const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
// Three by default, for the same reason as group.sim.ts: one run of a
// non-deterministic model cannot tell a regression from noise, and a suite
// that reddens on noise is one nobody reads. Scoring is by majority (below).
// SIM_RUNS=1 for a quick look, and it reverts to failing on any single run.
const RUNS = Number(process.env.SIM_RUNS ?? "3");
/** A slow model on a cold load can take a while for a multi-tool turn. */
const TURN_TIMEOUT_MS = 120_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

/** Run one scenario end to end, returning the outcome of every turn. */
async function runScenario(turns: { say: string }[], start: SimBlob): Promise<TurnOutcome[]> {
  // Deep copy: a repeated run must not inherit the previous run's state.
  const blob: SimBlob = {
    ...start,
    memories: start.memories.map((memory) => ({ ...memory })),
  };
  const history: Message[] = [];
  const outcomes: TurnOutcome[] = [];

  for (const turn of turns) {
    history.push({ role: "user", content: turn.say });
    const tools: ToolCallRecord[] = [];
    const started = Date.now();
    const reply = await streamBlobTurn({
      model: MODEL,
      // Rebuilt each turn exactly like App.tsx does, so the sim exercises the
      // real prompt including live memories and config.
      messages: [{ role: "system", content: blobSystemPrompt(blob, USER) }, ...history],
      forceConfigure: (blob.title ?? "") === "" && (blob.description ?? "") === "",
      memory: {
        list: () => blob.memories,
        save: (memories) => {
          blob.memories = memories;
        },
        // Mirrors App.tsx: without this the sim would exercise a different
        // wiring than the app actually runs.
        reconcile: (fact, existing) => reconcileMemories({ model: MODEL, fact, existing }),
      },
      onSegment: () => {},
      onConfigure: (patch) => {
        Object.assign(blob, patch);
      },
      onToolCall: (call) => tools.push(call),
    });
    history.push({ role: "assistant", content: reply });
    outcomes.push({
      reply,
      tools: tools.map((call) => ({ name: call.name, args: call.args })),
      blob: { ...blob, memories: blob.memories.map((memory) => ({ ...memory })) },
      ms: Date.now() - started,
    });
  }
  return outcomes;
}

/** Compact transcript so a failure shows what the model actually did. */
function report(scenarioName: string, turns: { say: string }[], outcomes: TurnOutcome[]): string {
  const lines = [`\n\u2500\u2500 ${scenarioName}`];
  outcomes.forEach((outcome, index) => {
    const toolNames = outcome.tools.map((call) => {
      // Values, not just keys: a wrong argument is the usual failure mode.
      const args = Object.entries(call.args)
        .map(([key, value]) => `${key}=${JSON.stringify(value).slice(0, 44)}`)
        .join(" ");
      return `${call.name}(${args})`;
    });
    lines.push(`   user: ${turns[index]?.say ?? ""}`);
    lines.push(`   blob: ${outcome.reply.replace(/\s+/g, " ").slice(0, 160)}`);
    lines.push(`   tools: ${toolNames.join(" ") || "\u2014"}  (${outcome.ms}ms)`);
    lines.push(
      `   config: ${JSON.stringify(outcome.blob.title ?? "")} | memories: ${JSON.stringify(
        outcome.blob.memories.map((memory) => memory.text.slice(0, 60)),
      )}`,
    );
  });
  return lines.join("\n");
}

/** Pass/fail tally per scenario, so repeat runs show reliability not luck. */
const tally = new Map<string, { pass: number; fail: number; reasons: string[] }>();

afterAll(() => {
  const rows = [...tally.entries()].sort(
    ([, a], [, b]) => a.pass / (a.pass + a.fail) - b.pass / (b.pass + b.fail),
  );
  const lines = [`\n\u2550\u2550 reliability (${MODEL}, ${RUNS} run${RUNS === 1 ? "" : "s"})`];
  for (const [name, count] of rows) {
    const total = count.pass + count.fail;
    const percent = Math.round((count.pass / total) * 100);
    const bar = "\u2588".repeat(Math.round(percent / 10)).padEnd(10, "\u2591");
    lines.push(`   ${bar} ${String(percent).padStart(3)}%  ${name}`);
  }
  console.log(lines.join("\n"));

  // The verdict, taken across runs rather than per run: a scenario that failed
  // more often than it passed is a regression, one that failed once in three
  // is the model being a model.
  if (RUNS > 1) {
    const broken = rows
      .filter(([, count]) => count.fail > count.pass)
      .map(
        ([name, count]) =>
          `${name}: failed ${count.fail}/${count.pass + count.fail} \u2014 ${count.reasons[0]}`,
      );
    expect(broken, broken.join("\n   ")).toEqual([]);
  }
});

describe(`agent simulation (${MODEL})`, () => {
  for (const scenario of scenarios) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${scenario.name} [run ${run}]` : scenario.name;
      it(
        label,
        async () => {
          const outcomes = await runScenario(scenario.turns, scenario.start);
          const failures: string[] = [];
          scenario.turns.forEach((turn, index) => {
            const outcome = outcomes[index];
            if (outcome === undefined) {
              failures.push(`turn ${index + 1}: no outcome`);
              return;
            }
            for (const check of turn.expect) {
              const failure = check(outcome);
              if (failure !== null) {
                failures.push(`turn ${index + 1}: ${failure}`);
              }
            }
          });
          // Always print: passes are as informative as failures when tuning.
          console.log(report(scenario.name, scenario.turns, outcomes));
          const count = tally.get(scenario.name) ?? { pass: 0, fail: 0, reasons: [] as string[] };
          if (failures.length === 0) {
            count.pass++;
          } else {
            count.fail++;
            count.reasons.push(failures.join("; "));
          }
          tally.set(scenario.name, count);
          if (RUNS === 1) {
            expect(failures, failures.join("\n   ")).toEqual([]);
          }
        },
        TURN_TIMEOUT_MS * scenario.turns.length,
      );
    }
  }
});
