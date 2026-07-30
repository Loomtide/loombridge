/**
 * Prop-purpose gate.
 *
 * WHY: a clean-room build placed a decorative box at the spawn point that
 * clipped the player and served NO gameplay role (no collider, no interactable
 * script). The perceptual VLM rated it a pass — "looks fine" — but a purposeless
 * object that overlaps the player at spawn is a real defect. This gate is PURE
 * geometry + component facts, so it catches both shapes deterministically:
 *
 *   1. PURPOSE — every prop must be FUNCTIONAL: it has a collider (it's stood on
 *      / blocks / collides) OR it carries an interactable gameplay script
 *      (Collectible / Hazard / Trampoline / LevelGoal …) OR it's explicitly
 *      listed as intentional decoration. A prop with none of these is dead
 *      clutter → FAIL.
 *   2. PLAYER-OVERLAP — no prop's bounds may intersect the player's bounds at
 *      spawn (a prop sitting on top of the player) → FAIL.
 *   3. GROUNDING — a prop dodged checks (1) + (2) by getting a collider and
 *      moving off the spawn, then was parked FLOATING (e.g. near the flag, base
 *      above the ground, over a gap). When `grounds` is captured, every prop's
 *      visible/collider BOTTOM must rest on (≈) some ground's `topY` while
 *      sitting horizontally over that same ground → PASS, else (it floats over a
 *      gap / above every ground) FAIL. Opt out via `props.intentionalFloating`
 *      (a deliberate floating collectible / cloud).
 *
 * INPUT (captured via `scene.get_bounds` + component listing), `objects.json`:
 *
 *   {
 *     player: { name, bounds: { minX, maxX, minY, maxY } },
 *     props: [
 *       { name, bounds: { minX, maxX, minY, maxY }, hasCollider: boolean, scripts: string[], bottomY?: number },
 *       ...
 *     ],
 *     grounds?: [{ name, minX, maxX, topY }],   // same shape the placement gate uses
 *   }
 *
 * ACCEPTANCE: the optional `props` section. A contract that declares ANY of it
 * must also declare `props.purposes` (refused at validation time, not skipped
 * here: ledger L101).
 *   • `intentionalDecor`     — prop names that pass PURPOSE even with no collider/script.
 *   • `intentionalFloating`  — prop names exempt from the GROUNDING check (a deliberate
 *     floating collectible / cloud). May also reuse `intentionalDecor`.
 *   • `checkPlayerOverlap`   — run the overlap rule unless explicitly false (default true).
 *   • `interactableScripts`  — script names that make a prop functional. Defaults to
 *     ["Collectible","Hazard","Trampoline","LevelGoal"] when omitted.
 *
 * The GROUNDING tolerance reuses `placement.groundedToleranceU` (default 0.1u).
 *
 * SKIPPED: the player itself + anything whose name matches the ground pattern
 * `/ground|terrain|platform|floor/i` (ground spans are handled by the placement
 * gate, not here).
 *
 * CHECKS (per prop):
 *  - PURPOSE (`prop-purpose.<name>`): hasCollider===true OR scripts ∩ interactable
 *    ≠ ∅ OR listed in intentionalDecor → PASS, else FAIL.
 *  - PLAYER-OVERLAP (`prop-overlap.<name>`, only when checkPlayerOverlap !== false):
 *    the prop's bounds rect must NOT intersect the player's bounds → PASS, else FAIL.
 *  - GROUNDING (`prop-grounded.<name>`, only when `grounds` is non-empty AND the prop
 *    isn't listed in intentionalFloating/intentionalDecor): the prop's bottom (its
 *    `bottomY` or, absent that, bounds.minY) must rest on (within tol of) some ground's
 *    `topY` while horizontally over that ground's [minX,maxX] → PASS, else FAIL
 *    (it floats above the nearest ground / over a gap). Backward-compatible: with no
 *    `grounds` the grounding check is skipped entirely.
 *  - No props captured → a single WARN (degrade, don't crash).
 *
 * Mirrors the doc-comment + GateCheck style of `placement.ts`.
 */

import type { AcceptanceContract, PropPurposeSpec } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** An axis-aligned bounds rectangle in world units. */
export interface PropBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The player's spawn footprint. */
export interface PropPlayer {
  name: string;
  bounds: PropBounds;
}

