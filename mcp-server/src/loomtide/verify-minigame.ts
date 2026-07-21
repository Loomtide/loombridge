/**
 * `loomtide verify --minigame --contract <path> --captures <dir>` (S6c-3).
 *
 * The verify-FIRST entry for a 2D kids mini-game: it grades an EXISTING per-state
 * uGUI capture pack against a product-owned `MinigameContract` using the S6c
 * deterministic gate engine (`runMinigameGates`), writes a JSON report, renders a
 * developer-facing terminal report, and returns an enforcement exit code.
 *
 * Like `verify --profile`, this is a STANDALONE, OFFLINE mode (S6 plan): it never
 * reads `ACCEPTANCE.json`/`SLICES.json`, never writes `STATE.md`, never calls the
 * Unity bridge, and never mutates the game. It reads exactly two inputs (the
 * contract + the capture dir) and writes only its own report artifacts under
 * `.loomtide/reports/` (the JSON record + the S7b human report — HTML + Markdown).
 * Live capture orchestration is NOT this slice.
 *
 * Exit-code contract (the verify-first loop), DERIVED in `minigameReportStatus`
 * (precedence: fail > incomplete > pass):
 *   - pass        → 0   ≥1 substantive check graded green (incl. a flow `pass`)
 *   - fail        → 1   a graded gate `fail` (object missing INSIDE a present
 *                       capture, etc.) OR a flow `game_fail`
 *   - incomplete  → 2   a capture/HARNESS gap — a wholly-absent capture
 *                       (`captureAbsent`), a flow `harness_fault`/`missing_evidence`,
 *                       a missing captures dir / unloadable contract, or nothing
 *                       substantively graded.
 * The S6d separation (CLAUDE.md "Verification / supervisor invariants"): a missing
 * input or a harness fault is NEVER a game defect or a pass — it is `incomplete`,
 * and a harness/capture gap can never be laundered into a green by other passing
 * gates (only a real `fail` outranks it).
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { CheckStatus, GateCheck, GateCheckAnnotation, GateReport, SeamAnnotation } from "../verification/gates/types.js";
import { ICON, tildify } from "./cli-ui.js";
import { loomtidePaths, nowIso } from "./state.js";
import { assertValidMinigameContract } from "./minigame-profiles/validator.js";
import { AGE_BANDS, resolveDevices, VISUAL_PROFILES, type DeviceSpec, type MinigameContract } from "./minigame-profiles/types.js";
import { perDeviceKey } from "./minigame-capture-plan.js";
import {
  CAPTURE_GATE,
  isBackgroundKey,
  OUTCOME_GATED_GATE,
  runMinigameGates,
  type MinigameVerdict,
} from "./minigame-gates/run-minigame-gates.js";
import type { FlowReport } from "./minigame-gates/interaction-flow.js";
import { nextStepLinesFor } from "./minigame-next.js";
import { INPUT_RESPONSE_CHECK, type InputResponseReport } from "./minigame-gates/input-response.js";
import {
  baselineThresholds,
  compareToBaseline,
  resolveBaselineRef,
  type BaselineCompareResult,
  type BaselineThresholds,
} from "./minigame-baseline.js";
import {
  backgroundCandidatesFor,
  backgroundContainerCandidates,
  backgroundSuggestionText,
  bannerFor,
  groupFindingsByDevice,
  harnessFlowSentence,
  humanizeFinding,
  humanizeGrouped,
  partitionBackgroundCandidates,
  prettyCheckSubject,
  prettyId,
  renderMinigameReportHtml,
  renderMinigameReportMarkdown,
} from "./minigame-report-render.js";

/** Derived report status. `incomplete` = nothing was actually graded (exit 2). */
export type MinigameReportStatus = "pass" | "fail" | "incomplete";

/** A device tag carried onto a per-device finding (Phase 4). */
export interface MinigameDeviceTag {
  id: string;
  label: string;
}

/** One failing check, flattened with its (logical) state for the report + terminal. */
export interface MinigameFlatCheck {
  /** The LOGICAL state id (the `@device` suffix stripped, when present). */
  state: string;
  gate: string;
  /** The check id (often encodes the object id, e.g. `required-in-frame.startButton`). */
  id: string;
  expected: string;
  actual: string;
  detail: string;
  /** Optional structured geometry (safe-area rect/insets/overflow) so the report can DRAW it. */
  annotation?: GateCheckAnnotation;
  /** Optional cut-edge seam geometry (background-seam) so the report can draw the exposed edges. */
  seamAnnotation?: SeamAnnotation;
  /** Which device this finding is on (Phase 4). Absent for an old single-aspect pack
   * or a device-invariant gate (the report renders such findings once). */
  device?: MinigameDeviceTag;
}

/**
 * Split a states-map key into its LOGICAL state + optional device id. Phase 4 grades
 * each state at every device under a `<state>@<device>` key; the `@device` suffix is
 * stripped here so per-state wording (and `capturesByState`-keyed lookups) still work.
 * A key with no `@` (a legacy single-aspect pack) yields the bare state, no device.
 */
export function splitStateDevice(key: string): { state: string; deviceId?: string } {
  // Split on the LAST `@`: state ids are validator-guaranteed `@`-free (STATE_ID_PATTERN,
  // Low-1 fix), so the last `@` is the true `<state>@<device>` delimiter — defensive even if
  // a device id ever carried one (device ids are also `@`-free, so this is belt-and-suspenders).
  const at = key.lastIndexOf("@");
  if (at < 0) return { state: key };
  return { state: key.slice(0, at), deviceId: key.slice(at + 1) };
}

export interface MinigameReportSummary {
  /** Declared states the contract asked to grade. */
  statesTotal: number;
  /** States that produced ≥1 applicable (non-not_applicable) check. */
  statesGraded: number;
  /** Every check across every state. */
  checksTotal: number;
  pass: number;
  warn: number;
  fail: number;
  notApplicable: number;
}

/** A single CR-report finding, carrying enough to point a partner at the cause. */
export interface MinigameFinding {
  /** Where the finding came from: a per-state gate, the interaction flow, a missing capture, or a baseline drift. */
  source: "gate" | "flow" | "capture" | "baseline";
  state?: string;
  /** The Unity scene this finding's state belongs to (multi-scene contracts only; from `state.scene`).
   *  Absent for a single-scene contract — the report then renders one flat list, unchanged. Used only
   *  to GROUP the report under each scene; the verdict/exit code stay global (one verdict per game). */
  scene?: string;
  gate?: string;
  id?: string;
  transition?: string;
  expectedState?: string;
  detail: string;
  /** A concrete remedy (game fix, re-capture, …). */
  nextAction?: string;
  /** Optional structured geometry (safe-area rect/insets/overflow) so the report can DRAW it. */
  annotation?: GateCheckAnnotation;
  /** Optional cut-edge seam geometry (background-seam) so the report can draw the exposed edges. */
  seamAnnotation?: SeamAnnotation;
  /** Which device this finding is on (Phase 4). Absent for an old single-aspect pack
   * or a device-invariant gate (flow / console) — those render once. */
  device?: MinigameDeviceTag;
}

/** Per-state capture artifact paths (relative to root when possible). */
export interface MinigameStatePaths {
  uiRects: string;
  console: string;
  png: string;
}

/** The baseline-regression section of the report (S6e). */
export interface MinigameBaselineSection {
  /** Baseline bundle dir, relativized to root when possible. */
  ref: string;
  /** True iff an approved baseline bundle was found. */
  present: boolean;
  /** Advisory note when a baseline is declared but not yet approved (never blocks). */
  note?: string;
  capturedAt?: string;
  masks: string[];
  thresholds: BaselineThresholds;
  /** Per-declared-state comparison outcome. */
  states: Record<
    string,
    {
      compared: boolean;
      regressed: boolean;
      incomplete?: string;
      diffFraction?: number;
      dimensionsMatch?: boolean;
      maxRectDrift?: number;
      driftedObjects?: Array<{ id: string; drift: number }>;
      actual?: string;
      baseline?: string;
    }
  >;
  /** State ids that regressed (→ baseline-regression tier, exit 1). */
  regressions: string[];
  /** State ids whose baseline file was missing/corrupt (→ incomplete). */
  incompleteStates: string[];
}

