/**
 * Replay Verification — observe-a-human-session transform.
 *
 * The bridge's `input.observe_stop` returns the clicks a developer made while
 * manually playing (each already resolved to a locator path at gesture time). This PURE
 * function turns that observation into a replayable `ReplayTrace`: the truest
 * "demonstrate once" path — the human plays, Loombridge records, replay verifies.
 *
 * Each observed click becomes its own SEGMENT: `wait-for-visible` (so replay waits
 * for the target to appear rather than firing blind) → `tap` → a `capture` (a
 * screenshot of the resulting state). Per-step segments give a visual timeline and
 * pinpoint which step diverged.
 *
 * The human's observed inter-tap gap is grafted on as a per-step `settleMs` on each
 * capture (capped): replay taps when the target is visible, then SETTLES for the
 * human's dwell before the screenshot — so the capture reflects the settled screen
 * (spawn/fall/transition animations finished), not a mid-animation frame, AND the
 * gap paces the next tap. The visibility wait stays primary; the settle only adds
 * time, and the observed gap is honored once (not as both a pre- and post-tap wait).
 *
 * OUTCOME verification (optional): pass captured `outcomes` (end-state assertions
 * read from the live run via `captureOutcomes`) and the trace asserts the game
 * reached that state — so a replay whose taps actuate but whose OUTCOME diverged
 * (re-randomized content made the same taps wrong) FAILS instead of silently
 * passing. Without outcomes the trace still only verifies the UI flow.
 *
 * The assembled trace is validated through `parseTrace`, so the recorder can never
 * emit a trace its own parser would reject (green by construction, like
 * `RecordingSession.build`).
 */

import { parseTrace } from "./parse.js";
import type { Action, Assertion, ConditionOperator, Locator, ReplayTrace, Segment } from "./types.js";

/**
 * An OUTCOME the recording should pin: a component/runtime property whose value
 * was captured during the human's run (the expected end state). Replay asserts it,
 * so a run that diverges (e.g. the score didn't increase, the round didn't advance
 * because re-randomized content made the same taps wrong) FAILS instead of passing
 * just because the taps actuated. Makes a `pass` mean the game reached the state,
 * not merely that the UI flow ran.
 *
 * Two real constraints (proven live on CountTheFruits):
 * - Target a SERIALIZED property: a UI `Text.text` (path `m_Text`, component
 *   `Text`) or a public field — NOT a runtime C# auto-property (`{ get; set; }`),
 *   which `assert_condition` can't read. Prefer what the game DISPLAYS.
 * - The assertion is NOT gated on replay actually REACHING the state: if replay
 *   never reaches the screen, it reads the SCENE-DEFAULT value — so an outcome
 *   whose value EQUALS the scene default can false-pass. Capture a value that
 *   DIFFERS from the default (a non-perfect score, not the authored placeholder).
 */
export interface OutcomeSpec {
  /** Stable id for the emitted assertion (also a report key). */
  id: string;
  locator: Locator;
  component?: string;
  property_path: string;
  /** Comparator (default `equals`). */
  operator?: ConditionOperator;
  /** Tolerance for `approx`. */
  tolerance?: number;
  /**
   * Gate the assertion on the element being VISIBLE at replay: the value is captured
   * on a screen the human reached, so replay must reach it too, else it reads the
   * scene default and false-passes. Defaults ON only for a UI-TEXT outcome (a
   * displayed value — `m_Text` / a `Text`/`TMP` component); a non-UI or always-
   * present property is left UNGATED (the `ui-visible` check can't be satisfied and
   * would false-FAIL it). Set `true`/`false` to override.
   */
  reachedWhenVisible?: boolean;
}

