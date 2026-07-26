/**
 * Framing / composition gate (§3.2).
 *
 * INPUT: the `scene.get_screen_rects` op output —
 *   `{ objects: [{ name, centerXFraction, isPartiallyClipped, isOffScreen?, clipSide?, ... }] }`
 * ACCEPTANCE: the `framing` section.
 *
 * CHECKS:
 *  - anchor: the player's `centerXFraction` is within
 *    `framing.playerAnchor.centerXFraction ± tolerance`.
 *      • When `framing.cameraMode === "static"` the per-frame anchor does not
 *        apply (a literal anchor only makes sense for a following camera), so the
 *        check is INFORMATIONAL — status "pass" with a note — never a warn.
 *      • Otherwise an off-target anchor is a WARN (not a hard fail): we surface
 *        the deviation without breaking the build.
 *  - clipping: no required object is `isPartiallyClipped` or `isOffScreen`.
 *  - camera: when the contract pins a concrete `framing.camera` block, the
 *    captured camera (projection + world position + PixelPerfectCamera settings)
 *    must reproduce it. Closes the gap where a wrong camera (skybox/3D, off
 *    position, blurry-HUD upscaleRT=true, wrong pixel grid) still passed because
 *    the gate only looked at the player rect. The window-dependent runtime
 *    `orthographicSize`/aspect are NOT hard-checked (a non-16:9 Game-view
 *    overscans with cropFrame off); the deterministic intent — projection,
 *    transform, and the pixel grid (PPU + refResolution) — is.
 *
 * The player object is matched by name containing "player" (case-insensitive),
 * falling back to a configurable `playerNameHint`.
 */

import type {
  AcceptanceContract,
  CameraFramingSection,
  PerspectiveFramingSection,
} from "../types.js";
import { isPerspectiveFramingSection } from "../types.js";
import {
  computeVisibleGroundExtent,
  orthographicGroundWidthM,
} from "../visible-ground-extent.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** One projected screen rect (subset of the op output we consume). */
export interface ScreenRectObject {
  name: string;
  centerXFraction?: number;
  centerYFraction?: number;
  isFullyVisible?: boolean;
  isPartiallyClipped?: boolean;
  isOffScreen?: boolean;
  clipSide?: string;
}

/**
 * PixelPerfectCamera settings as captured into `screen-rects.json` by the raw
 * capture writer (`loombridge capture`). Absent on a hand-authored / pre-writer
 * capture, which degrades the pixel-perfect checks to a single WARN.
 */
export interface PixelPerfectCapture {
  assetsPPU?: number;
  refResolutionX?: number;
  refResolutionY?: number;
  upscaleRT?: boolean;
  pixelSnapping?: boolean;
}

/** The camera block of `scene.get_screen_rects`, enriched by the capture writer. */
export interface CameraCapture {
  name?: string;
  orthographic?: boolean;
  /**
   * The LIVE camera half-height from `scene.get_screen_rects` (play mode). Under
   * PixelPerfectCamera with `cropFrame` off this OVERSCANS when the Game view is
   * not exactly 16:9, so it is recorded for transparency but NOT the enforced
   * value — see `authoredOrthographicSize`.
   */
  orthographicSize?: number;
  /**
   * The AUTHORED Camera orthographic half-height, read in EDIT mode (before
   * PixelPerfect's runtime overscan). This is the window-independent value the
   * `camera.orthographicSize` check enforces against `framing.camera.orthographicSize`.
   */
  authoredOrthographicSize?: number;
  position?: { x?: number; y?: number; z?: number };
  /**
   * Vertical field of view in degrees (Unity `Camera.fieldOfView`), captured in
   * EDIT mode by the raw writer for the PERSPECTIVE framing branch. Absent on the
   * 2D pixel-perfect path (orthographic cameras ignore it) and on pre-writer
   * captures — the perspective gate refuses when the contract needs it but it's absent.
   */
  fieldOfView?: number;
  /**
   * Camera world pitch-DOWN angle in degrees (0 = horizon, 90 = straight down),
   * for the PERSPECTIVE framing branch. NOT emitted by the bridge today (the
   * `scene.get_screen_rects` camera block carries only projection/ortho-size/
   * position) — see the gap note in the gate. When the contract declares a
   * `visibleGroundWidthM` band and this is absent, the gate REFUSES (never a skip).
   */
  worldPitchDownDeg?: number;
  /**
   * Producer stamp for `worldPitchDownDeg`. NO bridge op emits camera pitch today
   * (`scene.get_screen_rects` carries only projection/ortho-size/position), so a
   * bare `worldPitchDownDeg` in a capture can only be hand-authored — NOT trusted
   * evidence. The gate trusts the pitch ONLY when this equals
   * `TRUSTED_PITCH_PRODUCER` — the stamp the bridge will emit alongside the
   * rotation once `get_screen_rects` ships it. Hand-setting the stamp is
   * deliberate evidence forgery (same class as forging `_provenance`), which is
   * the shared trust floor of every disk-evidence field.
   */
  worldPitchDownDegProducedBy?: string;
  /** Merged from `component.get_properties` on the camera's PixelPerfectCamera. */
  pixelPerfect?: PixelPerfectCapture;
}

