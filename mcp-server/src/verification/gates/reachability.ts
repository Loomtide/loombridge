/**
 * Reachability gate.
 *
 * WHY: the playability gate can prove a level is "completable" by TELEPORTING
 * the player onto each collectible — which means an UNREACHABLE collectible
 * still passes. This gate closes that hole with a PURE geometric envelope
 * check: given the feel budget (jump apex, dash distance, run speed, airtime),
 * is each collectible actually within reach of some platform or launcher?
 *
 * INPUT (the agent captures object world positions/bounds via `scene.get_bounds`):
 *
 *   {
 *     player?:  { startX, startY },
 *     platforms:   [{ name, topY, minX, maxX }],          // standable surfaces
 *     launchers?:  [{ name, x, topY, launchApex }],        // trampolines / springs
 *     collectibles:[{ name, x, y }],
 *   }
 *
 * ACCEPTANCE: the `feel` section (budget) + the optional `reachability` section
 * (margins). Targets read with sane fallbacks:
 *   - jumpApex  = feel.jumpApex?.target  ?? 2.2
 *   - dashDist  = feel.dashDistance?.target ?? 0
 *   - runSpeed  = feel.runSpeed?.target  ?? 0
 *   - airtimeS  = 2 * (feel.timeToApex?.target ?? 325) / 1000   // up + down
 *   - vMargin   = acceptance.reachability?.verticalMarginU   ?? 0.5
 *   - hReach    = acceptance.reachability?.horizontalMarginU ?? (dashDist + runSpeed * airtimeS)
 *
 * CHECKS: one per collectible. A collectible C is reachable if EITHER:
 *   • some platform P: C.y <= P.topY + jumpApex + vMargin
 *                      AND C.x in [P.minX - hReach, P.maxX + hReach]
 *   • some launcher L: C.y <= L.topY + L.launchApex + vMargin
 *                      AND |C.x - L.x| <= hReach
 * -> PASS naming the platform/launcher it's reachable from, else FAIL stating how
 * far out of the envelope it is. Empty/absent collectibles -> a single WARN.
 *
 * Mirrors the doc-comment + GateCheck style of `playability.ts`.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** A standable surface (top edge + horizontal extent) in world units. */
export interface ReachabilityPlatform {
  name: string;
  /** World-Y of the top (standable) surface. */
  topY: number;
  /** Left/right world-X extent of the surface. */
  minX: number;
  maxX: number;
}

/** A launcher (trampoline/spring) that boosts the player above its top by `launchApex`. */
export interface ReachabilityLauncher {
  name: string;
  /** World-X of the launcher center. */
  x: number;
  /** World-Y of the launcher's top surface. */
  topY: number;
  /** Extra apex height (u) the launch adds above `topY`. */
  launchApex: number;
}

/** A collectible's world position. */
export interface ReachabilityCollectible {
  name: string;
  x: number;
  y: number;
}

/** The geometric layout the agent captures via `scene.get_bounds`. */
export interface ReachabilityLayout {
  player?: { startX: number; startY: number };
  platforms: ReachabilityPlatform[];
  launchers?: ReachabilityLauncher[];
  collectibles: ReachabilityCollectible[];
}

export const GATE_NAME = "reachability";

/**
 * The raw inputs the geometric envelope is solved from. The SAME shape is fed by
 * BOTH the build-mode acceptance contract (`acceptance.feel` + `acceptance.reachability`)
 * and a verify-first feel profile (F4: `envelopeFromProfile`). One envelope
 * definition, two sources.
 *
 * `jumpApex`/`dashDist`/`runSpeed`/`timeToApexMs` are the feel targets; `vMargin`
 * the optional vertical slack (default 0.5 applied by callers when omitted);
 * `hReachOverride` an optional explicit horizontal reach (when omitted the envelope
 * derives `dashDist + runSpeed * airtimeS`).
 */
export interface FeelEnvelopeBudget {
  /** Jump apex height (u). */
  jumpApex: number;
  /** Dash distance (u). 0 when the feel has no dash. */
  dashDist: number;
  /** Run speed (u/s). 0 when unknown. */
  runSpeed: number;
  /** Time to apex (ms) — airtime is 2× this (up + down). */
  timeToApexMs: number;
  /** Vertical slack (u) added above apex when reaching up. */
  vMargin: number;
  /** Explicit horizontal reach (u) override; when omitted, derived from dash+run·airtime. */
  hReachOverride?: number;
}

/**
 * The solved geometric envelope: how high (jumpApex + vMargin above a surface) and
 * how far sideways (hReach) the player can reach. PURE — no acceptance/profile
 * dependency. Both `evaluateReachability` (build mode) and the profile-verify path
 * (F4) consume an identical `FeelEnvelope`, so the geometry below is run UNCHANGED
 * regardless of which source produced the envelope.
 */
export interface FeelEnvelope {
  jumpApex: number;
  dashDist: number;
  runSpeed: number;
  /** Total airtime (s) = 2 × timeToApex. */
  airtimeS: number;
  vMargin: number;
  /** Horizontal reach (u): the override, else dashDist + runSpeed · airtimeS. */
  hReach: number;
}

/**
 * Solve the geometric reach envelope from a feel budget. This is the SINGLE
 * definition of "feel budget → reach" that was previously inline in
 * `evaluateReachability`; factoring it out lets the verify-first profile path feed
 * a profile-derived budget through the exact same math (F4). Pure.
 */