/** One observed click, as returned by `input.observe_stop` (path resolved at gesture time). */
export interface ObservedClick {
  /** Milliseconds since the observation started (drives the replay timing floor). */
  tMs: number;
  locator: Locator;
  /** Pointer button (0 = left); only left-clicks are recorded in v1. */
  button?: number;
  /**
   * Where the click landed: `ui` = a uGUI element (replayable via EventSystem
   * dispatch); `world` = a non-uGUI sprite/collider (recorded, but replay marks it
   * blocked — needs simulated-pointer input traces). Absent ⇒ treated as `ui`.
   */
  kind?: "ui" | "world";
  /**
   * Present ⇒ the gesture was a uGUI DRAG (press → move → release): `locator` is the
   * dragged element, `to` the drop target. The transform emits a `drag` action.
   * Only set for `kind:"ui"` drags (a world drag stays a recorded tap/blocked in v1).
   */
  to?: Locator;
  /**
   * Accumulated screen-px pointer travel for this gesture (a real value only for a
   * drag-only / in-place scrub or stir; 0 for a normal point-to-point drag or a tap).
   * Carried onto the emitted `drag` action only when finite and > 0.
   */
  travelPx?: number;
  /**
   * Screen.height (px) at record time, paired with `travelPx` (0 when no travel). Lets
   * replay rescale travel per device so a multi-aspect re-drive reproduces the same
   * on-canvas travel; carried onto the `drag` action when `travelPx` is set and this > 0.
   */
  travelRefHeight?: number;
  /**
   * Release-point X ÷ screen width, in [0,1]. SENTINEL -1 for taps and for a normal
   * distinct-drop drag (the drop target IS a raycast element → `to` suffices). A value
   * `>= 0` (with `releaseNy >= 0`) ⇒ the gesture's drop target is NOT a raycast element
   * and replay must release at this normalized point instead of `to`'s center.
   */
  releaseNx?: number;
  /** Release-point Y ÷ screen height, in [0,1]; SENTINEL -1 likewise. See `releaseNx`. */
  releaseNy?: number;
  /**
   * The value of the DECLARED state-signal field (see `ObserveTraceMeta.stateSignal`)
   * sampled by the observer at this gesture (enum → name, e.g. "Pour"). When the
   * recording declared a state signal AND this is a non-empty string, the transform
   * PREPENDS a `wait-for-condition` gate before this gesture so replay waits for the
   * game to reach the same consumable state. `null`/absent ⇒ no signal was sampled
   * (the gesture is emitted exactly as it would be without a declared signal).
   */
  stateSignal?: string | null;
  /**
   * The state-signal SPEC the observer sampled `stateSignal` FROM at this gesture (Phase 2 / D1-B:
   * per-scene auto-detect). Under auto-detect the signal differs scene to scene — StarChef's phase
   * manager vs Home's — so the spec is carried PER GESTURE rather than once globally, and takes
   * precedence over the global `meta.stateSignal`. Absent ⇒ the legacy single-signal path uses
   * `meta.stateSignal`. Paired with `stateSignal` (the sampled value) to build the gate.
   */
  stateSignalSpec?: StateSignalSpec;
}

/**
 * Pull the clicks array out of an `input.observe_stop` response payload. A missing
 * or non-array `clicks` yields `[]` (let the caller refuse an empty observation),
 * but a present-yet-malformed entry (no locator path) THROWS rather than being
 * silently dropped — a partial recording must never masquerade as a complete one.
 */
export function extractClicks(data: unknown): ObservedClick[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { clicks?: unknown }).clicks;
  if (!Array.isArray(raw)) return [];
  return raw.map((click, i) => {
    if (!click || typeof click !== "object" || !(click as ObservedClick).locator?.path) {
      throw new Error(
        `observe: malformed click at index ${i} (no locator path) — refusing a partial recording`,
      );
    }
    const c = click as ObservedClick;
    // A present-but-pathless drop target would silently degrade a drag to a tap.
    if (c.to !== undefined && !c.to?.path) {
      throw new Error(
        `observe: malformed drag at index ${i} (drop target has no locator path) — refusing a partial recording`,
      );
    }
    return c;
  });
}

/**
 * One observed keyboard EDGE — a press (`down`) or release (`up`) of `key` at `tMs`
 * (ms since observation started). The recorder emits raw edges (not paired holds) so
 * CONCURRENT keys reproduce: the transform interleaves them on a timeline.
 */
export interface ObservedKeyEdge {
  key: string;
  edge: "down" | "up";
  tMs: number;
}

/**
 * Pull the key edges out of an `input.observe_stop` payload. Missing/non-array ⇒ `[]`
 * (a session may be pure-click). A present-yet-malformed entry THROWS rather than
 * being silently dropped — a partial recording must never masquerade as complete.
 */
