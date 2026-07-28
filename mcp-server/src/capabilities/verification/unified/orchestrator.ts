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
  loombridgePaths,
  nowIso,
  readState,
  standardReplayLayout,
  type ReplayLayout,
} from "../../../domain/state.js";
import { isInside, projectWorkspace, sanitizeWorkspaceId } from "../../../domain/workspace-paths.js";
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
import { discoverVerificationAssets, type DiscoveredAsset } from "./discovery.js";
import {
  fingerprintReport,
  notRunFor,
  reportPathFor,
  reportWasWritten,
  resolveUnifiedOutcome,
  unifiedScreensReportPath,
  unifiedVerifyReportPath,
  worstExitTier,
  writeUnifiedVerifyReport,
  type ReportFingerprint,
  type UnifiedAssetOutcome,
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
  runFlowTrace(
    layout: ReplayLayout,
    id: string,
    opts: { strictVisual: boolean; projectPathCanonical?: string },
  ): Promise<{ status: string; exitTier: number }>;
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
      const { replayTraceForVerify } = await import("../../replay/trace.js");
      const { artifact, exitTier } = await replayTraceForVerify(layout, id, opts);
      return { status: artifact.status, exitTier };
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
  const reportPath = opts.reportPath ?? unifiedVerifyReportPath(paths.reports);

  // `--report` IS A WRITE, so it is validated before anything else happens (M4). A
  // path that collides with a project artifact would have the run silently overwrite
  // the contract, the roadmap, or a verdict it is supposed to be reading. This refuses
  // FIRST: before discovery, before the plan, before a single section runs, so a
  // refused invocation leaves the project byte-identical.
  // Containment first: the docs promise --report "resolves relative to --root", and a
  // path that escapes the root would let a verify run write outside the project it is
  // grading (observed in the S1 final test: `--report ../../escape.json` was accepted).
  // Refuse rather than clamp: a silently relocated report is a report nobody finds.
  if (!isInside(reportPath, root)) {
    console.error(`${TAG} REFUSED: --report ${reportPath} resolves outside the project root ${root}`);
    console.error(
      `${TAG} nothing was written and nothing ran. Point --report inside the project, or omit it to use ` +
        `${path.relative(root, unifiedVerifyReportPath(paths.reports))}.`,
    );
    return 2;
  }
  const collision = await reportCollision(paths, reportPath);
  if (collision) {
    console.error(`${TAG} REFUSED: --report ${path.relative(root, reportPath)} ${collision}`);
    console.error(
      `${TAG} nothing was written and nothing ran. Point --report at a new path, or omit it to use ` +
        `${path.relative(root, unifiedVerifyReportPath(paths.reports))}.`,
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

  const { assets, notes } = await discoverVerificationAssets({
    root,
    workspaceId: opts.workspaceId,
    workspace,
  });

  // THE PLAN, before any write. `discoverVerificationAssets` only reads, so at this
  // point the project on disk is byte-identical to what the operator started with.
  for (const line of planLines(root, assets, notes, opts.live)) console.error(line);

  if (assets.length === 0) {
    // The on-ramp. Nothing is written, not even `.loombridge/`: a fresh project that
    // asked a question and got an answer must not acquire state as a side effect.
    for (const line of onRampLines(root)) console.error(line);
    return 2;
  }

  const notRun: UnifiedNotRun[] = [];
  const sections: Partial<Record<UnifiedSectionName, UnifiedVerifySection>> = {};
  const executed: { section: UnifiedSectionName; exit: number; anchored: boolean }[] = [];

  // Every row that will NOT execute, classified BEFORE anything runs so the reason is
  // discovery's own (`notRunClass`), never inferred from how a section behaved.
  const runnable: DiscoveredAsset[] = [];
  for (const asset of assets) {
    if (asset.runnable === "no") notRun.push(notRunFor(asset));
    else if (asset.runnable === "live" && !opts.live) {
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

  const feelAsset = runnable.find((a) => a.kind === "feel-snapshot");
  if (feelAsset) {
    // A feel row cannot exist without a workspace: discovery only looks for one inside a
    // resolved workspace dir. The assertion records that, rather than inventing a path.
    record("feel", await runSection("feel", () => feelSection(deps, opts, root, workspace!, feelAsset)));
  }

  const outcome = resolveUnifiedOutcome({ executed, notRun });
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
    sections,
    anchoredSections: sectionNames.filter((n) => sections[n]!.anchored),
    unanchoredSections: sectionNames.filter((n) => !sections[n]!.anchored),
    status: outcome.status,
    exit: outcome.exit,
    notes,
  };
  await writeUnifiedVerifyReport(reportPath, report);

  for (const line of summaryLines(report, opts.live)) console.error(line);
  console.error(
    `${TAG} status=${report.status} exit=${report.exit} report=${path.relative(root, reportPath)}`,
  );
  return report.exit;
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
      const { status, exitTier } = await deps.runFlowTrace(layout, asset.id, {
        strictVisual: true,
        projectPathCanonical,
      });
      outcomes.push({
        kind: "trace",
        id: asset.id,
        status,
        exit: exitTier,
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
    // Every trace that reaches this section passed baseline-manifest verification at
    // discovery (unstamped and tampered baselines never become runnable rows), so a
    // section that executed at all compared a frozen anchor.
    anchored: traces.length > 0,
    reportPath: worst.reportPath,
    reportSha256: worst.reportSha256,
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
    note: `${headline}; bound to the run, never human-approved`,
    ...(assets.length > 0 ? { assets } : {}),
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

/** The plan: one line per discovered asset, printed before anything runs. */
export function planLines(
  root: string,
  assets: readonly DiscoveredAsset[],
  notes: readonly string[],
  live: boolean,
): string[] {
  const lines = [
    `${TAG} plan for ${root} (${live ? "offline + live" : "offline only; pass --live for live assets"}):`,
  ];
  for (const asset of assets) {
    lines.push(`${TAG}   ${asset.kind} '${asset.id}': ${disposition(asset, live)}; ${provenance(asset)}`);
  }
  if (assets.length === 0) lines.push(`${TAG}   (no verification assets)`);
  for (const note of notes) lines.push(`${TAG}   note: ${note}`);
  return lines;
}

function disposition(asset: DiscoveredAsset, live: boolean): string {
  if (asset.broken) return `BROKEN, will not run: ${asset.broken}`;
  if (asset.runnable === "no") return `will not run: ${asset.reason ?? "not runnable"}`;
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
  if (asset.approvedAt) return `approved ${asset.approvedAt}${asset.approvedBy ? ` (${asset.approvedBy})` : ""}`;
  if (asset.runnable !== "no" && asset.reason) return `no frozen anchor (${asset.reason})`;
  return "no frozen anchor";
}

/**
 * The on-ramp for a project with nothing to check. The actors are named honestly: the
 * recording session is a HUMAN playing the game, and that play session IS the approval
 * moment. An agent reading this must not be told to perform a step it structurally
 * cannot perform.
 */
export function onRampLines(root: string): string[] {
  return [
    `${TAG} REFUSED: no verification assets found under ${root}, so nothing was checked.`,
    `${TAG} a run that checked nothing is not a pass (exit 2). No report was written.`,
    `${TAG} the cheapest universal anchor is a recorded demonstration, so ask your human to play the game once:`,
    `${TAG}   1. loombridge trace record --observe --id <name>   (a HUMAN plays it; this session IS the approval)`,
    `${TAG}   2. loombridge trace replay --id <name>             (re-drive the demonstration and capture frames)`,
    `${TAG}   3. loombridge trace approve --id <name>            (freeze those frames as the baseline)`,
    `${TAG} then run: loombridge verify --live`,
  ];
}

/** The per-section result lines plus the roll-up of everything that was NOT measured. */
export function summaryLines(report: UnifiedVerifyReport, live: boolean): string[] {
  const lines: string[] = [];
  for (const [name, section] of Object.entries(report.sections)) {
    const detail = section.assets?.length
      ? ` [${section.assets.map((a) => `${a.id}=${a.status}`).join(", ")}]`
      : "";
    const where = section.reportPath ? ` → ${section.reportPath}` : "";
    const qualifier = section.note ? `${section.note}, exit ${section.exit}` : `exit ${section.exit}`;
    // M8: say out loud when an executed section compared no frozen anchor. "pass" and
    // "pass against nothing a human froze" must not print identically.
    const anchor = section.anchored ? "" : " [no frozen anchor compared]";
    lines.push(`${TAG} ${name}: ${section.status} (${qualifier})${detail}${anchor}${where}`);
  }
  if (report.notRun.length > 0) {
    // Name EVERY unmeasured anchor (A6). A partial that exits 0 must still say out loud
    // which anchors it did not measure, or "0" reads as "all clear".
    lines.push(
      `${TAG} NOT MEASURED (never folded into pass): ` +
        report.notRun.map((n) => `${n.kind} '${n.id}' (${n.reason})`).join("; "),
    );
  }
  if (report.status === "nothing-checked") {
    const liveOnly = report.notRun.filter((n) => n.why === "live-only-skipped");
    lines.push(`${TAG} REFUSED: zero assets executed, so nothing was checked (exit 2).`);
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
  }
  return lines;
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
 */
async function reportCollision(
  paths: ReturnType<typeof loombridgePaths>,
  target: string,
): Promise<string | null> {
  const declared: [string, string][] = [
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
    if (path.resolve(artifact) === target) return what;
  }
  // …and the whole directory as a backstop: `.loombridge/tests/` is committed EVIDENCE, so
  // nothing under it is ever a report destination, named file or not.
  const testsDir = path.resolve(paths.tests);
  if (target === testsDir || target.startsWith(`${testsDir}${path.sep}`)) {
    return "is inside the stamped test-results directory";
  }
  // The whole design directory: the frozen hero shot and its metadata live there, and
  // nothing under it is ever a report destination.
  const designDir = path.resolve(paths.design);
  if (target === designDir || target.startsWith(`${designDir}${path.sep}`)) {
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
