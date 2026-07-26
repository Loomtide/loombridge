/**
 * Mini-game baseline regression (S6e).
 *
 * A *baseline* is an APPROVED snapshot of a mini-game's per-state captures (the
 * `<state>.png` + `<state>.ui-rects.json`) frozen from a PASS verification run. On
 * a later `verify --minigame`, when the contract declares a `baseline.ref` and an
 * approved bundle exists there, each declared state is compared against its
 * baseline twice:
 *
 *   - **perceptual PNG diff** — `comparePerceptual` over the decoded frames, with
 *     every `baseline.masks` object's rect BLANKED in both images (dynamic content —
 *     score text, randomized answers — must not trip a regression). Drift beyond
 *     `maxBaselineDiffFraction` regresses the state.
 *   - **rect drift** — each non-masked object present in both captures: the max
 *     normalized edge delta of its rect vs the baseline. Drift beyond
 *     `maxRectDriftFraction` regresses the state (a control that moved/resized
 *     without a big pixel change).
 *
 * A baseline regression is its OWN tier (S6e plan): it blocks release (exit 1) but
 * is reported separately from a game defect and from a harness/capture gap. This
 * module is pure aside from the disk reads; the per-state compare
 * (`compareStateToBaseline`) is a PURE function over decoded images so it is fully
 * unit-testable without disk.
 *
 * Anti-false-green (CLAUDE.md "Verification / supervisor invariants"): a CURRENT
 * capture that is absent is a capture/harness gap (INCOMPLETE — owned by the gate
 * runner's `captureAbsent`), NOT a regression; a BASELINE state file that is
 * missing/corrupt means the comparison cannot be made → INCOMPLETE for that state,
 * never a silent pass. Only a present-vs-present comparison can produce a pass or a
 * regression.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { MinigameContract } from "./profiles/types.js";
import { readFrameImage, type DecodedImage } from "./frame-facts.js";
import type { MinigameCaptureObject, MinigameRect, MinigameViewport } from "./types.js";
import { comparePerceptual } from "../replay/visual-diff.js";

/** The manifest filename inside a baseline bundle. */
export const BASELINE_MANIFEST = "baseline-manifest.json";

/** Default regression tolerances when the contract sets no `artifactThresholds` key. */
export const DEFAULT_MAX_BASELINE_DIFF_FRACTION = 0.02;
export const DEFAULT_MAX_RECT_DRIFT_FRACTION = 0.02;

export interface BaselineThresholds {
  maxBaselineDiffFraction: number;
  maxRectDriftFraction: number;
}

/** Resolve the two baseline tolerances from a contract (closed-vocab `artifactThresholds`). */
export function baselineThresholds(contract: MinigameContract): BaselineThresholds {
  return {
    maxBaselineDiffFraction:
      contract.artifactThresholds.maxBaselineDiffFraction ?? DEFAULT_MAX_BASELINE_DIFF_FRACTION,
    maxRectDriftFraction:
      contract.artifactThresholds.maxRectDriftFraction ?? DEFAULT_MAX_RECT_DRIFT_FRACTION,
  };
}

/** Resolve the baseline bundle dir: an explicit override, else the contract's `baseline.ref`. */
export function resolveBaselineRef(
  contract: MinigameContract,
  root: string,
  override?: string,
): string | null {
  const ref = override ?? contract.baseline?.ref;
  if (!ref) return null;
  return path.isAbsolute(ref) ? ref : path.resolve(root, ref);
}

export interface BaselineManifestState {
  id: string;
  pngSha256: string;
  viewport: MinigameViewport;
}

export interface BaselineManifest {
  schemaVersion: "1";
  kind: "minigame-baseline";
  contractId: string;
  capturedAt: string;
  masks: string[];
  approvedStatus: "pass";
  approvedSummary: { pass: number; warn: number; fail: number; notApplicable: number };
  states: BaselineManifestState[];
}

/** One non-masked object whose rect drifted beyond tolerance. */
export interface RectDrift {
  id: string;
  /** Max normalized edge delta vs the baseline rect, in [0,1]. */
  drift: number;
}

/** The per-state baseline comparison outcome. */
export interface BaselineStateResult {
  state: string;
  /** True iff BOTH the current and baseline captures were present and compared. */
  compared: boolean;
  /** True iff the state drifted beyond a threshold (perceptual OR rect). */
  regressed: boolean;
  /** Why the state could not be compared (e.g. baseline png missing), when `compared` is false. */
  incomplete?: string;
  diffFraction?: number;
  dimensionsMatch?: boolean;
  maxRectDrift?: number;
  driftedObjects?: RectDrift[];
}

