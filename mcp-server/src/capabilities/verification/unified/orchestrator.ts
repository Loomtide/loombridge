/**
 * The unified `verify` ORCHESTRATOR: the bare front door (RFC
 * `Docs/Design/UnifiedVerify.md`, S1).
 *
 * `loombridge verify` with nothing but `--root`/`--strict`/`--live`/`--report`/`--id`/
 * `--workspace` lands here. It answers the only question a user actually has, "does this
 * build still do what a human approved?", by discovering the project's verification
 * assets and delegating each to the engine that already owns it. It implements NO gate
 * of its own: every verdict below comes from `runVerify`, `runVerifyMinigame`,
 * `replayTraceForVerify`, or `runVerifySnapshot`, unchanged.
 *
 * Four rules carry the weight:
 *
 * 1. **The plan prints FIRST.** Discovery is pure IO fact-gathering, and nothing is
 *    written to the project until the operator has seen the list of what will run and
 *    what will not. A plan printed after the run is a receipt, not a plan.
 * 2. **A row that did not execute never folds into pass.** Broken, non-anchor, draft,
 *    and live-only-skipped rows all land in `notRun`, and `resolveUnifiedOutcome` is the
 *    single place that decides what that costs. Only the operator's own `--live`
 *    omission may still exit 0.
 * 3. **Offline by default, `--live` opt-in** (D2). The dominant runtime of this door is
 *    CI, and live-by-default would make the least specific command the one most likely
 *    to hit the post-reload stall family.
 * 4. **A section that throws is a HARNESS FAULT for that section, not a fatal run.** The
 *    other sections still execute, because "the feel capture could not connect" tells an
 *    operator nothing about whether the screens regressed.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  fileExists,
  loombridgePaths,
  nowIso,
  readState,
  standardReplayLayout,
  writeState,
  type LoombridgeState,
  type ReplayLayout,
} from "../../../domain/state.js";
import { phaseForStatus } from "../verify.js";
import { isInside, projectWorkspace, sanitizeWorkspaceId } from "../../../domain/workspace-paths.js";
import {
  DEFAULT_DRIFT_FRACTION,
  anchorTermsSentence,
  driftPercentText,
  driftRegressionLine,
  driftSuggestionLines,
  maskSuggestionLines,
  type DriftFacts,
  type MaskSuggestion,
} from "../../replay/visual-diff.js";
import { resolveCliProjectPin } from "../../setup/cli-project-pin.js";
import {
  exitCodeIsUnexplained,
  gradeTestResults,
  isNUnitParseError,
  parseNUnitResults,
  summaryDisagreements,
  deriveSummary,
} from "../../tests/nunit-parse.js";
import {
  TEST_RESULTS_FILE,
  TEST_RESULTS_MANIFEST,
  sha256,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
  verifyTestResults,
} from "../../tests/test-results-manifest.js";
import { gradedGates } from "../run-gates.js";
import {
  discoverVerificationAssets,
  type AbsentAssetFamily,
  type DiscoveredAsset,
} from "./discovery.js";
import {
  SCOPED_SUMMARY,
  SECTION_FOR_KIND,
  ZERO_ANCHORED_SUMMARY,
  fingerprintReport,
  notRunFor,
  parseOnlySelection,
  reportPathFor,
  reportWasWritten,
  resolveUnifiedOutcome,
  unifiedScopedReportPath,
  unifiedScreensReportPath,
  unifiedVerifyReportPath,
  worstExitTier,
  writeUnifiedVerifyReport,
  type ReportFingerprint,
  type UnifiedAssetOutcome,
  type UnifiedDeselected,
  type UnifiedNotRun,
  type UnifiedSectionName,
  type UnifiedVerifyReport,
  type UnifiedVerifySection,
} from "./report.js";

const TAG = "[loombridge verify]";

/**
 * The four section engines, injectable.
 *
 * This is a TEST SEAM, and a deliberately narrow one: the defaults below are the real
 * engines, and the orchestrator never branches on whether a dep was injected. It exists
 * because the `flow` and `feel` sections need a running Unity editor, so the only other
 * way to cover "a per-trace throw becomes that trace's harness fault while the rest of
 * the run continues" would be to leave it uncovered.
 */
export interface UnifiedSectionDeps {
  runContract(args: {
    root: string;
    inputsDir: string;
    acceptancePath: string;
    outputPath: string;
    strict: boolean;
  }): Promise<number>;
  runScreens(args: {
    root: string;
    contractPath: string;
    capturesDir: string;
    outputPath: string;
    strict: boolean;
    quietNext: boolean;
    baselineRefOverride?: string;
  }): Promise<number>;
  /**
   * A3: the seam returns the DRIFT FACTS alongside the tier, so the section can say what
   * moved and by how much. A tier alone forced the summary to print the engine's own word
   * ("pass") next to a 1, which is the display dishonesty R3 exists to end.
   */
  runFlowTrace(
    layout: ReplayLayout,
    id: string,
    opts: { strictVisual: boolean; projectPathCanonical?: string },
  ): Promise<
    {
      status: string;
      exitTier: number;
      /**
       * Whether the re-tolerance suggestion may be printed for this trace. REQUIRED, and
       * decided by the ONE predicate (`shouldSuggestTolerance`) rather than re-derived
       * from the tier here: an optional field would default to "no suggestion", which is
       * a skip, and a second derivation is how the two doors would come to disagree about
       * whether a harness fault deserves advice to widen a gate.
       */
      suggestTolerance: boolean;
      /**
       * The absolute path of the HTML page this replay rendered for THIS run.
       *
       * REQUIRED, so the summary always has a page to name. The trace engine renders one
       * on every replay it performs and deletes any older page it does not overwrite, so
       * an optional field here could only mean "the operator gets no link", which is the
       * state this seam was fixed out of: `verify` printed the JSON, the human went looking
       * for a page, and the one on disk was a previous run's.
       */
      htmlPath: string;
      /**
       * Q3: the mask verdict for this run, derived ONCE in `applyVisualDiff` from this
       * report and the previous one on disk. Optional here and only here, because
       * "nothing drifted" genuinely has no verdict to carry; the gating of whether it may
       * be PRINTED is `suggestTolerance` above, the same predicate the trace verb uses,
       * so a harness fault can never be answered with "mask it".
       */
      maskSuggestion?: MaskSuggestion;
    } & DriftFacts
  >;
  runFeel(args: { root: string; workspace: string; strict: boolean }): Promise<number>;
}

/** The real engines. Imported lazily so the bare path costs nothing it does not use. */
async function realDeps(): Promise<UnifiedSectionDeps> {
  return {
    async runContract(args) {
      const { runVerify } = await import("../verify.js");
      return runVerify({ ...args, inputsExplicit: false, outputExplicit: false });
    },
    async runScreens(args) {
      const { runVerifyMinigame } = await import("../../minigame/verify-minigame.js");
      return runVerifyMinigame(args);
    },
    async runFlowTrace(layout, id, opts) {
      const { replayTraceForVerify, shouldSuggestTolerance } = await import("../../replay/trace.js");
      const { artifact, exitTier, drift, htmlPath, maskSuggestion } = await replayTraceForVerify(
        layout,
        id,
        opts,
      );
      // The suggestion is gated on the ARTIFACT, by the SAME predicate the trace verb
      // uses, so neither door can offer "widen the tolerance" for a harness fault.
      return {
        status: artifact.status,
        exitTier,
        htmlPath,
        ...drift,
        suggestTolerance: shouldSuggestTolerance(artifact),
        ...(maskSuggestion ? { maskSuggestion } : {}),
      };
    },
    async runFeel(args) {
      const { runVerifySnapshot } = await import("../../feel/snapshot-verify.js");
      return runVerifySnapshot(args);
    },
  };
}