export function extractKeyEdges(data: unknown): ObservedKeyEdge[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { keyEdges?: unknown }).keyEdges;
  if (!Array.isArray(raw)) return [];
  return raw.map((edge, i) => {
    const e = edge as Partial<ObservedKeyEdge> | null;
    if (
      !e ||
      typeof e !== "object" ||
      typeof e.key !== "string" ||
      e.key.length === 0 ||
      (e.edge !== "down" && e.edge !== "up") ||
      typeof e.tMs !== "number" ||
      !Number.isFinite(e.tMs)
    ) {
      throw new Error(
        `observe: malformed key edge at index ${i} (need { key, edge:"down"|"up", tMs }) — refusing a partial recording`,
      );
    }
    return e as ObservedKeyEdge;
  });
}

/**
 * The OS WINDOW-MANAGER modifier family: Command/Meta on macOS, the Windows key elsewhere, both
 * sides, under every alias `KeyCode.ToString()` can print. `LeftMeta`, `LeftCommand` and `LeftApple`
 * are the same enum value, and which name .NET prints for a shared value is not something the
 * recorder should have to predict, so all of them are listed. Compared case-insensitively.
 *
 * These keys are NOT gameplay input. A human presses Cmd (or Win) to bring the Game view into
 * focus, to alt-tab, or to grab a screenshot — and one real recording carried `key-down LeftMeta`
 * x3, `key-down LeftWindows`, then the matching ups, purely from focusing the editor. Replaying
 * that injects a HELD Cmd into the game.
 *
 * Ctrl, Alt and Shift are deliberately NOT here: real games bind them (sprint, crouch, modifiers on
 * a build menu), so dropping them would silently delete gameplay.
 */
const OS_MODIFIER_KEYS = new Set([
  "leftmeta",
  "rightmeta",
  "leftcommand",
  "rightcommand",
  "leftapple",
  "rightapple",
  "leftwindows",
  "rightwindows",
]);

/** True for a key in the OS window-manager modifier family (see {@link OS_MODIFIER_KEYS}). */
export function isOsModifierKey(key: string): boolean {
  return OS_MODIFIER_KEYS.has(key.trim().toLowerCase());
}

/**
 * Split observed key edges into the ones worth replaying and a count of the OS-modifier edges
 * dropped. Pure; the caller reports the count (a dropped input the human performed must never be
 * silent).
 *
 * THIS MUST RUN BEFORE THE TRANSFORM IS CHOSEN. The presence of ANY key edge is what routes a
 * recording onto the merged keyboard timeline (`observedEdgesToTrace`) instead of the per-gesture
 * pointer transform (`observedClicksToTrace`). A pointer-only demonstration polluted by one Cmd
 * press would otherwise lose its per-gesture segments and per-gesture captures over an input the
 * game never saw. `observeLive.stop()` applies it, which is upstream of that branch in
 * `recordObservedTrace`.
 */
export function dropOsModifierKeyEdges(
  edges: ObservedKeyEdge[],
): { edges: ObservedKeyEdge[]; dropped: number } {
  const kept = edges.filter((edge) => !isOsModifierKey(edge.key));
  return { edges: kept, dropped: edges.length - kept.length };
}

/**
 * A state-signal binding: the component/property whose value names the game's current phase
 * (an enum like `Mix`/`Pour`). Used to build a `wait-for-condition` gate so replay waits for the
 * game to reach the same consumable phase the human's gesture occurred at.
 */
export interface StateSignalSpec {
  locator: Locator;
  component?: string;
  property: string;
}

export interface ObserveTraceMeta {
  id: string;
  /** Scene to load on reset (tier-1 scene-load). */
  scene: string;
  title?: string;
  intent?: string;
  /**
   * The DECLARED GLOBAL state signal (from the CLI `--state-signal <path>:<Component>:<property>`)
   * the observer samples per gesture. When set, each gesture whose `click.stateSignal`
   * is a non-empty string gets a `wait-for-condition` gate prepended (`property == the
   * sampled value`) so replay fires the gesture only once the game reaches the same
   * consumable state — a target often goes VISIBLE before the game's `phase` flips.
   * Absent ⇒ no global gate; a PER-GESTURE `click.stateSignalSpec` (Phase 2 auto-detect) still gates.
   */
  stateSignal?: StateSignalSpec;
  /**
   * Phase 2 / D1-B: ask the observer to AUTO-DETECT each scene's state signal live and switch on
   * scene-change (so a hub→game recording gates each scene's gestures on its own phase manager
   * without a declared signal). Takes precedence over `stateSignal`. Absent/false ⇒ unchanged.
   */
  autoDetectStateSignal?: boolean;
}

