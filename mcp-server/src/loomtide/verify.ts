/**
 * `loomtide verify` — run the Tier-1 gates against the `.loomtide/` contract and
 * write the verdict. This is the ENFORCED spine (plan §3a/§3d): the build is not
 * "done" until this is green, and the guarantee is identical across Claude Code
 * and Codex precisely because it lives in this deterministic CLI, not in any
 * agent's command prose.
 *
 * It composes the existing gate runner (`verification/run-gates.ts`) rather than
 * reimplementing it — `loomtide verify` only adds `.loomtide/` path conventions,
 * STATE.md bookkeeping, and the enforcement exit code.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { runGates, VERIFY_STAGES, type VerifyStage } from "../verification/run-gates.js";
import { deriveEvidenceClasses } from "../verification/gates/evidence-classes.js";
import { assertValidAcceptanceContract } from "../verification/validator.js";
import type { AcceptanceContract } from "../verification/types.js";
import {
  fileExists,
  loomtidePaths,
  nowIso,
  readState,
  writeState,
  type LoomtidePhase,
  type LoomtideState,
} from "./state.js";
import { inspectContractPresence, noContractRefusal } from "./contract-presence.js";
import { designPaths, designStatus } from "./design.js";
import { resolveFeelProfileModule } from "./genre-registry.js";
import {
  getSliceDiagnosticPath,
  getSliceVerdictPath,
  getSliceVerifyDir,
  readSlicePlan,
  snapshotSliceFixture,
  writeSlicePlan,
  type SliceEntry,
  type SlicePlan,
} from "./slices.js";
import {
  WORKSPACE_ID_PATTERN,
  isInside,
  projectWorkspace,
  sanitizeWorkspaceId,
} from "./workspace-paths.js";

async function stageAssetManifestInput(root: string, inputsDir: string): Promise<void> {
  const paths = loomtidePaths(root);
  try {
    await fs.access(paths.assetManifest);
  } catch {
    return;
  }
  await fs.mkdir(inputsDir, { recursive: true });
  await fs.copyFile(paths.assetManifest, path.join(inputsDir, "asset-manifest.json"));
}

/**
 * The build gate. Tier-1 `fail` is always a hard failure. `warn` is a hard
 * failure only under `--strict` (which `loomtide build` uses to require green;
 * standalone/CI `verify` tolerates warns from partial captures).
 *
 * Pure + exported so the enforcement rule is exhaustively unit-tested without a
 * Unity fixture — this is the single most important line of the product.
 */
export function exitCodeForVerdict(status: string, opts: { strict: boolean }): number {
  if (status === "fail") return 1;
  if (opts.strict && status === "warn") return 1;
  return 0;
}

export async function exitCodeForLiveProfileCapture(args: {
  reportPath: string;
  verifierCode: number;
}): Promise<number> {
  try {
    const report = JSON.parse(await fs.readFile(args.reportPath, "utf-8")) as { status?: string };
    if (report.status === "incomplete") {
      console.error(
        "[loomtide verify] capture verdict incomplete; exit=2 (capture/harness gap, not a game pass).",
      );
      return 2;
    }
  } catch {
    // If the profile report cannot be read, preserve the verifier's own exit.
  }
  return args.verifierCode;
}

function phaseForStatus(status: string): LoomtidePhase {
  if (status === "pass") return "verified-green";
  if (status === "fail") return "verified-failing";
  return "verified-warn";
}

export interface VerifyArgs {
  /** Project root (the dir that contains `.loomtide/`). */
  root: string;
  /** Directory of captured op-output JSON (default `.loomtide/verify`). */
  inputsDir: string;
  /**
   * Whether `--inputs` was passed explicitly. A `--slice` run defaults `inputsDir`
   * to the per-slice capture dir, but an explicit `--inputs` override must win.
   * Absent ⇒ treated as not explicit (the per-slice default applies).
   */
  inputsExplicit?: boolean;
  /** Acceptance contract path (default `.loomtide/ACCEPTANCE.json`). */
  acceptancePath: string;
  /** Verdict output path (default `.loomtide/reports/build-verdict.json`). */
  outputPath: string;
  /** Whether `--output` was passed explicitly (profile mode has its own default). */
  outputExplicit?: boolean;
  /** Optional advisory VLM findings file. */
  vlmPath?: string;
  /** Treat `warn` as a hard failure too (require all-green). */
  strict: boolean;
  /** Print the full per-finding breakdown in the terminal (default: slim — the detail lives in the report). */
  verbose?: boolean;
  /** Suppress the resolved single-next-step footer (the `run`/`check` wrapper owns that line). */
  quietNext?: boolean;
  /**
   * Phase-scoped verification (stage-fixture harness). When set to a restricted
   * stage (construct/level/polish), the run is DIAGNOSTIC: it grades only that
   * stage's gates, writes `verify-<stage>.json`, and does NOT touch STATE or
   * write build-verdict.json — only a full run (`verify`/unset) certifies (§3a).
   */
  stage?: VerifyStage;
  /**
   * Slice-scoped verification (S2a). When set to a slice id from
   * `.loomtide/SLICES.json`, the run grades ONLY that slice's `acceptance.gates`
   * and writes a PER-SLICE verdict to `.loomtide/reports/slices/<id>.verdict.json`.
   * It does NOT touch the whole-game build-verdict.json or STATE's `lastVerdict`/
   * `phase`; a fresh pass bound to the slice proof flips `built -> verified`.
   * Mutually exclusive with `stage` — they are independent axes.
   */
  slice?: string;
  /**
   * Verify-first profile mode (S5b). When set to a shipped profile id
   * (`precision`/`classic`/`momentum`), `verify` runs standalone against the
   * profile's feel bands — no `ACCEPTANCE.json`/`SLICES.json`, no project
   * mutation — and writes the external feel workspace report. Mutually
   * exclusive with `--slice`/`--stage`. See `verify-profile.ts`.
   */
  profile?: string;
  /** External feel workspace for profile capture/report artifacts. */
  feelWorkspace?: string;
  /** Optional id used to resolve the external feel workspace. */
  feelWorkspaceId?: string;
  /** Optional measurements file for profile mode (default: none → unmeasured). */
  measurementsPath?: string;
  /** Generic existing-game feel setup mode: propose/write a capture contract. */
  setupCapture?: boolean;
  setupPlayerPath?: string;
  setupScene?: string;
  setupGame?: string;
  setupJumpButtonPath?: string;
  setupJoystickPath?: string;
  setupMoveRightKey?: string;
  setupJumpKey?: string;
  setupDashKey?: string;
  setupCoyoteProbePath?: string;
  setupJumpBufferProbePath?: string;
  setupActivatePaths?: string[];
  setupNoAutoActivate?: boolean;
  setupApply?: boolean;
  setupForce?: boolean;
  /** Live discovery: inspect a live editor to propose controls/sync signals. */
  setupDiscover?: boolean;
  setupAnimatorControllerPath?: string;
  setupAnimatorBool?: string;
  setupAnimatorHost?: string;
  captureContractPath?: string;
  measurementsOutputPath?: string;
  captureArtifactsDir?: string;
  captureOnly?: boolean;
  project?: string;
  sourceRoot?: string;
  /**
   * F4 — optional level-layout JSON for `--profile` mode (platforms/launchers/
   * collectibles, the `ReachabilityLayout` shape). When supplied, reachability runs
   * against the profile's swapped envelope and an unreachable collectible gates the
   * verdict; absent → reachability is stamped `not_run` in the report.
   */
  layoutPath?: string;
  /**
   * Mini-game verify-first mode (S6c-3). When set, `verify` grades a
   * `MinigameContract` (`--contract`) against a per-state uGUI capture pack
   * (`--captures`) using the S6c deterministic gate engine — standalone, offline,
   * no ACCEPTANCE.json/SLICES.json, no project mutation. The guided mini-game
   * flow passes paths under `~/.loomtide/projects/<id>/`; this low-level gate
   * writes to `--output` or, if omitted, the legacy root report path. Mutually exclusive with
   * `--profile`/`--slice`/`--stage`. See `verify-minigame.ts`.
   */
  minigame?: boolean;
  /** Mini-game contract path (required in `--minigame` mode). */
  contractPath?: string;
  /** Per-state capture dir (required in `--minigame` mode). */
  capturesDir?: string;
}