export interface UnifiedVerifyOpts {
  root: string;
  /** Mirrors `--strict` into every section that has an all-green mode. */
  strict: boolean;
  /** `--live`: execute the assets that need a running editor. */
  live: boolean;
  /** `--report <path>`: override the unified report location. */
  reportPath?: string;
  /**
   * `--only <sections>`: the RAW selector value, validated here (S2a/F13).
   *
   * Raw rather than pre-parsed, because the refusal for a bad selector has to happen at the
   * same pre-discovery, pre-write position `--report` is refused at: a run that discovered
   * assets, printed a plan, and only then complained about a typo would already have told an
   * operator what "will run" for an invocation that never could.
   */
  only?: string;
  /** `--id <kebab>`: the workspace id for the out-of-project assets (feel, screens). */
  workspaceId?: string;
  /** `--workspace <dir>`: the resolved workspace, when the caller derived one. */
  workspace?: string;
  /** TEST SEAM (see `UnifiedSectionDeps`); production callers omit it. */
  deps?: Partial<UnifiedSectionDeps>;
}

/**
 * Run the unified verify. Returns the process exit code (0 pass or live-skipped
 * partial, 1 game defect or drift, 2 harness fault / broken asset / nothing graded).
 *
 * A throw out of this function is the CALLER's harness tier (2). Nothing inside it
 * throws for a section failure; sections are caught individually.
 */
export async function runUnifiedVerify(opts: UnifiedVerifyOpts): Promise<number> {
  const root = path.resolve(opts.root);
  const paths = loombridgePaths(root);
  const deps: UnifiedSectionDeps = { ...(await realDeps()), ...opts.deps };

  // `--only` IS VALIDATED FIRST (F13), before the report path is even resolved: the
  // selection decides WHICH default report this run may write, and a malformed selector
  // must leave the project byte-identical, exactly like a refused `--report`.
  let only: UnifiedSectionName[] | null = null;
  if (opts.only !== undefined) {
    const parsed = parseOnlySelection(opts.only);
    if (!parsed.ok) {
      console.error(`${TAG} REFUSED: ${parsed.error}`);
      console.error(`${TAG} nothing was written and nothing ran.`);
      return 2;
    }
    only = parsed.sections;
  }
  // F1: a SCOPED run never writes verify.json. Two files for two questions; see
  // `UNIFIED_SCOPED_REPORT`.
  const defaultReportPath = only
    ? unifiedScopedReportPath(paths.reports)
    : unifiedVerifyReportPath(paths.reports);
  const reportPath = opts.reportPath ?? defaultReportPath;

  // `--report` IS A WRITE, so it is validated before anything else happens (M4). A
  // path that collides with a project artifact would have the run silently overwrite
  // the contract, the roadmap, or a verdict it is supposed to be reading. This refuses
  // FIRST: before discovery, before the plan, before a single section runs, so a
  // refused invocation leaves the project byte-identical.
  // Containment first: the docs promise --report "resolves relative to --root", and a
  // path that escapes the root would let a verify run write outside the project it is
  // grading (observed in the S1 final test: `--report ../../escape.json` was accepted).
  // Refuse rather than clamp: a silently relocated report is a report nobody finds.
  // BOTH sides go through realpath (M-M6 family): a symlink inside the root whose real
  // location is outside it is an escape wearing a contained spelling, and comparing
  // spelled paths would wave it through. `realTarget` resolves the deepest existing
  // ancestor, so a not-yet-created report path still resolves honestly, and the root is
  // realpathed so macOS /tmp vs /private/tmp cannot produce a false mismatch.
  if (!isInside(await realTarget(reportPath), await realTarget(root))) {
    console.error(`${TAG} REFUSED: --report ${reportPath} resolves outside the project root ${root}`);
    console.error(
      `${TAG} nothing was written and nothing ran. Point --report inside the project, or omit it to use ` +
        `${path.relative(root, defaultReportPath)}.`,
    );
    return 2;
  }
  const collision = await reportCollision(paths, reportPath, only !== null);
  if (collision) {
    console.error(`${TAG} REFUSED: --report ${path.relative(root, reportPath)} ${collision}`);
    console.error(
      `${TAG} nothing was written and nothing ran. Point --report at a new path, or omit it to use ` +
        `${path.relative(root, defaultReportPath)}.`,
    );
    return 2;
  }

  // Resolve the out-of-project workspace ONCE, here, and hand the resolved directory to
  // discovery. The alternative (letting discovery derive it, then recovering it from a
  // discovered path) would mean walking `..` back up from a snapshot dir, which is the
  // one thing this repo has learned never to do: a re-nested directory silently points
  // the derivation somewhere else while every test still passes.
  const workspaceId = opts.workspaceId ?? sanitizeWorkspaceId(path.basename(root));
  const workspace = opts.workspace ?? (workspaceId ? projectWorkspace(workspaceId) : undefined);

  const { assets, absent, notes } = await discoverVerificationAssets({
    root,
    workspaceId: opts.workspaceId,
    workspace,
  });

  // THE PLAN, before any write. `discoverVerificationAssets` only reads, so at this
  // point the project on disk is byte-identical to what the operator started with.
  for (const line of planLines(root, assets, notes, opts.live, only, absent)) console.error(line);

  if (assets.length === 0) {
    // The on-ramp. Nothing is written, not even `.loombridge/`: a fresh project that
    // asked a question and got an answer must not acquire state as a side effect.
    const acceptanceAbsent = !(await fileExists(paths.acceptance));
    for (const line of onRampLines(root, { acceptanceAbsent })) console.error(line);
    return 2;
  }

  const notRun: UnifiedNotRun[] = [];
  const deselected: UnifiedDeselected[] = [];
  const sections: Partial<Record<UnifiedSectionName, UnifiedVerifySection>> = {};
  const executed: { section: UnifiedSectionName; exit: number; anchored: boolean }[] = [];

  // Every row that will NOT execute, classified BEFORE anything runs so the reason is
  // discovery's own (`notRunClass`), never inferred from how a section behaved.
  //
  // ORDER IS THE MOAT (F2). The `runnable === "no"` test comes FIRST and takes no notice of
  // the selection: a broken, unapproved or draft row lands in `notRun` and keeps its tier
  // whether or not the operator scoped its section out. Deselection may only ever remove a
  // HEALTHY row, so `--only tests` on a project with a tampered feel snapshot is still a
  // tier-2 run. Tampering is never scoped away, and the scoping cannot be used to make an
  // unmeasurable anchor disappear from the calculus.
  const runnable: DiscoveredAsset[] = [];
  for (const asset of assets) {
    if (asset.runnable === "no") notRun.push(notRunFor(asset));
    else if (only && !only.includes(SECTION_FOR_KIND[asset.kind])) {
      deselected.push({ kind: asset.kind, id: asset.id, section: SECTION_FOR_KIND[asset.kind] });
    } else if (asset.runnable === "live" && !opts.live) {
      notRun.push({ kind: asset.kind, id: asset.id, reason: "needs --live", why: "live-only-skipped" });
    } else runnable.push(asset);
  }

  const record = (name: UnifiedSectionName, section: UnifiedVerifySection): void => {
    sections[name] = section;
    // `anchored` travels with the tier into the outcome rule (G1): the two facts are decided
    // in one place, by the section that knows whether a frozen anchor was compared.
    executed.push({ section: name, exit: section.exit, anchored: section.anchored });
  };

  const contractAsset = runnable.find((a) => a.kind === "contract");
  if (contractAsset) {
    record("contract", await runSection("contract", () => contractSection(deps, opts, root, paths, contractAsset)));
  }
  const screensAsset = runnable.find((a) => a.kind === "screen-contract");
  if (screensAsset) {
    record("screens", await runSection("screens", () => screensSection(deps, opts, root, paths, screensAsset)));
  }
  const traceAssets = runnable.filter((a) => a.kind === "trace");
  if (traceAssets.length > 0) {
    // PIN THE EDITOR (F-pin). `endpoint-discovery-latest.json` is a single shared
    // pointer every running editor overwrites on its heartbeat, so an UNPINNED replay
    // drives whichever project published most recently. Observed live: identical
    // `trace replay` invocations alternating PASS/BLOCKED as two editors flapped. The
    // trace verb resolves the pin the same way; the unified door must not be the one
    // path that replays a demonstration against someone else's game.
    const projectPathCanonical = resolveCliProjectPin({ root });
    record("flow", await runSection("flow", () => flowSection(deps, root, traceAssets, projectPathCanonical)));
  }

  const testsAsset = runnable.find((a) => a.kind === "test-results");
  if (testsAsset) {
    record("tests", await runSection("tests", () => testsSection(opts, root, paths)));
  }

  const slicePlanAsset = runnable.find((a) => a.kind === "slice-plan");
  if (slicePlanAsset) {
    record("slices", await runSection("slices", () => slicesSection(root, paths)));
  }

  const feelAsset = runnable.find((a) => a.kind === "feel-snapshot");
  if (feelAsset) {
    // A feel row cannot exist without a workspace: discovery only looks for one inside a
    // resolved workspace dir. The assertion records that, rather than inventing a path.
    record("feel", await runSection("feel", () => feelSection(deps, opts, root, workspace!, feelAsset)));
  }

  const outcome = resolveUnifiedOutcome({ executed, notRun, scoped: only !== null });
  const sectionNames = Object.keys(sections) as UnifiedSectionName[];
  const report: UnifiedVerifyReport = {
    kind: "unified-verify",
    schemaVersion: "1",
    producedAt: nowIso(),
    root,
    // The SAME binding rule build-verdict.json uses, so the two can be checked against
    // each other. Read after the sections ran: `writeState` preserves `currentBuild`.
    runId: (await readState(paths))?.currentBuild?.runId ?? null,
    live: opts.live,
    plan: assets,
    notRun,
    // Straight from discovery, unfiltered by the selection: a family with no asset is
    // absent whatever `--only` asked for, and re-deriving it here from a second list of
    // kinds is the drift the catalog exists to prevent.
    absentFamilies: absent,
    only,
    deselected,
    sections,
    anchoredSections: sectionNames.filter((n) => sections[n]!.anchored),
    unanchoredSections: sectionNames.filter((n) => !sections[n]!.anchored),
    status: outcome.status,
    exit: outcome.exit,
    notes,
  };
  await writeUnifiedVerifyReport(reportPath, report);
  await recordRollupInState({ root, paths, report, reportPath, scoped: only !== null });

  for (const line of summaryLines(report, opts.live)) console.error(line);
  console.error(
    `${TAG} status=${report.status} exit=${report.exit} report=${path.relative(root, reportPath)}`,
  );
  return report.exit;
}

