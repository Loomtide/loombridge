/**
 * `loombridge minigame finalize` — turn a placeholder `setup`/`init` contract into a
 * real one from OBSERVED Unity data, so a developer never hand-edits hierarchy paths.
 *
 * `setup` writes a VALID but placeholder contract (locators like
 * `StartScreen/StartButton`, ids like `playArea`/`scoreDisplay`, `TODO:` text).
 * `finalize` reads the REAL per-state capture pack (`<state>.ui-rects.json`, the
 * `unity_ui_get_screen_rects` output: real object `path`/`role`/`text`/visibility)
 * — optionally cross-checked against the first observed replay click — infers which
 * real scene object plays each role (start control, home/back, the active play area,
 * the reward object), and REWRITES the contract's `requiredInFrame` + per-state
 * bindings to those real objects.
 *
 * Honest-or-refuse (CLAUDE.md verification invariants): it NEVER emits a placeholder
 * locator and NEVER invents an object to pass validation. If the capture pack is
 * absent, a required state is missing, or a role can't be inferred with confidence
 * (a keyword/observed-click match), it REFUSES with exit 2 and names what's missing.
 *
 * It reads the workspace capture pack + (optional) replay root and writes ONLY the
 * finalized contract (in place, or to `--output`). It never touches the Unity
 * project, never calls the bridge, and adds no gates.
 *
 * Exit codes:
 *   0  contract finalized + written (every role resolved, validates)
 *   2  usage / capture pack missing / required state capture missing / a role
 *      could not be inferred (named)
 *   1  unexpected filesystem or runtime error
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ICON } from "../../shared/cli-ui.js";
import { isDraftDescription } from "./minigame-draft.js";
import { printNextStep } from "./minigame-next.js";

import { assertValidMinigameContract } from "./profiles/validator.js";
import {
  OUTCOME_GATEABLE_KINDS,
  isObjectLocator,
  type MinigameContract,
  type MinigameObjectRef,
  type MinigameState,
} from "./profiles/types.js";
import type {
  BackgroundCandidates,
  BackgroundData,
  MinigameCaptureObject,
} from "./types.js";
import { BACKGROUND_DATA_FILE } from "./run-minigame-gates.js";
import {
  actionLocatorPath,
  planCaptureFromTrace,
  planResponseStimulus,
  stripScene,
} from "./minigame-capture-plan.js";
import type { Action, ReplayTrace } from "../replay/types.js";
import { flatReplayLayout } from "../../domain/state.js";

/** Per-state visible/real objects, keyed by contract state id. */
export type CapturePack = Map<string, MinigameCaptureObject[]>;

/** Outcome of loading a capture pack for a contract's declared states. */
export type CaptureLoad =
  | { kind: "ok"; pack: CapturePack }
  | { kind: "empty" }
  | { kind: "missing"; states: string[] };

/** One semantic role the finalizer must bind to a real object. */
export interface RoleSpec {
  /** Human label used in the summary + refusal (e.g. "start control"). */
  role: string;
  /** Stateskinds whose captures are searched for this role's object. */
  kinds: MinigameState["kind"][];
  /** Name/text keyword the object must match (confidence gate — no match ⇒ refuse). */
  keyword: RegExp;
  /** Require the object to be an interactive control (raycastTarget). */
  requireRaycast: boolean;
  /** Prefer this uGUI role when several match (e.g. "container" for the play area). */
  preferRole?: string;
  /** Reject any candidate whose HIERARCHY PATH matches this (e.g. persistent-HUD progress pips). */
  excludePath?: RegExp;
  /** Drop near-full-frame backdrops/overlays (area ≥ 85% of the estimated frame). */
  excludeBackdrops?: boolean;
  /** Among the survivors, pick the LARGEST by screen area (the prominent element). */
  preferLargest?: boolean;
}

/**
 * The role contract the scaffold encodes (start / play-area / reward / home). These
 * mirror the placeholder ids `setup` writes, but are inferred fresh from real data —
 * the finalizer does NOT trust the draft's placeholder ids or locators.
 */
export const ROLE_SPECS: RoleSpec[] = [
  {
    role: "start control",
    kinds: ["start"],
    keyword: /start|play|begin|^go$|new|tap|tutorial/i,
    requireRaycast: true,
  },
  {
    role: "home/back control",
    kinds: ["active", "success_reward", "failure_timeout", "home_back"],
    keyword: /home|back|menu|exit|quit|close|return/i,
    requireRaycast: true,
  },
  {
    role: "active play area",
    kinds: ["active"],
    keyword: /answer|play|board|grid|panel|area|tile|card|option|choice|button|target|cell|slot|drop|zone/i,
    requireRaycast: true,
    preferRole: "container",
  },
  {
    role: "reward object",
    kinds: ["success_reward"],
    keyword: /reward|end|card|win|score|replay|star|trophy|summary|result|complete|prize|finish|well|congrat/i,
    requireRaycast: false,
    // The reward is the prominent celebration element on the success screen — NOT a
    // persistent-HUD progress pip (e.g. `/HUD/Progress/Star3`, which is also on the
    // active screen and tiny) and NOT the full-frame dimming overlay. Exclude both and
    // prefer the largest survivor (the win card/panel), so it never binds a 38px score
    // indicator that the tap-target gate would then flag as "too small to tap".
    excludePath: /(^|\/)progress(\/|$)/i,
    excludeBackdrops: true,
    preferLargest: true,
  },
];

/**
 * The control path the DEMONSTRATED trace bound to each role, derived from the same
 * trace→state alignment `minigame capture` uses (`planCaptureFromTrace`). When the dev
 * actually tapped/dragged a role's control, that path is stronger evidence than any
 * keyword/raycast heuristic — so finalize binds it directly (see `inferFinalizedContract`).
 * Reward has no single demonstrated control, so it isn't derived here (keyword-only).
 */
export interface DemonstratedControls {
  /** Candidate paths whose interaction ENTERED the active state (e.g. a hub tile / Play button).
   * Ordered, resolved in order against the captures. A DRAG yields [target, source] so a gameplay
   * drag binds the visible/captured SOURCE when the target is an invisible drop zone. */
  startControl?: string[];
  /** Candidate paths for the gameplay interaction WHILE active (drag → [drop-zone, dragged-object]). */
  activePlayArea?: string[];
  /** Candidate paths whose interaction produced the home_back state. */
  homeBack?: string[];
}