/**
 * The only producer stamp the perspective framing branch accepts for
 * `worldPitchDownDeg`. Emitted by NOTHING today (bridge gap: `scene.get_screen_rects`
 * lacks camera rotation); defined now so (a) the future bridge change + capture
 * writer have a fixed contract to emit, and (b) an unstamped hand-authored pitch
 * REFUSES loudly instead of riding into a band verdict.
 */
export const TRUSTED_PITCH_PRODUCER = "bridge:scene.get_screen_rects";

/** The `scene.get_screen_rects` op output shape (+ writer-enriched camera). */
export interface ScreenRectsResult {
  objects: ScreenRectObject[];
  camera?: CameraCapture;
  viewport?: { width?: number; height?: number; aspect?: number };
}

export const GATE_NAME = "framing";

function isPlayer(name: string, hint?: string): boolean {
  const n = name.toLowerCase();
  if (hint && n.includes(hint.toLowerCase())) return true;
  return n.includes("player") || n.includes("ninja") || n.includes("frog");
}

/** Position tolerance in world units — a static camera transform is exact. */
const POSITION_TOLERANCE = 0.05;

/**
 * Validate the captured camera against the contract's concrete `framing.camera`
 * block. Appends `camera.*` checks. Deterministic config the build MUST match is
 * a hard FAIL on mismatch; a missing capture block degrades to WARN (the
 * "missing capture degrades to warn" pattern) so a pre-writer / hand-authored
 * `screen-rects.json` surfaces as "re-capture", not a false green.
 */