/**
 * Partner-facing CR grouping (S6f): the same results, sorted into the four buckets
 * a producer/QA/engineer reads — what BLOCKS release, what wasn't honestly tested
 * (harness/capture, NOT a game defect), what passed, and what was not graded by design.
 */
export interface MinigameCrReport {
  /** Game defects that BLOCK release — deterministic gate fails + flow game_fail (→ exit 1). */
  blockingFailures: MinigameFinding[];
  /** Baseline regressions (S6e) — drift beyond threshold vs the approved baseline. Its OWN tier:
   * blocks release (→ exit 1) but is NOT a game defect and NOT a harness/capture gap. */
  baselineRegressions: MinigameFinding[];
  /** Capture/harness gaps — NOT game defects — captureAbsent + flow harness_fault/missing_evidence (→ exit 2). */
  incompleteHarness: MinigameFinding[];
  /** Soft issues (graded `warn` checks). No minigame gate emits `warn` today; included so a
   * `warn` is never invisible (and under `--strict` a `warn` forces fail — surfaced here, not silent). */
  warnings: MinigameFinding[];
  /** Gates that passed, grouped by state. */
  passedGates: Record<string, string[]>;
  /** Not-graded-by-design notes (vacuous not_applicable; advisory/VLM is NOT run this slice). */
  advisoryNotes: MinigameFinding[];
  /**
   * NOT ASSERTED — OUTCOME-GATED: states/transitions a read-only verifier can't drive
   * (a win/reward on a non-deterministic game). Its OWN tier — neither pass nor fail nor a
   * capture gap; never blocks the exit code. Surfaced so "we did not assert this" is loud,
   * not silent (mirrors the project's honest-or-stop discipline).
   */
  notAssertedOutcomeGated: MinigameFinding[];
}

export interface MinigameVerifyReport {
  kind: "minigame-verification";
  schemaVersion: "1";
  producedAt: string;
  contract: {
    id: string;
    title: string | null;
    type: string;
    ageBand: string;
    ageBandLabel: string | null;
    visualProfile: string;
    visualProfileLabel: string | null;
    scenes: string[];
    /** Bound required-control scene paths (scene prefix stripped: `/Canvas/...`). The report uses
     * these to keep the safeAreaBackground suggestion from proposing a container that would exempt
     * a real control, and to keep a bound control's sweep finding out of the "likely background" bucket. */
    requiredLocators: string[];
  };
  /** The capture dir graded, relative to root when possible. */
  capturesDir: string;
  status: MinigameReportStatus;
  /** Per-state gate reports, keyed by contract state id (verbatim from the engine). */
  states: Record<string, GateReport[]>;
  /** Per-state, per-gate verdict roll-up for a compact view of what graded. */
  gatesByState: Record<string, Record<string, CheckStatus>>;
  summary: MinigameReportSummary;
  /** Every failing check, flattened with its state + object id. */
  failures: MinigameFlatCheck[];
  /** Every not_applicable check + its reason (so a skipped check is never silent). */
  notApplicable: MinigameFlatCheck[];
  /** State ids whose capture file was absent/unreadable — incomplete, NOT a game defect (S6d). */
  captureAbsent: string[];
  /** State ids declared `outcomeGated` — NOT asserted by design (read-only can't drive the outcome). */
  outcomeGated: string[];
  /** The interaction-flow verdict (S6d), present only when `interaction-flow` is enabled. */
  flow?: FlowReport;
  /** The input-response (liveness) verdict (slice 3), present only when `input-response` is enabled. */
  inputResponse?: InputResponseReport;
  /** The baseline-regression comparison (S6e), present only when the contract declares `baseline.ref`. */
  baseline?: MinigameBaselineSection;
  /** Partner-facing CR grouping of the results (S6f). */
  cr: MinigameCrReport;
  /** Per-declared-state capture artifact paths, relative to root when possible (S6f). */
  statePaths: Record<string, MinigameStatePaths>;
  /** Device id → display label for the devices graded (Phase 4) — lets the renderer
   * caption per-device screens/findings without re-resolving the contract. */
  deviceLabels: Record<string, string>;
  headline: string;
  nextAction: string;
}

/**
 * Flatten one state's reports into per-check rows carrying the LOGICAL state id (the
 * `@device` suffix stripped) and, when the key was a `<state>@<device>` per-device
 * report, a `device` tag (Phase 4). `deviceLabels` maps a device id → its display
 * label; an absent map (or an unknown id) just yields the bare id as the label.
 */
function flatten(
  states: Record<string, GateReport[]>,
  deviceLabels?: Map<string, string>,
): Array<MinigameFlatCheck & { status: CheckStatus }> {
  const rows: Array<MinigameFlatCheck & { status: CheckStatus }> = [];
  for (const [key, reports] of Object.entries(states)) {
    const { state, deviceId } = splitStateDevice(key);
    const device: MinigameDeviceTag | undefined = deviceId
      ? { id: deviceId, label: deviceLabels?.get(deviceId) ?? deviceId }
      : undefined;
    for (const report of reports) {
      for (const c of report.checks) {
        rows.push({
          state,
          gate: report.gate,
          id: c.id,
          expected: c.expected,
          actual: c.actual,
          detail: c.detail,
          annotation: c.annotation,
          seamAnnotation: c.seamAnnotation,
          device,
          status: c.status,
        });
      }
    }
  }
  return rows;
}

/** Build the device id → label lookup for a contract (Phase 4 finding tags). */
function deviceLabelMap(contract: MinigameContract): Map<string, string> {
  return new Map(resolveDevices(contract).map((d: DeviceSpec) => [d.id, d.label]));
}

/**
 * Derive the report status from the graded checks. PURE + exported so the
 * exit-code contract is exhaustively unit-tested without a fixture.
 *
 * Honest-status rule (precedence: fail > incomplete > pass):
 *   - FAIL: any graded `fail` (an object missing INSIDE a present capture, etc.),
 *     any flow `game_fail`, or a graded `warn` under `--strict`.
 *   - INCOMPLETE: a `captureAbsent` state (wholly-missing capture — a capture/HARNESS
 *     gap, S6d), a flow `harness_fault`/`missing_evidence`, OR nothing substantively
 *     graded (every per-state check vacuous AND no flow pass).
 *   - PASS: otherwise.
 *
 * The load-bearing S6d rule: a `harness_fault` or any `captureAbsent` **forces
 * `incomplete` even when every per-state gate passes** — a harness/capture fault can
 * never be laundered into a green by other passing checks (only a real `fail`
 * outranks it). A "graded pass" still reflects a REAL check: (1) the object-scoped
 * evaluators emit `not_applicable` (not a vacuous `pass`) when they find nothing to
 * grade; (2) the validator refuses an object-scoped check that binds no object
 * (`OBJECT_CHECK_NO_BINDINGS`); and a missing capture is incomplete, never green.
 */
