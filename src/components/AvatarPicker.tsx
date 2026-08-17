import { BlobAvatar } from "@/components/BlobAvatar";
import type { AgentShape, AvatarTone } from "@/data/agents";

const TONES: readonly AvatarTone[] = [
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

const SHAPES: readonly AgentShape[] = [
  "sphere",
  "droplet",
  "cloud",
  "egg",
  "pebble",
  "triangle",
  "squircle",
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

/** Tone + shape radio grids, shared by the creator and Edit Profile. */
export function AvatarPicker({ tone, shape, group, onChange }: AvatarPickerProps) {
  return (
    <>
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
            <BlobAvatar tone={tone} shape={option} size={26} />
          </label>
        ))}
      </fieldset>
    </>
  );
}
