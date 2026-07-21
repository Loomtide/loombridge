/**
 * Visible ground-plane extent — pure geometry for the perspective camera-framing
 * gate (§3.2, dogfood finding "camera framing gate").
 *
 * MOTIVATING INCIDENT: the dogfood project's top-down rig framed ~54m of world width where
 * the truth sheet documented ~24-32m — a machine-checkable over-wide frame that
 * sat unnoticed until a human eyeballed "the character looks very small". This
 * module turns the eyeball into arithmetic: given the camera's height above the
 * ground plane, its pitch-down angle, vertical FOV and viewport aspect, it
 * computes how much of the flat ground the camera actually sees.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────
 * Coordinate frame: the ground is the horizontal plane y = 0; the camera sits at
 * height h above it and is pitched DOWN by θ (theta) measured from the horizon
 * (θ = 0 looks flat at the horizon, θ = 90° looks straight down at the nadir).
 * The vertical field of view spans ±(fovV/2) about the optical axis, so the
 * frustum's extreme rays make these angles BELOW the horizon:
 *
 *     top (far)  ray:  θ − fovV/2      ← closest to the horizon
 *     bottom(near)ray: θ + fovV/2      ← steepest, closest to the nadir
 *
 * A ray leaving the camera at angle φ below the horizon drops h vertically and
 * travels h / tan(φ) horizontally before it meets the ground, so its ground hit
 * lies at horizontal distance d(φ) = h / tan(φ) from the point below the camera
 * (the nadir). The horizontal FOV follows from the aspect ratio (Unity's
 * `fieldOfView` is the VERTICAL FOV):
 *
 *     tan(fovH/2) = aspect · tan(fovV/2)         (aspect = viewport width/height)
 *
 * The four frustum corners intersect the ground in a trapezoid — narrower at the
 * near edge, wider at the far edge (classic perspective foreshortening). The
 * horizontal half-width at a point is (slant distance to that point) · tan(fovH/2),
 * because the X axis of the frustum cross-section coincides with the ground's X
 * axis (both are perpendicular to the vertical plane containing the optical axis).
 *
 * The BAND METRIC we report as `visibleGroundWidthM` is the width the camera
 * shows at the CENTRE of the frame — where the optical axis meets the ground. The
 * slant distance camera→axis-ground-point is h / sin(θ), so:
 *
 *     visibleGroundWidthM = 2 · (h / sin θ) · tan(fovH/2)
 *                         = 2 · (h / sin θ) · aspect · tan(fovV/2)
 *
 * This is the value that reproduces the dogfood numbers exactly:
 *   h=26, θ=80°, fovV=60°, 16:9 → 54.2m (the un-eyeballed over-wide frame)
 *   h=12, θ=52°, fovV=60°, 16:9 → 31.3m (the corrected, in-band frame)
 *
 * ── Honest degeneracy (never Infinity silently) ─────────────────────────────
 * If the camera is not pitched down (θ ≤ 0) or the TOP ray reaches the horizon or
 * points above it (θ − fovV/2 ≤ 0), that ray never meets the ground: the far
 * extent is UNBOUNDED (the frame contains the horizon / sky). Rather than emit
 * Infinity — which a band check would silently swallow — we return a refusal-
 * shaped `{ bounded: false, reason }`. The gate turns that into a hard refusal:
 * a top-down arena rig that can see the horizon is misframed by construction.
 */

/** Camera + viewport geometry needed to compute the visible ground extent. */
export interface CameraGroundGeometry {
  /** Camera world height above the ground plane, in metres. Must be > 0. */
  heightAboveGroundM: number;
  /** Pitch DOWN from the horizon, degrees. 0 = flat at horizon, 90 = straight down. */
  pitchDownDeg: number;
  /** Vertical field of view, degrees (Unity `Camera.fieldOfView`). */
  fieldOfViewDeg: number;
  /** Viewport aspect ratio = width / height (e.g. 16/9 ≈ 1.778). Must be > 0. */
  aspect: number;
}

/** A bounded visible-ground result: the camera sees a finite ground trapezoid. */
export interface BoundedGroundExtent {
  bounded: true;
  /** BAND METRIC: ground width the camera shows at the centre of the frame (m). */
  visibleGroundWidthM: number;
  /** Ground width at the NEAR (steepest) edge of the frame (m). */
  nearWidthM: number;
  /** Ground width at the FAR (closest-to-horizon) edge of the frame (m). */
  farWidthM: number;
  /**
   * Horizontal distance from the nadir to the near edge (m). MAY be negative when
   * the bottom ray passes vertical (θ + fovV/2 > 90°): the near edge then wraps
   * behind the nadir and the frame straddles the point below the camera.
   */
  nearEdgeDistM: number;
  /** Horizontal distance from the nadir to the far edge (m). */
  farEdgeDistM: number;
  /** Visible ground DEPTH along the view direction = farEdge − nearEdge (m). */
  depthM: number;
  /** Slant distance camera→(axis-ground point), i.e. h / sin θ (m). */
  centerDistM: number;
}

/** A refusal-shaped result: the visible ground extent is unbounded or undefined. */
export interface UnboundedGroundExtent {
  bounded: false;
  /** Why the extent could not be computed as a finite value. */
  reason: string;
}

