/**
 * Scene-agnostic `check` driver (Phase 1 front door): the record-first orchestration for `check --id X`
 * with NO `--scene`. Sequences record → build the (single/multi-scene) contract → write it → run the
 * existing capture/finalize/verify pipeline, and — crucially — makes any can't-verify scene DOMINATE the
 * exit code: a build that couldn't grade every touched scene is can't-verify (exit 2), never a full green,
 * even if the scenes it COULD grade pass. A partial verification is not a pass (the MOAT).
 *
 * IO-injected (record / build / writeContract / runPipeline / log) so the sequencing + the exit-code
 * precedence are unit-tested without an editor; the live wiring connects the bridge, records the human's
 * play, shells `minigame scan` per scene, and runs `driveRun`.
 */

import type { BuildContractResult } from "./minigame-scene-build.js";
import type { ReplayTrace } from "./replay/types.js";
import type { MinigameContract } from "./minigame-profiles/types.js";

/** Exit codes (mirrors the rest of the CLI): 0 ready · 1 not-ready · 2 can't-verify / harness gap. */
export const EXIT = { READY: 0, NOT_READY: 1, CANT_VERIFY: 2 } as const;

export interface SceneAgnosticCheckDeps {
  /** Record the human's cross-scene demonstration (resolves the active scene itself, #295). */
  record: () => Promise<Pick<ReplayTrace, "segments" | "start"> | { error: string }>;
  /** Build the contract from the trace (wraps `buildContractFromTrace` with live per-scene scan IO). */
  build: (trace: Pick<ReplayTrace, "segments" | "start">) => Promise<BuildContractResult>;
  /** Persist the built contract to the workspace. */
  writeContract: (contract: MinigameContract) => Promise<void>;
  /** Run capture → finalize → verify on the written contract; returns the verify exit code (0/1). */
  runPipeline: () => Promise<number>;
  log: (line: string) => void;
}

/**
 * Drive the scene-agnostic check. PURE of IO (all via `deps`). Returns the process exit code. A record
 * or build failure is exit 2 (can't verify). On a successful build, the pipeline grades the contract;
 * but if ANY scene came back can't-verify, the overall verdict is can't-verify (exit 2) regardless of the
 * graded scenes' result — the build was not fully verified.
 */
export async function runSceneAgnosticCheck(deps: SceneAgnosticCheckDeps): Promise<number> {
  const trace = await deps.record();
  if ("error" in trace) {
    deps.log(`✗ can't verify: recording failed — ${trace.error}`);
    return EXIT.CANT_VERIFY;
  }

  const built = await deps.build(trace);
  if (!built.ok) {
    deps.log(`✗ ${built.error}`);
    for (const cv of built.cantVerify) deps.log(`  · ${cv.sceneName}: ${cv.reason}`);
    return EXIT.CANT_VERIFY;
  }

  // Surface every ungradeable scene up front; they will force can't-verify below even if the rest pass.
  for (const cv of built.cantVerify) deps.log(`⚠ can't verify ${cv.sceneName}: ${cv.reason}`);

  await deps.writeContract(built.contract);
  const pipelineCode = await deps.runPipeline();

  if (built.cantVerify.length > 0) {
    // The graded scenes have a verdict, but the build as a whole couldn't be fully verified.
    deps.log(
      `🟡 Can't verify this build: ${built.cantVerify.length} scene(s) couldn't be graded (see above). ` +
        `The scenes that could be graded reported exit ${pipelineCode}.`,
    );
    return EXIT.CANT_VERIFY;
  }
  return pipelineCode;
}
