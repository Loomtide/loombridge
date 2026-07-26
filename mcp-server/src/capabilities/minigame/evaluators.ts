/**
 * Deterministic mini-game UI gate evaluators (S6c-1).
 *
 * Each evaluator is a PURE function `(state, contract) => GateReport` over one
 * per-state capture (`MinigameCaptureState`). They reuse the platformer gate
 * report shape (`GateReport`/`GateCheck`/`worstStatus`/`makeGateReport`) so a
 * mini-game verdict aggregates identically to a Tier-1 platformer verdict.
 *
 * Anti-false-green discipline (CLAUDE.md "Verification / supervisor invariants",
 * mirroring `isFreshGreen`'s "refuse a missing field" rule): an ABSENT required
 * object, an ABSENT matching contract state, or an ABSENT console summary is a
 * FAIL — never a silently-skipped check. The keystone is `required-in-frame`.
 *
 * S6c-1 implements five checks: `required-in-frame`, `safe-area`,
 * `control-overlap`, `text-clipping`, `console-clean`. The remaining contract
 * checks (`tap-target-size`, `no-black-bars`, `render-frame`, `interaction-flow`)
 * are S6c-2/S6d and are surfaced by the runner as `not_applicable` — never passed.
 */

import {
  makeGateReport,
  type GateCheck,
  type GateCheckAnnotation,
  type GateReport,
  type SeamAnnotation,
} from "../verification/gates/types.js";
import {
  buildSafeAreaSweepChecks,
  gradeSafeAreaSweep,
  gradeTapTarget,
  resolveSafeBounds,
  safeAreaOverflow,
  tapTargetGradeToCheck,
  type SweepElement,
} from "../verification/mobile-touch-gates.js";
// `safeAreaOverflow` is the shared per-edge overflow math (now lives in the
// dimension-agnostic mobile-touch-gates module so the 3D top-down path shares the
// exact same implementation). Re-exported here for back-compat — the gate index and
// the 2D tests still import it from this module.
export { safeAreaOverflow };
import { VISUAL_PROFILES, type MinigameContract } from "./profiles/types.js";
import {
  backgroundFillFraction,
  parseHexColor,
  type DecodedImage,
  type MinigameFrameFacts,
} from "./frame-facts.js";
import type {
  BackgroundData,
  MinigameCaptureObject,
  MinigameCaptureState,
  MinigameRect,
} from "./types.js";
import { coverageStats, viewRect } from "./coverage-geometry.js";
import { renderOrderUnsupportedReason, seamFindings, seamSegment } from "./seam-geometry.js";

/** Floating-point slack for normalized geometry comparisons. */
const GEOMETRY_EPSILON = 1e-6;
/** Minimum pixel-area overlap that counts as a real control collision. */
const OVERLAP_AREA_EPSILON = 0.5;
/**
 * A pair is exempt from control-overlap ONLY when it shows intentional stacking,
 * not mere geometric containment (a large UNRELATED hit area swallowing a small
 * button is a real bug, not a backdrop). Evidence required:
 *   (a) one object's hierarchy path is an ANCESTOR of the other's (a scrim/panel
 *       behind its own descendants), or
 *   (b) the larger object is effectively a FULL-FRAME backdrop that contains the
 *       smaller (a separate-Canvas modal scrim that isn't a path-ancestor).
 * The intersection must still cover ~all of the smaller rect (`CONTROL_CONTAINMENT_RATIO`).
 */
const CONTROL_CONTAINMENT_RATIO = 0.98;
/** A control covering at least this fraction of BOTH frame dimensions is a full-frame backdrop. */
const FULL_FRAME_FRACTION = 0.98;
/** Relative tolerance for matching captured viewport aspect to the profile target. */
const ASPECT_TOLERANCE = 0.02;
/** Default fraction of its rect a background fill must cover to count as enveloping. */
const DEFAULT_MIN_BG_FILL_FRACTION = 0.6;
/** Fallback background fill colour when a binding omits `bgColor`. */
const DEFAULT_BG_FILL: [number, number, number] = [255, 255, 255];

function pass(id: string, expected: string, actual: string, detail: string, annotation?: GateCheckAnnotation): GateCheck {
  return annotation ? { id, expected, actual, status: "pass", detail, annotation } : { id, expected, actual, status: "pass", detail };
}

function fail(id: string, expected: string, actual: string, detail: string, annotation?: GateCheckAnnotation): GateCheck {
  return annotation ? { id, expected, actual, status: "fail", detail, annotation } : { id, expected, actual, status: "fail", detail };
}

/**
 * "Nothing for this check to grade in this state" — emitted (instead of a vacuous
 * `pass`) when a per-state check finds nothing applicable to check: a state that
 * declares no required objects, a `control-overlap` with fewer than two interactive
 * controls, a `tap-target-size` with no tap targets, a `text-clipping` with no text
 * objects. This is the anti-false-green rule: a check that verified NOTHING must not
 * report green. The standalone runner's status logic treats an all-`not_applicable`
 * run as `incomplete` (exit 2), never a pass — so a contract whose only enabled check
 * is vacuous everywhere can no longer launder an empty capture into a release-green.
 */
function na(id: string, expected: string, actual: string, detail: string): GateCheck {
  return { id, expected, actual, status: "not_applicable", detail };
}

/**
 * Resolve the required-in-frame object ids the contract declares for this
 * captured state. A capture state with no matching contract state is a binding
 * failure (the verifier cannot know what to require) — reported, never skipped.
 */
function requiredIdsForState(
  state: MinigameCaptureState,
  contract: MinigameContract,
):
  | { found: true; ids: string[] }
  | { found: false } {
  const cs = contract.states.find((s) => s.id === state.state);
  if (!cs) return { found: false };
  return { found: true, ids: cs.requiredInFrame ?? [] };
}

/** The single check a gate emits when the capture state has no contract state. */
function unboundStateCheck(gate: string, state: string): GateCheck {
  return fail(
    `${gate}.${state}`,
    `a contract state declaring '${state}'`,
    "no matching contract state",
    `Capture state '${state}' has no matching contract state — cannot resolve required objects (refuse-on-absent).`,
  );
}

function objectsById(state: MinigameCaptureState): Map<string, MinigameCaptureObject> {
  return new Map(state.objects.map((o) => [o.id, o]));
}