/** Default per-tap wait budget — the human's targets appear within a frame or two. */
const WAIT_FOR_VISIBLE_MS = 4000;

/** Cap on the per-step settle: a long human pause shouldn't make replay crawl. */
const MAX_SETTLE_MS = 3000;
/** Always settle at least this before a capture, so the screen isn't mid-animation. */
const MIN_SETTLE_MS = 400;

/**
 * How long to SETTLE after step `i`'s tap before its capture — the human's dwell on
 * the resulting screen (the gap to their NEXT click), clamped. This both lets the
 * screenshot reflect the settled state AND paces the next tap (the next step taps
 * right after this settle), so the observed gap is honored once, not twice. The last
 * step has no next click → a default settle for the final screen.
 */
function settleMsFor(clicks: ObservedClick[], i: number): number {
  const raw = i < clicks.length - 1 ? clicks[i + 1].tMs - clicks[i].tMs : MAX_SETTLE_MS;
  const gap = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SETTLE_MS) : MIN_SETTLE_MS;
  return Math.max(gap, MIN_SETTLE_MS);
}

/**
 * Reduce a bridge-built locator to what a PERSISTED trace should carry: the stable
 * hierarchy `path` only. A bridge locator also includes a runtime `instanceId`
 * (ephemeral — different every Play session, and arrives as a number that trips
 * `parseTrace`), a `globalObjectId`, and `scene` (the runtime scene NAME, which
 * binds resolution to that name matching at replay — brittle under scene rename /
 * additive load / DontDestroyOnLoad). Replay matches by `path`, and an absent
 * `scene` lets the resolver search all loaded scenes — strictly more robust.
 */
function stableLocator(locator: Locator): Locator {
  return { path: locator.path };
}

/**
 * Build a `drag` action from an observed drag click, carrying the two custom-gesture
 * fields ONLY when the observation actually evidences them:
 * - `travelPx` is set when finite and > 0 (a real scrub/stir distance);
 * - `releaseNorm` is set when BOTH `releaseNx` and `releaseNy` are >= 0 (the SENTINEL
 *   -1 means "absent" → a normal distinct-drop drag, emitted byte-identically to today).
 * `to` is always the stable drop-target locator. When neither field applies, the result
 * is exactly `{ do:"drag", from, to }` — regression-safe.
 */
function dragActionFor(click: ObservedClick, from: Locator): Action {
  const drag: Action = { do: "drag", from, to: stableLocator(click.to as Locator) };
  if (typeof click.travelPx === "number" && Number.isFinite(click.travelPx) && click.travelPx > 0) {
    drag.travelPx = click.travelPx;
    // Pair the record-time screen height so replay can rescale travel per device.
    if (typeof click.travelRefHeight === "number" && Number.isFinite(click.travelRefHeight) && click.travelRefHeight > 0) {
      drag.travelRefHeight = click.travelRefHeight;
    }
  }
  if (
    typeof click.releaseNx === "number" &&
    typeof click.releaseNy === "number" &&
    click.releaseNx >= 0 &&
    click.releaseNy >= 0
  ) {
    drag.releaseNorm = { x: click.releaseNx, y: click.releaseNy };
  }
  return drag;
}

/**
 * Build the precondition GATE for a gesture: a `wait-for-condition` action that
 * holds until the DECLARED state-signal field equals the value the observer
 * sampled at that gesture — so replay fires the gesture only once the game reaches
 * the same consumable state. Returns `undefined` (so the gesture is emitted exactly
 * as today — regression-safe) when no signal was declared, or `click.stateSignal`
 * isn't a non-empty string (null/absent/blank ⇒ no signal sampled). Pure.
 */
