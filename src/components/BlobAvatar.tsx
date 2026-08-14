import { type CSSProperties, useId } from "react";
import type { AgentShape, AvatarTone } from "@/data/agents";

const GRADIENTS: Record<AvatarTone, [string, string]> = {
  purple: ["#b18cfe", "#7130e6"],
  blue: ["#6cb8fd", "#1f6ff0"],
  green: ["#5fe08a", "#12a348"],
  teal: ["#4fe0c4", "#0e93b0"],
  brown: ["#b98a5e", "#6f4a2a"],
  orange: ["#ffab5e", "#f06a0a"],
  gold: ["#ffd166", "#eda313"],
  red: ["#ff7a70", "#e0201c"],
  pink: ["#ff8fc8", "#ea3d8e"],
  gray: ["#c9c9cf", "#8b8b92"],
};

/** Organic silhouettes drawn in a -88..88 box, one per agent personality. */
const SHAPES: Record<AgentShape, string> = {
  sphere:
    "M54.3,-64.9C68.6,-54.4,77.4,-36.2,79.3,-17.7C81.2,0.8,76.1,19.5,66.3,34.6" +
    "C56.5,49.7,42,61.2,25.5,67.4C9,73.6,-9.5,74.5,-26.4,68.9C-43.3,63.3,-58.6,51.2,-67.6,35.3" +
    "C-76.6,19.4,-79.3,-0.3,-73.9,-16.9C-68.5,-33.5,-55,-47,-40.1,-57.4" +
    "C-25.2,-67.8,-8.9,-75.1,7.4,-74.9C23.7,-74.7,39.9,-75.4,54.3,-64.9Z",
  droplet:
    "M0,-82C22,-52,58,-26,58,14C58,52,32,76,0,76C-32,76,-58,52,-58,14C-58,-26,-22,-52,0,-82Z",
  cloud:
    "M-38,-30C-34,-56,-6,-66,12,-54C34,-70,66,-52,62,-28C80,-18,80,10,64,22" +
    "C70,48,44,66,22,58C8,74,-24,74,-36,56C-64,60,-80,32,-66,10C-80,-10,-62,-34,-38,-30Z",
  egg: "M0,-78C36,-78,60,-42,60,4C60,46,34,76,0,76C-34,76,-60,46,-60,4C-60,-42,-36,-78,0,-78Z",
  pebble:
    "M52,-58C70,-42,80,-16,74,8C68,32,48,50,24,62C0,74,-28,78,-48,64" +
    "C-68,50,-78,20,-72,-8C-66,-36,-46,-58,-22,-68C2,-78,34,-74,52,-58Z",
  triangle: "M-8,-74C0,-82,10,-80,16,-70L72,42C78,54,72,68,58,70L-62,72C-76,72,-84,58,-76,46Z",
  squircle: "M0,-74C48,-74,74,-48,74,0C74,48,48,74,0,74C-48,74,-74,48,-74,0C-74,-48,-48,-74,0,-74Z",
};

interface Eye {
  cx: number;
  cy: number;
  /** Pill half-width. */
  rx: number;
  /** Pill half-height. */
  ry: number;
  /** Degrees; positive tilts the top toward the outside. */
  tilt: number;
}

interface Face {
  eyes: [Eye, Eye];
  /** Optional open mouth (small ellipse), for the chattier personalities. */
  mouth?: { cx: number; cy: number; rx: number; ry: number };
}

/**
 * One face per shape so each Blob reads as a different little employee:
 * alert, curious, sleepy, mischievous... Drawn from simple pill eyes so they
 * stay crisp at 24px and never read as emoji.
 */
const FACES: Record<AgentShape, Face> = {
  // Wide awake, eager: tall pills, slight inward tilt.
  sphere: {
    eyes: [
      { cx: -18, cy: -12, rx: 7, ry: 16, tilt: -8 },
      { cx: 18, cy: -12, rx: 7, ry: 16, tilt: 8 },
    ],
  },
  // Looking up, a bit dreamy: round wide-set eyes high on the drop.
  droplet: {
    eyes: [
      { cx: -20, cy: -6, rx: 8, ry: 10, tilt: 0 },
      { cx: 20, cy: -6, rx: 8, ry: 10, tilt: 0 },
    ],
  },
  // Soft and friendly: close-set little eyes with an open mouth.
  cloud: {
    eyes: [
      { cx: -14, cy: -10, rx: 6, ry: 11, tilt: -4 },
      { cx: 14, cy: -10, rx: 6, ry: 11, tilt: 4 },
    ],
    mouth: { cx: 0, cy: 16, rx: 7, ry: 5 },
  },
  // Sleepy overnight worker: low half-closed lids.
  egg: {
    eyes: [
      { cx: -17, cy: -6, rx: 10, ry: 4.5, tilt: -6 },
      { cx: 17, cy: -6, rx: 10, ry: 4.5, tilt: 6 },
    ],
  },
  // Mischievous: mismatched eyes, one squinting.
  pebble: {
    eyes: [
      { cx: -16, cy: -10, rx: 7, ry: 14, tilt: -10 },
      { cx: 18, cy: -12, rx: 7, ry: 8, tilt: 10 },
    ],
  },
  // Determined: sharp inward-angled eyes set low in the triangle.
  triangle: {
    eyes: [
      { cx: -14, cy: 14, rx: 6, ry: 13, tilt: -16 },
      { cx: 16, cy: 14, rx: 6, ry: 13, tilt: 16 },
    ],
  },
  // Deadpan sidekick: small level eyes, tiny surprised mouth.
  squircle: {
    eyes: [
      { cx: -20, cy: -8, rx: 6, ry: 9, tilt: 0 },
      { cx: 20, cy: -8, rx: 6, ry: 9, tilt: 0 },
    ],
    mouth: { cx: 0, cy: 14, rx: 5, ry: 6 },
  },
};

