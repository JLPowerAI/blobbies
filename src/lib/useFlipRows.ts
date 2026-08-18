import { type RefObject, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/** Matches --duration-compose and --ease-standard, so glides feel app-native. */
const GLIDE_MS = 160;
const GLIDE_EASE = "cubic-bezier(0.3, 0, 0.2, 1)";
/** Per-row entry offset, and the row count after which it stops growing. */
const STAGGER_MS = 18;
const STAGGER_CAP = 6;

/**
 * Glide list rows to their new positions instead of teleporting them.
 *
 * The FLIP technique the composer already uses: measure where each row was,
 * let React paint the new layout, then animate from the old position back to
 * the new one. Rows are found by a `data-flip-row="<id>"` attribute.
 *
 * Deleting the second of six memories moves four rows up by a row height at
 * once; without this the table just reprints and the eye cannot tell whether
 * something moved or something else was deleted. Rows that are new to the list
 * fade in rather than gliding, because they have no old position to come from
 * — which also covers the first paint, where every row is new.
 *
 * `trigger` should change exactly when the rows do (their ids joined, say):
 * rects are re-measured every render so they never go stale, but animating on
 * unrelated renders would measure mid-animation positions and jitter.
 */
export function useFlipRows(container: RefObject<HTMLElement | null>, trigger: string): void {
  const rects = useRef(new Map<string, DOMRect>());
  const lastTrigger = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) {
      return;
    }
    const changed = lastTrigger.current !== trigger;
    const first = lastTrigger.current === null;
    lastTrigger.current = trigger;
    const reduced = prefersReducedMotion();
    let entering = 0;

    for (const row of root.querySelectorAll<HTMLElement>("[data-flip-row]")) {
      const key = row.dataset.flipRow;
      if (key === undefined) {
        continue;
      }
      const next = row.getBoundingClientRect();
      const previous = rects.current.get(key);
      rects.current.set(key, next);
      // `el.animate` is missing in jsdom, so tests take the no-animation path
      // and assert against the committed DOM rather than a mid-flight one.
      if (!changed || reduced || typeof row.animate !== "function") {
        continue;
      }
      if (previous === undefined) {
        // New row: nothing to glide from. Stagger the fades so a freshly
        // opened list arrives as a list rather than as one solid block, and
        // cap it so forty memories do not take a second to appear.
        row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: GLIDE_MS,
          easing: GLIDE_EASE,
          delay: first ? Math.min(entering, STAGGER_CAP) * STAGGER_MS : 0,
          fill: "backwards",
        });
        entering += 1;
        continue;
      }
      const dy = previous.top - next.top;
      // Sub-pixel drift is not movement worth animating.
      if (Math.abs(dy) < 1) {
        continue;
      }
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: GLIDE_MS,
        easing: GLIDE_EASE,
      });
    }

    // Forget rows that are gone, or the map grows for the life of the dialog
    // and a re-added id would glide from wherever it sat a hundred edits ago.
    const live = new Set(
      [...root.querySelectorAll<HTMLElement>("[data-flip-row]")].map((row) => row.dataset.flipRow),
    );
    for (const key of rects.current.keys()) {
      if (!live.has(key)) {
        rects.current.delete(key);
      }
    }
  });
}