/**
 * E16: RECORD THE SLICES ROLL-UP IN STATE, the way the flat door already records its own
 * verdict.
 *
 * Observed live: nine slices re-graded green through the roll-up and `STATE.md` still
 * read `built-unverified` / `lastVerdict: null`, because the only writer of that block
 * is `runVerify`, and on a slice-planned project `runVerify` grades the FLAT inputs dir,
 * finds nothing there, and takes its nothing-graded refusal (which correctly leaves STATE
 * untouched). So the one path that did the grading was the one path that never said so,
 * and every reader of STATE saw an unverified build.
 *
 * The rules mirror `runVerify`'s exactly:
 *
 *  - only a FULL run may record: a `--only` run is scoped by construction and never
 *    writes the full-run report (`UNIFIED_VERIFY_REPORT`), so it must not write the
 *    single-slot state either;
 *  - only a run whose slices section EXECUTED may record. A project with no slice plan
 *    keeps today's behaviour byte for byte: `runVerify` owns its STATE write and nothing
 *    here overwrites it;
 *  - only a real game verdict (`pass`/`fail`) may record. `harness-fault`,
 *    `nothing-checked` and `partial` are not verdicts about the game, and mapping them
 *    onto a `verified-*` phase would be the "verify passed" artefact the flat door's
 *    nothing-graded refusal exists to prevent. They leave STATE untouched, and say so.
 *
 * `currentBuild`, `genre`, `engine` and `designTarget` are carried through unchanged:
 * this records a verdict, it does not re-mint a run.
 */
async function recordRollupInState(args: {
  root: string;
  paths: ReturnType<typeof loombridgePaths>;
  report: UnifiedVerifyReport;
  reportPath: string;
  scoped: boolean;
}): Promise<void> {
  if (args.scoped) return;
  if (args.report.sections.slices === undefined) return;

  const status = args.report.status;
  if (status !== "pass" && status !== "fail") {
    console.error(
      `${TAG} slices: STATE not updated: the run is \`${status}\`, which is not a verdict about the game. ` +
        "Only pass/fail is recorded as a phase.",
    );
    return;
  }

  const prev = await readState(args.paths);
  const state: LoombridgeState = {
    genre: prev?.genre ?? "unknown",
    engine: prev?.engine ?? "unity",
    phase: phaseForStatus(status),
    designTarget: prev?.designTarget,
    currentBuild: prev?.currentBuild,
    lastVerdict: {
      status,
      at: args.report.producedAt,
      verdictPath: path.relative(args.root, args.reportPath),
    },
    updatedAt: args.report.producedAt,
  };
  await writeState(args.paths, state);
  console.error(
    `${TAG} slices: STATE.md phase=${state.phase} lastVerdict=${status} → ${state.lastVerdict!.verdictPath}`,
  );
}

// ── sections ─────────────────────────────────────────────────────────────────

/**
 * Run one section, mapping a THROW to that section's harness tier. A section that
 * cannot run is a gap in this run's coverage, never a verdict about the game, and
 * never a reason to abandon the sections after it.
 */
async function runSection(
  name: UnifiedSectionName,
  body: () => Promise<UnifiedVerifySection>,
): Promise<UnifiedVerifySection> {
  try {
    return await body();
  } catch (error) {
    console.error(`${TAG} ${name}: harness fault (not a game defect): ${message(error)}`);
    return { status: "harness-fault", exit: 2, anchored: false };
  }
}

/**
 * Stamp a section's report binding ONLY when this run produced the file (M5).
 *
 * `before` is the fingerprint taken before the engine ran. When the engine exited
 * without touching the file, the section says so instead of naming (and hashing) the
 * report a previous run left behind.
 */
async function bindReport(
  root: string,
  absPath: string | undefined,
  before: ReportFingerprint,
): Promise<Pick<UnifiedVerifySection, "reportPath" | "reportSha256" | "note">> {
  const after = await fingerprintReport(absPath);
  if (!reportWasWritten(before, after)) {
    return { note: "no report produced this run" };
  }
  return { reportPath: reportPathFor(root, absPath), reportSha256: after.sha256 };
}

/**
 * The acceptance contract. `runVerify` is called with today's exact defaults: it stages
 * the inputs, writes build-verdict.json, writes STATE, and owns the nothing-graded
 * refusal. The orchestrator adds nothing to that verdict and subtracts nothing from it.
 */
async function contractSection(
  deps: UnifiedSectionDeps,
  opts: UnifiedVerifyOpts,
  root: string,
  paths: ReturnType<typeof loombridgePaths>,
  asset: DiscoveredAsset,
): Promise<UnifiedVerifySection> {
  const before = await fingerprintReport(paths.verdict);
  const exit = await deps.runContract({
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: asset.paths.asset,
    outputPath: paths.verdict,
    strict: opts.strict,
  });
  const verdict = await readJson<VerdictShape>(paths.verdict);
  // L9/M-refused: the engine's nothing-graded refusal writes a `warn` verdict (its
  // gates name every missing capture) and exits 2. Copying `warn` up here would give
  // the run that measured NOTHING the same word as a run that measured a real subset
  // and found small problems. `refused` is the honest word, and it is derived from the
  // verdict's own gates + checks (`gradedGates`), the same pure predicate the engine
  // refused on, never from matching the refusal's prose.
  const refused = refusedNothingGraded(exit, verdict);
  const binding = await bindReport(root, paths.verdict, before);
  return {
    status: refused ? "refused" : verdict?.status ?? tierWord(exit),
    exit,
    // The contract's frozen half is the approved design target, and only a target that
    // is BOTH approved and unchanged since approval is an anchor a comparison used.
    anchored: asset.approvedAt !== undefined,
    ...binding,
    ...(refused ? { note: "nothing graded" } : {}),
  };
}

