import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/** One row in a Blob's home folder listing. */
export interface HomeEntry {
  name: string;
  size: number;
  modifiedMs: number;
  isDir: boolean;
}

/**
 * File access to one Blob's sandboxed home folder. The Rust side owns all
 * path validation; this interface exists so tools and tests can run without
 * the Tauri IPC.
 */
export interface HomeBackend {
  /**
   * The Blob this sandbox belongs to. Carried on the backend rather than
   * passed alongside it so there is one source of truth for *which* sandbox:
   * `run_command` contains its file arguments against this same home
   * (`shell.rs`), and a second id argument could drift from this one.
   */
  readonly id: string;
  list(dir?: string): Promise<HomeEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The real backend: Rust commands, sandboxed under blobs/<id>/home/. */
export function tauriHome(blobId: string): HomeBackend {
  return {
    id: blobId,
    list: (dir) => invoke<HomeEntry[]>("blob_home_list", { id: blobId, dir: dir ?? null }),
    read: (path) => invoke<string>("blob_home_read", { id: blobId, path }),
    write: (path, content) => invoke<void>("blob_home_write", { id: blobId, path, content }),
    remove: (path) => invoke<void>("blob_home_delete", { id: blobId, path }),
  };
}

/**
 * Browser-dev fallback: an in-memory home so the fs tools work in `pnpm dev`
 * outside Tauri. Deliberately no persistence — parity with localStorage-level
 * dev ergonomics, not a real store.
 */
export function memoryHome(id = "dev"): HomeBackend {
  const files = new Map<string, { content: string; modifiedMs: number }>();
  const clean = (path: string): string => {
    const parts = path.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === "..") || parts.length === 0) {
      throw new Error("path is outside the Blob's home folder");
    }
    return parts.join("/");
  };
  // All async so bad paths become rejections, matching the Tauri backend.
  return {
    id,
    list: async (dir) => {
      const prefix = dir === undefined || dir === "" ? "" : `${clean(dir)}/`;
      const rows = new Map<string, HomeEntry>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        const rest = path.slice(prefix.length);
        const name = rest.split("/")[0] ?? rest;
        const isDir = rest.includes("/");
        const existing = rows.get(name);
        if (existing === undefined || !isDir) {
          rows.set(name, {
            name,
            size: isDir ? 0 : file.content.length,
            modifiedMs: file.modifiedMs,
            isDir,
          });
        }
      }
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    read: async (path) => {
      const file = files.get(clean(path));
      if (file === undefined) {
        throw new Error("no such file");
      }
      return file.content;
    },
    write: async (path, content) => {
      files.set(clean(path), { content, modifiedMs: Date.now() });
    },
    remove: async (path) => {
      const key = clean(path);
      let removed = files.delete(key);
      for (const stored of [...files.keys()]) {
        if (stored.startsWith(`${key}/`)) {
          files.delete(stored);
          removed = true;
        }
      }
      if (!removed) {
        throw new Error("no such file");
      }
    },
  };
}

/** The backend for this runtime: real files in Tauri, in-memory in a browser. */
export function homeFor(blobId: string): HomeBackend {
  return isTauri() ? tauriHome(blobId) : devHome(blobId);
}

/** Browser-dev homes keyed per Blob so switching Blobs keeps them apart. */
const devHomes = new Map<string, HomeBackend>();
function devHome(blobId: string): HomeBackend {
  let home = devHomes.get(blobId);
  if (home === undefined) {
    home = memoryHome(blobId);
    devHomes.set(blobId, home);
  }
  return home;
}
