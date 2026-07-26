/**
 * Pure core of `loombridge minigame capture` (no bridge, fully unit-testable):
 *
 *  - `toCaptureObject` / `toCaptureState`: transform a raw `ui.get_screen_rects`
 *    full-scene dump into the `<state>.ui-rects.json` shape the verify gates read,
 *    assigning each object a STABLE id derived purely from its hierarchy path (so the
 *    same object matches across states, and `finalize` can adopt it).
 *  - `planCaptureFromTrace`: decide, from the contract's states + the recorded trace,
 *    WHEN during the replay to snapshot each named state (auto from trace anchors):
 *    start = before the first tap; active = after it; success_reward = just before the
 *    Home tap (or at the end if there isn't one); home_back = after the Home tap. A
 *    state the trace never reaches is `unreached` (named, never faked).
 *  - `buildFlowEvidence`: assemble an honest `flow.json` from the REAL per-transition
 *    actuation evidence recorded while driving (one actuation, or `steps[]` for a
 *    multi-tap transition like answering N rounds).
 */

import { createHash } from "node:crypto";

import { sceneSlug } from "./minigame-scene-inference.js";
import type { MinigameCaptureObject } from "./types.js";
import type { FlowActuation, FlowEvidence } from "./flow-evidence.js";
import type { MinigameContract, MinigameReachedCondition } from "./profiles/types.js";
import type { Action, ReplayTrace } from "../replay/types.js";

/** A raw object entry from `ui.get_screen_rects` (a subset of its emitted fields). */
export interface RawScreenObject {
  locator?: { path?: string } | string;
  name?: string;
  role?: string;
  active?: boolean;
  isVisible?: boolean;
  visibilityReason?: string | null;
  screenRect?: MinigameCaptureObject["screenRect"] | null;
  viewportRect?: MinigameCaptureObject["viewportRect"] | null;
  isFullyVisible?: boolean;
  isPartiallyClipped?: boolean;
  isOffScreen?: boolean;
  clipSide?: string | null;
  centerXFraction?: number;
  centerYFraction?: number;
  raycastTarget?: boolean;
  interactable?: boolean;
  canvasScaleFactor?: number;
  text?: string;
  fontSize?: number;
  spriteName?: string;
}

/** The `ui.get_screen_rects` op return shape (viewport + objects). */
export interface RawScreenRects {
  viewport?: { width?: number; height?: number; aspect?: number };
  objects?: RawScreenObject[];
}

/** Generic leaf names that don't uniquely identify an object — qualify with the parent. */
const GENERIC_LEAVES = new Set([
  "label", "text", "image", "background", "bg", "icon", "panel", "container",
  "fill", "outline", "border", "shadow", "value", "title", "content", "frame",
]);

/** camelCase a list of path segments: ["AnswerButton1","Label"] → "answerButton1Label". */
function camel(segments: string[]): string {
  const cleaned = segments
    .join(" ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return "object";
  return cleaned
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/**
 * A stable, readable object id derived PURELY from the hierarchy path (so the same
 * object gets the same id in every state's capture). Uses the leaf name; if that's
 * generic (e.g. "Label"), qualifies it with the parent ("AnswerButton1/Label" →
 * `answerButton1Label`) to keep distinct controls distinct. Pure ⇒ cross-state stable.
 */
export function objectIdFromPath(objectPath: string): string {
  const segs = objectPath.split("/").filter(Boolean);
  if (segs.length === 0) return "object";
  const leaf = segs[segs.length - 1];
  if (GENERIC_LEAVES.has(leaf.toLowerCase()) && segs.length >= 2) {
    return camel(segs.slice(-2));
  }
  return camel([leaf]);
}

/**
 * The artifact key for a single state captured at a single device: `<state>@<device>`.
 * Pure + filename-safe (the device id is already validated filename-safe), so it is the
 * stem for `<state>@<device>.png` / `.ui-rects.json` and the `rawByState` map key. Kept
 * here (not inlined in the live drive) so the multi-aspect key construction is unit-testable
 * without a bridge — the whole reason Phase 3's capture loop can be trusted offline.
 */
export function perDeviceKey(stateId: string, deviceId: string): string {
  return `${stateId}@${deviceId}`;
}

/** First 6 hex of sha256(path) — a stable, path-only disambiguator suffix. */
function shortPathHash(objectPath: string): string {
  return createHash("sha256").update(objectPath).digest("hex").slice(0, 6);
}

/**
 * Resolve a STABLE, COLLISION-FREE id for every object path captured in one run.
 *
 * `objectIdFromPath` is readable but NOT injective: two distinct paths sharing a
 * (non-generic) leaf — e.g. `/StartScreen/Button` and `/EndScreen/Button`, both → `button`
 * — would collapse to the same id, and since the verify gates (and `finalize`) bind a
 * contract object to a captured object BY id, a duplicate id silently binds the wrong
 * scene object (or drops one as "already seen" in `finalize`'s candidate dedup).
 *
 * So: keep the clean readable id when its base uniquely identifies a single path;
 * when ≥2 DISTINCT paths share a base, disambiguate EACH with a suffix derived from its
 * OWN full path (`button-3f2a1c`). The suffix depends only on the path, so the same
 * object gets the same id in every state's capture (cross-state stability the gates
 * need), while distinct objects never collide. Resolving across the whole run (not
 * per-state) keeps an object's id identical whether or not its colliding twin happens
 * to be visible in a given state.
 */
export function assignObjectIds(paths: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(paths)];
  const byBase = new Map<string, string[]>();
  for (const p of distinct) {
    const base = objectIdFromPath(p);
    const group = byBase.get(base) ?? [];
    group.push(p);
    byBase.set(base, group);
  }
  const ids = new Map<string, string>();
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      ids.set(group[0], base);
    } else {
      for (const p of group) ids.set(p, `${base}-${shortPathHash(p)}`);
    }
  }
  return ids;
}