export function minigameReportStatus(
  states: Record<string, GateReport[]>,
  opts: {
    strict: boolean;
    captureAbsent?: string[];
    flow?: FlowReport;
    /** State ids that drifted from the approved baseline (S6e) — a regression is a FAIL. */
    regressions?: string[];
    /** State ids whose BASELINE file was missing/corrupt — can't compare (→ incomplete, S6e). */
    baselineIncomplete?: string[];
    /** The input-response (liveness) verdict (slice 3) — game_fail → fail, missing → incomplete. */
    inputResponse?: InputResponseReport;
    /** States that collapse sequential sub-screens (G8) — can't be verified as one frame → incomplete. */
    sequentialStates?: string[];
  },
): MinigameReportStatus {
  const captureAbsent = opts.captureAbsent ?? [];
  const sequentialStates = opts.sequentialStates ?? [];
  const regressions = opts.regressions ?? [];
  const baselineIncomplete = opts.baselineIncomplete ?? [];
  const flowOutcome = opts.flow?.outcome;
  const responseOutcome = opts.inputResponse?.outcome;
  const graded = flatten(states).filter((r) => r.status !== "not_applicable");

  // FAIL dominates — a real game/gate defect (a flow game failure, an inert control that
  // didn't respond to input) OR a baseline regression (S6e). A regression is computed from
  // PRESENT captures, so it is real even if the flow had a harness fault — `fail` correctly
  // outranks the harness `incomplete`.
  if (
    graded.some((r) => r.status === "fail") ||
    flowOutcome === "game_fail" ||
    responseOutcome === "game_fail" ||
    regressions.length > 0
  ) {
    return "fail";
  }
  if (opts.strict && graded.some((r) => r.status === "warn")) return "fail";

  // INCOMPLETE-forcing — a capture/harness gap (or a baseline file we couldn't read) can
  // never be laundered into a green by other passing gates; it dominates `pass` (only
  // `fail` outranks it).
  if (
    captureAbsent.length > 0 ||
    baselineIncomplete.length > 0 ||
    sequentialStates.length > 0 ||
    flowOutcome === "harness_fault" ||
    flowOutcome === "missing_evidence" ||
    responseOutcome === "missing_evidence"
  ) {
    return "incomplete";
  }

  // Nothing substantively graded (all per-state checks vacuous AND no flow/response pass).
  const substantive = graded.length > 0 || flowOutcome === "pass" || responseOutcome === "pass";
  if (!substantive) return "incomplete";

  return "pass";
}

/** Map the derived status to the enforcement exit code. PURE + exported. */
export function exitCodeForMinigame(status: MinigameReportStatus): number {
  if (status === "fail") return 1;
  if (status === "incomplete") return 2;
  return 0;
}

export function summarize(states: Record<string, GateReport[]>): MinigameReportSummary {
  const rows = flatten(states);
  // Count LOGICAL states, not `<state>@<device>` keys: Phase 4 multiplies the check
  // count per device, but "2 of 4 screens" must stay meaningful — derive the screen
  // counts by stripping the `@device` suffix. Phase 5: the background-coverage gate is a
  // FRAME-LEVEL per-device check keyed under a reserved sentinel, NOT a screen — exclude
  // it from the screen counts (its checks still count toward checksTotal/pass/fail below).
  const logicalStates = new Set(
    Object.keys(states).filter((k) => !isBackgroundKey(k)).map((k) => splitStateDevice(k).state),
  );
  const gradedLogical = new Set<string>();
  for (const [key, reports] of Object.entries(states)) {
    if (isBackgroundKey(key)) continue;
    if (reports.some((r) => r.checks.some((c) => c.status !== "not_applicable"))) {
      gradedLogical.add(splitStateDevice(key).state);
    }
  }
  return {
    statesTotal: logicalStates.size,
    statesGraded: gradedLogical.size,
    checksTotal: rows.length,
    pass: rows.filter((r) => r.status === "pass").length,
    warn: rows.filter((r) => r.status === "warn").length,
    fail: rows.filter((r) => r.status === "fail").length,
    notApplicable: rows.filter((r) => r.status === "not_applicable").length,
  };
}

function gatesByState(states: Record<string, GateReport[]>): Record<string, Record<string, CheckStatus>> {
  const out: Record<string, Record<string, CheckStatus>> = {};
  for (const [state, reports] of Object.entries(states)) {
    out[state] = {};
    for (const report of reports) out[state][report.gate] = report.verdict;
  }
  return out;
}

/**
 * Sort the results into the partner-facing CR buckets (S6f). PURE + exported so the
 * grouping is unit-tested without a fixture. Crucially, a capture/harness gap is
 * kept OUT of `blockingFailures` and labelled as NOT a game defect — the same
 * harness-vs-game separation the exit code already enforces.
 */
export function buildCrGroups(
  states: Record<string, GateReport[]>,
  failures: MinigameFlatCheck[],
  notApplicable: MinigameFlatCheck[],
  captureAbsent: string[],
  flow: FlowReport | undefined,
  /** Baseline-regression findings + baseline-incomplete findings (S6e), when a baseline ran. */
  baseline?: { regressions: MinigameFinding[]; incomplete: MinigameFinding[] },
  /** State ids declared `outcomeGated` — surfaced in their own NOT-ASSERTED tier. */
  outcomeGated: string[] = [],
  /** The input-response (liveness) verdict — its game_fail blocks, missing is a capture gap. */
  inputResponse?: InputResponseReport,
  /** Device id → label, so a per-device warning/capture-gap finding carries its device tag. */
  deviceLabels?: Map<string, string>,
  /** The gameplay state id the seam gate's annotation draws on (`<state>@<device>` screenshot). */
  gameplayStateId?: string,
): MinigameCrReport {
  const deviceFor = (deviceId: string | undefined): MinigameDeviceTag | undefined =>
    deviceId ? { id: deviceId, label: deviceLabels?.get(deviceId) ?? deviceId } : undefined;

  // 1. BLOCKING — deterministic gate fails (object-level defects) + flow game_fail +
  // an input-response game_fail (a gameplay control that didn't respond — a real defect).
  // Each gate finding carries the failing state's `device` tag (Phase 4) so the report
  // can name WHICH device the defect is on.
  const blockingFailures: MinigameFinding[] = failures.map((f) => ({
    source: "gate" as const,
    state: f.state,
    gate: f.gate,
    id: f.id,
    detail: f.detail,
    annotation: f.annotation,
    // Resolve the seam gate's screenshot to draw on (it has no screen of its own): the
    // gameplay state's `<state>@<device>` thumbnail. No gameplay screen → leave it undefined
    // (the renderer falls back to a plain card).
    seamAnnotation:
      f.gate === "background-seam" && f.seamAnnotation
        ? {
            ...f.seamAnnotation,
            ...(gameplayStateId && f.device
              ? { screenshotKey: `${gameplayStateId}@${f.device.id}` }
              : {}),
          }
        : f.seamAnnotation,
    device: f.device,
  }));
  for (const s of inputResponse?.states ?? []) {
    if (s.status === "game_fail") {
      blockingFailures.push({ source: "gate", state: s.state, gate: INPUT_RESPONSE_CHECK, id: `${INPUT_RESPONSE_CHECK}.${s.state}`, detail: s.detail, nextAction: s.nextAction });
    }
  }
  for (const t of flow?.transitions ?? []) {
    if (t.status === "game_fail") {
      blockingFailures.push({ source: "flow", transition: t.transition, expectedState: t.expectedState, detail: t.detail, nextAction: t.nextAction });
    }
  }

  // 1b. BASELINE REGRESSIONS (S6e) — drift vs the approved baseline. Its own tier:
  // blocks (exit 1) but is NEITHER a game defect NOR a harness/capture gap.
  const baselineRegressions: MinigameFinding[] = baseline?.regressions ?? [];

  // 2. INCOMPLETE / HARNESS — capture/harness gaps (incl. an unreadable baseline file); NEVER game defects.
  // A `captureAbsent` entry may be a per-device `<state>@<device>` key (Phase 4): split it
  // into the logical state + device tag, and name the `<state>@<device>` stem in the remedy.
  const incompleteHarness: MinigameFinding[] = captureAbsent.map((key) => {
    const { state, deviceId } = splitStateDevice(key);
    return {
      source: "capture" as const,
      state,
      device: deviceFor(deviceId),
      detail: `Capture for '${key}' is absent/unreadable: a capture/harness gap, NOT a game defect.`,
      nextAction: `Re-capture '${key}' (write ${key}.ui-rects.json / ${key}.png) and re-run.`,
    };
  });
  for (const t of flow?.transitions ?? []) {
    if (t.status === "harness_fault" || t.status === "missing_evidence") {
      incompleteHarness.push({ source: "flow", transition: t.transition, expectedState: t.expectedState, detail: t.detail, nextAction: t.nextAction });
    }
  }
  for (const s of inputResponse?.states ?? []) {
    if (s.status === "missing_evidence") {
      incompleteHarness.push({ source: "gate", state: s.state, gate: INPUT_RESPONSE_CHECK, id: `${INPUT_RESPONSE_CHECK}.${s.state}`, detail: s.detail, nextAction: s.nextAction });
    }
  }
  incompleteHarness.push(...(baseline?.incomplete ?? []));

  // 3. WARNINGS — graded `warn` checks (so a `warn` is never invisible; under --strict it
  // forces fail, surfaced here rather than as a "fails with nothing shown" report).
  const warnings: MinigameFinding[] = flatten(states, deviceLabels)
    .filter((r) => r.status === "warn")
    .map((r) => ({ source: "gate" as const, state: r.state, gate: r.gate, id: r.id, detail: r.detail, device: r.device }));

  // 4. PASSED — gates whose verdict is pass, grouped by state. The frame-level
  // background-coverage gate is keyed under the reserved `<KEY>@<device>` sentinel (not a
  // screen) — relabel it "Background coverage · <device>" so the Passed list reads cleanly
  // and never surfaces the raw sentinel.
  const passedGates: Record<string, string[]> = {};
  for (const [key, reports] of Object.entries(states)) {
    const passed = reports.filter((r) => r.verdict === "pass").map((r) => r.gate);
    if (passed.length === 0) continue;
    if (isBackgroundKey(key)) {
      const { deviceId } = splitStateDevice(key);
      const dev = deviceId ? deviceLabels?.get(deviceId) ?? deviceId : undefined;
      passedGates[`Background coverage${dev ? ` · ${dev}` : ""}`] = passed;
    } else {
      passedGates[key] = passed;
    }
  }

  // 5. NOT ASSERTED — OUTCOME-GATED: declared `outcomeGated` states + flow transitions
  // that reach them. Its own tier; never a blocker, never a capture gap.
  const notAssertedOutcomeGated: MinigameFinding[] = outcomeGated.map((state) => ({
    source: "gate" as const,
    state,
    detail: `'${state}' is outcome-gated: a read-only verifier can't drive its outcome (no RNG seed / no game change). Not asserted by design; the verifiable screens are graded normally.`,
    nextAction: `Leave \`outcomeGated\` set while reaching '${state}' depends on game outcome. Verify the deterministic envelope (start/active) instead.`,
  }));
  for (const t of flow?.transitions ?? []) {
    if (t.status === "outcome_gated") {
      notAssertedOutcomeGated.push({ source: "flow", transition: t.transition, expectedState: t.expectedState, detail: t.detail, nextAction: t.nextAction });
    }
  }

  // 6. ADVISORY / NOT-APPLICABLE — not graded by design (vacuous n/a). The capture-absent
  // `minigame-capture` and outcome-gated `minigame-outcome-gated` markers are surfaced in
  // their own tiers, not here.
  const advisoryNotes: MinigameFinding[] = notApplicable
    .filter((n) => n.gate !== CAPTURE_GATE && n.gate !== OUTCOME_GATED_GATE)
    .map((n) => ({ source: "gate" as const, state: n.state, gate: n.gate, id: n.id, detail: n.detail, device: n.device }));

  return { blockingFailures, baselineRegressions, incompleteHarness, warnings, passedGates, advisoryNotes, notAssertedOutcomeGated };
}

