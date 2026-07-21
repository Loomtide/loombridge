import path from "node:path";

import { isSafeCapturePath, isWithin } from "./capture-paths.js";
import { captureKindForSlice, type CaptureKind } from "./capture-recipes.js";
import { inspectContractPresence } from "./contract-presence.js";
import { fileExists, type CurrentBuildRef, type LoomtidePaths, type LoomtideState } from "./state.js";
import type { DesignStatusReport } from "./design.js";
import {
  awaitingApprovalSlices,
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
  captureKind: CaptureKind | null;
  missing: string[];
  unsafe: string[];
}

export interface LoomtideStatusModel {
  hasRoadmap: boolean;
  /** Whether `.loomtide/ACCEPTANCE.json` exists (RCL-P04 honesty). */
  contractExists: boolean;
  /** Capture dir names present under `.loomtide/` (e.g. `["captures"]`). */
  capturePresentDirs: string[];
  /** True when captures are present but NO contract exists — captures are NOT a verification. */
  capturesWithoutContract: boolean;
  designStatus: DesignStatusReport["status"];
  designApproved: boolean;
  designFrozenMatches: boolean;
  phase?: LoomtideState["phase"];
  currentBuild?: CurrentBuildRef | null;
  counts: StatusCounts;
  currentSlice: SliceEntry | null;
  nextUnblocked: SliceEntry | null;
  awaitingApproval: SliceEntry[];
  mode: ReturnType<typeof planDispatchMode> | "no-roadmap";
  nextCommand: string;
  warnings: string[];
  captures: SliceCaptureStatus[];
}

export function developerNextAction(model: LoomtideStatusModel): string {
  if (model.nextCommand === "loomtide plan (approval flow)") {
    const id = model.awaitingApproval[0]?.id ?? model.currentSlice?.id;
    if (id) return `say "approve ${id}" or run /loomtide:plan to approve and advance.`;
    return "say approve or run /loomtide:plan to approve and advance.";
  }
  if (model.nextCommand.startsWith("loomtide capture --slice ") || model.nextCommand.startsWith("loomtide verify --slice ")) {
    const name = model.currentSlice ? `${model.currentSlice.id}` : "the current slice";
    return `${name} needs capture/verify evidence; run /loomtide:build or say continue.`;
  }
  if (model.nextCommand === "loomtide build") return "run /loomtide:build or say continue.";
  if (model.nextCommand === "loomtide plan") return "run /loomtide:plan to set up or refresh the project plan.";
  if (model.nextCommand === "loomtide design status") {
    return "the design target needs attention; run /loomtide:plan to continue the planning flow.";
  }
  if (model.nextCommand === "loomtide doneness") return "all slices are approved; ask the agent to certify done.";
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

async function captureStatusForSlice(paths: LoomtidePaths, slice: SliceEntry): Promise<SliceCaptureStatus> {
  const captureKind = captureKindForSlice(slice.acceptance.gates);
  const missing: string[] = [];
  const unsafe: string[] = [];
  const manifest = slice.proof?.captureManifest ?? [];
  const verifyRoot = path.resolve(paths.verifyInputs);
  const sliceVerifyRoot = path.resolve(getSliceVerifyDir(paths, slice.id));

  for (const entry of manifest) {
    if (!isSafeCapturePath(entry)) {
      unsafe.push(entry);
      continue;
    }
    const candidate = path.resolve(verifyRoot, entry);
    if (!isWithin(verifyRoot, candidate) || !isWithin(sliceVerifyRoot, candidate)) {
      unsafe.push(entry);
      continue;
    }
    if (!(await fileExists(candidate))) {
      missing.push(entry);
    }
  }

  return { sliceId: slice.id, captureKind, missing, unsafe };
}

function nextCommandFor(args: {
  plan: SlicePlan | null;
  designApproved: boolean;
  mode: ReturnType<typeof planDispatchMode> | "no-roadmap";
  currentSlice: SliceEntry | null;
  captures: SliceCaptureStatus[];
}): string {
  if (!args.plan || args.mode === "no-roadmap") return "loomtide plan";
  if (!args.designApproved) return "loomtide design status";
  if (!args.currentSlice) return "loomtide doneness";

  const slice = args.currentSlice;
  if (slice.state === "built") {
    const capture = args.captures.find((c) => c.sliceId === slice.id);
    if (capture && capture.captureKind && (capture.missing.length > 0 || capture.unsafe.length > 0)) {
      return `loomtide capture --slice ${slice.id}`;
    }
    return `loomtide verify --slice ${slice.id} --strict`;
  }
  if (slice.state === "verified") return "loomtide plan (approval flow)";
  if (slice.state === "pending" || slice.state === "stale") return "loomtide build";
  return "loomtide doneness";
}

export async function computeStatusModel(args: {
  paths: LoomtidePaths;
  plan: SlicePlan | null;
  state: LoomtideState | null;
  design: DesignStatusReport;
}): Promise<LoomtideStatusModel> {
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
  const warnings: string[] = [];

  // RCL-P04 honesty: capture files present but NO acceptance contract is the
  // false-green shape — surface it loudly. Captures are not a verification.
  if (presence.capturesWithoutContract) {
    warnings.push(
      `Captures present under ${presence.capturePresentDirs.map((d) => `.loomtide/${d}/`).join(", ")} but there is NO acceptance contract (.loomtide/ACCEPTANCE.json) — nothing has been graded. Captures are NOT a verification. Run \`loomtide plan\` (or \`adopt\`) first.`,
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

  const model: LoomtideStatusModel = {
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
  };
  model.nextCommand = nextCommandFor({ plan: args.plan, designApproved, mode, currentSlice, captures });
  return model;
}

export function renderPlanStatusEcho(model: LoomtideStatusModel, prefix = "loomtide plan"): void {
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

export function renderDetailedStatus(model: LoomtideStatusModel): void {
  if (!model.hasRoadmap) {
    console.error("[loomtide status] No roadmap yet.");
    // RCL-P04 honesty: never let captures read as a pass.
    if (!model.contractExists) {
      if (model.capturesWithoutContract) {
        console.error(
          `[loomtide status] Captures present under ${model.capturePresentDirs.map((d) => `.loomtide/${d}/`).join(", ")}, NO contract, NOT verified — captures are NOT a verification; nothing has been graded.`,
        );
      } else {
        console.error("[loomtide status] No acceptance contract (.loomtide/ACCEPTANCE.json) — NOT verified.");
      }
    }
    console.error(`[loomtide status] Next: ${developerNextAction(model)}`);
    if (!model.designApproved) {
      const designLabel = model.designStatus === "approved" ? "approved but changed" : model.designStatus;
      console.error(`[loomtide status] Design target: ${designLabel}`);
    }
    return;
  }

  console.error(`[loomtide status] Progress: ${model.counts.approved}/${model.counts.total} slices approved`);
  if (model.currentSlice) {
    if (model.awaitingApproval.length) {
      const names = model.awaitingApproval.map((slice) => `${slice.id} — ${slice.title}`).join(", ");
      console.error(`[loomtide status] Waiting for approval: ${names}`);
    } else {
      console.error(`[loomtide status] Current slice: ${model.currentSlice.id} — ${model.currentSlice.title}`);
    }
  } else {
    console.error("[loomtide status] Current slice: none");
  }
  console.error(`[loomtide status] Next: ${developerNextAction(model)}`);
  if (model.warnings.length) {
    console.error("[loomtide status] Warnings:");
    for (const warning of model.warnings) console.error(`  - ${warning}`);
  }
}
