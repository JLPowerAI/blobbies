import { useCallback, useState } from "react";

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
    // No matchMedia means a non-browser environment (jsdom) where CSS
    // animations — and therefore animationend — never happen.
    if (typeof window.matchMedia !== "function") {
      onClosed();
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
