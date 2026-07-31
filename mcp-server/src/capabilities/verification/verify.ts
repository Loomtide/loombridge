/**
 * `loombridge verify` — run the Tier-1 gates against the `.loombridge/` contract and
 * write the verdict. This is the ENFORCED spine (plan §3a/§3d): the build is not
 * "done" until this is green, and the guarantee is identical across Claude Code
 * and Codex precisely because it lives in this deterministic CLI, not in any
 * agent's command prose.
 *
 * It composes the existing gate runner (`verification/run-gates.ts`) rather than
 * reimplementing it — `loombridge verify` only adds `.loombridge/` path conventions,
 * STATE.md bookkeeping, and the enforcement exit code.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  ASSET_MANIFEST_INPUT_FILE,
  captureAbsentGates,
  declaredInputFileForGate,
  gradedGates,
  isCaptureAbsentCheck,
  runGates,
  sliceEvidenceFiles,
  VERIFY_STAGES,
  type VerifyStage,
} from "./run-gates.js";
import { buildEvidenceLedger, originSummary, runBindingRefusals } from "./evidence-ledger.js";
import { deriveEvidenceClasses } from "./gates/evidence-classes.js";
import { assertValidAcceptanceContract } from "./validator.js";
import type { AcceptanceContract } from "./types.js";
import type { BuildVerdict } from "./gates/types.js";
import {
  fileExists,
  loombridgePaths,
  nowIso,
  readState,
  writeState,
  type LoombridgePhase,
  type LoombridgeState,
} from "../../domain/state.js";
import { inspectContractPresence, noContractRefusal } from "../../domain/contract-presence.js";
import { UNIFIED_SECTION_NAMES } from "./unified/report.js";
import { designPaths, designStatus } from "./design.js";
import { feelPaths } from "../feel/feel-workspace.js";
import { resolveFeelProfileModule } from "../genre/genre-registry.js";
import { deriveGenreCoverage } from "../genre/genre-coverage.js";
import { readGenrePromotionReport } from "../genre/promotion-report.js";
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
} from "../../domain/workspace-paths.js";

/**
 * Stage the project's approved `ASSET_MANIFEST.json` into the inputs dir so the
 * asset-source gate has a document to check the CAPTURED observations against.
 *
 * NEVER OVERWRITES (M6). The staged copy is the BARE manifest document; what a real
 * capture run writes at the same path is the WRAPPED shape (`{ manifest,
 * observedAssets }`), which is the only form that carries what the build actually
 * used. Clobbering the wrapped capture with the bare document turned a valid graded
 * gate into a tier-1 UNKNOWN_FIELD fail, i.e. a real capture was destroyed by the
 * convenience copy taken on the way past. Absent file, stage it; present file, leave
 * it alone and let the gate grade whatever the run captured.
 */
async function stageAssetManifestInput(root: string, inputsDir: string): Promise<void> {
  const paths = loombridgePaths(root);
  try {
    await fs.access(paths.assetManifest);
  } catch {
    return;
  }
  const staged = path.join(inputsDir, ASSET_MANIFEST_INPUT_FILE);
  try {
    await fs.access(staged);
    return; // a captured input is already there: never clobber evidence
  } catch {
    /* absent → stage the project document below */
  }
  await fs.mkdir(inputsDir, { recursive: true });
  await fs.copyFile(paths.assetManifest, staged);
}

/**
 * The build gate. Tier-1 `fail` is always a hard failure. `warn` is a hard
 * failure only under `--strict` (which `loombridge build` uses to require green;
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

/**
 * The three tiers a SLICE verdict can land in, and the exit code each one owns.
 *
 * Bare `verify` keeps its documented tiers untouched (`exitCodeForVerdict` above). A
 * slice verify is a different question and used to answer it with the same code: a
 * `warn` exited 0, which is the code a PASS returns, while the slice was not advanced.
 * Exit 0 therefore covered approved, blocked-on-warn, and never-evaluated at once
 * (ledger L64/L113). It now splits three ways:
 *
 *  - `pass`      → 0. The only approvable outcome.
 *  - `harness`   → 2. The verdict is `warn` and EVERY warning is a gate whose input file
 *                  was absent, i.e. the gate never ran. A capture gap is a harness fault
 *                  and must never read as a game defect, nor as a pass (the same tier
 *                  `runBindingRefusals` and an incomplete live-profile capture exit in).
 *  - `defect`    → 1. Anything else: a `fail`, or a `warn` over evidence that was
 *                  actually graded. Slice verify is STRICT BY DEFAULT: a warn does not
 *                  advance the slice, so reporting success for it was false advertising.
 *
 * `--strict` is consequently a no-op for `--slice` (kept for compatibility; a warn is
 * already non-zero and a pass is never upgraded).
 *
 * Pure + exported so the rule is exhaustively tested off the assembled report alone.
 */
export type SliceVerdictTier = "pass" | "defect" | "harness";

export function sliceVerdictOutcome(
  report: Pick<BuildVerdict, "status" | "gates" | "checks">,
): { code: number; tier: SliceVerdictTier; approvable: boolean; missingEvidence: string[] } {
  const absentGates = captureAbsentGates(report);
  const missingEvidence = absentGates.map((gate) => declaredInputFileForGate(gate) ?? `${gate} (input file undeclared)`);

  if (report.status === "pass") {
    return { code: 0, tier: "pass", approvable: true, missingEvidence: [] };
  }
  if (report.status === "warn") {
    const warnings = report.checks.filter((c) => c.status === "warn");
    // Refuse-not-skip: an EMPTY warning list under a `warn` status is a contradiction in
    // the report itself, so it falls to the defect tier rather than being read as "no
    // graded warnings, therefore harness".
    const allFromAbsentInputs = warnings.length > 0 && warnings.every(isCaptureAbsentCheck);
    if (allFromAbsentInputs) {
      return { code: 2, tier: "harness", approvable: false, missingEvidence };
    }
  }
  return { code: 1, tier: "defect", approvable: false, missingEvidence };
}

export async function exitCodeForLiveProfileCapture(args: {
  reportPath: string;
  verifierCode: number;
}): Promise<number> {
  try {
    const report = JSON.parse(await fs.readFile(args.reportPath, "utf-8")) as { status?: string };
    if (report.status === "incomplete") {
      console.error(
        "[loombridge verify] capture verdict incomplete; exit=2 (capture/harness gap, not a game pass).",
      );
      return 2;
    }
  } catch {
    // If the profile report cannot be read, preserve the verifier's own exit.
  }
  return args.verifierCode;
}

/**
 * The one status → phase mapping. EXPORTED (E16) so the slices roll-up in the unified
 * door records its verdict with exactly the words the flat door uses; two copies of this
 * mapping is two chances for STATE to describe a verdict nobody minted.
 */
export function phaseForStatus(status: string): LoombridgePhase {
  if (status === "pass") return "verified-green";
  if (status === "fail") return "verified-failing";
  return "verified-warn";
}