/** One scene prop with the facts the purpose/overlap/grounding rules need. */
export interface PropObject {
  name: string;
  bounds: PropBounds;
  /** Whether the prop has any (2D/3D) collider. */
  hasCollider?: boolean;
  /** Script class names attached to the prop. */
  scripts?: string[];
  /**
   * World-Y of the prop's visible/collider BOTTOM edge for the grounding check.
   * Falls back to `bounds.minY` when omitted.
   */
  bottomY?: number;
  /** Semantic role captured from the scene/builder, if known. */
  purpose?: string;
  /** Spatial evidence that this prop affects gameplay rather than merely existing. */
  routeEvidence?: {
    usedInTraversal?: boolean;
    connectsTo?: string;
    constrainsRoute?: boolean;
    supportsCollectible?: boolean;
  };
}

/** A standable ground span: its horizontal extent + top (standable) surface. */
export interface PropGround {
  name: string;
  /** Left/right world-X extent of the ground. */
  minX: number;
  maxX: number;
  /** World-Y of the top (standable) surface. */
  topY: number;
}

/** The `scene.get_bounds`-derived prop layout capture. */
export interface PropPurposeInput {
  player?: PropPlayer;
  props?: PropObject[];
  /**
   * Standable ground spans (same shape the placement gate captures). When present,
   * every non-exempt prop is checked for grounding. Absent → grounding check skipped.
   */
  grounds?: PropGround[];
}

export const GATE_NAME = "prop-purpose";

const EPS = 1e-6;

/** Default scripts that give a prop a gameplay purpose. */
const DEFAULT_INTERACTABLE_SCRIPTS = ["Collectible", "Hazard", "Trampoline", "LevelGoal"];

/** Ground-like names handled by the placement gate, skipped here. */
const GROUND_NAME_RE = /ground|terrain|platform|floor/i;

/** True when two AABBs overlap (touching edges alone is NOT an overlap). */
function rectsIntersect(a: PropBounds, b: PropBounds): boolean {
  return (
    a.minX < b.maxX - EPS &&
    a.maxX > b.minX + EPS &&
    a.minY < b.maxY - EPS &&
    a.maxY > b.minY + EPS
  );
}

function matchesPurposeSpec(
  prop: PropObject,
  spec: PropPurposeSpec,
): boolean {
  if (spec.name && prop.name === spec.name) return true;
  if (spec.nameRegex) {
    try {
      return new RegExp(spec.nameRegex, "i").test(prop.name);
    } catch {
      return false;
    }
  }
  return prop.purpose === spec.purpose;
}

function scriptIncludes(scripts: string[], needles: string[]): boolean {
  return scripts.some((script) =>
    needles.some((needle) => script.toLowerCase().includes(needle.toLowerCase())),
  );
}

