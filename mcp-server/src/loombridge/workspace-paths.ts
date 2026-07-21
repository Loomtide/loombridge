/**
 * Shared external-workspace resolution for the partner-facing verification flows.
 *
 * Both the MINI-GAME flow (`minigame setup/run/check/...`) and the FEEL flow
 * (`verify --profile`) write their artifacts under one external workspace,
 * `~/.loombridge/projects/<id>/` — deliberately under the user's home, NOT cwd, so
 * running a verb from inside the Unity project never drops generated artifacts
 * into the game repo (the "keep the project clean" rule).
 *
 * This module is the single source of truth for HOW that path/id is derived,
 * validated, and guarded, so the two flows can't drift apart (they used to keep
 * four copies of the resolver and two divergent id sanitizers). It is a leaf —
 * it imports only Node builtins, so any module can depend on it without a cycle.
 */

import os from "node:os";
import path from "node:path";

/**
 * A valid workspace / mini-game contract id: lowercase kebab, starts with a
 * letter. This is also the mini-game contract `id` pattern (re-exported as
 * `MINIGAME_ID_PATTERN`), so a workspace id and a contract id are the same shape
 * across both flows.
 */
export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Lowercase-kebab a folder name into a candidate workspace/contract id, or
 * `undefined` if it can't (e.g. starts with a digit, all punctuation). Callers
 * REFUSE on `undefined` and ask for an explicit `--id` rather than silently
 * inventing a generic id — two underivable folders must not collide on one
 * workspace.
 */
export function sanitizeWorkspaceId(name: string): string | undefined {
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return WORKSPACE_ID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Canonicalize ANY user-typed string into a valid workspace/contract id (lowercase kebab, starting
 * with a letter): split camelCase (`StarChef` → `Star-Chef`), collapse runs of space/punctuation into
 * one hyphen, lowercase, and prefix `game-` if it would otherwise start with a digit. ALWAYS returns a
 * valid id (unlike `sanitizeWorkspaceId`, which refuses) — so an explicit `--id StarChef` is accepted
 * as `star-chef` with zero friction, IDENTICAL to the id auto-derived from a scene filename. Idempotent:
 * a value that is already canonical is returned unchanged.
 */
export function normalizeWorkspaceId(raw: string): string {
  const kebab = (raw ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const id = /^[a-z]/.test(kebab) ? kebab : `game-${kebab || "minigame"}`;
  return id.replace(/-+/g, "-");
}

/** The default workspace path for an id: `~/.loombridge/projects/<id>`. */
export function projectWorkspace(id: string): string {
  return path.resolve(os.homedir(), ".loombridge", "projects", id);
}

/** True if `child` resolves to `parent` or a path inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