export interface VerifyArgs {
  /** Project root (the dir that contains `.loombridge/`). */
  root: string;
  /** Directory of captured op-output JSON (default `.loombridge/verify`). */
  inputsDir: string;
  /**
   * Whether `--inputs` was passed explicitly. A `--slice` run defaults `inputsDir`
   * to the per-slice capture dir, but an explicit `--inputs` override must win.
   * Absent ⇒ treated as not explicit (the per-slice default applies).
   */
  inputsExplicit?: boolean;
  /** Acceptance contract path (default `.loombridge/ACCEPTANCE.json`). */
  acceptancePath: string;
  /** Verdict output path (default `.loombridge/reports/build-verdict.json`). */
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
   * `.loombridge/SLICES.json`, the run grades ONLY that slice's `acceptance.gates`
   * and writes a PER-SLICE verdict to `.loombridge/reports/slices/<id>.verdict.json`.
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
   * flow passes paths under `~/.loombridge/projects/<id>/`; this low-level gate
   * writes to `--output` or, if omitted, the legacy root report path. Mutually exclusive with
   * `--profile`/`--slice`/`--stage`. See `verify-minigame.ts`.
   */
  minigame?: boolean;
  /** Mini-game contract path (required in `--minigame` mode). */
  contractPath?: string;
  /** Per-state capture dir (required in `--minigame` mode). */
  capturesDir?: string;
  /**
   * `--enforce-taste` (profile mode only): gate TASTE metrics as failures.
   * Default false: taste out-of-band is descriptive placement.
   */
  enforceTaste?: boolean;
  /**
   * `--snapshot`: the standalone tuning-drift mode. Grades the current measured
   * behavior against the approved feel snapshot (`loombridge feel snapshot`).
   * Mutually exclusive with `--profile`/`--minigame`/contract flags.
   */
  snapshot?: boolean;
}

/** A restricted stage is a diagnostic checkpoint, not a certifiable full run. */
function isDiagnosticStage(stage: VerifyStage | undefined): boolean {
  return stage !== undefined && stage !== "verify";
}

/**
 * The nothing-graded refusal (RFC UnifiedVerify: "a verify that checked nothing
 * must never exit 0").
 *
 * The motivating defect, observed live on a fresh project: a planned-but-uncaptured
 * project got a bare `verify` that exited 0 with every gate at `warn` and flipped
 * STATE to `verified-warn`, which an agent can quote as "verify passed". Only
 * `doneness` refused it. The refusal lives HERE, in the engine, so it closes for the
 * bare CLI, every `--inputs` form, and the `loombridge_verify` MCP tool at once.
 *
 * "Nothing graded" is read from the assembled report's own gates + checks
 * (`gradedGates`), never from an empty inputs directory: emptiness is a proxy that
 * disagrees with the report the moment a gate is contract-`not_applicable` or its
 * capture is staged from elsewhere.
 */
function refuseNothingGraded(args: { inputsDir: string; root: string; reportPath: string }): void {
  console.error(
    "[loombridge verify] REFUSED: nothing was graded. No gate consumed a captured input " +
      `(every gate is warn-on-missing-capture or not_applicable). Inputs dir: ${args.inputsDir}`,
  );
  console.error(
    `[loombridge verify] a verdict that measured nothing is NOT a pass; STATE was left untouched. Report: ${args.reportPath}`,
  );
  console.error(
    "[loombridge verify] capture the evidence first, then re-run: " +
      `loombridge capture --root ${args.root} --slice <id>  (or save each MCP op's output into ${args.inputsDir}; see \`loombridge capture --help\`).`,
  );
}

/**
 * Run `verify` programmatically. Returns the enforcement exit code.
 * Exported for tests.
 */