function stateSignalGate(
  meta: ObserveTraceMeta,
  click: ObservedClick,
): Action | undefined {
  // No sampled value ⇒ no gate (the game phase wasn't readable at this gesture).
  if (typeof click.stateSignal !== "string" || click.stateSignal.length === 0) return undefined;
  // The PER-GESTURE spec (Phase 2 auto-detect: this gesture's scene's signal) wins; else the legacy
  // single global signal. Either way the gate is baked from the resolved spec + the sampled value, so
  // the per-scene spec never has to persist beyond the transform.
  const signal = click.stateSignalSpec ?? meta.stateSignal;
  if (!signal) return undefined;
  return {
    do: "wait-for-condition",
    locator: signal.locator,
    ...(signal.component ? { component: signal.component } : {}),
    property_path: signal.property,
    operator: "equals",
    expected: click.stateSignal,
  };
}

export function observedClicksToTrace(
  clicks: ObservedClick[],
  meta: ObserveTraceMeta,
  outcomes?: Assertion[],
): ReplayTrace {
  if (clicks.length === 0) {
    throw new Error("observe: no clicks were recorded — nothing to turn into a trace");
  }

  const segments: Segment[] = clicks.map((click, i) => {
    const locator = stableLocator(click.locator);
    // Multi-scene EVIDENCE: the scene this gesture occurred in (from the bridge locator, when it
    // reports one). Carried on the segment for scene inference; replay still dispatches on the bare
    // path (`stableLocator` above), so this never affects replay matching. Undefined ⇒ dropped on
    // serialize (single-scene, back-compatible). An empty string from the bridge is normalized to
    // absent so the producer and the inference layer agree on what "no evidence" means.
    const scene = click.locator.scene || undefined;
    const id = `step-${i + 1}`;
    const settleMs = settleMsFor(clicks, i);
    // The precondition gate (if a state signal was declared + sampled) is grafted
    // immediately BEFORE the gesture and AFTER any wait-for-visible — so replay
    // waits for the game to reach the consumable state before actuating. Absent ⇒
    // `undefined`, so the actions list is byte-identical to today.
    const gate = stateSignalGate(meta, click);
    if (click.to && click.kind !== "world") {
      // A uGUI drag-and-drop: wait for the draggable, then drag it onto the drop
      // target (replayable via the EventSystem drag dispatch). Drags are uGUI-only;
      // a world gesture never carries `to` (guarded here so it can't misroute).
      return {
        id,
        ...(scene !== undefined ? { scene } : {}),
        actions: [
          { do: "wait-for-visible", locator, timeoutMs: WAIT_FOR_VISIBLE_MS },
          ...(gate ? [gate] : []),
          dragActionFor(click, locator),
        ],
        captures: [{ id, settleMs }],
      };
    }
    if (click.kind === "world") {
      // A non-uGUI target: record it faithfully, but it isn't drivable via the
      // EventSystem — replay marks the step blocked (see Action.world-tap).
      return {
        id,
        ...(scene !== undefined ? { scene } : {}),
        actions: [...(gate ? [gate] : []), { do: "world-tap", locator }],
        captures: [{ id, settleMs }],
      };
    }
    return {
      id,
      ...(scene !== undefined ? { scene } : {}),
      actions: [
        { do: "wait-for-visible", locator, timeoutMs: WAIT_FOR_VISIBLE_MS },
        ...(gate ? [gate] : []),
        { do: "tap", locator },
      ],
      captures: [{ id, settleMs }],
    };
  });

  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: meta.id,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.intent ? { intent: meta.intent } : {}),
    start: { scene: meta.scene, reset: "scene-load" },
    input: { backend: "ui-events" },
    segments,
    // Captured outcome assertions (the trustworthy-verdict layer): replay asserts
    // the game reached the recorded end state, not just that the taps actuated.
    ...(outcomes && outcomes.length > 0 ? { assertions: outcomes } : {}),
    outcome: { expected: "success" },
  };

  // Validate (throws on an unsafe id / malformed shape); return the assembled trace
  // un-normalized, mirroring RecordingSession.build.
  parseTrace(trace);
  return trace;
}

/** Cap on a single inter-event wait — a long human pause shouldn't make replay crawl. */
const MAX_WAIT_MS = 10_000;