export type VisibleGroundExtent = BoundedGroundExtent | UnboundedGroundExtent;

const DEG2RAD = Math.PI / 180;

/**
 * Compute the visible ground-plane extent of a pitched perspective camera.
 *
 * Returns a refusal-shaped `{ bounded: false, reason }` for every degenerate
 * input (camera at/below ground, invalid FOV/aspect, not pitched down, or a top
 * ray at/above the horizon → unbounded far extent). Never returns Infinity/NaN.
 */
export function computeVisibleGroundExtent(geom: CameraGroundGeometry): VisibleGroundExtent {
  const { heightAboveGroundM: h, pitchDownDeg, fieldOfViewDeg, aspect } = geom;

  if (!Number.isFinite(h) || h <= 0) {
    return {
      bounded: false,
      reason: `camera height above ground must be > 0 (got ${fmt(h)}m); the camera is at or below the ground plane.`,
    };
  }
  if (!Number.isFinite(fieldOfViewDeg) || fieldOfViewDeg <= 0 || fieldOfViewDeg >= 180) {
    return {
      bounded: false,
      reason: `vertical field of view must be in (0, 180) degrees (got ${fmt(fieldOfViewDeg)}°).`,
    };
  }
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return { bounded: false, reason: `viewport aspect must be > 0 (got ${fmt(aspect)}).` };
  }
  if (!Number.isFinite(pitchDownDeg) || pitchDownDeg <= 0) {
    return {
      bounded: false,
      reason: `camera is not pitched down (pitch ${fmt(pitchDownDeg)}° ≤ 0); a top-down/high-angle rig requires a downward pitch, so the ground extent is undefined.`,
    };
  }
  if (pitchDownDeg >= 180) {
    return {
      bounded: false,
      reason: `camera pitch ${fmt(pitchDownDeg)}° ≥ 180°; the camera is pitched past straight-down and no longer frames the ground below it.`,
    };
  }

  const halfFovV = (fieldOfViewDeg / 2) * DEG2RAD;
  const topAngle = pitchDownDeg * DEG2RAD - halfFovV; // far ray angle below horizon
  if (topAngle <= 1e-9) {
    return {
      bounded: false,
      reason:
        `the frame's top ray reaches or rises above the horizon (pitch ${fmt(pitchDownDeg)}° − ½·FOV ${fmt(fieldOfViewDeg / 2)}° = ${fmt(pitchDownDeg - fieldOfViewDeg / 2)}° ≤ 0): ` +
        `the far ground extent is UNBOUNDED (the frame contains the horizon / sky). A top-down arena rig must not see the horizon — refusing rather than reporting Infinity.`,
    };
  }

  const theta = pitchDownDeg * DEG2RAD;
  const bottomAngle = theta + halfFovV; // near ray angle below horizon (may exceed 90°)
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const tv = Math.tan(halfFovV);
  const th = aspect * tv; // tan(fovH/2)

  // Corner-ray parameters (slant multipliers): a ray with vertical sign sv∈{-1,+1}
  // has world direction y-component (−sinθ + sv·tv·cosθ); the ground hit param is
  // t = h / |D.y|. sv=−1 → near (steep) edge, sv=+1 → far (shallow) edge.
  const tNear = h / (sinT + tv * cosT); // sv = −1
  const tFar = h / (sinT - tv * cosT); // sv = +1  (positive: guaranteed by topAngle>0)

  // Ground widths: horizontal half-extent = (slant param) · tan(fovH/2), doubled.
  const nearWidthM = 2 * tNear * th;
  const farWidthM = 2 * tFar * th;

  // Forward horizontal (nadir→edge) distances from the corner rays' Z component
  // (D.z = cosθ + sv·tv·sinθ). Robust when bottomAngle passes vertical (negative).
  const nearEdgeDistM = tNear * (cosT - tv * sinT); // sv = −1
  const farEdgeDistM = tFar * (cosT + tv * sinT); // sv = +1
  const depthM = farEdgeDistM - nearEdgeDistM;

  // Frame-centre width: slant camera→axis-ground point is h/sinθ.
  const centerDistM = h / sinT;
  const visibleGroundWidthM = 2 * centerDistM * th;

  // Defensive: any non-finite slips through as a refusal, never a silent value.
  if (
    ![nearWidthM, farWidthM, nearEdgeDistM, farEdgeDistM, depthM, visibleGroundWidthM].every(Number.isFinite)
  ) {
    return {
      bounded: false,
      reason: `degenerate geometry produced a non-finite extent (pitch ${fmt(pitchDownDeg)}°, FOV ${fmt(fieldOfViewDeg)}°, bottom ray ${fmt(bottomAngle / DEG2RAD)}°).`,
    };
  }

  return {
    bounded: true,
    visibleGroundWidthM,
    nearWidthM,
    farWidthM,
    nearEdgeDistM,
    farEdgeDistM,
    depthM,
    centerDistM,
  };
}

/**
 * Visible ground width of an ORTHOGRAPHIC camera looking down at the ground: the
 * frustum is a box, so the width is independent of height/pitch —
 * `width = 2 · orthographicSize · aspect` (orthographicSize is the half-height).
 */
export function orthographicGroundWidthM(orthographicSize: number, aspect: number): number {
  return 2 * orthographicSize * aspect;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