/**
 * Stamp each finding with the scene of the state it belongs to (multi-scene contracts), so the report
 * can group findings under each scene (D6). PURE + exported. Single source of truth instead of editing
 * every finding-construction site: a flow finding's scene comes from its `expectedState`, every other
 * from its `state`. `stateScene` carries only states that DECLARE a scene — for a single-scene contract
 * it is empty, so every finding stays scene-less and the report renders exactly as before (back-compat).
 */
export function stampFindingScenes(cr: MinigameCrReport, stateScene: ReadonlyMap<string, string>): MinigameCrReport {
  if (stateScene.size === 0) return cr; // single-scene: no-op, byte-identical report
  const sceneOf = (f: MinigameFinding): string | undefined => {
    const stateId = f.state ?? f.expectedState;
    const scene = stateId ? stateScene.get(stateId) : undefined;
    return scene ?? f.scene;
  };
  const stamp = (findings: MinigameFinding[]): MinigameFinding[] =>
    findings.map((f) => {
      const scene = sceneOf(f);
      return scene === undefined ? f : { ...f, scene };
    });
  return {
    ...cr,
    blockingFailures: stamp(cr.blockingFailures),
    baselineRegressions: stamp(cr.baselineRegressions),
    incompleteHarness: stamp(cr.incompleteHarness),
    warnings: stamp(cr.warnings),
    advisoryNotes: stamp(cr.advisoryNotes),
    notAssertedOutcomeGated: stamp(cr.notAssertedOutcomeGated),
  };
}

/**
 * The contract state the seam gate's annotation should DRAW on — the seam gate is
 * frame-level (it has no screen of its own), so we pick a representative GAMEPLAY screen:
 * the first `kind:"active"` state, else the first `kind:"start"` state, else the first
 * non-outcome-gated state. The caller pairs this with the finding's device id to form the
 * `<state>@<device>` thumbnail key. Undefined when no usable gameplay state exists.
 */
export function gameplayStateIdFor(contract: MinigameContract): string | undefined {
  const active = contract.states.find((s) => s.kind === "active" && s.outcomeGated !== true);
  if (active) return active.id;
  const start = contract.states.find((s) => s.kind === "start" && s.outcomeGated !== true);
  if (start) return start.id;
  return contract.states.find((s) => s.outcomeGated !== true)?.id;
}

/** Path relative to `root` when it stays under it; otherwise the absolute path (no `..` leak). */
function relPathUnderRoot(root: string, abs: string): string {
  const r = path.relative(root, abs);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : abs;
}

/**
 * Per-declared-state capture artifact paths, relativized to root when possible.
 *
 * Phase 4: adds per-device entries keyed `<state>@<device>` (→ `<state>@<device>.png`
 * / `.ui-rects.json`; console stays base-only, so it reuses `<state>.console.json`)
 * AND keeps the legacy `<state>` entries. The report renderer/thumbnails use both —
 * the per-device entries back the per-device annotated cards + gallery, the legacy
 * entries back an old single-aspect pack.
 */
function buildStatePaths(
  contract: MinigameContract,
  root: string,
  capturesDirAbs: string,
): Record<string, MinigameStatePaths> {
  const rel = (stem: string, suffix: string): string =>
    relPathUnderRoot(root, path.join(capturesDirAbs, `${stem}.${suffix}`));
  const out: Record<string, MinigameStatePaths> = {};
  const devices = resolveDevices(contract);
  for (const s of contract.states) {
    // Legacy base entry (an old single-aspect pack, and the device-invariant console).
    out[s.id] = { uiRects: rel(s.id, "ui-rects.json"), console: rel(s.id, "console.json"), png: rel(s.id, "png") };
    // Per-device entries — console is base-only, so reuse `<state>.console.json`.
    for (const d of devices) {
      const key = perDeviceKey(s.id, d.id);
      out[key] = { uiRects: rel(key, "ui-rects.json"), console: rel(s.id, "console.json"), png: rel(key, "png") };
    }
  }
  return out;
}

/**
 * Read each declared state's `<state>.png` from the captures dir and return a map
 * of state id → inline `data:image/png;base64,…` URI, for the self-contained HTML
 * report (S7b). A missing/unreadable PNG is silently omitted (a state with no usable
 * capture is already surfaced as a capture gap in the report — never a render error).
 */
async function readStateThumbnails(
  capturesDirAbs: string,
  report: MinigameVerifyReport,
): Promise<Record<string, string>> {
  const thumbs: Record<string, string> = {};
  await Promise.all(
    Object.keys(report.statePaths).map(async (stateId) => {
      try {
        const buf = await fs.readFile(path.join(capturesDirAbs, `${stateId}.png`));
        thumbs[stateId] = `data:image/png;base64,${buf.toString("base64")}`;
      } catch {
        // No usable PNG for this state — omit; the report already flags it.
      }
    }),
  );
  return thumbs;
}