/**
 * Turn an observed session that includes KEY EDGES into a timed-edge trace: clicks
 * and key-down/up edges merged into one time-ordered action list, with `wait`s
 * grafting the human's pacing between them. Keyboard gameplay is continuous and
 * CONCURRENT (a key stays held across waits while another taps), so — unlike the
 * per-click transform — it can't be split into per-gesture segments; it's one
 * `recorded` segment carrying the whole timeline. A key still held at stop is
 * released with a trailing `key-up` so the trace stays balanced.
 *
 * PER-GESTURE CAPTURES WITHOUT PER-GESTURE SEGMENTS. Each pointer gesture is followed by
 * an INTERLEAVED `{ do: "capture" }` action (`step-1`, `step-2`, …) sitting at that
 * gesture's own point in the timeline, plus the trailing `final` capture of the end state.
 * That is the whole reason the capture action exists: a segment boundary between a
 * `key-down` and its `key-up` would change the run's semantics, while a capture inside the
 * timeline leaves every held key exactly where the human left it. Before this, a 14-gesture
 * keyboard recording froze a baseline of ONE frame, so the pixel ratchet guarded nothing
 * about the gestures that produced it.
 *
 * THE SETTLE IS THE HUMAN'S OWN DWELL, AND IT IS SPENT ONCE. The settle is the gap to the
 * NEXT observed event (capped by {@link MAX_SETTLE_MS}) and is then DEDUCTED from the `wait`
 * that gap would otherwise have become. So the timeline's total length, and with it every
 * key-hold duration, is exactly what was recorded. This is why the merged path does NOT
 * apply the pointer path's {@link MIN_SETTLE_MS} floor per gesture: on the pointer path each
 * gesture is its own segment with no key held across it, so a floor only slows replay down,
 * whereas here a floor would hold a key down LONGER than the human did and change what the
 * game actually simulated. The only floored settle is the one after the last event, where
 * there is no following gap to spend and nothing left to distort.
 */