export async function runVerify(args: VerifyArgs): Promise<number> {
  // Refuse-on-missing-contract (RCL-P04 / §3a refuse-when-you-can't-check). A
  // build that hand-creates `.loombridge/captures/` and never authored a contract
  // must NOT be able to run the gate to a vacuous green — there is nothing to
  // grade against. Refuse clearly and point at `loombridge plan`, rather than
  // failing later with a cryptic ENOENT on the contract read.
  if (!(await fileExists(args.acceptancePath))) {
    const presence = await inspectContractPresence(loombridgePaths(args.root));
    console.error(
      `[loombridge verify] REFUSED — ${noContractRefusal(args.acceptancePath, presence.capturePresentDirs)} The build is not verified.`,
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
    const staged = gradedGates(report);
    const code = staged.length === 0 ? 2 : exitCodeForVerdict(report.status, { strict: args.strict });
    console.error(`[loombridge verify] stage=${args.stage} (DIAGNOSTIC) status=${report.status} | ${gateLine}`);
    console.error(`[loombridge verify] report=${args.outputPath} exit=${code} — not a certifiable verdict; run the full \`verify\` for §3a.`);
    // A staged run that graded nothing is still a run that checked nothing: it must
    // not read as green just because a restricted stage cannot certify anyway.
    if (staged.length === 0) {
      refuseNothingGraded({ inputsDir: args.inputsDir, root: args.root, reportPath: args.outputPath });
    }
    return code;
  }

  // Embed the frozen Design Target reference (plan §3c: "frozen = golden" — the
  // comparison target for the VLM review + regression). ADVISORY metadata only:
  // it never changes the Tier-1 `status`, like `reviewFindings`.
  const paths = loombridgePaths(args.root);
  const design = await designStatus(paths);
  const heroPng = designPaths(paths).heroPng;
  // Read currentBuild BEFORE writing state — verify is also part of the §3a
  // supervisor mechanism: the verdict records the runId of the build it
  // certifies (or null when no build is in flight). `loombridge doneness` uses
  // `verdict.runId === currentBuild.runId` to refuse stale certifications.
  const prev = await readState(paths);
  // Genre coverage (CommandSurfaceRedesign W1) — what this verdict is allowed to CLAIM, derived from
  // the registry + the on-disk promotion report. Stamped for humans and for `status`; `doneness`
  // re-derives it from the same disk truth and refuses on disagreement, so this block is a readable
  // record of the claim, never the basis for it.
  const coverage = deriveGenreCoverage({
    genre: prev?.genre ?? "unknown",
    promotion: await readGenrePromotionReport(paths),
  });
  const producedAt = nowIso();
  const reportOut = {
    ...report,
    // Evidence-class matrix (dogfood learnings §6 / High #7): ALWAYS emitted so a report
    // can never compress distinct signals into one "all green" claim. An unwired
    // class reads `absent` / `no-producer`, never omitted (refuse-not-skip).
    evidenceClasses: deriveEvidenceClasses(report),
    producedAt,
    runId: prev?.currentBuild?.runId ?? null,
    genreCoverage: coverage,
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

  // Nothing graded ⇒ refuse (2) with the verdict written but STATE untouched. The
  // verdict file stays so the run is auditable (its `warn` gates name every missing
  // capture); what must NOT happen is the phase flipping to `verified-warn`, which is
  // the artifact an agent quotes as "verify passed". A PARTIALLY graded run (at least
  // one gate consumed a real capture) keeps today's semantics exactly (0 non-strict,
  // 1 under --strict, STATE flipped): a real green over a real subset is a real result,
  // and the coverage line below is what scopes the claim.
  const graded = gradedGates(report);
  if (graded.length === 0) {
    refuseNothingGraded({ inputsDir: args.inputsDir, root: args.root, reportPath: args.outputPath });
    return 2;
  }

  // STATE.md bookkeeping — preserve genre/engine + supervisor block, record the
  // verdict + phase.
  const state: LoombridgeState = {
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
  console.error(`[loombridge verify] status=${report.status} | ${gateLine}`);
  console.error(
    `[loombridge verify] verdict=${args.outputPath} exit=${code}${args.strict ? " (strict)" : ""}`,
  );
  // Advisory: a verify without an approved, frozen Design Target can't ground its
  // polish/VLM judgment (plan §3c). Never affects the Tier-1 exit code.
  if (design.status !== "approved") {
    console.error(
      "[loombridge verify] design target: NOT approved — polish/VLM judgment is ungrounded (plan §3c, advisory).",
    );
  } else if (!design.frozenMatches) {
    console.error(
      "[loombridge verify] design target: CHANGED since approval — re-approve before trusting the comparison (advisory).",
    );
  }
  // Scope the claim at the moment it is made. A `partially-graded` green is a real green over the
  // genre-neutral gates, and saying so here (not only at `doneness`) is what stops it being read as
  // more than it is. A `graded` build prints nothing — shipped output is unchanged.
  if (coverage.coverage !== "graded") {
    console.error(
      `[loombridge verify] coverage: ${coverage.coverage} — genre "${coverage.genre}" has no ` +
        `genre-specific oracle; ${coverage.gaps.length} gap(s) recorded on the verdict (see \`genreCoverage.gaps\`).`,
    );
  }
  if (code !== 0) {
    const why = report.status === "fail" ? "gate failures" : "warnings under --strict";
    console.error(`[loombridge verify] NOT done — ${why}. The build is not complete until this is green.`);
  }
  return code;
}

/**
 * Slice-scoped verify (S2a). Selects the slice's `acceptance.gates` (NOT the
 * `--stage` phase enum), grades only those, and writes a PER-SLICE verdict to
 * `.loombridge/reports/slices/<id>.verdict.json`. The verdict is stamped with
 * `producedAt`, the `runId` from `currentBuild` (null pre-S2b), the frozen
 * Design Target metadata, and a `slice: { id, gates }` binding so S2c doneness
 * can check freshness/fidelity and bind the verdict to the slice. It does NOT
 * write the whole-game build-verdict.json or mutate STATE's `lastVerdict`/
 * `phase`. On a fresh pass bound to the minted slice proof, it commits
 * `built -> verified` and snapshots a per-slice checkpoint.
 */
async function runVerifySlice(args: VerifyArgs, acceptance: AcceptanceContract): Promise<number> {
  const sliceId = args.slice!;
  const paths = loombridgePaths(args.root);

  const plan = await readSlicePlan(paths);
  if (!plan) {
    console.error(
      "[loombridge verify] no .loombridge/SLICES.json — run `loombridge plan` to scaffold the roadmap first.",
    );
    return 2;
  }

  const slice: SliceEntry | undefined = plan.slices.find((s) => s.id === sliceId);
  if (!slice) {
    const known = plan.slices.map((s) => s.id).join(", ") || "(none)";
    console.error(`[loombridge verify] unknown slice "${sliceId}". Known ids: ${known}.`);
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
      `[loombridge verify] slice ${sliceId} REFUSED — requested gate(s) did not grade: ${ungradedGates.join(", ")}. ` +
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

  // ── THE EVIDENCE LEDGER (H3) + RUN BINDING AT GRADE TIME (E4/L106) ──────────
  //
  // The verdict records a sha256 per file the gates just read, so a later reader
  // (the roll-up door) can ask "is this still the evidence that was approved?" :
  // a question no previous verdict could answer, which is how an approved
  // `parallax` verdict survived a later slice rewriting the exact quantities it
  // had graded.
  //
  // THE RUN the verdict is minted under: `currentBuild.runId` when a build is in
  // flight, else the slice's own proof runId. Producer-written evidence stamped
  // with a DIFFERENT run is a measurement of another build, and grading it while
  // stamping this run's id on the verdict is the mixed-vintage certificate L106
  // recorded. That is a refusal, and NO verdict is written: an absent verdict
  // reads as "not done" downstream, which is right.
  const mintedRunId = prev?.currentBuild?.runId ?? slice.proof?.runId ?? null;
  const ledger = await buildEvidenceLedger({
    root: args.root,
    inputsDir,
    files: sliceEvidenceFiles(gates),
    runId: prev?.currentBuild?.runId ?? null,
  });
  const binding = runBindingRefusals({ ledger, mintedRunId, label: `slice ${sliceId}` });
  for (const note of binding.notes) console.error(`[loombridge verify] note: ${note}`);
  if (binding.refusals.length > 0) {
    console.error(
      `[loombridge verify] slice ${sliceId} REFUSED: the evidence does not bind to this run (harness tier, not a game defect):`,
    );
    for (const refusal of binding.refusals) console.error(`  - ${refusal}`);
    console.error(
      `[loombridge verify] no verdict was written. Re-capture this slice in ONE session under the current run: ` +
        `loombridge capture --root ${args.root} --slice ${sliceId}`,
    );
    return 2;
  }

  const producedAt = nowIso();
  const reportOut = {
    ...report,
    evidenceClasses: deriveEvidenceClasses(report),
    // H3: the bytes this verdict graded, per file, with the re-derived
    // evidenceOrigin beside each (M18: reported, never wired into
    // requiredEvidenceClasses).
    evidence: ledger,
    /**
     * E15: the run-binding QUALIFICATIONS this verdict was minted under. Always written
     * (an empty array when there are none), because these notes are exactly the facts a
     * refusal would have carried and a check that softened from refusal to note has to
     * leave its reasoning somewhere a later reader can find. A note printed only to
     * stderr is invisible to `doneness`, to the roll-up, and to a human reading the
     * verdict a week later.
     */
    runBindingNotes: binding.notes,
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
  const outcome = sliceVerdictOutcome(report);
  const code = outcome.code;
  /**
   * MACHINE-READABLE approvability (the C6/PIPESTATUS lesson: three separate runs lost
   * this verb's exit code to a pipe and were saved only because the CLI also PRINTS it).
   * A reader that cannot see the exit code must still be able to answer the only
   * question that matters: may this slice be approved on the strength of this verdict?
   *
   * A diagnostic verdict is never approvable however green it is: it is not bound to the
   * slice's proof, which is exactly why it was written to the diagnostic path.
   */
  const approvable = outcome.approvable && !writesDiagnostic;
  const verdictPath = writesDiagnostic
    ? getSliceDiagnosticPath(paths, sliceId)
    : getSliceVerdictPath(paths, sliceId);
  const verdictOut = writesDiagnostic
    ? { ...reportOut, approvable, diagnostic: true }
    : { ...reportOut, approvable };
  await fs.mkdir(path.dirname(verdictPath), { recursive: true });
  await fs.writeFile(verdictPath, `${JSON.stringify(verdictOut, null, 2)}\n`, "utf-8");

  if (args.strict) {
    // Kept for compatibility (scripts pass it), but it can no longer change anything:
    // a slice warn is already non-zero and a pass is never upgraded. Say so rather than
    // letting the flag imply this run was graded more harshly than a bare one.
    console.error(
      `[loombridge verify] slice ${sliceId}: --strict is a NO-OP for --slice (slice verify is strict by default: a warn never exits 0).`,
    );
  }
  const gateLine = Object.entries(report.gates)
    .filter(([, v]) => v !== "not_applicable")
    .map(([g, v]) => `${g}=${v}`)
    .join(" ");
  console.error(`[loombridge verify] slice ${sliceId} (gates: ${gates.join(", ")}) | ${gateLine}`);
  // M18: the origin mix of the evidence behind that gate line, printed where the
  // verdict is made. "Every gate green" and "every gate green over files the agent
  // wrote itself" must not print identically.
  console.error(
    `[loombridge verify] slice ${sliceId} evidence: ${ledger.files.length} file(s) [${originSummary(ledger)}]` +
      `${ledger.missing.length > 0 ? `; ${ledger.missing.length} declared input(s) absent: ${ledger.missing.join(", ")}` : ""}`,
  );
  const relVerdict = path.relative(args.root, verdictPath);
  console.error(
    writesDiagnostic
      ? `[loombridge verify] slice ${sliceId}: diagnostic (not bound to slice proof) → ${relVerdict} exit=${code} approvable=${approvable}`
      : `[loombridge verify] slice ${sliceId}: ${report.status} → ${relVerdict} exit=${code} approvable=${approvable}`,
  );
  if (outcome.tier === "harness") {
    // Never a pass, never a game bug: the gates below never ran, so this verdict says
    // nothing about the game at all. Name the files, because the fix is to capture them.
    console.error(
      `[loombridge verify] slice ${sliceId} NOT GRADED: harness/capture gap (exit 2, not a game defect): ` +
        `gate(s) ${captureAbsentGates(report).join(", ")} had no input.`,
    );
    console.error(
      `[loombridge verify] missing evidence: ${outcome.missingEvidence.join(", ")} under ` +
        `${path.relative(args.root, inputsDir)}/: produce them (\`loombridge capture --root ${args.root} --slice ${sliceId}\`), then re-verify.`,
    );
  } else if (code !== 0) {
    const why =
      report.status === "fail"
        ? "gate failures"
        : "warnings over graded evidence (slice verify is strict by default: a warn does not advance the slice)";
    console.error(`[loombridge verify] slice ${sliceId} NOT green — ${why}.`);
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
    console.error(`[loombridge verify] slice ${sliceId}: diagnostic run; slice state NOT flipped.`);
  } else if (flip.ok) {
    await writeSlicePlan(paths, flip.plan);
    const checkpointId = await snapshotSliceFixture(paths, sliceId);
    console.error(`[loombridge verify] slice ${sliceId} verified; checkpoint=.loombridge-fixtures/${checkpointId}/`);
  } else {
    console.error(
      `[loombridge verify] slice ${sliceId}: verdict written, slice state NOT flipped (${flip.reasons.join("; ")}).`,
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

/**
 * The POSITIVE allowlist that routes an invocation to the unified orchestrator (A9).
 *
 * It is an allowlist, not a "no mode flag present" test, and that direction is the whole
 * point: a NEGATIVE rule silently adopts every flag added later, so the next flag someone
 * adds to `parseArgs` would join the orchestrator by omission and inherit a code path
 * nobody wrote it for. With this set, a new flag routes to the legacy engine (today's
 * behavior) until an author puts it here on purpose.
 *
 * `__tests__/unit/capabilities/verification/unified-verify-flags.test.ts` walks every flag
 * `parseArgs` accepts and fails if one is classified in neither direction.
 */
export const ORCHESTRATOR_FLAGS: ReadonlySet<string> = new Set([
  "--root",
  "--strict",
  "--live",
  "--report",
  "--only",
  "--id",
  "--workspace",
]);

/** The subset of {@link ORCHESTRATOR_FLAGS} that consumes the following argv token. */
export const ORCHESTRATOR_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--root",
  "--report",
  "--only",
  "--id",
  "--workspace",
]);

/** The orchestrator-only flags: `parseArgs` (the legacy engine) does not know them. */
const ORCHESTRATOR_ONLY_FLAGS: ReadonlySet<string> = new Set(["--live", "--report", "--only"]);

interface OrchestratorArgs {
  root: string;
  strict: boolean;
  live: boolean;
  reportPath?: string;
  /**
   * `--only <sections>` RAW. The router deliberately does not validate the value: the
   * selector's refusal belongs at the orchestrator's pre-write position (F13), next to
   * `--report`'s, and a router that rejected a typo here would report it as "not
   * orchestrator territory" and fall through to the legacy unknown-flag path instead.
   */
  only?: string;
  workspaceId?: string;
  workspace?: string;
}

/**
 * Classify an argv as orchestrator territory, or not. Returns null when ANY token falls
 * outside the allowlist, in which case the caller must fall through to the legacy paths
 * unchanged (including their unknown-flag exit 2).
 *
 * A value-flag whose value is missing or flag-like also returns null: that is a malformed
 * invocation, and `parseArgs` already owns exactly how those are reported.
 *
 * Exported so `unified-verify-flags.test.ts` can drive the REAL router with one argv per
 * accepted flag. A guard that only compared two sets would keep passing if someone
 * hijacked this function with an inline set of its own.
 */
export function classifyOrchestratorArgs(args: string[]): OrchestratorArgs | null {
  const parsed: OrchestratorArgs = { root: process.cwd(), strict: false, live: false };
  let rawReport: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!ORCHESTRATOR_FLAGS.has(arg)) return null;
    if (!ORCHESTRATOR_VALUE_FLAGS.has(arg)) {
      if (arg === "--strict") parsed.strict = true;
      else if (arg === "--live") parsed.live = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return null;
    i += 1;
    if (arg === "--root") parsed.root = path.resolve(value);
    else if (arg === "--report") rawReport = value;
    else if (arg === "--only") parsed.only = value;
    else if (arg === "--id") parsed.workspaceId = value;
    else parsed.workspace = path.resolve(value);
  }
  // `--report` resolves against `--root`, NOT the cwd (L12), and it is resolved after
  // the loop so flag order cannot change where it lands. A report path is a statement
  // about the project being verified; resolving it against wherever the operator
  // happened to `cd` puts the run's own record somewhere the project cannot find it,
  // and in CI that "somewhere" is a scratch dir that gets thrown away.
  if (rawReport !== undefined) parsed.reportPath = path.resolve(parsed.root, rawReport);
  return parsed;
}

/**
 * Was `--only` passed with no usable value? (F13)
 *
 * `classifyOrchestratorArgs` returns null for a value-flag whose value is missing or
 * flag-like, which is right for routing but would report a malformed selector as "this argv
 * belongs to a mode". This predicate lets `run` say what actually happened.
 */
function onlyValueMissing(args: readonly string[]): boolean {
  const at = args.lastIndexOf("--only");
  if (at === -1) return false;
  const value = args[at + 1];
  return value === undefined || value.startsWith("--");
}

/**
 * The S2b deprecation notices for the two mode flags the unified door replaced.
 *
 * STDERR ONLY, and behavior-free: `--snapshot` and `--minigame` keep byte-identical
 * behavior, and the notice exists to route the next invocation, not to change this one.
 * stdout stays byte-identical with and without it, because a machine reading a mode's
 * output must not have to learn a new line. `--profile` gets NO notice: it is a permanent
 * diagnostic, already documented as never gating, not an alias of anything.
 *
 * SUPPRESSED UNDER `--quiet-next` (F10): that flag is the guided flow's existing marker for
 * "a wrapper owns the next-step line", so the guided mini-game run, which passes it, does
 * not tell a human to stop using the flow they are standing in the middle of.
 */
function deprecationNotice(mode: "snapshot" | "minigame"): string[] {
  const [flag, section, what] = mode === "snapshot"
    ? ["--snapshot", "feel", "the approved feel snapshot"]
    : ["--minigame", "screens", "the screen contract + its approved layout baseline"];
  // EVERY line carries the `NOTICE:` marker, so a consumer (and the parity test) can strip
  // the notice by a rule rather than by counting lines or matching its prose.
  return [
    `[loombridge verify] NOTICE: ${flag} is a DEPRECATED ALIAS. Behavior here is unchanged, but the front`,
    `[loombridge verify] NOTICE: door is now bare \`loombridge verify\` (or \`loombridge verify --only ${section}\`), which`,
    `[loombridge verify] NOTICE: grades ${what} as one section of one report. The alias will be removed in a future major.`,
  ];
}

/** A `--help`/parse outcome. `usageError` exits 2; a bare `help` exits 0. */
type ParseHelp = { help: true; usageError?: boolean };


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
  let enforceTaste = false;
  let snapshot = false;

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
    else if (arg === "--enforce-taste") enforceTaste = true;
    else if (arg === "--snapshot") snapshot = true;
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
        console.error(`[loombridge verify] invalid --stage "${value}". Known: ${VERIFY_STAGES.join(", ")}.`);
        return { help: true };
      }
      stage = value as VerifyStage;
    } else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      // An unknown argument is a malformed invocation, not a help request — exit 2.
      // This also catches a value-flag that swallowed the next flag as its value
      // (e.g. `--measurements --root x` leaves `x` as an unknown positional).
      console.error(`[loombridge verify] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // `--slice` and `--stage` are independent axes (slice = data-driven gate
  // selection from acceptance.gates; stage = the hardcoded phase enum). Refuse
  // both at once rather than silently picking one.
  if (slice !== undefined && stage !== undefined) {
    console.error(
      "[loombridge verify] --slice and --stage are independent axes; pass only one.",
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
  if (snapshot && profile !== undefined) {
    console.error("[loombridge verify] pass either --profile or --snapshot, not both (they grade against different baselines).");
    return { help: true, usageError: true };
  }

  if (profile !== undefined) {
    const offenders: string[] = [];
    if (slice !== undefined) offenders.push("--slice");
    if (stage !== undefined) offenders.push("--stage");
    if (inputsDir !== undefined) offenders.push("--inputs");
    if (acceptancePath !== undefined) offenders.push("--acceptance");
    if (vlmPath !== undefined) offenders.push("--vlm");
    if (offenders.length > 0) {
      console.error(
        `[loombridge verify] --profile mode ignores contract flags; remove: ${offenders.join(", ")}. ` +
          "Allowed: --root, --profile, --id, --workspace, --measurements, --layout, --setup-capture, setup/capture drive flags, --enforce-taste, --strict, --output.",
      );
      return { help: true, usageError: true };
    }
    if (feelWorkspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(feelWorkspaceId)) {
      console.error("[loombridge verify] --id must be lowercase kebab-case (letters, digits, hyphens; start with a letter).");
      return { help: true, usageError: true };
    }
    // Resolve the external feel workspace the same way the mini-game flow resolves
    // its workspace (shared `workspace-paths.ts`): explicit `--workspace`, else
    // `~/.loombridge/projects/<id>` from `--id` or the sanitized project basename.
    // Refuse an underivable id (rather than silently inventing one) and a workspace
    // inside the project (artifacts must never pollute the game repo).
    if (feelWorkspace !== undefined) {
      resolvedFeelWorkspace = feelWorkspace;
    } else {
      const feelId = feelWorkspaceId ?? sanitizeWorkspaceId(path.basename(root));
      if (!feelId) {
        console.error(
          `[loombridge verify] could not derive a workspace id from '${path.basename(root)}'; pass --id <kebab>.`,
        );
        return { help: true, usageError: true };
      }
      resolvedFeelWorkspace = projectWorkspace(feelId);
    }
    const projectAbs = path.resolve(root);
    if (isInside(resolvedFeelWorkspace, projectAbs)) {
      console.error(
        `[loombridge verify] feel workspace ${resolvedFeelWorkspace} is inside the project ${projectAbs} — ` +
          "pass --workspace <dir> outside it (the default is ~/.loombridge/projects/<id>).",
      );
      return { help: true, usageError: true };
    }
    if (setupCapture && !setupPlayerPath) {
      console.error("[loombridge verify] --setup-capture requires --player <locator-path>.");
      return { help: true, usageError: true };
    }
    if (setupApply && !setupCapture) {
      console.error("[loombridge verify] --apply is only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupActivatePaths.length > 0 || setupNoAutoActivate) && !setupCapture) {
      console.error("[loombridge verify] --activate/--no-auto-activate are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if (
      (setupDiscover
        || setupAnimatorControllerPath !== undefined
        || setupAnimatorBool !== undefined
        || setupAnimatorHost !== undefined)
      && !setupCapture
    ) {
      console.error("[loombridge verify] --discover/--animator-* are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupCoyoteProbePath !== undefined || setupJumpBufferProbePath !== undefined) && !setupCapture) {
      console.error("[loombridge verify] --coyote-probe/--jump-buffer-probe are only valid with --setup-capture.");
      return { help: true, usageError: true };
    }
    if ((setupAnimatorControllerPath !== undefined || setupAnimatorBool !== undefined || setupAnimatorHost !== undefined) && !setupDiscover) {
      console.error("[loombridge verify] --animator-controller/--animator-bool/--animator-host require --discover.");
      return { help: true, usageError: true };
    }
    if (captureContractPath !== undefined && setupCapture) {
      console.error("[loombridge verify] pass either --setup-capture or --capture-contract, not both.");
      return { help: true, usageError: true };
    }
    if (captureContractPath !== undefined && measurementsPath !== undefined) {
      console.error("[loombridge verify] pass either --capture-contract or --measurements, not both.");
      return { help: true, usageError: true };
    }
    if (measurementsOutputPath !== undefined && captureContractPath === undefined) {
      console.error("[loombridge verify] --measurements-output requires --capture-contract.");
      return { help: true, usageError: true };
    }
    if (captureArtifactsDir !== undefined && captureContractPath === undefined) {
      console.error("[loombridge verify] --capture-artifacts requires --capture-contract.");
      return { help: true, usageError: true };
    }
    if (captureOnly && captureContractPath === undefined) {
      console.error("[loombridge verify] --capture-only requires --capture-contract.");
      return { help: true, usageError: true };
    }
  } else if (snapshot) {
    // `--snapshot` is the standalone tuning-drift mode: it grades the current
    // measured behavior against the approved feel snapshot, not the acceptance
    // contract, a profile, or the mini-game pack. Refuse the other modes' flags
    // rather than silently ignoring them.
    const offenders: string[] = [];
    if (slice !== undefined) offenders.push("--slice");
    if (stage !== undefined) offenders.push("--stage");
    if (inputsDir !== undefined) offenders.push("--inputs");
    if (acceptancePath !== undefined) offenders.push("--acceptance");
    if (vlmPath !== undefined) offenders.push("--vlm");
    if (layoutPath !== undefined) offenders.push("--layout");
    if (enforceTaste) offenders.push("--enforce-taste");
    if (
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
      measurementsOutputPath !== undefined ||
      captureArtifactsDir !== undefined ||
      captureOnly
    ) {
      offenders.push("profile setup/capture flags");
    }
    if (offenders.length > 0) {
      console.error(
        `[loombridge verify] --snapshot mode ignores other modes' flags; remove: ${offenders.join(", ")}. ` +
          "Allowed: --root, --id, --workspace, --capture-contract, --measurements, --project, --source-root, --strict, --output.",
      );
      return { help: true, usageError: true };
    }
    if (captureContractPath !== undefined && measurementsPath !== undefined) {
      console.error("[loombridge verify] pass either --capture-contract or --measurements, not both.");
      return { help: true, usageError: true };
    }
    if (feelWorkspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(feelWorkspaceId)) {
      console.error("[loombridge verify] --id must be lowercase kebab-case (letters, digits, hyphens; start with a letter).");
      return { help: true, usageError: true };
    }
    if (feelWorkspace !== undefined) {
      resolvedFeelWorkspace = feelWorkspace;
    } else {
      const feelId = feelWorkspaceId ?? sanitizeWorkspaceId(path.basename(root));
      if (!feelId) {
        console.error(
          `[loombridge verify] could not derive a workspace id from '${path.basename(root)}'; pass --id <kebab>.`,
        );
        return { help: true, usageError: true };
      }
      resolvedFeelWorkspace = projectWorkspace(feelId);
    }
    if (isInside(resolvedFeelWorkspace, path.resolve(root))) {
      console.error(
        `[loombridge verify] feel workspace ${resolvedFeelWorkspace} is inside the project ${path.resolve(root)}: ` +
          "pass --workspace <dir> outside it (the default is ~/.loombridge/projects/<id>).",
      );
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
    feelWorkspace !== undefined ||
    enforceTaste
  ) {
    console.error("[loombridge verify] profile capture/setup flags require --profile.");
    return { help: true, usageError: true };
  } else if (layoutPath !== undefined) {
    // `--layout` (F4) is only meaningful in `--profile` mode — it re-checks a level
    // against the SELECTED profile's swapped envelope. Refuse it elsewhere rather
    // than silently ignoring it.
    console.error("[loombridge verify] --layout requires --profile.");
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
    if (snapshot) offenders.push("--snapshot");
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
        `[loombridge verify] --minigame mode ignores contract/profile flags; remove: ${offenders.join(", ")}. ` +
          "Allowed: --root, --contract, --captures, --strict, --output, --verbose, --quiet-next.",
      );
      return { help: true, usageError: true };
    }
    if (contractPath === undefined || capturesDir === undefined) {
      const missing = [
        contractPath === undefined ? "--contract <path>" : null,
        capturesDir === undefined ? "--captures <dir>" : null,
      ].filter(Boolean);
      console.error(`[loombridge verify] --minigame requires ${missing.join(" and ")}.`);
      return { help: true, usageError: true };
    }
  } else if (contractPath !== undefined || capturesDir !== undefined) {
    // `--contract`/`--captures` are only meaningful in `--minigame` mode.
    console.error("[loombridge verify] --contract/--captures require --minigame.");
    return { help: true, usageError: true };
  }

  // Default every path to the `.loombridge/` convention under root. A diagnostic
  // stage defaults its output to `verify-<stage>.json` so it never clobbers the
  // certifiable build-verdict.json. (A `--slice` run ignores `outputPath` — it
  // writes the per-slice verdict path computed in runVerifySlice.)
  const paths = loombridgePaths(root);
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
    enforceTaste,
    snapshot,
  };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge verify [options]",
      "",
      "BARE `verify` (no mode flags) is the unified front door: it DISCOVERS the",
      "project's verification assets (acceptance contract, approved trace baselines,",
      "feel snapshot, screen contract), PRINTS THE PLAN FIRST (one row per asset, with",
      "when and by what it was approved), then runs them into one report at",
      ".loombridge/reports/verify.json. Nothing is written before the plan prints.",
      "Offline assets run by default; assets that need a running editor are listed as",
      "'needs --live' and never folded into a pass. A project with no assets prints the",
      "record/replay/approve on-ramp and exits 2.",
      "It also grades a stamped Unity EditMode run from .loombridge/tests/ when",
      "`loombridge tests run` produced one: offline, never launching an editor, and never",
      "as a full pass (a suite has no human approval, so it is permanently unanchored).",
      "",
      "SLICE-PLANNED PROJECTS: when .loombridge/SLICES.json exists, the acceptance contract is",
      "graded PER SLICE and this door grades the ROLL-UP (the `slices` section): it re-runs each",
      "APPROVED slice's own gate list over that slice's evidence dir, refuses on any divergence",
      "from the stored verdict, re-hashes every evidence file against the shas the verdict",
      "recorded (a changed file is the stale-approval refusal, naming file and slice), and",
      "refuses when a contract section declaring required content is walked by no gate in the",
      "plan. A verdict minted without evidence shas is refused: re-verify that slice. All of it",
      "is offline; a refused roll-up is exit 2 (harness tier), never a game verdict.",
      "",
      "  loombridge verify                     # offline assets, plan first",
      "  loombridge verify --live              # also replay traces + grade feel drift",
      "  loombridge verify --only screens      # one section, for CI granularity",
      "",
      "Seven flags stay on the unified run and combine only with each other: --root,",
      "--strict, --live, --report, --only, --id, --workspace. EVERY OTHER flag below is a",
      "mode or engine flag, and passing any one of them selects that legacy mode instead,",
      "unchanged (--inputs, --acceptance, --output, --vlm, --slice, --stage, --profile,",
      "--snapshot, --minigame and their companions).",
      "",
      "DEPRECATED ALIASES: --snapshot and --minigame keep byte-identical behavior and now",
      "print a short stderr notice pointing at the unified door (--only feel and",
      "--only screens). They will be removed in a future major. --profile is NOT",
      "deprecated: it is a permanent DIAGNOSTIC and never gates.",
      "",
      "Bare-run options (combinable only with each other):",
      "  --live                Also run the assets that need a running Unity editor",
      "                        (trace replay with pixel-drift gating, feel snapshot).",
      "  --report <path>       Unified report path, resolved relative to --root (default:",
      "                        .loombridge/reports/verify.json, or",
      "                        .loombridge/reports/verify-scoped.json under --only). Refused",
      "                        when it would overwrite a project artifact or any file that is",
      "                        not a previous unified report.",
      `  --only <sections>     Comma-separated subset of ${UNIFIED_SECTION_NAMES.join("|")}.`,
      "                        A SCOPED run: healthy assets outside the selection are listed",
      "                        as 'deselected' and excluded from the verdict, but a BROKEN or",
      "                        unapproved asset still refuses (tier 2) whatever you selected:",
      "                        tampering is never scoped away. A scoped run's status is never",
      "                        `pass` (its ceiling is `partial`), it writes",
      "                        .loombridge/reports/verify-scoped.json instead of the full",
      "                        report, and `doneness` never certifies from it. Unknown or",
      "                        empty selections refuse (exit 2) before anything is written;",
      "                        a KNOWN section that matches no discovered asset is",
      "                        nothing-checked (exit 2), naming the kinds that were found.",
      "                        CI NOTE: `--only tests` NEVER exits 0. A red suite exits 1 and",
      "                        a green one exits 2, because the tests section is permanently",
      "                        unanchored (no human approves a suite), and a run that compared",
      "                        nothing human-approved cannot exit 0. For a tests-only CI step",
      "                        use `loombridge tests grade --results <xml>`, or include an",
      "                        anchored section (e.g. --only screens,tests) in the selection.",
      "",
      "Options:",
      "  --root <dir>          Project root (default: cwd)",
      "  --inputs <dir>        Captured op-output dir (default: .loombridge/verify)",
      "  --acceptance <path>   Contract (default: .loombridge/ACCEPTANCE.json)",
      "  --output <path>       Verdict (default: .loombridge/reports/build-verdict.json)",
      "                        In --profile mode, overrides the profile report path",
      "                        (or setup capture contract path with --setup-capture).",
      "  --vlm <path>          Advisory VLM findings (optional)",
      "  --strict              Treat warnings as failures (require all-green). On a bare",
      "                        run, applies to the unified run (see above) and is mirrored",
      "                        into every section that has an all-green mode. NO-OP for",
      "                        --slice: slice verify is strict by DEFAULT (a warn never",
      "                        exits 0). The flag is accepted for compatibility.",
      "  --verbose             (--minigame) Print the full per-finding breakdown in the",
      "                        terminal (default: slim — the detail lives in the report)",
      "  --quiet-next          (--minigame) Suppress the resolved next-step footer (the",
      "                        run/check wrapper owns that line; rarely needed by hand). It",
      "                        ALSO suppresses the deprecated-alias notice, for both",
      "                        --snapshot and --minigame.",
      "  --stage <name>        Phase-scoped DIAGNOSTIC run — grade only a stage's gates",
      "                        (construct | level | polish | verify). Restricted stages",
      "                        write verify-<stage>.json and do NOT certify (§3a); only",
      "                        the full run (`verify` / omitted) writes build-verdict.json.",
      "  --slice <id>          Slice-scoped run — grade ONLY the slice's acceptance.gates",
      "                        (from .loombridge/SLICES.json) and write the per-slice verdict",
      "                        to .loombridge/reports/slices/<id>.verdict.json. Defaults",
      "                        --inputs to .loombridge/verify/<id>/. Does NOT touch the",
      "                        whole-game build-verdict.json or STATE; a fresh pass",
      "                        flips the slice built -> verified. Mutually exclusive",
      "                        with --stage (they are independent axes).",
      "                        Slice exit codes are their own three-way contract: 0 pass",
      "                        (the verdict records `approvable: true`), 1 a game defect",
      "                        (fail, or a warn over evidence that WAS graded), 2 a",
      "                        harness/capture gap (the only failing checks are gates",
      "                        whose input file was absent, so nothing was graded).",
      "  --profile <id>        VERIFY-FIRST mode (S5b): grade an existing 2D platformer",
      "                        against a feel profile (precision | classic | momentum).",
      "                        Runs standalone — no ACCEPTANCE.json/SLICES.json, no project",
      "                        mutation — and writes <workspace>/feel/reports/feel-profile.{json,html,md}.",
      "                        Mutually exclusive with --slice/--stage.",
      "  --id <kebab>          Profile mode workspace id (default: sanitized basename of --root;",
      "                        refused if the basename can't derive one — pass --id explicitly).",
      "                        Resolves to ~/.loombridge/projects/<id> unless --workspace is set.",
      "  --workspace <dir>     Profile mode feel workspace (default: ~/.loombridge/projects/<id>;",
      "                        must be OUTSIDE the project — artifacts never pollute the game repo).",
      "  --measurements <path> Measured feel values for --profile mode (optional; absent",
      "                        metrics report as 'not measured', never green).",
      "  --enforce-taste       Profile mode: gate TASTE metrics (archetype tuning targets",
      "                        like runSpeed/jumpApex) as failures. Default: taste out-of-band",
      "                        is descriptive placement; grammar metrics (coyote time, jump",
      "                        buffer, gravity asymmetry, jump-cut) always gate.",
      "  --snapshot            TUNING-DRIFT mode: grade the current measured behavior against",
      "                        the approved feel snapshot (`loombridge feel snapshot`). Default:",
      "                        live-capture with the snapshot's own frozen contract (binding",
      "                        verified). --capture-contract overrides (hash-checked; mismatch",
      "                        refuses, exit 2). --measurements grades offline (binding",
      "                        unverified; exit 1 under --strict). Exit: 0 clean, 1 drift or a",
      "                        rejected value, 2 integrity/binding/capture gap.",
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
      "  --source-root <dir>  Optional Loombridge source checkout for stale-runtime guard.",
      "  --layout <path>       Level layout JSON for --profile mode (F4): platforms/",
      "                        launchers/collectibles. Re-checks the level against the",
      "                        profile's swapped jump envelope — an unreachable collectible",
      "                        FAILs. Absent → reachability is stamped 'not_run'.",
      "  --minigame            MINI-GAME mode (S6c-3): grade a 2D kids mini-game contract",
      "                        against a per-state uGUI capture pack with the deterministic",
      "                        gate engine. Standalone — no ACCEPTANCE.json/SLICES.json, no",
      "                        project mutation. Guided mini-game flows write",
      "                        ~/.loombridge/projects/<id>/reports/minigame-verification.json",
      "                        by passing --output; omitted --output uses the legacy root report path.",
      "                        Requires --contract and --captures. Mutually exclusive with",
      "                        --profile/--slice/--stage.",
      "  --contract <path>     Mini-game contract JSON (--minigame mode).",
      "  --captures <dir>      Per-state capture dir: <state>.ui-rects.json / .console.json /",
      "                        .png (--minigame mode).",
      "  -h, --help            Show this help",
      "",
      "Exit (bare run): 0 pass, or a partial whose ONLY unmeasured assets were skipped",
      "      for lack of --live; 1 a game defect (gate fail, drift, baseline regression);",
      "      2 a harness fault, a broken asset, or nothing graded. A 2 is never a game",
      "      verdict, and a run that checked nothing is never a pass.",
      "Exit: 1 on Tier-1 fail (or warn under --strict), else 0.",
      "      A contract run that graded NOTHING (no gate consumed a capture) exits 2.",
      "      In --profile mode: 1 on fail (or 'incomplete' under --strict), else 0.",
      "      In --profile --capture-contract mode: incomplete capture evidence exits 2.",
      "      In --minigame mode: 0 pass, 1 fail, 2 incomplete (nothing graded).",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  // THE UNIFIED FRONT DOOR (RFC UnifiedVerify, S1). An argv made of nothing but the
  // allowlisted flags is the bare `verify` question ("does this build still do what a
  // human approved?"), answered by the orchestrator: discover the assets, print the plan,
  // then delegate to the engines below. Everything else routes to the legacy paths
  // EXACTLY as before, so `--minigame`/`--snapshot`/`--profile`/`--slice`/`--stage`/
  // `--inputs` and the unknown-flag exit 2 are untouched.
  //
  // Deliberate S1 divergence: the MCP `loombridge_verify` tool still calls `runVerify`
  // directly (contract mode) and does NOT come through here. Routing it is an S2 item;
  // what makes the divergence safe today is that the checked-nothing refusal lives in the
  // ENGINE (`runVerify`), so the tool cannot report a vacuous green either way.
  const orchestrated = classifyOrchestratorArgs(args);
  if (orchestrated) {
    // The same two guards every workspace-aware mode applies, for the same two reasons:
    // an unusable id must be refused rather than silently sanitized into someone else's
    // workspace, and a workspace INSIDE the project would write verification artifacts
    // into the game repo.
    if (orchestrated.workspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(orchestrated.workspaceId)) {
      console.error("[loombridge verify] --id must be lowercase kebab-case (letters, digits, hyphens; start with a letter).");
      return 2;
    }
    if (orchestrated.workspace !== undefined && isInside(orchestrated.workspace, path.resolve(orchestrated.root))) {
      console.error(
        `[loombridge verify] workspace ${orchestrated.workspace} is inside the project ${path.resolve(orchestrated.root)}: ` +
          "pass --workspace <dir> outside it (the default is ~/.loombridge/projects/<id>).",
      );
      return 2;
    }
    const { runUnifiedVerify } = await import("./unified/orchestrator.js");
    try {
      return await runUnifiedVerify(orchestrated);
    } catch (error) {
      // A throw out of the orchestrator itself is a harness fault, never a game verdict.
      console.error(`[loombridge verify] fatal: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const orchestratorOnly = args.filter((a) => ORCHESTRATOR_ONLY_FLAGS.has(a));
  if (orchestratorOnly.length > 0) {
    // The more specific fault first: a value-less `--only` is a malformed selector, not a
    // mode combination, and reporting it as one sends the operator looking for a mode flag
    // they never passed. Refused here, before `parseArgs` and before any write.
    if (onlyValueMissing(args)) {
      console.error(
        `[loombridge verify] REFUSED: --only requires a comma-separated value. Known sections: ${UNIFIED_SECTION_NAMES.join(", ")}.`,
      );
      console.error("[loombridge verify] nothing was written and nothing ran.");
      return 2;
    }
    console.error(
      `[loombridge verify] ${orchestratorOnly.join(" and ")} ${orchestratorOnly.length > 1 ? "belong" : "belongs"} to the bare unified run; ` +
        `they cannot be combined with mode/engine flags. Allowed alongside them: ${[...ORCHESTRATOR_FLAGS].join(", ")}.`,
    );
    return 2;
  }
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  // S2b: the deprecation notices, printed once the invocation is known to be well-formed
  // (a usage error is not the moment to advertise the replacement) and BEFORE the mode runs,
  // so the notice cannot be mistaken for part of the verdict.
  if (!parsed.quietNext) {
    for (const line of parsed.snapshot ? deprecationNotice("snapshot") : []) console.error(line);
    for (const line of parsed.minigame ? deprecationNotice("minigame") : []) console.error(line);
  }
  // Mini-game verify-first mode (S6c-3) branches BEFORE runVerify so the
  // unconditional ACCEPTANCE.json read never happens — this mode is standalone
  // and grades a MinigameContract against a uGUI capture pack.
  if (parsed.minigame) {
    const { runVerifyMinigame } = await import("../minigame/verify-minigame.js");
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
      console.error(`[loombridge verify] fatal: ${message}`);
      return 1;
    }
  }
  // Tuning-drift snapshot mode branches BEFORE runVerify for the same reason:
  // it is standalone and grades against the approved feel snapshot, never the
  // acceptance contract. Fatal exceptions are harness-tier (2), never a pass.
  if (parsed.snapshot) {
    const { runVerifySnapshot } = await import("../feel/snapshot-verify.js");
    try {
      return await runVerifySnapshot({
        root: parsed.root,
        workspace: parsed.feelWorkspace!,
        captureContractPath: parsed.captureContractPath,
        measurementsPath: parsed.measurementsPath,
        project: parsed.project,
        sourceRoot: parsed.sourceRoot,
        strict: parsed.strict,
        outputPath: parsed.outputExplicit ? parsed.outputPath : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loombridge verify] fatal: ${message}`);
      return 2;
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
      const { proposeFeelCaptureContract, writeFeelCaptureContract } = await import("../feel/setup.js");
      const { summarizeFeelCaptureProposal } = await import("../feel/prompts.js");
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
        const { runFeelDiscovery } = await import("../feel/discover-live.js");
        const { resolveDiscoveredRoles } = await import("../feel/discover.js");
        const { unityConnectionHint } = await import("../../shared/cli-ui.js");
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
          for (const note of resolved.notes) console.error(`[loombridge verify] discover: ${note}`);
          jumpButtonPath = resolved.jumpButtonPath;
          joystickPath = resolved.joystickPath;
          animatorBoolSignal = resolved.animatorBoolSignal;
        } catch (error) {
          const hint = unityConnectionHint(error);
          if (hint) hint.forEach((line) => console.error(line));
          else console.error(`[loombridge verify] discover failed: ${error instanceof Error ? error.message : String(error)}`);
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
        for (const line of summarizeFeelCaptureProposal(contract)) console.error(`[loombridge verify] ${line}`);
        console.error(`[loombridge verify] capture contract target=${path.relative(parsed.root, output)}`);
        if (!parsed.setupApply) {
          console.error(`[loombridge verify] dry-run only. Review the proposal, then re-run with --apply to write it.`);
          return 0;
        }
        await writeFeelCaptureContract(contract, output, { force: parsed.setupForce });
        console.error(`[loombridge verify] wrote capture contract=${path.relative(parsed.root, output)}`);
        console.error(`[loombridge verify] next: run capture to produce --measurements.`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loombridge verify] setup-capture failed: ${message}`);
        return 2;
      }
    }
    // F4: load the optional level layout (pure JSON; profile grading consumes it
    // whether measurements came from a file or from a live capture run).
    let layout: import("./gates/reachability.js").ReachabilityLayout | undefined;
    if (parsed.layoutPath !== undefined) {
      try {
        const raw = await fs.readFile(parsed.layoutPath, "utf-8");
        layout = JSON.parse(raw) as import("./gates/reachability.js").ReachabilityLayout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loombridge verify] could not read --layout ${parsed.layoutPath}: ${message}`);
        return 2;
      }
    }
    if (parsed.captureContractPath) {
      const { runFeelCaptureLive } = await import("../feel/live.js");
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
        for (const warning of result.warnings) console.error(`[loombridge verify] warning: ${warning}`);
        console.error(`[loombridge verify] measurements=${path.relative(parsed.root, result.outputPath)}`);
        if (result.artifactsDir) {
          console.error(`[loombridge verify] capture-artifacts=${path.relative(parsed.root, result.artifactsDir)}`);
        }
        if (parsed.captureOnly) {
          console.error(`[loombridge verify] next: run loombridge verify --profile ${parsed.profile} --measurements ${path.relative(parsed.root, result.outputPath)}`);
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
          enforceTaste: parsed.enforceTaste,
        });
        return await exitCodeForLiveProfileCapture({ reportPath, verifierCode });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[loombridge verify] capture failed: ${message}`);
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
        enforceTaste: parsed.enforceTaste,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loombridge verify] fatal: ${message}`);
      return 1;
    }
  }
  try {
    return await runVerify(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge verify] fatal: ${message}`);
    return 1;
  }
}
