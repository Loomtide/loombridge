/**
 * Generic feel setup discovery (pure core).
 *
 * Inspect live Unity facts — a `ui.get_screen_rects` dump and (optionally) an
 * Animator controller's parameters — and PROPOSE likely drive controls and a
 * sampled sync signal for `verify --profile --setup-capture`. This is advisory:
 * it never binds evidence to a verdict, and an ambiguous match is surfaced as a
 * choice the developer must resolve, never silently picked. Fixed-Joystick-style
 * naming is matched only through generic uGUI conventions (jump/joystick), never
 * project-specific paths.
 */

import {
  SWEEP_BACKDROP_AREA,
} from "../minigame-role-discover.js";
import type {
  RawScreenObject,
  RawScreenRects,
} from "../minigame-capture-plan.js";

/** A discovered uGUI control candidate: a stable path + a human name. */
export interface FeelControlCandidate {
  path: string;
  name: string;
}

/**
 * The outcome of proposing a single role (jump button / joystick) from the
 * discovered candidates. `ambiguous` lists every plausible match so the developer
 * can choose; it is NEVER collapsed to a silent pick.
 */
export type FeelRoleProposal =
  | { kind: "proposed"; candidate: FeelControlCandidate }
  | { kind: "ambiguous"; candidates: FeelControlCandidate[] }
  | { kind: "none" };

export interface FeelUiDiscovery {
  controls: FeelControlCandidate[];
  jump: FeelRoleProposal;
  joystick: FeelRoleProposal;
}

// Generic uGUI naming conventions — not tied to any one project's hierarchy.
// Substring match so camelCase ("ButtonJump") and spaced ("Fixed Joystick")
// names both resolve; these tokens don't collide with unrelated game controls.
const JUMP_RE = /jump|jmp/i;
const JOYSTICK_RE = /joystick|joypad|thumbstick|d-?pad|stick/i;

function rawPath(raw: RawScreenObject): string {
  if (typeof raw.locator === "string") return raw.locator;
  if (raw.locator && typeof raw.locator.path === "string") return raw.locator.path;
  return raw.name ? `/${raw.name}` : "";
}

function viewportArea(raw: RawScreenObject): number {
  const rect = raw.viewportRect;
  const width = rect && typeof rect.width === "number" && Number.isFinite(rect.width) ? rect.width : 0;
  const height = rect && typeof rect.height === "number" && Number.isFinite(rect.height) ? rect.height : 0;
  return Math.max(0, width) * Math.max(0, height);
}

/**
 * An interactive uGUI control candidate: visible, a raycast target, not a
 * container, and not a full-frame backdrop (the same eligibility the mini-game
 * sweep uses). Pure over a `ui.get_screen_rects` dump.
 */
export function classifyFeelControlCandidates(rects: RawScreenRects): FeelControlCandidate[] {
  const objects = rects.objects ?? [];
  const seen = new Set<string>();
  const candidates: FeelControlCandidate[] = [];
  for (const raw of objects) {
    if (raw.isVisible !== true) continue;
    if (raw.role === "container") continue;
    if (raw.raycastTarget !== true) continue;
    if (viewportArea(raw) >= SWEEP_BACKDROP_AREA) continue;
    const path = rawPath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    candidates.push({ path, name: raw.name ?? path.split("/").filter(Boolean).at(-1) ?? path });
  }
  return candidates;
}

function leaf(candidate: FeelControlCandidate): string {
  return `${candidate.name} ${candidate.path.split("/").filter(Boolean).at(-1) ?? ""}`;
}

/**
 * Propose a control for a role from the candidate set: exactly one match ⇒
 * `proposed`, several ⇒ `ambiguous` (every match surfaced), none ⇒ `none`.
 */