/** A restricted stage is a diagnostic checkpoint, not a certifiable full run. */
function isDiagnosticStage(stage: VerifyStage | undefined): boolean {
  return stage !== undefined && stage !== "verify";
}

/**
 * Run `verify` programmatically. Returns the enforcement exit code.
 * Exported for tests.
 */
export async function runVerify(args: VerifyArgs): Promise<number> {
  // Refuse-on-missing-contract (RCL-P04 / §3a refuse-when-you-can't-check). A
  // build that hand-creates `.loomtide/captures/` and never authored a contract
  // must NOT be able to run the gate to a vacuous green — there is nothing to
  // grade against. Refuse clearly and point at `loomtide plan`, rather than
  // failing later with a cryptic ENOENT on the contract read.
  if (!(await fileExists(args.acceptancePath))) {
    const presence = await inspectContractPresence(loomtidePaths(args.root));
    console.error(
      `[loomtide verify] REFUSED — ${noContractRefusal(args.acceptancePath, presence.capturePresentDirs)} The build is not verified.`,
    );
    return 2;
  }
  const acceptance = assertValidAcceptanceContract(
    JSON.parse(await fs.readFile(args.acceptancePath, "utf-8")),
  );

  // Slice-scoped verification: data-driven gate selection from the slice's
  // acceptance.gates + a PER-SLICE verdict. It does NOT mutate the whole-game
  // single-slot state (lastVerdict/phase); S2b may commit built -> verified.
  if (args.slice !== undefined) {
    return runVerifySlice(args, acceptance);
  }

  await stageAssetManifestInput(args.root, args.inputsDir);
  const report = await runGates({
    acceptance,
    inputsDir: args.inputsDir,
    vlmPath: args.vlmPath,
    stage: args.stage,
  });

  // A restricted stage is a DIAGNOSTIC checkpoint: grade only this stage's gates,
  // write `verify-<stage>.json`, and leave the §3a supervisor state untouched —
  // it is NOT a certifiable verdict (no runId/designTarget binding, no phase flip,
  // build-verdict.json is not overwritten). Only the full run certifies.
  if (isDiagnosticStage(args.stage)) {
    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(
      args.outputPath,
      `${JSON.stringify({ ...report, evidenceClasses: deriveEvidenceClasses(report), stage: args.stage, producedAt: nowIso(), diagnostic: true }, null, 2)}\n`,
      "utf-8",
    );
    const gateLine = Object.entries(report.gates)
      .filter(([, v]) => v !== "not_applicable")
      .map(([g, v]) => `${g}=${v}`)
      .join(" ");
    const code = exitCodeForVerdict(report.status, { strict: args.strict });
    console.error(`[loomtide verify] stage=${args.stage} (DIAGNOSTIC) status=${report.status} | ${gateLine}`);
    console.error(`[loomtide verify] report=${args.outputPath} exit=${code} — not a certifiable verdict; run the full \`verify\` for §3a.`);
    return code;
  }

  // Embed the frozen Design Target reference (plan §3c: "frozen = golden" — the
  // comparison target for the VLM review + regression). ADVISORY metadata only:
  // it never changes the Tier-1 `status`, like `reviewFindings`.
  const paths = loomtidePaths(args.root);
  const design = await designStatus(paths);
  const heroPng = designPaths(paths).heroPng;
  // Read currentBuild BEFORE writing state — verify is also part of the §3a
  // supervisor mechanism: the verdict records the runId of the build it
  // certifies (or null when no build is in flight). `loomtide doneness` uses
  // `verdict.runId === currentBuild.runId` to refuse stale certifications.
  const prev = await readState(paths);
  const producedAt = nowIso();
  const reportOut = {
    ...report,
    // Evidence-class matrix (dogfood learnings §6 / High #7): ALWAYS emitted so a report
    // can never compress distinct signals into one "all green" claim. An unwired
    // class reads `absent` / `no-producer`, never omitted (refuse-not-skip).
    evidenceClasses: deriveEvidenceClasses(report),
    producedAt,
    runId: prev?.currentBuild?.runId ?? null,
    designTarget: {
      status: design.status,
      // The 3D design-target split: doneness refuses to certify an approved
      // `composition-reference` (style guide for scene assembly only) — only a
      // frozen `rendered-unity-frame` is eligible for hero-shot fidelity (§3c).
      kind: design.kind,
      heroShot: design.hasPng ? path.relative(args.root, heroPng) : null,
      pngSha256: design.pngSha256 ?? null,
      frozenMatches: design.frozenMatches,
    },
  };

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, `${JSON.stringify(reportOut, null, 2)}\n`, "utf-8");

  // STATE.md bookkeeping — preserve genre/engine + supervisor block, record the
  // verdict + phase.
  const state: LoomtideState = {
    genre: prev?.genre ?? "unknown",
    engine: prev?.engine ?? "unity",
    phase: phaseForStatus(report.status),
    designTarget: prev?.designTarget,
    currentBuild: prev?.currentBuild,
    lastVerdict: {
      status: report.status,
      at: producedAt,
      verdictPath: path.relative(args.root, args.outputPath),
    },
    updatedAt: producedAt,
  };
  await writeState(paths, state);

  const code = exitCodeForVerdict(report.status, { strict: args.strict });
  const gateLine = Object.entries(report.gates)
    .map(([g, v]) => `${g}=${v}`)
    .join(" ");
  console.error(`[loomtide verify] status=${report.status} | ${gateLine}`);
  console.error(
    `[loomtide verify] verdict=${args.outputPath} exit=${code}${args.strict ? " (strict)" : ""}`,
  );
  // Advisory: a verify without an approved, frozen Design Target can't ground its
  // polish/VLM judgment (plan §3c). Never affects the Tier-1 exit code.
  if (design.status !== "approved") {
    console.error(
      "[loomtide verify] design target: NOT approved — polish/VLM judgment is ungrounded (plan §3c, advisory).",
    );
  } else if (!design.frozenMatches) {
    console.error(
      "[loomtide verify] design target: CHANGED since approval — re-approve before trusting the comparison (advisory).",
    );
  }
  if (code !== 0) {
    const why = report.status === "fail" ? "gate failures" : "warnings under --strict";
    console.error(`[loomtide verify] NOT done — ${why}. The build is not complete until this is green.`);
  }
  return code;
}