/** The whole-game baseline comparison result. */
export interface BaselineCompareResult {
  /** The bundle dir compared against (relativized by the caller for the report). */
  ref: string;
  /** True iff an approved baseline manifest was found at `ref`. */
  present: boolean;
  /** When the contract declares a ref but no approved bundle exists — advisory, not blocking. */
  note?: string;
  capturedAt?: string;
  masks: string[];
  thresholds: BaselineThresholds;
  states: BaselineStateResult[];
  /** State ids that regressed (→ the baseline-regression tier, exit 1). */
  regressions: string[];
  /** State ids whose BASELINE file was missing/corrupt — cannot compare (→ incomplete). */
  incompleteStates: string[];
}

// ── pure comparison ──────────────────────────────────────────────────────────

/** The decoded inputs one state contributes to a comparison. */
export interface BaselineStateInputs {
  image: DecodedImage;
  objects: MinigameCaptureObject[];
  viewport: MinigameViewport;
}

/** A pixel box in IMAGE (top-left origin) coordinates. */
interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}

/**
 * Convert a capture `screenRect` (bottom-left origin, px) to an image pixel box
 * (top-left origin), mirroring `backgroundFillFraction`'s flip. `H` is the image
 * height the box will be applied to.
 */
function screenRectToPixelBox(rect: MinigameRect, W: number, H: number): PixelBox {
  return {
    x0: clampInt(rect.x, 0, W),
    x1: clampInt(rect.x + rect.width, 0, W),
    y0: clampInt(H - (rect.y + rect.height), 0, H),
    y1: clampInt(H - rect.y, 0, H),
  };
}

/**
 * The mask pixel boxes to blank: every masked object's `screenRect` from BOTH the
 * current and baseline captures (so dynamic content that MOVED is removed from both
 * images). Boxes are in the common WxH pixel space (only reached when dims match).
 */
function maskPixelBoxes(
  masks: ReadonlySet<string>,
  current: BaselineStateInputs,
  baseline: BaselineStateInputs,
  W: number,
  H: number,
): PixelBox[] {
  if (masks.size === 0) return [];
  const boxes: PixelBox[] = [];
  for (const o of [...current.objects, ...baseline.objects]) {
    if (masks.has(o.id)) boxes.push(screenRectToPixelBox(o.screenRect, W, H));
  }
  return boxes;
}