function isFiniteRect(r: MinigameRect | undefined): r is MinigameRect {
  return (
    !!r &&
    [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * The object's normalized 0..1 rect: the captured `viewportRect` if present,
 * otherwise derived from `screenRect` + the viewport size (origin bottom-left).
 * Returns null when neither is usable (no geometry to grade).
 */
export function normalizedRect(
  obj: MinigameCaptureObject,
  viewport: MinigameCaptureState["viewport"],
): MinigameRect | null {
  if (isFiniteRect(obj.viewportRect)) return obj.viewportRect;
  if (isFiniteRect(obj.screenRect) && viewport.width > 0 && viewport.height > 0) {
    return {
      x: obj.screenRect.x / viewport.width,
      y: obj.screenRect.y / viewport.height,
      width: obj.screenRect.width / viewport.width,
      height: obj.screenRect.height / viewport.height,
    };
  }
  return null;
}

/** Intersection area of two pixel rects (0 when disjoint). */
function intersectionArea(a: MinigameRect, b: MinigameRect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y, b.y);
  const top = Math.min(a.y + a.height, b.y + b.height);
  const w = right - left;
  const h = top - bottom;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Fraction of the SMALLER rect covered by the intersection. ~1 means one rect is
 * (nearly) inside the other — a containment/stacking relationship rather than a
 * sibling collision.
 */
function containmentRatio(a: MinigameRect, b: MinigameRect): number {
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? intersectionArea(a, b) / minArea : 0;
}

/** True iff `ancestor` is a strict hierarchy-path ancestor of `descendant`. */
function isAncestorPath(ancestor: string | undefined, descendant: string | undefined): boolean {
  if (!ancestor || !descendant || ancestor === descendant) return false;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return descendant.startsWith(prefix);
}

/** True iff the rect covers ~the whole frame (a full-frame scrim/backdrop). */
function isFullFrameBackdrop(
  rect: MinigameRect,
  viewport: MinigameCaptureState["viewport"],
): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return false;
  return (
    rect.width >= FULL_FRAME_FRACTION * viewport.width &&
    rect.height >= FULL_FRAME_FRACTION * viewport.height
  );
}

// ── required-in-frame (keystone) ────────────────────────────────────────────────

/**
 * Every `requiredInFrame` id the contract declares for this state must appear in
 * the capture and be `active && isVisible && isFullyVisible`. An ABSENT id (or an
 * absent matching contract state) is a FAIL, never a skip — this is the keystone
 * refuse-on-absent guard the other checks lean on.
 */
export function evaluateRequiredInFrame(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "required-in-frame";
  const resolved = requiredIdsForState(state, contract);
  if (!resolved.found) return makeGateReport(gate, [unboundStateCheck(gate, state.state)]);

  if (resolved.ids.length === 0) {
    return makeGateReport(gate, [
      na(
        `${gate}.${state.state}`,
        "0 required-in-frame objects declared for this state",
        "none declared",
        `State '${state.state}' declares no requiredInFrame objects — nothing to require here (not graded).`,
      ),
    ]);
  }

  const byId = objectsById(state);
  // G8: objects the capture saw DURING this state's window but never in the representative frame —
  // the contract collapsed sequential sub-screens (cook: spray→pour→power). For these, the object IS
  // shown to the player, just not simultaneously, so a single-frame "not visible" is NOT a game fail —
  // it's a contract-granularity gap. Downgrade to not_applicable here (never a green); the report
  // separately forces INCOMPLETE for any sequential state, so this can't launder cook into a pass.
  const sequential = new Set(state.sequential?.missing ?? []);
  const seqNote = (id: string): string =>
    `Required object '${id}' is shown on '${state.state}' but never in the same frame as its peers — '${state.state}' collapses sequential sub-screens. Can't verify it in one frame; split '${state.state}' into one state per sub-screen.`;
  const checks = resolved.ids.map((id) => {
    const cid = `${gate}.${id}`;
    const expected = "active && isVisible && isFullyVisible";
    const obj = byId.get(id);
    if (!obj || !obj.active || !obj.isVisible || obj.isFullyVisible !== true) {
      if (sequential.has(id)) return na(cid, expected, "sequential sub-screen (not co-visible)", seqNote(id));
    }
    if (!obj) {
      return fail(
        cid,
        expected,
        "absent from capture",
        `Required object '${id}' is absent from the '${state.state}' capture — an absent required object is a FAIL, never skipped.`,
      );
    }
    if (!obj.active) {
      return fail(cid, expected, "active=false", `Required object '${id}' is inactive (${obj.visibilityReason ?? "active=false"}) in '${state.state}'.`);
    }
    if (!obj.isVisible) {
      return fail(cid, expected, "isVisible=false", `Required object '${id}' is not visible (${obj.visibilityReason ?? "isVisible=false"}) in '${state.state}'.`);
    }
    if (obj.isFullyVisible !== true) {
      const clip = obj.clipSide ? `, clipped ${obj.clipSide}` : "";
      return fail(cid, expected, `isFullyVisible=${String(obj.isFullyVisible)}`, `Required object '${id}' is not fully visible (isFullyVisible=${String(obj.isFullyVisible)}${clip}) in '${state.state}'.`);
    }
    return pass(cid, expected, "active, visible, fully in frame", `Required object '${id}' is active, visible, and fully in frame.`);
  });
  return makeGateReport(gate, checks);
}

// ── safe-area ───────────────────────────────────────────────────────────────────

/**
 * `safeAreaOverflow` (the per-edge overflow math shared by `safe-area`,
 * `safe-area-sweep`, and the 3D top-down sweep) now lives in the dimension-agnostic
 * `mobile-touch-gates` module and is imported + re-exported above. The tie-break
 * order (left→right→bottom→top) only NAMES the edge, never the verdict.
 */

/**
 * Each required object's normalized rect must sit inside the safe rect defined by
 * `uiSafeAreas.insets` (default = full frame), tolerating `maxOverflowFraction` of
 * frame on any edge. An absent required object (no geometry) is a FAIL.
 */
export function evaluateSafeArea(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "safe-area";
  const resolved = requiredIdsForState(state, contract);
  if (!resolved.found) return makeGateReport(gate, [unboundStateCheck(gate, state.state)]);

  const insets = contract.uiSafeAreas?.insets ?? {};
  const tol = contract.uiSafeAreas?.maxOverflowFraction ?? 0;
  const safeLeft = insets.left ?? 0;
  const safeRight = 1 - (insets.right ?? 0);
  const safeBottom = insets.bottom ?? 0;
  const safeTop = 1 - (insets.top ?? 0);
  const safeLabel = `x∈[${safeLeft.toFixed(3)},${safeRight.toFixed(3)}], y∈[${safeBottom.toFixed(3)},${safeTop.toFixed(3)}] (≤${tol} overflow)`;

  if (resolved.ids.length === 0) {
    return makeGateReport(gate, [
      na(`${gate}.${state.state}`, safeLabel, "no required objects", `State '${state.state}' declares no requiredInFrame objects — nothing to place (not graded).`),
    ]);
  }

  const byId = objectsById(state);
  const checks = resolved.ids.map((id) => {
    const cid = `${gate}.${id}`;
    const obj = byId.get(id);
    if (!obj) {
      return fail(cid, safeLabel, "absent from capture", `Required object '${id}' is absent from the '${state.state}' capture — cannot verify safe-area (refuse-on-absent).`);
    }
    const rect = normalizedRect(obj, state.viewport);
    if (!rect) {
      return fail(cid, safeLabel, "no usable geometry", `Required object '${id}' has no viewportRect and no derivable screenRect — cannot verify safe-area.`);
    }
    const { worst, edge } = safeAreaOverflow(
      rect,
      { left: safeLeft, right: safeRight, bottom: safeBottom, top: safeTop },
      tol,
    );
    const actual = `x∈[${rect.x.toFixed(3)},${(rect.x + rect.width).toFixed(3)}], y∈[${rect.y.toFixed(3)},${(rect.y + rect.height).toFixed(3)}]`;
    // Structured geometry so the report can DRAW this check over the state PNG —
    // the rect (as captured, bottom-left origin), the safe insets, and (on fail)
    // the offending edge + fraction. The frame size turns fractions into px copy.
    const safeInsets = {
      top: insets.top ?? 0,
      bottom: insets.bottom ?? 0,
      left: insets.left ?? 0,
      right: insets.right ?? 0,
    };
    const baseAnnotation: GateCheckAnnotation = {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      safeInsets,
      viewport: { width: state.viewport.width, height: state.viewport.height },
      ...(obj.path ? { locator: obj.path } : {}),
    };
    if (worst > tol + GEOMETRY_EPSILON) {
      // Pass/fail is decided by `worst > tol`; `edge` (from safeAreaOverflow, ties
      // resolving to the earlier edge: left→right→bottom→top) only NAMES the edge.
      return fail(
        cid,
        safeLabel,
        actual,
        `Required object '${id}' overflows the safe area on the ${edge} edge by ${worst.toFixed(3)} of frame (> ${tol} tolerance) in '${state.state}'.`,
        { ...baseAnnotation, overflow: { edge, fraction: worst } },
      );
    }
    return pass(
      cid,
      safeLabel,
      actual,
      `Required object '${id}' is within the safe area (max edge overflow ${worst.toFixed(3)} ≤ ${tol}).`,
      baseAnnotation,
    );
  });
  return makeGateReport(gate, checks);
}

// ── safe-area-sweep ───────────────────────────────────────────────────────────────

/**
 * Grade EVERY visible rendered uGUI element against the safe area — not just the
 * contract's `requiredInFrame`. Catches HUD chrome (a score chip, a star row) that
 * sits in the unsafe margin even though it was never declared a required object.
 *
 * This is now a THIN ADAPTER over the dimension-agnostic `gradeSafeAreaSweep` +
 * `buildSafeAreaSweepChecks` (in `mobile-touch-gates.ts`): it projects the minigame
 * capture/contract into the neutral shared inputs (owned-ids/-paths, exempt predicate,
 * declared-background predicate) and lets the SHARED core do the candidate selection,
 * overflow grading, hierarchy dedup, and report shaping. The 3D top-down path calls
 * the same core, so a thumb layout is graded by exactly the same code.
 *
 * Candidate set (DISCOVERED, not declared — a non-usable rect is SKIPPED, not a
 * refuse): visible, rendered (`role !== "container"`), with usable geometry, NOT a
 * full-bleed backdrop, NOT already graded by `safe-area` (this state's
 * `requiredInFrame`), and NOT on `safeAreaExempt`. Hierarchy dedup reports the
 * outermost overflowing widget only.
 */
export function evaluateSafeAreaSweep(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "safe-area-sweep";

  const insets = contract.uiSafeAreas?.insets ?? {};
  const tol = contract.uiSafeAreas?.maxOverflowFraction ?? 0;
  const safe = resolveSafeBounds(insets);
  const safeInsets = {
    top: insets.top ?? 0,
    bottom: insets.bottom ?? 0,
    left: insets.left ?? 0,
    right: insets.right ?? 0,
  };

  // `safe-area` already grades this state's required objects — don't double-report.
  const resolved = requiredIdsForState(state, contract);
  const requiredIds = new Set(resolved.found ? resolved.ids : []);
  // The captured paths of those required objects — a sweep candidate INSIDE one of them (e.g.
  // a button's icon child) belongs to a widget `safe-area` already grades, so skip it.
  const requiredPaths = state.objects
    .filter((o) => requiredIds.has(o.id) && o.path)
    .map((o) => o.path as string);
  // Optional `string[]` exempt list (not yet on the type — read defensively).
  const exempt = new Set((contract as { safeAreaExempt?: string[] }).safeAreaExempt ?? []);
  // Declared DECORATIVE BACKGROUND subtrees/patterns (sky/hill/cloud/sparkle that, like a
  // world-space backdrop, may sit outside the safe area). Exact path, ANCESTOR path
  // (`/Canvas/Background` → all children), or a trailing-`*` SEGMENT-SAFE glob.
  const background = (contract as { safeAreaBackground?: string[] }).safeAreaBackground ?? [];
  const matchesBackground = (path: string): boolean =>
    background.some((b) => {
      if (b === path) return true;
      if (isAncestorPath(b, path)) return true;
      if (b.endsWith("*")) {
        const prefix = b.slice(0, -1);
        return path === prefix || path.startsWith(`${prefix}[`) || path.startsWith(`${prefix}/`);
      }
      return false;
    });

  // Project each captured object into a neutral SweepElement (normalize geometry here —
  // the minigame-specific viewport handling stays local; the shared core is dimension-agnostic).
  const sweepElements: SweepElement[] = state.objects.map((o) => ({
    id: o.id,
    path: o.path,
    role: o.role,
    isVisible: o.isVisible,
    raycastTarget: o.raycastTarget,
    rect: normalizedRect(o, state.viewport),
  }));

  const result = gradeSafeAreaSweep(sweepElements, {
    safe,
    tol,
    ownedIds: requiredIds,
    ownedPaths: requiredPaths,
    isExempt: (el) => exempt.has(el.id) || (!!el.path && exempt.has(el.path)),
    isBackground: (el) => !!el.path && matchesBackground(el.path),
  });

  return makeGateReport(
    gate,
    buildSafeAreaSweepChecks(result, {
      gate,
      stateLabel: state.state,
      safe,
      tol,
      safeInsets,
      viewport: { width: state.viewport.width, height: state.viewport.height },
    }),
  );
}

// ── control-overlap ─────────────────────────────────────────────────────────────

/**
 * Required INTERACTIVE controls (present, active, `raycastTarget === true`) must
 * not overlap each other — a pairwise `screenRect` intersection area beyond an
 * epsilon is a FAIL (overlapping hit areas mis-route a child's tap).
 *
 * Backdrop exemption: a pair is exempt only with EVIDENCE of intentional stacking
 * — one path is an ancestor of the other (a scrim/panel behind its descendants),
 * OR the larger control is a full-frame backdrop — AND its intersection covers ~all
 * of the smaller rect. Bare geometric containment is NOT enough: a large unrelated
 * hit area swallowing a small button is a real collision, not a backdrop. Without
 * the ancestry/backdrop signal a correct raycast-blocking modal would false-fail.
 *
 * Refuse-on-absent: a required id that is ABSENT from the capture is a FAIL here
 * (mirroring `safe-area`), NOT a silent drop — so this check is independently
 * sound and does not rely on `required-in-frame` being co-enabled to catch the
 * absence (the contract validator does not force that coupling).
 */
export function evaluateControlOverlap(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "control-overlap";
  const resolved = requiredIdsForState(state, contract);
  if (!resolved.found) return makeGateReport(gate, [unboundStateCheck(gate, state.state)]);

  const byId = objectsById(state);
  const checks: GateCheck[] = [];

  // A required object that never appears in the capture cannot be cleared of
  // overlap — refuse it (fail-closed), never drop it.
  for (const id of resolved.ids) {
    if (!byId.has(id)) {
      checks.push(
        fail(
          `${gate}.${id}`,
          "present required object",
          "absent from capture",
          `Required object '${id}' is absent from the '${state.state}' capture — cannot verify control non-overlap (refuse-on-absent).`,
        ),
      );
    }
  }

  const controls = resolved.ids
    .map((id) => byId.get(id))
    .filter((o): o is MinigameCaptureObject => !!o && o.active && o.raycastTarget === true && isFiniteRect(o.screenRect));

  if (controls.length < 2) {
    // Too few controls to overlap → NOT graded (not a vacuous pass). Only emit it
    // when nothing was already refused above — otherwise the absent-id FAIL stands.
    if (checks.length === 0) {
      checks.push(
        na(
          `${gate}.${state.state}`,
          "no two required interactive controls overlap",
          `${controls.length} interactive control(s)`,
          `State '${state.state}' has ${controls.length} required interactive control(s) — too few to overlap (not graded).`,
        ),
      );
    }
    return makeGateReport(gate, checks);
  }

  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      const area = intersectionArea(a.screenRect, b.screenRect);
      if (area <= OVERLAP_AREA_EPSILON) continue;
      // Exempt INTENTIONAL stacking only: one control nearly contains the other AND
      // either is the other's hierarchy ancestor, or the larger is a full-frame
      // backdrop. Bare containment of an UNRELATED control still fails.
      const nearlyContains = containmentRatio(a.screenRect, b.screenRect) >= CONTROL_CONTAINMENT_RATIO;
      const ancestry = isAncestorPath(a.path, b.path) || isAncestorPath(b.path, a.path);
      const larger = a.screenRect.width * a.screenRect.height >= b.screenRect.width * b.screenRect.height ? a : b;
      const backdrop = isFullFrameBackdrop(larger.screenRect, state.viewport);
      if (nearlyContains && (ancestry || backdrop)) continue;
      checks.push(
        fail(
          `${gate}.${a.id}~${b.id}`,
          "0 px² overlap (intentional ancestor/backdrop stacking exempt)",
          `${area.toFixed(1)} px² overlap`,
          `Required controls '${a.id}' and '${b.id}' overlap by ${area.toFixed(1)} px² in '${state.state}' — interactive hit areas must be disjoint unless one is an ancestor/full-frame backdrop of the other.`,
        ),
      );
    }
  }
  if (checks.length === 0) {
    checks.push(
      pass(
        `${gate}.${state.state}`,
        "no two required interactive controls overlap",
        `${controls.length} controls, 0 overlapping pairs`,
        `All ${controls.length} required interactive controls in '${state.state}' have disjoint hit areas.`,
      ),
    );
  }
  return makeGateReport(gate, checks);
}

