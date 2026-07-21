/**
 * Standalone mini-game UI gate runner (S6c-1).
 *
 * `runMinigameGates(contract, captureDir)` grades a `MinigameContract` over the
 * per-state uGUI captures produced by S6b: for each contract state it loads
 * `<state>.ui-rects.json` + `<state>.console.json` from `captureDir`, runs that
 * contract's ENABLED deterministic checks (the S6c-1 evaluators), and aggregates
 * per-state + overall with the platformer gates' `worstStatus`.
 *
 * This is a STANDALONE mode (like `verify --profile`), not folded into the
 * platformer `runGates`/`AcceptanceContract` slice pipeline — it grades per-state
 * uGUI capture inputs, not the platformer acceptance shape. It reads the capture
 * dir and returns a verdict; it does not call the Unity bridge or mutate the
 * project. The `verify --minigame` CLI entry is S6c-3.
 *
 * Refuse-on-absent (CLAUDE.md "Verification / supervisor invariants"): a declared
 * contract state with NO `<state>.ui-rects.json` is never silently skipped. S6d
 * reclassification: a WHOLLY-absent/unreadable capture file is a capture/harness
 * gap → INCOMPLETE (tracked in `captureAbsent`), NOT a game `fail` — a missing
 * capture is never proof the game failed. An object MISSING INSIDE a present
 * capture stays a deterministic `required-in-frame` fail. The cross-state
 * `interaction-flow` check (S6d) is graded by `evaluateInteractionFlow`, not the
 * per-state loop.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  makeGateReport,
  worstStatus,
  type CheckStatus,
  type GateReport,
} from "../../verification/gates/types.js";
import { resolveDevices, type MinigameContract } from "../minigame-profiles/types.js";
import { perDeviceKey } from "../minigame-capture-plan.js";
import {
  BACKGROUND_COVERAGE_GATE,
  BACKGROUND_SEAM_GATE,
  DEFERRED_MINIGAME_CHECKS,
  evaluateBackgroundCoverage,
  evaluateBackgroundSeam,
  MINIGAME_FRAME_EVALUATORS,
  MINIGAME_GATE_EVALUATORS,
  MINIGAME_IMAGE_EVALUATORS,
} from "./evaluators.js";
import { loadFlowEvidence } from "./flow-evidence.js";
import { evaluateInteractionFlow, FLOW_CHECK, type FlowReport } from "./interaction-flow.js";
import {
  evaluateInputResponse,
  loadInputResponseEvidence,
  INPUT_RESPONSE_CHECK,
  type InputResponseEvidence,
  type InputResponseReport,
} from "./input-response.js";
import {
  computeFrameFacts,
  readFrameImage,
  type DecodedImage,
  type MinigameFrameFacts,
} from "./frame-facts.js";
import type {
  BackgroundData,
  MinigameCaptureObject,
  MinigameCaptureState,
  MinigameConsole,
  MinigameViewport,
} from "./types.js";

/** The aggregated mini-game verdict: overall status + per-state gate reports. */
export interface MinigameVerdict {
  /** Worst status across every PER-STATE gate report (informational; the CLI's
   * `minigameReportStatus` combines this with `captureAbsent`/`flow` for the exit code). */
  status: CheckStatus;
  /** Per-state gate reports, keyed by contract state id. */
  states: Record<string, GateReport[]>;
  /** State ids whose `<state>.ui-rects.json` was absent/unreadable — a capture/harness
   * gap (→ incomplete), NOT a game fail. Empty when every declared state was captured. */
  captureAbsent: string[];
  /** State ids declared `outcomeGated` — NOT asserted by design (read-only can't drive
   * the outcome). Neither pass nor fail nor a capture gap; reported separately. */
  outcomeGated: string[];
  /** State ids whose capture marked sequential sub-screens (G8) — the contract collapsed
   * sub-screens that are never co-visible (cook: spray→pour→power). Can't be verified as one
   * frame → incomplete (split the state); NOT a game fail. */
  sequentialStates: string[];
  /** The interaction-flow verdict, present only when `interaction-flow` is enabled (S6d). */
  flow?: FlowReport;
  /** The input-response (liveness) verdict, present only when `input-response` is enabled. */
  inputResponse?: InputResponseReport;
}

/** The gate name used when a declared state is outcome-gated (not asserted by design). */
export const OUTCOME_GATED_GATE = "minigame-outcome-gated";

