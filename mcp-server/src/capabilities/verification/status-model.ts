import { readFile } from "node:fs/promises";
import path from "node:path";

import { isSafeCapturePath, isWithin } from "../../domain/capture-paths.js";
import { checkCaptureManifest } from "../../domain/capture-manifest.js";
import { captureRecipesForFiles, type CaptureKind } from "../../domain/capture-recipes.js";
import { inspectContractPresence } from "../../domain/contract-presence.js";
import { fileExists, type CurrentBuildRef, type LoombridgePaths, type LoombridgeState } from "../../domain/state.js";
import { gateInputFiles } from "./run-gates.js";
import type { DesignStatusReport } from "./design.js";
import {
  awaitingApprovalSlices,
  getSliceVerdictPath,
  getSliceVerifyDir,
  nextUnblockedSlice,
  planDispatchMode,
  type SliceEntry,
  type SlicePlan,
  type SliceState,
} from "./slices.js";

export interface StatusCounts {
  total: number;
  pending: number;
  built: number;
  verified: number;
  approved: number;
  stale: number;
}

export interface SliceCaptureStatus {
  sliceId: string;
  /** The recipe SET `loombridge capture --slice <id>` will run (may be empty). */
  recipes: CaptureKind[];
  /** Declared evidence files no CLI recipe produces (the agent must assemble them). */
  agentAssemblyRequired: string[];
  missing: string[];
  unsafe: string[];
}

/**
 * L32: WHICH GATE FAILED, read off the slice's own verdict.
 *
 * Observed live: after a `player-feel` verify wrote a FAIL verdict, `status` still said
 * "player-feel needs capture/verify evidence; run /loombridge:build or say continue".
 * Evidence existed, a gate had failed, and the summary line described neither, so the
 * only way to learn what was wrong was to open the verdict by hand. The next action a
 * developer is given must name the thing that is actually red.
 */
export interface SliceGateFailure {
  sliceId: string;
  /** The verdict's own status word (`fail` / `warn`). */
  status: string;
  /** Gate ids the verdict reports as `fail`. */
  failing: string[];
  /** Gate ids the verdict reports as `warn` (a partial capture, typically). */
  warning: string[];
  /** Root-relative verdict path, so the message can point at the detail. */
  verdictPath: string;
}

export interface LoombridgeStatusModel {
  hasRoadmap: boolean;
  /** Whether `.loombridge/ACCEPTANCE.json` exists (RCL-P04 honesty). */
  contractExists: boolean;
  /** Capture dir names present under `.loombridge/` (e.g. `["captures"]`). */
  capturePresentDirs: string[];
  /** True when captures are present but NO contract exists — captures are NOT a verification. */
  capturesWithoutContract: boolean;
  designStatus: DesignStatusReport["status"];
  designApproved: boolean;
  designFrozenMatches: boolean;
  phase?: LoombridgeState["phase"];
  currentBuild?: CurrentBuildRef | null;
  counts: StatusCounts;
  currentSlice: SliceEntry | null;
  nextUnblocked: SliceEntry | null;
  awaitingApproval: SliceEntry[];
  mode: ReturnType<typeof planDispatchMode> | "no-roadmap";
  nextCommand: string;
  warnings: string[];
  captures: SliceCaptureStatus[];
  /** L32: per-slice verdicts that are not green, with the gate ids that are red. */
  gateFailures: SliceGateFailure[];
}

export function developerNextAction(model: LoombridgeStatusModel): string {
  if (model.nextCommand === "loombridge plan (approval flow)") {
    const id = model.awaitingApproval[0]?.id ?? model.currentSlice?.id;
    if (id) return `say "approve ${id}" or run /loombridge:plan to approve and advance.`;
    return "say approve or run /loombridge:plan to approve and advance.";
  }
  if (model.nextCommand.startsWith("loombridge capture --slice ") || model.nextCommand.startsWith("loombridge verify --slice ")) {
    const name = model.currentSlice ? `${model.currentSlice.id}` : "the current slice";
    // L32: a verdict exists and it is RED. Say which gate, and point at the file that
    // holds the detail, instead of asking for evidence that is already on disk.
    const failure = model.gateFailures.find((f) => f.sliceId === model.currentSlice?.id);
    if (failure) {
      const red = failure.failing.length > 0 ? failure.failing : failure.warning;
      const word = failure.failing.length > 0 ? "FAILED" : "warned";
      return (
        `${name}: gate(s) ${red.join(", ")} ${word} in ${failure.verdictPath} (verdict status \`${failure.status}\`); ` +
        `fix them, then re-run \`loombridge verify --slice ${failure.sliceId} --strict\`.`
      );
    }
    return `${name} needs capture/verify evidence; run /loombridge:build or say continue.`;
  }
  if (model.nextCommand === "loombridge build") return "run /loombridge:build or say continue.";
  if (model.nextCommand === "loombridge plan") return "run /loombridge:plan to set up or refresh the project plan.";
  if (model.nextCommand === "loombridge target status") {
    return "the design target needs attention; run /loombridge:plan to continue the planning flow.";
  }
  if (model.nextCommand === "loombridge doneness") return "all slices are approved; ask the agent to certify done.";
  return model.nextCommand;
}