/** Resolve the hierarchy path from a raw object's `locator` (object or string) + name. */
function rawPath(raw: RawScreenObject): string {
  if (typeof raw.locator === "string") return raw.locator;
  if (raw.locator && typeof raw.locator.path === "string") return raw.locator.path;
  return raw.name ? `/${raw.name}` : "";
}

/** Every object's hierarchy path in a raw dump (for building the run-wide id map). */
export function rawObjectPaths(raw: RawScreenRects): string[] {
  return (raw.objects ?? []).map(rawPath);
}

/**
 * Transform one raw screen-rects object into the capture-pack object shape. `id` is the
 * pre-resolved collision-free id (`assignObjectIds`); when omitted (single-object use)
 * it falls back to the readable per-path base.
 */
export function toCaptureObject(raw: RawScreenObject, id?: string): MinigameCaptureObject {
  const path = rawPath(raw);
  const obj: MinigameCaptureObject = {
    id: id ?? objectIdFromPath(path),
    path,
    role: typeof raw.role === "string" ? raw.role : "container",
    active: raw.active === true,
    isVisible: raw.isVisible === true,
    screenRect: raw.screenRect ?? { x: 0, y: 0, width: 0, height: 0 },
  };
  // Carry the optional fields the gates read, only when present (keep the JSON tight).
  if (raw.visibilityReason !== undefined) obj.visibilityReason = raw.visibilityReason;
  if (raw.viewportRect != null) obj.viewportRect = raw.viewportRect;
  if (raw.isFullyVisible !== undefined) obj.isFullyVisible = raw.isFullyVisible;
  if (raw.isPartiallyClipped !== undefined) obj.isPartiallyClipped = raw.isPartiallyClipped;
  if (raw.isOffScreen !== undefined) obj.isOffScreen = raw.isOffScreen;
  if (raw.clipSide !== undefined) obj.clipSide = raw.clipSide;
  if (raw.centerXFraction !== undefined) obj.centerXFraction = raw.centerXFraction;
  if (raw.centerYFraction !== undefined) obj.centerYFraction = raw.centerYFraction;
  if (raw.raycastTarget !== undefined) obj.raycastTarget = raw.raycastTarget;
  if (raw.interactable !== undefined) obj.interactable = raw.interactable;
  if (raw.canvasScaleFactor !== undefined) obj.canvasScaleFactor = raw.canvasScaleFactor;
  if (raw.text !== undefined) obj.text = raw.text;
  if (raw.fontSize !== undefined) obj.fontSize = raw.fontSize;
  if (raw.spriteName !== undefined) obj.spriteName = raw.spriteName;
  return obj;
}

/** The `<state>.ui-rects.json` document for one captured state. */
export interface CaptureStateDoc {
  state: string;
  source: string;
  viewport: { width: number; height: number; aspect: number };
  objects: MinigameCaptureObject[];
}

/**
 * Transform a raw full-scene dump into the `<state>.ui-rects.json` document. `idFor`
 * resolves each object's collision-free id from its path (built once per run via
 * `assignObjectIds`); when omitted it falls back to the readable per-path base.
 */
export function toCaptureState(
  stateId: string,
  raw: RawScreenRects,
  idFor?: (objectPath: string) => string,
): CaptureStateDoc {
  const width = raw.viewport?.width ?? 0;
  const height = raw.viewport?.height ?? 0;
  return {
    state: stateId,
    source: "loombridge minigame capture (full-scene dump)",
    viewport: {
      width,
      height,
      aspect: raw.viewport?.aspect ?? (height > 0 ? width / height : 0),
    },
    objects: (raw.objects ?? []).map((o) => toCaptureObject(o, idFor?.(rawPath(o)))),
  };
}

// ── capture planning (auto from trace anchors) ───────────────────────────────

/** A control whose path/name reads as Home/Back navigation (the `home_back` boundary). */
export const HOME_BACK_RE = /home|back|menu|return|exit|quit|close/i;

/**
 * The hierarchy path a single action targets: tap/world-tap/wait-for-visible →
 * `action.locator.path`; drag → its DROP target `action.to.path`. Exported so the
 * finalizer can bind a role from the control the dev actually demonstrated.
 */
export function actionLocatorPath(action: Action): string | undefined {
  if (action.do === "tap" || action.do === "world-tap" || action.do === "wait-for-visible") {
    return action.locator?.path;
  }
  if (action.do === "drag") return action.to?.path;
  return undefined;
}

/** A uGUI EventSystem dispatch (the only kind that defines a flow transition). */
function isUiDispatch(action: Action): boolean {
  return action.do === "tap" || action.do === "drag";
}