export function proposeRoleControl(candidates: FeelControlCandidate[], pattern: RegExp): FeelRoleProposal {
  const matches = candidates.filter((c) => pattern.test(leaf(c)));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "proposed", candidate: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

/** Discover uGUI control candidates and propose jump / joystick roles. */
export function discoverUiControls(rects: RawScreenRects): FeelUiDiscovery {
  const controls = classifyFeelControlCandidates(rects);
  return {
    controls,
    jump: proposeRoleControl(controls, JUMP_RE),
    joystick: proposeRoleControl(controls, JOYSTICK_RE),
  };
}

/** A single Animator controller parameter from `animator.get_state_machine`. */
export interface AnimatorParameter {
  name: string;
  type?: string;
}

export type AnimatorBoolProposal =
  | { kind: "proposed"; bool: string }
  | { kind: "ambiguous"; bools: string[] }
  | { kind: "none"; reason: string };

export interface ResolvedDiscoveryRoles {
  jumpButtonPath?: string;
  joystickPath?: string;
  animatorBoolSignal?: { bool: string; host?: string };
  /** Human-readable lines describing what was proposed, ambiguous, or not found. */
  notes: string[];
}

function describeAmbiguous(role: string, paths: string[], flag: string): string {
  return `${role}: ambiguous — ${paths.length} candidates (${paths.join(", ")}). Not bound; pass ${flag} <path> to choose.`;
}

/**
 * Fold a live discovery + explicit developer overrides into drive facts. An
 * EXPLICIT flag always wins; an unambiguous proposal is adopted (and surfaced for
 * confirmation); an ambiguous match is reported with its choices and left UNBOUND
 * (never silently picked); nothing found is reported and left unbound.
 */
export function resolveDiscoveredRoles(args: {
  ui: FeelUiDiscovery;
  animatorBool?: AnimatorBoolProposal;
  explicit?: {
    jumpButtonPath?: string;
    joystickPath?: string;
    jumpKey?: string;
    moveRightKey?: string;
    animatorHost?: string;
  };
}): ResolvedDiscoveryRoles {
  const notes: string[] = [];
  const explicit = args.explicit ?? {};
  const result: ResolvedDiscoveryRoles = { notes };

  notes.push(`controls: discovered ${args.ui.controls.length} interactive uGUI candidate(s).`);

  if (explicit.jumpButtonPath) {
    result.jumpButtonPath = explicit.jumpButtonPath;
    notes.push(`jump: using explicit --jump-button ${explicit.jumpButtonPath}.`);
  } else if (explicit.jumpKey) {
    notes.push(`jump: using explicit --jump-key ${explicit.jumpKey}; discovery will not bind a uGUI jump button.`);
  } else if (args.ui.jump.kind === "proposed") {
    result.jumpButtonPath = args.ui.jump.candidate.path;
    notes.push(`jump: proposed ${args.ui.jump.candidate.path} (confirm with --apply).`);
  } else if (args.ui.jump.kind === "ambiguous") {
    notes.push(describeAmbiguous("jump", args.ui.jump.candidates.map((c) => c.path), "--jump-button"));
  } else {
    notes.push("jump: no uGUI candidate found; declare --jump-button or --jump-key, else it stays unsupported.");
  }

  if (explicit.joystickPath) {
    result.joystickPath = explicit.joystickPath;
    notes.push(`joystick: using explicit --joystick ${explicit.joystickPath}.`);
  } else if (explicit.moveRightKey) {
    notes.push(`joystick: using explicit --move-right-key ${explicit.moveRightKey}; discovery will not bind a uGUI joystick.`);
  } else if (args.ui.joystick.kind === "proposed") {
    result.joystickPath = args.ui.joystick.candidate.path;
    notes.push(`joystick: proposed ${args.ui.joystick.candidate.path} (confirm with --apply).`);
  } else if (args.ui.joystick.kind === "ambiguous") {
    notes.push(describeAmbiguous("joystick", args.ui.joystick.candidates.map((c) => c.path), "--joystick"));
  } else {
    notes.push("joystick: no uGUI candidate found; declare --joystick or --move-right-key, else it stays unsupported.");
  }

  if (args.animatorBool) {
    if (args.animatorBool.kind === "proposed") {
      result.animatorBoolSignal = { bool: args.animatorBool.bool, host: explicit.animatorHost };
      notes.push(`sync: proposed Animator.GetBool("${args.animatorBool.bool}") → inputToAnimStateLatency.`);
    } else if (args.animatorBool.kind === "ambiguous") {
      notes.push(`sync: ambiguous — Animator bools (${args.animatorBool.bools.join(", ")}). Not bound; pass --animator-bool <name> to choose.`);
    } else {
      notes.push(`sync: ${args.animatorBool.reason}`);
    }
  }

  return result;
}

function boolParameterNames(params: AnimatorParameter[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of params) {
    if (typeof p.name !== "string" || p.name.trim().length === 0) continue;
    if (typeof p.type === "string" && p.type.toLowerCase() !== "bool") continue;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p.name);
  }
  return out;
}

/**
 * Propose an Animator bool parameter to sample as a sync signal. An explicit
 * developer choice always wins; otherwise exactly one bool ⇒ propose it, several
 * ⇒ ambiguous (choices surfaced), none ⇒ nothing proposed (never invented).
 */
export function proposeAnimatorBool(
  params: AnimatorParameter[],
  explicitBool?: string,
): AnimatorBoolProposal {
  if (explicitBool && explicitBool.trim().length > 0) {
    return { kind: "proposed", bool: explicitBool };
  }
  const bools = boolParameterNames(params);
  if (bools.length === 0) {
    return { kind: "none", reason: "no Animator bool parameter was discovered to sample." };
  }
  if (bools.length === 1) return { kind: "proposed", bool: bools[0] };
  return { kind: "ambiguous", bools };
}