// ── text-clipping ───────────────────────────────────────────────────────────────

/**
 * Required `role:"text"` objects must be `isFullyVisible && !isPartiallyClipped`
 * (v1 = frame-clip; container-fit is deferred).
 *
 * Refuse-on-absent: a required id that is ABSENT from the capture is a FAIL here
 * (its role is unknowable, so it cannot be cleared) — NOT a silent drop via the
 * role filter. A PRESENT required object whose role is genuinely not "text" is
 * legitimately not this check's concern and is skipped. This keeps the check
 * independently sound rather than relying on `required-in-frame` being co-enabled.
 */
export function evaluateTextClipping(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "text-clipping";
  const resolved = requiredIdsForState(state, contract);
  if (!resolved.found) return makeGateReport(gate, [unboundStateCheck(gate, state.state)]);

  const byId = objectsById(state);
  const checks: GateCheck[] = [];
  for (const id of resolved.ids) {
    const cid = `${gate}.${id}`;
    const expected = "isFullyVisible && !isPartiallyClipped";
    const obj = byId.get(id);
    if (!obj) {
      checks.push(
        fail(
          cid,
          expected,
          "absent from capture",
          `Required object '${id}' is absent from the '${state.state}' capture — cannot verify text is unclipped (refuse-on-absent).`,
        ),
      );
      continue;
    }
    // A present non-text required object is not this check's concern.
    if (obj.role !== "text") continue;
    if (obj.isFullyVisible !== true || obj.isPartiallyClipped === true) {
      const clip = obj.clipSide ? ` (clipped ${obj.clipSide})` : "";
      checks.push(fail(cid, expected, `isFullyVisible=${String(obj.isFullyVisible)}, isPartiallyClipped=${String(obj.isPartiallyClipped)}`, `Text object '${id}' is clipped by the frame${clip} in '${state.state}'.`));
      continue;
    }
    checks.push(pass(cid, expected, "fully visible, not clipped", `Text object '${id}' is fully visible and unclipped.`));
  }

  // No required text objects (and none absent) → NOT graded (not a vacuous pass).
  if (checks.length === 0) {
    checks.push(
      na(
        `${gate}.${state.state}`,
        "required text objects unclipped",
        "no required text objects",
        `State '${state.state}' declares no required role:text objects — nothing to clip-check (not graded).`,
      ),
    );
  }
  return makeGateReport(gate, checks);
}