export function feelEnvelope(budget: FeelEnvelopeBudget): FeelEnvelope {
  const airtimeS = (2 * budget.timeToApexMs) / 1000;
  const hReach = budget.hReachOverride ?? budget.dashDist + budget.runSpeed * airtimeS;
  return {
    jumpApex: budget.jumpApex,
    dashDist: budget.dashDist,
    runSpeed: budget.runSpeed,
    airtimeS,
    vMargin: budget.vMargin,
    hReach,
  };
}

/** Read the feel budget out of an acceptance contract (build mode), with the documented fallbacks. */
function budgetFromAcceptance(acceptance: AcceptanceContract): FeelEnvelopeBudget {
  const feel = acceptance.feel ?? {};
  return {
    jumpApex: feel.jumpApex?.target ?? 2.2,
    dashDist: feel.dashDistance?.target ?? 0,
    runSpeed: feel.runSpeed?.target ?? 0,
    timeToApexMs: feel.timeToApex?.target ?? 325,
    vMargin: acceptance.reachability?.verticalMarginU ?? 0.5,
    hReachOverride: acceptance.reachability?.horizontalMarginU,
  };
}

/**
 * Geometric reachability check against an explicit envelope (F4 seam). PURE — the
 * envelope source (acceptance feel budget OR a swapped profile) is the caller's
 * concern. This is the math `evaluateReachability` runs in build mode, lifted so
 * the profile-verify path runs it UNCHANGED against a profile-derived envelope.
 */
export function evaluateReachabilityEnvelope(
  layout: ReachabilityLayout,
  envelope: FeelEnvelope,
): GateReport {
  const checks: GateCheck[] = [];

  const collectibles = layout.collectibles ?? [];
  if (collectibles.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "reachability.collectibles",
        expected: "≥1 collectible captured",
        actual: "(none)",
        status: "warn",
        detail:
          "No collectibles captured; reachability not evaluated. Capture collectible positions via scene.get_bounds.",
      },
    ]);
  }

  // Only the solved reach radii enter the geometry; the raw budget components
  // (dash/run/airtime) already folded into `hReach` inside `feelEnvelope`.
  const { jumpApex, vMargin, hReach } = envelope;

  const platforms = layout.platforms ?? [];
  const launchers = layout.launchers ?? [];

  for (const c of collectibles) {
    // Highest reachable Y from any platform / launcher (for the FAIL message).
    let bestVerticalReach = Number.NEGATIVE_INFINITY;

    // ---- platforms: jump up to topY + jumpApex + vMargin, dash/run hReach sideways ----
    let reachedVia: string | null = null;
    for (const p of platforms) {
      const maxReachY = p.topY + jumpApex + vMargin;
      bestVerticalReach = Math.max(bestVerticalReach, maxReachY);
      const inVertical = c.y <= maxReachY + 1e-9;
      const inHorizontal =
        c.x >= p.minX - hReach - 1e-9 && c.x <= p.maxX + hReach + 1e-9;
      if (inVertical && inHorizontal) {
        reachedVia = `platform "${p.name}"`;
        break;
      }
    }

    // ---- launchers: boosted up to topY + launchApex + vMargin, within hReach horizontally ----
    if (!reachedVia) {
      for (const l of launchers) {
        const maxReachY = l.topY + l.launchApex + vMargin;
        bestVerticalReach = Math.max(bestVerticalReach, maxReachY);
        const inVertical = c.y <= maxReachY + 1e-9;
        const inHorizontal = Math.abs(c.x - l.x) <= hReach + 1e-9;
        if (inVertical && inHorizontal) {
          reachedVia = `launcher "${l.name}"`;
          break;
        }
      }
    }

    if (reachedVia) {
      checks.push({
        id: `reach.${c.name}`,
        expected: `within reach (Δy ≤ jumpApex ${jumpApex}+vMargin ${vMargin}, Δx ≤ hReach ${hReach.toFixed(2)})`,
        actual: `(${c.x.toFixed(2)}, ${c.y.toFixed(2)})`,
        status: "pass",
        detail: `"${c.name}" at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}) is reachable from ${reachedVia}.`,
      });
      continue;
    }

    // ---- FAIL: classify whether it's a vertical or horizontal miss ----
    const overVertical = c.y > bestVerticalReach + 1e-9;
    let why: string;
    if (overVertical) {
      why = `y ${c.y.toFixed(2)} exceeds max reach ${bestVerticalReach.toFixed(2)} from any platform/launcher`;
    } else {
      why = `x ${c.x.toFixed(2)} outside horizontal envelope (hReach ${hReach.toFixed(2)}) of every platform/launcher in vertical range`;
    }
    checks.push({
      id: `reach.${c.name}`,
      expected: `within reach (Δy ≤ jumpApex ${jumpApex}+vMargin ${vMargin}, Δx ≤ hReach ${hReach.toFixed(2)})`,
      actual: `(${c.x.toFixed(2)}, ${c.y.toFixed(2)})`,
      status: "fail",
      detail: `"${c.name}" is NOT reachable: ${why}. Completion by teleport would mask this — reachability must hold geometrically.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}

/**
 * Build-mode reachability: read the feel budget out of the acceptance contract,
 * solve the envelope, and run the geometric check. Behavior is UNCHANGED from the
 * pre-F4 inline version — this is now a thin adapter over `feelEnvelope` +
 * `evaluateReachabilityEnvelope` (the same path the profile-verify mode reuses).
 */
export function evaluateReachability(
  layout: ReachabilityLayout,
  acceptance: AcceptanceContract,
): GateReport {
  return evaluateReachabilityEnvelope(layout, feelEnvelope(budgetFromAcceptance(acceptance)));
}