/** Build the report `baseline` section + the CR baseline findings from a compare result (S6e). */
function buildBaselineSection(
  result: BaselineCompareResult,
  root: string,
  capturesDirAbs: string,
): { section: MinigameBaselineSection; regressions: MinigameFinding[]; incomplete: MinigameFinding[] } {
  const states: MinigameBaselineSection["states"] = {};
  const regressions: MinigameFinding[] = [];
  const incomplete: MinigameFinding[] = [];
  const reApprove = "if the change is intended, re-approve the baseline with `loomtide minigame baseline approve`";

  for (const st of result.states) {
    const driftBits: string[] = [];
    if (st.diffFraction !== undefined) driftBits.push(`pixel diff ${(st.diffFraction * 100).toFixed(2)}% (max ${(result.thresholds.maxBaselineDiffFraction * 100).toFixed(2)}%)`);
    if (st.maxRectDrift) driftBits.push(`rect drift ${(st.maxRectDrift * 100).toFixed(2)}% (max ${(result.thresholds.maxRectDriftFraction * 100).toFixed(2)}%)`);
    states[st.state] = {
      compared: st.compared,
      regressed: st.regressed,
      incomplete: st.incomplete,
      diffFraction: st.diffFraction,
      dimensionsMatch: st.dimensionsMatch,
      maxRectDrift: st.maxRectDrift,
      driftedObjects: st.driftedObjects,
      actual: relPathUnderRoot(root, path.join(capturesDirAbs, `${st.state}.png`)),
      baseline: relPathUnderRoot(root, path.join(result.ref, `${st.state}.png`)),
    };
    if (st.regressed) {
      const objs = st.driftedObjects && st.driftedObjects.length > 0 ? ` (moved: ${listIds(st.driftedObjects.map((o) => o.id))})` : "";
      regressions.push({
        source: "baseline",
        state: st.state,
        detail: `State '${st.state}' drifted from the approved baseline: ${driftBits.join(", ") || "drift"}${objs}. A baseline regression is NOT a game defect; ${reApprove}.`,
        nextAction: `Review the visual change to '${st.state}'; ${reApprove}.`,
      });
    } else if (!st.compared && result.incompleteStates.includes(st.state)) {
      incomplete.push({
        source: "baseline",
        state: st.state,
        detail: st.incomplete ?? `Baseline for '${st.state}' could not be read: cannot compare.`,
        nextAction: `Re-approve the baseline so '${st.state}' has a reference (\`loomtide minigame baseline approve\`).`,
      });
    }
  }

  const section: MinigameBaselineSection = {
    ref: relPathUnderRoot(root, result.ref),
    present: result.present,
    note: result.note,
    capturedAt: result.capturedAt,
    masks: result.masks,
    thresholds: result.thresholds,
    states,
    regressions: result.regressions,
    incompleteStates: result.incompleteStates,
  };
  return { section, regressions, incomplete };
}

/** Cap a list of ids for a one-line message. */
function listIds(ids: string[], cap = 4): string {
  const unique = [...new Set(ids)];
  if (unique.length <= cap) return unique.join(", ");
  return `${unique.slice(0, cap).join(", ")} +${unique.length - cap} more`;
}

interface FlowContext {
  captureAbsent: string[];
  flow?: FlowReport;
  /** State ids that regressed vs the approved baseline (S6e). */
  regressions?: string[];
  /** State ids declared `outcomeGated` — not asserted by design (read-only). */
  outcomeGated?: string[];
}

function headlineFor(
  status: MinigameReportStatus,
  summary: MinigameReportSummary,
  failures: MinigameFlatCheck[],
  title: string,
  ctx: FlowContext,
): string {
  const flow = ctx.flow;
  if (status === "incomplete") {
    // Most-specific harness/capture wording first — NEVER imply a game result.
    if (flow?.outcome === "harness_fault") {
      const t = flow.transitions.find((x) => x.status === "harness_fault");
      return `${title}: HARNESS FAULT on ${t?.transition ?? "the interaction flow"}. The game was NOT honestly tested (not a game defect).`;
    }
    if (ctx.captureAbsent.length > 0) {
      return `${title}: capture absent for ${listIds(ctx.captureAbsent)}. Incomplete (capture/harness gap, not a game result).`;
    }
    if (flow?.outcome === "missing_evidence") {
      return `${title}: interaction-flow evidence missing. Incomplete (not a game result).`;
    }
    if (summary.statesTotal === 0) return `Nothing graded for ${title}: the contract declares no states.`;
    return `Nothing graded for ${title}: every check was not-applicable (no gradeable captures/checks).`;
  }
  if (status === "fail") {
    const parts: string[] = [];
    if (flow?.outcome === "game_fail") {
      const t = flow.transitions.find((x) => x.status === "game_fail");
      parts.push(`interaction flow failed on ${t?.transition ?? "?"} (game did not reach '${t?.expectedState ?? "?"}')`);
    }
    if (failures.length > 0) {
      const failedStates = [...new Set(failures.map((f) => f.state))];
      parts.push(`${summary.fail} check(s) failed across ${failedStates.length} state(s) (${listIds(failedStates)})`);
    }
    const regressions = ctx.regressions ?? [];
    if (regressions.length > 0) {
      parts.push(`baseline regression on ${regressions.length} state(s) (${listIds(regressions)}), NOT a game defect`);
    }
    return `${title}: ${parts.join("; ")}.`;
  }
  const flowNote = flow?.outcome === "pass" ? `; interaction flow pass (${flow.transitions.length} transition(s))` : "";
  const gated = ctx.outcomeGated ?? [];
  const gatedNote = gated.length > 0
    ? `; ${listIds(gated.map(prettyId))} not asserted (outcome-gated: read-only can't drive the outcome)`
    : "";
  return `${title}: all ${summary.pass} graded check(s) pass across ${summary.statesGraded} state(s)${flowNote}${gatedNote}.`;
}

/** The safe-area-sweep gate name (local mirror of the evaluator's `gate` literal). */
const SAFE_AREA_SWEEP_GATE = "safe-area-sweep";

export function nextActionFor(
  status: MinigameReportStatus,
  blockingFailures: MinigameFinding[],
  notApplicable: MinigameFlatCheck[],
  ctx: FlowContext,
  requiredLocators: string[] = [],
): string {
  const flow = ctx.flow;
  if (status === "incomplete") {
    // Prefer the gate's own class-specific remedy — it points at the harness, never the game.
    if (flow && (flow.outcome === "harness_fault" || flow.outcome === "missing_evidence")) {
      const t = flow.transitions.find((x) => x.status === flow.outcome);
      if (t) return t.nextAction;
    }
    if (ctx.captureAbsent.length > 0) {
      return `Capture the missing screen(s): ${listIds(ctx.captureAbsent.map(prettyId))} (write <screen>.ui-rects.json / .console.json / .png) and re-run. A missing capture is not a game result.`;
    }
    return notApplicable.length > 0
      ? `Re-capture the screens so the enabled checks can grade; currently nothing is gradeable on ${listIds([...new Set(notApplicable.map((n) => prettyId(n.state)))])}.`
      : "Capture the contract's screens (write <screen>.ui-rects.json / <screen>.console.json / <screen>.png into the captures dir) and re-run.";
  }
  if (status === "fail") {
    const parts: string[] = [];
    if (flow?.outcome === "game_fail") {
      const t = flow.transitions.find((x) => x.status === "game_fail");
      if (t) parts.push(t.nextAction);
    }
    // Split + group the SAME way the report sections do, so the "fix" list counts grouped DISTINCT
    // issues (not raw per-device/per-screen checks) and lists only the real must-fix HUD controls —
    // the likely-background decoration goes to the declare suggestion below, never "fix".
    const sweepPaths = blockingFailures
      .filter((f) => f.source === "gate" && f.gate === SAFE_AREA_SWEEP_GATE)
      .map((f) => f.annotation?.locator)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    const bgCandidates = backgroundContainerCandidates(sweepPaths, requiredLocators);
    const { mustFix } = partitionBackgroundCandidates(blockingFailures, bgCandidates);
    const mustFixObjects = mustFix.filter((f) => f.source === "gate" && f.gate !== CAPTURE_GATE);
    if (mustFixObjects.length > 0) {
      // Speak in product names (the offending control, or the screen for a frame-level check) —
      // never the raw `<screen>/<gate>.<id>`; the precise ids live in the report. Group first so a
      // control flagged across N device aspects (and both screens) counts once.
      const subjects = [
        ...new Set(
          groupFindingsByDevice(mustFixObjects).map(
            (g) => prettyCheckSubject(g.finding.gate, g.finding.id) ?? prettyId(g.finding.state ?? ""),
          ),
        ),
      ];
      parts.push(
        `fix ${listIds(subjects)} (see the report for the exact screen + check), then re-capture and re-run \`loomtide verify --minigame\``,
      );
    }
    const regressions = ctx.regressions ?? [];
    if (regressions.length > 0) {
      parts.push(
        `review the baseline drift on ${listIds(regressions.map(prettyId))}; if intended, re-approve with \`loomtide minigame baseline approve\` (a regression is not a game defect)`,
      );
    }
    // Advisory only (Phase 2): if the safe-area-sweep flagged a wall of elements and we found
    // candidate background containers, suggest declaring them — never exempts, never the verdict.
    if (bgCandidates.length > 0) {
      parts.push(backgroundSuggestionText(bgCandidates));
    }
    return parts.length > 0 ? `${parts.join("; ")}.` : "Fix the reported failure(s), then re-capture and re-run `loomtide verify --minigame`.";
  }
  const gated = ctx.outcomeGated ?? [];
  if (gated.length > 0) {
    return `Deterministic gates pass for the verifiable envelope. ${listIds(gated.map(prettyId))} is outcome-gated, not asserted, because a read-only verifier can't drive the outcome (no RNG seed / no game change); that is by design, not a gap. Re-run after any UI change.`;
  }
  return "Deterministic gates pass. Re-run after any UI change; layer the advisory VLM review for semantic/age-appropriateness sign-off.";
}

