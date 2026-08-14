import type { ReactNode } from "react";

interface SlidePanelProps {
  /** Which window edge the panel lives on; it slides toward/away from it. */
  side: "left" | "right";
  open: boolean;
  children: ReactNode;
}

/**
 * Shared open/close animation for edge panels. The wrapper animates its width
 * while the fixed-width content translates toward its own edge, so a left
 * panel exits left and a right panel exits right. While closed the subtree is
 * `inert` and aria-hidden, keeping it out of tab order and the a11y tree.
 */
export function SlidePanel({ side, open, children }: SlidePanelProps) {
  const classes = [
    "slide-panel",
    side === "left" ? "slide-panel-left" : "slide-panel-right",
    open ? "slide-panel-open" : "slide-panel-closed",
  ].join(" ");
  return (
    <div className={classes} aria-hidden={open ? undefined : true} inert={!open}>
      {children}
    </div>
  );
}
