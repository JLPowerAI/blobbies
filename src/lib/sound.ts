import { readPreference } from "@/lib/preferences";

/**
 * The in-app turn-end chime: the sound for a Blob finishing its work while
 * you are in the app. Independent of the OS notification banner, which only
 * fires for background work and carries its own (OS-controlled) sound.
 *
 * Governed by Settings → Agent → Sounds; failures are swallowed — a missing
 * chime must never break a turn.
 */

let chime: HTMLAudioElement | null = null;

/** Half volume: a full-volume mp3 chime reads as an alarm, not a whisper. */
const CHIME_VOLUME = 0.5;

export function playChime(): void {
  if (readPreference("pref:sounds", "on") !== "on") {
    return;
  }
  try {
    chime ??= new Audio("/blobbies-notif.mp3");
    chime.volume = CHIME_VOLUME;
    chime.currentTime = 0;
    void chime.play().catch(() => {
      // Autoplay refused or the file missing: silence, not an error.
    });
  } catch {
    // Audio constructor unavailable: silence, not an error.
  }
}