/**
 * Slice-scoped verify (S2a). Selects the slice's `acceptance.gates` (NOT the
 * `--stage` phase enum), grades only those, and writes a PER-SLICE verdict to
 * `.loomtide/reports/slices/<id>.verdict.json`. The verdict is stamped with
 * `producedAt`, the `runId` from `currentBuild` (null pre-S2b), the frozen
 * Design Target metadata, and a `slice: { id, gates }` binding so S2c doneness
 * can check freshness/fidelity and bind the verdict to the slice. It does NOT
 * write the whole-game build-verdict.json or mutate STATE's `lastVerdict`/
 * `phase`. On a fresh pass bound to the minted slice proof, it commits
 * `built -> verified` and snapshots a per-slice checkpoint.
 */
async function runVerifySlice(args: VerifyArgs, acceptance: AcceptanceContract): Promise<number> {
  const sliceId = args.slice!;
  const paths = loomtidePaths(args.root);

  const plan = await readSlicePlan(paths);
  if (!plan) {
    console.error(
      "[loomtide verify] no .loomtide/SLICES.json — run `loomtide plan` to scaffold the roadmap first.",
    );
    return 2;
  }

  const slice: SliceEntry | undefined = plan.slices.find((s) => s.id === sliceId);
  if (!slice) {
    const known = plan.slices.map((s) => s.id).join(", ") || "(none)";
    console.error(`[loomtide verify] unknown slice "${sliceId}". Known ids: ${known}.`);
    return 2;
  }

  // Default the inputs dir to the per-slice capture dir unless --inputs overrode
  // it. parseArgs records whether --inputs was explicit so an override survives.
  const inputsDir = args.inputsExplicit ? args.inputsDir : getSliceVerifyDir(paths, sliceId);
  await stageAssetManifestInput(args.root, inputsDir);

  const gates = [...slice.acceptance.gates];
  const report = await runGates({
    acceptance,
    inputsDir,
    vlmPath: args.vlmPath,
    selectGates: new Set(gates),
  });

  // §3a refuse-when-you-can't-check: every requested per-slice gate must actually
  // grade. Unknown ids are caught at rest by assertValidSlicePlan, but a supported
  // gate can still be absent (e.g. frame-integrity without --vlm) or deliberately
  // not_applicable for the contract. Either case means the requested proof is
  // incomplete. Refuse and write NO verdict file; an absent verdict reads as
  // "not done" downstream, which is right.
  const ungradedGates = gates.filter((g) => !report.gates[g] || report.gates[g] === "not_applicable");
  if (ungradedGates.length > 0) {
    console.error(
      `[loomtide verify] slice ${sliceId} REFUSED — requested gate(s) did not grade: ${ungradedGates.join(", ")}. ` +
        "A per-slice verify cannot certify unless every slice acceptance.gates entry is checked; " +
        "fix the slice's acceptance.gates, contract applicability, capture inputs, or VLM inputs.",
    );
    return 1;
  }

  // Stamp the per-slice verdict exactly like the full run does (runId from
  // currentBuild — may be null pre-S2b — + frozen designTarget metadata) so S2c
  // doneness can check freshness/fidelity, PLUS the slice binding.
  const design = await designStatus(paths);
  const heroPng = designPaths(paths).heroPng;
  const prev = await readState(paths);
  const producedAt = nowIso();
  const reportOut = {
    ...report,
    evidenceClasses: deriveEvidenceClasses(report),
    producedAt,
    runId: prev?.currentBuild?.runId ?? null,
    designTarget: {
      status: design.status,
      // The 3D design-target split: doneness refuses to certify an approved
      // `composition-reference` (style guide for scene assembly only) — only a
      // frozen `rendered-unity-frame` is eligible for hero-shot fidelity (§3c).
      kind: design.kind,
      heroShot: design.hasPng ? path.relative(args.root, heroPng) : null,
      pngSha256: design.pngSha256 ?? null,
      frozenMatches: design.frozenMatches,
    },
    slice: { id: sliceId, gates },
  };

  const writesDiagnostic = shouldWriteSliceDiagnostic(slice, prev?.currentBuild?.runId);
  const verdictPath = writesDiagnostic
    ? getSliceDiagnosticPath(paths, sliceId)
    : getSliceVerdictPath(paths, sliceId);
  const verdictOut = writesDiagnostic ? { ...reportOut, diagnostic: true } : reportOut;
  await fs.mkdir(path.dirname(verdictPath), { recursive: true });
  await fs.writeFile(verdictPath, `${JSON.stringify(verdictOut, null, 2)}\n`, "utf-8");

  const code = exitCodeForVerdict(report.status, { strict: args.strict });
  const gateLine = Object.entries(report.gates)
    .filter(([, v]) => v !== "not_applicable")
    .map(([g, v]) => `${g}=${v}`)
    .join(" ");
  console.error(`[loomtide verify] slice ${sliceId} (gates: ${gates.join(", ")}) | ${gateLine}`);
  const relVerdict = path.relative(args.root, verdictPath);
  console.error(
    writesDiagnostic
      ? `[loomtide verify] slice ${sliceId}: diagnostic (not bound to slice proof) → ${relVerdict} exit=${code}${args.strict ? " (strict)" : ""}`
      : `[loomtide verify] slice ${sliceId}: ${report.status} → ${relVerdict} exit=${code}${args.strict ? " (strict)" : ""}`,
  );
  if (code !== 0) {
    const why = report.status === "fail" ? "gate failures" : "warnings under --strict";
    console.error(`[loomtide verify] slice ${sliceId} NOT green — ${why}.`);
  }
  const flip = sliceVerifiedFlipDecision({
    slice,
    plan,
    verdictRunId: reportOut.runId,
    currentBuildRunId: prev?.currentBuild?.runId,
    status: report.status,
    code,
  });
  if (writesDiagnostic) {
    console.error(`[loomtide verify] slice ${sliceId}: diagnostic run; slice state NOT flipped.`);
  } else if (flip.ok) {
    await writeSlicePlan(paths, flip.plan);
    const checkpointId = await snapshotSliceFixture(paths, sliceId);
    console.error(`[loomtide verify] slice ${sliceId} verified; checkpoint=.loomtide-fixtures/${checkpointId}/`);
  } else {
    console.error(
      `[loomtide verify] slice ${sliceId}: verdict written, slice state NOT flipped (${flip.reasons.join("; ")}).`,
    );
  }
  return code;
}