/** The shape the contract section reads back off `build-verdict.json`. */
type VerdictShape = { status?: string; gates?: Record<string, string>; checks?: { id: string; actual: string }[] };

/**
 * Did the contract engine refuse because NOTHING graded? Read from the verdict's own
 * gates + checks, which is the same disk truth `runVerify` refused on.
 */
function refusedNothingGraded(exit: number, verdict: VerdictShape | null): boolean {
  if (exit !== 2 || !verdict?.gates || !verdict.checks) return false;
  return gradedGates({ gates: verdict.gates, checks: verdict.checks } as Parameters<typeof gradedGates>[0]).length === 0;
}

/**
 * The screen contract. Two deliberate divergences from the guided `minigame` flow (A3):
 *
 * - the report goes to a VERIFY-OWNED path, never the workspace default, because
 *   `minigame next` drives its state machine off that file and a `verify` run must not
 *   advance (or reset) a human's guided flow behind their back;
 * - the baseline is the DISCOVERED dir, passed as an override. The plan named that dir
 *   and audited its manifest; grading against a different one the contract happens to
 *   declare would mean the verdict is not about the anchor the operator was shown.
 */
async function screensSection(
  deps: UnifiedSectionDeps,
  opts: UnifiedVerifyOpts,
  root: string,
  paths: ReturnType<typeof loombridgePaths>,
  asset: DiscoveredAsset,
): Promise<UnifiedVerifySection> {
  const outputPath = unifiedScreensReportPath(paths.reports);
  const before = await fingerprintReport(outputPath);
  const exit = await deps.runScreens({
    root,
    contractPath: asset.paths.asset,
    capturesDir: asset.paths.inputs!,
    outputPath,
    strict: opts.strict,
    quietNext: true,
    baselineRefOverride: asset.paths.baseline,
  });
  const report = await readJson<{ status?: string; baseline?: { present?: boolean } }>(outputPath);

  // A3: discovery verified an approved layout baseline (H1 makes that a precondition
  // for running at all), so a comparison that reports it as not-present means the two
  // disagree about what is on disk. That is a broken asset (harness tier), never a
  // quiet pass over no baseline.
  const compared = report?.baseline?.present === true;
  const tier = compared ? exit : 2;
  if (!compared && report !== null) {
    console.error(
      `${TAG} screens: the approved layout baseline at ${path.relative(root, asset.paths.baseline!)} ` +
        "was discovered but the comparison could not use it (broken asset, harness tier 2).",
    );
  }
  return {
    status: report?.status ?? tierWord(tier),
    exit: tier,
    anchored: compared,
    ...(await bindReport(root, outputPath, before)),
  };
}

/**
 * Trace replay (actuation + pixels). Pixel-drift gating is the DEFAULT here (A5): the
 * whole point of an approved baseline is that drift from it is a result, so the unified
 * door never runs the permissive variant.
 *
 * Each trace is caught individually (A7). One undrivable trace is one harness fault,
 * not a reason to stop measuring the others.
 */
async function flowSection(
  deps: UnifiedSectionDeps,
  root: string,
  traces: DiscoveredAsset[],
  projectPathCanonical: string | undefined,
): Promise<UnifiedVerifySection> {
  const layout = standardReplayLayout(root);
  const outcomes: UnifiedAssetOutcome[] = [];
  for (const asset of traces) {
    const before = await fingerprintReport(asset.paths.report);
    try {
      const { status, exitTier, suggestTolerance, maskSuggestion, htmlPath, ...drift } =
        await deps.runFlowTrace(layout, asset.id, { strictVisual: true, projectPathCanonical });
      // R1's suggestion loop, at the unified door and in the SAME words as the trace verb:
      // an operator who only ever runs `verify --live` must get the same actionable exit
      // from a pixel-only failure, naming `trace tolerance` (never `trace approve`).
      if (suggestTolerance) {
        // The mask half FIRST, in the same order and the same words the trace verb uses:
        // masks for concentrated drift, tolerance for diffuse, and the refusals (a
        // deterministic change, a diffuse drift, a drift that moved, a single run) printed
        // rather than hidden. The verdict leads because it is what decides whether a
        // tolerance is the remaining option; see `printSummary` for the full reasoning.
        if (maskSuggestion) {
          for (const line of maskSuggestionLines(maskSuggestion, asset.id)) {
            console.error(`${TAG} flow: ${line}`);
          }
        }
        for (const line of driftSuggestionLines({ ...drift, traceId: asset.id })) {
          console.error(`${TAG} flow: ${line}`);
        }
      }
      outcomes.push({
        kind: "trace",
        id: asset.id,
        status,
        exit: exitTier,
        drift,
        // The page THIS replay rendered. The catch below deliberately has no counterpart:
        // a trace that threw produced no run, so there is nothing to link, and the engine
        // has already removed or overwritten whatever page was there.
        htmlPath: reportPathFor(root, htmlPath) ?? htmlPath,
        ...(await bindReport(root, asset.paths.report, before)),
      });
    } catch (error) {
      console.error(
        `${TAG} flow: trace "${asset.id}" could not be replayed (harness fault, not a game defect): ${message(error)}`,
      );
      outcomes.push({
        kind: "trace",
        id: asset.id,
        status: "harness-fault",
        exit: 2,
        ...(await bindReport(root, asset.paths.report, before)),
      });
    }
  }
  const exit = worstExitTier(outcomes.map((o) => o.exit));
  const worst = outcomes.find((o) => o.exit === exit) ?? outcomes[0]!;
  return {
    status: worst.status,
    exit,
    // The worst asset's drift travels up as a TYPED field so `summaryLines` can name what
    // moved. Carried only when something actually drifted: a clean section says nothing
    // about tolerances, and an absent block can never be read as "0 captures drifted, so
    // this was checked".
    ...(worst.drift && worst.drift.driftCaptures > 0 ? { drift: worst.drift } : {}),
    // Every trace that reaches this section passed baseline-manifest verification at
    // discovery (unstamped and tampered baselines never become runnable rows), so a
    // section that executed at all compared a frozen anchor.
    anchored: traces.length > 0,
    reportPath: worst.reportPath,
    reportSha256: worst.reportSha256,
    // The page for the asset whose verdict this section is REPORTING, chosen by the same
    // `worst` rule as the JSON above it, so the link and the status word can never come
    // from two different traces.
    ...(worst.htmlPath ? { htmlPath: worst.htmlPath } : {}),
    ...(worst.note ? { note: worst.note } : {}),
    assets: outcomes,
  };
}

/**
 * The stamped Unity test run, graded OFFLINE (T1/T6).
 *
 * There is no engine to delegate to and no editor to launch: `loombridge tests run` is the
 * producer, this is the consumer, and everything here is a pure function of bytes already
 * on disk. Which means this section is the one place in the orchestrator that owns a
 * verdict, so it re-derives every binding rather than inheriting one from the plan:
 *
 *  - INTEGRITY IS RE-RUN HERE (not trusted from discovery). Discovery ran minutes-to-
 *    milliseconds earlier and its answer is a plan, not evidence; the section grades the
 *    bytes it read itself.
 *  - THE SHA IS RE-VERIFIED AGAINST THE BYTES ACTUALLY GRADED (G12/F13). `verifyTestResults`
 *    hashes what it read, and this section grades exactly that buffer; the explicit
 *    re-check below states the binding rather than leaving it as an implementation detail
 *    two refactors could separate.
 *  - THE SUMMARY IS RE-DERIVED FROM THE WALK AND COMPARED TO THE MANIFEST'S (G12). The
 *    producer stamped `deriveSummary(parsed)`; the grader recomputes the same function over
 *    the same bytes, so any disagreement means the manifest was hand-edited.
 *  - THE PRODUCER'S FACTS ARE READ, NOT ASSUMED (G4): `exitCode`, `compileErrors`,
 *    `mutatedProject`, and the assembly set all feed `gradeTestResults`, which refuses on
 *    each. `exitCodeIsUnexplained` is the exit-code rule, imported rather than re-stated:
 *    Unity exits 2 on genuine test failures, so a blanket "non-zero is a harness fault"
 *    would reclassify every real red as a harness problem and this gate could never report
 *    an assertion defect at all.
 *
 * `anchored` is FALSE, always and permanently (R8). A suite has no human-approve step, so
 * there is nothing frozen to compare against; G1 turns that into `partial` rather than
 * `pass` for the run, which is the honest reading.
 */
