import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

/**
 * Pointer-driven dragging for sidebar Blobs.
 *
 * Pointer events rather than HTML5 drag-and-drop: the native API gives no
 * usable drag image in a webview (and no image at all on touch), while the
 * design calls for the Blob's own avatar following the cursor. Listeners go on
 * `window`, not the row, so a drag survives the cursor leaving it.
 */

/** Movement before a press becomes a drag, so a click still selects a row. */
const DRAG_THRESHOLD = 6;

export interface BlobDrag {
  id: string;
  /** Viewport position of the floating tile. */
  x: number;
  y: number;
  /** Drop zone under the cursor, from its `data-drop` attribute. */
  over: string | null;
}

/** What the drop zone under the cursor resolves to, or null for none. */
function zoneAt(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const zone = (element as HTMLElement).dataset?.drop;
    if (zone !== undefined) {
      return zone;
    }
  }
  return null;
}

export function useBlobDrag(onDrop: (id: string, zone: string) => void) {
  const [drag, setDrag] = useState<BlobDrag | null>(null);
  /** Mirrors `drag` for the pointer listeners, whose closure would go stale. */
  const dragRef = useRef<BlobDrag | null>(null);
  dragRef.current = drag;
  /** Set for the click that ends a drag, so it does not also select the row. */
  const dragged = useRef(false);
  /** Detaches the in-flight drag's window listeners, if any. */
  const stop = useRef<(() => void) | null>(null);

  // Unmounting mid-drag must not leave listeners on window.
  useEffect(() => () => stop.current?.(), []);

  const start = (event: ReactPointerEvent, id: string) => {
    // Left button only: right-click opens the context menu.
    if (event.button !== 0) {
      return;
    }
    const originX = event.clientX;
    const originY = event.clientY;
    dragged.current = false;

    const onMove = (move: PointerEvent) => {
      const far =
        Math.abs(move.clientX - originX) > DRAG_THRESHOLD ||
        Math.abs(move.clientY - originY) > DRAG_THRESHOLD;
      if (dragRef.current === null && !far) {
        return;
      }
      dragged.current = true;
      const next = {
        id,
        x: move.clientX,
        y: move.clientY,
        over: zoneAt(move.clientX, move.clientY),
      };
      dragRef.current = next;
      setDrag(next);
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stop.current = null;
    };

    const onUp = () => {
      detach();
      const current = dragRef.current;
      if (current !== null && current.over !== null) {
        onDrop(current.id, current.over);
      }
      dragRef.current = null;
      setDrag(null);
    };

    stop.current = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return {
    drag,
    start,
    /** True when the click that just fired was the end of a drag. */
    consumeClick: () => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}
