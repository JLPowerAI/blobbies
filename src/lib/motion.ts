/**
 * Should motion be skipped entirely?
 *
 * A missing `matchMedia` means a non-browser environment (jsdom), where CSS
 * animations never run and `animationend` never fires — so any code that waits
 * for an animation to finish must treat that case as "already finished" or it
 * hangs forever.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