/** The interacted scene paths of an action, target-first: tap → [locator]; drag → [to, from]. */
function actionPaths(action: Action | undefined): string[] {
  if (!action) return [];
  if (action.do === "drag") {
    return [action.to?.path, action.from?.path].filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  if (action.do === "tap" || action.do === "world-tap") {
    return action.locator?.path ? [action.locator.path] : [];
  }
  return [];
}

/**
 * Derive the demonstrated control path per role from the recorded trace, using the EXACT
 * alignment `minigame capture` computes (`planCaptureFromTrace` + `planResponseStimulus`):
 *   - startControl   = the action that ENTERS the active state (its `after-action` trigger).
 *   - activePlayArea = the gameplay stimulus tap/drag on the active state.
 *   - homeBack       = the action that produces the home_back state.
 * Defensive: any missing / unreached / out-of-range alignment leaves that field undefined.
 * Pure (no fs) so finalize's trace-first binding is unit-testable without a replay root.
 *
 * KNOWN v1 limitations (the alignment assumes the scaffold's `start → (one tap) → active` shape):
 *   - home/back is STILL keyword-anchored: `planCaptureFromTrace` locates the home tap via
 *     `HOME_BACK_RE` (home|back|menu|return|exit|quit|close), so a home control named outside
 *     that set (e.g. "Lobby") yields no `homeBack` and falls back to the role keyword. Trace
 *     generalization covers start control + active play area; home/back remains keyword-gated.
 *   - a game with EXTRA screens before gameplay (hub → game-home → play) binds the FIRST tap as
 *     the start control (the hub tile), and the play-area stimulus may be a navigation tap.
 *   - a game with NO distinct start screen (gameplay from frame 1) mislabels the first gameplay
 *     tap as the start control. Only the FIRST gameplay action binds the play area (the rest are
 *     not bound). These shapes bind a valid object but not always the ideal one; the dev can
 *     hand-edit, and finalize still refuses rather than invent.
 */
export function traceDemonstratedControls(
  contract: MinigameContract,
  trace: ReplayTrace,
): DemonstratedControls {
  const plan = planCaptureFromTrace(contract, trace);
  const out: DemonstratedControls = {};

  // The action at a state's `after-action` anchor (the interaction that produced that state). In a
  // fused multi-scene contract several states share a kind (a `home__active` hub AND a
  // `star-chef__active` gameplay state); the FIRST is the entry/hub, anchored at {initial} (not an
  // action). So we pick the first state OF THAT KIND whose plan trigger IS an action — the gameplay
  // scene's. Single-scene has one such state, so this binds the same action as before.
  const afterAction = (kind: MinigameState["kind"]): Action | undefined => {
    for (const s of contract.states) {
      if (s.kind !== kind) continue;
      const sp = plan.states.find((p) => p.stateId === s.id);
      if (sp && sp.trigger.kind === "after-action") return plan.flatActions[sp.trigger.index];
    }
    return undefined;
  };

  out.startControl = actionPaths(afterAction("active")); // the interaction that transitioned start→active
  out.homeBack = actionPaths(afterAction("home_back")); // the interaction that produced home_back

  const stimulus = planResponseStimulus(contract, plan);
  if (stimulus) out.activePlayArea = actionPaths(plan.flatActions[stimulus.stimulusIndex]);

  return out;
}

/** True when `ancestor` is a strict path-ancestor of `p` (segment boundary respected). */
function isAncestorPath(ancestor: string, p: string): boolean {
  return p.startsWith(`${ancestor}/`);
}

/**
 * Resolve a DEMONSTRATED trace path to a captured uGUI object in `pool`. A trace path may
 * not be an exact captured object — a custom-tap container (`/Canvas/Tiles/Tile_StarChef`)
 * whose CHILDREN are the captured uGUI objects, or a child whose captured object is its
 * parent. Resolution order (closest first); deterministic:
 *   1. exact            — `obj.path === tappedPath`.
 *   2. nearest DESCENDANT — objects under `tappedPath/…`; pick the LARGEST by screen area (the
 *      widget body, not a tiny badge/glyph), lexicographic path tie-break for determinism.
 *   3. nearest ANCESTOR   — objects that are a prefix of `tappedPath`, EXCLUDING near-full-frame
 *      containers (never launder the Canvas/scene root as a "control"); the deepest of those.
 *   4. null (→ finalize refuses; it never invents a binding).
 * The dev proved this path is the control, so this BYPASSES the keyword filter (but NOT the
 * "don't bind a frame-filling root" guard, so a sparse capture can't silently bind the canvas).
 */
export function resolveCapturedObject(
  pool: MinigameCaptureObject[],
  tappedPath: string,
): MinigameCaptureObject | null {
  const exact = pool.find((o) => o.path === tappedPath);
  if (exact) return exact;

  // Nearest captured DESCENDANT — prefer the LARGEST child (the widget body), so safe-area /
  // tap-target gates measure the control, not a tiny badge. Deterministic on area ties.
  const descendants = pool.filter((o) => isAncestorPath(tappedPath, o.path));
  if (descendants.length > 0) {
    return descendants.reduce((best, o) => {
      const da = rectArea(o);
      const ba = rectArea(best);
      if (da !== ba) return da > ba ? o : best;
      return o.path < best.path ? o : best;
    });
  }

  // Nearest captured ANCESTOR, but NEVER a near-full-frame container (the Canvas/scene root) —
  // that would launder a frame-filling object as the control, defeating the refusal the keyword
  // path would have given. Of the non-backdrop ancestors, the deepest (closest parent).
  const frameArea = estimateFrameArea(pool);
  const ancestors = pool.filter(
    (o) => isAncestorPath(o.path, tappedPath) && (frameArea <= 0 || rectArea(o) < 0.85 * frameArea),
  );
  if (ancestors.length > 0) {
    return ancestors.reduce((best, o) => (o.path.length > best.path.length ? o : best));
  }

  return null;
}


/** A path segment safe to interpolate into a filename (no separators / traversal). */
function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("..") &&
    !segment.includes("\0")
  );
}

/**
 * Object-referencing contract fields the finalizer does NOT yet infer. If a draft
 * carries any (non-empty), finalize would either pass their PLACEHOLDER locators
 * through untouched (`allowedOffscreen`) or leave their object-id references dangling
 * after the rewrite (`containers`, `baseline.masks`). Honest-or-refuse: name them and
 * refuse rather than emit a "finalized" contract that still contains placeholders.
 */
export function unsupportedDraftFields(draft: MinigameContract): string[] {
  const fields: string[] = [];
  if (draft.allowedOffscreen && draft.allowedOffscreen.length > 0) fields.push("allowedOffscreen");
  if (draft.containers && draft.containers.length > 0) fields.push("containers");
  if (draft.baseline?.masks && draft.baseline.masks.length > 0) fields.push("baseline.masks");
  return fields;
}

/** Leaf object name from a hierarchy path: `/HUD/StartScreen/StartButton` → `startbutton`. */
function leaf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** The text we match a keyword against: the object's leaf name + any text content. */
function haystack(o: MinigameCaptureObject): string {
  return `${leaf(o.path)} ${(o.text ?? "").toLowerCase()}`;
}

/** Derive the readable scene-name prefix for a locator from a scene asset path. */
export function deriveSceneName(scenePath: string | undefined): string | undefined {
  if (!scenePath) return undefined;
  const base = path.basename(scenePath);
  return base.endsWith(".unity") ? base.slice(0, -".unity".length) : base;
}

/** Build a canonical Loombridge locator (`SceneName:/Path`, or bare `/Path`). */
export function buildLocator(sceneName: string | undefined, objectPath: string): string {
  const loc = sceneName ? `${sceneName}:${objectPath}` : objectPath;
  // Defensive: if the assembled form isn't a valid locator, fall back to the bare path.
  return isObjectLocator(loc) ? loc : objectPath;
}

