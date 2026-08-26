import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Media tools: the thin client half of `src-tauri/src/media.rs`.
 *
 * Nothing here builds an ffmpeg argv — that is the whole point of the Rust
 * side, which assembles it from typed parameters so a model can never supply
 * one. This file only carries values across and reports what came back.
 *
 * A plain browser has no ffmpeg and no home folder, so "not installed" is the
 * only honest answer there — same shape as `listSkills`.
 */

/** What ffprobe found. */
export interface MediaInfo {
  report: string;
}

/** Where a produced file landed, home-relative. */
export interface MediaOutput {
  name: string;
  bytes: number;
}

/**
 * Is ffmpeg available? Decides whether the tools are offered at all, rather
 * than offering them and failing on use.
 */
export async function ffmpegPresent(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  try {
    return await invoke<boolean>("ffmpeg_present");
  } catch {
    return false;
  }
}

export function mediaInfo(blobId: string, path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("media_info", { id: blobId, path });
}

export function mediaClip(
  blobId: string,
  path: string,
  output: string,
  start: string,
  duration: string,
): Promise<MediaOutput> {
  return invoke<MediaOutput>("media_clip", { id: blobId, path, output, start, duration });
}

export function mediaAudio(blobId: string, path: string, output: string): Promise<MediaOutput> {
  return invoke<MediaOutput>("media_audio", { id: blobId, path, output });
}
