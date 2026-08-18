import { useCallback, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * Two-phase dismissal for animated popovers/dialogs. `requestClose` flips the
 * element into its exit animation; call `finishClose` from `onAnimationEnd`
 * to actually unmount. Under reduced motion (where CSS animations are
 * disabled and `animationend` never fires) it closes immediately.
 */
export function useExitAnimation(onClosed: () => void): {
  closing: boolean;
  requestClose: () => void;
  finishClose: () => void;
} {
  const [closing, setClosing] = useState(false);

  const requestClose = useCallback(() => {
    // Without an exit animation there is no `animationend` to wait for, so
    // closing has to happen now or it never happens at all.
    if (prefersReducedMotion()) {
      onClosed();
      return;
    }
    setClosing(true);
  }, [onClosed]);

  const finishClose = useCallback(() => {
    setClosing(false);
    onClosed();
  }, [onClosed]);

  return { closing, requestClose, finishClose };
}