/**
 * The on-screen PANEL a control belongs to — the first two hierarchy segments
 * (`/Canvas/GameplayRoot/Answers/AnswerButton2` → `/Canvas/GameplayRoot`). A heuristic used
 * to detect screen transitions in a hub-of-games NAVIGATION PRELUDE: the hub tile, the game's
 * own start screen, and its gameplay area sit under different panels, so a change of scope
 * between consecutive taps marks a screen change. Falls back to the whole path when shallower.
 * (Assumes the kids-minigame convention of grouping a screen's controls under one container.)
 */
function screenScope(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length >= 2 ? `/${segs[0]}/${segs[1]}` : `/${segs.join("/")}`;
}

/** The SOURCE control a gesture acts on (a drag's dragged element / a tap's target) — what
 *  identifies the SCREEN the gesture belongs to (vs `actionLocatorPath`, the drag's DROP). */
function gestureSourcePath(action: Action): string | undefined {
  if (action.do === "drag") return action.from?.path;
  if (action.do === "tap" || action.do === "world-tap") return action.locator?.path;
  return undefined;
}

/** Drop a contract locator's optional `Scene:` prefix, leaving the bare hierarchy path. */
export function stripScene(locator: string): string {
  const i = locator.indexOf(":");
  return i >= 0 ? locator.slice(i + 1) : locator;
}

/**
 * For a state's `requiredInFrame` ids, count how many are VISIBLE in a screen-rects dump.
 * Each required id resolves to its contract locator (scene-stripped); we match the rects
 * object whose path equals that locator (scene-stripped too) and count it visible iff that
 * object exists AND `isVisible === true`. `objLocatorById` is built from
 * `contract.requiredInFrame` (id → scene-stripped locator), exactly like the plan does.
 *
 * This is the visibility check the capture loop uses to pick the MOMENT to snapshot a
 * `window` state (the first step where `visible === total`), so a screen is shot only once
 * all of its required objects are co-visible — never at entry-before-they-appear.
 */
export function requiredVisibleStatus(
  requiredIds: string[],
  objLocatorById: Map<string, string>,
  rects: RawScreenRects,
): { total: number; visible: number; missing: string[] } {
  // Index the dump's objects by their scene-stripped path → isVisible flag.
  const visibleByPath = new Map<string, boolean>();
  for (const o of rects.objects ?? []) {
    visibleByPath.set(stripScene(rawPath(o)), o.isVisible === true);
  }
  let visible = 0;
  const missing: string[] = [];
  for (const id of requiredIds) {
    const loc = objLocatorById.get(id);
    const isVis = loc !== undefined && visibleByPath.get(stripScene(loc)) === true;
    if (isVis) visible += 1;
    else missing.push(id);
  }
  return { total: requiredIds.length, visible, missing };
}

export type CaptureTrigger =
  | { kind: "initial" }
  | { kind: "after-action"; index: number }
  | { kind: "before-action"; index: number }
  | { kind: "window"; start: number; end: number }
  | { kind: "final" }
  | { kind: "unreached"; reason: string };

export interface StateCapturePlan {
  stateId: string;
  kind: string;
  trigger: CaptureTrigger;
  reached?: MinigameReachedCondition;
  /** The state's declared `requiredInFrame` object ids — carried for the window scan's
   *  visibility check (the loop picks the first step where ALL are co-visible). */
  requiredInFrame?: string[];
}

export interface CapturePlan {
  /** One entry per declared state, in `happyPath` order. */
  states: StateCapturePlan[];
  /** The trace's actions flattened across segments (drive order). */
  flatActions: Action[];
  /** States the recorded trace never reaches (named, surfaced honestly — never faked).
   * `outcomeGated` distinguishes "not asserted by design (read-only can't drive the
   * outcome)" from "your recording missed it (fix the recording)". */
  unreached: { stateId: string; reason: string; outcomeGated?: boolean }[];
}

/**
 * Decide when to snapshot each named state from the contract + recorded trace.
 * Auto from trace anchors:
 *   - start          → the game's idle/title screen: the pre-tap frame for a direct-launch
 *                      game, or — when a hub→game NAVIGATION PRELUDE precedes gameplay — the
 *                      game's own first screen, anchored on the wait-for-visible that confirms
 *                      it loaded (so an async scene load can't snapshot the still-loading hub)
 *   - active          → after the tap that ENTERS gameplay (skipping the nav prelude)
 *   - success_reward  → just before the Home/Back tap, or at the end if there's none
 *   - home_back       → after the Home/Back tap (unreached if the trace never taps Home)
 * A `failure_timeout` (or any other) state on the happy path is `unreached` here.
 *
 * Prelude handling: in a hub of games, the happy path begins with one or more NAVIGATION taps
 * (tap the hub tile → maybe a per-game start screen) before the first gameplay tap. Anchoring
 * `active` on the literal first tap would snapshot the hub (or a start screen) mid-transition —
 * the P0 bug this fixes. We instead find the gameplay panel (the on-screen scope of the last
 * play tap) and anchor `active` on the tap that enters it; with no prelude that IS the first
 * tap, so direct-launch games are unchanged.
 *
 * MULTI-SCENE (D3 — graded entry scene): when the trace carries per-segment scene evidence AND the
 * contract's states span ≥2 scenes (a fused multi-scene contract, e.g. hub→game), the single global
 * anchoring above mislabels — every scene's `active`/`start` collapses onto ONE gameplay anchor, so
 * the entry/hub scene is captured against a GAMEPLAY frame. We then dispatch to
 * `planMultiSceneFromTrace`, which anchors each state within its OWN scene's slice of the trace (the
 * entry scene at its settled idle frame; the literal scene-load transition frame is never an anchor).
 * Single-scene traces keep `planSingleSceneFromTrace` (byte-identical to the pre-D3 behaviour).
 */