/** Return a copy of `image` with every pixel inside any box set to opaque black. */
function blankBoxes(image: DecodedImage, boxes: PixelBox[]): DecodedImage {
  if (boxes.length === 0) return image;
  const data = new Uint8Array(image.data); // copy — keep the input pure
  const W = image.width;
  for (const b of boxes) {
    for (let y = b.y0; y < b.y1; y += 1) {
      for (let x = b.x0; x < b.x1; x += 1) {
        const i = (y * W + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

/** Normalized 0..1 rect for an object: its `viewportRect`, else derived from `screenRect`/viewport. */
export function normalizedRect(o: MinigameCaptureObject, viewport: MinigameViewport): MinigameRect | null {
  if (o.viewportRect) return o.viewportRect;
  const { width: vw, height: vh } = viewport;
  if (!(vw > 0) || !(vh > 0)) return null;
  return {
    x: o.screenRect.x / vw,
    y: o.screenRect.y / vh,
    width: o.screenRect.width / vw,
    height: o.screenRect.height / vh,
  };
}

/** Max per-edge absolute delta between two normalized rects (left/top/right/bottom). */
export function rectDrift(a: MinigameRect, b: MinigameRect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

/**
 * Compare one state's CURRENT inputs against its BASELINE inputs. PURE — exported
 * so the regression logic is unit-tested from in-memory images. A dimension
 * mismatch is unambiguous drift (a resolution change); otherwise the masked
 * perceptual diff and the per-object rect drift are each measured and either, over
 * threshold, regresses the state.
 */
export function compareStateToBaseline(
  state: string,
  current: BaselineStateInputs,
  baseline: BaselineStateInputs,
  masks: ReadonlySet<string>,
  thresholds: BaselineThresholds,
): BaselineStateResult {
  const dimsMatch =
    current.image.width === baseline.image.width && current.image.height === baseline.image.height;

  // 1. Perceptual diff (masked). On a size mismatch comparePerceptual returns a full
  // diff without reading pixels, so masking is moot — let it flag the drift.
  let diff: { diffFraction: number; status: string; dimensionsMatch: boolean };
  if (dimsMatch) {
    const W = current.image.width;
    const H = current.image.height;
    const boxes = maskPixelBoxes(masks, current, baseline, W, H);
    diff = comparePerceptual(blankBoxes(current.image, boxes), blankBoxes(baseline.image, boxes), {
      driftFraction: thresholds.maxBaselineDiffFraction,
    });
  } else {
    diff = comparePerceptual(current.image, baseline.image, {
      driftFraction: thresholds.maxBaselineDiffFraction,
    });
  }

  // 2. Rect drift on non-masked objects present in BOTH captures.
  const baseById = new Map(baseline.objects.map((o) => [o.id, o]));
  const driftedObjects: RectDrift[] = [];
  let maxRectDrift = 0;
  for (const o of current.objects) {
    if (masks.has(o.id)) continue;
    const bo = baseById.get(o.id);
    if (!bo) continue; // membership is the required-in-frame gate's job, not baseline's
    const cur = normalizedRect(o, current.viewport);
    const base = normalizedRect(bo, baseline.viewport);
    // A null normalized rect means no `viewportRect` AND a degenerate (0/non-finite)
    // viewport — unreachable on real captures (the op emits the real game-view size, and
    // an object with no viewportRect is inactive/offscreen, already gated by required-in-frame).
    // The perceptual diff would still catch a visible move; rect-drift just abstains here.
    if (!cur || !base) continue;
    const d = rectDrift(cur, base);
    if (d > maxRectDrift) maxRectDrift = d;
    if (d > thresholds.maxRectDriftFraction) driftedObjects.push({ id: o.id, drift: d });
  }

  const regressed = diff.status === "drift" || driftedObjects.length > 0;
  return {
    state,
    compared: true,
    regressed,
    diffFraction: diff.diffFraction,
    dimensionsMatch: diff.dimensionsMatch,
    maxRectDrift,
    driftedObjects,
  };
}

// ── disk: load / approve / compare ───────────────────────────────────────────

function pngPath(dir: string, stateId: string): string {
  return path.join(dir, `${stateId}.png`);
}

function uiRectsPath(dir: string, stateId: string): string {
  return path.join(dir, `${stateId}.ui-rects.json`);
}

/**
 * Load a state's `<state>.png` + `<state>.ui-rects.json` from `dir`. Returns null
 * when EITHER is missing/unreadable/unparseable — a baseline comparison needs both
 * (the image for the pixel diff, the rects for drift), so a partial capture is
 * treated as absent (refuse-on-absent), never half-compared.
 */
export async function loadStateInputs(dir: string, stateId: string): Promise<BaselineStateInputs | null> {
  let image: DecodedImage;
  try {
    image = await readFrameImage(pngPath(dir, stateId));
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(uiRectsPath(dir, stateId), "utf-8");
    const ui = JSON.parse(raw) as { viewport?: Partial<MinigameViewport>; objects?: MinigameCaptureObject[] };
    return {
      image,
      objects: Array.isArray(ui.objects) ? ui.objects : [],
      viewport: {
        width: ui.viewport?.width ?? 0,
        height: ui.viewport?.height ?? 0,
        aspect: ui.viewport?.aspect ?? 0,
      },
    };
  } catch {
    return null;
  }
}

/** Read + shape-check a baseline manifest from `refDir`. Returns null when absent/invalid. */
export async function loadBaselineManifest(refDir: string): Promise<BaselineManifest | null> {
  try {
    const raw = await fs.readFile(path.join(refDir, BASELINE_MANIFEST), "utf-8");
    const m = JSON.parse(raw) as BaselineManifest;
    if (m && m.kind === "minigame-baseline" && Array.isArray(m.states)) return m;
    return null;
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Snapshot a PASS run's captures into an approved baseline bundle at `refDir`:
 * copy each CAPTURED state's `<state>.png` + `<state>.ui-rects.json` and write the
 * manifest (per-state pngSha256 + viewport, the contract's masks, the approved
 * summary). Mutates ONLY `refDir` (outside the game project).
 *
 * Outcome-gated states (`cs.outcomeGated === true`) are intentionally NOT captured
 * (a read-only verifier can't drive their outcome — see the finalize/gate-runner
 * convention), so they're skipped here rather than read (reading would ENOENT). A
 * non-gated state whose capture is genuinely absent is also skipped (recorded in
 * `skipped`) rather than throwing a half-written bundle. The manifest lists exactly
 * the states that were really bundled.
 */
export async function writeBaselineBundle(args: {
  contract: MinigameContract;
  capturesDir: string;
  refDir: string;
  capturedAt: string;
  approvedSummary: BaselineManifest["approvedSummary"];
}): Promise<BaselineManifest> {
  const { contract, capturesDir, refDir, capturedAt, approvedSummary } = args;
  await fs.mkdir(refDir, { recursive: true });
  const states: BaselineManifestState[] = [];
  const skipped: string[] = [];
  for (const cs of contract.states) {
    // Outcome-gated states are never captured by design → don't read them.
    if (cs.outcomeGated === true) {
      skipped.push(cs.id);
      continue;
    }
    let pngBytes: Buffer;
    let rectsRaw: string;
    try {
      pngBytes = await fs.readFile(pngPath(capturesDir, cs.id));
      rectsRaw = await fs.readFile(uiRectsPath(capturesDir, cs.id), "utf-8");
    } catch (error) {
      // A genuinely-absent capture for a non-gated state: skip-with-note rather than
      // leaving a half-written bundle. Only ENOENT is a clean skip; anything else
      // (permission, corrupt read) is a real failure and re-thrown.
      if (isEnoent(error)) {
        skipped.push(cs.id);
        continue;
      }
      throw error;
    }
    await fs.writeFile(pngPath(refDir, cs.id), pngBytes);
    await fs.writeFile(uiRectsPath(refDir, cs.id), rectsRaw);
    const ui = JSON.parse(rectsRaw) as { viewport?: Partial<MinigameViewport> };
    states.push({
      id: cs.id,
      pngSha256: sha256(pngBytes),
      viewport: {
        width: ui.viewport?.width ?? 0,
        height: ui.viewport?.height ?? 0,
        aspect: ui.viewport?.aspect ?? 0,
      },
    });
  }
  if (skipped.length > 0) {
    console.error(
      `[loombridge minigame] baseline: skipped ${skipped.length} uncaptured state(s) (outcome-gated or no capture present): ${skipped.join(", ")}.`,
    );
  }
  const manifest: BaselineManifest = {
    schemaVersion: "1",
    kind: "minigame-baseline",
    contractId: contract.id,
    capturedAt,
    masks: contract.baseline?.masks ?? [],
    approvedStatus: "pass",
    approvedSummary,
    states,
  };
  await fs.writeFile(path.join(refDir, BASELINE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return manifest;
}

/**
 * Compare the current captures (`capturesDir`) against the approved baseline at
 * `refDir`. When no approved bundle exists, returns `present:false` + an advisory
 * note (a declared-but-unapproved baseline never blocks). Otherwise, per declared
 * state: a missing CURRENT capture is skipped (owned by the gate runner's
 * captureAbsent → incomplete, NOT a regression); a missing BASELINE state file is
 * an incomplete (can't compare); a present-vs-present pair is compared.
 */
export async function compareToBaseline(
  contract: MinigameContract,
  capturesDir: string,
  refDir: string,
  thresholds: BaselineThresholds,
): Promise<BaselineCompareResult> {
  const masks = new Set(contract.baseline?.masks ?? []);
  const base: Omit<BaselineCompareResult, "states" | "regressions" | "incompleteStates" | "present"> = {
    ref: refDir,
    masks: [...masks],
    thresholds,
  };

  const manifest = await loadBaselineManifest(refDir);
  if (!manifest) {
    return {
      ...base,
      present: false,
      note: `No approved baseline at '${refDir}' — declared but not yet approved (run \`loombridge minigame baseline approve\`). Baseline regression not enforced.`,
      states: [],
      regressions: [],
      incompleteStates: [],
    };
  }

  const states: BaselineStateResult[] = [];
  const regressions: string[] = [];
  const incompleteStates: string[] = [];
  for (const cs of contract.states) {
    const current = await loadStateInputs(capturesDir, cs.id);
    if (!current) {
      // Current capture absent — a capture/harness gap already owned by the gate
      // runner's `captureAbsent` (→ incomplete). NOT a regression, and not double-counted
      // here: record it for the report but leave the incomplete to captureAbsent.
      states.push({
        state: cs.id,
        compared: false,
        regressed: false,
        incomplete: "current capture absent (see capture-absent — a capture/harness gap, not a regression)",
      });
      continue;
    }
    const baseline = await loadStateInputs(refDir, cs.id);
    if (!baseline) {
      states.push({
        state: cs.id,
        compared: false,
        regressed: false,
        incomplete: "baseline capture missing/corrupt for this state — cannot compare (incomplete, never a silent pass)",
      });
      incompleteStates.push(cs.id);
      continue;
    }
    const result = compareStateToBaseline(cs.id, current, baseline, masks, thresholds);
    states.push(result);
    if (result.regressed) regressions.push(cs.id);
  }

  return {
    ...base,
    present: true,
    capturedAt: manifest.capturedAt,
    states,
    regressions,
    incompleteStates,
  };
}