async function testsSection(
  opts: UnifiedVerifyOpts,
  root: string,
  paths: ReturnType<typeof loombridgePaths>,
): Promise<UnifiedVerifySection> {
  const dir = paths.tests;
  const refuse = (note: string): UnifiedVerifySection => {
    console.error(`${TAG} tests: ${note}`);
    return { status: "harness-fault", exit: 2, anchored: false, note };
  };

  const integrity = await verifyTestResults(dir, { root });
  if (integrity.unstamped) {
    return refuse(`no ${TEST_RESULTS_MANIFEST} in ${path.relative(root, dir)}; run \`loombridge tests run\``);
  }
  if (!integrity.ok) return refuse(integrity.failures.join("; "));

  const manifest = integrity.manifest!;
  const bytes = integrity.resultsBytes;
  if (bytes === undefined) {
    return refuse(`${TEST_RESULTS_FILE} could not be read at grade time`);
  }
  // G12/F13, stated explicitly: the verdict below is about THESE bytes, and the manifest
  // that supplies exitCode/compileErrors/assemblies is bound to them.
  if (sha256(bytes) !== manifest.resultsSha256) {
    return refuse(`${TEST_RESULTS_FILE} does not hash to the manifest's resultsSha256 at grade time`);
  }

  const parsed = parseNUnitResults(bytes.toString("utf-8"));
  if (isNUnitParseError(parsed)) {
    // The unreadable-PNG precedent: evidence that cannot be read is a refusal, never a skip
    // and never a pass over "the cases I happened to see".
    return refuse(`${TEST_RESULTS_FILE} is unreadable: ${parsed.error}`);
  }

  const grade = gradeTestResults({
    run: parsed,
    strict: opts.strict,
    exitCode: manifest.exitCode,
    compileErrors: manifest.compileErrors,
    mutatedProject: manifest.mutatedProject,
    manifestSummary: manifest.summary,
    manifestAssemblies: manifest.assemblies,
  });

  const s = grade.summary;
  const headline =
    `${s.total} test(s): ${s.passed} passed, ${s.failed} failed, ` +
    `${s.inconclusive} inconclusive, ${s.skipped} skipped`;
  console.error(`${TAG} tests: ${headline} (stamped ${manifest.finishedAt}, runId ${manifest.runId ?? "none"})`);
  for (const reason of grade.reasons) console.error(`${TAG} tests:   refusal: ${reason}`);
  for (const note of grade.notes) console.error(`${TAG} tests:   note: ${note}`);
  // A named, capped list of the disagreements the manifest carries, printed even when the
  // grade already refused, so an operator can see WHICH cross-check fired.
  const stampedVsGraded = summaryDisagreements(manifest.summary, deriveSummary(parsed));
  if (stampedVsGraded.length > 0) {
    console.error(`${TAG} tests:   manifest summary disagrees with the walk: ${stampedVsGraded.join("; ")}`);
  }
  if (exitCodeIsUnexplained(manifest.exitCode, grade.failures.filter((f) => f.label === undefined || f.label === "Error").length)) {
    console.error(`${TAG} tests:   Unity exit ${manifest.exitCode} is not accounted for by the test-case walk`);
  }

  // T6: the per-failure detail behind the section's single word, capped so a suite-wide red
  // cannot bury the report. `assets` is the shared row shape, one row per failing case.
  const assets: UnifiedAssetOutcome[] = grade.failures.slice(0, 10).map((failure) => ({
    kind: "test-results" as const,
    id: failure.fullname,
    status: failure.label ?? "Failed",
    exit: grade.tier,
    ...(failure.message ? { note: failure.message.split(/\r?\n/)[0]!.slice(0, 200) } : {}),
  }));

  return {
    status: tierWord(grade.tier),
    exit: grade.tier,
    // PERMANENT (R8). Not "false because this run found no anchor": there is no anchor to
    // find, and there is no verb that could create one.
    anchored: false,
    // FXC: the build scope travels into the unified report, `null` included, so a reader can tell
    // build-scoped evidence from unscoped evidence without parsing this run's stderr.
    runId: manifest.runId,
    note: `${headline}; bound to the run, never human-approved`,
    ...(assets.length > 0 ? { assets } : {}),
  };
}

/**
 * THE SLICE ROLL-UP (E5/L109), graded OFFLINE.
 *
 * Like `tests`, there is no editor to launch and no engine to delegate to: every input
 * is on disk. Unlike `tests`, this section CAN be anchored, because an approved slice
 * carries a human checkpoint (`proof.approvedAt`) and the roll-up re-grades the
 * evidence that approval was made against.
 *
 * The whole decision lives in `evaluateSliceRollup` (pure of console output). This
 * function prints it and shapes the section. It writes NOTHING: the per-slice verdicts
 * are the approved record, and a door that rewrote them while grading them would be
 * grading its own output.
 */
async function slicesSection(
  root: string,
  paths: ReturnType<typeof loombridgePaths>,
): Promise<UnifiedVerifySection> {
  const { readSlicePlan } = await import("../slices.js");
  const { evaluateSliceRollup, reverifyCommand } = await import("../slice-rollup.js");
  const { assertValidAcceptanceContract } = await import("../validator.js");

  const plan = await readSlicePlan(paths);
  if (!plan) {
    // Discovery only produced a runnable row because the file was there and parsed;
    // if it is gone by now, that is a harness fault, never a pass.
    const note = "SLICES.json disappeared between the plan and the run";
    console.error(`${TAG} slices: ${note}`);
    return { status: "harness-fault", exit: 2, anchored: false, note };
  }
  let acceptance;
  try {
    acceptance = assertValidAcceptanceContract(
      JSON.parse(await fs.readFile(paths.acceptance, "utf-8")),
    );
  } catch (error) {
    const note = `the acceptance contract could not be read, so no slice can be re-graded: ${message(error)}`;
    console.error(`${TAG} slices: ${note}`);
    return { status: "harness-fault", exit: 2, anchored: false, note };
  }

  const rollup = await evaluateSliceRollup({ root, paths, acceptance, plan });
  console.error(
    `${TAG} slices: ${rollup.approvedSlices}/${rollup.totalSlices} approved, ` +
      `${rollup.regradedGreen} re-graded green`,
  );
  for (const slice of rollup.slices) {
    const sha = slice.verdictSha256 ? slice.verdictSha256.slice(0, 12) : "(unreadable)";
    console.error(
      `${TAG} slices:   ${slice.id}: ${slice.regradedGreen ? "re-graded green" : "NOT re-graded green"} ` +
        `[evidence: ${slice.originSummary ?? "no ledger"}] verdict ${slice.verdictPath} sha ${sha}`,
    );
  }
  for (const note of rollup.notes) console.error(`${TAG} slices:   note: ${note}`);
  for (const refusal of rollup.refusals) console.error(`${TAG} slices:   REFUSED: ${refusal}`);
  if (rollup.refusals.length > 0) {
    // S4e: the refusal names the exact command, per slice, so "what do I run now" is
    // answered by the output rather than by reading this file.
    const failing = rollup.slices.filter((s) => s.refusals.length > 0).map((s) => s.id);
    if (failing.length > 0) {
      console.error(
        `${TAG} slices:   re-verify: ${failing.map((id) => reverifyCommand(root, id)).join("  &&  ")}`,
      );
    }
  }

  return {
    status: rollup.status,
    exit: rollup.exit,
    // M17, in the FXH terms: an approval whose evidence no longer re-grades is not an
    // anchor that was COMPARED, so `anchored` requires a re-graded green AND full
    // contract coverage. A refused roll-up contributes tier 2 and no anchor, which is
    // why a project with per-slice dirs and an empty flat dir cannot improve its exit
    // by this section merely existing.
    anchored: rollup.anchored,
    note:
      `${rollup.regradedGreen}/${rollup.approvedSlices} approved slice(s) re-graded green` +
      (rollup.coverageRefusals.length > 0
        ? `; ${rollup.coverageRefusals.length} contract section(s) walked by no gate`
        : ""),
    assets: rollup.slices.map((slice) => ({
      kind: "slice-plan" as const,
      id: slice.id,
      status: slice.regradedGreen ? "pass" : "refused",
      exit: slice.regradedGreen ? 0 : 2,
      reportPath: slice.verdictPath,
      // The project verdict BINDS to the slice verdicts by sha: a later hand-edit of an
      // approved slice verdict is detectable against this roll-up.
      reportSha256: slice.verdictSha256,
      ...(slice.refusals.length > 0 ? { note: slice.refusals[0] } : {}),
    })),
  };
}