export function planCaptureFromTrace(contract: MinigameContract, trace: ReplayTrace): CapturePlan {
  const hasSceneEvidence = (trace.segments ?? []).some(
    (s) => typeof (s as { scene?: unknown }).scene === "string" && ((s as { scene?: string }).scene?.length ?? 0) > 0,
  );
  const stateSceneSlugs = new Set(
    contract.states.map((s) => (s.scene ? sceneSlug(s.scene) : "")).filter((x) => x.length > 0),
  );
  if (hasSceneEvidence && stateSceneSlugs.size >= 2) {
    return planMultiSceneFromTrace(contract, trace);
  }
  return planSingleSceneFromTrace(contract, trace);
}

/** Single-scene (and back-compat) capture plan — the pre-D3 global anchoring, unchanged. */
function planSingleSceneFromTrace(contract: MinigameContract, trace: ReplayTrace): CapturePlan {
  const flatActions = trace.segments.flatMap((s) => s.actions);
  const homeTapIndex = flatActions.findIndex(
    (a) => isUiDispatch(a) && HOME_BACK_RE.test(actionLocatorPath(a) ?? ""),
  );

  // ui-dispatch taps/drags with their flatActions index, in drive order.
  const dispatches = flatActions
    .map((a, index) => (isUiDispatch(a) ? { index, path: actionLocatorPath(a) ?? "" } : null))
    .filter((d): d is { index: number; path: string } => d !== null);
  // Ignore a trailing Home/Back tap when locating gameplay (that's navigation OUT, not play).
  const homeDispatchPos = dispatches.findIndex((d) => HOME_BACK_RE.test(d.path));
  const playDispatches = homeDispatchPos >= 0 ? dispatches.slice(0, homeDispatchPos) : dispatches;

  // Locate where GAMEPLAY begins, skipping a hub→game(→start-screen) navigation prelude.
  let activeTrigger: CaptureTrigger;
  let startTrigger: CaptureTrigger = { kind: "initial" };
  if (playDispatches.length === 0) {
    activeTrigger = { kind: "unreached", reason: "the recorded trace never taps a control to start the game" };
  } else {
    const gameplayScope = screenScope(playDispatches[playDispatches.length - 1].path);
    const firstGameplayPos = playDispatches.findIndex((d) => screenScope(d.path) === gameplayScope);
    const entryPos = Math.max(0, firstGameplayPos - 1);
    const entry = playDispatches[entryPos];
    // active = right after the tap that enters gameplay. In the prelude case the slow scene
    // load already happened earlier (its wait-for-visible blocked the drive), so the gameplay
    // panel swaps in fast and the settle delay covers it.
    activeTrigger = { kind: "after-action", index: entry.index };
    if (entryPos > 0) {
      // A nav prelude → the game has its OWN first screen (e.g. a per-game start screen) the
      // hub launched into. Capture `start` there, anchored on the wait-for-visible right before
      // the entry tap (it confirms that screen finished loading — robust against an async scene
      // load); fall back to just after the last nav tap if the segment carried no such wait.
      const waitIdx = entry.index - 1;
      startTrigger =
        waitIdx >= 0 && flatActions[waitIdx]?.do === "wait-for-visible"
          ? { kind: "after-action", index: waitIdx }
          : { kind: "after-action", index: playDispatches[entryPos - 1].index };
    }
  }

  // Per-state visibility-aligned capture (S8 #3, slice 2): when the demonstration carries
  // state-signal gates (`wait-for-condition`), give each ACTIVE state a WINDOW spanning its OWN
  // screen's gated gestures (first..last), then the live loop snapshots at the first step in
  // that window where ALL the state's `requiredInFrame` objects are co-visible — so mix is shot
  // before its ingredients are consumed and decorate is shot after the first topping reveals the
  // doneButton, instead of always at screen entry. A gesture is matched to a state by PANEL (the
  // screen scope its `requiredInFrame` objects sit under), robust to hand-edited state ids
  // (e.g. `DecorPanel` → state id `decorate`). No gates ⇒ this map is empty and the legacy
  // `activeTrigger` is kept (byte-identical to pre-slice-1 behaviour).
  const objLocator = new Map((contract.requiredInFrame ?? []).map((o) => [o.id, stripScene(o.locator)]));
  const gatedByPanel = new Map<string, { first: number; last: number }>();
  {
    let lastGate: Extract<Action, { do: "wait-for-condition" }> | undefined;
    for (let i = 0; i < flatActions.length; i++) {
      const a = flatActions[i];
      if (a.do === "wait-for-condition") { lastGate = a; continue; }
      const src = gestureSourcePath(a);
      if (src && lastGate) {
        const panel = screenScope(src);
        const win = gatedByPanel.get(panel);
        if (win) win.last = i; // extend the panel's window to the latest gated gesture
        else gatedByPanel.set(panel, { first: i, last: i });
      }
      if (src) lastGate = undefined; // a gate gates exactly its next gesture
    }
  }
  /** The dominant screen panel of a state's `requiredInFrame` objects (chrome under its own
   *  shallow scope is naturally outvoted by the screen's controls). */
  const dominantPanel = (requiredIds: string[] | undefined): string | undefined => {
    const counts = new Map<string, number>();
    for (const id of requiredIds ?? []) {
      const loc = objLocator.get(id);
      if (!loc) continue;
      // Only objects that actually sit UNDER a panel (depth >= 3, i.e. /Canvas/<panel>/<ctrl>)
      // vote. Persistent chrome (e.g. /Canvas/HomeButton, depth 2) must NOT count — otherwise on
      // a single-control screen it ties the screen's real panel and the order-dependent tiebreak
      // could pick the chrome scope, which has no gated gesture → silent fallback to the old
      // shared trigger (the mislabel this change fixes). [adversarial-review finding]
      if (loc.split("/").filter(Boolean).length < 3) continue;
      const scope = screenScope(loc);
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [p, n] of counts) if (n > bestN) { bestN = n; best = p; }
    return best;
  };

  // Walk states in happyPath order (the contract guarantees these reference real states).
  const order = contract.interactionFlow.happyPath;
  const byId = new Map(contract.states.map((s) => [s.id, s]));
  const states: StateCapturePlan[] = [];
  const unreached: { stateId: string; reason: string; outcomeGated?: boolean }[] = [];

  for (const stateId of order) {
    const state = byId.get(stateId);
    if (!state) continue;
    // Outcome-gated states are NOT captured: a read-only replay can't deterministically
    // drive a win/reward on a non-deterministic game, so capturing whatever frame happens
    // to be on screen would mislabel it. Surface honestly as not-asserted-by-design.
    if (state.outcomeGated === true) {
      const reason = "outcome-gated — a read-only replay can't drive its outcome (no RNG seed / no game change); not asserted by design";
      unreached.push({ stateId, reason, outcomeGated: true });
      states.push({ stateId, kind: state.kind, trigger: { kind: "unreached", reason }, reached: state.reached, requiredInFrame: state.requiredInFrame });
      continue;
    }
    let trigger: CaptureTrigger;
    switch (state.kind) {
      case "start":
        trigger = startTrigger;
        break;
      case "active": {
        const panel = dominantPanel(state.requiredInFrame);
        const win = panel ? gatedByPanel.get(panel) : undefined;
        if (win) {
          // Capture this screen at the first step in its gated window where ALL of its
          // requiredInFrame objects are co-visible (decided live by the loop via
          // `requiredVisibleStatus`) — NOT a derived phase `reached`. Window states keep the
          // contract's usually-unset `state.reached`.
          trigger = { kind: "window", start: win.first, end: win.last };
        } else {
          trigger = activeTrigger;
        }
        break;
      }
      case "success_reward":
        trigger =
          homeTapIndex >= 0
            ? { kind: "before-action", index: homeTapIndex }
            : flatActions.length > 0
              ? { kind: "final" }
              : { kind: "unreached", reason: "the recorded trace has no actions" };
        break;
      case "home_back":
        trigger =
          homeTapIndex >= 0
            ? { kind: "after-action", index: homeTapIndex }
            : { kind: "unreached", reason: "the recorded trace never taps a Home/Back control" };
        break;
      default:
        trigger = { kind: "unreached", reason: `state kind '${state.kind}' is not captured by the happy-path replay` };
    }
    if (trigger.kind === "unreached") unreached.push({ stateId, reason: trigger.reason });
    states.push({ stateId, kind: state.kind, trigger, reached: state.reached, requiredInFrame: state.requiredInFrame });
  }

  return { states, flatActions, unreached };
}