function appendCameraChecks(
  checks: GateCheck[],
  camera: CameraCapture | undefined,
  spec: CameraFramingSection,
): void {
  if (!camera) {
    checks.push({
      id: "camera.capture",
      expected: "captured camera block (projection + position + pixelPerfect)",
      actual: "(no camera block in screen-rects.json)",
      status: "warn",
      detail:
        "framing.camera is pinned but screen-rects.json has no `camera` block. " +
        "Re-capture with the raw writer (`loombridge capture --slice <id>`) so the camera/pixel-perfect settings are verified, not assumed.",
    });
    return;
  }

  // Projection — must be orthographic for 2D.
  checks.push(
    camera.orthographic === true
      ? {
          id: "camera.projection",
          expected: "orthographic",
          actual: "orthographic",
          status: "pass",
          detail: "Camera is orthographic (correct for a 2D frame).",
        }
      : {
          id: "camera.projection",
          expected: "orthographic",
          actual: camera.orthographic === false ? "perspective" : "(unknown)",
          status: "fail",
          detail: "Camera must be orthographic for a 2D frame; a perspective camera distorts the composition.",
        },
  );

  // World position — a static camera transform is deterministic.
  const pos = camera.position;
  if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number" || typeof pos.z !== "number") {
    checks.push({
      id: "camera.position",
      expected: `worldPosition (${spec.worldPosition.x}, ${spec.worldPosition.y}, ${spec.worldPosition.z})`,
      actual: "(no camera position captured)",
      status: "warn",
      detail: "screen-rects.json camera has no numeric position; cannot verify framing transform.",
    });
  } else {
    const dx = Math.abs(pos.x - spec.worldPosition.x);
    const dy = Math.abs(pos.y - spec.worldPosition.y);
    const dz = Math.abs(pos.z - spec.worldPosition.z);
    const onTarget = dx <= POSITION_TOLERANCE && dy <= POSITION_TOLERANCE && dz <= POSITION_TOLERANCE;
    checks.push({
      id: "camera.position",
      expected: `worldPosition (${spec.worldPosition.x}, ${spec.worldPosition.y}, ${spec.worldPosition.z}) ± ${POSITION_TOLERANCE}`,
      actual: `(${pos.x}, ${pos.y}, ${pos.z})`,
      status: onTarget ? "pass" : "fail",
      detail: onTarget
        ? "Camera world position matches the pinned framing transform."
        : `Camera world position off target (Δ=${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}); the one-screen frame will not align with the contract.`,
    });
  }

  // Authored orthographic half-height — enforce the EDIT-mode value, not the
  // runtime one. PixelPerfectCamera overscans `orthographicSize` at runtime when
  // the Game view is not exactly 16:9 (cropFrame off), so the live value is
  // window-dependent; `authoredOrthographicSize` (captured in edit mode) is the
  // deterministic intent the contract pins.
  if (typeof camera.authoredOrthographicSize !== "number") {
    checks.push({
      id: "camera.orthographicSize",
      expected: `${spec.orthographicSize} (authored half-height)`,
      actual: "(authored orthographicSize not captured)",
      status: "warn",
      detail:
        "screen-rects.json camera has no authoredOrthographicSize (the edit-mode Camera value). " +
        "Re-capture with `loombridge capture` so the authored ortho size is verified — the runtime orthographicSize overscans under PixelPerfect and is not the enforced value.",
    });
  } else {
    const d = Math.abs(camera.authoredOrthographicSize - spec.orthographicSize);
    const onTarget = d <= 0.01;
    const runtimeNote =
      typeof camera.orthographicSize === "number" && Math.abs(camera.orthographicSize - spec.orthographicSize) > 0.01
        ? ` (runtime ${camera.orthographicSize.toFixed(3)} = PixelPerfect overscan, not enforced)`
        : "";
    checks.push({
      id: "camera.orthographicSize",
      expected: `${spec.orthographicSize} (authored half-height)`,
      actual: `${camera.authoredOrthographicSize}${runtimeNote}`,
      status: onTarget ? "pass" : "fail",
      detail: onTarget
        ? `Authored Camera orthographicSize matches the contract (${spec.orthographicSize}); the runtime value overscans under PixelPerfect when the Game view isn't 16:9 — informational only.`
        : `Authored Camera orthographicSize ${camera.authoredOrthographicSize} != contract ${spec.orthographicSize}; the one-screen half-height is wrong.`,
    });
  }

  // PixelPerfectCamera — the pixel grid (PPU + refResolution) defines the frame;
  // upscaleRT is the HUD-crispness pin (must match, usually false).
  const pp = camera.pixelPerfect;
  const ppSpec = spec.pixelPerfect;
  if (!pp) {
    checks.push({
      id: "camera.pixelPerfect",
      expected: `assetsPPU ${ppSpec.assetsPPU}, ref ${ppSpec.refResolutionX}x${ppSpec.refResolutionY}, upscaleRT ${ppSpec.upscaleRT}`,
      actual: "(no pixelPerfect block captured)",
      status: "warn",
      detail:
        "screen-rects.json camera has no `pixelPerfect` block (likely a hand-authored / pre-writer capture). " +
        "Re-capture with `loombridge capture` so the PixelPerfectCamera settings are verified.",
    });
    return;
  }

  const eqNum = (a: number | undefined, b: number) => typeof a === "number" && a === b;
  // PPU
  checks.push(
    eqNum(pp.assetsPPU, ppSpec.assetsPPU)
      ? mkPass("camera.pixelPerfect.assetsPPU", `${ppSpec.assetsPPU}`, "PixelPerfectCamera assetsPPU matches the contract.")
      : mkFail(
          "camera.pixelPerfect.assetsPPU",
          `${ppSpec.assetsPPU}`,
          `${pp.assetsPPU ?? "(missing)"}`,
          "assetsPPU defines world-units-per-pixel; a mismatch rescales every sprite relative to the frame.",
        ),
  );
  // Reference resolution
  const refOk = eqNum(pp.refResolutionX, ppSpec.refResolutionX) && eqNum(pp.refResolutionY, ppSpec.refResolutionY);
  checks.push(
    refOk
      ? mkPass(
          "camera.pixelPerfect.refResolution",
          `${ppSpec.refResolutionX}x${ppSpec.refResolutionY}`,
          "PixelPerfectCamera reference resolution matches the contract pixel grid.",
        )
      : mkFail(
          "camera.pixelPerfect.refResolution",
          `${ppSpec.refResolutionX}x${ppSpec.refResolutionY}`,
          `${pp.refResolutionX ?? "?"}x${pp.refResolutionY ?? "?"}`,
          "The reference resolution sizes the pixel grid (and the derived ortho size); a mismatch changes how many tiles read on screen.",
        ),
  );
  // upscaleRT — HUD-crispness pin
  checks.push(
    pp.upscaleRT === ppSpec.upscaleRT
      ? mkPass(
          "camera.pixelPerfect.upscaleRT",
          `${ppSpec.upscaleRT}`,
          `PixelPerfectCamera upscaleRT matches the contract (${ppSpec.upscaleRT}).`,
        )
      : mkFail(
          "camera.pixelPerfect.upscaleRT",
          `${ppSpec.upscaleRT}`,
          `${pp.upscaleRT ?? "(missing)"}`,
          ppSpec.upscaleRT === false
            ? "upscaleRT must be false: true rasterizes a Screen Space-Camera HUD into the low-res RT then upscales it → blurry HUD (the ui-conformance hudCrispness failure)."
            : "upscaleRT does not match the contract.",
        ),
  );
  // pixelSnapping — less critical (sub-pixel shimmer), WARN on mismatch.
  if (typeof ppSpec.pixelSnapping === "boolean") {
    checks.push(
      pp.pixelSnapping === ppSpec.pixelSnapping
        ? mkPass(
            "camera.pixelPerfect.pixelSnapping",
            `${ppSpec.pixelSnapping}`,
            "PixelPerfectCamera pixelSnapping matches the contract.",
          )
        : {
            id: "camera.pixelPerfect.pixelSnapping",
            expected: `${ppSpec.pixelSnapping}`,
            actual: `${pp.pixelSnapping ?? "(missing)"}`,
            status: "warn",
            detail: "pixelSnapping differs from the contract; sprites may shimmer at sub-pixel positions (advisory).",
          },
    );
  }
}