function describeDeps(slice: SliceEntry): string {
  if (slice.dependsOn.length === 0) return "no deps";
  return `needs ${slice.dependsOn.map((d) => `${d} ✓`).join(", ")}`;
}

function emptyCounts(): StatusCounts {
  return { total: 0, pending: 0, built: 0, verified: 0, approved: 0, stale: 0 };
}

function countsFor(plan: SlicePlan | null): StatusCounts {
  const counts = emptyCounts();
  if (!plan) return counts;
  counts.total = plan.slices.length;
  for (const slice of plan.slices) {
    counts[slice.state] += 1;
  }
  return counts;
}

async function captureStatusForSlice(paths: LoombridgePaths, slice: SliceEntry): Promise<SliceCaptureStatus> {
  // The recipe SET this slice's declared evidence resolves to, derived from the
  // same gate→file map `build` mints the manifest from.
  const dispatch = captureRecipesForFiles(gateInputFiles(slice.acceptance.gates));
  // THE shared manifest predicate (also used by `capture` and both doneness
  // paths). This was a private re-implementation of it; three copies of a
  // refusal is three chances for one to drift into a skip.
  const completeness = await checkCaptureManifest({
    manifest: slice.proof?.captureManifest ?? [],
    verifyRoot: paths.verifyInputs,
    scopeRoot: getSliceVerifyDir(paths, slice.id),
  });

  return {
    sliceId: slice.id,
    recipes: dispatch.recipes,
    agentAssemblyRequired: dispatch.unproduced,
    missing: completeness.missing,
    unsafe: completeness.unsafe,
  };
}

/**
 * Resolve one slice's verdict path the same way every other reader does: the proof's
 * own `verdictPath` when it is a safe in-root relative path, else the conventional
 * per-slice location. Returns null when the slice has neither.
 */
function sliceVerdictPathFor(paths: LoombridgePaths, slice: SliceEntry): string | null {
  const declared = slice.proof?.verdictPath;
  if (declared) {
    if (!isSafeCapturePath(declared)) return null;
    const abs = path.resolve(paths.root, declared);
    return isWithin(paths.root, abs) ? abs : null;
  }
  return getSliceVerdictPath(paths, slice.id);
}

/** L32: read a slice verdict and report the gates that are not green. Null when green/absent. */
async function gateFailureFor(paths: LoombridgePaths, slice: SliceEntry): Promise<SliceGateFailure | null> {
  const abs = sliceVerdictPathFor(paths, slice);
  if (!abs) return null;
  let verdict: { status?: unknown; gates?: unknown };
  try {
    verdict = JSON.parse(await readFile(abs, "utf-8")) as { status?: unknown; gates?: unknown };
  } catch {
    return null;
  }
  const status = typeof verdict.status === "string" ? verdict.status : "(absent)";
  const gates =
    typeof verdict.gates === "object" && verdict.gates !== null && !Array.isArray(verdict.gates)
      ? (verdict.gates as Record<string, unknown>)
      : {};
  const failing = Object.entries(gates).filter(([, v]) => v === "fail").map(([g]) => g);
  const warning = Object.entries(gates).filter(([, v]) => v === "warn").map(([g]) => g);
  if (status === "pass" && failing.length === 0 && warning.length === 0) return null;
  if (failing.length === 0 && warning.length === 0) return null;
  return { sliceId: slice.id, status, failing, warning, verdictPath: path.relative(paths.root, abs) };
}

function nextCommandFor(args: {
  plan: SlicePlan | null;
  designApproved: boolean;
  mode: ReturnType<typeof planDispatchMode> | "no-roadmap";
  currentSlice: SliceEntry | null;
  captures: SliceCaptureStatus[];
}): string {
  if (!args.plan || args.mode === "no-roadmap") return "loombridge plan";
  if (!args.designApproved) return "loombridge target status";
  if (!args.currentSlice) return "loombridge doneness";

  const slice = args.currentSlice;
  if (slice.state === "built") {
    const capture = args.captures.find((c) => c.sliceId === slice.id);
    if (capture && capture.recipes.length > 0 && (capture.missing.length > 0 || capture.unsafe.length > 0)) {
      return `loombridge capture --slice ${slice.id}`;
    }
    return `loombridge verify --slice ${slice.id} --strict`;
  }
  if (slice.state === "verified") return "loombridge plan (approval flow)";
  if (slice.state === "pending" || slice.state === "stale") return "loombridge build";
  return "loombridge doneness";
}