/**
 * Objects that would PASS `required-in-frame` in a state — the EXACT gate predicate
 * (`active && isVisible && isFullyVisible === true`), so a bound object can never fail
 * the very check it was bound for (a partially-clipped object is not bindable).
 */
function visibleObjects(pack: CapturePack, stateId: string): MinigameCaptureObject[] {
  return (pack.get(stateId) ?? []).filter(
    (o) => o.active && o.isVisible && o.isFullyVisible === true,
  );
}

/**
 * Gather the visible objects across every contract state whose `kind` is in `kinds`,
 * deduped by id (first occurrence wins) and kept in (state-order, capture-order) so
 * the pick is deterministic.
 */
function candidates(
  draft: MinigameContract,
  pack: CapturePack,
  kinds: MinigameState["kind"][],
): MinigameCaptureObject[] {
  const seen = new Set<string>();
  const out: MinigameCaptureObject[] = [];
  for (const state of draft.states) {
    if (!kinds.includes(state.kind)) continue;
    for (const obj of visibleObjects(pack, state.id)) {
      if (seen.has(obj.id)) continue;
      seen.add(obj.id);
      out.push(obj);
    }
  }
  return out;
}

/** Screen-rect area of an object (0 when geometry is absent/non-finite). */
function rectArea(o: MinigameCaptureObject): number {
  const r = o.screenRect;
  if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return 0;
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/**
 * Estimate the frame area from the pool's max screen extents — finalize's capture pack
 * carries no viewport, so derive it from the furthest object edges (the full-frame
 * backdrops define the frame). Used to drop near-full-frame overlays from a role.
 */
function estimateFrameArea(pool: MinigameCaptureObject[]): number {
  let w = 0;
  let h = 0;
  for (const o of pool) {
    const r = o.screenRect;
    if (r && Number.isFinite(r.x) && Number.isFinite(r.width)) w = Math.max(w, r.x + r.width);
    if (r && Number.isFinite(r.y) && Number.isFinite(r.height)) h = Math.max(h, r.y + r.height);
  }
  return w * h;
}

/** Pick the best object for a role from its candidate pool (deterministic, or null). */
function pickForRole(
  pool: MinigameCaptureObject[],
  spec: RoleSpec,
  exclude: Set<string>,
): MinigameCaptureObject | null {
  let matches = pool.filter(
    (o) =>
      !exclude.has(o.id) &&
      spec.keyword.test(haystack(o)) &&
      (!spec.excludePath || !spec.excludePath.test(o.path)) &&
      (!spec.requireRaycast || o.raycastTarget === true),
  );
  if (spec.excludeBackdrops) {
    const frameArea = estimateFrameArea(pool);
    if (frameArea > 0) matches = matches.filter((o) => rectArea(o) < 0.85 * frameArea);
  }
  if (matches.length === 0) return null;
  if (spec.preferRole) {
    const preferred = matches.find((o) => o.role === spec.preferRole);
    if (preferred) return preferred;
  }
  if (spec.preferLargest) {
    return matches.reduce((best, o) => (rectArea(o) > rectArea(best) ? o : best));
  }
  return matches[0];
}

/** A resolved role → real object binding. */
export interface ResolvedRole {
  role: string;
  id: string;
  path: string;
  locator: string;
}

export interface InferResult {
  resolved: ResolvedRole[];
  unresolved: { role: string; reason: string }[];
  /** The finalized contract — present only when every role resolved AND it validates. */
  contract?: MinigameContract;
}

/**
 * Infer real role bindings from the capture pack and rewrite the draft contract.
 *
 * `traceControls` (optional) carries the control paths the dev DEMONSTRATED in the
 * recorded trace (`traceDemonstratedControls`). For each demonstrated role, finalize
 * binds the captured object that path resolves to (`resolveCapturedObject`), BYPASSING
 * the keyword + raycast heuristics — a real human interaction is stronger evidence than
 * a name match, and generalizes past the CountFruits-tuned keyword set (e.g. a non-
 * raycast hub tile, a `MixZone` play area). A role the trace doesn't demonstrate falls
 * back to the keyword heuristic unchanged.
 *
 * `traceStartPath` is the legacy single-path start hint; when given without
 * `traceControls.startControl` it still seeds the start binding (back-compat).
 */
export function inferFinalizedContract(
  draft: MinigameContract,
  pack: CapturePack,
  opts: { traceStartPath?: string; traceControls?: DemonstratedControls } = {},
): InferResult {
  const sceneName = deriveSceneName(draft.scenes[0]);
  const resolved: ResolvedRole[] = [];
  const unresolved: { role: string; reason: string }[] = [];
  const chosenIds = new Set<string>();
  const byRole = new Map<string, MinigameCaptureObject>();

  // A role whose states are ALL outcome-gated is not asserted by design — a read-only
  // verifier can't drive that screen (e.g. the reward on a win-gated, re-randomizing game).
  // Don't bind it and don't refuse for it; verify reports the gated state separately.
  const isOutcomeGated = (stateId: string): boolean =>
    draft.states.find((s) => s.id === stateId)?.outcomeGated === true;
  const roleIsGated = (spec: RoleSpec): boolean => {
    const roleStates = draft.states.filter((s) => spec.kinds.includes(s.kind));
    return roleStates.length > 0 && roleStates.every((s) => isOutcomeGated(s.id));
  };

  // The control path the recorded trace demonstrated for each role (if any). The dev
  // proved these are the controls, so a demonstrated path binds DIRECTLY — bypassing the
  // CountFruits-tuned keyword + raycast heuristics that fail on other games.
  const controls = opts.traceControls ?? {};
  const demonstratedFor = (spec: RoleSpec): string[] => {
    if (spec.role === "start control") {
      const paths = controls.startControl ?? [];
      return paths.length > 0 ? paths : opts.traceStartPath ? [opts.traceStartPath] : [];
    }
    if (spec.role === "active play area") return controls.activePlayArea ?? [];
    if (spec.role === "home/back control") return controls.homeBack ?? [];
    return []; // reward (and any future role) is keyword-only
  };

  ROLE_SPECS.forEach((spec) => {
    // A role whose kind matches NO declared state has no screen to bind — e.g. a fused hub→game
    // contract with no `start` state, or a game that starts gameplay from frame 1. It's N/A: don't
    // bind it and don't refuse for it (the same "nothing to bind ⇒ not required" stance as an
    // outcome-gated role, which roleIsGated only reaches when length > 0). Without this, a multi-scene
    // contract whose scans never produced a `start` state could never finalize.
    if (!draft.states.some((s) => spec.kinds.includes(s.kind))) return;
    if (roleIsGated(spec)) return; // outcome-gated role — not required, not bound
    const pool = candidates(draft, pack, spec.kinds);
    let obj: MinigameCaptureObject | null = null;

    // Trace-first: bind the control the dev demonstrated for this role, resolving each
    // candidate path (in order) to a captured object (exact / nearest child / nearest parent)
    // and bypassing keyword + raycast. A real interaction beats a name match. (A drag offers
    // [drop-zone, dragged-object] so the visible dragged control binds when the zone is invisible.)
    const tappedPaths = demonstratedFor(spec);
    for (const tp of tappedPaths) {
      const candidate = resolveCapturedObject(pool, tp);
      if (candidate && !chosenIds.has(candidate.id)) {
        obj = candidate;
        break;
      }
    }
    // Keyword fallback: only when the trace demonstrated nothing that resolved.
    if (!obj) obj = pickForRole(pool, spec, chosenIds);

    if (!obj) {
      const where = spec.kinds.join("/");
      const demoNote = tappedPaths.length > 0
        ? ` (the trace interacted with ${tappedPaths.join(" / ")}, but no captured ${where}-screen object resolved to it)`
        : " (the trace demonstrated no control for it either)";
      unresolved.push({
        role: spec.role,
        reason:
          pool.length === 0
            ? `no visible object in the ${where} screen capture(s) — capture that screen, or this game has no ${spec.role}`
            : `no visible ${where}-screen object looked like a ${spec.role} (none matched ${spec.keyword})${demoNote}`,
      });
      return;
    }
    chosenIds.add(obj.id);
    byRole.set(spec.role, obj);
    resolved.push({
      role: spec.role,
      id: obj.id,
      path: obj.path,
      locator: buildLocator(sceneName, obj.path),
    });
  });

  if (unresolved.length > 0) return { resolved, unresolved };

  // Per state, require the DISTINCTIVE objects the scan declared for that screen (the per-phase
  // identity — ingredients on `mix`, toppings on `decorate`, the power button on `cook`) PLUS the
  // inferred roles, keeping only those actually VISIBLE in that state's capture. Two reasons this
  // matters, both surfaced by the live multi-scene run:
  //   1. Without the distinctive objects every phase of a multi-screen scene collapses to the shared
  //      home button, so the flow check can't tell `mix` from `cook` and reports a false "did not
  //      advance". The distinctive set is exactly what makes states distinguishable.
  //   2. Only-if-visible keeps the binding honest (required-in-frame can't fail on a hidden object).
  // The global registry is built HERE, in happyPath order, so each object's locator carries the scene
  // it FIRST appears in — fixing the multi-scene prefix bug (finalize previously stamped every object
  // with scenes[0], mislabeling a second scene's objects). Matching is path-based so this is cosmetic,
  // but a correct prefix keeps the contract honest. Single-scene contracts (no per-state `scene`) fall
  // back to scenes[0] and are byte-identical to before.
  // Each draft requiredInFrame object id → its scene-stripped path. The fused contract NAMESPACES
  // object ids (`star-chef__ingredientSpray`) but leaves locators as bare paths, while the capture pack
  // keys objects by BARE id — so distinctive objects must be matched by PATH, the system's scene-agnostic
  // convention, not by id.
  const draftPathById = new Map((draft.requiredInFrame ?? []).map((o) => [o.id, stripScene(o.locator)]));
  const registry = new Map<string, MinigameObjectRef>();
  const fallbackScene = deriveSceneName(draft.scenes[0]);
  // Preserving the scan's per-phase DISTINCTIVE objects matters only for a fused MULTI-SCENE contract,
  // where several `active` phases (mix/cook/decorate) would otherwise collapse to the shared home button
  // and become indistinguishable to the flow check. A single-scene game's flow is already distinguished by
  // its roles, so it keeps the exact role-only binding (byte-identical) — no broad behaviour change.
  // Count DISTINCT state scenes, not "any state has a scene": the scaffold/scan stamps `scene` on EVERY
  // state even in a single-scene contract, so `some(s => s.scene)` would wrongly trip the multi-scene path.
  const distinctStateScenes = new Set<string>();
  for (const s of draft.states) if (typeof s.scene === "string" && s.scene) distinctStateScenes.add(s.scene);
  const isMultiScene = (draft.scenes?.length ?? 0) > 1 || distinctStateScenes.size > 1;
  const states: MinigameState[] = draft.states.map((state) => {
    const visible = visibleObjects(pack, state.id);
    const visibleById = new Map(visible.map((o) => [o.id, o]));
    const visibleByPath = new Map(visible.map((o) => [o.path, o]));
    const sceneName = state.scene ?? fallbackScene;
    const boundPaths = new Set<string>();
    const bound: string[] = [];
    const add = (id: string, objPath: string, description: string): void => {
      if (boundPaths.has(objPath)) return; // a role + a distinctive id can share a path (the home button)
      boundPaths.add(objPath);
      bound.push(id);
      if (!registry.has(id)) registry.set(id, { id, locator: buildLocator(sceneName, objPath), description });
    };
    // Roles FIRST (by their pack id), so a path shared with a distinctive object keeps the role id/label.
    for (const r of resolved) {
      const obj = visibleById.get(r.id);
      if (obj) add(r.id, obj.path, `Inferred ${r.role} (${obj.path}).`);
    }
    // Then the scan's DISTINCTIVE objects for this screen (resolved by path), keeping only those VISIBLE
    // here. Without them a multi-phase scene's states share only the home button and the flow check can't
    // tell `mix` from `cook` — a false "did not advance". Only-if-visible keeps the binding honest.
    // Multi-scene only (see isMultiScene) so a single-scene contract stays byte-identical.
    if (isMultiScene) {
      for (const draftId of state.requiredInFrame ?? []) {
        const p = draftPathById.get(draftId);
        const obj = p ? visibleByPath.get(p) : undefined;
        // Bind the PACK's id (`obj.id`, bare), NOT the draft's namespaced id (`star-chef__powerButton`):
        // the captures + the required-in-frame/flow gates match objects by id, and the capture ids are
        // bare. A namespaced id would never match its bare capture object → a false "not visible".
        if (obj) add(obj.id, obj.path, `Distinctive object on the ${state.kind} screen (${obj.path}).`);
      }
    }
    return { ...state, requiredInFrame: bound, description: `${state.kind} screen.` };
  });
  const requiredInFrame: MinigameObjectRef[] = [...registry.values()];

  const contract: MinigameContract = {
    ...draft,
    // Replace a placeholder top-level description (scaffold `TODO:` or scan `DRAFT:`) so a finalized
    // contract no longer reads as a draft. Downstream draft detection (`isDraftContract`, the
    // finalize-vs-verify routing + capture's reorder guard) keys off these placeholder prefixes —
    // leaving one would let re-capture silently reorder, or `next` loop on finalize.
    description: isDraftDescription(draft.description)
      ? "Finalized 2D kids mini-game verification contract (locators inferred from captures)."
      : draft.description,
    requiredInFrame,
    states,
  };
  // A finalized contract that doesn't validate is a finalizer bug, surfaced loudly.
  assertValidMinigameContract(contract);
  return { resolved, unresolved, contract };
}

/** Find a captured object by its (path-derived) id anywhere in the pack. */
function findInPack(pack: CapturePack, id: string): MinigameCaptureObject | undefined {
  for (const objs of pack.values()) {
    const o = objs.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

/**
 * Apply a `--input-response <state>:<tap>:<observe…>` declaration to the finalized contract:
 * resolve each referenced id from the capture pack (so the developer can only reference REAL
 * captured ids — the ones `minigame capture` suggested, never invented), add any not already
 * in the object registry, set the state's `inputResponse`, and enable the `input-response`
 * check. The gate still RE-DERIVES the result from `<state>.response.json` — declaring it here
 * is a claim ("this should change on a tap"), not a graded pass. Returns `{ error }` (exit 2)
 * on an unknown state / unresolvable id / a contract that no longer validates.
 */
export function applyInputResponseFlag(
  contract: MinigameContract,
  pack: CapturePack,
  ir: { state: string; tap: string; observe: string[] },
): { contract: MinigameContract } | { error: string } {
  if (!contract.states.some((s) => s.id === ir.state)) {
    return { error: `--input-response: '${ir.state}' is not a declared state.` };
  }
  const sceneName = deriveSceneName(contract.scenes[0]);
  const required = [...contract.requiredInFrame];
  const haveId = new Set(required.map((o) => o.id));
  for (const id of [...new Set([ir.tap, ...ir.observe])]) {
    if (haveId.has(id)) continue;
    const obj = findInPack(pack, id);
    if (!obj) {
      return { error: `--input-response: object id '${id}' was not found in the captures — use the ids \`minigame capture\` suggested.` };
    }
    required.push({ id, locator: buildLocator(sceneName, obj.path), description: `Input-response object (${obj.path}).` });
    haveId.add(id);
  }
  const states = contract.states.map((s) =>
    s.id === ir.state ? { ...s, inputResponse: { tap: ir.tap, observe: ir.observe } } : s,
  );
  const deterministic = contract.checks.deterministic.includes("input-response")
    ? contract.checks.deterministic
    : [...contract.checks.deterministic, "input-response" as const];
  const next: MinigameContract = { ...contract, requiredInFrame: required, states, checks: { ...contract.checks, deterministic } };
  try {
    assertValidMinigameContract(next);
  } catch (error) {
    return { error: `--input-response produced an invalid contract: ${message(error)}` };
  }
  return { contract: next };
}

/** Add background geometry gates to the deterministic checks (dedup). */
function withBackgroundCheck(deterministic: string[]): string[] {
  const out = [...deterministic];
  for (const check of ["background-coverage", "background-seam"]) {
    if (!out.includes(check)) out.push(check);
  }
  return out;
}

/**
 * Apply a `--background <auto|off>` / `--background-camera + --background-layers` declaration: the
 * CONFIRM side of background geometry suggest-and-confirm. It binds (or removes) the gates AND,
 * when enabling, returns the FROZEN `background.json` geometry so `verify` runs with no re-capture.
 *
 * Anti-gaming (CLAUDE.md): `background.json` is ONLY written from REAL captured AABBs.
 *   - `auto` binds the discovered recommendation (camera + recommended layers) and emits their geometry.
 *   - `explicit` binds the dev's camera + layers and synthesizes geometry ONLY by LOCATOR match against
 *     `candidates` (camera from `camera`/`cameras`, each layer from `allLayers`). If candidates is null
 *     or ANY chosen locator isn't found, the gate is still enabled but NO geometry is fabricated — the
 *     caller instructs a re-capture (an assumed-covered box is never synthesized).
 *   - `off` removes the gate + its bindings.
 * The contract is always re-validated (the validator refuses a gate-on contract with missing bindings).
 * PURE: no fs. Returns `{ error }` (exit 2) on any failure.
 */
export function applyBackgroundFlag(
  contract: MinigameContract,
  candidates: BackgroundCandidates | null,
  decl: NonNullable<FinalizeArgs["background"]>,
): { contract: MinigameContract; backgroundData?: BackgroundData } | { error: string } {
  if (decl.mode === "off") {
    const deterministic = contract.checks.deterministic.filter((c) => c !== "background-coverage" && c !== "background-seam");
    const next: MinigameContract = { ...contract, checks: { ...contract.checks, deterministic } };
    delete next.backgroundCamera;
    delete next.backgroundLayers;
    try {
      assertValidMinigameContract(next);
    } catch (error) {
      return { error: `--background off produced an invalid contract: ${message(error)}` };
    }
    return { contract: next };
  }

  if (decl.mode === "auto") {
    if (!candidates || !candidates.camera || candidates.recommended.length === 0) {
      const why = !candidates
        ? "no background-candidates.json was found in the captures dir — run `minigame capture` first"
        : !candidates.camera
          ? "discovery found no gameplay camera"
          : "discovery recommended no coverage layers";
      const warn = candidates && candidates.warnings.length > 0 ? ` (${candidates.warnings.join("; ")})` : "";
      return {
        error:
          `--background auto: ${why}${warn}. ` +
          "Provide the binding explicitly with --background-camera <locator> + --background-layers <loc1,loc2,...>.",
      };
    }
    const next: MinigameContract = {
      ...contract,
      backgroundCamera: candidates.camera.locator,
      backgroundLayers: candidates.recommended.map((r) => r.locator),
      checks: { ...contract.checks, deterministic: withBackgroundCheck(contract.checks.deterministic) },
    };
    const missingOrder = candidates.recommended.filter((r) => !r.order).map((r) => r.locator);
    if (missingOrder.length > 0) {
      return {
        error:
          `--background auto: recommended layer(s) lack render-order for background-seam (${missingOrder.join(", ")}). ` +
          "Re-capture with the current bridge so background.json can prove both coverage and seams.",
      };
    }
    try {
      assertValidMinigameContract(next);
    } catch (error) {
      return { error: `--background auto produced an invalid contract: ${message(error)}` };
    }
    const backgroundData: BackgroundData = {
      camera: { orthographic: true, orthoSize: candidates.camera.orthoSize, position: candidates.camera.position },
      layers: candidates.recommended.map((r) => ({ locator: r.locator, min: r.aabb.min, max: r.aabb.max, order: r.order })),
    };
    return { contract: next, backgroundData };
  }

  // explicit: bind the dev's camera + layers, enable the gate.
  const next: MinigameContract = {
    ...contract,
    backgroundCamera: decl.camera,
    backgroundLayers: decl.layers,
    checks: { ...contract.checks, deterministic: withBackgroundCheck(contract.checks.deterministic) },
  };
  try {
    assertValidMinigameContract(next);
  } catch (error) {
    return { error: `--background-camera/--background-layers produced an invalid contract: ${message(error)}` };
  }
  // Synthesize geometry ONLY by locator match — never fabricate an assumed-covered box.
  const cam =
    candidates &&
    (candidates.camera?.locator === decl.camera
      ? candidates.camera
      : candidates.cameras.find((c) => c.locator === decl.camera));
  const layerAabbs = decl.layers.map((loc) => candidates?.allLayers.find((l) => l.locator === loc));
  if (cam && layerAabbs.every((l) => l !== undefined)) {
    const missingOrder = layerAabbs.filter((l) => !l!.order).map((l) => l!.locator);
    if (missingOrder.length > 0) {
      return { contract: next };
    }
    const backgroundData: BackgroundData = {
      camera: { orthographic: true, orthoSize: cam.orthoSize, position: cam.position },
      layers: decl.layers.map((loc, i) => {
        const aabb = layerAabbs[i]!.aabb;
        return { locator: loc, min: aabb.min, max: aabb.max, order: layerAabbs[i]!.order };
      }),
    };
    return { contract: next, backgroundData };
  }
  // Geometry not available from candidates → bind the gate but require a re-capture (caller).
  return { contract: next };
}

/**
 * Load `<state>.ui-rects.json` for every declared state. Distinguishes a wholly
 * absent pack (nothing captured) from a partially-captured one (some states missing)
 * so the CLI can refuse with the right message.
 */
export async function loadCapturePack(
  captureDir: string,
  stateIds: string[],
): Promise<CaptureLoad> {
  const pack: CapturePack = new Map();
  const missing: string[] = [];
  for (const stateId of stateIds) {
    // A traversal/odd state id must never read outside the captures dir; treat an
    // unsafe id as a missing capture (it then refuses with the id named).
    if (!isSafeSegment(stateId)) {
      missing.push(stateId);
      continue;
    }
    const file = path.join(captureDir, `${stateId}.ui-rects.json`);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { objects?: unknown };
      // A present-but-malformed capture (no `objects` array) is NOT an empty screen —
      // treat it as missing/unreadable so it refuses, never a silent zero-object pass.
      if (!Array.isArray(parsed.objects)) {
        missing.push(stateId);
        continue;
      }
      pack.set(stateId, parsed.objects as MinigameCaptureObject[]);
    } catch {
      missing.push(stateId);
    }
  }
  if (missing.length === stateIds.length) return { kind: "empty" };
  if (missing.length > 0) return { kind: "missing", states: missing };
  return { kind: "ok", pack };
}

/**
 * Best-effort: read the controls the dev DEMONSTRATED in a replay root's first trace,
 * aligned against the draft contract (`traceDemonstratedControls`). Parses the trace once
 * and returns the per-role control paths finalize binds trace-first. Returns `{}` on any
 * problem — the trace is a HINT that generalizes role binding, never required.
 */
export async function readDemonstratedControls(
  traceRoot: string,
  draft: MinigameContract,
): Promise<DemonstratedControls> {
  try {
    const { parseTrace } = await import("../replay/index.js");
    const tracesDir = flatReplayLayout(traceRoot).replayTraces;
    const entries = (await fs.readdir(tracesDir)).filter((f) => f.endsWith(".trace.json")).sort();
    for (const entry of entries) {
      try {
        const trace = parseTrace(JSON.parse(await fs.readFile(path.join(tracesDir, entry), "utf-8")));
        return traceDemonstratedControls(draft, trace);
      } catch {
        /* skip a bad trace, try the next */
      }
    }
  } catch {
    /* no traces dir / unreadable — no hint */
  }
  return {};
}

interface FinalizeArgs {
  contractPath: string;
  capturesDir: string;
  traceRoot?: string;
  output?: string;
  /** State ids to mark `outcomeGated` (read-only can't drive their outcome). */
  outcomeGated?: string[];
  /** A declared input-response liveness: `<state>:<tapId>:<obs1,obs2>`. */
  inputResponse?: { state: string; tap: string; observe: string[] };
  /** Override the safe-area insets (a fraction of the frame per edge, [0, 0.5)). */
  safeAreaInsets?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
  /**
   * The `--background` decision: `auto` binds the discovered recommendation, `off` removes the
   * gate, `explicit` binds a dev-supplied camera + layer set. Undefined ⇒ no background work.
   */
  background?: { mode: "auto" } | { mode: "off" } | { mode: "explicit"; camera: string; layers: string[] };
}

const INSET_EDGES = ["top", "bottom", "left", "right"] as const;
const isValidInset = (n: number): boolean => Number.isFinite(n) && n >= 0 && n < 0.5;

/** Parse `--safe-area-insets` — a uniform number, or `top=..,bottom=..,left=..,right=..`. */
function parseInsets(
  spec: string,
): Partial<Record<"top" | "bottom" | "left" | "right", number>> | { error: string } {
  const trimmed = spec.trim();
  if (/^[0-9.]+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!isValidInset(n)) return { error: `--safe-area-insets ${trimmed} must be a fraction in [0, 0.5)` };
    return { top: n, bottom: n, left: n, right: n };
  }
  const out: Partial<Record<(typeof INSET_EDGES)[number], number>> = {};
  for (const part of trimmed.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!(INSET_EDGES as readonly string[]).includes(k)) {
      return { error: `--safe-area-insets: unknown edge '${k}' (use top/bottom/left/right, or a single number)` };
    }
    const n = Number(v);
    if (!isValidInset(n)) return { error: `--safe-area-insets: ${k}='${v}' must be a fraction in [0, 0.5)` };
    out[k as (typeof INSET_EDGES)[number]] = n;
  }
  if (Object.keys(out).length === 0) return { error: "--safe-area-insets needs a value (a number, or top=..,bottom=..)" };
  return out;
}