function mkPass(id: string, expected: string, detail: string): GateCheck {
  return { id, expected, actual: expected, status: "pass", detail };
}

function mkFail(id: string, expected: string, actual: string, detail: string): GateCheck {
  return { id, expected, actual, status: "fail", detail };
}

/**
 * REFUSAL for the perspective extent gate: a hard `fail`, NOT a warn.
 *
 * This is the §"Verification / supervisor invariants" rule — once the contract
 * declares a `visibleGroundWidthM` band, an absent bound evidence field (camera
 * height / pitch / FOV / projection) is a REFUSAL, never a silently-skipped check.
 * It deliberately differs from the 2D ortho branch's "missing capture → warn"
 * degradation: the whole reason this gate exists is that the dogfood project's over-wide 54m
 * frame went un-eyeballed, so a missing measurement must BLOCK, not pass.
 */
function refuseExtent(id: string, expected: string, actual: string, detail: string): GateCheck {
  return { id, expected, actual, status: "fail", detail };
}

/**
 * Perspective / high-angle framing: compute the visible ground-plane WIDTH from
 * the CAPTURED camera evidence and compare it against the contract's
 * `visibleGroundWidthM` band. Catches the dogfood class where a too-high / too-
 * wide-FOV rig shows ~54m of world (character reads as a speck) vs a ~24-32m spec.
 *
 * Refuses (hard fail) when any bound evidence field is missing while the band is
 * declared, and when the geometry is unbounded (the frame contains the horizon).
 */
