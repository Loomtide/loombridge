/**
 * Shared, DIMENSION-AGNOSTIC mobile-touch verification gates (RCL-F03/RCL-F04).
 *
 * Mobile-touch coverage — the safe-area sweep, tap-target-size, and multi-aspect
 * grading — was born in the 2D `minigame` path (S6c). A 3D top-down build (the
 * dogfood case authored a full thumb layout: twin sticks, fire, reload, ability
 * buttons) got NONE of those checks: the only gate path that graded touch HUD was
 * coupled to `MinigameContract`/`MinigameCaptureState`. This module lifts the
 * load-bearing geometry into ONE shared layer both paths call, so the same gate
 * that protects a 2D kids minigame protects a 3D top-down thumb layout.
 *
 * What is shared here (the genuine, single implementation):
 *   - `safeAreaOverflow`  — the per-edge overflow math (was in minigame evaluators).
 *   - `gradeSafeAreaSweep` — the candidate-selection + overflow + hierarchy-dedup
 *                            algorithm, over a NEUTRAL element list (no contract).
 *   - `buildSafeAreaSweepChecks` — the report-shaping (the exact `GateCheck`s the
 *                            2D sweep has always emitted), reused verbatim by 3D.
 *   - `gradeTapTarget` / `tapTargetGradeToCheck` — px→dp sizing + report shaping.
 *   - `runTopDownTouchGates` — the 3D entry point that grades captured thumb-layout
 *                            HUD rects across device aspects.
 *
 * Honest discipline (CLAUDE.md "Verification / supervisor invariants"): the touch
 * gates REFUSE — never silently pass — when the required touch/HUD capture is
 * absent. A 3D build with no thumb-layout capture is `blocked` (unsupported), never
 * a green. An absent `canvasScaleFactor` refuses the tap-target check (no density
 * basis may be assumed). These mirror the 2D path's refuse-on-absent rules exactly,
 * because they are now the SAME code.
 *
 * Capture convention (must match `unity_ui_get_screen_rects`): screen origin is
 * BOTTOM-LEFT, `screenRect` is px, `rect` is normalized 0..1. This module is PURE
 * over captured rects — the live wiring (drive a held touch via the RCL-T13
 * `dispatch_pointer` hold + EventSystem, then capture the resulting rects) belongs
 * to the capture layer; the gate logic never touches the bridge.
 */

import {
  makeGateReport,
  worstStatus,
  type CheckStatus,
  type GateCheck,
  type GateCheckAnnotation,
  type GateReport,
} from "./gates/types.js";

/** Floating-point slack for normalized geometry comparisons (matches the 2D evaluators). */
export const TOUCH_GEOMETRY_EPSILON = 1e-6;

/** A full-bleed background must reach within this fraction of every frame edge. */
export const SWEEP_EDGE_TOUCH = 0.02;

/** uGUI roles that can be a tap target (matches the 2D path). */
export const TAP_TARGET_ROLES: ReadonlySet<string> = new Set(["button", "image"]);

/** A tap-target candidate must occupy less than this fraction of the frame (excludes full-frame backdrops). */
export const TAP_TARGET_MAX_AREA_FRACTION = 0.9;

/** Which frame edge an overflow is measured against. */
export type TouchEdge = "left" | "right" | "bottom" | "top";

/** An axis-aligned rectangle (normalized 0..1 OR pixel, depending on use). */
export interface TouchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The resolved safe boundaries (fractions of the frame), after applying insets. */
export interface SafeBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** Safe-area inset fractions of the frame (top/bottom/left/right), default 0. */
export interface SafeAreaInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

// ── shared geometry primitives ───────────────────────────────────────────────────

/**
 * The worst safe-area overflow of a normalized rect against already-resolved safe
 * boundaries (`safe.left/right/bottom/top`). Returns `{ worst, edge }`; the `edge`
 * tie-break order is left→right→bottom→top (it only NAMES the edge, never affects the
 * verdict). The single implementation shared by `safe-area`, `safe-area-sweep`, and
 * the 3D top-down sweep.
 */