// ── console-clean ───────────────────────────────────────────────────────────────

/**
 * The state's captured `errorCount` must be 0. A MISSING/uncapturable console
 * summary is a FAIL (refuse-on-absent) — an absent console can't be assumed clean.
 * `_contract` is unused but kept for evaluator-signature uniformity.
 */
export function evaluateConsoleClean(
  state: MinigameCaptureState,
  _contract: MinigameContract,
): GateReport {
  const gate = "console-clean";
  const errorCount = state.console?.errorCount;
  if (typeof errorCount !== "number" || !Number.isFinite(errorCount)) {
    return makeGateReport(gate, [
      fail(
        `${gate}.${state.state}`,
        "errorCount === 0",
        "no console summary",
        `State '${state.state}' has no console summary ({ errorCount }) — an absent console capture is a FAIL, never assumed clean.`,
      ),
    ]);
  }
  if (errorCount === 0) {
    return makeGateReport(gate, [
      pass(`${gate}.${state.state}`, "errorCount === 0", "0 errors", `State '${state.state}' captured a clean console (0 errors).`),
    ]);
  }
  return makeGateReport(gate, [
    fail(`${gate}.${state.state}`, "errorCount === 0", `${errorCount} errors`, `State '${state.state}' captured ${errorCount} console error(s) — a verified release must have a clean console.`),
  ]);
}

