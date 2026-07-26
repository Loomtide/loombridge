/**
 * The record-first scene-agnostic SCAN PLAN (Phase 1, D2-A/D/E). Pure. Given a recorded multi-scene
 * trace, it composes the merged primitives into ONE combined decision the live runner executes:
 *   - which scenes were visited, in first-touch order, and the slug prefix to namespace each scene's
 *     generated state/object ids by (`inferScenesFromTrace` + `sceneSlug`);
 *   - whether two distinct scenes collapse to one slug — a REFUSAL (can't namespace captures safely,
 *     `findSlugCollisions`);
 *   - which scenes demonstrate a continuous gesture with no sampled phase signal — emitted as
 *     can't-verify, never a silent green (`unverifiableGestureScenes`, invariant #4).
 *
 * This is the orchestration BRAIN; the live scan loop is the IO shell that opens + scans each scene and
 * merges the per-scene contracts. Keeping the decision pure means the MOAT calls (collision refusal,
 * can't-verify, scene ordering) are exhaustively unit-tested without an editor.
 */

import {
  inferScenesFromTrace,
  findSlugCollisions,
  sceneSlug,
} from "./minigame-scene-inference.js";
import { unverifiableGestureScenes, type UnverifiableScene } from "./minigame-scene-gating.js";
import type { ReplayTrace } from "../replay/types.js";

export interface ScenePlanEntry {
  /** Runtime scene name (evidence), as carried on the trace. */
  sceneName: string;
  /** Slug to namespace this scene's generated state/object ids by (`<slug>__<baseId>`). */
  namespacePrefix: string;
  /** False ⇒ this scene is can't-verify (invariant #4): the runner emits exit 2 for it, never grades it green. */
  verifiable: boolean;
  /** Why the scene is unverifiable (present only when `verifiable` is false). */
  reason?: string;
}

export type SceneAgnosticPlan =
  | {
      /** A real multi-scene plan the runner can execute (some scenes may be can't-verify). */
      status: "ok";
      startScene: string | undefined;
      scenes: ScenePlanEntry[];
      unverifiable: UnverifiableScene[];
    }
  | {
      /** Two distinct scenes share a slug — the runner REFUSES (exit 2) rather than merge their captures. */
      status: "collision";
      collisions: { slug: string; names: string[] }[];
    }
  | {
      /** No per-segment scene evidence — a single-scene trace; the runner uses the existing scan-first flow. */
      status: "no-evidence";
      startScene: string | undefined;
    };

/**
 * Plan the record-first scan from a recorded trace. Pure. Order of precedence is MOAT-first: a slug
 * collision is a hard refusal BEFORE any per-scene work (two scenes would otherwise share a capture
 * namespace); a trace with no scene evidence falls back to the single-scene flow; otherwise an `ok` plan
 * lists every visited scene in first-touch order with its namespace prefix and verifiability.
 */
export function planSceneAgnosticScan(
  trace: Pick<ReplayTrace, "segments" | "start">,
): SceneAgnosticPlan {
  const inferred = inferScenesFromTrace(trace);
  if (!inferred.hasEvidence) {
    return { status: "no-evidence", startScene: inferred.startScene };
  }

  // Refuse a slug collision up front: two distinct scenes that namespace to the same slug would merge
  // their captures under one filename namespace (grading scene B against scene A's frozen capture).
  const collisions = findSlugCollisions(inferred.sceneNames);
  if (collisions.length > 0) {
    return { status: "collision", collisions };
  }

  const unverifiable = unverifiableGestureScenes(trace);
  const unverifiableByName = new Map(unverifiable.map((u) => [u.sceneName, u.reason] as const));
  const scenes: ScenePlanEntry[] = inferred.sceneNames.map((sceneName) => {
    const reason = unverifiableByName.get(sceneName);
    return {
      sceneName,
      namespacePrefix: sceneSlug(sceneName),
      verifiable: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
    };
  });

  return { status: "ok", startScene: inferred.startScene, scenes, unverifiable };
}
