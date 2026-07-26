/**
 * Record-first contract assembly (Phase 1 D2-A/D/E capstone): turn a recorded trace into the contract
 * the rest of the pipeline (capture → finalize → verify) grades. Ties the merged pieces together —
 * `planSceneAgnosticScan` (the decision) + `driveSceneAgnosticScan` (the per-scene scan + fusion) — and
 * resolves the three plan branches:
 *   - no scene evidence → SINGLE-scene: scan the start scene the normal way (back-compatible);
 *   - a slug collision  → REFUSE (can't verify — two scenes would share a capture namespace);
 *   - multi-scene `ok`  → scan each verifiable scene + fuse, surfacing can't-verify scenes.
 *
 * IO-injected (the per-scene scan deps + a single-scene scan + log) so the assembly is unit-tested
 * without an editor; the live wiring records the trace and shells `minigame scan` per scene.
 */

import { planSceneAgnosticScan } from "./minigame-scene-plan.js";
import { driveSceneAgnosticScan, type SceneScanDeps, type CantVerifyScene } from "./minigame-scene-scan.js";
import type { ReplayTrace } from "../replay/types.js";
import type { MinigameContract } from "./profiles/types.js";

export interface BuildContractDeps {
  /** Per-scene scan IO (resolveScenePath / scanScene / log) for the multi-scene branch. */
  scan: SceneScanDeps;
  /** Scan the single start scene the normal way (the no-evidence / single-scene branch). */
  singleSceneScan: (startScenePath: string) => Promise<MinigameContract>;
  log: (line: string) => void;
}

export type BuildContractResult =
  | { ok: true; contract: MinigameContract; cantVerify: CantVerifyScene[]; multiScene: boolean }
  | { ok: false; error: string; cantVerify: CantVerifyScene[] };

/**
 * Build the (single- or multi-scene) contract from a recorded trace. PURE of IO (all via `deps`).
 * `ok:false` is a can't-verify (exit 2) — a slug collision, an unresolvable single start scene, or
 * nothing verifiable. `cantVerify` is always carried so the caller can surface every ungradeable scene.
 */
export async function buildContractFromTrace(
  trace: Pick<ReplayTrace, "segments" | "start">,
  workspaceId: string,
  deps: BuildContractDeps,
): Promise<BuildContractResult> {
  const plan = planSceneAgnosticScan(trace);

  if (plan.status === "collision") {
    const detail = plan.collisions.map((c) => `${c.names.join(" + ")} → '${c.slug}'`).join("; ");
    return {
      ok: false,
      error: `can't verify: two scenes share a capture namespace (${detail}) — rename a scene so they don't collide.`,
      cantVerify: plan.collisions.flatMap((c) => c.names.map((sceneName) => ({ sceneName, reason: `shares slug '${c.slug}' with another scene` }))),
    };
  }

  if (plan.status === "no-evidence") {
    // Single-scene: scan the start scene normally. `start.scene` is already a resolved asset path (#295).
    const startScene = plan.startScene;
    if (!startScene) {
      return { ok: false, error: "can't verify: the recording has no resolvable start scene", cantVerify: [] };
    }
    deps.log(`▶ single-scene recording — scanning ${startScene}`);
    try {
      const contract = await deps.singleSceneScan(startScene);
      return { ok: true, contract, cantVerify: [], multiScene: false };
    } catch (e) {
      return { ok: false, error: `can't verify: scan of '${startScene}' failed — ${e instanceof Error ? e.message : String(e)}`, cantVerify: [] };
    }
  }

  // Multi-scene: scan each verifiable scene + fuse.
  const scanned = await driveSceneAgnosticScan(plan, workspaceId, deps.scan);
  if (!scanned.ok) {
    return { ok: false, error: scanned.error, cantVerify: scanned.cantVerify };
  }
  return { ok: true, contract: scanned.contract, cantVerify: scanned.cantVerify, multiScene: true };
}