export async function computeStatusModel(args: {
  paths: LoombridgePaths;
  plan: SlicePlan | null;
  state: LoombridgeState | null;
  design: DesignStatusReport;
}): Promise<LoombridgeStatusModel> {
  const counts = countsFor(args.plan);
  const presence = await inspectContractPresence(args.paths);
  const designApproved = args.design.status === "approved" && args.design.frozenMatches;
  const next = args.plan ? nextUnblockedSlice(args.plan) : null;
  const awaiting = args.plan ? awaitingApprovalSlices(args.plan) : [];
  const mode = args.plan
    ? planDispatchMode({
        hasRoadmap: true,
        designApproved,
        nextSlice: next,
        awaitingApproval: awaiting.length > 0,
      })
    : "no-roadmap";
  const currentSlice = awaiting[0] ?? next;
  const relevant = args.plan
    ? args.plan.slices.filter((slice) => ["built", "verified", "approved"].includes(slice.state))
    : [];
  const captures = await Promise.all(relevant.map((slice) => captureStatusForSlice(args.paths, slice)));
  const gateFailures = (
    await Promise.all(relevant.map((slice) => gateFailureFor(args.paths, slice)))
  ).filter((f): f is SliceGateFailure => f !== null);
  const warnings: string[] = [];

  // L32, in the warnings list as well as in the next action: a red gate is the most
  // actionable fact `status` has, and it must not be reachable only by opening the
  // verdict file.
  for (const failure of gateFailures) {
    const red = failure.failing.length > 0 ? `failing gate(s): ${failure.failing.join(", ")}` : `warned gate(s): ${failure.warning.join(", ")}`;
    warnings.push(
      `${failure.sliceId}: verdict status \`${failure.status}\`: ${red} (see ${failure.verdictPath}).`,
    );
  }

  // RCL-P04 honesty: capture files present but NO acceptance contract is the
  // false-green shape — surface it loudly. Captures are not a verification.
  if (presence.capturesWithoutContract) {
    warnings.push(
      `Captures present under ${presence.capturePresentDirs.map((d) => `.loombridge/${d}/`).join(", ")} but there is NO acceptance contract (.loombridge/ACCEPTANCE.json) — nothing has been graded. Captures are NOT a verification. Run \`loombridge plan\` (or \`adopt\`) first.`,
    );
  }

  if (args.design.status === "approved" && !args.design.frozenMatches) {
    warnings.push("Design Target is approved but the hero-shot bytes changed since approval; re-approve before building.");
  }
  if (counts.stale > 0 && args.plan) {
    warnings.push(`Stale slice(s): ${args.plan.slices.filter((s) => s.state === "stale").map((s) => s.id).join(", ")}`);
  }

  for (const slice of relevant) {
    if (!slice.proof) {
      warnings.push(`${slice.id}: ${slice.state} but proof block is missing.`);
      continue;
    }
    for (const field of ["runId", "startedAt", "verdictPath"] as const) {
      if (!slice.proof[field]) warnings.push(`${slice.id}: proof.${field} is missing.`);
    }
    if (slice.proof.captureManifest === undefined) {
      warnings.push(`${slice.id}: proof.captureManifest is missing.`);
    }
    if ((slice.state === "verified" || slice.state === "approved") && !slice.proof.checkpointId) {
      warnings.push(`${slice.id}: proof.checkpointId is missing for a ${slice.state} slice.`);
    }
    if (slice.state === "approved" && !slice.proof.approvedAt) {
      warnings.push(`${slice.id}: proof.approvedAt is missing for an approved slice.`);
    }
    if ((slice.state === "verified" || slice.state === "approved") && slice.proof.verdictPath) {
      if (!isSafeCapturePath(slice.proof.verdictPath)) {
        warnings.push(`${slice.id}: proof.verdictPath is unsafe: ${slice.proof.verdictPath}`);
      } else {
        const verdictPath = path.resolve(args.paths.root, slice.proof.verdictPath);
        if (!isWithin(args.paths.root, verdictPath)) {
          warnings.push(`${slice.id}: proof.verdictPath escapes the project root: ${slice.proof.verdictPath}`);
        } else if (!(await fileExists(verdictPath))) {
          warnings.push(`${slice.id}: proof verdict file is missing: ${slice.proof.verdictPath}`);
        }
      }
    }
  }

  for (const capture of captures) {
    if (capture.unsafe.length > 0) {
      warnings.push(`${capture.sliceId}: unsafe captureManifest path(s): ${capture.unsafe.join(", ")}`);
    }
    if (capture.missing.length > 0) {
      warnings.push(`${capture.sliceId}: missing capture file(s): ${capture.missing.join(", ")}`);
      // Say WHICH of the missing files `loombridge capture` will never write, so
      // "run capture again" is not the answer a developer keeps trying. Only the
      // missing ones: an agent-assembled file already on disk is not a gap.
      const stillOwed = capture.agentAssemblyRequired.filter((file) =>
        capture.missing.some((entry) => entry === file || entry.endsWith(`/${file}`)),
      );
      if (stillOwed.length > 0) {
        warnings.push(
          `${capture.sliceId}: no CLI capture recipe produces ${stillOwed.join(", ")}; the agent must assemble ${stillOwed.length === 1 ? "it" : "them"}.`,
        );
      }
    }
  }

  const currentBuild = args.state?.currentBuild ?? null;
  if (currentBuild && args.plan) {
    const matching = args.plan.slices.find((slice) => slice.proof?.runId === currentBuild.runId);
    if (!matching) {
      warnings.push(`currentBuild.runId ${currentBuild.runId} does not match any slice proof.`);
    } else if (matching.state === "approved" && counts.approved === counts.total) {
      warnings.push(`currentBuild.runId ${currentBuild.runId} points at an already-approved roadmap.`);
    }
    if (currentSlice?.state === "built" && currentSlice.proof?.runId && currentSlice.proof.runId !== currentBuild.runId) {
      warnings.push(
        `${currentSlice.id}: built proof runId ${currentSlice.proof.runId} does not match currentBuild.runId ${currentBuild.runId}.`,
      );
    }
  }

  const model: LoombridgeStatusModel = {
    hasRoadmap: args.plan !== null,
    contractExists: presence.contractExists,
    capturePresentDirs: presence.capturePresentDirs,
    capturesWithoutContract: presence.capturesWithoutContract,
    designStatus: args.design.status,
    designApproved,
    designFrozenMatches: args.design.frozenMatches,
    phase: args.state?.phase,
    currentBuild,
    counts,
    currentSlice,
    nextUnblocked: next,
    awaitingApproval: awaiting,
    mode,
    nextCommand: "",
    warnings,
    captures,
    gateFailures,
  };
  model.nextCommand = nextCommandFor({ plan: args.plan, designApproved, mode, currentSlice, captures });
  return model;
}