function appendPerspectiveExtentChecks(
  checks: GateCheck[],
  rects: ScreenRectsResult,
  spec: PerspectiveFramingSection,
  fallbackAspect: number | undefined,
): void {
  const band = spec.visibleGroundWidthM;
  const camera = rects.camera;
  const ID = "camera.visibleGroundWidth";

  // No band declared → the extent gate is NOT armed. This is a WARN, never a
  // pass: an omitted band silently disarming the extent check is exactly the
  // hand-crafted-contract bypass the moat bans (contract validation now REQUIRES
  // the band on a perspective-shaped framing section; this warn covers contracts
  // that predate that rule or bypassed validation).
  if (!band) {
    checks.push({
      id: ID,
      expected: "framing.camera.visibleGroundWidthM {min,max} band (world metres)",
      actual: "(band not declared)",
      status: "warn",
      detail:
        "Perspective framing declared without a visibleGroundWidthM band — the visible ground extent is UNENFORCED. " +
        "Declare {min,max} (world metres) so an over-wide / speck-character frame is caught (the dogfood project showed ~54m vs a ~24-32m spec). " +
        "Contract validation now refuses a perspective-shaped framing.camera without this band.",
    });
    return;
  }

  const expected = `visible ground width ∈ [${band.min}, ${band.max}] m`;

  // ---- gather evidence; a missing BOUND field is a REFUSAL, not a skip ----
  if (!camera) {
    checks.push(
      refuseExtent(
        ID,
        expected,
        "(no camera block in screen-rects.json)",
        "framing.camera declares a visibleGroundWidthM band but screen-rects.json has no `camera` block. " +
          "Re-capture with `loombridge capture` so the camera height/projection/FOV are verified. A missing camera is a REFUSAL, not a skipped check.",
      ),
    );
    return;
  }

  const aspect =
    typeof rects.viewport?.aspect === "number" && rects.viewport.aspect > 0
      ? rects.viewport.aspect
      : fallbackAspect;
  if (typeof aspect !== "number" || !(aspect > 0)) {
    checks.push(
      refuseExtent(
        ID,
        expected,
        "(no viewport aspect captured)",
        "screen-rects.json has no positive `viewport.aspect` and the contract framing.aspect could not supply one; the visible ground width cannot be computed. REFUSING.",
      ),
    );
    return;
  }

  const groundY = spec.groundPlaneY ?? 0;
  const camY = camera.position?.y;
  if (typeof camY !== "number") {
    checks.push(
      refuseExtent(
        ID,
        expected,
        "(no camera height captured)",
        `screen-rects.json camera has no numeric position.y; cannot measure the camera height above the ground plane (y=${groundY}). REFUSING.`,
      ),
    );
    return;
  }
  const height = camY - groundY;

  // ---- orthographic capture ----
  if (camera.orthographic === true) {
    // The ortho width formula belongs ONLY to a contract that explicitly
    // sanctions an ortho rig by pinning `orthographicSize`. Otherwise a
    // perspective-declared contract could be rerouted into the looser ortho
    // formula by a capture claiming orthographic:true — projection mismatch.
    if (typeof spec.orthographicSize !== "number") {
      checks.push(
        refuseExtent(
          ID,
          expected,
          "(capture reports orthographic)",
          "contract declares a perspective rig (no framing.camera.orthographicSize is pinned); capture reports orthographic — projection mismatch. " +
            "An orthographic capture may satisfy this band only when the contract explicitly sanctions an ortho rig by pinning orthographicSize. REFUSING.",
        ),
      );
      return;
    }
    const size =
      typeof camera.authoredOrthographicSize === "number"
        ? camera.authoredOrthographicSize
        : typeof camera.orthographicSize === "number"
          ? camera.orthographicSize
          : undefined;
    if (size === undefined) {
      checks.push(
        refuseExtent(
          ID,
          expected,
          "(orthographic, but no orthographicSize captured)",
          "camera is orthographic but neither authoredOrthographicSize nor orthographicSize was captured; the visible ground width (2·size·aspect) cannot be computed. REFUSING.",
        ),
      );
      return;
    }
    // The captured size must reproduce the contract-pinned one — otherwise an
    // off-contract rig could tune ANY size whose width lands in band.
    if (Math.abs(size - spec.orthographicSize) > 0.01) {
      checks.push(
        mkFail(
          "camera.orthographicSize",
          `${spec.orthographicSize} (contract-pinned ortho half-height)`,
          `${round(size)}`,
          `captured orthographicSize ${round(size)} != the contract-pinned ${spec.orthographicSize}; the rig is off-contract even if its width lands in band.`,
        ),
      );
    } else {
      checks.push(
        mkPass(
          "camera.orthographicSize",
          `${spec.orthographicSize} (contract-pinned ortho half-height)`,
          "Captured orthographicSize reproduces the contract-pinned value.",
        ),
      );
    }
    const width = orthographicGroundWidthM(size, aspect);
    pushBandCheck(checks, ID, expected, band, width, {
      projection: "orthographic",
      detail: `orthographic width = 2·${round(size)}·${round(aspect)} (aspect)`,
    });
    // A declared pitch band cannot be verified on the ortho path (no bridge op
    // emits camera rotation yet): surface a WARN — noisy, never silently skipped.
    // The ortho width is pitch-independent, so the band verdict above stands.
    if (spec.pitchDownDeg) {
      checks.push({
        id: "camera.pitchDown",
        expected: `pitch-down ∈ [${spec.pitchDownDeg.min}, ${spec.pitchDownDeg.max}]°`,
        actual: "(camera pitch not captured — bridge gap)",
        status: "warn",
        detail:
          "pitchDownDeg band is declared but no bridge op emits the camera's world rotation yet (`scene.get_screen_rects` lacks rotation), so the pitch is UNVERIFIED for this orthographic rig. " +
          "The ortho ground width is pitch-independent (band above is still enforced); the top-down read of the frame is not machine-checked until the bridge ships rotation.",
      });
    }
    return;
  }

  // ---- perspective rig: need TRUSTED captured pitch + FOV; refuse when absent ----
  if (camera.orthographic === false) {
    // D4 guard: groundPlaneY is contract-authored and directly scales the width
    // (raise it toward camY → shrink h → shrink width into band). Refuse
    // implausible values instead of letting them launder the band.
    if (!Number.isFinite(groundY) || Math.abs(groundY) > 100) {
      checks.push(
        refuseExtent(
          ID,
          expected,
          `groundPlaneY=${groundY}`,
          `implausible ground plane: framing.camera.groundPlaneY=${groundY} (|y| must be ≤ 100 and finite). A ground plane far from the world origin is a band-laundering knob, not a plausible arena floor. REFUSING.`,
        ),
      );
      return;
    }
    if (height < 1) {
      checks.push(
        refuseExtent(
          ID,
          expected,
          `height=${round(height)}m (camY=${round(camY)}, groundPlaneY=${groundY})`,
          `implausible camera height: camY − groundPlaneY = ${round(camY)} − ${groundY} = ${round(height)}m < 1m. A top-down/high-angle rig cannot sit at/under the arena floor — this reads as a groundPlaneY laundering attempt or a broken capture. REFUSING.`,
        ),
      );
      return;
    }
    const fov = camera.fieldOfView;
    const pitch = camera.worldPitchDownDeg;
    if (typeof fov !== "number") {
      checks.push(
        refuseExtent(
          ID,
          expected,
          "(perspective, but no fieldOfView captured)",
          "camera is perspective but no `fieldOfView` was captured; the visible ground extent cannot be computed. " +
            "Re-capture with `loombridge capture` (it reads the edit-mode Camera field of view). REFUSING.",
        ),
      );
      return;
    }
    if (typeof pitch !== "number") {
      checks.push(
        refuseExtent(
          ID,
          expected,
          "(perspective, but no camera pitch captured)",
          "camera is perspective but no `worldPitchDownDeg` was captured; the visible ground extent depends on the pitch and cannot be computed. " +
            "BRIDGE GAP: `scene.get_screen_rects` does not emit the camera's world rotation/pitch (only projection, ortho size, position). REFUSING until it does.",
        ),
      );
      return;
    }
    // D2 guard: no bridge op emits camera pitch today, so a present pitch
    // WITHOUT the producer stamp can only be hand-authored — not trusted
    // evidence. The stamp contract (`TRUSTED_PITCH_PRODUCER`) is defined now for
    // the future bridge emission; until then every unstamped pitch refuses.
    if (camera.worldPitchDownDegProducedBy !== TRUSTED_PITCH_PRODUCER) {
      checks.push(
        refuseExtent(
          ID,
          expected,
          `worldPitchDownDeg=${round(pitch)}° (unstamped)`,
          "worldPitchDownDeg is present but carries no recognized producer stamp — no bridge op emits camera pitch yet " +
            "(bridge gap: `scene.get_screen_rects` lacks rotation), so a hand-authored pitch is NOT trusted evidence. " +
            `The bridge will stamp worldPitchDownDegProducedBy="${TRUSTED_PITCH_PRODUCER}" once it ships rotation; ` +
            `found ${camera.worldPitchDownDegProducedBy === undefined ? "(no stamp)" : `"${camera.worldPitchDownDegProducedBy}"`}. REFUSING.`,
        ),
      );
      return;
    }
    const extent = computeVisibleGroundExtent({
      heightAboveGroundM: height,
      pitchDownDeg: pitch,
      fieldOfViewDeg: fov,
      aspect,
    });
    // pitch-in-band secondary check (only when the contract declares a band).
    appendPitchBandCheck(checks, spec.pitchDownDeg, pitch);
    if (!extent.bounded) {
      checks.push(
        refuseExtent(
          ID,
          expected,
          "(unbounded — horizon in frame)",
          `visible ground extent is UNBOUNDED: ${extent.reason} (camera h=${round(height)}m, pitch=${round(pitch)}°, FOV=${round(fov)}°, aspect=${round(aspect)}).`,
        ),
      );
      return;
    }
    pushBandCheck(checks, ID, expected, band, extent.visibleGroundWidthM, {
      projection: "perspective",
      detail:
        `perspective centre width from h=${round(height)}m, pitch=${round(pitch)}°, FOV=${round(fov)}°, aspect=${round(aspect)} ` +
        `(near ${round(extent.nearWidthM)}m → far ${round(extent.farWidthM)}m, depth ${round(extent.depthM)}m)`,
    });
    return;
  }

  // projection not captured → cannot pick the width formula → REFUSE.
  checks.push(
    refuseExtent(
      ID,
      expected,
      "(projection not captured)",
      "screen-rects.json camera has no `orthographic` flag; cannot tell whether to use the orthographic or perspective width formula. REFUSING.",
    ),
  );
}