export function safeAreaOverflow(
  rect: { x: number; y: number; width: number; height: number },
  safe: SafeBounds,
  _tol: number,
): { worst: number; edge: TouchEdge } {
  const leftOver = Math.max(0, safe.left - rect.x);
  const rightOver = Math.max(0, rect.x + rect.width - safe.right);
  const bottomOver = Math.max(0, safe.bottom - rect.y);
  const topOver = Math.max(0, rect.y + rect.height - safe.top);
  const worst = Math.max(leftOver, rightOver, bottomOver, topOver);
  const edge =
    worst === leftOver ? "left" : worst === rightOver ? "right" : worst === bottomOver ? "bottom" : "top";
  return { worst, edge };
}

/** Resolve `{left,right,bottom,top}` safe boundaries from inset fractions (default = full frame). */
export function resolveSafeBounds(insets: SafeAreaInsets | undefined): SafeBounds {
  const i = insets ?? {};
  return {
    left: i.left ?? 0,
    right: 1 - (i.right ?? 0),
    bottom: i.bottom ?? 0,
    top: 1 - (i.top ?? 0),
  };
}

/** The human label the report cards use for a safe-area band (`x∈[…], y∈[…] (≤tol overflow)`). */
export function safeAreaLabel(safe: SafeBounds, tol: number): string {
  return `x∈[${safe.left.toFixed(3)},${safe.right.toFixed(3)}], y∈[${safe.bottom.toFixed(3)},${safe.top.toFixed(3)}] (≤${tol} overflow)`;
}

/** True iff `ancestor` is a strict hierarchy-path ancestor of `descendant`. */
export function isAncestorPath(ancestor: string | undefined, descendant: string | undefined): boolean {
  if (!ancestor || !descendant || ancestor === descendant) return false;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return descendant.startsWith(prefix);
}

/**
 * True iff the rect reaches (or exceeds) all four frame edges — the honest "is this
 * the full-bleed background" signal (only backgrounds may sit outside the safe area).
 * Area alone mis-classifies a narrow off-frame bleeder or a near-full-screen modal.
 */
export function reachesAllFrameEdges(r: TouchRect): boolean {
  return (
    r.x <= SWEEP_EDGE_TOUCH &&
    r.y <= SWEEP_EDGE_TOUCH &&
    r.x + r.width >= 1 - SWEEP_EDGE_TOUCH &&
    r.y + r.height >= 1 - SWEEP_EDGE_TOUCH
  );
}

// ── neutral safe-area-sweep core (shared by 2D + 3D) ──────────────────────────────

/**
 * One HUD element fed to the sweep — the dimension-agnostic projection of a captured
 * uGUI object (2D `MinigameCaptureObject`) OR a 3D top-down thumb-layout control.
 * `rect` is the element's normalized 0..1 rect (bottom-left origin); a null rect means
 * "no usable geometry" (skipped, not refused — discovered, not declared).
 */
export interface SweepElement {
  id: string;
  path?: string;
  role?: string;
  isVisible?: boolean;
  raycastTarget?: boolean;
  /** Normalized 0..1 rect, bottom-left origin. Null = no usable geometry (skip). */
  rect: TouchRect | null;
}

/** Options that classify which swept elements are owned/exempt/background. */
export interface SweepOptions {
  safe: SafeBounds;
  tol: number;
  /** Ids already graded by the `safe-area` (required-objects) gate — not double-swept. */
  ownedIds?: ReadonlySet<string>;
  /** Paths of owned widgets — a candidate INSIDE one (a child) is skipped. */
  ownedPaths?: readonly string[];
  /** Element is waived by an explicit exempt list (surfaced as a visible "waived" note). */
  isExempt?: (el: SweepElement) => boolean;
  /** Element is declared decorative background (silently exempt unless interactive). */
  isBackground?: (el: SweepElement) => boolean;
}

/** A flagged sweep overflow (after hierarchy dedup). */
export interface SweepViolation {
  id: string;
  path: string;
  edge: TouchEdge;
  fraction: number;
  rect: TouchRect;
  interactive: boolean;
}

/** The neutral sweep result both report builders consume. */
export interface SweepResult {
  /** Overflowing HUD elements (deduped: outermost widget only, per edge). */
  flagged: SweepViolation[];
  /** Exempt elements that WOULD have overflowed — surfaced so an exemption is never silent. */
  waived: { id: string; path: string; edge: TouchEdge; fraction: number }[];
  /** Declared-background element ids that WOULD have overflowed (one summary note). */
  backgroundExempt: string[];
  /** Count of graded (non-exempt, non-background, non-owned) candidates. */
  candidateCount: number;
}

