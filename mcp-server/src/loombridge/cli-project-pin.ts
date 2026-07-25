import fs from "node:fs";
import path from "node:path";
import { looksLikeUnityProject } from "./bridge-install-common.js";

/**
 * Resolve which Unity editor a CLI verb should drive, so it never depends on
 * `endpoint-discovery-latest.json`.
 *
 * That file is a single shared pointer that EVERY running editor overwrites on its ~60s
 * heartbeat. A client with no pin follows it, so with two editors open the same command
 * drives whichever published most recently. Observed live: identical `trace replay`
 * invocations alternating between PASS and BLOCKED (reset-unavailable) as the pointer
 * flapped between two projects. Where two projects share locator paths the failure is
 * worse than a blocked run — inputs land in the wrong game and the captures are filed
 * under the intended one.
 *
 * Resolution order:
 *  1. an explicit `--project`-style argument, when the verb has one;
 *  2. `--root`, but only when it really is a Unity project — several verbs point `--root`
 *     at a workspace OUTSIDE the game (the flat mini-game layout), and pinning to that
 *     would match no editor at all;
 *  3. `undefined` — unpinned, the previous behaviour, which is correct and unambiguous
 *     while only one editor is running.
 *
 * Returns an absolute path; `UnityClient` canonicalises it further.
 */
export function resolveCliProjectPin(candidates: {
  project?: string | undefined;
  root?: string | undefined;
}): string | undefined {
  const explicit = candidates.project?.trim();
  if (explicit) return path.resolve(explicit);

  const root = candidates.root?.trim();
  if (!root) return undefined;
  const resolved = path.resolve(root);
  try {
    if (fs.existsSync(resolved) && looksLikeUnityProject(resolved)) return resolved;
  } catch {
    /* unreadable → fall through to unpinned rather than failing the verb */
  }
  return undefined;
}
