/**
 * Single-editor resolution for the scene-agnostic `minigame check`.
 *
 * The record-first flow spawns several short-lived CLI steps (record → scene name→path lookup →
 * per-scene scan), each of which connects to Unity independently. When MORE THAN ONE editor is open,
 * each step's discovery can pick a DIFFERENT editor — so `record` runs in project A while `scan`
 * opens a path in project B and reports "scene not found" (a real bug seen live: a GameHub
 * recording scanned against a shooter project). The MOAT held (it surfaced can't-verify, never a
 * false scan of the wrong project), but the run can't make progress.
 *
 * This PURE resolver collapses discovery records to the set of distinct live projects and decides ONE
 * target up front so the orchestrator can pin every step to the same editor:
 *   - exactly one editor  → that's the target;
 *   - zero editors        → refuse (`none`): nothing to verify against;
 *   - two or more editors → refuse (`ambiguous`): never GUESS which project to grade — list them and
 *                           tell the user to close the others or pin one explicitly;
 *   - an explicit pin     → honoured when a live editor for it is discovered, else `none` (we refuse
 *                           rather than pin blind — a blind pin would only fail later, less clearly).
 *
 * "Distinct project", not "distinct process": two editors of the SAME project expose the same scenes,
 * so either is a safe target and that is NOT ambiguous.
 */

import {
  collapseReloadChurn,
  normalizeProjectPathCanonical,
  projectPathCanonicalEquals,
  TARGET_PROJECT_ENV_VAR,
} from "../../editor-discovery.js";
import type { UnityEndpointDiscoveryRecord } from "../../types.js";

export interface EditorTarget {
  projectPathCanonical: string;
  projectName?: string;
}

export type EditorTargetResolution =
  | { ok: true; target: EditorTarget }
  | { ok: false; code: "none" | "ambiguous"; message: string; projects: EditorTarget[] };

/** The distinct live projects among the discovered editors (one entry per canonical path). */
export function distinctEditorProjects(
  records: UnityEndpointDiscoveryRecord[],
): EditorTarget[] {
  const byProject = new Map<string, EditorTarget>();
  for (const record of collapseReloadChurn(records)) {
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    if (!project) continue; // unroutable record — no canonical path
    const key = project.toLocaleLowerCase();
    if (!byProject.has(key)) {
      byProject.set(key, {
        projectPathCanonical: project,
        ...(record.projectName ? { projectName: record.projectName } : {}),
      });
    }
  }
  return [...byProject.values()];
}

function describe(target: EditorTarget): string {
  return target.projectName
    ? `${target.projectName} — ${target.projectPathCanonical}`
    : target.projectPathCanonical;
}

/**
 * Resolve the ONE editor the scene-agnostic check should run against. `envTarget` is the value of
 * `LOOMBRIDGE_TARGET_PROJECT_PATH` (an explicit user pin), if any.
 */
export function resolveSingleEditorTarget(
  records: UnityEndpointDiscoveryRecord[],
  envTarget?: string | null,
): EditorTargetResolution {
  const projects = distinctEditorProjects(records);

  const pin = normalizeProjectPathCanonical(envTarget);
  if (pin) {
    const match = projects.find((t) => projectPathCanonicalEquals(t.projectPathCanonical, pin));
    if (match) return { ok: true, target: match };
    return {
      ok: false,
      code: "none",
      message:
        `no running Unity editor was found for the pinned project (${TARGET_PROJECT_ENV_VAR}=${pin}). `
        + `Open that project's editor with the Loombridge bridge connected, or unset the pin.`,
      projects,
    };
  }

  if (projects.length === 0) {
    return {
      ok: false,
      code: "none",
      message:
        "no running Unity editor was discovered — open the project's editor and make sure the "
        + "Loombridge bridge is connected, then re-run.",
      projects,
    };
  }

  if (projects.length > 1) {
    const list = projects.map((t) => `  • ${describe(t)}`).join("\n");
    return {
      ok: false,
      code: "ambiguous",
      message:
        "multiple Unity editors are open — refusing to guess which one to verify against:\n"
        + `${list}\n`
        + `Close the others, or pin one with ${TARGET_PROJECT_ENV_VAR}=<project path>.`,
      projects,
    };
  }

  return { ok: true, target: projects[0]! };
}