export function parseArgs(argv: string[]): FinalizeArgs | { error: string } {
  let contractPath: string | undefined;
  let capturesDir: string | undefined;
  let traceRoot: string | undefined;
  let output: string | undefined;
  let outcomeGated: string[] | undefined;
  let inputResponse: FinalizeArgs["inputResponse"];
  let safeAreaInsets: FinalizeArgs["safeAreaInsets"];
  let backgroundMode: "auto" | "off" | undefined;
  let backgroundCamera: string | undefined;
  let backgroundLayers: string[] | undefined;
  // Whether the `--background-layers` flag was PRESENT at all — tracked independently of whether it
  // filtered to non-empty, so `--background-layers ""` (or `" , ,"`) ERRORS rather than silently
  // no-opping (which would exit 0 with the coverage gate quietly absent).
  let sawLayersFlag = false;
  const take = (i: number, name: string): string | { error: string } => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let v: string | { error: string };
    switch (arg) {
      case "--contract":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        contractPath = path.resolve(v);
        break;
      case "--captures":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        capturesDir = path.resolve(v);
        break;
      case "--trace-root":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        traceRoot = path.resolve(v);
        break;
      case "--output":
      case "-o":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        output = path.resolve(v);
        break;
      case "--outcome-gated":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        outcomeGated = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--input-response": {
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        const parts = v.split(":");
        const observe = (parts[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length !== 3 || !parts[0] || !parts[1] || observe.length === 0) {
          return { error: `--input-response must be '<state>:<tapId>:<observeId,...>' (got "${v}")` };
        }
        inputResponse = { state: parts[0], tap: parts[1], observe };
        break;
      }
      case "--safe-area-insets": {
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        const parsed = parseInsets(v);
        if ("error" in parsed) return parsed;
        safeAreaInsets = parsed;
        break;
      }
      case "--background":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        if (v !== "auto" && v !== "off") {
          return { error: `--background must be 'auto' or 'off' (or use --background-camera + --background-layers)` };
        }
        backgroundMode = v;
        break;
      case "--background-camera":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        backgroundCamera = v.trim();
        break;
      case "--background-layers":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        sawLayersFlag = true;
        backgroundLayers = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  if (!contractPath) return { error: "--contract <path> is required" };
  if (!capturesDir) return { error: "--captures <dir> is required" };

  // Reconcile the `--background` family into a single decision.
  let background: FinalizeArgs["background"];
  // The `--background-layers` flag was given but every entry was blank (`""` / `" , ,"`) — that's a
  // footgun, not a no-op: silently dropping it would exit 0 with the coverage gate quietly absent.
  if (sawLayersFlag && (backgroundLayers === undefined || backgroundLayers.length === 0)) {
    return { error: `--background-layers needs at least one non-empty locator` };
  }
  const hasExplicit = backgroundCamera !== undefined || (backgroundLayers !== undefined && backgroundLayers.length > 0);
  if (backgroundMode && hasExplicit) {
    return { error: `cannot mix --background ${backgroundMode} with --background-camera/--background-layers (use one or the other)` };
  }
  if (hasExplicit) {
    if (backgroundCamera === undefined || backgroundLayers === undefined || backgroundLayers.length === 0) {
      return { error: `--background-camera and --background-layers must be used together` };
    }
    background = { mode: "explicit", camera: backgroundCamera, layers: backgroundLayers };
  } else if (backgroundMode) {
    background = { mode: backgroundMode };
  }

  return { contractPath, capturesDir, traceRoot, output, outcomeGated, inputResponse, safeAreaInsets, background };
}

async function loadDraft(contractPath: string): Promise<MinigameContract> {
  const raw = await fs.readFile(contractPath, "utf-8");
  return assertValidMinigameContract(JSON.parse(raw));
}

/**
 * Read the frozen `background-candidates.json` written by `minigame capture` from the captures
 * dir. Returns null on any problem (`--background auto` requires it; `explicit` uses it for
 * geometry when present). Advisory data, so never throws — a missing/odd file is just null.
 */
async function loadCandidates(capturesDir: string): Promise<BackgroundCandidates | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(capturesDir, "background-candidates.json"), "utf-8")) as BackgroundCandidates;
  } catch {
    return null;
  }
}

