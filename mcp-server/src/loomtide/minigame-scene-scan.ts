/**
 * Record-first per-scene SCAN LOOP (Phase 1 D2-A). The IO shell around the pure planner + merge: given
 * an `ok` plan (from `planSceneAgnosticScan`), open + scan each VERIFIABLE scene, assemble the per-scene
 * parts, and fuse them into one multi-scene contract (`mergeSceneContracts`). Unverifiable scenes
 * (invariant #4) and scenes whose asset path can't be resolved are returned as can't-verify — never
 * dropped, never graded green.
 *
 * IO-injected (resolveScenePath / scanScene / log) so the orchestration — which scenes are scanned,
 * which become can't-verify, the refuse-when-nothing-verifiable backstop — is unit-tested without an
 * editor. The live wiring passes a name→path resolver + a `minigame scan` subprocess.
 */

import { mergeSceneContracts, type ScenePart } from "./minigame-scene-merge.js";
import type { SceneAgnosticPlan } from "./minigame-scene-plan.js";
import type { MinigameContract } from "./minigame-profiles/types.js";

/** A scene the runner could not grade — surfaced as can't-verify (exit 2), with why. */
export interface CantVerifyScene {
  sceneName: string;
  reason: string;
}

export interface SceneScanDeps {
  /** Resolve a runtime scene NAME to its saved `Assets/**.unity` asset path, or null when it can't be
   *  mapped (unsaved / not in the project) — a null is a can't-verify for that scene, never a guess. */
  resolveScenePath: (sceneName: string) => Promise<string | null>;
  /** Open + scan one scene, returning the per-scene contract a `minigame scan` produces for it. */
  scanScene: (scenePath: string, sceneName: string) => Promise<MinigameContract>;
  log: (line: string) => void;
}

export type SceneScanResult =
  | { ok: true; contract: MinigameContract; cantVerify: CantVerifyScene[] }
  | { ok: false; error: string; cantVerify: CantVerifyScene[] };

/**
 * Drive the per-scene scan + fusion for an `ok` plan. PURE of IO (all via `deps`). Returns the fused
 * multi-scene contract plus the can't-verify scenes (invariant-#4 gesture scenes + path-unresolvable
 * scenes). If NO scene is verifiable + resolvable, there's nothing to grade → `ok:false` (can't verify
 * this build), never an empty green contract.
 */
export async function driveSceneAgnosticScan(
  plan: Extract<SceneAgnosticPlan, { status: "ok" }>,
  workspaceId: string,
  deps: SceneScanDeps,
): Promise<SceneScanResult> {
  const cantVerify: CantVerifyScene[] = [];
  const parts: ScenePart[] = [];

  for (const scene of plan.scenes) {
    if (!scene.verifiable) {
      // Invariant #4: a gesture scene with no sampled phase signal — can't close the loop honestly.
      cantVerify.push({ sceneName: scene.sceneName, reason: scene.reason ?? "can't verify (no sampled phase signal)" });
      deps.log(`⚠ ${scene.sceneName}: can't verify — ${scene.reason ?? "no sampled phase signal"}`);
      continue;
    }
    const scenePath = await deps.resolveScenePath(scene.sceneName);
    if (scenePath === null) {
      // Can't map the runtime name to a saved asset — refuse rather than guess (D5).
      cantVerify.push({ sceneName: scene.sceneName, reason: "can't resolve scene to a saved Assets/**.unity path — save the scene or it can't be opened to scan" });
      deps.log(`⚠ ${scene.sceneName}: can't verify — scene has no saved asset path`);
      continue;
    }
    deps.log(`▶ scanning ${scene.sceneName} (${scenePath})`);
    // A scan that can't run (scene won't open, subprocess/bridge failure) is a HARNESS gap → can't-verify
    // for that scene, never an unhandled throw that crashes the whole run (harness fault ≠ crash).
    let contract: MinigameContract;
    try {
      contract = await deps.scanScene(scenePath, scene.sceneName);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      cantVerify.push({ sceneName: scene.sceneName, reason: `scan failed: ${why}` });
      deps.log(`⚠ ${scene.sceneName}: can't verify — scan failed: ${why}`);
      continue;
    }
    parts.push({ prefix: scene.namespacePrefix, sceneName: scene.sceneName, contract });
  }

  if (parts.length === 0) {
    return {
      ok: false,
      error: "no verifiable scene could be scanned — nothing to grade (can't verify this build)",
      cantVerify,
    };
  }

  // mergeSceneContracts throws on a referential-integrity / singleton-conflict failure — surface it as a
  // can't-build error rather than a thrown stack (the caller turns it into exit 2).
  let contract: MinigameContract;
  try {
    contract = mergeSceneContracts(parts, workspaceId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), cantVerify };
  }
  return { ok: true, contract, cantVerify };
}