// ── tap-target-size (S6c-2) ──────────────────────────────────────────────────────

/**
 * Every required tap target must meet `tapTargets.minSizeDp` after a DOCUMENTED
 * px→dp conversion: `dp = min(screenRect.width, screenRect.height) / canvasScaleFactor`,
 * where `canvasScaleFactor` is the live `Canvas.scaleFactor` (the density the UI
 * was authored against). The basis is NEVER assumed: an absent/non-finite
 * `canvasScaleFactor` on a tap target is a refuse-on-absent FAIL (the live capture
 * of it is wired in S6c-3). An absent required object is a FAIL (mirror
 * control-overlap). Tap targets = required + `active` + `raycastTarget` + role ∈
 * {button,image} + rect area < 0.9 of frame (excludes full-frame backdrops).
 *
 * The px→dp grading (`gradeTapTarget`) + report shaping (`tapTargetGradeToCheck`)
 * are the SHARED, dimension-agnostic core (`mobile-touch-gates.ts`); only the
 * required-id resolution + absent-id refusal are minigame-specific and stay here.
 * The 3D top-down path grades its thumb-layout controls through the same core.
 */
export function evaluateTapTargetSize(
  state: MinigameCaptureState,
  contract: MinigameContract,
): GateReport {
  const gate = "tap-target-size";
  const resolved = requiredIdsForState(state, contract);
  if (!resolved.found) return makeGateReport(gate, [unboundStateCheck(gate, state.state)]);

  const minDp = contract.tapTargets?.minSizeDp;
  if (typeof minDp !== "number" || !Number.isFinite(minDp) || minDp <= 0) {
    return makeGateReport(gate, [
      fail(`${gate}.${state.state}`, "a positive tapTargets.minSizeDp", String(minDp), `Contract declares no usable tapTargets.minSizeDp — cannot grade tap targets (refuse-on-absent).`),
    ]);
  }

  const frameArea = state.viewport.width * state.viewport.height;
  const byId = objectsById(state);
  const checks: GateCheck[] = [];
  for (const id of resolved.ids) {
    const obj = byId.get(id);
    if (!obj) {
      checks.push(fail(`${gate}.${id}`, `≥ ${minDp}dp`, "absent from capture", `Required object '${id}' is absent from the '${state.state}' capture — cannot measure its tap target (refuse-on-absent).`));
      continue;
    }
    const grade = gradeTapTarget(
      {
        id: obj.id,
        path: obj.path,
        role: obj.role,
        active: obj.active,
        raycastTarget: obj.raycastTarget,
        screenRect: obj.screenRect,
        canvasScaleFactor: obj.canvasScaleFactor,
      },
      frameArea,
      minDp,
    );
    const check = tapTargetGradeToCheck(id, grade, {
      gate,
      stateLabel: state.state,
      minDp,
      floorLabel: `floor for age band '${contract.ageBand}'`,
      rect: normalizedRect(obj, state.viewport),
      viewport: { width: state.viewport.width, height: state.viewport.height },
      ...(obj.path ? { locator: obj.path } : {}),
    });
    if (check) checks.push(check); // null = not a graded tap target → skip
  }
  if (checks.length === 0) {
    checks.push(na(`${gate}.${state.state}`, `required tap targets ≥ ${minDp}dp`, "no tap targets", `State '${state.state}' has no required interactive tap targets to size-check (not graded).`));
  }
  return makeGateReport(gate, checks);
}

// ── no-black-bars (S6c-2) ────────────────────────────────────────────────────────

/**
 * No letterbox/pillarbox: (1) the captured `viewport.aspect` must match the
 * `visualProfile` target aspect within tolerance, and (2) the DARK uniform border
 * band (`frameFacts.uniformBorderFraction` — see frame-facts.ts; bright background
 * fill is NOT counted) must be ≤ `artifactThresholds.maxUniformBorderFraction`
 * (default strict 0 when the contract omits it). Absent frame facts (missing/
 * unreadable `<state>.png`) is a refuse-on-absent FAIL, never a pass.
 */
export function evaluateNoBlackBars(
  state: MinigameCaptureState,
  frameFacts: MinigameFrameFacts | null,
  contract: MinigameContract,
): GateReport {
  const gate = "no-black-bars";
  const checks: GateCheck[] = [];

  const profile = VISUAL_PROFILES[contract.visualProfile];
  if (!profile) {
    checks.push(fail(`${gate}.aspect.${state.state}`, "a known visualProfile", String(contract.visualProfile), `Contract visualProfile '${contract.visualProfile}' is unknown — no target aspect to check against (refuse-on-absent).`));
  } else {
    const target = profile.aspectRatio;
    const actual = state.viewport.aspect;
    if (typeof actual !== "number" || !Number.isFinite(actual) || actual <= 0) {
      checks.push(fail(`${gate}.aspect.${state.state}`, `aspect ≈ ${target.toFixed(4)}`, String(actual), `State '${state.state}' has no usable viewport.aspect — cannot check for letterboxing (refuse-on-absent).`));
    } else {
      const rel = Math.abs(actual - target) / target;
      if (rel > ASPECT_TOLERANCE) {
        checks.push(fail(`${gate}.aspect.${state.state}`, `aspect ≈ ${target.toFixed(4)} (±${(ASPECT_TOLERANCE * 100).toFixed(0)}%)`, actual.toFixed(4), `State '${state.state}' viewport aspect ${actual.toFixed(4)} differs from the '${contract.visualProfile}' target ${target.toFixed(4)} by ${(rel * 100).toFixed(1)}% — letterboxing/pillarboxing implied.`));
      } else {
        checks.push(pass(`${gate}.aspect.${state.state}`, `aspect ≈ ${target.toFixed(4)} (±${(ASPECT_TOLERANCE * 100).toFixed(0)}%)`, actual.toFixed(4), `State '${state.state}' viewport matches the '${contract.visualProfile}' aspect.`));
      }
    }
  }

  if (!frameFacts) {
    checks.push(fail(`${gate}.border.${state.state}`, "frame facts from <state>.png", "no frame facts", `State '${state.state}' has no frame facts (missing/unreadable <state>.png) — cannot check for black bars (refuse-on-absent).`));
  } else {
    const maxUniform = contract.artifactThresholds?.maxUniformBorderFraction ?? 0;
    const u = frameFacts.uniformBorderFraction;
    const c = frameFacts.dominantBorderColor;
    if (u > maxUniform + GEOMETRY_EPSILON) {
      checks.push(fail(`${gate}.border.${state.state}`, `uniform dark border ≤ ${maxUniform}`, u.toFixed(4), `State '${state.state}' has a uniform dark border band of ${(u * 100).toFixed(1)}% (> ${(maxUniform * 100).toFixed(1)}%) — a likely letterbox/black bar (border colour rgb(${c.r},${c.g},${c.b})).`));
    } else {
      checks.push(pass(`${gate}.border.${state.state}`, `uniform dark border ≤ ${maxUniform}`, u.toFixed(4), `State '${state.state}' has no significant uniform dark border (${(u * 100).toFixed(1)}%; bright background fill is not counted).`));
    }
  }
  return makeGateReport(gate, checks);
}

