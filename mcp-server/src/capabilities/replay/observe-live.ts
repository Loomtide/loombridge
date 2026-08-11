/**
 * Replay Verification — observe-a-human-session live wiring.
 *
 * `observeLive(send)` starts observation (`input.observe_start`) and returns a
 * handle whose `stop()` collects the developer's recorded clicks
 * (`input.observe_stop`). The agent calls it, tells the human to play, then awaits
 * `stop()` and feeds the clicks to `observedClicksToTrace`. Not exported from the
 * barrel — live wiring, like `run-live`/`record-live`.
 */

import {
  dropOsModifierKeyEdges,
  extractClicks,
  extractKeyEdges,
  type ObservedClick,
  type ObservedKeyEdge,
  type OutcomeSpec,
} from "./observe.js";
import type { Assertion } from "./types.js";
import type { BridgeSend } from "./unity-driver.js";

export interface StopResult {
  clicks: ObservedClick[];
  /** Keyboard down/up edges observed during the session (empty for a pure-click session). */
  keyEdges: ObservedKeyEdge[];
  /** uGUI taps the observer dropped for hitting no interactive element (honest, not silent). */
  droppedNoTarget: number;
  /**
   * Gestures the observer dropped because the Game view was UNFOCUSED at the press
   * edge: the editor swallowed them, so the game never processed them. Recording them
   * would mint phantom steps replay cannot reproduce. 0 when the bridge predates the
   * field (an older editor simply reports nothing here).
   */
  droppedUnfocused: number;
  /**
   * Key edges dropped for being OS WINDOW-MANAGER modifiers (Cmd/Meta/Win, either side): the human
   * pressed them to focus the Game view or alt-tab, not to play. Dropped here, upstream of the
   * transform choice, so a pointer demonstration polluted by a Cmd press still takes the pointer
   * path. Reported, never silent. See `dropOsModifierKeyEdges`.
   */
  droppedOsModifier: number;
}

export interface ObserveSession {
  /** Stop observing (while Play Mode is still live) and return the recorded clicks. */
  stop(): Promise<StopResult>;
}

/** A value no real property equals — lets us read `actual` regardless of pass/fail. */
const CAPTURE_SENTINEL = "__loombridge_outcome_capture__";

/** uGUI Text components whose serialized `m_Text` is a screen-gated DISPLAYED value. */
const TEXT_COMPONENTS = new Set(["Text", "TMP_Text", "TextMeshProUGUI", "TextMeshPro"]);

/** A displayed UI-Text outcome — the case where the visibility gate is meaningful. */
function isUiTextTarget(spec: OutcomeSpec): boolean {
  return spec.property_path === "m_Text" || (!!spec.component && TEXT_COMPONENTS.has(spec.component));
}

/**
 * Capture the CURRENT value of each declared outcome property (call while Play Mode
 * is live, at stop) into an end-state `Assertion` for the trace. Reads the value via
 * `runtime.assert_condition`'s `actual` field (preserving JSON shape) and pins it
 * with `equals` (or the spec's operator). Refuses a property it can't read — a
 * silently-absent outcome is worse than none.
 */
export async function captureOutcomes(send: BridgeSend, specs: OutcomeSpec[]): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  for (const spec of specs) {
    // We only ever read `actual`, never `passed`, so the comparison is irrelevant —
    // but the operator must be `not_equals`: it never invokes the numeric reader, so a
    // string sentinel vs a number/string property never throws INVALID_TYPE (it just
    // returns the value). Do NOT switch this to a numeric comparator.
    const response = await send("runtime.assert_condition", {
      locator: spec.locator,
      ...(spec.component ? { component: spec.component } : {}),
      property_path: spec.property_path,
      operator: "not_equals",
      expected: CAPTURE_SENTINEL,
    });
    if (response.status === "error") {
      throw new Error(
        `observe: could not capture outcome "${spec.id}" (${spec.property_path}): ${response.error?.message ?? "bridge error"}`,
      );
    }
    const actual = (response.data as { actual?: unknown } | undefined)?.actual;
    if (actual === undefined) {
      throw new Error(
        `observe: could not capture outcome "${spec.id}" (${spec.property_path}) — the property read no value`,
      );
    }
    assertions.push({
      id: spec.id,
      locator: spec.locator,
      ...(spec.component ? { component: spec.component } : {}),
      property_path: spec.property_path,
      operator: spec.operator ?? "equals",
      expected: actual,
      ...(spec.tolerance !== undefined ? { tolerance: spec.tolerance } : {}),
      // Gate on reaching the screen — the value was read while visible, so replay
      // must reach it too, else it reads a scene default and false-passes. Default ON
      // only for a UI-TEXT outcome (a displayed value on a screen-gated element): for
      // a non-UI / always-present property `ui-visible` can't be satisfied and would
      // false-FAIL, so leave those ungated unless the author opts in explicitly.
      ...((spec.reachedWhenVisible ?? isUiTextTarget(spec)) ? { reachedWhenVisible: true } : {}),
    });
  }
  return assertions;
}

/**
 * The DECLARED state signal passed to `input.observe_start` so the observer SAMPLES
 * that field per gesture (mirrors the agreed bridge protocol: `observe_start` params
 * gain optional `stateSignal: { path, component, property }`). Omitted ⇒ the bridge
 * receives `{}` and no signal is sampled (the no-signal path is unchanged).
 */