/**
 * The feel snapshot. `runVerifySnapshot` already implements the 0/1/2 contract (clean /
 * drift / integrity-or-capture-gap), so its exit is taken as-is: re-deriving a tier here
 * would put a second, drifting opinion next to the engine's.
 */
async function feelSection(
  deps: UnifiedSectionDeps,
  opts: UnifiedVerifyOpts,
  root: string,
  workspace: string,
  asset: DiscoveredAsset,
): Promise<UnifiedVerifySection> {
  const before = await fingerprintReport(asset.paths.report);
  const exit = await deps.runFeel({ root, workspace, strict: opts.strict });
  const report = await readJson<{ status?: string }>(asset.paths.report);
  return {
    status: report?.status ?? tierWord(exit),
    exit,
    // Discovery only marks a feel row runnable when `verifySnapshotIntegrity` passed
    // AND the snapshot's `projectRoot` stamp names this project, so an executed feel
    // section is by construction a comparison against a frozen, owned anchor.
    anchored: asset.approvedAt !== undefined,
    ...(await bindReport(root, asset.paths.report, before)),
  };
}

// ── output ───────────────────────────────────────────────────────────────────

/**
 * The plan: one line per discovered asset, then one line per check family this project has
 * NO asset of, printed before anything runs.
 *
 * The second half is not decoration. Observed live: a project with a single trace produced
 * a verdict covering exactly that trace, and the operator could not tell whether the screen
 * checks (safe area, tap targets, required objects) had passed, did not exist, or had
 * silently not run. Every family the door knows about is now named either as a row above or
 * as a gap below, so those three readings can never again print identically.
 */
export function planLines(
  root: string,
  assets: readonly DiscoveredAsset[],
  notes: readonly string[],
  live: boolean,
  only: readonly UnifiedSectionName[] | null = null,
  absent: readonly AbsentAssetFamily[] = [],
): string[] {
  const scope = only ? `; scoped to --only ${only.join(",")}` : "";
  const lines = [
    `${TAG} plan for ${root} (${live ? "offline + live" : "offline only; pass --live for live assets"}${scope}):`,
  ];
  for (const asset of assets) {
    lines.push(`${TAG}   ${asset.kind} '${asset.id}': ${disposition(asset, live, only)}; ${provenance(asset)}`);
    // Q7: THE ANCHOR'S TERMS GET THEIR OWN LINE. Appending them to the row above produced
    // a run-on that buried the one fact a reader most needs before anything runs: how
    // much of this comparison is already conceded. Silent when there is nothing conceded
    // (no masks, default tolerance), so a strict anchor still reads as one line.
    const terms = anchorTerms(asset);
    if (terms) lines.push(`${TAG}     anchor terms: ${terms}`);
  }
  if (assets.length === 0) lines.push(`${TAG}   (no verification assets)`);
  // ONE LINE PER ABSENT FAMILY, in the same voice as the rows above: what it would have
  // established, and the command that creates one. `searchedIn` is printed when the family
  // lives outside the project, because "no screen contract" and "no screen contract under
  // the id this folder name derives" are different answers.
  for (const family of absent) {
    const where = family.searchedIn ? `, searched ${family.searchedIn}` : "";
    lines.push(
      `${TAG}   ${family.kind}: NO ASSET, nothing in this family was checked${where} ` +
        `(would cover ${family.covers}); create one: ${family.nextAction}`,
    );
  }
  for (const note of notes) lines.push(`${TAG}   note: ${note}`);
  return lines;
}

/**
 * What the plan says will happen to one row.
 *
 * The BROKEN and not-runnable branches come FIRST, before the selection is consulted, for
 * the same reason the classification loop does (F2): a broken row is refused whatever the
 * operator selected, and the plan must say so rather than reporting it as merely scoped out.
 */
function disposition(asset: DiscoveredAsset, live: boolean, only: readonly UnifiedSectionName[] | null): string {
  if (asset.broken) return `BROKEN, will not run: ${asset.broken}`;
  if (asset.runnable === "no") return `will not run: ${asset.reason ?? "not runnable"}`;
  if (only && !only.includes(SECTION_FOR_KIND[asset.kind])) {
    return `deselected (--only ${only.join(",")}): not run, and not counted`;
  }
  if (asset.runnable === "live") return live ? "will run (live)" : "not run: needs --live";
  return "will run (offline)";
}

/**
 * WHEN and by WHAT this asset's anchor was approved: the RFC's human-anchor invariant.
 *
 * The parenthetical is the provenance AS RECORDED (L13). Discovery re-derives the
 * integrity shas from disk, so the frozen bytes are audited; the source it names
 * (a replay report, a contract id, a human's note) is copied off the manifest and is
 * not re-checked here. The wording keeps those two apart so a reader cannot take the
 * line as a claim that the named source was verified.
 */
function provenance(asset: DiscoveredAsset): string {
  if (asset.approvedAt) {
    return `approved ${asset.approvedAt}${asset.approvedBy ? ` (${asset.approvedBy})` : ""}`;
  }
  if (asset.runnable !== "no" && asset.reason) return `no frozen anchor (${asset.reason})`;
  return "no frozen anchor";
}

/**
 * R1/A2 + Q7, THE AUDIT SURFACE. What this anchor already concedes, printed BEFORE
 * anything runs: a stamped tolerance with the consent sentence spelling out how big the
 * hole is, and any masks with how much of the frame they blank outright. A tolerance or a
 * mask nobody sees is indistinguishable from a gate nobody has.
 *
 * The sentence itself comes from `anchorTermsSentence`, the SAME function the two stamp
 * verbs and the HTML header print, so the plan cannot describe this anchor's terms in
 * words the stamp never used. The default (no masks, default tolerance) is silent: it is
 * the strictest thing the fields can hold, so it says nothing new.
 *
 * The masked fraction reaches this line as a NUMBER discovery already computed from the
 * rects, so the rects themselves never have to be re-measured here against dimensions the
 * plan does not have.
 */
function anchorTerms(asset: DiscoveredAsset): string | null {
  if (!asset.approvedAt) return null;
  return anchorTermsSentence({
    maskCount: asset.maskCount ?? 0,
    maskedFraction: asset.maskedFraction ?? 0,
    scopedCount: asset.maskScopedCount ?? 0,
    tolerance: asset.driftTolerance ?? DEFAULT_DRIFT_FRACTION,
  });
}

/**
 * The on-ramp for a project with nothing to check. The actors are named honestly: the
 * recording session is a HUMAN playing the game, and that play session IS the approval
 * moment. An agent reading this must not be told to perform a step it structurally
 * cannot perform.
 */