/** The gate name used when a declared state has no capture file. */
export const CAPTURE_GATE = "minigame-capture";

/**
 * The RESERVED logical-state sentinel for the background-coverage gate (Phase 5).
 * background-coverage is a FRAME-LEVEL, aspect-dependent / state-INDEPENDENT check —
 * graded ONCE PER DEVICE under the `states` map key `<BACKGROUND_COVERAGE_KEY>@<device>`
 * (so the existing `flatten`/`failures`/CR-grouping machinery tags each finding with its
 * device for free). It is NOT a screen, so the summary's logical-state count
 * (`summarize`) and the "Screens" listing EXCLUDE this sentinel — see `isBackgroundKey`.
 */
export const BACKGROUND_COVERAGE_KEY = "__background-coverage__";
/** Reserved states-map sentinel for the per-device background-seam gate. */
export const BACKGROUND_SEAM_KEY = "__background-seam__";

/** The `background.json` filename — ONE scene-level, device-invariant geometry pack. */
export const BACKGROUND_DATA_FILE = "background.json";

/** True iff a `states`-map key is the background-coverage sentinel (its logical state is reserved). */
export function isBackgroundKey(key: string): boolean {
  const at = key.lastIndexOf("@");
  const logical = at < 0 ? key : key.slice(0, at);
  return logical === BACKGROUND_COVERAGE_KEY || logical === BACKGROUND_SEAM_KEY;
}

function uiRectsPath(captureDir: string, stateId: string): string {
  return path.join(captureDir, `${stateId}.ui-rects.json`);
}

function consolePath(captureDir: string, stateId: string): string {
  return path.join(captureDir, `${stateId}.console.json`);
}

function framePngPath(captureDir: string, stateId: string): string {
  return path.join(captureDir, `${stateId}.png`);
}

/**
 * Rewrite a per-device capture's `.state` to the LOGICAL state id. Phase 3 stamps the
 * composite `<state>@<device>` key into the dump (so the artifact is self-describing),
 * but the per-state evaluators resolve `contract.states` by `capture.state`; they must
 * see the logical id (`start`), not `start@base-16x9`, to bind the state's required
 * objects. Null passes through (an absent capture is handled by the caller).
 */
function withLogicalState(
  capture: MinigameCaptureState | null,
  logicalStateId: string,
): MinigameCaptureState | null {
  return capture ? { ...capture, state: logicalStateId } : capture;
}