/**
 * Grade EVERY visible rendered HUD element against the safe area — the candidate
 * selection + overflow + hierarchy-dedup algorithm, over a NEUTRAL element list.
 * Identical to the 2D minigame sweep (the 2D evaluator now delegates here), so a 3D
 * top-down thumb layout is graded by exactly the same code.
 */
export function gradeSafeAreaSweep(elements: readonly SweepElement[], opts: SweepOptions): SweepResult {
  const { safe, tol } = opts;
  const ownedIds = opts.ownedIds ?? new Set<string>();
  const ownedPaths = opts.ownedPaths ?? [];
  const isExempt = opts.isExempt ?? (() => false);
  const isBackground = opts.isBackground ?? (() => false);

  type Flagged = SweepViolation;
  const flagged: Flagged[] = [];
  const waived: SweepResult["waived"] = [];
  const backgroundExempt: string[] = [];
  let candidateCount = 0;

  for (const o of elements) {
    if (o.isVisible !== true) continue; // not on screen
    if (o.role === "container") continue; // a layout container has no Graphic
    if (ownedIds.has(o.id)) continue; // owned by `safe-area`
    if (o.path && ownedPaths.some((rp) => isAncestorPath(rp, o.path))) continue; // inside an owned widget
    const rect = o.rect;
    if (!rect) continue; // discovered, not declared — no usable geometry, just skip
    if (reachesAllFrameEdges(rect)) continue; // a full-bleed background may bleed past the safe area

    const { worst, edge } = safeAreaOverflow(rect, safe, tol);
    const overflows = worst > tol + TOUCH_GEOMETRY_EPSILON;

    // Declared decorative background: not graded (may bleed). GUARD: a tappable control
    // (raycastTarget) is NEVER background — honoring a too-broad/tampered declaration for an
    // interactive element would let it permanently exempt a real control (a verdict-level false
    // green). So an interactive element falls through to be FLAGGED.
    if (o.path && isBackground(o) && o.raycastTarget !== true) {
      if (overflows) backgroundExempt.push(o.id);
      continue;
    }

    // Explicit exempt list: not graded — but if it WOULD have failed, surface it (never silent).
    if (isExempt(o)) {
      if (overflows) waived.push({ id: o.id, path: o.path ?? "", edge, fraction: worst });
      continue;
    }

    candidateCount += 1;
    if (!overflows) continue; // inside the safe area

    flagged.push({
      id: o.id,
      path: o.path ?? "",
      edge,
      fraction: worst,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      interactive: o.raycastTarget === true,
    });
  }

  // Dedup by hierarchy: suppress a flagged candidate whose path is a strict descendant of
  // another flagged candidate overflowing the SAME edge (report the outermost widget only).
  const surviving = flagged.filter(
    (cand) =>
      !flagged.some(
        (other) =>
          other !== cand &&
          other.edge === cand.edge &&
          isAncestorPath(other.path, cand.path),
      ),
  );

  return { flagged: surviving, waived, backgroundExempt, candidateCount };
}

/** Context the sweep report builder needs to shape its `GateCheck`s. */
export interface SweepReportContext {
  gate: string;
  /** Logical state label, e.g. "active" (2D) or "topdown@<device>" (3D). */
  stateLabel: string;
  safe: SafeBounds;
  tol: number;
  /** Inset fractions for the drawable annotation. */
  safeInsets: { top: number; bottom: number; left: number; right: number };
  viewport: { width: number; height: number };
}

/**
 * Shape a `SweepResult` into the exact `GateCheck`s the 2D sweep has always emitted —
 * reused verbatim by the 3D top-down sweep so both produce identical findings.
 */