function shouldWriteSliceDiagnostic(slice: SliceEntry, currentBuildRunId: string | undefined): boolean {
  if (slice.state !== "verified" && slice.state !== "approved") return false;
  const proofRunId = slice.proof?.runId;
  return !currentBuildRunId || !proofRunId || currentBuildRunId !== proofRunId;
}

function sliceVerifiedFlipDecision(args: {
  slice: SliceEntry;
  plan: SlicePlan;
  verdictRunId: string | null;
  currentBuildRunId: string | undefined;
  status: string;
  code: number;
}): { ok: true; plan: SlicePlan } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const proofRunId = args.slice.proof?.runId;

  if (args.slice.state !== "built") reasons.push(`slice.state is ${args.slice.state}, not built`);
  if (args.status !== "pass") reasons.push(`verdict.status is ${args.status}, not pass`);
  if (args.code !== 0) reasons.push(`verify exit is ${args.code}, not 0`);
  if (!args.verdictRunId) reasons.push("verdict.runId is missing");
  if (!args.currentBuildRunId) reasons.push("currentBuild.runId is missing");
  if (!proofRunId) reasons.push("slice.proof.runId is missing");
  if (args.verdictRunId && args.currentBuildRunId && args.verdictRunId !== args.currentBuildRunId) {
    reasons.push(`verdict.runId ${args.verdictRunId} != currentBuild.runId ${args.currentBuildRunId}`);
  }
  if (args.verdictRunId && proofRunId && args.verdictRunId !== proofRunId) {
    reasons.push(`verdict.runId ${args.verdictRunId} != slice.proof.runId ${proofRunId}`);
  }
  if (args.currentBuildRunId && proofRunId && args.currentBuildRunId !== proofRunId) {
    reasons.push(`currentBuild.runId ${args.currentBuildRunId} != slice.proof.runId ${proofRunId}`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const plan: SlicePlan = {
    ...args.plan,
    slices: args.plan.slices.map((entry) =>
      entry.id === args.slice.id
        ? {
            ...entry,
            state: "verified" as const,
            proof: {
              ...entry.proof,
              checkpointId: entry.id,
              approvedAt: entry.proof?.approvedAt ?? null,
            },
          }
        : entry,
    ),
  };
  return { ok: true, plan };
}

/** A `--help`/parse outcome. `usageError` exits 2; a bare `help` exits 0. */
type ParseHelp = { help: true; usageError?: boolean };

function feelPaths(workspace: string): {
  captureContract: string;
  measurements: string;
  captureArtifacts: string;
  report: string;
} {
  const feelRoot = path.join(workspace, "feel");
  return {
    captureContract: path.join(feelRoot, "capture-contract.json"),
    measurements: path.join(feelRoot, "profile-measurements.json"),
    captureArtifacts: path.join(feelRoot, "capture-artifacts"),
    report: path.join(feelRoot, "reports", "feel-profile.json"),
  };
}

function parseArgs(args: string[]): VerifyArgs | ParseHelp {
  let root = process.cwd();
  let inputsDir: string | undefined;
  let acceptancePath: string | undefined;
  let outputPath: string | undefined;
  let vlmPath: string | undefined;
  let strict = false;
  let verbose = false;
  let quietNext = false;
  let stage: VerifyStage | undefined;
  let slice: string | undefined;
  let profile: string | undefined;
  let feelWorkspaceId: string | undefined;
  let feelWorkspace: string | undefined;
  let measurementsPath: string | undefined;
  let setupCapture = false;
  let setupPlayerPath: string | undefined;
  let setupScene: string | undefined;
  let setupGame: string | undefined;
  let setupJumpButtonPath: string | undefined;
  let setupJoystickPath: string | undefined;
  let setupMoveRightKey: string | undefined;
  let setupJumpKey: string | undefined;
  let setupDashKey: string | undefined;
  let setupCoyoteProbePath: string | undefined;
  let setupJumpBufferProbePath: string | undefined;
  const setupActivatePaths: string[] = [];
  let setupNoAutoActivate = false;
  let setupApply = false;
  let setupForce = false;
  let setupDiscover = false;
  let setupAnimatorControllerPath: string | undefined;
  let setupAnimatorBool: string | undefined;
  let setupAnimatorHost: string | undefined;
  let captureContractPath: string | undefined;
  let measurementsOutputPath: string | undefined;
  let captureArtifactsDir: string | undefined;
  let captureOnly = false;
  let project: string | undefined;
  let sourceRoot: string | undefined;
  let layoutPath: string | undefined;
  let minigame = false;
  let contractPath: string | undefined;
  let capturesDir: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--inputs") inputsDir = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--acceptance") acceptancePath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--output") outputPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--vlm") vlmPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--strict") strict = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--quiet-next") quietNext = true;
    else if (arg === "--profile") profile = args[(i += 1)] ?? "";
    else if (arg === "--id") feelWorkspaceId = args[(i += 1)] ?? "";
    else if (arg === "--workspace") feelWorkspace = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--measurements") measurementsPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--setup-capture") setupCapture = true;
    else if (arg === "--player") setupPlayerPath = args[(i += 1)] ?? "";
    else if (arg === "--scene") setupScene = args[(i += 1)] ?? "";
    else if (arg === "--game") setupGame = args[(i += 1)] ?? "";
    else if (arg === "--jump-button") setupJumpButtonPath = args[(i += 1)] ?? "";
    else if (arg === "--joystick") setupJoystickPath = args[(i += 1)] ?? "";
    else if (arg === "--move-right-key") setupMoveRightKey = args[(i += 1)] ?? "";
    else if (arg === "--jump-key") setupJumpKey = args[(i += 1)] ?? "";
    else if (arg === "--dash-key") setupDashKey = args[(i += 1)] ?? "";
    else if (arg === "--coyote-probe") setupCoyoteProbePath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--jump-buffer-probe") setupJumpBufferProbePath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--activate") setupActivatePaths.push(args[(i += 1)] ?? "");
    else if (arg === "--no-auto-activate") setupNoAutoActivate = true;
    else if (arg === "--apply") setupApply = true;
    else if (arg === "--force") setupForce = true;
    else if (arg === "--discover") setupDiscover = true;
    else if (arg === "--animator-controller") setupAnimatorControllerPath = args[(i += 1)] ?? "";
    else if (arg === "--animator-bool") setupAnimatorBool = args[(i += 1)] ?? "";
    else if (arg === "--animator-host") setupAnimatorHost = args[(i += 1)] ?? "";
    else if (arg === "--capture-contract") captureContractPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--measurements-output") measurementsOutputPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--capture-artifacts") captureArtifactsDir = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--capture-only") captureOnly = true;
    else if (arg === "--project") project = args[(i += 1)] ?? "";
    else if (arg === "--source-root") sourceRoot = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--layout") layoutPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--minigame") minigame = true;
    else if (arg === "--contract") contractPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--captures") capturesDir = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--slice") slice = args[(i += 1)] ?? "";
    else if (arg === "--stage") {
      const value = args[(i += 1)] ?? "";
      if (!(VERIFY_STAGES as readonly string[]).includes(value)) {
        console.error(`[loomtide verify] invalid --stage "${value}". Known: ${VERIFY_STAGES.join(", ")}.`);
        return { help: true };
      }
      stage = value as VerifyStage;
    } else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      // An unknown argument is a malformed invocation, not a help request — exit 2.
      // This also catches a value-flag that swallowed the next flag as its value
      // (e.g. `--measurements --root x` leaves `x` as an unknown positional).
      console.error(`[loomtide verify] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // `--slice` and `--stage` are independent axes (slice = data-driven gate
  // selection from acceptance.gates; stage = the hardcoded phase enum). Refuse
  // both at once rather than silently picking one.
  if (slice !== undefined && stage !== undefined) {
    console.error(
      "[loomtide verify] --slice and --stage are independent axes; pass only one.",
    );
    return { help: true, usageError: true };
  }

  // The external feel workspace, resolved + guarded inside the `--profile` block
  // below (left undefined in every other mode, where it is unused).
  let resolvedFeelWorkspace: string | undefined;

  // `--profile` is the standalone verify-first mode (S5b): it grades against a
  // feel profile, not the acceptance contract / slice plan. Setup-capture extends
  // that mode with explicit drive facts, but contract-scoped build-gate flags are
  // still refused rather than silently ignored.
  if (profile !== undefined) {
    const offenders: string[] = [];
    if (slice !== undefined) offenders.push("--slice");
    if (stage !== undefined) offenders.push("--stage");
    if (inputsDir !== undefined) offenders.push("--inputs");
    if (acceptancePath !== undefined) offenders.push("--acceptance");
    if (vlmPath !== undefined) offenders.push("--vlm");
    if (offenders.length > 0) {
      console.error(
        `[loomtide verify] --profile mode ignores contract flags; remove: ${offenders.join(", ")}. ` +
          "Allowed: --root, --profile, --id, --workspace, --measurements, --layout, --setup-capture, setup/capture drive flags, --strict, --output.",
      );
      return { help: true, usageError: true };
    }
    if (feelWorkspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(feelWorkspaceId)) {
      console.error("[loomtide verify] --id must be lowercase kebab-case (letters, digits, hyphens; start with a letter).");
      return { help: true, usageError: true };
    }
    // Resolve the external feel workspace the same way the mini-game flow resolves
    // its workspace (shared `workspace-paths.ts`): explicit `--workspace`, else
    // `~/.loomtide/projects/<id>` from `--id` or the sanitized project basename.
    // Refuse an underivable id (rather than silently inventing one) and a workspace
    // inside the project (artifacts must never pollute the game repo).
    if (feelWorkspace !== undefined) {
      resolvedFeelWorkspace = feelWorkspace;
    } else {
      const feelId = feelWorkspaceId ?? sanitizeWorkspaceId(path.basename(root));
      if (!feelId) {
        console.error(
          `[loomtide verify] could not derive a workspace id from '${path.basename(root)}'; pass --id <kebab>.`,
        );
        return { help: true, usageError: true };
      }
      resolvedFeelWorkspace = projectWorkspace(feelId);
    }
    const projectAbs = path.resolve(root);
    if (isInside(resolvedFeelWorkspace, projectAbs)) {
      console.error(
        `[loomtide verify] feel workspace ${resolvedFeelWorkspace} is inside the project ${projectAbs} — ` +
          "pass --workspace <dir> outside it (the default is ~/.loomtide/projects/<id>).",
      );
      return { help: true, usageError: true };
    }
    if (setupCapture && !setupPlayerPath) {
      console.error("[loomtide verify] --setup-capture requires --player <locator-path>.");
      return { help: true, usageError: true };
    }
    if (setupApply && !setupCapture) {
      console.error("[loomtide verify] --apply is only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupActivatePaths.length > 0 || setupNoAutoActivate) && !setupCapture) {
      console.error("[loomtide verify] --activate/--no-auto-activate are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if (
      (setupDiscover
        || setupAnimatorControllerPath !== undefined
        || setupAnimatorBool !== undefined
        || setupAnimatorHost !== undefined)
      && !setupCapture
    ) {
      console.error("[loomtide verify] --discover/--animator-* are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupCoyoteProbePath !== undefined || setupJumpBufferProbePath !== undefined) && !setupCapture) {
      console.error("[loomtide verify] --coyote-probe/--jump-buffer-probe are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupAnimatorControllerPath !== undefined || setupAnimatorBool !== undefined || setupAnimatorHost !== undefined) && !setupDiscover) {
      console.error("[loomtide verify] --animator-controller/--animator-bool/--animator-host require --discover.");
      return { help: true, usageError: true };
    }
    if (captureContractPath !== undefined && setupCapture) {
      console.error("[loomtide verify] pass either --setup-capture or --capture-contract, not both.");
      return { help: true, usageError: true };
    }
    if (captureContractPath !== undefined && measurementsPath !== undefined) {
      console.error("[loomtide verify] pass either --capture-contract or --measurements, not both.");
      return { help: true, usageError: true };
    }
    if (measurementsOutputPath !== undefined && captureContractPath === undefined) {
      console.error("[loomtide verify] --measurements-output requires --capture-contract.");
      return { help: true, usageError: true };
    }
    if (captureArtifactsDir !== undefined && captureContractPath === undefined) {
      console.error("[loomtide verify] --capture-artifacts requires --capture-contract.");
      return { help: true, usageError: true };
    }
    if (captureOnly && captureContractPath === undefined) {
      console.error("[loomtide verify] --capture-only requires --capture-contract.");
      return { help: true, usageError: true };
    }
  } else if (
    setupCapture ||
    setupPlayerPath !== undefined ||
    setupScene !== undefined ||
    setupGame !== undefined ||
    setupJumpButtonPath !== undefined ||
    setupJoystickPath !== undefined ||
    setupMoveRightKey !== undefined ||
    setupJumpKey !== undefined ||
    setupCoyoteProbePath !== undefined ||
    setupJumpBufferProbePath !== undefined ||
    setupActivatePaths.length > 0 ||
    setupNoAutoActivate ||
    setupApply ||
    setupForce ||
    setupDiscover ||
    setupAnimatorControllerPath !== undefined ||
    setupAnimatorBool !== undefined ||
    setupAnimatorHost !== undefined ||
    captureContractPath !== undefined ||
    measurementsOutputPath !== undefined ||
    captureArtifactsDir !== undefined ||
    captureOnly ||
    project !== undefined ||
    sourceRoot !== undefined ||
    feelWorkspaceId !== undefined ||
    feelWorkspace !== undefined
  ) {
    console.error("[loomtide verify] profile capture/setup flags require --profile.");
    return { help: true, usageError: true };
  } else if (layoutPath !== undefined) {
    // `--layout` (F4) is only meaningful in `--profile` mode — it re-checks a level
    // against the SELECTED profile's swapped envelope. Refuse it elsewhere rather
    // than silently ignoring it.
    console.error("[loomtide verify] --layout requires --profile.");
    return { help: true, usageError: true };
  }

  // `--minigame` is the standalone S6c-3 mini-game mode: it grades a
  // MinigameContract (`--contract`) against a per-state uGUI capture pack
  // (`--captures`), not the platformer acceptance contract / slice plan / feel
  // profile. Require its two inputs and refuse every contract/profile-scoped flag
  // (rather than silently ignoring one).
  if (minigame) {
    const offenders: string[] = [];
    if (profile !== undefined) offenders.push("--profile");
    if (slice !== undefined) offenders.push("--slice");
    if (stage !== undefined) offenders.push("--stage");
    if (inputsDir !== undefined) offenders.push("--inputs");
    if (acceptancePath !== undefined) offenders.push("--acceptance");
    if (vlmPath !== undefined) offenders.push("--vlm");
    if (measurementsPath !== undefined) offenders.push("--measurements");
    if (feelWorkspaceId !== undefined) offenders.push("--id");
    if (feelWorkspace !== undefined) offenders.push("--workspace");
    if (offenders.length > 0) {
      console.error(
        `[loomtide verify] --minigame mode ignores contract/profile flags; remove: ${offenders.join(", ")}. ` +
          "Allowed: --root, --contract, --captures, --strict, --output, --verbose, --quiet-next.",
      );
      return { help: true, usageError: true };
    }
    if (contractPath === undefined || capturesDir === undefined) {
      const missing = [
        contractPath === undefined ? "--contract <path>" : null,
        capturesDir === undefined ? "--captures <dir>" : null,
      ].filter(Boolean);
      console.error(`[loomtide verify] --minigame requires ${missing.join(" and ")}.`);
      return { help: true, usageError: true };
    }
  } else if (contractPath !== undefined || capturesDir !== undefined) {
    // `--contract`/`--captures` are only meaningful in `--minigame` mode.
    console.error("[loomtide verify] --contract/--captures require --minigame.");
    return { help: true, usageError: true };
  }

  // Default every path to the `.loomtide/` convention under root. A diagnostic
  // stage defaults its output to `verify-<stage>.json` so it never clobbers the
  // certifiable build-verdict.json. (A `--slice` run ignores `outputPath` — it
  // writes the per-slice verdict path computed in runVerifySlice.)
  const paths = loomtidePaths(root);
  const defaultOutput =
    stage && stage !== "verify"
      ? path.join(paths.reports, `verify-${stage}.json`)
      : paths.verdict;
  return {
    root,
    inputsDir: inputsDir ?? paths.verifyInputs,
    inputsExplicit: inputsDir !== undefined,
    acceptancePath: acceptancePath ?? paths.acceptance,
    outputPath: outputPath ?? defaultOutput,
    outputExplicit: outputPath !== undefined,
    vlmPath,
    strict,
    verbose,
    quietNext,
    stage,
    slice,
    profile,
    feelWorkspace: resolvedFeelWorkspace,
    feelWorkspaceId,
    measurementsPath,
    setupCapture,
    setupPlayerPath,
    setupScene,
    setupGame,
    setupJumpButtonPath,
    setupJoystickPath,
    setupMoveRightKey,
    setupJumpKey,
    setupDashKey,
    setupCoyoteProbePath,
    setupJumpBufferProbePath,
    setupActivatePaths,
    setupNoAutoActivate,
    setupApply,
    setupForce,
    setupDiscover,
    setupAnimatorControllerPath,
    setupAnimatorBool,
    setupAnimatorHost,
    captureContractPath,
    measurementsOutputPath,
    captureArtifactsDir,
    captureOnly,
    project,
    sourceRoot,
    layoutPath,
    minigame,
    contractPath,
    capturesDir,
  };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loomtide verify [options]",
      "",
      "Run the Tier-1 gates against .loomtide/ACCEPTANCE.json, write the verdict,",
      "and exit non-zero unless the build is acceptable (the build gate).",
      "",
      "Options:",
      "  --root <dir>          Project root (default: cwd)",
      "  --inputs <dir>        Captured op-output dir (default: .loomtide/verify)",
      "  --acceptance <path>   Contract (default: .loomtide/ACCEPTANCE.json)",
      "  --output <path>       Verdict (default: .loomtide/reports/build-verdict.json)",
      "                        In --profile mode, overrides the profile report path",
      "                        (or setup capture contract path with --setup-capture).",
      "  --vlm <path>          Advisory VLM findings (optional)",
      "  --strict              Treat warnings as failures (require all-green)",
      "  --verbose             (--minigame) Print the full per-finding breakdown in the",
      "                        terminal (default: slim — the detail lives in the report)",
      "  --quiet-next          (--minigame) Suppress the resolved next-step footer (the",
      "                        run/check wrapper owns that line; rarely needed by hand)",
      "  --stage <name>        Phase-scoped DIAGNOSTIC run — grade only a stage's gates",
      "                        (construct | level | polish | verify). Restricted stages",
      "                        write verify-<stage>.json and do NOT certify (§3a); only",
      "                        the full run (`verify` / omitted) writes build-verdict.json.",
      "  --slice <id>          Slice-scoped run — grade ONLY the slice's acceptance.gates",
      "                        (from .loomtide/SLICES.json) and write the per-slice verdict",
      "                        to .loomtide/reports/slices/<id>.verdict.json. Defaults",
      "                        --inputs to .loomtide/verify/<id>/. Does NOT touch the",
      "                        whole-game build-verdict.json or STATE; a fresh pass",
      "                        flips the slice built -> verified. Mutually exclusive",
      "                        with --stage (they are independent axes).",
      "  --profile <id>        VERIFY-FIRST mode (S5b): grade an existing 2D platformer",
      "                        against a feel profile (precision | classic | momentum).",
      "                        Runs standalone — no ACCEPTANCE.json/SLICES.json, no project",
      "                        mutation — and writes <workspace>/feel/reports/feel-profile.{json,html,md}.",
      "                        Mutually exclusive with --slice/--stage.",
      "  --id <kebab>          Profile mode workspace id (default: sanitized basename of --root;",
      "                        refused if the basename can't derive one — pass --id explicitly).",
      "                        Resolves to ~/.loomtide/projects/<id> unless --workspace is set.",
      "  --workspace <dir>     Profile mode feel workspace (default: ~/.loomtide/projects/<id>;",
      "                        must be OUTSIDE the project — artifacts never pollute the game repo).",
      "  --measurements <path> Measured feel values for --profile mode (optional; absent",
      "                        metrics report as 'not measured', never green).",
      "  --setup-capture      Profile mode: propose/write a generic existing-game capture",
      "                        contract instead of grading. Requires --player. Default:",
      "                        <workspace>/feel/capture-contract.json.",
      "  --player <path>      Controlled subject locator path for --setup-capture.",
      "  --scene <name>       Optional scene name stored on setup locators.",
      "  --game <name>        Optional game name for the capture contract.",
      "  --jump-button <path> uGUI jump button path for pointer/mobile capture.",
      "  --joystick <path>    uGUI joystick path for hold-drag run capture.",
      "  --move-right-key <k> Input System key for keyboard run capture.",
      "  --jump-key <k>       Input System key for keyboard jump capture.",
      "  --dash-key <k>       Input System key for keyboard dash capture.",
      "  --coyote-probe <json>",
      "                        With --setup-capture, include a reviewed semantic-probe",
      "                        JSON interaction with ground-lost + jump-input anchors.",
      "  --jump-buffer-probe <json>",
      "                        With --setup-capture, include a reviewed semantic-probe",
      "                        JSON interaction with pre-jump-buffered-input + grounded-ready anchors.",
      "  --activate <path>    With --setup-capture, temporarily SetActive(true) before",
      "                        capture; repeatable. Restores the original active state.",
      "  --no-auto-activate   With --setup-capture, do not infer a common uGUI root to",
      "                        activate from declared button/joystick paths.",
      "  --discover           With --setup-capture, inspect a live editor and PROPOSE likely",
      "                        jump/joystick controls from ui.get_screen_rects. Explicit drive",
      "                        flags (--jump-button/--joystick/--jump-key/--move-right-key)",
      "                        win; ambiguous matches are reported as choices and left unbound",
      "                        (never silently picked). Routes via --project. Unreachable",
      "                        editor → exit 2.",
      "  --animator-controller <Assets/...controller>",
      "                        With --discover, enumerate the controller's bool parameters and",
      "                        propose an Animator.GetBool sync signal when unambiguous.",
      "  --animator-bool <name> With --discover, sample this Animator bool explicitly (skips",
      "                        bool discovery).",
      "  --animator-host <path> With --discover, the Animator host locator (default: --player).",
      "  --apply              With --setup-capture, write the proposed contract.",
      "  --force              Allow --setup-capture to overwrite the capture contract.",
      "  --capture-contract <path>",
      "                        Profile mode: run a generic capture contract in live Unity",
      "                        then grade the selected profile using those measurements.",
      "  --measurements-output <path>",
      "                        Output path for --capture-contract (default:",
      "                        <workspace>/feel/profile-measurements.json).",
      "  --capture-artifacts <dir>",
      "                        Raw capture artifact bundle for --capture-contract (default:",
      "                        <workspace>/feel/capture-artifacts).",
      "  --capture-only       With --capture-contract, write measurements/artifacts only;",
      "                        print the follow-up grading command instead of grading.",
      "  --project <name|path> Route live capture to a specific Unity editor/project.",
      "  --source-root <dir>  Optional Loomtide source checkout for stale-runtime guard.",
      "  --layout <path>       Level layout JSON for --profile mode (F4): platforms/",
      "                        launchers/collectibles. Re-checks the level against the",
      "                        profile's swapped jump envelope — an unreachable collectible",
      "                        FAILs. Absent → reachability is stamped 'not_run'.",
      "  --minigame            MINI-GAME mode (S6c-3): grade a 2D kids mini-game contract",
      "                        against a per-state uGUI capture pack with the deterministic",
      "                        gate engine. Standalone — no ACCEPTANCE.json/SLICES.json, no",
      "                        project mutation. Guided mini-game flows write",
      "                        ~/.loomtide/projects/<id>/reports/minigame-verification.json",
      "                        by passing --output; omitted --output uses the legacy root report path.",
      "                        Requires --contract and --captures. Mutually exclusive with",
      "                        --profile/--slice/--stage.",
      "  --contract <path>     Mini-game contract JSON (--minigame mode).",
      "  --captures <dir>      Per-state capture dir: <state>.ui-rects.json / .console.json /",
      "                        .png (--minigame mode).",
      "  -h, --help            Show this help",
      "",
      "Exit: 1 on Tier-1 fail (or warn under --strict), else 0.",
      "      In --profile mode: 1 on fail (or 'incomplete' under --strict), else 0.",
      "      In --profile --capture-contract mode: incomplete capture evidence exits 2.",
      "      In --minigame mode: 0 pass, 1 fail, 2 incomplete (nothing graded).",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  // Mini-game verify-first mode (S6c-3) branches BEFORE runVerify so the
  // unconditional ACCEPTANCE.json read never happens — this mode is standalone
  // and grades a MinigameContract against a uGUI capture pack.
  if (parsed.minigame) {
    const { runVerifyMinigame } = await import("./verify-minigame.js");
    try {
      return await runVerifyMinigame({
        root: parsed.root,
        contractPath: parsed.contractPath!,
        capturesDir: parsed.capturesDir!,
        outputPath: parsed.outputExplicit ? parsed.outputPath : undefined,
        strict: parsed.strict,
        verbose: parsed.verbose,
        quietNext: parsed.quietNext,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loomtide verify] fatal: ${message}`);
      return 1;
    }
  }
  // Verify-first profile mode (S5b) branches BEFORE runVerify so the
  // unconditional ACCEPTANCE.json read never happens — this mode is standalone.
  if (parsed.profile !== undefined) {
    // Resolve the verify-first feel grader through the genre registry — the core never imports a
    // genre pack directly. With one feel-profile genre today this is byte-identical to the prior
    // direct platformer import (same validation, same unknown-profile message, same runner).
    const feel = await resolveFeelProfileModule(parsed.profile);
    if ("unknownMessage" in feel) {
      console.error(feel.unknownMessage);
      return 2;
    }
    const { runVerifyProfile } = feel.module;
    const workspacePaths = feelPaths(parsed.feelWorkspace!);
    if (parsed.setupCapture) {
      const { proposeFeelCaptureContract, writeFeelCaptureContract } = await import("./feel-capture/setup.js");
      const { summarizeFeelCaptureProposal } = await import("./feel-capture/prompts.js");
      const output = parsed.outputExplicit
        ? parsed.outputPath
        : workspacePaths.captureContract;

      // Live discovery (opt-in): inspect a live editor for likely controls/sync
      // signals. Explicit drive flags always win; ambiguous matches are surfaced as
      // choices and left UNBOUND (never silently picked). A live/connection failure
      // is incomplete capture-setup evidence → exit 2, never a fabricated proposal.
      let jumpButtonPath = parsed.setupJumpButtonPath;
      let joystickPath = parsed.setupJoystickPath;
      let animatorBoolSignal: { bool: string; host?: string } | undefined;
      if (parsed.setupDiscover) {
        const { runFeelDiscovery } = await import("./feel-capture/discover-live.js");
        const { resolveDiscoveredRoles } = await import("./feel-capture/discover.js");
        const { unityConnectionHint } = await import("./cli-ui.js");
        try {
          const discovery = await runFeelDiscovery({
            project: parsed.project,
            scene: parsed.setupScene,
            animatorControllerPath: parsed.setupAnimatorControllerPath,
            animatorBool: parsed.setupAnimatorBool,
          });
          const resolved = resolveDiscoveredRoles({
            ui: discovery.ui,
            animatorBool: discovery.animatorBool,
            explicit: {
              jumpButtonPath: parsed.setupJumpButtonPath,
              joystickPath: parsed.setupJoystickPath,
              jumpKey: parsed.setupJumpKey,
              moveRightKey: parsed.setupMoveRightKey,
              animatorHost: parsed.setupAnimatorHost,
            },
          });
          for (const note of resolved.notes) console.error(`[loomtide verify] discover: ${note}`);
          jumpButtonPath = resolved.jumpButtonPath;
          joystickPath = resolved.joystickPath;
          animatorBoolSignal = resolved.animatorBoolSignal;
        } catch (error) {
          const hint = unityConnectionHint(error);
          if (hint) hint.forEach((line) => console.error(line));
          else console.error(`[loomtide verify] discover failed: ${error instanceof Error ? error.message : String(error)}`);
          return 2;
        }
      }

      try {
        const semanticProbes = [];
        if (parsed.setupCoyoteProbePath) {
          semanticProbes.push(JSON.parse(await fs.readFile(parsed.setupCoyoteProbePath, "utf-8")));
        }
        if (parsed.setupJumpBufferProbePath) {
          semanticProbes.push(JSON.parse(await fs.readFile(parsed.setupJumpBufferProbePath, "utf-8")));
        }
        const contract = proposeFeelCaptureContract({
          root: parsed.root,
          game: parsed.setupGame,
          scene: parsed.setupScene,
          playerPath: parsed.setupPlayerPath!,
          jumpButtonPath,
          joystickPath,
          moveRightKey: parsed.setupMoveRightKey,
          jumpKey: parsed.setupJumpKey,
          dashKey: parsed.setupDashKey,
          semanticProbes: semanticProbes.length > 0 ? semanticProbes : undefined,
          activatePaths: parsed.setupActivatePaths,
          autoActivateUiRoot: !parsed.setupNoAutoActivate,
          animatorBoolSignal,
          outputPath: output,
          force: parsed.setupForce,
        });
        for (const line of summarizeFeelCaptureProposal(contract)) console.error(`[loomtide verify] ${line}`);
        console.error(`[loomtide verify] capture contract target=${path.relative(parsed.root, output)}`);
        if (!parsed.setupApply) {
          console.error(`[loomtide verify] dry-run only. Review the proposal, then re-run with --apply to write it.`);
          return 0;
        }
        await writeFeelCaptureContract(contract, output, { force: parsed.setupForce });
        console.error(`[loomtide verify] wrote capture contract=${path.relative(parsed.root, output)}`);
        console.error(`[loomtide verify] next: run capture to produce --measurements.`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loomtide verify] setup-capture failed: ${message}`);
        return 2;
      }
    }
    // F4: load the optional level layout (pure JSON; profile grading consumes it
    // whether measurements came from a file or from a live capture run).
    let layout: import("../verification/gates/reachability.js").ReachabilityLayout | undefined;
    if (parsed.layoutPath !== undefined) {
      try {
        const raw = await fs.readFile(parsed.layoutPath, "utf-8");
        layout = JSON.parse(raw) as import("../verification/gates/reachability.js").ReachabilityLayout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loomtide verify] could not read --layout ${parsed.layoutPath}: ${message}`);
        return 2;
      }
    }
    if (parsed.captureContractPath) {
      const { runFeelCaptureLive } = await import("./feel-capture/live.js");
      const output = parsed.measurementsOutputPath
        ?? workspacePaths.measurements;
      const artifactsDir = parsed.captureArtifactsDir
        ?? workspacePaths.captureArtifacts;
      try {
        const result = await runFeelCaptureLive({
          root: parsed.root,
          contractPath: parsed.captureContractPath,
          outputPath: output,
          artifactsDir,
          project: parsed.project,
          sourceRoot: parsed.sourceRoot,
        });
        for (const warning of result.warnings) console.error(`[loomtide verify] warning: ${warning}`);
        console.error(`[loomtide verify] measurements=${path.relative(parsed.root, result.outputPath)}`);
        if (result.artifactsDir) {
          console.error(`[loomtide verify] capture-artifacts=${path.relative(parsed.root, result.artifactsDir)}`);
        }
        if (parsed.captureOnly) {
          console.error(`[loomtide verify] next: run loomtide verify --profile ${parsed.profile} --measurements ${path.relative(parsed.root, result.outputPath)}`);
          return 0;
        }
        const reportPath = parsed.outputExplicit
          ? parsed.outputPath
          : workspacePaths.report;
        const verifierCode = await runVerifyProfile({
          root: parsed.root,
          profile: parsed.profile,
          measurementsPath: result.outputPath,
          layout,
          outputPath: reportPath,
          strict: parsed.strict,
        });
        return await exitCodeForLiveProfileCapture({ reportPath, verifierCode });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loomtide verify] capture failed: ${message}`);
        return 2;
      }
    }
    try {
      return await runVerifyProfile({
        root: parsed.root,
        profile: parsed.profile,
        measurementsPath: parsed.measurementsPath,
        layout,
        outputPath: parsed.outputExplicit ? parsed.outputPath : workspacePaths.report,
        strict: parsed.strict,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loomtide verify] fatal: ${message}`);
      return 1;
    }
  }
  try {
    return await runVerify(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loomtide verify] fatal: ${message}`);
    return 1;
  }
}
