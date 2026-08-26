import { type RefObject, useEffect } from "react";

/**
 * Everything a user can Tab to. `:not([disabled])` and the negative-tabindex
 * exclusion are what keep a disabled button or a programmatically-focusable
 * container out of the cycle — the browser skips both, so the trap must too.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside a dialog, and hands focus back when it closes.
 *
 * `aria-modal="true"` is a promise to a screen reader that the rest of the
 * app is unreachable. Nothing enforces it on its own: without this, Tab walks
 * out of the dialog and into the page behind it, and the announcement is
 * simply untrue. Restoring focus is the other half — a keyboard user who
 * opened a dialog from a button is otherwise dropped back at the top of the
 * document with no idea where they were.
 *
 * The hook owns the opening focus too, because the two are one decision: what
 * to give focus back to can only be read BEFORE the dialog takes it.
 *
 * Not `inert` on the rest of the app (what SlidePanel uses): these dialogs are
 * portalled to `document.body`, so there is no one sibling subtree to mark,
 * and marking `#root` would fight the panel that owns the trigger.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    const opener = document.activeElement;
    // `preventScroll` throughout: focusing a control deep in a long dialog
    // otherwise scrolls it into view, so opening one jumps its own body.
    dialog.focus({ preventScroll: true });

    // Read on every Tab, not once: these dialogs grow rows, expand sections
    // and swap forms while open, and a list captured at mount goes stale.
    // `[hidden]` is the only visibility test done here — a layout-based one
    // (`offsetParent`) cannot be evaluated outside a real browser, and the
    // dialogs have no display-toggled controls to justify the trade.
    const stops = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.closest("[hidden]") === null,
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const focusable = stops();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        // Nothing to land on: hold focus on the dialog rather than let Tab
        // escape to the page behind it.
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active) && active !== dialog;
      // From the dialog itself (where focus starts) or from anywhere outside
      // it, Tab enters at the near edge. Between the edges the browser's own
      // order is already right and is left alone.
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    // Only Tab is intercepted, deliberately. A `focusin` guard that yanks
    // focus back on any outside focus — what the reference implementation
    // does — also fires for focus this app moves on purpose while a dialog is
    // open, and swallows it. Tab containment plus the restore below is the
    // part of the `aria-modal` promise that holds without that cost.
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Back to the control that opened it — unless the page moved on and
      // that element is gone, in which case forcing focus anywhere would be
      // a guess.
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref]);
}