export function buildSafeAreaSweepChecks(result: SweepResult, ctx: SweepReportContext): GateCheck[] {
  const { gate, stateLabel, safe, tol, safeInsets, viewport } = ctx;
  const safeLabel = safeAreaLabel(safe, tol);

  const fails: GateCheck[] = result.flagged.map((f) => {
    const annotation: GateCheckAnnotation = {
      rect: { x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height },
      safeInsets,
      viewport: { width: viewport.width, height: viewport.height },
      ...(f.path ? { locator: f.path } : {}),
      overflow: { edge: f.edge, fraction: f.fraction },
      ...(f.interactive ? { interactive: true } : {}),
    };
    return {
      id: `${gate}.${f.id}`,
      expected: safeLabel,
      actual: `x∈[${f.rect.x.toFixed(3)},${(f.rect.x + f.rect.width).toFixed(3)}], y∈[${f.rect.y.toFixed(3)},${(f.rect.y + f.rect.height).toFixed(3)}]`,
      status: "fail",
      detail: `'${f.id}' sits outside the safe area on the ${f.edge} edge by ${f.fraction.toFixed(3)} of frame (> ${tol}) in '${stateLabel}' — only backgrounds may bleed past the safe area.`,
      annotation,
    };
  });

  const notes: GateCheck[] = result.waived.map((w) => ({
    id: `${gate}.${w.id}`,
    expected: safeLabel,
    actual: "waived by safeAreaExempt",
    status: "not_applicable",
    detail: `'${w.id}' sits outside the safe area on the ${w.edge} edge by ${w.fraction.toFixed(3)} of frame, but is WAIVED by contract.safeAreaExempt (not graded — surfaced so the exemption is never silent).`,
  }));
  if (result.backgroundExempt.length > 0) {
    const sample = result.backgroundExempt.slice(0, 3).join(", ");
    const more = result.backgroundExempt.length > 3 ? ` +${result.backgroundExempt.length - 3} more` : "";
    notes.push({
      id: `${gate}.${stateLabel}.background`,
      expected: safeLabel,
      actual: `${result.backgroundExempt.length} background element(s) exempted`,
      status: "not_applicable",
      detail: `${result.backgroundExempt.length} element(s) outside the safe area in '${stateLabel}' (${sample}${more}) were exempted as declared decorative background (contract.safeAreaBackground) — not graded; surfaced so a too-broad safeAreaBackground is never silent.`,
    });
  }

  if (fails.length > 0) return [...fails, ...notes];
  if (result.candidateCount > 0) {
    return [
      {
        id: `${gate}.${stateLabel}`,
        expected: safeLabel,
        actual: `${result.candidateCount} swept HUD element(s) inside the safe area`,
        status: "pass",
        detail: `All ${result.candidateCount} swept HUD elements are inside the safe area in '${stateLabel}'.`,
      },
      ...notes,
    ];
  }
  if (notes.length > 0) return notes;
  return [
    {
      id: `${gate}.${stateLabel}`,
      expected: safeLabel,
      actual: "no sweepable HUD elements",
      status: "not_applicable",
      detail: `No sweepable HUD elements in '${stateLabel}' — nothing to sweep (not graded).`,
    },
  ];
}

// ── neutral tap-target-size core (shared by 2D + 3D) ──────────────────────────────

/** A neutral tap-target element (a captured uGUI control projected dimension-agnostically). */
export interface TapTargetElement {
  id: string;
  path?: string;
  role?: string;
  active?: boolean;
  raycastTarget?: boolean;
  /** Pixel-space rect (origin bottom-left). */
  screenRect?: TouchRect;
  /** Live `Canvas.scaleFactor` — the px→dp density basis. Absent → refuse (never assumed). */
  canvasScaleFactor?: number;
  /** Normalized rect for the fail annotation (optional). */
  rect?: TouchRect | null;
}