export function onRampLines(root: string, opts: { acceptanceAbsent: boolean } = { acceptanceAbsent: false }): string[] {
  const lines = [
    `${TAG} REFUSED: no verification assets found under ${root}, so nothing was checked.`,
    `${TAG} a run that checked nothing is not a pass (exit 2). No report was written.`,
    `${TAG} the cheapest universal anchor is a recorded demonstration, so ask your human to play the game once:`,
    `${TAG}   1. loombridge trace record --id <name>             (a HUMAN plays it; this session IS the approval)`,
    `${TAG}   2. loombridge trace replay --id <name>             (re-drive the demonstration and capture frames)`,
    `${TAG}   3. loombridge trace approve --id <name>            (freeze those frames as the baseline)`,
    `${TAG} then run: loombridge verify --live`,
  ];
  // F7, THE OTHER DOOR. The on-ramp above is door two (an existing game: approve an anchor,
  // then re-measure it forever). An agent that reaches this text while BUILDING a new game
  // has arrived at the wrong door entirely, and the tell is on disk: no ACCEPTANCE.json.
  // Naming `loombridge plan` here is what stops the answer to "there is nothing to verify"
  // being read as "record a demonstration of the game you have not built yet".
  if (opts.acceptanceAbsent) {
    lines.push(
      `${TAG} building a NEW game? loombridge plan is the other door: it scaffolds .loombridge/ and`,
      `${TAG}   authors the acceptance contract this verb grades (there is no ACCEPTANCE.json here).`,
    );
  }
  return lines;
}

/** The per-section result lines plus the roll-up of everything that was NOT measured. */
export function summaryLines(report: UnifiedVerifyReport, live: boolean): string[] {
  const lines: string[] = [];
  for (const [name, section] of Object.entries(report.sections)) {
    const detail = section.assets?.length
      ? ` [${section.assets.map(assetDetail).join(", ")}]`
      : "";
    const where = section.reportPath ? ` → ${section.reportPath}` : "";
    // THE PAGE IS NAMED WHEREVER THE JSON IS (the whole point of carrying `htmlPath` up):
    // a human told only about a verdict file goes looking for the pictures, and the file
    // they find may be another run's. The spelling is `trace replay`'s own `html   → …`,
    // deliberately, so the two doors read identically. It is a closure rather than a
    // suffix on `where` because it is a SECOND line, and because the drift branch below
    // returns early: a suffix would have to be repeated at both exits, which is exactly
    // how one of them comes to lose it.
    const withHtml = (line: string): void => {
      lines.push(line);
      if (section.htmlPath) lines.push(`${TAG} ${name}: html   → ${section.htmlPath}`);
    };
    // R3/A3: DRIFT NAMES ITSELF, and it leads. The engine's own word for a trace whose
    // actuation succeeded is `pass`, so the previous line read "flow: pass (exit 1)" and
    // taught readers to distrust either the word or the number. The failing thing goes
    // first; the actuation result stays as the qualifier that it is.
    if (section.drift && section.drift.driftCaptures > 0) {
      withHtml(
        `${TAG} ${name}: ${driftRegressionLine({ ...section.drift, exitTier: section.exit })}` +
          `${detail}${where}`,
      );
      continue;
    }
    const qualifier = section.note ? `${section.note}, exit ${section.exit}` : `exit ${section.exit}`;
    // M8: say out loud when an executed section compared no frozen anchor. "pass" and
    // "pass against nothing a human froze" must not print identically.
    const anchor = section.anchored ? "" : " [no frozen anchor compared]";
    // FXQ: the same fact, carried by the STATUS WORD itself, for the green case. The bracketed
    // marker above is easy to crop; the word is what gets quoted. This is a HUMAN-facing
    // change only: `UnifiedVerifySection.status` in the unified report keeps the engine's own word
    // verbatim (the machine-readable `anchored` field sits beside it), so no consumer has to
    // learn a new status token.
    const word = section.exit === 0 && !section.anchored ? `${section.status} (unanchored)` : section.status;
    withHtml(`${TAG} ${name}: ${word} (${qualifier})${detail}${anchor}${where}`);
  }
  if (report.notRun.length > 0) {
    // Name EVERY unmeasured anchor (A6). A partial that exits 0 must still say out loud
    // which anchors it did not measure, or "0" reads as "all clear".
    lines.push(
      `${TAG} NOT MEASURED (never folded into pass): ` +
        report.notRun.map((n) => `${n.kind} '${n.id}' (${n.reason})`).join("; "),
    );
  }
  if (report.absentFamilies.length > 0) {
    // THE COVERAGE GAP, on every run, green or red. A verdict that grades one trace and
    // says nothing else reads as a verdict about the game; this line says which families
    // it is silent about. It is INFORMATIONAL: no status word, no tier, no exit code is
    // derived from it anywhere, and the wording is careful not to imply otherwise, because
    // enumerating a gap is the opposite of covering it. The per-family next action is one
    // scroll up, in the plan, rather than repeated here.
    lines.push(
      `${TAG} NOT CHECKED (no asset of this kind exists here, so this verdict says nothing ` +
        `about them; see the plan above to create one): ` +
        report.absentFamilies.map((f) => f.kind).join(", "),
    );
  }
  if (report.only) {
    // The scoping is stated on EVERY scoped run, green or red, and separately from the
    // deselected rows: an operator (or a CI log reader) must be able to tell a subset run
    // from a full one without reconstructing it from what did not print.
    lines.push(`${TAG} ${SCOPED_SUMMARY} [--only ${report.only.join(",")}]`);
    if (report.deselected.length > 0) {
      lines.push(
        `${TAG} DESELECTED (--only, excluded from the verdict): ` +
          report.deselected.map((d) => `${d.kind} '${d.id}' (${d.section})`).join("; "),
      );
    }
  }
  if (report.status === "nothing-checked") {
    const liveOnly = report.notRun.filter((n) => n.why === "live-only-skipped");
    lines.push(`${TAG} REFUSED: zero assets executed, so nothing was checked (exit 2).`);
    if (report.only) {
      // The row-less selection, named (S2a). A selector that matched no discovered asset is
      // still a run that checked nothing, and the operator's typo (or a project that never
      // grew that asset) is the actionable half of the answer.
      lines.push(
        `${TAG} the selection --only ${report.only.join(",")} matched no runnable asset ` +
          `(discovered kinds: ${report.plan.map((a) => a.kind).join(", ") || "none"}).`,
      );
    }
    if (liveOnly.length > 0 && !live) {
      lines.push(
        `${TAG} every discovered asset needs a running editor. Re-run with: loombridge verify --live`,
      );
    }
  }
  if (report.status === "partial") {
    // Three very different partials share one word, so the line has to separate them: an
    // operator's deliberate `--live` omission still exits 0; an anchor the run could not
    // measure (broken, unapproved, draft) keeps the harness tier even though every executed
    // check was green; and G1's case, where everything ran and passed but a section compared
    // nothing a human ever froze, exits 0 and is still not a pass.
    if (report.notRun.length > 0) {
      lines.push(
        report.exit === 0
          ? `${TAG} PARTIAL: everything that ran passed, but the anchors above were not measured `
            + "(skipped for lack of --live). This is not a full pass."
          : `${TAG} PARTIAL: everything that ran passed, but the anchors above could not be measured `
            + `at all, which is the harness tier (exit ${report.exit}). This is not a pass.`,
      );
    }
    // G1: name the unanchored sections. "Everything passed" and "everything passed against
    // nothing a human approved" must never read the same, and the machine-readable
    // `unanchoredSections` is not enough on its own: the summary line is what an agent
    // quotes.
    if (report.unanchoredSections.length > 0) {
      lines.push(
        `${TAG} PARTIAL: no frozen human approval was compared in: ${report.unanchoredSections.join(", ")}. `
          + "A green section measured against nothing a human froze is not a pass.",
      );
    }
    // FXH: the strongest form of that, where NO executed section was anchored, is also the one
    // that changes the exit. It gets its own line because the exit code is the part an agent
    // acts on, and "why is this a 2" must be answerable from the summary alone.
    if (report.anchoredSections.length === 0 && Object.keys(report.sections).length > 0) {
      lines.push(`${TAG} REFUSED: ${ZERO_ANCHORED_SUMMARY} (exit ${report.exit}).`);
    }
  }
  return lines;
}

