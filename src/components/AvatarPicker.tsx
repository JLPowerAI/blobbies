import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { AgentShape, AvatarTone } from "@/data/agents";
import { useExitAnimation } from "@/lib/useExitAnimation";

/** Lightest first, then warm through cool to neutral. */
const TONES: readonly AvatarTone[] = [
  "cream",
  "brown",
  "red",
  "orange",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "gray",
];

/** Eight, so they lay out as two even rows of four. */
const SHAPES: readonly AgentShape[] = [
  "sphere",
  "pebble",
  "squircle",
  "bean",
  "triangle",
  "egg",
  "cloud",
  "droplet",
];

interface AvatarPickerProps {
  tone: AvatarTone;
  shape: AgentShape;
  /**
   * Radio group prefix. Two pickers can be mounted at once (creator and Edit
   * Profile), and shared `name`s would make them one group.
   */
  group: string;
  onChange: (patch: { tone: AvatarTone } | { shape: AgentShape }) => void;
}

/**
 * Shape then colour radio grids, shared by the creator and Edit Profile.
 *
 * Shapes first because they are the bigger decision and each one is drawn in
 * the current colour — so picking a colour repaints the row above, which reads
 * as an answer to what you just did; the reverse would redraw a row you had
 * already scrolled past.
 */
export function AvatarPicker({ tone, shape, group, onChange }: AvatarPickerProps) {
  return (
    <>
      <fieldset className="creator-shapes">
        <legend className="visually-hidden">Shape</legend>
        {SHAPES.map((option) => (
          <label
            key={option}
            className={shape === option ? "shape-option shape-option-active" : "shape-option"}
          >
            <input
              type="radio"
              name={`${group}-shape`}
              className="visually-hidden"
              value={option}
              checked={shape === option}
              onChange={() => onChange({ shape: option })}
              aria-label={option}
            />
            {/* Big enough that eight silhouettes are actually comparable — at
                thumbnail size a pebble and a bean are the same little lump. */}
            <BlobAvatar tone={tone} shape={option} size={36} />
          </label>
        ))}
      </fieldset>

      <fieldset className="creator-swatches">
        <legend className="visually-hidden">Color</legend>
        {TONES.map((option) => (
          <label
            key={option}
            className={tone === option ? "tone-swatch tone-swatch-active" : "tone-swatch"}
            data-tone={option}
          >
            <input
              type="radio"
              name={`${group}-tone`}
              className="visually-hidden"
              value={option}
              checked={tone === option}
              onChange={() => onChange({ tone: option })}
              aria-label={option}
            />
          </label>
        ))}
      </fieldset>
    </>
  );
}

/**
 * The Blob's avatar as the control that edits it: hovering reveals a pencil,
 * clicking opens the tone and shape grids in a popover.
 *
 * Folded away rather than laid out under the avatar because the two grids are
 * seventeen controls the user touches once and then never again — permanently
 * on screen they push Name, Title and Description (the fields actually being
 * edited) below the fold.
 */
export function AvatarField({ tone, shape, group, onChange }: AvatarPickerProps) {
  const [open, setOpen] = useState(false);
  const { closing, requestClose, finishClose } = useExitAnimation(() => setOpen(false));
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape here must not also close the panel behind it: this popover is
      // the innermost thing open, so it consumes the key.
      event.stopPropagation();
      requestClose();
      // Focus goes back to what opened it, or it lands on <body> and the next
      // Tab restarts from the top of the panel.
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, requestClose]);

  return (
    <div className="avatar-field">
      <button
        ref={buttonRef}
        type="button"
        className="avatar-edit-button"
        aria-label="Edit avatar"
        aria-expanded={open}
        onClick={() => (open ? requestClose() : setOpen(true))}
      >
        <BlobAvatar tone={tone} shape={shape} size={56} />
        {/* Over the avatar, not beside it: the avatar IS the target, and a
            pencil that reserved its own space would shift the layout on
            hover. Hidden from the tree — the button is already labelled. */}
        <span className="avatar-edit-pencil" aria-hidden="true">
          <Pencil size={18} strokeWidth={2} />
        </span>
      </button>

      {open ? (
        <>
          {/* Same click-away scrim as the sidebar's context menu: a transparent
              layer, so a click outside cannot land on the app underneath and
              do two things at once. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: transparent scrim; click-away mirrors Escape */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the window listener above */}
          <div className="context-menu-scrim" onClick={() => requestClose()} />
          <div
            className={closing ? "avatar-popover avatar-popover-closing" : "avatar-popover"}
            onAnimationEnd={(event) => {
              // Only the popover's own exit, never a child's: the avatars
              // inside idle-animate forever and would unmount it instantly.
              if (closing && event.target === event.currentTarget) {
                finishClose();
              }
            }}
          >
            <AvatarPicker tone={tone} shape={shape} group={group} onChange={onChange} />
          </div>
        </>
      ) : null}
    </div>
  );
}
