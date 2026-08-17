/**
 * Model-id namespace helpers for Tinfoil — a leaf module.
 *
 * `tinfoil.ts` pulls in `SecureClient` and gg-ai (the whole attestation +
 * provider stack), so the UI imports these tiny pure helpers statically and
 * reaches the real module through dynamic `import()` on action paths.
 * `tinfoil.ts` re-exports everything here; existing imports keep working.
 */

/** Namespace prefix marking a model id as Tinfoil's in `settings.model`. */
export const TINFOIL_MODEL_PREFIX = "tinfoil:";

/** Public inference endpoint (also serves the unauthenticated model list). */
export const TINFOIL_BASE_URL = "https://inference.tinfoil.sh/v1";

/** True when the Settings model choice names a Tinfoil model. */
export function isTinfoilModel(model: string): boolean {
  return model.startsWith(TINFOIL_MODEL_PREFIX);
}

/** Bare Tinfoil model id, with the `tinfoil:` namespace stripped. */
export function tinfoilModelId(model: string): string {
  return isTinfoilModel(model) ? model.slice(TINFOIL_MODEL_PREFIX.length) : model;
}