export function evaluatePropPurpose(
  input: PropPurposeInput,
  acceptance: AcceptanceContract,
): GateReport {
  const props = input.props ?? [];
  const player = input.player;

  if (props.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "prop-purpose.data",
        expected: "≥1 prop captured",
        actual: "(none)",
        status: "warn",
        detail:
          "No props captured (objects.json had no props); prop-purpose not evaluated. Capture each non-ground object's bounds + hasCollider + scripts via scene.get_bounds + component listing.",
      },
    ]);
  }

  const cfg = acceptance.props ?? {};
  const interactable = cfg.interactableScripts ?? DEFAULT_INTERACTABLE_SCRIPTS;
  const intentionalDecor = new Set(cfg.intentionalDecor ?? []);
  // A prop exempt from grounding: explicit intentionalFloating OR reused intentionalDecor.
  const intentionalFloating = new Set([
    ...(cfg.intentionalFloating ?? []),
    ...(cfg.intentionalDecor ?? []),
  ]);
  const checkOverlap = cfg.checkPlayerOverlap !== false;
  const purposeSpecs = cfg.purposes ?? [];

  // Grounding is only evaluated when ground spans were captured (back-compat:
  // no grounds → skip the grounding check entirely, never regress old captures).
  const grounds = input.grounds ?? [];
  const checkGrounding = grounds.length > 0;
  // Reuse the placement gate's grounded slack so the two gates agree on "rests on".
  const groundedTol = acceptance.placement?.groundedToleranceU ?? 0.1;

  const checks: GateCheck[] = [];

  for (const prop of props) {
    // Skip the player itself + ground-like spans (placement gate owns those).
    if (player && prop.name === player.name) continue;
    if (GROUND_NAME_RE.test(prop.name)) continue;

    const hasCollider = prop.hasCollider === true;
    const scripts = prop.scripts ?? [];
    const matchedScript = scripts.find((s) => interactable.includes(s));
    const isDecor = intentionalDecor.has(prop.name);
    const declaredSpec = purposeSpecs.find((spec) => matchesPurposeSpec(prop, spec));
    const declaredPurpose = prop.purpose ?? declaredSpec?.purpose;

    // ---- PURPOSE ----
    const purposeId = `prop-purpose.${prop.name}`;
    const purposeExpected = "functional (has a collider OR an interactable script) OR listed in intentionalDecor";
    if (hasCollider || matchedScript || isDecor) {
      const reason = hasCollider
        ? "has a collider"
        : matchedScript
          ? `has interactable script "${matchedScript}"`
          : "is listed as intentional decor";
      checks.push({
        id: purposeId,
        expected: purposeExpected,
        actual: reason,
        status: "pass",
        detail: `Prop "${prop.name}" has a purpose (${reason}).`,
      });
    } else {
      checks.push({
        id: purposeId,
        expected: purposeExpected,
        actual: "no collider, no interactable script, not intentional decor",
        status: "fail",
        detail: `purposeless prop (no collider, no interactable script, not intentional decor): "${prop.name}" serves no gameplay role. Give it a collider/interactable script, list it in props.intentionalDecor, or remove it.`,
      });
    }

    // ---- SEMANTIC PURPOSE ----
    // UNCONDITIONAL (ledger L101). This used to read
    // `if (purposeSpecs.length > 0 || prop.purpose)`, which is the exact
    // falsy-skip CLAUDE.md forbids sitting on a gate's own opt-in seam: a
    // contract with no `props.purposes` plus a capture that omits `purpose`
    // disabled the whole semantic tier in silence. The rule now always runs; the
    // MIGRATION edge (a contract that never declared purposes) is answered at
    // CONTRACT VALIDATION, which refuses such a contract by name
    // (`props.purposes`) instead of letting the gate quietly grade nothing.
    {
      const semanticId = `prop-semantic.${prop.name}`;
      if (!declaredPurpose) {
        checks.push({
          id: semanticId,
          expected: "declared semantic gameplay purpose",
          actual: "none",
          status: hasCollider ? "fail" : "warn",
          detail: `Prop "${prop.name}" has no semantic purpose. A collider alone is not enough; declare route_platform/blocker/hazard/launcher/collectible/goal/cover/enemy/decor (in props.purposes, or as the capture's own purpose field) or remove it.`,
        });
      } else if (declaredPurpose === "decor") {
        checks.push({
          id: semanticId,
          expected: "decor is non-solid unless intentionalDecor",
          actual: hasCollider ? "solid decor" : "non-solid decor",
          status: hasCollider && !isDecor ? "fail" : "pass",
          detail:
            hasCollider && !isDecor
              ? `Prop "${prop.name}" is declared decor but has a collider. Make decor non-solid or list it in props.intentionalDecor if this is deliberate.`
              : `Prop "${prop.name}" is decor and does not create unintended gameplay collision.`,
        });
      } else {
        const evidence = prop.routeEvidence ?? {};
        let ok = true;
        let expected = "semantic role evidence";
        let actual = `purpose=${declaredPurpose}`;

        if (declaredPurpose === "route_platform" || declaredPurpose === "collectible_support") {
          expected = "used in traversal, connects route, or supports collectible";
          ok = evidence.usedInTraversal === true || Boolean(evidence.connectsTo) || evidence.supportsCollectible === true;
          actual = JSON.stringify(evidence);
        } else if (declaredPurpose === "launcher") {
          expected = "launcher script plus reachable target evidence";
          ok = scriptIncludes(scripts, ["trampoline", "launcher", "bounce"]) && (evidence.usedInTraversal === true || Boolean(evidence.connectsTo));
          actual = `scripts=${scripts.join(",") || "(none)"} evidence=${JSON.stringify(evidence)}`;
        } else if (declaredPurpose === "blocker") {
          expected = "constrains or redirects route";
          ok = evidence.constrainsRoute === true;
          actual = JSON.stringify(evidence);
        } else if (declaredPurpose === "hazard") {
          expected = "hazard script/role";
          ok = scriptIncludes(scripts, ["hazard", "damage", "spike", "saw"]);
          actual = `scripts=${scripts.join(",") || "(none)"}`;
        } else if (declaredPurpose === "collectible" || declaredPurpose === "pickup") {
          expected = "collectible/pickup script/role";
          ok = scriptIncludes(scripts, ["collectible", "pickup", "coin"]);
          actual = `scripts=${scripts.join(",") || "(none)"}`;
        } else if (declaredPurpose === "goal") {
          expected = "goal/level-complete script/role";
          ok = scriptIncludes(scripts, ["goal", "levelgoal", "finish", "checkpoint"]);
          actual = `scripts=${scripts.join(",") || "(none)"}`;
        } else if (declaredPurpose === "cover" || declaredPurpose === "enemy") {
          expected = "declared combat/navigation role";
          ok = true;
        }

        checks.push({
          id: semanticId,
          expected,
          actual,
          status: ok ? "pass" : "fail",
          detail: ok
            ? `Prop "${prop.name}" has semantic gameplay purpose "${declaredPurpose}" with acceptable evidence.`
            : `Prop "${prop.name}" is declared "${declaredPurpose}" but lacks the required evidence. A solid prop should affect traversal, combat, resource collection, hazard pressure, or the goal route.`,
        });
      }
    }

    // ---- PLAYER-OVERLAP ----
    if (checkOverlap && player) {
      const overlapId = `prop-overlap.${prop.name}`;
      const overlaps = rectsIntersect(prop.bounds, player.bounds);
      checks.push({
        id: overlapId,
        expected: "prop bounds do not intersect the player's bounds at spawn",
        actual: overlaps ? "overlaps the player" : "clear of the player",
        status: overlaps ? "fail" : "pass",
        detail: overlaps
          ? `prop overlaps the player at spawn: "${prop.name}" bounds [${prop.bounds.minX},${prop.bounds.minY}..${prop.bounds.maxX},${prop.bounds.maxY}] intersect the player "${player.name}" [${player.bounds.minX},${player.bounds.minY}..${player.bounds.maxX},${player.bounds.maxY}]. Move it off the spawn point.`
          : `Prop "${prop.name}" is clear of the player at spawn (no bounds overlap).`,
      });
    }

    // ---- GROUNDING (prop must rest on a ground, not float over a gap) ----
    // Skipped when no grounds were captured (back-compat) or the prop is an
    // explicit floating exemption (intentionalFloating / intentionalDecor).
    if (checkGrounding && !intentionalFloating.has(prop.name)) {
      const groundedId = `prop-grounded.${prop.name}`;
      const bottomY = prop.bottomY ?? prop.bounds.minY;
      // Grounds whose horizontal span overlaps the prop's footprint at all.
      const horizOverlapping = grounds.filter(
        (g) => prop.bounds.maxX > g.minX + EPS && prop.bounds.minX < g.maxX - EPS,
      );
      // A prop rests on a ground when its bottom is ≈ that ground's top (|Δ| ≤ tol)
      // AND it sits horizontally over that same ground.
      const resting = horizOverlapping.find(
        (g) => Math.abs(bottomY - g.topY) <= groundedTol,
      );
      // Nearest ground top BELOW the bottom, for the floats-over-a-gap message.
      const nearestTopY =
        grounds.length > 0
          ? grounds.reduce((best, g) =>
              Math.abs(bottomY - g.topY) < Math.abs(bottomY - best.topY) ? g : best,
            ).topY
          : undefined;
      const expected = `prop bottom Y ≈ some ground's top Y (|Δ| ≤ ${groundedTol}u) while over that ground`;

      if (resting) {
        checks.push({
          id: groundedId,
          expected,
          actual: `rests on "${resting.name}" (bottom Y ${bottomY}, ground top Y ${resting.topY})`,
          status: "pass",
          detail: `Prop "${prop.name}" rests on ground "${resting.name}" (bottom Y ${bottomY} ≈ top Y ${resting.topY}, |Δ| ${Math.abs(bottomY - resting.topY).toFixed(2)}u ≤ ${groundedTol}u).`,
        });
      } else {
        const gapNote = horizOverlapping.length === 0 ? " (over a gap — no ground beneath it)" : "";
        checks.push({
          id: groundedId,
          expected,
          actual: `floats — bottom Y ${bottomY}, nearest ground top Y ${nearestTopY ?? "n/a"}`,
          status: "fail",
          detail: `prop floats — base Y ${bottomY} above the nearest ground${nearestTopY !== undefined ? ` (top Y ${nearestTopY})` : ""} / over a gap: "${prop.name}" does not rest on any ground${gapNote}. Drop it onto a ground (bottom Y ≈ a ground top Y within ${groundedTol}u while over that ground), or list it in props.intentionalFloating if it's a deliberate floating object.`,
        });
      }
    }
  }

  // Every captured prop was the player / a ground span → nothing to assess.
  if (checks.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "prop-purpose.data",
        expected: "≥1 non-ground prop to assess",
        actual: "(only player/ground captured)",
        status: "warn",
        detail:
          "All captured objects were the player or ground spans; no decorative/functional prop to assess. prop-purpose not evaluated.",
      },
    ]);
  }

  return makeGateReport(GATE_NAME, checks);
}