const FACE_COLOR = "rgba(20, 12, 8, 0.78)";

/**
 * Base idle-motion personality per shape (cycle length, starting phase).
 * Each instance then adds its own jitter so two Blobs with the same shape
 * still never move in sync. Animation is pure CSS transforms.
 */
const MOTION: Record<AgentShape, { duration: number; delay: number }> = {
  sphere: { duration: 7, delay: 0 },
  droplet: { duration: 9, delay: -2 },
  cloud: { duration: 8, delay: -5 },
  egg: { duration: 11, delay: -3 },
  pebble: { duration: 6.5, delay: -1 },
  triangle: { duration: 7.5, delay: -4 },
  squircle: { duration: 10, delay: -6 },
};

/** Cheap deterministic hash → 0..1, used to de-sync same-shape instances. */
function jitterFrom(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) / 0xffffffff;
}

interface BlobAvatarProps {
  tone: AvatarTone;
  shape?: AgentShape;
  size?: number;
  /** "thinking" swaps the idle glance for a busy squish-and-look-up loop. */
  variant?: "idle" | "thinking";
}

/** Glossy gradient blob used as each agent's identity mark. Decorative only. */
export function BlobAvatar({
  tone,
  shape = "sphere",
  size = 38,
  variant = "idle",
}: BlobAvatarProps) {
  const [light, dark] = GRADIENTS[tone];
  // The same tone can render more than once (sidebar row + chat header), so
  // gradient/clip ids must be per-instance to stay unique in the document.
  const uid = useId();
  const gradientId = `blob-fill-${uid}`;
  const clipId = `blob-clip-${uid}`;
  const motion = MOTION[shape];
  // Per-instance jitter: shift the phase by up to a full cycle and stretch
  // the cycle up to +20%, so identical shapes drift apart immediately.
  const jitter = jitterFrom(uid);
  const duration = motion.duration * (1 + jitter * 0.2);
  const delay = motion.delay - jitter * motion.duration;
  const motionStyle = {
    "--face-duration": `${duration.toFixed(2)}s`,
    "--face-delay": `${delay.toFixed(2)}s`,
  } as CSSProperties;
  return (
    <svg
      className={variant === "thinking" ? "blob-avatar blob-avatar-thinking" : "blob-avatar"}
      width={size}
      height={size}
      viewBox="-88 -88 176 176"
      aria-hidden="true"
      focusable="false"
      style={motionStyle}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={SHAPES[shape]} />
        </clipPath>
      </defs>
      <path d={SHAPES[shape]} fill={`url(#${gradientId})`} />
      <g clipPath={`url(#${clipId})`}>
        {/* Shine drifts opposite the glance, like light tracking the eyes. */}
        <g className="blob-shine">
          <ellipse
            cx="-22"
            cy="-38"
            rx="26"
            ry="16"
            fill="#ffffff"
            opacity="0.45"
            transform="rotate(-18 -22 -38)"
          />
        </g>
        <g className="blob-face">
          {FACES[shape].eyes.map((eye, index) => (
            <ellipse
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed two-eye tuple
              key={index}
              cx={eye.cx}
              cy={eye.cy}
              rx={eye.rx}
              ry={eye.ry}
              fill={FACE_COLOR}
              transform={`rotate(${eye.tilt} ${eye.cx} ${eye.cy})`}
            />
          ))}
          {FACES[shape].mouth === undefined ? null : (
            <ellipse
              cx={FACES[shape].mouth.cx}
              cy={FACES[shape].mouth.cy}
              rx={FACES[shape].mouth.rx}
              ry={FACES[shape].mouth.ry}
              fill={FACE_COLOR}
            />
          )}
        </g>
      </g>
    </svg>
  );
}