// ── multi-scene capture planning (D3 — graded entry scene) ───────────────────

/**
 * One scene slug per flatAction index (`flatActions = trace.segments.flatMap(s => s.actions)`),
 * derived from the per-segment scene evidence (`Segment.scene`, a runtime name). Pure.
 *
 * Carry-forward: a segment with no scene evidence inherits the last EVIDENCED scene. Leading
 * evidence-less actions take the FIRST evidenced scene's slug when there is one — a runtime name, the
 * same identifier space `state.scene` lives in — rather than the `trace.start.scene` asset-path
 * basename, which closes the name↔path reconciliation hole (the path basename can differ from the
 * runtime name). Only when there is NO evidence at all does it fall back to `sceneSlug(start.scene)`.
 */
export function actionSceneSlugs(trace: Pick<ReplayTrace, "segments" | "start">): string[] {
  const segs = trace.segments ?? [];
  const firstEvidenced = segs
    .map((s) => (s as { scene?: unknown }).scene)
    .find((s): s is string => typeof s === "string" && s.length > 0);
  const leadingFallback = firstEvidenced
    ? sceneSlug(firstEvidenced)
    : trace.start?.scene
      ? sceneSlug(trace.start.scene)
      : "";
  const out: string[] = [];
  let current: string | undefined; // last EVIDENCED slug, carried forward to evidence-less segments
  for (const seg of segs) {
    const segScene = (seg as { scene?: unknown }).scene;
    const evidenced = typeof segScene === "string" && segScene.length > 0;
    const slug = evidenced ? sceneSlug(segScene) : (current ?? leadingFallback);
    if (evidenced) current = slug;
    for (let k = 0; k < seg.actions.length; k += 1) out.push(slug);
  }
  return out;
}

