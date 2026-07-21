/**
 * Replay Verification — record-by-demonstration (Phase B, promote-a-run).
 *
 * A `RecordingSession` wraps a `ReplayDriver`: each `tap`/`drag`/`waitVisible`/
 * `capture` DRIVES the live editor (via the same driver the replay uses) AND
 * appends the corresponding action/anchor/capture to a trace under construction.
 * `build()` emits a `ReplayTrace` that replays the demonstrated flow. This is the
 * doc's `promote-a-run` recorder: an agent demonstrates a flow once and the green
 * run becomes a trace — no hand-authoring.
 *
 * It is pure given a driver (the live wiring is in `record-live.ts`), so it is
 * unit-testable against a fake driver. A failed step throws, so a recording only
 * succeeds if every demonstrated action actually actuated and every anchor was
 * reached — a recorded trace is a green run by construction.
 */

import type { ReplayDriver } from "./driver.js";
import { isSafePathSegment, parseTrace } from "./parse.js";
import type { Action, Anchor, Capture, Locator, ReplayTrace, Segment } from "./types.js";

export interface RecordingMeta {
  id: string;
  title?: string;
  intent?: string;
  /** The scene to restore on replay (tier-1 reset). */
  scene: string;
  /** Expected outcome of the demonstrated flow (default "success"). */
  outcome?: "success" | "failure";
}

export class RecordingSession {
  private readonly segments: Segment[] = [];
  private anchorSeq = 0;

  constructor(
    private readonly driver: ReplayDriver,
    private readonly meta: RecordingMeta,
  ) {
    requireSafeId(meta.id, "trace id");
  }

  /** Begin a named segment; subsequent steps attach to it. */
  segment(id: string): void {
    requireSafeId(id, "segment id");
    if (this.segments.some((s) => s.id === id)) {
      throw new Error(`record: duplicate segment id "${id}"`);
    }
    this.segments.push({ id, actions: [], anchors: [], captures: [] });
  }

  /** Tap a uGUI element (records a `tap` action). Throws if it did not actuate. */
  async tap(locator: Locator): Promise<void> {
    const action: Action = { do: "tap", locator };
    const result = await this.driver.dispatch(action);
    if (!result.ok) {
      throw new Error(`record: tap ${locator.path} failed (${result.detail ?? "not actuated"})`);
    }
    this.current().actions.push(action);
  }

  /** Drag from one element to another (records a `drag` action). */
  async drag(from: Locator, to: Locator): Promise<void> {
    const action: Action = { do: "drag", from, to };
    const result = await this.driver.dispatch(action);
    if (!result.ok) {
      throw new Error(`record: drag ${from.path}→${to.path} failed (${result.detail ?? "not actuated"})`);
    }
    this.current().actions.push(action);
  }

  /** Wait for an element to become visible (records a `ui-visible` anchor). */
  async waitVisible(locator: Locator, timeoutMs?: number): Promise<string> {
    const id = `${this.current().id}-anchor-${(this.anchorSeq += 1)}`;
    const anchor: Anchor = { id, kind: "ui-visible", locator, timeoutMs };
    const result = await this.driver.waitForAnchor(anchor);
    if (!result.reached) {
      throw new Error(`record: ${locator.path} never became visible (${result.actual ?? "not observed"})`);
    }
    this.current().anchors!.push(anchor);
    return id;
  }

  /** Capture a screenshot, tied to the most recent anchor in this segment if any. */
  async capture(id: string): Promise<void> {
    // `id` becomes a PNG filename — validate before driving (a screenshot write
    // happens live, before build()/parseTrace could reject it).
    requireSafeId(id, "capture id");
    const outcome = await this.driver.capture(id);
    if (!outcome.artifact) {
      // Fail loudly like tap/waitVisible — a recording must not reference a
      // capture that produced no image ("green by construction" for captures too).
      throw new Error(`record: capture "${id}" produced no image`);
    }
    const segment = this.current();
    const lastAnchor = segment.anchors?.[segment.anchors.length - 1];
    const capture: Capture = lastAnchor ? { id, atAnchor: lastAnchor.id } : { id };
    segment.captures!.push(capture);
  }

  /**
   * Emit the recorded trace. Throws if the recording somehow assembled a trace
   * the parser would reject — the recorder's whole job is to produce a VALID
   * trace, so it must never emit one `parseTrace` refuses (e.g. an
   * `outcome:"failure"` recording with nothing to observe the failure).
   */
  build(): ReplayTrace {
    const segments = this.segments.length
      ? this.segments
      : [{ id: "segment-1", actions: [] as Action[] }];
    const trace: ReplayTrace = {
      schemaVersion: "0.1",
      id: this.meta.id,
      title: this.meta.title,
      intent: this.meta.intent,
      start: { scene: this.meta.scene, reset: "scene-load" },
      input: { backend: "ui-events" },
      segments,
      outcome: { expected: this.meta.outcome ?? "success" },
    };
    parseTrace(trace); // structural guard; throws TraceParseError if invalid.
    return trace;
  }

  private current(): Segment {
    if (this.segments.length === 0) this.segment("segment-1");
    return this.segments[this.segments.length - 1];
  }
}

function requireSafeId(id: string, label: string): void {
  if (typeof id !== "string" || !isSafePathSegment(id)) {
    throw new Error(`record: ${label} "${id}" must be a non-empty name without path separators or '..'`);
  }
}