/** Push the visible-ground-width band verdict (pass within [min,max], else fail). */
function pushBandCheck(
  checks: GateCheck[],
  id: string,
  expected: string,
  band: { min: number; max: number },
  width: number,
  meta: { projection: string; detail: string },
): void {
  const inBand = width >= band.min - 1e-6 && width <= band.max + 1e-6;
  checks.push({
    id,
    expected,
    actual: `${round(width)} m`,
    status: inBand ? "pass" : "fail",
    detail: inBand
      ? `Visible ground width ${round(width)}m is within [${band.min}, ${band.max}]m (${meta.projection}): ${meta.detail}.`
      : `Visible ground width ${round(width)}m is OUTSIDE [${band.min}, ${band.max}]m (${meta.projection}): ${meta.detail}. ` +
        (width > band.max
          ? "The frame is too WIDE — the play space over-reads and characters render as specks (the dogfood 54m failure)."
          : "The frame is too NARROW — the play space is cramped / over-zoomed."),
  });
}

/** Secondary check: captured camera pitch must sit within the declared pitchDownDeg band. */
function appendPitchBandCheck(
  checks: GateCheck[],
  band: { min: number; max: number } | undefined,
  pitch: number,
): void {
  if (!band) return;
  const inBand = pitch >= band.min - 1e-6 && pitch <= band.max + 1e-6;
  checks.push({
    id: "camera.pitchDown",
    expected: `pitch-down ∈ [${band.min}, ${band.max}]°`,
    actual: `${round(pitch)}°`,
    status: inBand ? "pass" : "fail",
    detail: inBand
      ? `Camera pitch-down ${round(pitch)}° is within the top-down band [${band.min}, ${band.max}]°.`
      : `Camera pitch-down ${round(pitch)}° is OUTSIDE the top-down band [${band.min}, ${band.max}]°; the rig is not framing the arena from the intended high angle.`,
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function evaluateFraming(
  rects: ScreenRectsResult,
  acceptance: AcceptanceContract,
  options: { playerNameHint?: string } = {},
): GateReport {
  const checks: GateCheck[] = [];
  const objects = rects.objects ?? [];
  const anchor = acceptance.framing.playerAnchor;
  const isStaticCamera = acceptance.framing.cameraMode === "static";

  // ---- player anchor (WARN on miss) ----
  const player = objects.find((o) => isPlayer(o.name, options.playerNameHint));
  if (!player) {
    checks.push({
      id: "anchor.player",
      expected: `centerXFraction ${anchor.centerXFraction} ± ${anchor.tolerance}`,
      actual: "(no player object in screen rects)",
      status: "warn",
      detail: "No player object found in screen rects; cannot check anchor.",
    });
  } else if (typeof player.centerXFraction !== "number") {
    checks.push({
      id: "anchor.player",
      expected: `centerXFraction ${anchor.centerXFraction} ± ${anchor.tolerance}`,
      actual: "(no centerXFraction)",
      status: "warn",
      detail: `Player "${player.name}" has no centerXFraction; cannot check anchor.`,
    });
  } else if (isStaticCamera) {
    // Static one-screen camera: the per-frame 40% anchor does not apply
    // (it presumes a following camera). Report INFORMATIONAL pass, never a warn.
    checks.push({
      id: "anchor.player",
      expected: `centerXFraction ${anchor.centerXFraction} ± ${anchor.tolerance} (N/A: static camera)`,
      actual: player.centerXFraction.toFixed(3),
      status: "pass",
      detail: `Static one-screen camera (framing.cameraMode="static"): player-anchor check is informational. Player sits at ${player.centerXFraction.toFixed(3)}; the ${anchor.centerXFraction} 'lead-the-look' anchor only applies to a following camera, so no anchor deviation is flagged.`,
    });
  } else {
    const delta = Math.abs(player.centerXFraction - anchor.centerXFraction);
    const onTarget = delta <= anchor.tolerance + 1e-9;
    checks.push({
      id: "anchor.player",
      expected: `centerXFraction ${anchor.centerXFraction} ± ${anchor.tolerance}`,
      actual: player.centerXFraction.toFixed(3),
      // Anchor miss is a WARN, never a hard fail (static-vs-follow camera note).
      status: onTarget ? "pass" : "warn",
      detail: onTarget
        ? `Player anchored at ${player.centerXFraction.toFixed(3)} (within ±${anchor.tolerance} of ${anchor.centerXFraction}).`
        : `Player anchored at ${player.centerXFraction.toFixed(3)}, off target ${anchor.centerXFraction} (±${anchor.tolerance}). WARN: may be a static-vs-follow-camera design reconcile, not a build bug.`,
    });
  }

  // ---- clipping (FAIL if any required-ish object is clipped/off-screen) ----
  for (const obj of objects) {
    const clipped = obj.isPartiallyClipped === true || obj.isOffScreen === true;
    if (!clipped) {
      checks.push({
        id: `clip.${obj.name}`,
        expected: "fully in frame",
        actual: "fully in frame",
        status: "pass",
        detail: `"${obj.name}" is fully inside the camera frame.`,
      });
      continue;
    }
    const how = obj.isOffScreen ? "off-screen" : `clipped at ${obj.clipSide ?? "edge"}`;
    checks.push({
      id: `clip.${obj.name}`,
      expected: "fully in frame",
      actual: how,
      status: "fail",
      detail: `"${obj.name}" is ${how} — important object must not be clipped.`,
    });
  }

  // ---- camera (only when the contract pins a concrete framing.camera) ----
  if (acceptance.framing.camera) {
    if (isPerspectiveFramingSection(acceptance.framing.camera)) {
      // 3D top-down / high-angle rig: enforce the visible ground-extent band
      // (the dogfood "camera shows 54m vs 24-32m spec" class).
      const a = acceptance.framing.aspect;
      const fallbackAspect =
        a && typeof a.w === "number" && typeof a.h === "number" && a.h > 0 ? a.w / a.h : undefined;
      appendPerspectiveExtentChecks(checks, rects, acceptance.framing.camera, fallbackAspect);
    } else {
      // 2D pixel-perfect ortho camera: projection + position + ortho + pixel grid.
      appendCameraChecks(checks, rects.camera, acceptance.framing.camera);
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