// ── render-frame (S6c-2) ─────────────────────────────────────────────────────────

/**
 * Frame border/coverage facts, matching the platformer `render-frame` gate's
 * semantics: `frameFacts.borderFraction ≤ artifactThresholds.maxBorderFraction`
 * (default 0.02) and `frameFacts.contentCoverage ≥ artifactThresholds.minContentCoverage`
 * (default `1 − 2·maxBorderFraction`, the platformer derivation). Absent frame
 * facts is a refuse-on-absent FAIL.
 */
export function evaluateRenderFrame(
  state: MinigameCaptureState,
  frameFacts: MinigameFrameFacts | null,
  contract: MinigameContract,
): GateReport {
  const gate = "render-frame";
  if (!frameFacts) {
    return makeGateReport(gate, [
      fail(`${gate}.${state.state}`, "frame facts from <state>.png", "no frame facts", `State '${state.state}' has no frame facts (missing/unreadable <state>.png) — cannot grade the rendered frame (refuse-on-absent).`),
    ]);
  }
  const maxBorder = contract.artifactThresholds?.maxBorderFraction ?? 0.02;
  const minCoverage = contract.artifactThresholds?.minContentCoverage ?? Math.max(0, 1 - maxBorder * 2);
  const checks: GateCheck[] = [];

  const b = frameFacts.borderFraction;
  checks.push(
    b <= maxBorder + GEOMETRY_EPSILON
      ? pass(`${gate}.border.${state.state}`, `border ≤ ${maxBorder}`, b.toFixed(4), `State '${state.state}' frame border ${(b * 100).toFixed(1)}% ≤ ${(maxBorder * 100).toFixed(1)}% — no boxed/letterboxed frame.`)
      : fail(`${gate}.border.${state.state}`, `border ≤ ${maxBorder}`, b.toFixed(4), `State '${state.state}' frame border ${(b * 100).toFixed(1)}% exceeds ${(maxBorder * 100).toFixed(1)}% — boxed/letterboxed frame.`),
  );

  const cov = frameFacts.contentCoverage;
  checks.push(
    cov + GEOMETRY_EPSILON >= minCoverage
      ? pass(`${gate}.coverage.${state.state}`, `coverage ≥ ${minCoverage.toFixed(3)}`, cov.toFixed(4), `State '${state.state}' content covers ${(cov * 100).toFixed(1)}% of the frame ≥ ${(minCoverage * 100).toFixed(1)}%.`)
      : fail(`${gate}.coverage.${state.state}`, `coverage ≥ ${minCoverage.toFixed(3)}`, cov.toFixed(4), `State '${state.state}' content covers only ${(cov * 100).toFixed(1)}% of the frame (< ${(minCoverage * 100).toFixed(1)}%) — black margins / unintended viewport rect.`),
  );
  return makeGateReport(gate, checks);
}

// ── background-fit (S6c+, pixel-based) ───────────────────────────────────────────

/**
 * A declared background card/panel must be scaled (e.g. 9-sliced) so its rendered
 * FILL envelops the content it sits behind — its `bgColor` must cover at least
 * `minBgFillFraction` of its layout rect. PIXEL-based on purpose: the RectTransform
 * alone CANNOT see an under-scaled sprite (the content can sit inside the rect
 * while the rendered fill covers only a fraction of it, leaving content on the bare
 * frame — the exact defect this gate was built to catch).
 *
 * Applicability is content-aware: a binding is graded when its background is shown
 * OR any declared `content` is visible. If nothing is shown → `not_applicable`. If
 * content IS visible but the background is not, the content renders on the bare
 * frame → FAIL, distinguishing an ABSENT capture (locator/capture omission) from a
 * present-but-hidden background. A shown background with NO frame image is a
 * refuse-on-absent FAIL (no pixels to measure). Otherwise PASS iff fill ≥ floor.
 */
export function evaluateBackgroundFit(
  state: MinigameCaptureState,
  image: DecodedImage | null,
  contract: MinigameContract,
): GateReport {
  const gate = "background-fit";
  const bindings = contract.containers ?? [];
  if (bindings.length === 0) {
    // The validator refuses background-fit without containers; guard anyway so the
    // gate never silently passes when it has nothing wired.
    return makeGateReport(gate, [
      fail(`${gate}.${state.state}`, "≥1 container binding", "none declared", `'background-fit' is enabled but the contract declares no containers — nothing to verify (refuse).`),
    ]);
  }

  const byId = objectsById(state);
  const checks: GateCheck[] = [];
  for (const binding of bindings) {
    const cid = `${gate}.${binding.background}`;
    const minFill = binding.minBgFillFraction ?? DEFAULT_MIN_BG_FILL_FRACTION;
    const expected = `fill ≥ ${(minFill * 100).toFixed(0)}% of rect`;
    const bg = byId.get(binding.background);
    const bgShown = !!bg && bg.active && bg.isVisible;
    // The binding is APPLICABLE in a state when the background is shown OR any of
    // its declared content is visible — visible content implies its background must
    // be on screen behind it (the content can't legitimately float on the frame).
    const contentVisible = (binding.content ?? []).some((id) => {
      const o = byId.get(id);
      return !!o && o.active && o.isVisible;
    });

    if (!bgShown) {
      if (!contentVisible) {
        // Nothing for this container is on screen here → not this state's concern.
        checks.push({
          id: cid,
          expected,
          actual: "not shown in this state",
          status: "not_applicable",
          detail: `Background '${binding.background}' (and any declared content) is not shown in '${state.state}' — background-fit not graded here.`,
        });
        continue;
      }
      // Content IS visible but its background is not → the content renders on the
      // bare frame. Distinguish an ABSENT capture (locator/capture omission — a
      // real gap to fail on) from a present-but-hidden background.
      const reason = !bg ? "background absent from capture" : "background inactive/hidden";
      checks.push(
        fail(
          cid,
          expected,
          reason,
          `Background '${binding.background}' is ${reason} in '${state.state}' while its content is shown — the content renders on the bare frame (no enveloping background).`,
        ),
      );
      continue;
    }
    if (image === null) {
      checks.push(fail(cid, expected, "no frame image", `Background '${binding.background}' is shown in '${state.state}' but the <state>.png is missing/unreadable — cannot measure its fill (refuse-on-absent).`));
      continue;
    }
    if (!isFiniteRect(bg.screenRect)) {
      checks.push(fail(cid, expected, "no usable rect", `Background '${binding.background}' has no usable screenRect — cannot measure its fill.`));
      continue;
    }
    const color = (binding.bgColor && parseHexColor(binding.bgColor)) || DEFAULT_BG_FILL;
    const fillFraction = backgroundFillFraction(image, bg.screenRect, color);
    const actual = `${(fillFraction * 100).toFixed(1)}% fill`;
    if (fillFraction + GEOMETRY_EPSILON < minFill) {
      checks.push(fail(cid, expected, actual, `Background '${binding.background}' fill covers only ${(fillFraction * 100).toFixed(1)}% of its layout rect in '${state.state}' (< ${(minFill * 100).toFixed(0)}%) — the sprite is not scaled/9-sliced to envelop its content (content sits on the bare frame).`));
    } else {
      checks.push(pass(cid, expected, actual, `Background '${binding.background}' fill covers ${(fillFraction * 100).toFixed(1)}% of its rect ≥ ${(minFill * 100).toFixed(0)}% — it envelops its content.`));
    }
  }
  return makeGateReport(gate, checks);
}