export function renderPlanStatusEcho(model: LoombridgeStatusModel, prefix = "loombridge plan"): void {
  if (!model.hasRoadmap) {
    console.error(`[${prefix}] Roadmap: none yet (design phase).`);
    return;
  }
  console.error(`[${prefix}] Roadmap: ${model.counts.approved}/${model.counts.total} approved.`);
  if (model.awaitingApproval.length) {
    console.error(`[${prefix}] Awaiting approval: ${model.awaitingApproval.map((s) => s.id).join(", ")}`);
  } else if (model.nextUnblocked) {
    console.error(`[${prefix}] Next unblocked: ${model.nextUnblocked.id} (${describeDeps(model.nextUnblocked)})`);
  }
}

export function renderDetailedStatus(model: LoombridgeStatusModel): void {
  if (!model.hasRoadmap) {
    console.error("[loombridge status] No roadmap yet.");
    // RCL-P04 honesty: never let captures read as a pass.
    if (!model.contractExists) {
      if (model.capturesWithoutContract) {
        console.error(
          `[loombridge status] Captures present under ${model.capturePresentDirs.map((d) => `.loombridge/${d}/`).join(", ")}, NO contract, NOT verified — captures are NOT a verification; nothing has been graded.`,
        );
      } else {
        console.error("[loombridge status] No acceptance contract (.loombridge/ACCEPTANCE.json) — NOT verified.");
      }
    }
    console.error(`[loombridge status] Next: ${developerNextAction(model)}`);
    if (!model.designApproved) {
      const designLabel = model.designStatus === "approved" ? "approved but changed" : model.designStatus;
      console.error(`[loombridge status] Design target: ${designLabel}`);
    }
    return;
  }

  console.error(`[loombridge status] Progress: ${model.counts.approved}/${model.counts.total} slices approved`);
  if (model.currentSlice) {
    if (model.awaitingApproval.length) {
      const names = model.awaitingApproval.map((slice) => `${slice.id} — ${slice.title}`).join(", ");
      console.error(`[loombridge status] Waiting for approval: ${names}`);
    } else {
      console.error(`[loombridge status] Current slice: ${model.currentSlice.id} — ${model.currentSlice.title}`);
    }
  } else {
    console.error("[loombridge status] Current slice: none");
  }
  console.error(`[loombridge status] Next: ${developerNextAction(model)}`);
  if (model.warnings.length) {
    console.error("[loombridge status] Warnings:");
    for (const warning of model.warnings) console.error(`  - ${warning}`);
  }
}