export interface VerifyMinigameArgs {
  /** Project root (used only to relativize paths + legacy default report location). */
  root: string;
  /** Path to the mini-game contract JSON. */
  contractPath: string;
  /** Directory of per-state `<state>.ui-rects.json` / `.console.json` / `.png` captures. */
  capturesDir: string;
  /** Optional report output path. Guided flows pass `<workspace>/reports/minigame-verification.json`. */
  outputPath?: string;
  /** Treat a graded `warn` as a hard failure (require all-green). */
  strict: boolean;
  /** Print the full per-finding breakdown in the terminal (default: slim — the detail lives in the report). */
  verbose?: boolean;
  /** Suppress the resolved single-next-step footer (the `run`/`check` wrapper owns that line). */
  quietNext?: boolean;
  /** Override the baseline bundle dir (default: the contract's `baseline.ref`, S6e). */
  baselineRefOverride?: string;
}

/**
 * Build the report from an already-loaded contract + the captures dir. Pure aside
 * from the capture-dir reads inside `runMinigameGates`. Exported for tests.
 */
export async function buildMinigameReport(
  contract: MinigameContract,
  args: VerifyMinigameArgs,
): Promise<MinigameVerifyReport> {
  const verdict: MinigameVerdict = await runMinigameGates(contract, args.capturesDir);

  // S6e baseline regression — only when the contract declares a baseline.ref. A
  // declared-but-unapproved baseline returns `present:false` (advisory note, no
  // regression). The compare reads PRESENT captures, so a regression is real even
  // alongside a harness fault.
  let baselineSection: MinigameBaselineSection | undefined;
  let baselineFindings: { regressions: MinigameFinding[]; incomplete: MinigameFinding[] } | undefined;
  let regressions: string[] = [];
  let baselineIncomplete: string[] = [];
  const refDir = resolveBaselineRef(contract, args.root, args.baselineRefOverride);
  if (refDir) {
    const result = await compareToBaseline(contract, args.capturesDir, refDir, baselineThresholds(contract));
    const built = buildBaselineSection(result, args.root, args.capturesDir);
    baselineSection = built.section;
    baselineFindings = { regressions: built.regressions, incomplete: built.incomplete };
    regressions = result.regressions;
    baselineIncomplete = result.incompleteStates;
  }

  const ctx: FlowContext = { captureAbsent: verdict.captureAbsent, flow: verdict.flow, regressions, outcomeGated: verdict.outcomeGated };
  const status = minigameReportStatus(verdict.states, {
    strict: args.strict,
    captureAbsent: verdict.captureAbsent,
    flow: verdict.flow,
    regressions,
    baselineIncomplete,
    inputResponse: verdict.inputResponse,
    sequentialStates: verdict.sequentialStates,
  });
  const summary = summarize(verdict.states);

  // Phase 4: tag each flattened row with the device it was graded on (the `@device`
  // suffix of its states-map key), so a per-device fail names WHICH device.
  const deviceLabels = deviceLabelMap(contract);
  const rows = flatten(verdict.states, deviceLabels);
  const failures: MinigameFlatCheck[] = rows
    .filter((r) => r.status === "fail")
    .map(({ status: _s, ...rest }) => rest);
  const notApplicable: MinigameFlatCheck[] = rows
    .filter((r) => r.status === "not_applicable")
    .map(({ status: _s, ...rest }) => rest);

  const title = contract.title ?? contract.id;
  const capturesDir = relPathUnderRoot(args.root, args.capturesDir);
  // Bound required-control paths, scene-prefix stripped, so they compare to the sweep's
  // unprefixed `/Canvas/...` paths — used to keep the background suggestion from proposing a
  // container that exempts a real control (and to keep its sweep finding out of "likely background").
  const requiredLocators = contract.requiredInFrame.map((o) =>
    o.locator.includes(":") ? o.locator.slice(o.locator.indexOf(":") + 1) : o.locator,
  );

  // Built once so the next-action can speak in the SAME grouped/split units as the report sections
  // (must-fix vs likely-background, per-device duplicates collapsed) rather than raw per-device checks.
  // Map state id → scene (multi-scene contracts only) so findings can be grouped under each scene (D6).
  // Empty for a single-scene contract ⇒ `stampFindingScenes` is a no-op and the report is unchanged.
  const stateScene = new Map<string, string>();
  for (const s of contract.states) if (s.scene) stateScene.set(s.id, s.scene);
  const cr = stampFindingScenes(
    buildCrGroups(verdict.states, failures, notApplicable, verdict.captureAbsent, verdict.flow, baselineFindings, verdict.outcomeGated, verdict.inputResponse, deviceLabels, gameplayStateIdFor(contract)),
    stateScene,
  );

  return {
    kind: "minigame-verification",
    schemaVersion: "1",
    producedAt: nowIso(),
    contract: {
      id: contract.id,
      title: contract.title ?? null,
      type: contract.type,
      ageBand: contract.ageBand,
      ageBandLabel: AGE_BANDS[contract.ageBand]?.label ?? null,
      visualProfile: contract.visualProfile,
      visualProfileLabel: VISUAL_PROFILES[contract.visualProfile]?.label ?? null,
      scenes: contract.scenes,
      requiredLocators,
    },
    capturesDir,
    status,
    states: verdict.states,
    gatesByState: gatesByState(verdict.states),
    summary,
    failures,
    notApplicable,
    captureAbsent: verdict.captureAbsent,
    outcomeGated: verdict.outcomeGated,
    flow: verdict.flow,
    inputResponse: verdict.inputResponse,
    baseline: baselineSection,
    cr,
    statePaths: buildStatePaths(contract, args.root, args.capturesDir),
    deviceLabels: Object.fromEntries(deviceLabels),
    headline: headlineFor(status, summary, failures, title, ctx),
    nextAction: nextActionFor(status, cr.blockingFailures, notApplicable, ctx, requiredLocators),
  };
}

/** Keep terminal output ASCII-clean (CI logs): straight quotes, no middle dot. */
function terminalSafe(text: string): string {
  // Normalize curly quotes to straight; keep `·` (a clean separator) and the status icons.
  return text.replace(/[“”]/g, '"');
}

/** A partner-readable label for an interaction-flow outcome/transition status. */
function flowStatusLabel(status: string): string {
  switch (status) {
    case "pass":
      return "OK";
    case "game_fail":
      return "game did not advance";
    case "harness_fault":
      return "not tested (test setup)";
    case "missing_evidence":
      return "no evidence (test setup)";
    case "outcome_gated":
      return "not asserted (outcome-gated)";
    default:
      return status;
  }
}