/** True iff `file` is a readable regular file — used to detect a per-device pack. */
async function fileExists(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * The NON-fail `minigame-capture` marker for a wholly-absent/unreadable capture (S6d):
 * a capture/harness gap (→ incomplete), never a game defect. `key` is the states-map
 * key (`<state>` for a legacy pack, `<state>@<device>` per device); `label` names the
 * artifact stem in the message.
 */
function absentCaptureReport(key: string, label: string): GateReport {
  return makeGateReport(CAPTURE_GATE, [
    {
      id: `${CAPTURE_GATE}.${key}`,
      expected: `${label}.ui-rects.json present and parseable in the capture dir`,
      actual: "missing or unparseable",
      status: "not_applicable",
      detail: `No usable capture for '${label}' (${label}.ui-rects.json is absent or not valid JSON) — a wholly-absent capture is a capture/harness gap (INCOMPLETE), never a game defect (S6d).`,
    },
  ]);
}

/**
 * Decode a state's `<state>.png` once, returning both the raw image (for the
 * pixel gate `background-fit`) and its frame facts (for `no-black-bars`/
 * `render-frame`). Both are null when the PNG is missing/unreadable — those gates
 * then FAIL (refuse-on-absent), never pass.
 */
async function loadStateFrameInputs(
  captureDir: string,
  stateId: string,
): Promise<{ image: DecodedImage | null; frameFacts: MinigameFrameFacts | null }> {
  try {
    const image = await readFrameImage(framePngPath(captureDir, stateId));
    return { image, frameFacts: computeFrameFacts(image) };
  } catch {
    return { image: null, frameFacts: null };
  }
}

/**
 * Load a state's capture from `captureDir`. Returns null when the
 * `<state>.ui-rects.json` is missing OR unparseable (refuse-on-absent — the runner
 * turns either into a FAIL; an unreadable capture is no more "verified" than a
 * missing one). A missing/malformed console file yields an absent `console`, which
 * the `console-clean` evaluator refuses.
 */
async function loadCaptureState(
  captureDir: string,
  stateId: string,
): Promise<MinigameCaptureState | null> {
  let ui: {
    state?: unknown;
    viewport?: Partial<MinigameViewport>;
    objects?: MinigameCaptureObject[];
    sequential?: { missing?: unknown };
  };
  try {
    // Read AND parse inside the guard: a corrupt/truncated capture must FAIL the
    // state (via the null → minigame-capture path), never throw out of the runner
    // and leave every other state ungraded.
    const uiRaw = await fs.readFile(uiRectsPath(captureDir, stateId), "utf-8");
    ui = JSON.parse(uiRaw);
  } catch {
    return null;
  }

  let console: MinigameConsole | undefined;
  try {
    const consoleRaw = await fs.readFile(consolePath(captureDir, stateId), "utf-8");
    const parsed = JSON.parse(consoleRaw) as { errorCount?: unknown };
    if (typeof parsed.errorCount === "number" && Number.isFinite(parsed.errorCount)) {
      console = { errorCount: parsed.errorCount };
    }
  } catch {
    console = undefined;
  }

  // G8: a sequential sub-screen marker (objects shown in the state's window but never in one frame).
  // Parsed defensively as a strict string[] — a downgrade-only signal, so a malformed value just
  // means "no downgrade" (the would-be fail stands), never a fabricated pass.
  const seqMissing = Array.isArray(ui.sequential?.missing)
    ? ui.sequential.missing.filter((id): id is string => typeof id === "string")
    : [];
  return {
    state: typeof ui.state === "string" ? ui.state : stateId,
    viewport: {
      width: ui.viewport?.width ?? 0,
      height: ui.viewport?.height ?? 0,
      aspect: ui.viewport?.aspect ?? 0,
    },
    objects: Array.isArray(ui.objects) ? ui.objects : [],
    console,
    ...(seqMissing.length > 0 ? { sequential: { missing: seqMissing } } : {}),
  };
}

/**
 * Run the enabled deterministic checks for one already-loaded capture state.
 * Exported (pure) so callers/tests can grade an in-memory capture without disk.
 *
 * `frameFacts` are the per-state `<state>.png` facts the two frame gates
 * (`no-black-bars`/`render-frame`) need; pass null when the PNG was missing/
 * unreadable — those gates then FAIL (refuse-on-absent), never pass.
 */
export function runStateGates(
  capture: MinigameCaptureState,
  contract: MinigameContract,
  frameFacts: MinigameFrameFacts | null = null,
  image: DecodedImage | null = null,
): GateReport[] {
  const reports: GateReport[] = [];
  for (const check of contract.checks.deterministic) {
    // `interaction-flow` and `input-response` are graded from cross-state / before-after
    // EVIDENCE by their own evaluators, not the per-state loop. Background geometry gates are
    // frame-level, per-DEVICE checks graded once per device (not per state). Skip all here.
    if (check === FLOW_CHECK || check === INPUT_RESPONSE_CHECK || check === BACKGROUND_COVERAGE_GATE || check === BACKGROUND_SEAM_GATE) continue;
    if (DEFERRED_MINIGAME_CHECKS.has(check)) {
      reports.push(
        makeGateReport(check, [
          {
            id: `${check}.${capture.state}`,
            expected: "evaluated",
            actual: "deferred",
            status: "not_applicable",
            detail: `'${check}' is deferred to S6d — not evaluated yet (reported as not_applicable, never silently passed).`,
          },
        ]),
      );
      continue;
    }
    const frameEvaluator = MINIGAME_FRAME_EVALUATORS[check];
    if (frameEvaluator) {
      reports.push(frameEvaluator(capture, frameFacts, contract));
      continue;
    }
    const imageEvaluator = MINIGAME_IMAGE_EVALUATORS[check];
    if (imageEvaluator) {
      reports.push(imageEvaluator(capture, image, contract));
      continue;
    }
    const evaluator = MINIGAME_GATE_EVALUATORS[check];
    // Unknown checks can't reach here for a validated contract (closed vocab), but
    // if one does, surface it as not_applicable rather than silently dropping it.
    if (!evaluator) {
      reports.push(
        makeGateReport(check, [
          {
            id: `${check}.${capture.state}`,
            expected: "a known deterministic check",
            actual: "unrecognized check",
            status: "not_applicable",
            detail: `'${check}' has no S6c-1 evaluator — not run (validate the contract's checks.deterministic vocabulary).`,
          },
        ]),
      );
      continue;
    }
    reports.push(evaluator(capture, contract));
  }
  return reports;
}

/**
 * Load the scene-level `background.json` (device-invariant world geometry) for the
 * `background-coverage` gate. Returns null when the file is missing OR unparseable —
 * the evaluator turns either into a refuse-on-absent FAIL (never assumed covered).
 */
async function loadBackgroundData(captureDir: string): Promise<BackgroundData | null> {
  try {
    const raw = await fs.readFile(path.join(captureDir, BACKGROUND_DATA_FILE), "utf-8");
    const parsed = JSON.parse(raw) as BackgroundData;
    // Shape-guard the top level; the evaluator does the deep refuse-on-absent checks.
    if (!parsed || typeof parsed !== "object" || !parsed.camera || !Array.isArray(parsed.layers)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Grade a mini-game contract over the per-state captures in `captureDir`. */
export async function runMinigameGates(
  contract: MinigameContract,
  captureDir: string,
): Promise<MinigameVerdict> {
  const states: Record<string, GateReport[]> = {};
  const captureAbsent: string[] = [];
  const outcomeGated: string[] = [];
  const capturesByState = new Map<string, MinigameCaptureState | null>();

  for (const cs of contract.states) {
    // Outcome-gated states are NOT asserted: a read-only verifier can't deterministically
    // drive a win/reward on a non-deterministic game, so any frame "captured" there is
    // untrustworthy as the intended state. Mark it not_applicable (outcome-gated) and skip
    // grading — never a capture-absent INCOMPLETE, never a fail.
    if (cs.outcomeGated === true) {
      outcomeGated.push(cs.id);
      capturesByState.set(cs.id, null);
      states[cs.id] = [
        makeGateReport(OUTCOME_GATED_GATE, [
          {
            id: `${OUTCOME_GATED_GATE}.${cs.id}`,
            expected: "deterministically reachable to assert",
            actual: "outcome-gated (not asserted)",
            status: "not_applicable",
            detail: `State '${cs.id}' is outcome-gated — its outcome depends on game logic a READ-ONLY verifier can't drive (no RNG seed / no game change). Not asserted by design; the verifiable states are still graded.`,
          },
        ]),
      ];
      continue;
    }
    // Phase 4: grade this state at EVERY device. Phase 3 writes one
    // `<state>@<device>.ui-rects.json` / `.png` per device; we grade each so an
    // aspect-dependent defect (safe at 16:9, unsafe on a tall phone) fails the build
    // and the report can name the device. The logical state's BASE-device capture
    // still backs `capturesByState`, which the device-INVARIANT flow/input-response
    // gates read (they are never graded per device).
    const devices = resolveDevices(contract);
    const baseDevice = devices[0];

    // Back-compat: an OLD single-aspect pack (predating Phase 3) has no
    // `<state>@<device>` files. Detect by the BASE device's per-device rects: when it
    // is absent we fall back to grading the legacy `<state>` capture once under the
    // plain `cs.id` key (the pre-Phase-4 behavior).
    const hasPerDevice =
      baseDevice !== undefined &&
      (await fileExists(uiRectsPath(captureDir, perDeviceKey(cs.id, baseDevice.id))));

    if (!hasPerDevice) {
      const capture = await loadCaptureState(captureDir, cs.id);
      capturesByState.set(cs.id, capture);
      if (!capture) {
        captureAbsent.push(cs.id);
        states[cs.id] = [absentCaptureReport(cs.id, cs.id)];
        continue;
      }
      const { image, frameFacts } = await loadStateFrameInputs(captureDir, cs.id);
      states[cs.id] = runStateGates(capture, contract, frameFacts, image);
      continue;
    }

    // capturesByState still maps the LOGICAL state id → the BASE device's capture, so the
    // device-invariant flow / input-response gates read the same evidence as before. The
    // loaded capture's `.state` is the composite `<state>@<device>` key (Phase 3 stamps the
    // key into the dump); rewrite it to the LOGICAL id so the evaluators (and the flow gate)
    // resolve the contract state by `cs.id`, not the composite key.
    const baseKey = perDeviceKey(cs.id, baseDevice.id);
    capturesByState.set(cs.id, withLogicalState(await loadCaptureState(captureDir, baseKey), cs.id));

    // console.json is device-INVARIANT — Phase 3 writes it once as `<state>.console.json`, not
    // per `<state>@<device>`. Load it from the LOGICAL state and inject it into every per-device
    // capture, else the device-invariant `console-clean` gate refuses on each `<state>@<device>`
    // (which has no per-device console) and reports one false "absent console" FAIL per device.
    const logicalConsole = (await loadCaptureState(captureDir, cs.id))?.console;

    for (const device of devices) {
      const key = perDeviceKey(cs.id, device.id);
      const capture = withLogicalState(await loadCaptureState(captureDir, key), cs.id);
      if (!capture) {
        // captureAbsent is per (state,device): a missing `<state>@<device>` capture is a
        // capture/harness gap for THAT aspect (→ incomplete), never a game defect (S6d).
        captureAbsent.push(key);
        states[key] = [absentCaptureReport(key, key)];
        continue;
      }
      capture.console = logicalConsole;
      const { image, frameFacts } = await loadStateFrameInputs(captureDir, key);
      states[key] = runStateGates(capture, contract, frameFacts, image);
    }
  }

  // background-coverage gate (Phase 5) — only when enabled. It is FRAME-LEVEL, aspect-
  // dependent + state-INDEPENDENT, so it is graded ONCE PER DEVICE (not per state): load
  // the single device-invariant `background.json`, then evaluate the world-space layer
  // coverage at each device's aspect. Each per-device report lands under the reserved
  // `<BACKGROUND_COVERAGE_KEY>@<device>` states-map key, so the existing flatten/CR
  // machinery tags the finding with its device (Must-fix tier) — while `summarize` and the
  // "Screens" listing exclude this sentinel, so it never inflates the screen count.
  if (contract.checks.deterministic.includes(BACKGROUND_COVERAGE_GATE) || contract.checks.deterministic.includes(BACKGROUND_SEAM_GATE)) {
    const backgroundData = await loadBackgroundData(captureDir);
    for (const device of resolveDevices(contract)) {
      const aspect = device.height > 0 ? device.width / device.height : 0;
      if (contract.checks.deterministic.includes(BACKGROUND_COVERAGE_GATE)) {
        const key = perDeviceKey(BACKGROUND_COVERAGE_KEY, device.id);
        states[key] = [evaluateBackgroundCoverage(backgroundData, aspect)];
      }
      if (contract.checks.deterministic.includes(BACKGROUND_SEAM_GATE)) {
        const key = perDeviceKey(BACKGROUND_SEAM_KEY, device.id);
        states[key] = [evaluateBackgroundSeam(backgroundData, aspect, { width: device.width, height: device.height })];
      }
    }
  }

  // Cross-state interaction-flow gate (S6d) — only when enabled. Reuses the per-state
  // captures as before/after snapshots + `flow.json` for the actuation evidence.
  let flow: FlowReport | undefined;
  if (contract.checks.deterministic.includes(FLOW_CHECK)) {
    const flowEvidence = await loadFlowEvidence(captureDir);
    flow = evaluateInteractionFlow(contract, flowEvidence, capturesByState);
  }

  // Input-response (liveness) gate — only when enabled. Loads each declaring state's
  // before/after `<state>.response.json` evidence, then grades game-vs-harness.
  let inputResponse: InputResponseReport | undefined;
  if (contract.checks.deterministic.includes(INPUT_RESPONSE_CHECK)) {
    const evidenceByState = new Map<string, InputResponseEvidence | null>();
    for (const cs of contract.states) {
      if (cs.inputResponse) evidenceByState.set(cs.id, await loadInputResponseEvidence(captureDir, cs.id));
    }
    inputResponse = evaluateInputResponse(contract, evidenceByState);
  }

  // G8: states whose capture marked sequential sub-screens (objects shown in the window but never
  // co-visible). These can't be verified as a single frame → force incomplete (split the state).
  const sequentialStates = [...capturesByState.entries()]
    .filter(([, cap]) => (cap?.sequential?.missing?.length ?? 0) > 0)
    .map(([id]) => id);

  const status = worstStatus(
    Object.values(states)
      .flat()
      .map((report) => report.verdict),
  );
  return { status, states, captureAbsent, outcomeGated, sequentialStates, flow, inputResponse };
}