export interface ObserveStartStateSignal {
  path: string;
  component: string;
  property: string;
}

/**
 * The bridge's grace period for the human to make Unity the ACTIVE OS application before
 * `input.observe_start` begins recording (mirror of `InputHandler.DefaultActivationTimeoutMs`
 * in the C# bridge). Declared here because the WIRE timeout below has to exceed it: the two
 * numbers live in different languages and `replay-observe.test.ts` reads the C# constant off
 * disk and binds them, so a change on either side that inverts the relationship fails a test
 * instead of silently making the client give up before the bridge does.
 */
export const OBSERVE_ACTIVATION_GRACE_MS = 60_000;

/**
 * Wire timeout for `input.observe_start`. The default 10s op timeout would abort the call while
 * the bridge is still waiting for the human's click, so state it explicitly, with headroom over
 * the bridge's own grace for the reply to come back.
 */
export const OBSERVE_START_TIMEOUT_MS = OBSERVE_ACTIVATION_GRACE_MS + 30_000;

/** A line for the human running the CLI (the caller adds its own prefix). */
export type ObserveNotice = (message: string) => void;

export async function observeLive(
  send: BridgeSend,
  stateSignal?: ObserveStartStateSignal,
  autoDetectStateSignal = false,
  onNotice?: ObserveNotice,
): Promise<ObserveSession> {
  // Phase 2 / D1-B: when auto-detect is on the observer finds each scene's signal live, so a declared
  // stateSignal is ignored. Send only the flag in that case so the two modes can't both be active.
  const startParams = autoDetectStateSignal
    ? { autoDetectStateSignal: true }
    : (stateSignal ? { stateSignal } : {});
  const notify: ObserveNotice = onNotice ?? (() => {});
  // BEFORE the send, because the send does not return until Unity is the active application:
  // the human is looking at a terminal that would otherwise sit silent, and the instruction they
  // need ("click Unity") is the very thing that unblocks it. The "press Enter to stop" prompt is
  // printed by the caller only after this call resolves, so the human is never told to press
  // Enter before being told that recording actually started.
  notify(
    `Click the Unity window now: recording starts when Unity is the ACTIVE application ` +
      `(waiting up to ${Math.round(OBSERVE_ACTIVATION_GRACE_MS / 1000)}s). ` +
      `Taps that arrive before that are swallowed by the editor and are never recorded.`,
  );
  const started = await send("input.observe_start", startParams, OBSERVE_START_TIMEOUT_MS);
  if (started.status !== "error") {
    notify(observeStartNotice(started.data));
  }
  return {
    async stop(): Promise<StopResult> {
      const response = await send("input.observe_stop", {});
      // `observed:false` ⇒ the recorder was not live at stop (never started, or Play
      // Mode was restarted after observe_start). Refuse rather than treat an empty
      // capture as a clean no-click session.
      if (isNotObserved(response.data)) {
        throw new Error(
          "observe: the recorder was not live at stop (did Play Mode restart after observe_start?) — no clicks captured",
        );
      }
      const droppedNoTarget = (response.data as { droppedNoTarget?: unknown } | undefined)
        ?.droppedNoTarget;
      // Schema-tolerant: a bridge older than the Game-view-focus backstop returns no
      // `droppedUnfocused` field at all, which reads as 0 (nothing dropped for focus).
      const droppedUnfocused = (response.data as { droppedUnfocused?: unknown } | undefined)
        ?.droppedUnfocused;
      // OS modifier edges are stripped HERE, at the session boundary, because the transform choice
      // downstream keys off whether ANY key edge survived. See `dropOsModifierKeyEdges`.
      const keys = dropOsModifierKeyEdges(extractKeyEdges(response.data));
      return {
        clicks: extractClicks(response.data),
        keyEdges: keys.edges,
        droppedNoTarget: typeof droppedNoTarget === "number" ? droppedNoTarget : 0,
        droppedUnfocused: typeof droppedUnfocused === "number" ? droppedUnfocused : 0,
        droppedOsModifier: keys.dropped,
      };
    },
  };
}

/**
 * What to tell the human once `input.observe_start` has returned.
 *
 * Schema-tolerant in one direction only: a bridge that predates the activation gate reports
 * neither field, which reads as "started" (its behaviour is unchanged and there is nothing
 * honest to warn about). A bridge that DOES report it and says Unity was not active gets the
 * loud line, because every gesture arriving in that state is dropped, so the human would
 * otherwise demonstrate a whole flow into a recording that captured none of it.
 */
export function observeStartNotice(data: unknown): string {
  const d = data as { applicationActive?: unknown; activationTimedOut?: unknown } | undefined;
  const inactive = d?.activationTimedOut === true || d?.applicationActive === false;
  return inactive
    ? "WARNING: Unity did not become the active application. Recording started anyway, but every " +
        "gesture that arrives while Unity is inactive is DROPPED, never recorded. Click the Unity " +
        "window, then play your flow."
    : "Recording. Play your flow in Unity now.";
}

function isNotObserved(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { observed?: boolean }).observed === false;
}