/** Run `minigame finalize`. `argv` is the post-`finalize` remainder. */
export async function runFinalize(argv: string[], root: string = process.cwd()): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[loombridge minigame] finalize: ${parsed.error}.`);
    printUsage();
    return 2;
  }

  let draft: MinigameContract;
  try {
    draft = await loadDraft(parsed.contractPath);
  } catch (error) {
    console.error(
      `[loombridge minigame] finalize: could not load contract ${parsed.contractPath}: ${message(error)}`,
    );
    return 2;
  }

  // Apply `--outcome-gated <state,…>`: mark those states so a read-only verifier doesn't
  // assert them (and finalize doesn't require their roles). Refuse an unknown state id
  // rather than silently ignore it.
  if (parsed.outcomeGated && parsed.outcomeGated.length > 0) {
    const known = new Set(draft.states.map((s) => s.id));
    const unknown = parsed.outcomeGated.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(
        `[loombridge minigame] finalize: --outcome-gated names unknown state(s): ${unknown.join(", ")} ` +
          `(declared states: ${[...known].join(", ")}).`,
      );
      return 2;
    }
    const gated = new Set(parsed.outcomeGated);
    draft = { ...draft, states: draft.states.map((s) => (gated.has(s.id) ? { ...s, outcomeGated: true } : s)) };
  }

  // Refuse a draft carrying object fields finalize can't reconcile — never pass their
  // placeholder locators/dangling ids through into a "finalized" contract.
  const unsupported = unsupportedDraftFields(draft);
  if (unsupported.length > 0) {
    console.error(
      `[loombridge minigame] finalize: this draft declares ${unsupported.join(", ")}, which finalize does not ` +
        "infer — remove those field(s) and re-run, or finalize the contract by hand. (Refusing to emit a " +
        "contract that would still contain placeholder/unverified locators.)",
    );
    return 2;
  }

  // Outcome-gated states are intentionally NOT captured (a read-only replay can't drive
  // them), so don't require their capture — requiring it would refuse the very flow that
  // `setup --gated-outcome` → capture → finalize is meant to support.
  const stateIds = draft.states.filter((s) => !s.outcomeGated).map((s) => s.id);
  const load = await loadCapturePack(parsed.capturesDir, stateIds);
  if (load.kind === "empty") {
    console.error(
      `[loombridge minigame] finalize: capture pack missing at ${rel(root, parsed.capturesDir)} — ` +
        "run the assisted capture step first (it writes <state>.ui-rects.json for each screen), then finalize.",
    );
    return 2;
  }
  if (load.kind === "missing") {
    console.error(
      `[loombridge minigame] finalize: missing capture(s) for state(s): ${load.states.join(", ")} — ` +
        "capture every declared screen before finalizing (a missing screen is never guessed).",
    );
    return 2;
  }

  const traceControls = parsed.traceRoot
    ? await readDemonstratedControls(parsed.traceRoot, draft)
    : {};

  let result: InferResult;
  try {
    result = inferFinalizedContract(draft, load.pack, { traceControls });
  } catch (error) {
    console.error(`[loombridge minigame] finalize: ${message(error)}`);
    return 1;
  }

  if (!result.contract) {
    console.error("[loombridge minigame] finalize: could not infer every required role from the captures:");
    for (const u of result.unresolved) {
      console.error(`  • ${u.role}: ${u.reason}`);
    }
    if (result.resolved.length > 0) {
      console.error(
        `  (resolved: ${result.resolved.map((r) => `${r.role}→${r.path}`).join(", ")})`,
      );
    }
    console.error(
      "[loombridge minigame] finalize: refusing to write placeholder/invented locators — capture the missing screen(s) " +
        "or add a clearly-named control, then re-run.",
    );
    // Nudge: an unresolvable role often means its screen is OUTCOME-GATED (a win/reward a
    // read-only replay can't drive). Suggest gating the relevant state(s) rather than faking
    // it — but ONLY states of an outcome-gateable KIND. NEVER suggest gating `start`/`active`
    // (always-deterministic, must-verify screens) just because their role didn't resolve —
    // that would advise silently un-verifying the game (anti-gaming invariant). An unresolved
    // start/active role is a real "capture it / name the control" problem, not a gating one.
    const gateableStates = [
      ...new Set(
        ROLE_SPECS.filter((s) => result.unresolved.some((u) => u.role === s.role)).flatMap((s) =>
          draft.states
            .filter((st) => s.kinds.includes(st.kind) && !st.outcomeGated && OUTCOME_GATEABLE_KINDS.has(st.kind))
            .map((st) => st.id),
        ),
      ),
    ];
    if (gateableStates.length > 0) {
      console.error(
        `[loombridge minigame] finalize: if a screen is gated by gameplay OUTCOME (a win behind correct answers / RNG) ` +
          `a read-only verifier can't drive, mark it instead: --outcome-gated ${gateableStates.join(",")} ` +
          `(or re-run \`minigame setup --gated-outcome\`).`,
      );
    }
    return 2;
  }

  let finalized: MinigameContract = result.contract;
  // Apply a declared `--input-response` liveness: resolve its ids from the capture pack
  // (so the developer references the suggested capture ids, not invented ones), add them to
  // the object registry, set the state's `inputResponse`, and enable the check.
  if (parsed.inputResponse) {
    const applied = applyInputResponseFlag(finalized, load.pack, parsed.inputResponse);
    if ("error" in applied) {
      console.error(`[loombridge minigame] finalize: ${applied.error}`);
      return 2;
    }
    finalized = applied.contract;
  }

  // Apply `--safe-area-insets`: declare the REAL target-device safe margin (the scaffold's
  // default is a generic guess). This is an honest device fact, NOT a knob to silence a real
  // finding — only relax it to a margin your devices actually have.
  if (parsed.safeAreaInsets) {
    finalized = {
      ...finalized,
      uiSafeAreas: { ...finalized.uiSafeAreas, insets: { ...finalized.uiSafeAreas.insets, ...parsed.safeAreaInsets } },
    };
    try {
      assertValidMinigameContract(finalized);
    } catch (error) {
      console.error(`[loombridge minigame] finalize: --safe-area-insets produced an invalid contract: ${message(error)}`);
      return 2;
    }
  }

  // Apply the `--background` decision (the CONFIRM side of suggest-and-confirm): enable/bind or
  // remove the background geometry gates, and freeze `background.json` from REAL discovered geometry
  // so `verify` runs with no re-capture. `auto` requires the frozen candidates; `explicit` uses them
  // for geometry by locator match (else it binds the gate but requires a re-capture — never fabricates).
  let backgroundDataToWrite: BackgroundData | undefined;
  let backgroundSummary: FinalizeBackgroundSummary | undefined;
  if (parsed.background) {
    const candidates =
      parsed.background.mode === "off" ? null : await loadCandidates(parsed.capturesDir);
    const applied = applyBackgroundFlag(finalized, candidates, parsed.background);
    if ("error" in applied) {
      console.error(`[loombridge minigame] finalize: ${applied.error}`);
      return 2;
    }
    finalized = applied.contract;
    backgroundDataToWrite = applied.backgroundData;
    if (parsed.background.mode === "off") {
      backgroundSummary = { disabled: true };
    } else {
      backgroundSummary = {
        camera: finalized.backgroundCamera ?? "",
        layers: finalized.backgroundLayers ?? [],
        wroteData: backgroundDataToWrite !== undefined,
      };
    }
  }

  const outPath = parsed.output ?? parsed.contractPath;
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf-8");
    // Freeze the discovered background geometry so the gate grades it with no re-capture.
    if (backgroundDataToWrite) {
      await fs.writeFile(
        path.join(parsed.capturesDir, BACKGROUND_DATA_FILE),
        `${JSON.stringify(backgroundDataToWrite, null, 2)}\n`,
        "utf-8",
      );
    }
  } catch (error) {
    console.error(`[loombridge minigame] finalize: could not write ${outPath}: ${message(error)}`);
    return 1;
  }

  console.log(buildFinalizeSummary(result.resolved, outPath, root, backgroundSummary).join("\n"));
  // The guided footer only makes sense on the STANDARD workspace layout (<ws>/captures) the
  // resolver assumes; with a custom --captures it would inspect the wrong dir and mislead.
  const ws = path.dirname(outPath);
  if (path.resolve(parsed.capturesDir) === path.resolve(ws, "captures")) await printNextStep(ws);
  return 0;
}