/** Contiguous per-scene blocks of flatAction indices, in drive order (a revisited scene yields a
 *  second block). The entry scene is `blocks[0]`. */
interface SceneBlock {
  slug: string;
  first: number;
  last: number;
}
function sceneBlocks(slugs: string[]): SceneBlock[] {
  const blocks: SceneBlock[] = [];
  slugs.forEach((slug, i) => {
    const tail = blocks[blocks.length - 1];
    if (tail && tail.slug === slug) tail.last = i;
    else blocks.push({ slug, first: i, last: i });
  });
  return blocks;
}

/** The start/active/home anchors for ONE scene block (computed within its action range only). */
interface SceneAnchors {
  startTrigger: CaptureTrigger;
  activeTrigger: CaptureTrigger;
  /** flatActions index of the in-scene Home/Back tap, or -1. */
  homeTapIndex: number;
}

/**
 * Compute a scene's start/active/home anchors from ONLY its own action range — the existing prelude
 * algorithm, scoped. The scene-EXIT dispatch (a tap whose next action is in a different scene — the
 * hub tile launching the game) is excluded from gameplay and never an anchor, so the literal
 * scene-load transition frame is skipped. The ENTRY scene with no in-scene gameplay tap (a
 * pass-through hub) grades its settled idle frame ({initial}) for start AND active.
 */
function computeSceneAnchors(
  block: SceneBlock,
  isEntry: boolean,
  dispatches: { index: number; path: string }[],
  flatActions: Action[],
  isSceneExit: (d: { index: number }) => boolean,
): SceneAnchors {
  const inRange = dispatches.filter((d) => d.index >= block.first && d.index <= block.last);
  const homePos = inRange.findIndex((d) => HOME_BACK_RE.test(d.path));
  const homeTapIndex = homePos >= 0 ? inRange[homePos].index : -1;
  const beforeHome = homePos >= 0 ? inRange.slice(0, homePos) : inRange;
  const play = beforeHome.filter((d) => !isSceneExit(d));

  // The scene's settled load frame for a non-entry scene: just after the wait-for-visible that
  // confirmed it loaded (else after the scene's first action).
  const boundaryStart = (): CaptureTrigger => {
    for (let i = block.first; i <= block.last; i += 1) {
      if (flatActions[i]?.do === "wait-for-visible") return { kind: "after-action", index: i };
    }
    return { kind: "after-action", index: block.first };
  };

  if (play.length === 0) {
    const t: CaptureTrigger = isEntry ? { kind: "initial" } : boundaryStart();
    return { startTrigger: t, activeTrigger: t, homeTapIndex };
  }

  const gameplayScope = screenScope(play[play.length - 1].path);
  const firstGameplayPos = play.findIndex((d) => screenScope(d.path) === gameplayScope);
  const entryPos = Math.max(0, firstGameplayPos - 1);
  const entry = play[entryPos];
  const activeTrigger: CaptureTrigger = { kind: "after-action", index: entry.index };
  let startTrigger: CaptureTrigger;
  if (entryPos > 0) {
    const waitIdx = entry.index - 1;
    startTrigger =
      waitIdx >= 0 && flatActions[waitIdx]?.do === "wait-for-visible"
        ? { kind: "after-action", index: waitIdx }
        : { kind: "after-action", index: play[entryPos - 1].index };
  } else {
    startTrigger = isEntry ? { kind: "initial" } : boundaryStart();
  }
  return { startTrigger, activeTrigger, homeTapIndex };
}

/**
 * Multi-scene capture plan: anchor each state within its OWN scene's slice of the trace, so a fused
 * hub→game contract captures the entry/hub scene against its own idle frame (its safe-area + tap-target
 * gates then grade the hub) instead of collapsing every scene onto one gameplay anchor. A state whose
 * scene the demonstration never visited, or that has no honest in-scene anchor, is `unreached` — never
 * anchored on another scene's frame (the MOAT rule). Return-to-hub (the game's home_back) is out of
 * scope: it stays anchored after the game's back tap.
 */