/**
 * One asset inside a section's bracketed detail list.
 *
 * A drifted trace is NAMED as drift with its numbers, not printed as `id=pass` (R3): the
 * per-asset list is the only place a multi-trace section says WHICH trace moved, and
 * `pass` next to a section that exited 1 is the same dishonesty at a smaller scale.
 */
function assetDetail(asset: UnifiedAssetOutcome): string {
  const masked = asset.drift?.maskedFraction ?? 0;
  if (asset.drift && asset.drift.driftCaptures > 0) {
    return (
      `${asset.id}=pixel drift ${driftPercentText(asset.drift.maxDiffFraction)}% ` +
      `(${asset.drift.driftCaptures} capture(s) over tolerance ` +
      `${driftPercentText(asset.drift.toleranceUsed)}%` +
      // Q7: the number is qualified ONLY when masks exist, so an unmasked section reads
      // exactly as it always did and a masked one never claims more coverage than it had.
      (masked > 0 ? `, ${driftPercentText(masked)}% of the frame masked` : "") +
      ")"
    );
  }
  // M7/MX6: THE GREEN BRANCH CARRIES THE QUALIFIER TOO, and it is the branch that needs it
  // most. `demo=pass` is the line an agent quotes as proof, and a pass measured with 8% of
  // every frame blanked is a materially weaker claim than a pass: the red branch disclosing
  // the mask while the green branch hid it meant the disclosure vanished at exactly the
  // moment it started to matter. Silent at 0, so an unmasked row is byte-identical to what
  // it always printed.
  return masked > 0
    ? `${asset.id}=${asset.status} (${driftPercentText(masked)}% masked)`
    : `${asset.id}=${asset.status}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Would writing the unified report at `target` destroy something? (M4)
 *
 * Returns the refusal sentence, or null when the path is safe. Two rules, in order:
 *
 *  1. a DECLARED project artifact is refused whether or not it exists yet, because
 *     "ACCEPTANCE.json does not exist" is not a reason to be willing to create the
 *     unified report there;
 *  2. any other EXISTING file is refused unless it is a previous unified report
 *     (`kind: "unified-verify"`), which is the one file this run is entitled to
 *     replace.
 *
 * The known-artifact list is resolved from `loombridgePaths` + the report constants,
 * never re-spelled here: a renamed artifact moves both ends at once.
 *
 * M-M6, SYMLINKS. Both sides are resolved through `realTarget` before they are compared. A
 * string comparison of `path.resolve`d paths sees only what the argv spelled, so a symlink at
 * a fresh-looking path (`.loombridge/reports/sneaky.json -> verify.json`) matched nothing in
 * the declared list, read back as a previous unified report through the link, and was then
 * written THROUGH the link onto the file it pointed at. That is the F1 both-directions rule
 * defeated by one `ln -s`, and the same trick reaches the acceptance contract and the verdict.
 */
async function reportCollision(
  paths: ReturnType<typeof loombridgePaths>,
  target: string,
  scoped: boolean,
): Promise<string | null> {
  const realTargetPath = await realTarget(target);
  const declared: [string, string][] = [
    // F1, BOTH DIRECTIONS. The full report and the scoped report answer different questions,
    // and `--report` is the one way an operator could point one run at the other's file. A
    // scoped run may never write verify.json (the document `doneness` reads); a full run
    // may never write verify-scoped.json. Neither is caught by the "previous unified
    // report" allowance below, because both files carry `kind: "unified-verify"`.
    scoped
      ? [unifiedVerifyReportPath(paths.reports), "is the FULL run's unified report; a scoped run (--only) never writes it"]
      : [unifiedScopedReportPath(paths.reports), "is the scoped (--only) run's own report; a full run never writes it"],
    [paths.acceptance, "is the acceptance contract"],
    [paths.slices, "is the slice roadmap"],
    [paths.state, "is the project STATE"],
    [paths.gameSpec, "is the game spec"],
    [paths.feelSpec, "is the feel spec"],
    [paths.assetManifest, "is the approved asset manifest"],
    [paths.genrePromotion, "is the genre promotion report"],
    [paths.verdict, "is the Tier-1 build verdict"],
    [unifiedScreensReportPath(paths.reports), "is the unified run's own screens report"],
    // The stamped test-results trio. Named individually so the refusal says WHICH piece of
    // evidence `--report` was about to destroy, and resolved from the same constants the
    // producer writes through, so a rename moves both ends at once.
    [testResultsPath(paths.tests), "is the stamped Unity test results"],
    [testResultsManifestPath(paths.tests), "is the test-results binding manifest"],
    [testRunLogPath(paths.tests), "is the Unity test run log"],
  ];
  for (const [artifact, what] of declared) {
    if ((await realTarget(artifact)) === realTargetPath) return what;
  }
  // …and the whole directory as a backstop: `.loombridge/tests/` is committed EVIDENCE, so
  // nothing under it is ever a report destination, named file or not.
  const testsDir = await realTarget(paths.tests);
  if (realTargetPath === testsDir || realTargetPath.startsWith(`${testsDir}${path.sep}`)) {
    return "is inside the stamped test-results directory";
  }
  // The whole design directory: the frozen hero shot and its metadata live there, and
  // nothing under it is ever a report destination.
  const designDir = await realTarget(paths.design);
  if (realTargetPath === designDir || realTargetPath.startsWith(`${designDir}${path.sep}`)) {
    return "is inside the Design Target directory";
  }

  const existing = await readJson<{ kind?: unknown }>(target);
  if (existing !== null) {
    if (existing.kind === "unified-verify") return null;
    return "already exists and is not a previous unified verify report";
  }
  try {
    await fs.access(target);
    // Present but not JSON we could read: still someone else's file.
    return "already exists and is not a previous unified verify report";
  } catch {
    return null;
  }
}

/**
 * A path as the FILESYSTEM sees it: every symlink in the chain resolved, for the part of the
 * path that exists, with the not-yet-created remainder appended (M-M6).
 *
 * A plain `fs.realpath` cannot be used: the report target usually does NOT exist yet (that is
 * the point of writing it), and realpath on a missing path throws ENOENT, which would leave
 * exactly the comparison this exists to fix. So the deepest EXISTING ancestor is resolved and
 * the remaining segments are joined back on. Both the target and each declared artifact go
 * through this, so the comparison is between two paths the kernel would agree are the same
 * file, rather than between two strings the caller happened to type.
 */
async function realTarget(p: string): Promise<string> {
  const resolved = path.resolve(p);
  const remainder: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return remainder.length === 0 ? real : path.join(real, ...remainder.reverse());
    } catch {
      // A DANGLING symlink fails realpath (its target does not exist yet), but a write
      // through it would CREATE the target: resolving to the link's spelled parent would
      // let a link inside the root smuggle a write outside it (caught live by the escape
      // test). Follow the link text by hand and resolve where the write would land.
      try {
        const linkText = await fs.readlink(current);
        const followed = path.resolve(path.dirname(current), linkText);
        // A self-referential or cyclic link chain cannot make progress; refuse to loop.
        if (followed !== current) {
          const real = await realTarget(followed);
          return remainder.length === 0 ? real : path.join(real, ...remainder.reverse());
        }
      } catch {
        // Not a symlink (plain nonexistent path): fall through to ancestor resolution.
      }
      const parent = path.dirname(current);
      // The filesystem root itself is unresolvable only on a broken system; fall back to the
      // literal path rather than looping.
      if (parent === current) return resolved;
      remainder.push(path.basename(current));
      current = parent;
    }
  }
}

async function readJson<T>(file: string | undefined): Promise<T | null> {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** The fallback status word when an engine wrote no readable report of its own. */
function tierWord(exit: number): string {
  return exit === 0 ? "pass" : exit === 1 ? "fail" : "harness-fault";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