/** Describes the `--background` binding for the summary (pure). */
export type FinalizeBackgroundSummary =
  | { camera: string; layers: string[]; wroteData: boolean }
  | { disabled: true };

/** The human summary (pure, for tests): what got bound. The next command is the shared footer. */
export function buildFinalizeSummary(
  resolved: ResolvedRole[],
  outPath: string,
  root: string,
  background?: FinalizeBackgroundSummary,
): string[] {
  const lines = [
    `${ICON.finalize} Finalized contract → ${rel(root, outPath)}`,
    "",
    "Bound real objects (no hand-editing needed):",
    ...resolved.map((r) => `   ${ICON.pass} ${r.role}: ${r.id} → ${r.locator}`),
  ];
  if (background) {
    lines.push("");
    if ("disabled" in background) {
      lines.push(`${ICON.drift} background-coverage disabled.`);
    } else {
      lines.push(`${ICON.drift} background coverage + seam enabled:`);
      lines.push(`   ${ICON.pass} camera: ${background.camera}`);
      lines.push(`   ${ICON.pass} layers: ${background.layers.join(", ")}`);
      if (!background.wroteData) {
        lines.push(`   ${ICON.warn} re-run \`minigame capture\` to produce background.json before verify.`);
      }
    }
  }
  return lines;
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge minigame finalize --contract <path> --captures <dir> [--trace-root <dir>] [--output <path>]",
      "",
      "Replace a placeholder setup/init contract's locators + state bindings with REAL",
      "scene objects inferred from the capture pack (and, optionally, the first observed",
      "replay click). Writes only the finalized contract — never the Unity project.",
      "",
      "  --contract <path>   The draft .minigame.json from `minigame setup` (required).",
      "  --captures <dir>    The capture pack (<state>.ui-rects.json per screen; required).",
      "  --trace-root <dir>  Replay root from `trace record --observe` (optional hint).",
      "  --output <path>     Write here instead of in place.",
      "  --outcome-gated <a,b>  Mark state(s) whose outcome a READ-ONLY verifier can't drive",
      "                      (a win/reward gated by correct answers on a re-randomizing game).",
      "                      They're not asserted (verify reports NOT-VERIFIABLE), and their",
      "                      roles aren't required here.",
      "  --input-response <state>:<tap>:<obs,...>  Declare a liveness check (from the ids",
      "                      `minigame capture` suggested): tapping <tap> must change >=1 <obs>",
      "                      object — proof the game RESPONDS to input. Enables input-response.",
      "  --safe-area-insets <n | top=..,bottom=..,left=..,right=..>  Declare your target-device",
      "                      safe margin (fraction of frame per edge, [0,0.5)). Use your REAL",
      "                      device safe area — not a knob to silence a genuine safe-area finding.",
      "  --background <auto|off>  Confirm the background coverage + seam gates: `auto` binds the discovered",
      "                      recommendation (from background-candidates.json) + freezes background.json;",
      "                      `off` removes the gate.",
      "  --background-camera <locator>  Bind the background camera explicitly (with --background-layers).",
      "  --background-layers <l1,l2,...>  Bind the background layers explicitly (with --background-camera).",
      "                      Geometry is frozen only when every locator matches a discovered sprite;",
      "                      otherwise the gate is bound but `minigame capture` must re-run first.",
      "",
      "Exit: 0 finalized · 2 usage / captures missing / role not inferable · 1 fs/runtime error.",
    ].join("\n"),
  );
}

function rel(root: string, target: string): string {
  const r = path.relative(root, target);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : target;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