function planMultiSceneFromTrace(contract: MinigameContract, trace: ReplayTrace): CapturePlan {
  const flatActions = trace.segments.flatMap((s) => s.actions);
  const slugs = actionSceneSlugs(trace);
  const blocks = sceneBlocks(slugs);
  const entryBlock = blocks[0];
  // A scene's PRIMARY block = its first occurrence (a revisited scene keeps its first block).
  const firstBlockBySlug = new Map<string, SceneBlock>();
  for (const b of blocks) if (!firstBlockBySlug.has(b.slug)) firstBlockBySlug.set(b.slug, b);

  const dispatches = flatActions
    .map((a, index) => (isUiDispatch(a) ? { index, path: actionLocatorPath(a) ?? "" } : null))
    .filter((d): d is { index: number; path: string } => d !== null);
  // A scene-EXIT dispatch: the very next action is in a different scene (the tap navigated out). Its
  // after-frame is the scene-load frame — never a capture anchor.
  const isSceneExit = (d: { index: number }): boolean =>
    d.index + 1 < slugs.length && slugs[d.index + 1] !== slugs[d.index];

  const ctxCache = new Map<string, SceneAnchors>();
  const ctxFor = (block: SceneBlock): SceneAnchors => {
    const cached = ctxCache.get(block.slug);
    if (cached) return cached;
    const ctx = computeSceneAnchors(block, block === entryBlock, dispatches, flatActions, isSceneExit);
    ctxCache.set(block.slug, ctx);
    return ctx;
  };

  // Per-state visibility windows (as single-scene), but the gated-gesture map is keyed by
  // (scene slug :: panel) so two scenes' same-named panels can't cross-bind a window.
  const objLocator = new Map((contract.requiredInFrame ?? []).map((o) => [o.id, stripScene(o.locator)]));
  const gatedByPanel = new Map<string, { first: number; last: number }>();
  {
    let lastGate: Extract<Action, { do: "wait-for-condition" }> | undefined;
    for (let i = 0; i < flatActions.length; i += 1) {
      const a = flatActions[i];
      if (a.do === "wait-for-condition") { lastGate = a; continue; }
      const src = gestureSourcePath(a);
      if (src && lastGate) {
        const key = `${slugs[i]}::${screenScope(src)}`;
        const win = gatedByPanel.get(key);
        if (win) win.last = i;
        else gatedByPanel.set(key, { first: i, last: i });
      }
      if (src) lastGate = undefined;
    }
  }
  const dominantPanel = (requiredIds: string[] | undefined): string | undefined => {
    const counts = new Map<string, number>();
    for (const id of requiredIds ?? []) {
      const loc = objLocator.get(id);
      if (!loc) continue;
      if (loc.split("/").filter(Boolean).length < 3) continue;
      const scope = screenScope(loc);
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [p, n] of counts) if (n > bestN) { bestN = n; best = p; }
    return best;
  };

  const order = contract.interactionFlow.happyPath;
  const byId = new Map(contract.states.map((s) => [s.id, s]));
  const states: StateCapturePlan[] = [];
  const unreached: { stateId: string; reason: string; outcomeGated?: boolean }[] = [];

  for (const stateId of order) {
    const state = byId.get(stateId);
    if (!state) continue;
    if (state.outcomeGated === true) {
      const reason = "outcome-gated — a read-only replay can't drive its outcome (no RNG seed / no game change); not asserted by design";
      unreached.push({ stateId, reason, outcomeGated: true });
      states.push({ stateId, kind: state.kind, trigger: { kind: "unreached", reason }, reached: state.reached, requiredInFrame: state.requiredInFrame });
      continue;
    }
    const slug = state.scene ? sceneSlug(state.scene) : undefined;
    const block = slug ? firstBlockBySlug.get(slug) : undefined;
    if (!block) {
      const reason = `the demonstration never visited scene '${state.scene ?? "(unset)"}' — this screen can't be captured`;
      unreached.push({ stateId, reason });
      states.push({ stateId, kind: state.kind, trigger: { kind: "unreached", reason }, reached: state.reached, requiredInFrame: state.requiredInFrame });
      continue;
    }
    const ctx = ctxFor(block);
    let trigger: CaptureTrigger;
    switch (state.kind) {
      case "start":
        trigger = ctx.startTrigger;
        break;
      case "active": {
        const panel = dominantPanel(state.requiredInFrame);
        const win = panel ? gatedByPanel.get(`${slug}::${panel}`) : undefined;
        trigger = win ? { kind: "window", start: win.first, end: win.last } : ctx.activeTrigger;
        break;
      }
      case "success_reward":
        trigger =
          ctx.homeTapIndex >= 0
            ? { kind: "before-action", index: ctx.homeTapIndex }
            : block.last === flatActions.length - 1 && flatActions.length > 0
              ? { kind: "final" }
              : { kind: "unreached", reason: `no reward frame in scene '${state.scene}' (no Home/Back tap, and it isn't the final screen of the playthrough)` };
        break;
      case "home_back":
        trigger =
          ctx.homeTapIndex >= 0
            ? { kind: "after-action", index: ctx.homeTapIndex }
            : { kind: "unreached", reason: `the demonstration never taps a Home/Back control in scene '${state.scene}'` };
        break;
      default:
        trigger = { kind: "unreached", reason: `state kind '${state.kind}' is not captured by the happy-path replay` };
    }
    if (trigger.kind === "unreached") unreached.push({ stateId, reason: trigger.reason });
    states.push({ stateId, kind: state.kind, trigger, reached: state.reached, requiredInFrame: state.requiredInFrame });
  }

  return { states, flatActions, unreached };
}

// ── input-response (liveness) evidence ───────────────────────────────────────

/** Where to snapshot the before/after for the input-response liveness evidence. */
export interface ResponseStimulusPlan {
  /** The gameplay state (the `active`-kind state) the response is observed on. */
  stateId: string;
  /** flatActions index of the gameplay tap to snapshot AROUND (dump before it, drive, dump after). */
  stimulusIndex: number;
  /** The tapped control's path (informational; recorded into response.json). */
  stimulusTarget?: string;
}

/**
 * Plan the input-response stimulus: the FIRST gameplay ui-dispatch tap on the `active`
 * state — i.e. the first ui-dispatch AFTER the active state's capture anchor (which sits
 * right after the start tap). Snapshotting around a REAL recorded tap avoids needing a
 * resolved locator at capture time (it works on the pre-finalize draft), and is RNG-
 * invariant. Returns null when there's no active state captured by an action, or no
 * gameplay tap follows it.
 *
 * PRECONDITION (the scaffold's start→active→… shape): the active anchor is the START tap,
 * so the stimulus is the first GAMEPLAY tap after it. A game with no distinct start screen
 * (the very first tap IS gameplay) would instead pick the SECOND gameplay tap — still a
 * valid liveness stimulus, just not the first.
 */