/** A partner-readable label for an input-response (liveness) outcome/state status. */
function responseStatusLabel(status: string): string {
  switch (status) {
    case "pass":
      return "OK (the game responded)";
    case "game_fail":
      return "no response (inert control)";
    case "missing_evidence":
      return "not captured (test setup)";
    case "not_applicable":
      return "not declared";
    default:
      return status;
  }
}

/** The demoted "where + raw check id" detail tag for a finding line. */
function whereTag(f: MinigameFinding): string {
  if (f.id) return ` [${f.state ?? "?"}, check: ${f.id}]`;
  if (f.transition) return ` [flow: ${f.transition}]`;
  if (f.state) return ` [${f.state}]`;
  return "";
}

/**
 * Render the report to stderr as a partner-facing release check (S7b): no dev
 * prefix, plain-language finding sentences (the raw gate id demoted to a trailing
 * detail), grouped into the same moat tiers as the HTML/MD report — Must fix (game
 * defects) → Looks different (baseline drift, NOT a bug) → Couldn't be tested
 * (harness/capture gap, NOT a game defect) → warnings → game flow → passed →
 * screens → baseline → status + next. Presentation only; the status/exit semantics
 * are unchanged, and ASCII-clean for CI logs.
 */
function renderReport(report: MinigameVerifyReport, verbose: boolean): void {
  const line = (text: string): void => console.error(terminalSafe(text));
  // The full per-finding breakdown is the polished HTML/MD/JSON report now — the terminal stays
  // slim by default (scorecard + report link + the single next step). `--verbose` restores the
  // legacy per-finding dump for CI logs / quick triage without opening the report.
  if (verbose) {
  const c = report.contract;
  const cr = report.cr;
  const banner = bannerFor(report.status);
  // Glyph per honesty tier — a harness/capture gap (missing_evidence/harness_fault) is NOT a
  // game defect, and not-applicable is not a failure, so neither gets the ✗ a real game_fail does.
  const statusGlyph = (status: string): string => {
    switch (status) {
      case "pass":
        return ICON.pass; // ✓
      case "game_fail":
        return ICON.fail; // ✗ — a real game defect
      case "outcome_gated":
        return ICON.gated; // ⏸ — not asserted by design
      case "missing_evidence":
      case "harness_fault":
        return ICON.cantVerify; // 🟡 — test-setup gap, not the game
      default:
        return "·"; // not_applicable / unknown — neutral
    }
  };

  // Header — status icon + label, then the device line, then the plain-language verdict.
  line(`${banner.icon} ${c.title ?? c.id}: ${banner.label}`);
  line(`   ${c.ageBandLabel ?? c.ageBand} · ${c.visualProfileLabel ?? c.visualProfile}`);
  line(banner.line);

  // Must fix — real game defects (→ exit 1). Per-device duplicates are grouped into one row
  // (the same overflow on N aspects → one line naming the devices), so the count is distinct
  // issues, not the raw per-device check tally (that stays in the stats line below). The likely-
  // background sweep findings (decoration) split into their own "declare to dismiss" group so they
  // don't bury the real HUD issues — both remain exit-1 failures until declared.
  if (cr.blockingFailures.length > 0) {
    const candidates = backgroundCandidatesFor(report);
    const { mustFix, likelyBackground } = partitionBackgroundCandidates(cr.blockingFailures, candidates);
    if (mustFix.length > 0) {
      const groups = groupFindingsByDevice(mustFix);
      line(`\n${ICON.mustFix} Must fix before release (${groups.length})`);
      for (const g of groups) line(`   ${ICON.fail} ${humanizeGrouped(g)}${whereTag(g.finding)}`);
    }
    if (likelyBackground.length > 0) {
      const groups = groupFindingsByDevice(likelyBackground);
      line(`\n🎨 Likely background decoration — declare to dismiss (${groups.length})`);
      const cta = backgroundSuggestionText(candidates);
      if (cta) line(`   ${cta}`);
      for (const g of groups) line(`   ${ICON.fail} ${humanizeGrouped(g)}${whereTag(g.finding)}`);
    }
  }

  // Looks different — baseline drift; its own tier, NOT a bug (→ exit 1).
  if (cr.baselineRegressions.length > 0) {
    const groups = groupFindingsByDevice(cr.baselineRegressions);
    line(`\n${ICON.drift} Looks different from the approved version (${groups.length}): not a bug; re-approve if intended`);
    for (const g of groups) line(`   ${ICON.fail} ${humanizeGrouped(g)}${whereTag(g.finding)}`);
  }

  // Couldn't be tested — capture/harness gaps, NOT game defects (→ exit 2). Uses the
  // harness-correct wording so a harness fault is never phrased as a game result.
  if (cr.incompleteHarness.length > 0) {
    const groups = groupFindingsByDevice(cr.incompleteHarness);
    line(`\n${ICON.cantVerify} Couldn't be tested (${groups.length}): fix the test setup, not the game`);
    for (const g of groups) line(`   ${ICON.fail} ${harnessFlowSentence(g.finding)}${whereTag(g.finding)}`);
  }

  // Warnings — soft issues; never silent (under --strict a warn forces fail).
  if (cr.warnings.length > 0) {
    const groups = groupFindingsByDevice(cr.warnings);
    line(`\n${ICON.warn} Warnings (${groups.length}): block under --strict`);
    for (const g of groups) line(`   ${ICON.fail} ${humanizeGrouped(g)}${whereTag(g.finding)}`);
  }

  // Not asserted — OUTCOME-GATED: read-only can't drive these (by design, NOT a failure).
  // Compact to the state names + a flow note (the full per-finding detail is in the report).
  if (cr.notAssertedOutcomeGated.length > 0) {
    const stateNames = [...new Set(cr.notAssertedOutcomeGated.filter((f) => f.source !== "flow" && f.state).map((f) => f.state as string))];
    const flowCount = cr.notAssertedOutcomeGated.filter((f) => f.source === "flow").length;
    const flowNote = flowCount > 0 ? `${stateNames.length > 0 ? "  " : ""}(and ${flowCount} flow transition${flowCount === 1 ? "" : "s"})` : "";
    line(`\n${ICON.gated} Not asserted · outcome-gated (${cr.notAssertedOutcomeGated.length}): by design, never a failure`);
    line(`   ${stateNames.join(" · ")}${flowNote}`);
  }

  // Game flow (S6d) — per-transition, in plain language.
  if (report.flow) {
    line(`\n${ICON.flow} Game flow: ${flowStatusLabel(report.flow.outcome)}`);
    for (const t of report.flow.transitions) line(`   ${statusGlyph(t.status)} ${t.transition}: ${flowStatusLabel(t.status)}`);
  }

  // Responds to input (slice 3) — does tapping a gameplay control produce a change?
  if (report.inputResponse) {
    line(`\n${ICON.input} Responds to input: ${responseStatusLabel(report.inputResponse.outcome)}`);
    for (const s of report.inputResponse.states) line(`   ${statusGlyph(s.status)} tap ${s.tap} on ${s.state}: ${responseStatusLabel(s.status)}`);
  }

  // Passed — what's green, grouped by screen.
  const passedStates = Object.entries(cr.passedGates);
  if (passedStates.length > 0) {
    const passCount = passedStates.reduce((n, [, gates]) => n + gates.length, 0);
    line(`\n${ICON.passed} Passed (${passCount})`);
    for (const [state, gates] of passedStates) line(`   ${state}   ${gates.join(" · ")}`);
  }

  // Screens — list what was actually GRADED (the `states` map keys: `<state>@<device>` for a
  // per-device pack, the legacy `<state>` for an old single-aspect pack), so a path that
  // isn't on disk is never implied. A gated/absent state/aspect is excluded.
  const notCaptured = new Set([...report.captureAbsent, ...report.outcomeGated]);
  const capturedScreens = Object.keys(report.states).filter((key) => {
    if (notCaptured.has(key)) return false;
    const logical = splitStateDevice(key).state;
    return !notCaptured.has(logical); // a per-device key under a gated/absent state
  });
  if (capturedScreens.length > 0) {
    line(`\n${ICON.screens} Screens`);
    for (const key of capturedScreens) {
      const p = report.statePaths[key];
      if (!p) continue;
      const { state, deviceId } = splitStateDevice(key);
      const label = deviceId ? `${state} · ${report.deviceLabels[deviceId] ?? deviceId}` : state;
      line(`   ${label}   ${tildify(p.png)}`);
    }
  }

  // Baseline status (S6e) — show even when clean, so a present/declared baseline is visible.
  if (report.baseline) {
    const b = report.baseline;
    if (!b.present) {
      line(`\n${ICON.info} Baseline: declared at ${b.ref} but not approved yet; drift not enforced (run \`loomtide minigame baseline approve\`).`);
    } else {
      const compared = Object.values(b.states).filter((x) => x.compared).length;
      line(
        `\n${ICON.info} Baseline: ${b.ref} (approved ${b.capturedAt ?? "?"}): ${compared} screen(s) compared, ${b.regressions.length} drifted${b.incompleteStates.length > 0 ? `, ${b.incompleteStates.length} couldn't compare` : ""}${b.masks.length > 0 ? `, masks: ${b.masks.join(", ")}` : ""}.`,
      );
    }
  }
  } // end if (verbose)

  // Scorecard — ALWAYS printed (verbose or not): the at-a-glance verdict signal + CI line.
  const s = report.summary;
  const warnNote = s.warn > 0 ? ` · ${s.warn} warn` : "";
  const flowNote = report.flow ? ` · flow ${flowStatusLabel(report.flow.outcome)}` : "";
  line(`\n${ICON.stats} ${s.pass} pass · ${s.fail} fail${warnNote} · ${s.notApplicable} n/a   (${s.checksTotal} checks across ${s.statesGraded}/${s.statesTotal} screens)${flowNote}`);
  // Verbose keeps the legacy findings-specific next line (product-named). Slim mode instead prints the
  // resolved single-next-step footer (with its exact command) from `runVerifyMinigame`.
  if (verbose) line(`\n${ICON.next} Next: ${report.nextAction}`);
}