export function observedEdgesToTrace(
  clicks: ObservedClick[],
  keyEdges: ObservedKeyEdge[],
  meta: ObserveTraceMeta,
  outcomes?: Assertion[],
): ReplayTrace {
  if (clicks.length === 0 && keyEdges.length === 0) {
    throw new Error("observe: no input was recorded — nothing to turn into a trace");
  }

  type Ev =
    | { tMs: number; kind: "click"; click: ObservedClick }
    | { tMs: number; kind: "edge"; edge: ObservedKeyEdge };
  const events: Ev[] = [
    ...clicks.map((click): Ev => ({ tMs: click.tMs, kind: "click", click })),
    ...keyEdges.map((edge): Ev => ({ tMs: edge.tMs, kind: "edge", edge })),
  ];
  // Sort by time, tiebreaking equal-tMs events so a key-DOWN always precedes a
  // key-UP (rank 0 < 2) — never emit an up before its down at the same instant.
  const rank = (e: Ev): number => (e.kind === "edge" ? (e.edge.edge === "down" ? 0 : 2) : 1);
  events.sort((a, b) => a.tMs - b.tMs || rank(a) - rank(b));

  const actions: Action[] = [];
  const held = new Set<string>(); // keys currently down — drives balanced ups
  // The inter-event gap is accumulated and flushed as a `wait` ONLY right before an
  // action we actually emit — so a DROPPED edge (an unmatched up) leaves no orphan
  // wait, and any trailing gap after the last real action is discarded.
  let pendingMs = 0;
  let prevTMs = events[0].tMs;
  // Milliseconds of the upcoming gap ALREADY SPENT by a capture settle that was just
  // emitted. Deducted from the next `wait` so the human's dwell is honored exactly once
  // and the timeline (every key-hold duration with it) keeps its recorded length. The cap
  // is applied to the gap FIRST and the debt taken off after, so a capped 10s gap that
  // spent 3s settling waits 7s: 10s total, not 13s.
  let settleDebtMs = 0;
  const flushWait = (): void => {
    const gap = Math.max(0, Math.min(pendingMs, MAX_WAIT_MS) - settleDebtMs);
    if (gap > 0) actions.push({ do: "wait", durationMs: gap });
    pendingMs = 0;
    settleDebtMs = 0;
  };
  let gestureCount = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    pendingMs += Math.max(0, ev.tMs - prevTMs);
    prevTMs = ev.tMs;

    if (ev.kind === "edge") {
      const { key, edge } = ev.edge;
      if (edge === "down") {
        flushWait();
        actions.push({ do: "key-down", key });
        held.add(key);
      } else if (held.has(key)) {
        flushWait();
        actions.push({ do: "key-up", key });
        held.delete(key);
      }
      // else: an up with no matching down (key held before observe_start, or a
      // duplicate) — DROP it (its gap carries to the next emitted action). A balanced
      // trace is honest; `input.key_up` on an unpressed key would be a silent no-op.
      continue;
    }
    flushWait();
    const locator = stableLocator(ev.click.locator);
    // Precondition gate (state signal declared + sampled): grafted immediately
    // before the gesture and after any wait-for-visible. Absent ⇒ undefined, so the
    // action stream is byte-identical to today (regression-safe).
    const gate = stateSignalGate(meta, ev.click);
    if (ev.click.to && ev.click.kind !== "world") {
      actions.push({ do: "wait-for-visible", locator, timeoutMs: WAIT_FOR_VISIBLE_MS });
      if (gate) actions.push(gate);
      actions.push(dragActionFor(ev.click, locator));
    } else if (ev.click.kind === "world") {
      if (gate) actions.push(gate);
      actions.push({ do: "world-tap", locator });
    } else {
      actions.push({ do: "wait-for-visible", locator, timeoutMs: WAIT_FOR_VISIBLE_MS });
      if (gate) actions.push(gate);
      actions.push({ do: "tap", locator });
    }
    // The gesture's own frame, at the gesture's own point in the timeline. The id matches
    // the pointer path's (`step-N`, numbered by gesture) so it is stable across
    // re-recordings of the same flow and reads the same in both kinds of report.
    gestureCount += 1;
    // The human's dwell on the resulting screen: the gap to the NEXT observed event,
    // capped. With no next event the observation simply ended, so there is no dwell to
    // read and no following gap to distort — that one settles for MIN_SETTLE_MS, the same
    // discipline the trailing `final` capture uses.
    const nextTMs = i + 1 < events.length ? events[i + 1].tMs : undefined;
    const settleMs =
      nextTMs === undefined ? MIN_SETTLE_MS : Math.min(Math.max(0, nextTMs - ev.tMs), MAX_SETTLE_MS);
    actions.push({ do: "capture", id: `step-${gestureCount}`, settleMs });
    // Spend the dwell ONCE: the settle we just emitted comes out of the gap that would
    // otherwise become the next `wait`.
    settleDebtMs = settleMs;
  }
  // Release any key still held at stop, so replay can't strand it (teardown's
  // end_session is a backstop, but a balanced trace is honest on its own).
  for (const key of held) {
    actions.push({ do: "key-up", key });
  }

  // Multi-scene EVIDENCE for the merged keyboard timeline. Unlike the per-click transform, this is ONE
  // segment, so it can carry at most one scene. Stamp it only when every observed click agrees on a
  // single scene (key edges carry none) — that lifts evidence for a single-scene keyboard trace exactly
  // like the pointer path. A timeline genuinely spanning MULTIPLE scenes can't be represented by one
  // segment; we leave scene absent (⇒ single-scene fallback, the same as today, never a false multi-scene
  // claim). Per-gesture scene splitting for cross-scene KEYBOARD play is Phase 2 scope.
  const clickScenes = new Set(clicks.map((c) => c.locator.scene || undefined).filter((s) => s !== undefined));
  const segmentScene = clickScenes.size === 1 ? [...clickScenes][0] : undefined;

  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: meta.id,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.intent ? { intent: meta.intent } : {}),
    start: { scene: meta.scene, reset: "scene-load" },
    // Keyboard gameplay is driven by the simulated Input System keyboard; uGUI taps
    // in the timeline still dispatch under this backend (capabilityCheck accepts both).
    input: { backend: "input-system" },
    segments: [{
      id: "recorded",
      actions,
      captures: [{ id: "final", settleMs: MIN_SETTLE_MS }],
      ...(segmentScene !== undefined ? { scene: segmentScene } : {}),
    }],
    ...(outcomes && outcomes.length > 0 ? { assertions: outcomes } : {}),
    outcome: { expected: "success" },
  };

  parseTrace(trace);
  return trace;
}