export function planResponseStimulus(contract: MinigameContract, plan: CapturePlan): ResponseStimulusPlan | null {
  // The GAMEPLAY active — the `active` state whose plan anchor is an actual action (after/before).
  // In a fused multi-scene contract the FIRST active is the entry/hub, anchored at {initial} (no
  // stimulus there); the gameplay scene's active is the one with an action anchor. Single-scene has
  // exactly one active and it is already action-anchored, so this picks the same state as before.
  let activeId: string | undefined;
  let anchor = -1;
  for (const s of contract.states) {
    if (s.kind !== "active") continue;
    const sp = plan.states.find((p) => p.stateId === s.id);
    if (sp && (sp.trigger.kind === "after-action" || sp.trigger.kind === "before-action")) {
      activeId = s.id;
      anchor = sp.trigger.index;
      break;
    }
  }
  if (!activeId || anchor < 0) return null;
  for (let i = anchor + 1; i < plan.flatActions.length; i += 1) {
    if (isUiDispatch(plan.flatActions[i])) {
      return { stateId: activeId, stimulusIndex: i, stimulusTarget: actionLocatorPath(plan.flatActions[i]) };
    }
  }
  return null;
}

/**
 * Compact the changed-object ids for the liveness suggestion. A correct answer can spawn DOZENS
 * of same-named objects (confetti0..43) that flood the suggestion — but a large same-base group
 * can also be the real response (16 tiles flipping). So we never DROP a group: each base keeps
 * one REPRESENTATIVE in `suggested`, and large groups are additionally listed in `collapsed`
 * (count + a representative) so the suggestion can note "N shown as 1" without losing the signal.
 *
 * The base is the id with a trailing index/hash removed: a run of DIGITS, or a `-<hex>`/`_<hex>`
 * hash suffix (`confetti43`→`confetti`, `tile15`→`tile`, `check-9c644a`→`check`,
 * `question`→`question`). It does NOT eat hex letters inside a word (`tile`'s `e` stays). Small
 * same-base sets (e.g. `answerButton0..3`, a 4-choice quiz) stay fully expanded; only sets of
 * `GROUP_AT`+ collapse to a representative.
 */
export function summarizeChangedIds(changed: string[]): {
  suggested: string[];
  collapsed: Array<{ base: string; count: number; rep: string }>;
} {
  const GROUP_AT = 6; // a same-base set this large is shown as one representative (confetti, not a 4-quiz)
  const groups = new Map<string, string[]>();
  for (const id of changed) {
    const base = id.replace(/([-_][0-9a-fA-F]+|[0-9]+)$/, "") || id;
    const arr = groups.get(base);
    if (arr) arr.push(id);
    else groups.set(base, [id]);
  }
  const suggested: string[] = [];
  const collapsed: Array<{ base: string; count: number; rep: string }> = [];
  for (const [base, ids] of groups) {
    if (ids.length >= GROUP_AT) {
      suggested.push(ids[0]); // one representative — never drop the signal entirely
      collapsed.push({ base, count: ids.length, rep: ids[0] });
    } else {
      suggested.push(...ids);
    }
  }
  return { suggested, collapsed };
}

/** The `<state>.response.json` document: before/after object snapshots around the tap. */
export interface ResponseDoc {
  source: string;
  tap?: string;
  before: { objects: MinigameCaptureObject[] };
  after: { objects: MinigameCaptureObject[] };
}

/** Build the `<state>.response.json` from the before/after raw dumps (ids via the run-wide map). */
export function toResponseDoc(
  beforeRaw: RawScreenRects,
  afterRaw: RawScreenRects,
  stimulusTarget: string | undefined,
  idFor?: (objectPath: string) => string,
): ResponseDoc {
  const map = (raw: RawScreenRects) => ({
    objects: (raw.objects ?? []).map((o) => toCaptureObject(o, idFor?.(rawPath(o)))),
  });
  return {
    source: "loombridge minigame capture (input-response before/after)",
    tap: stimulusTarget,
    before: map(beforeRaw),
    after: map(afterRaw),
  };
}

// ── flow.json assembly ───────────────────────────────────────────────────────

/** One captured transition: the ordered actuations recorded between two state captures. */
export interface RecordedTransition {
  from: string;
  to: string;
  actuations: FlowActuation[];
}

/**
 * Build `flow.json` from the REAL recorded actuations. A transition with one
 * actuation gets `actuation`; a multi-tap transition (e.g. N answer rounds) gets
 * `steps[]`. Honest by construction — the values are verbatim dispatch results, so
 * a grouping mistake surfaces as a visible flow fault, never a fabricated green.
 */
export function buildFlowEvidence(transitions: RecordedTransition[]): FlowEvidence {
  return {
    schemaVersion: "1",
    transitions: transitions.map((t) => {
      const target = t.actuations[0]?.handlerTarget ?? t.actuations[0]?.target;
      const base = { from: t.from, to: t.to, trigger: { kind: "ui-dispatch", target } };
      return t.actuations.length === 1
        ? { ...base, actuation: t.actuations[0] }
        : { ...base, steps: t.actuations };
    }),
  };
}