/**
 * Load + validate the contract, run the gates, write the report, render it, and
 * return the enforcement exit code. A contract that can't be read/validated, or a
 * captures dir that doesn't exist, is `incomplete` (exit 2) — nothing was graded,
 * never a pass.
 */
export async function runVerifyMinigame(args: VerifyMinigameArgs): Promise<number> {
  // The captures dir must exist — a wholly-absent target is "nothing to grade"
  // (incomplete/2), distinct from a present-but-broken capture (a refuse-on-absent
  // FAIL/1 surfaced per state by the runner).
  let dirStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    dirStat = await fs.stat(args.capturesDir);
  } catch {
    dirStat = null;
  }
  if (!dirStat || !dirStat.isDirectory()) {
    console.error(
      `${ICON.cantVerify} Can't verify: the captures folder wasn't found: ${args.capturesDir}. ` +
        "Point --captures at the per-screen capture pack (<screen>.ui-rects.json / .console.json / .png), then re-run.",
    );
    return exitCodeForMinigame("incomplete");
  }

  let contract: MinigameContract;
  try {
    const raw = await fs.readFile(args.contractPath, "utf-8");
    contract = assertValidMinigameContract(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${ICON.cantVerify} Can't verify: couldn't read the contract ${args.contractPath}:`);
    console.error(message);
    return exitCodeForMinigame("incomplete");
  }

  const report = await buildMinigameReport(contract, args);

  const paths = loomtidePaths(args.root);
  const outputPath = args.outputPath ?? path.join(paths.reports, "minigame-verification.json");
  // Create ONLY the reports dir — this read-only diagnose run must not scaffold the
  // full build-mode `.loomtide/` tree.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  // S7b — emit the partner-facing human report (self-contained HTML + Markdown twin)
  // next to the JSON. The JSON stays the audit record; THESE are what a producer/QA
  // opens. Inline each captured screen as a base64 thumbnail so the HTML is portable
  // (no server, openable from a CI artifact zip). A missing/unreadable PNG is simply
  // skipped — its absence is already reported as a capture gap, never a render error.
  const thumbs = await readStateThumbnails(args.capturesDir, report);
  const ext = path.extname(outputPath);
  const base = ext ? outputPath.slice(0, -ext.length) : outputPath;
  const htmlPath = `${base}.html`;
  const mdPath = `${base}.md`;
  await fs.writeFile(htmlPath, renderMinigameReportHtml(report, thumbs), "utf-8");
  await fs.writeFile(mdPath, renderMinigameReportMarkdown(report), "utf-8");

  const verbose = args.verbose ?? false;
  renderReport(report, verbose);
  // Report link — slim by default (just the open command); verbose adds the MD/JSON paths.
  console.error(
    verbose
      ? `\n${ICON.report} Report: open ${tildify(htmlPath)} in a browser (or ${tildify(mdPath)}); full detail in ${tildify(outputPath)}`
      : `\n${ICON.report} Report: open ${tildify(htmlPath)}`,
  );

  const code = exitCodeForMinigame(report.status);
  // The rich "Result: <verdict>: <why> (exit N)" line is verbose-only — in slim mode the verdict
  // is carried by the scorecard's fail count and the next-step summary below.
  if (verbose && code !== 0) {
    let why: string;
    if (report.status === "fail") {
      const regressed = (report.baseline?.regressions.length ?? 0) > 0;
      const gameDefect = report.failures.length > 0 || report.flow?.outcome === "game_fail";
      if (regressed && !gameDefect) {
        why = "the look drifted from the approved version (not a bug: review, or re-approve if intended)";
      } else if (regressed) {
        why = "a game/flow problem AND a look-drift from the approved version";
      } else {
        why = report.flow?.outcome === "game_fail"
          ? "the game flow didn't reach its expected screen (and/or a screen check failed)"
          : "one or more screen checks failed";
      }
    } else if (report.flow?.outcome === "harness_fault") {
      why = "the test setup didn't drive the game honestly (not a game problem: re-capture)";
    } else if (report.captureAbsent.length > 0) {
      why = "a screen wasn't captured (test-setup gap, not a game problem)";
    } else if (report.flow?.outcome === "missing_evidence") {
      why = "the flow had no actuation evidence (test-setup gap)";
    } else {
      why = "nothing could be graded (no captures / no screens / nothing applicable)";
    }
    console.error(`${bannerFor(report.status).icon} Result: ${bannerFor(report.status).label}: ${why} (exit ${code}).`);
  }

  // The single next step (the SAME resolver `minigame next`/`check` use) — the slim terminal's one
  // actionable line + its exact command. Resolved from the contract's workspace, which now holds the
  // fresh report we just wrote. Guarded to the standard workspace report path: with a non-standard
  // `--output` the resolver would read a stale/absent report, so we skip it rather than mislead.
  // (`--quiet-next`: the run/check wrapper owns this line and prints its own — don't double it.)
  let footerPrinted = false;
  const workspace = path.dirname(args.contractPath);
  const standardReport = path.join(workspace, "reports", "minigame-verification.json");
  if (!verbose && !args.quietNext && path.resolve(outputPath) === path.resolve(standardReport)) {
    const nextLines = await nextStepLinesFor(workspace);
    if (nextLines.length > 0) {
      console.error(`\n${nextLines.join("\n")}`);
      footerPrinted = true;
    }
  }

  // MOAT safety net: a real FAIL must NEVER read green in the terminal. The slim scorecard shows
  // `0 fail` for a baseline-regression-only fail (regressions are a separate tier), and the footer
  // above is skipped on a non-standard `--output`. So if neither the verbose Result line nor the
  // footer carried the verdict, emit a one-line verdict here. Skipped under `--quiet-next` — the
  // run/check wrapper owns the trailing verdict+next line in that path.
  if (!verbose && !args.quietNext && code !== 0 && !footerPrinted) {
    console.error(`\n${bannerFor(report.status).icon} ${bannerFor(report.status).label} (exit ${code})`);
  }
  return code;
}