// ── background-coverage (Phase 5, world-space GEOMETRY) ──────────────────────────

/** The gate name for the background-coverage check. */
export const BACKGROUND_COVERAGE_GATE = "background-coverage";
/** The gate name for visible background cut-edge / seam detection. */
export const BACKGROUND_SEAM_GATE = "background-seam";

/**
 * Deterministic GEOMETRY background-coverage gate (Phase 5), graded per DEVICE ASPECT.
 *
 * The defect it catches (real, from CountTheFruits): a sky sprite whose world half-width
 * (9.6) is narrower than the camera's world half-width at a WIDE aspect (orthoSize 5 ×
 * 2.22 = 11.1) → uncovered/gray strips at the frame edges on tall phones, invisible at
 * 16:9. This is GEOMETRY, not pixels: a pixel/clear-color gate false-fails when edge art
 * happens to match the clear color, so we test world-rect containment instead.
 *
 * Build the camera's world VIEW RECT at this aspect (`halfW = orthoSize × aspect`,
 * `halfH = orthoSize`, centred on the camera position), grid-sample it COVERAGE_GRID²
 * points, and require each sample to lie inside ≥1 layer AABB. Any uncovered sample →
 * FAIL, reporting which side(s) have the gap and the worst sample's distance (world
 * units) past the nearest layer edge.
 *
 * Refuse-on-absent (CLAUDE.md "Verification / supervisor invariants"): missing
 * `background.json` / camera / empty layers → FAIL (never assume covered). A PERSPECTIVE
 * camera is out of scope → `not_applicable` (refuse to fake a verdict), said loudly.
 */
export function evaluateBackgroundCoverage(
  backgroundData: BackgroundData | null,
  aspect: number,
): GateReport {
  const gate = BACKGROUND_COVERAGE_GATE;
  const cid = `${gate}`;
  const expected = "every camera-view sample inside ≥1 background layer";

  if (!backgroundData) {
    return makeGateReport(gate, [
      fail(cid, expected, "no background.json", "No background.json was captured — cannot verify background coverage (an absent geometry pack is a FAIL, never assumed covered)."),
    ]);
  }
  const { camera, layers } = backgroundData;
  if (!camera || typeof camera.orthoSize !== "number" || !Number.isFinite(camera.orthoSize) || camera.orthoSize <= 0 || !camera.position || typeof camera.position.x !== "number" || typeof camera.position.y !== "number") {
    return makeGateReport(gate, [
      fail(cid, expected, "no usable camera geometry", "background.json has no usable camera (orthoSize/position) — cannot build the view rect to test coverage (refuse-on-absent)."),
    ]);
  }
  if (camera.orthographic === false) {
    // Perspective backgrounds are out of scope — say so loudly rather than fake a verdict.
    return makeGateReport(gate, [
      na(cid, expected, "perspective camera", "The background camera is PERSPECTIVE — world-space coverage is only defined for an orthographic camera, so this check is not applicable (not silently passed)."),
    ]);
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    return makeGateReport(gate, [
      fail(cid, expected, "no background layers", "background.json declares no background layers — there is nothing to cover the camera view (a FAIL, never assumed covered)."),
    ]);
  }
  if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0) {
    return makeGateReport(gate, [
      fail(cid, expected, `aspect=${String(aspect)}`, "The device aspect is not a usable positive number — cannot build the camera view rect (refuse-on-absent)."),
    ]);
  }

  // World view rect + grid-coverage are SHARED with the discovery helper (coverage-geometry.ts)
  // so a set discovery calls "covered" is exactly what this gate passes (no geometry drift).
  const { left, right, bottom, top } = viewRect(camera, aspect);
  const stats = coverageStats(layers, camera, aspect);
  const uncoveredCount = stats.uncovered;
  const total = stats.total;
  const worstGap = stats.worstGap;
  const worstSide = stats.worstSide;
  const sideGaps = stats.sideGaps;

  const layersLabel = layers.map((l) => l.locator).join(", ");
  const rectLabel = `view rect x∈[${left.toFixed(2)},${right.toFixed(2)}], y∈[${bottom.toFixed(2)},${top.toFixed(2)}] (orthoSize ${camera.orthoSize} × aspect ${aspect.toFixed(3)})`;

  if (uncoveredCount === 0) {
    return makeGateReport(gate, [
      pass(cid, expected, `${total}/${total} samples covered`, `The background layers (${layersLabel}) cover the whole camera view at aspect ${aspect.toFixed(3)} (${rectLabel}).`),
    ]);
  }

  const gapSides = (["left", "right", "top", "bottom"] as const).filter((s) => sideGaps[s] > 0);
  return makeGateReport(gate, [
    fail(
      cid,
      expected,
      `${uncoveredCount}/${total} samples uncovered`,
      `The background doesn't cover the camera view at aspect ${aspect.toFixed(3)}: ${uncoveredCount} of ${total} sampled points fall outside every background layer — gap on the ${gapSides.join("/")} edge${gapSides.length === 1 ? "" : "s"} (worst sample ${worstGap.toFixed(2)} world units past the nearest layer, on the ${worstSide} edge). ${rectLabel}. Widen/extend the background layers (${layersLabel}) to envelop the view at this aspect.`,
    ),
  ]);
}