function isFiniteRect(r: TouchRect | undefined): r is TouchRect {
  return (
    !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** True iff this object is a graded tap target (selection rule — documented, shared with 2D). */
export function isTouchTarget(el: TapTargetElement, frameArea: number): boolean {
  return (
    el.active === true &&
    el.raycastTarget === true &&
    typeof el.role === "string" &&
    TAP_TARGET_ROLES.has(el.role) &&
    isFiniteRect(el.screenRect) &&
    frameArea > 0 &&
    el.screenRect!.width * el.screenRect!.height < TAP_TARGET_MAX_AREA_FRACTION * frameArea
  );
}

/** The px→dp conversion: `dp = min(width,height) / canvasScaleFactor`. Null when the basis is missing. */
export function tapTargetDp(screenRect: TouchRect, canvasScaleFactor: number | undefined): number | null {
  if (typeof canvasScaleFactor !== "number" || !Number.isFinite(canvasScaleFactor) || canvasScaleFactor <= 0) {
    return null;
  }
  return Math.min(screenRect.width, screenRect.height) / canvasScaleFactor;
}

/** The outcome of grading one tap target. */
export type TapTargetGrade =
  | { kind: "not-a-target" }
  | { kind: "no-scale-factor" }
  | { kind: "below"; dp: number; minEdgePx: number; scaleFactor: number }
  | { kind: "ok"; dp: number; minEdgePx: number; scaleFactor: number };

/** Grade one element's tap-target size against `minDp`. Shared by 2D + 3D. */
export function gradeTapTarget(el: TapTargetElement, frameArea: number, minDp: number): TapTargetGrade {
  if (!isTouchTarget(el, frameArea)) return { kind: "not-a-target" };
  const sf = el.canvasScaleFactor;
  const dp = tapTargetDp(el.screenRect!, sf);
  if (dp === null) return { kind: "no-scale-factor" };
  const minEdgePx = Math.min(el.screenRect!.width, el.screenRect!.height);
  if (dp + TOUCH_GEOMETRY_EPSILON < minDp) return { kind: "below", dp, minEdgePx, scaleFactor: sf as number };
  return { kind: "ok", dp, minEdgePx, scaleFactor: sf as number };
}

/** Context for shaping a tap-target `GateCheck` (the `floorLabel` lets 2D say "age band 'X'"). */
export interface TapTargetCheckContext {
  gate: string;
  stateLabel: string;
  minDp: number;
  /** e.g. "floor for age band '3-5'" (2D) or "floor for the touch profile" (3D). */
  floorLabel: string;
  rect?: TouchRect | null;
  viewport?: { width: number; height: number };
  locator?: string;
}

/**
 * Shape a `TapTargetGrade` into the exact `GateCheck` the 2D path emits. Returns null
 * for `not-a-target` (the caller continues — it isn't this check's concern). Absent
 * required objects are the caller's concern (a 3D thumb layout has no required-id list).
 */
export function tapTargetGradeToCheck(
  id: string,
  grade: TapTargetGrade,
  ctx: TapTargetCheckContext,
): GateCheck | null {
  const { gate, stateLabel, minDp, floorLabel } = ctx;
  if (grade.kind === "not-a-target") return null;
  if (grade.kind === "no-scale-factor") {
    return {
      id: `${gate}.${id}`,
      expected: `≥ ${minDp}dp`,
      actual: "no canvasScaleFactor",
      status: "fail",
      detail: `Tap target '${id}' has no canvasScaleFactor — the px→dp density basis is missing, so its size can't be graded (refuse-on-absent; captured live in S6c-3).`,
    };
  }
  if (grade.kind === "below") {
    const annotation: GateCheckAnnotation | undefined = ctx.rect
      ? {
          rect: { x: ctx.rect.x, y: ctx.rect.y, width: ctx.rect.width, height: ctx.rect.height },
          ...(ctx.viewport ? { viewport: { width: ctx.viewport.width, height: ctx.viewport.height } } : {}),
          ...(ctx.locator ? { locator: ctx.locator } : {}),
          tapTarget: { actualDp: grade.dp, minDp },
        }
      : undefined;
    return {
      id: `${gate}.${id}`,
      expected: `≥ ${minDp}dp`,
      actual: `${grade.dp.toFixed(1)}dp`,
      status: "fail",
      detail: `Tap target '${id}' is ${grade.dp.toFixed(1)}dp (min edge ${grade.minEdgePx.toFixed(0)}px ÷ scale ${grade.scaleFactor}) — below the ${minDp}dp ${floorLabel} in '${stateLabel}'.`,
      ...(annotation ? { annotation } : {}),
    };
  }
  return {
    id: `${gate}.${id}`,
    expected: `≥ ${minDp}dp`,
    actual: `${grade.dp.toFixed(1)}dp`,
    status: "pass",
    detail: `Tap target '${id}' is ${grade.dp.toFixed(1)}dp (min edge ${grade.minEdgePx.toFixed(0)}px ÷ scale ${grade.scaleFactor}) ≥ ${minDp}dp.`,
  };
}

// ── 3D top-down entry point ───────────────────────────────────────────────────────

export const SAFE_AREA_SWEEP_GATE = "safe-area-sweep";
export const TAP_TARGET_SIZE_GATE = "tap-target-size";

/** A captured device frame for the 3D top-down path: viewport + the swept HUD elements. */
export interface TopDownTouchCapture {
  viewport: { width: number; height: number; aspect?: number };
  /** Every captured uGUI HUD element (origin bottom-left). */
  elements: TopDownTouchElement[];
}

/** One captured HUD element for the 3D path (carries both norm + pixel geometry). */
export interface TopDownTouchElement {
  id: string;
  path?: string;
  role?: string;
  active?: boolean;
  isVisible?: boolean;
  raycastTarget?: boolean;
  /** Normalized 0..1 rect, bottom-left origin (for the safe-area sweep). */
  rect?: TouchRect | null;
  /** Pixel-space rect (for tap-target sizing). */
  screenRect?: TouchRect;
  canvasScaleFactor?: number;
}

/** A device aspect to grade across (the multi-aspect dimension). */
export interface TouchDevice {
  id: string;
  label?: string;
  width: number;
  height: number;
}

/** The 3D top-down touch input: config + per-device captures (a device with no capture refuses). */
export interface TopDownTouchInput {
  /** Safe-area insets + tolerance (default full-frame, 0 tolerance). */
  safeArea?: { insets?: SafeAreaInsets; maxOverflowFraction?: number };
  /** Minimum tap-target size in dp. Omit to skip tap-target grading (sweep only). */
  tapTargets?: { minSizeDp: number };
  /** The device aspects to grade across. EMPTY → blocked (cannot grade a touch layout). */
  devices: TouchDevice[];
  /** Captured HUD per device id. A missing/null entry for a device is a capture gap → refuse. */
  capturesByDevice: Record<string, TopDownTouchCapture | null | undefined>;
  /** Element ids/paths waived from the sweep (an exempt that would fail is surfaced). */
  exempt?: readonly string[];
  /** Declared decorative-background path patterns (exact / ancestor / trailing-`*` glob). */
  background?: readonly string[];
}

/** The 3D top-down touch verdict. `blocked` is the honest "unsupported — no capture" signal. */
export interface TopDownTouchVerdict {
  /** Overall status. NEVER "pass" when `blocked` — an absent capture is unsupported, not green. */
  status: CheckStatus;
  /** True when NO device yielded a gradeable touch/HUD capture (unsupported / refuse). */
  blocked: boolean;
  /** Per-device gate reports, keyed by device id (plus a synthetic key for the blocked marker). */
  reports: Record<string, GateReport[]>;
  /** Device ids that produced a gradeable capture. */
  gradedDevices: string[];
  /** Device ids whose capture was absent/empty — a capture gap (refuse), never a pass. */
  absentDevices: string[];
}

/** Build a segment-safe background matcher (exact / ancestor / trailing-`*` glob) over declared paths. */
function makeBackgroundMatcher(background: readonly string[]): (path: string) => boolean {
  return (path: string): boolean =>
    background.some((b) => {
      if (b === path) return true;
      if (isAncestorPath(b, path)) return true;
      if (b.endsWith("*")) {
        const prefix = b.slice(0, -1);
        return path === prefix || path.startsWith(`${prefix}[`) || path.startsWith(`${prefix}/`);
      }
      return false;
    });
}

/** The non-pass marker emitted when a device has no gradeable touch/HUD capture (refuse, never green). */
function absentTouchReport(gate: string, deviceId: string, reason: string): GateReport {
  return makeGateReport(gate, [
    {
      id: `${gate}.${deviceId}`,
      expected: "a touch/HUD capture for this device",
      actual: "absent",
      status: "not_applicable",
      detail: `No touch/HUD capture for device '${deviceId}' (${reason}) — a 3D top-down build with no thumb-layout capture is unsupported/blocked here, never a silent pass (refuse-on-absent).`,
    },
  ]);
}

/**
 * Grade a 3D top-down build's thumb-layout HUD across device aspects with the SAME
 * shared safe-area-sweep + tap-target gates the 2D minigame path uses.
 *
 * Refuse discipline (never a silent pass):
 *   - `devices` empty → `blocked` (no aspect to grade).
 *   - a device with a missing/null capture, or a capture with zero HUD elements → that
 *     device is a capture gap (a `not_applicable` refuse marker), never a pass.
 *   - if NO device yields a gradeable capture → `blocked: true`, `status` is NOT "pass".
 */
export function runTopDownTouchGates(input: TopDownTouchInput): TopDownTouchVerdict {
  const reports: Record<string, GateReport[]> = {};
  const gradedDevices: string[] = [];
  const absentDevices: string[] = [];

  const safe = resolveSafeBounds(input.safeArea?.insets);
  const tol = input.safeArea?.maxOverflowFraction ?? 0;
  const safeInsets = {
    top: input.safeArea?.insets?.top ?? 0,
    bottom: input.safeArea?.insets?.bottom ?? 0,
    left: input.safeArea?.insets?.left ?? 0,
    right: input.safeArea?.insets?.right ?? 0,
  };
  const exempt = new Set(input.exempt ?? []);
  const matchesBackground = makeBackgroundMatcher(input.background ?? []);
  const minDp = input.tapTargets?.minSizeDp;

  if (!Array.isArray(input.devices) || input.devices.length === 0) {
    reports["__unsupported__"] = [
      absentTouchReport(SAFE_AREA_SWEEP_GATE, "__unsupported__", "no device aspects declared"),
    ];
    return { status: "not_applicable", blocked: true, reports, gradedDevices, absentDevices };
  }

  for (const device of input.devices) {
    const capture = input.capturesByDevice[device.id];
    if (!capture || !Array.isArray(capture.elements) || capture.elements.length === 0) {
      absentDevices.push(device.id);
      reports[device.id] = [
        absentTouchReport(
          SAFE_AREA_SWEEP_GATE,
          device.id,
          !capture ? "no capture provided" : "capture has no HUD elements",
        ),
      ];
      continue;
    }

    const viewport = {
      width: capture.viewport.width,
      height: capture.viewport.height,
    };

    // safe-area-sweep over the captured HUD (shared core + shared report builder).
    const sweepElements: SweepElement[] = capture.elements.map((e) => ({
      id: e.id,
      path: e.path,
      role: e.role,
      isVisible: e.isVisible,
      raycastTarget: e.raycastTarget,
      rect: e.rect ?? null,
    }));
    const sweepResult = gradeSafeAreaSweep(sweepElements, {
      safe,
      tol,
      isExempt: (el) => exempt.has(el.id) || (!!el.path && exempt.has(el.path)),
      isBackground: (el) => !!el.path && matchesBackground(el.path),
    });
    const deviceReports: GateReport[] = [
      makeGateReport(
        SAFE_AREA_SWEEP_GATE,
        buildSafeAreaSweepChecks(sweepResult, {
          gate: SAFE_AREA_SWEEP_GATE,
          stateLabel: device.id,
          safe,
          tol,
          safeInsets,
          viewport,
        }),
      ),
    ];

    // tap-target-size (only when a floor is declared). A thumb layout has no required-id
    // list, so every tappable HUD control is graded; absent canvasScaleFactor refuses.
    if (typeof minDp === "number" && Number.isFinite(minDp) && minDp > 0) {
      const frameArea = viewport.width * viewport.height;
      const checks: GateCheck[] = [];
      for (const e of capture.elements) {
        const grade = gradeTapTarget(
          {
            id: e.id,
            path: e.path,
            role: e.role,
            active: e.active,
            raycastTarget: e.raycastTarget,
            screenRect: e.screenRect,
            canvasScaleFactor: e.canvasScaleFactor,
          },
          frameArea,
          minDp,
        );
        const check = tapTargetGradeToCheck(e.id, grade, {
          gate: TAP_TARGET_SIZE_GATE,
          stateLabel: device.id,
          minDp,
          floorLabel: "floor for the touch profile",
          rect: e.rect ?? null,
          viewport,
          ...(e.path ? { locator: e.path } : {}),
        });
        if (check) checks.push(check);
      }
      if (checks.length === 0) {
        checks.push({
          id: `${TAP_TARGET_SIZE_GATE}.${device.id}`,
          expected: `required tap targets ≥ ${minDp}dp`,
          actual: "no tap targets",
          status: "not_applicable",
          detail: `Device '${device.id}' has no interactive tap targets to size-check (not graded).`,
        });
      }
      deviceReports.push(makeGateReport(TAP_TARGET_SIZE_GATE, checks));
    }

    reports[device.id] = deviceReports;
    gradedDevices.push(device.id);
  }

  const blocked = gradedDevices.length === 0;
  const status = blocked
    ? "not_applicable"
    : worstStatus(
        gradedDevices
          .flatMap((d) => reports[d])
          .map((r) => r.verdict),
      );
  return { status, blocked, reports, gradedDevices, absentDevices };
}