/**
 * Depth-aware background seam gate: the frontmost background art must bleed past
 * the bottom/left/right camera edges, or be occluded by an even-front layer, so
 * its cut edge cannot show inside the frame. The top edge is exempt because it is
 * often an intentional silhouette/horizon.
 */
export function evaluateBackgroundSeam(
  backgroundData: BackgroundData | null,
  aspect: number,
  viewport?: { width: number; height: number },
): GateReport {
  const gate = BACKGROUND_SEAM_GATE;
  const cid = `${gate}`;
  const expected = "background layer cut edges bleed past bottom/left/right frame edges";

  if (!backgroundData) {
    return makeGateReport(gate, [
      fail(cid, expected, "no background.json", "No background.json was captured — cannot verify background seams (an absent geometry pack is a FAIL, never assumed seamless)."),
    ]);
  }
  const { camera, layers } = backgroundData;
  if (!camera || typeof camera.orthoSize !== "number" || !Number.isFinite(camera.orthoSize) || camera.orthoSize <= 0 || !camera.position || typeof camera.position.x !== "number" || typeof camera.position.y !== "number") {
    return makeGateReport(gate, [
      fail(cid, expected, "no usable camera geometry", "background.json has no usable camera (orthoSize/position) — cannot build the view rect to test seams (refuse-on-absent)."),
    ]);
  }
  if (camera.orthographic === false) {
    return makeGateReport(gate, [
      na(cid, expected, "perspective camera", "The background camera is PERSPECTIVE — world-space seam detection is only defined for an orthographic camera, so this check is not applicable (not silently passed)."),
    ]);
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    return makeGateReport(gate, [
      fail(cid, expected, "no background layers", "background.json declares no background layers — there is nothing to test for seams (a FAIL, never assumed seamless)."),
    ]);
  }
  if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0) {
    return makeGateReport(gate, [
      fail(cid, expected, `aspect=${String(aspect)}`, "The device aspect is not a usable positive number — cannot build the camera view rect (refuse-on-absent)."),
    ]);
  }
  const missing = layers.filter((l) => !l.order).map((l) => l.locator);
  if (missing.length > 0) {
    return makeGateReport(gate, [
      fail(
        cid,
        expected,
        "missing render order",
        `background.json lacks render-order for ${missing.join(", ")} — re-capture with a current bridge before enabling background-seam (old background packs cannot prove seams).`,
      ),
    ]);
  }
  const unsupported = renderOrderUnsupportedReason(layers);
  if (unsupported) {
    return makeGateReport(gate, [
      fail(cid, expected, "unsupported render order", `${unsupported}. Put background layers on one sorting layer or disable background-seam until sorting-layer order can be resolved.`),
    ]);
  }

  const { rect, findings } = seamFindings(layers, camera, aspect);
  const rectLabel = `view rect x∈[${rect.left.toFixed(2)},${rect.right.toFixed(2)}], y∈[${rect.bottom.toFixed(2)},${rect.top.toFixed(2)}] (orthoSize ${camera.orthoSize} × aspect ${aspect.toFixed(3)})`;
  if (findings.length === 0) {
    return makeGateReport(gate, [
      pass(cid, expected, "no visible cut edge", `The background layers bleed or are occluded past the bottom/left/right frame edges at aspect ${aspect.toFixed(3)} (${rectLabel}).`),
    ]);
  }

  const sorted = findings.slice().sort((a, b) => b.exposedWorldUnits - a.exposedWorldUnits);
  const bits = sorted.map((f) => `${f.layer.locator} ${f.edge} edge exposed by ${f.exposedWorldUnits.toFixed(2)}u`);
  // Structured geometry so the report can DRAW each cut edge (a red line + shaded exposed
  // strip) over the gameplay screenshot — one segment per flagged layer, normalized
  // TOP-origin (image space). `screenshotKey` is resolved later by verify-minigame (the
  // seam gate has no screen of its own). This is the ONLY change on the fail path; the
  // verdict + message above are byte-identical.
  const seamAnnotation: SeamAnnotation = {
    ...(viewport ? { viewport } : {}),
    segments: sorted.map((f) => seamSegment(f, rect)),
  };
  const seamCheck: GateCheck = {
    ...fail(
      cid,
      expected,
      `${findings.length} visible seam(s)`,
      `A background layer's cut edge is visible inside the frame at aspect ${aspect.toFixed(3)}: ${bits.join("; ")}. Extend the layer past the frame edge or cover it with a closer layer. ${rectLabel}.`,
    ),
    seamAnnotation,
  };
  return makeGateReport(gate, [seamCheck]);
}

/**
 * The `(state, contract)` deterministic evaluators (no frame facts needed).
 * S6c-1 checks + S6c-2's `tap-target-size`.
 */
export const MINIGAME_GATE_EVALUATORS: Record<
  string,
  (state: MinigameCaptureState, contract: MinigameContract) => GateReport
> = {
  "required-in-frame": evaluateRequiredInFrame,
  "safe-area": evaluateSafeArea,
  "safe-area-sweep": evaluateSafeAreaSweep,
  "control-overlap": evaluateControlOverlap,
  "text-clipping": evaluateTextClipping,
  "console-clean": evaluateConsoleClean,
  "tap-target-size": evaluateTapTargetSize,
};

/**
 * The `(state, frameFacts, contract)` deterministic evaluators (S6c-2 frame gates
 * — they need the per-state `<state>.png` frame facts the runner produces).
 */
export const MINIGAME_FRAME_EVALUATORS: Record<
  string,
  (
    state: MinigameCaptureState,
    frameFacts: MinigameFrameFacts | null,
    contract: MinigameContract,
  ) => GateReport
> = {
  "no-black-bars": evaluateNoBlackBars,
  "render-frame": evaluateRenderFrame,
};

/**
 * The `(state, image, contract)` deterministic evaluators (they need the decoded
 * `<state>.png` pixels, not just precomputed frame facts).
 */
export const MINIGAME_IMAGE_EVALUATORS: Record<
  string,
  (
    state: MinigameCaptureState,
    image: DecodedImage | null,
    contract: MinigameContract,
  ) => GateReport
> = {
  "background-fit": evaluateBackgroundFit,
};

/**
 * Contract deterministic checks deferred to later S6 slices (surfaced by the runner
 * as `not_applicable`, visibly NOT a silent pass). Now EMPTY: S6c-2 implemented
 * `tap-target-size`/`no-black-bars`/`render-frame`, and S6d implements
 * `interaction-flow` as a cross-state gate (`evaluateInteractionFlow`, skipped in
 * the per-state loop), not a deferred per-state stub.
 */
export const DEFERRED_MINIGAME_CHECKS: ReadonlySet<string> = new Set<string>([]);
