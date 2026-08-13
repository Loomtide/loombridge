/**
 * Replay Verification — the live Unity driver (Phase A, slice A3).
 *
 * `UnityDriver` implements `ReplayDriver` over the bridge: each method is a thin
 * adapter onto an existing op, issued through a `BridgeSend` (normally
 * `UnityClient.send` bound to a connected client). The deterministic engine
 * (`engine.ts`) owns all sequencing; this file only translates one engine step
 * into one (or a few) op calls and interprets the response.
 *
 * Op mapping:
 *   reset            → editor.stop → scene.open_scene(Single) → editor.play → editor.wait_for
 *   dispatch(tap)    → ui.dispatch_pointer { action:"click" }
 *   dispatch(drag)   → ui.dispatch_pointer { action:"drag", to_locator }
 *   dispatch(wait)   → poll ui.get_screen_rects until isVisible
 *   waitForAnchor    → poll ui.get_screen_rects (ui-visible) | runtime.wait_for_condition
 *   capture          → editor.screenshot { outputPath }
 *   evaluateAssertion→ runtime.assert_condition
 *   readConsole      → editor.console_logs (count Error/Exception)
 *
 * The driver is constructed per trace (so `captureDir` can be trace-scoped).
 * It is decoupled from the concrete client via the `BridgeSend` function type,
 * which makes the op-mapping unit-testable against a fake send.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeResponse } from "../../shared/types.js";
import { alignedSettleFrames, physicsCadenceNote } from "./aligned-capture.js";
import type {
  AnchorResult,
  AssertionOutcome,
  CapabilityResult,
  CaptureOutcome,
  ConsoleOutcome,
  DispatchResult,
  ReplayDriver,
  ResetResult,
} from "./driver.js";
import type {
  Action,
  Anchor,
  Assertion,
  ConditionSpec,
  Locator,
  ResetHook,
  ResetSpec,
} from "./types.js";
import type { MinigameReachedCondition } from "../minigame/profiles/types.js";
import { LOOMBRIDGE_DIRNAME } from "../../domain/state.js";

export type BridgeSend = (
  command: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<BridgeResponse>;

export interface UnityDriverOptions {
  /**
   * Directory for capture PNGs (server-relative under `.loombridge/`|`captures/`,
   * or absolute under an allowed root). Default `.loombridge/run/replays/actual`.
   */
  captureDir?: string;
  /** Default wait budget for an anchor with no explicit timeout (ms). */
  defaultAnchorTimeoutMs?: number;
  /** Poll interval for ui-visible waits (ms). */
  pollIntervalMs?: number;
  /** Settle budget after entering Play Mode (ms). */
  playSettleTimeoutMs?: number;
  /** Console log types treated as errors. */
  errorLogTypes?: ReadonlySet<string>;
  /**
   * How often to ping `input.keepalive` while a keyboard input session is open, to
   * keep the bridge's held-key idle watchdog (30s) from reclaiming the session
   * mid-replay (a held key across long `wait`s would otherwise be released). Well
   * under the 30s timeout.
   */
  keepaliveIntervalMs?: number;
  /**
   * ALIGNED CAPTURE MODE. When set, a capture's settle stops being a wall-clock sleep in
   * this process and becomes ONE `replay.settle_and_capture` call: the bridge advances the
   * settle inside a single tick loop with `Time.captureDeltaTime` pinned to 1/fps and takes
   * the screenshot on the exact frame the settle completes.
   *
   * ABSENT = the legacy wall-clock path, byte for byte (sleep, then `editor.screenshot`).
   * That default is deliberate: alignment changes which frame a capture lands on, so every
   * baseline approved under the old discipline keeps grading exactly as it did until someone
   * asks for the new one.
   */
  alignedCaptureFps?: number;
}

/**
 * The cwd-relative capture directory a driver falls back to when no `captureDir` is given.
 *
 * POSIX separators on purpose: this string is sent to the bridge as a server-relative
 * `outputPath` and joined with `/` at the call site, so `path.join` (which would emit `\`
 * on Windows) must not be used. The dirname comes from the ONE constant; the
 * `run/replays/actual` tail is not a `LoombridgePaths` slot, so
 * `__tests__/unit/repo/write-paths.test.ts` pins THIS export and classifies it.
 */
export const UNITY_DRIVER_DEFAULT_CAPTURE_DIR = `${LOOMBRIDGE_DIRNAME}/run/replays/actual`;

const DEFAULTS = {
  captureDir: UNITY_DRIVER_DEFAULT_CAPTURE_DIR,
  defaultAnchorTimeoutMs: 5000,
  pollIntervalMs: 150,
  playSettleTimeoutMs: 30000,
  keepaliveIntervalMs: 10000,
  // The bridge collapses LogType.Error/Exception/Assert to the single lowercase
  // string "error" (TraceCollector.cs); match that exactly or console health is
  // a no-op (a thrown exception would never be counted — a silent green).
  errorLogTypes: new Set(["error"]),
};

export class UnityDriver implements ReplayDriver {
  private readonly captureDir: string;
  private readonly defaultAnchorTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly playSettleTimeoutMs: number;
  private readonly errorLogTypes: ReadonlySet<string>;
  /** Aligned-capture fps, or undefined for the legacy wall-clock settle. */
  private readonly alignedCaptureFps: number | undefined;
  /** The physics-cadence advisory is printed at most once per drive, not once per capture. */
  private cadenceNoticePrinted = false;

  /**
   * Input-session lifecycle for keyboard actions (opened lazily on the first
   * key action, closed in teardown). `unavailable` latches the blocked reason so
   * every subsequent key action degrades identically without re-probing.
   */
  private inputSession: "none" | "open" | "unavailable" = "none";
  private inputSessionBlockDetail = "input session unavailable";
  /** The open session's id + its keepalive timer (held keys survive long waits). */
  private inputSessionId: string | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private readonly keepaliveIntervalMs: number;

  /**
   * Lazily-fetched live viewport (px), used to denormalize a drag's `releaseNorm`
   * to absolute screen coords. Cached per drive so a trace of many such drags hits
   * `ui.get_screen_rects` once, not per drag (the viewport is stable within a run).
   */
  private viewport: { width: number; height: number } | undefined;

  constructor(
    private readonly send: BridgeSend,
    options: UnityDriverOptions = {},
  ) {
    this.captureDir = options.captureDir ?? DEFAULTS.captureDir;
    this.defaultAnchorTimeoutMs =
      options.defaultAnchorTimeoutMs ?? DEFAULTS.defaultAnchorTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.playSettleTimeoutMs =
      options.playSettleTimeoutMs ?? DEFAULTS.playSettleTimeoutMs;
    this.errorLogTypes = options.errorLogTypes ?? DEFAULTS.errorLogTypes;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULTS.keepaliveIntervalMs;
    this.alignedCaptureFps = options.alignedCaptureFps;
  }

  async capabilityCheck(backend: string): Promise<CapabilityResult> {
    // `ui-events`: uGUI through the EventSystem (ui.dispatch_pointer), backend-
    // agnostic. `input-system`: gameplay driven by the simulated Input System
    // keyboard. For BOTH, the ACTUAL device availability is resolved at dispatch
    // time and blocked-degrades honestly (a world-tap / keyboard action on a
    // legacy-only project), exactly as the simulated pointer does — so this gate
    // only rejects a backend the driver has no path for at all.
    if (backend === "ui-events" || backend === "input-system") return { supported: true };
    return { supported: false, reason: "unsupported-input-backend" };
  }

  async reset(start: { scene: string; reset: ResetSpec }): Promise<ResetResult> {
    // A reset does a Play-Mode exit→enter (a domain reload) that DESTROYS any
    // Unity input session this driver opened. Invalidate the cached session state
    // (including the `unavailable` latch — availability can change across a reload,
    // e.g. focus) so the next keyboard action re-opens a fresh session rather than
    // driving a dead one. Matters when a driver is REUSED across traces (a fleet
    // runner); harmless for the one-driver-per-trace path.
    this.stopKeepalive();
    this.inputSession = "none";
    this.inputSessionId = undefined;
    // Invalidate the cached viewport: multi-aspect capture REUSES one driver across
    // devices, calling reset() once per device AFTER set_game_view_size, so the viewport
    // (used to denormalize a `releaseNorm` drag) changes between drives. Re-fetch on the
    // next such drag at the new size, else non-base devices would release at the wrong point.
    this.viewport = undefined;
    try {
      if (start.reset === "scene-load") {
        await this.fullResetCycle(start.scene);
        return { ok: true, tier: "scene-load" };
      }
      if (start.reset === "relaunch") {
        // Editor-driven replay: a full Play-Mode exit destroys all runtime objects
        // (incl. DontDestroyOnLoad); static fields also reset when Reload-Domain-on-
        // Play is enabled. So this is the strongest reset available in-editor; a
        // genuine OS process relaunch applies to standalone player targets (a
        // build-target follow-on).
        await this.fullResetCycle(start.scene);
        return { ok: true, tier: "relaunch" };
      }
      // tier-2: scene load, then drive the declared reset hook to a clean start.
      await this.fullResetCycle(start.scene);
      await this.performResetHook(start.reset.hook);
      return { ok: true, tier: "hook" };
    } catch (error) {
      // A dead bridge is a harness failure, not a "the game couldn't reset"
      // verdict — rethrow it rather than dressing it up as a tidy `blocked`.
      if (isConnectionError(error)) throw error;
      return {
        ok: false,
        reason: "reset-unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** stop → wait edit-mode → open scene → play → wait playing. The fullest reset. */
  private async fullResetCycle(scene: string): Promise<void> {
    // Best-effort stop, then WAIT for edit mode before opening the scene:
    // exiting Play Mode applies on a later tick (after a domain reload), and
    // scene.open_scene cannot run in Play Mode.
    await this.trySend("editor.stop", {});
    this.data(
      await this.send(
        "editor.wait_for",
        { playMode: "stopped", compiling: false, timeoutMs: this.playSettleTimeoutMs },
        this.playSettleTimeoutMs + 5000,
      ),
      "editor.wait_for",
    );
    this.data(
      await this.send("scene.open_scene", { path: scene, mode: "Single" }, 30000),
      "scene.open_scene",
    );
    this.data(await this.send("editor.play", {}), "editor.play");
    this.data(
      await this.send(
        "editor.wait_for",
        { playMode: "playing", compiling: false, timeoutMs: this.playSettleTimeoutMs },
        this.playSettleTimeoutMs + 5000,
      ),
      "editor.wait_for",
    );
    // Keep the player loop ticking while we drive from the background. A backgrounded editor
    // suspends MonoBehaviour.Update + coroutines, so a game whose navigation runs in game code
    // (an animated tile that calls SceneManager.LoadScene from a coroutine, an async load) never
    // advances — every captured frame stalls on the entry screen. Setting runInBackground AFTER
    // play is confirmed (it's a runtime property; pre-reload wouldn't stick) makes the drive
    // focus-independent, like the runtime probe/input pump. Best-effort: an older bridge without
    // the op keeps the prior (focus-dependent) behaviour rather than failing the drive.
    await this.trySend("editor.set_run_in_background", { enabled: true });
  }

  /** Drive a tier-2 reset hook (after the scene is playing). Throws if it fails. */
  private async performResetHook(hook: ResetHook): Promise<void> {
    if (hook.do === "tap") {
      // The reset element may appear a frame or two after play starts (menu
      // fade-in, async load) — wait for it before tapping, like an anchor.
      const present = await this.pollVisible(hook.locator, this.defaultAnchorTimeoutMs);
      if (!present.reached) {
        throw new Error(
          `reset hook: ${hook.locator.path} never became tappable (${present.actual ?? "not visible"})`,
        );
      }
      const data = this.data(
        await this.send("ui.dispatch_pointer", { action: "click", locator: hook.locator }),
        "ui.dispatch_pointer",
      );
      if (data.actuated !== true) {
        throw new Error(`reset hook: tap ${hook.locator.path} did not actuate`);
      }
    } else {
      this.data(
        await this.send("component.set_property", {
          locator: hook.locator,
          type_name: hook.component,
          property_path: hook.property,
          value: hook.value ?? true,
        }),
        "component.set_property",
      );
    }

    // No silent green: an actuated tap / a written field is NOT proof the reset
    // took effect. If the trace declared a `verify`, the hook only succeeds once
    // that reset signal is observed.
    if (hook.verify) {
      const reached = await this.pollVisible(
        hook.verify.locator,
        hook.verify.timeoutMs ?? this.defaultAnchorTimeoutMs,
      );
      if (!reached.reached) {
        throw new Error(
          `reset hook: verify ${hook.verify.locator.path} not reached (${reached.actual ?? "not visible"})`,
        );
      }
    }
  }

  async dispatch(action: Action): Promise<DispatchResult> {
    if (action.do === "capture") {
      // A `capture` action is taken through the `capture` SEAM, by the engine, never
      // dispatched as input. REFUSED rather than allowed to reach the fall-through below,
      // which builds `{ action: "click", locator: action.locator }` from whatever the action
      // has: a capture has no locator, so it would dispatch a pointer click at an undefined
      // target and report `ok` if the bridge happened to tolerate it.
      return {
        ok: false,
        detail: `capture "${action.id}" reached driver.dispatch; an interleaved capture is taken through driver.capture`,
      };
    }
    if (action.do === "wait-for-visible") {
      const startedAt = Date.now();
      const result = await this.pollVisible(
        action.locator,
        action.timeoutMs ?? this.defaultAnchorTimeoutMs,
      );
      if (!result.reached) return { ok: false, detail: result.actual ?? "not visible" };
      // Timing floor: once visible, hold until the human's observed gap has elapsed
      // (the deterministic visibility wait stays primary; this only ever ADDS time,
      // so replay isn't unrealistically fast). The cap lives at trace-author time.
      if (action.minDelayMs && action.minDelayMs > 0) {
        const remaining = action.minDelayMs - (Date.now() - startedAt);
        if (remaining > 0) await delay(remaining);
      }
      return { ok: true };
    }

    if (action.do === "wait-for-condition") {
      // The recorder-grafted precondition gate: hold until the declared STATE
      // SIGNAL holds before the next gesture, so replay never fires before the
      // game can consume the input (a target goes VISIBLE before `phase` flips).
      // Maps 1:1 onto the condition-ANCHOR branch (runtime.wait_for_condition).
      const timeoutMs = action.timeoutMs ?? this.defaultAnchorTimeoutMs;
      const result = await this.op(
        "runtime.wait_for_condition",
        { ...conditionParams(action), playMode: "playing", timeoutMs },
        timeoutMs + 5000,
      );
      if ("error" in result) return { ok: false, detail: result.error };
      return result.data.passed === true
        ? { ok: true }
        : { ok: false, detail: stringifyActual(result.data.actual) };
    }

    if (action.do === "world-tap") {
      // A non-uGUI target the game resolves from `Pointer.current` + its own raycast
      // (the EventSystem dispatch can't actuate it). Resolve the target's CURRENT
      // screen-space center, then drive a simulated Input System pointer tap there.
      //
      // OPEN THE SESSION FIRST. A one-shot `input.pointer_tap` is delivered only to a
      // FOCUSED Game View, because it has no end_session to restore the focus-independent
      // InputSystem overrides it would otherwise have to leak. A session DOES own that
      // restore, so opening one before the tap is what makes an unfocused world tap land at
      // all, and a replay is precisely the case that runs while a human is looking at
      // something else. A project with no Input System still blocked-degrades honestly here,
      // exactly as it did when the tap itself was the thing that discovered it.
      const session = await this.ensureInputSession();
      if ("blocked" in session) return { ok: false, blocked: true, detail: session.detail };
      if ("error" in session) return { ok: false, detail: session.error };

      const resolved = await this.resolveWorldScreenPoint(action.locator);
      if ("error" in resolved) return { ok: false, detail: resolved.error };

      const tap = await this.op("input.pointer_tap", { x: resolved.x, y: resolved.y });
      if ("error" in tap) {
        const focusLost = isFocusLost(tap);
        if (focusLost) return focusLostBlock(tap.error);
        // Simulated pointer unavailable (legacy-only project) → honest BLOCKED, keyed
        // on the stable error CODE (message as a fallback). Any other error is a fail.
        const unavailable =
          tap.code === "INPUT_BACKEND_UNAVAILABLE" ||
          /Input System is not enabled|Simulated pointer unavailable/i.test(tap.error);
        return unavailable ? { ok: false, blocked: true, detail: tap.error } : { ok: false, detail: tap.error };
      }
      if (tap.data.dispatched !== true) {
        return { ok: false, detail: `world-tap ${action.locator.path}: pointer not dispatched` };
      }
      return { ok: true };
    }

    if (action.do === "key-tap" || action.do === "key-hold") {
      // Gameplay keyboard via the SIMULATED Input System keyboard. Lazily open an
      // input session (on the InputSystem backend — the only one that drives
      // gameplay input); a legacy-only project blocked-degrades, never a silent
      // pass. The session is closed in teardown().
      const session = await this.ensureInputSession();
      if ("blocked" in session) return { ok: false, blocked: true, detail: session.detail };
      if ("error" in session) return { ok: false, detail: session.error };

      // No silent no-op on a bad key: the bridge VALIDATES the key name (and its
      // KeyCode→InputSystem.Key mapping) and returns INVALID_KEY for an unknown or
      // unmappable name — verified live for both a typo and a non-keyboard KeyCode
      // (e.g. "Mouse0"). That op error surfaces here as a `fail`, so an unresolvable
      // key can't pass with nothing injected. (A VALID key the game merely ignores
      // is a genuine drive — the outcome assertion, not this layer, catches that.)
      if (action.do === "key-tap") {
        const tap = await this.op("input.key_tap", { key: action.key });
        if ("error" in tap) {
          return isFocusLost(tap) ? focusLostBlock(tap.error) : { ok: false, detail: tap.error };
        }
        return { ok: true };
      }
      // key-hold: press, hold for the real wall-clock duration (so the game's
      // Update/FixedUpdate advance under the held key), then release. If the
      // release op fails, teardown's end_session still releases all held keys.
      const down = await this.op("input.key_down", { key: action.key });
      if ("error" in down) {
        return isFocusLost(down) ? focusLostBlock(down.error) : { ok: false, detail: down.error };
      }
      await delay(action.durationMs);
      const up = await this.op("input.key_up", { key: action.key });
      if ("error" in up) {
        return isFocusLost(up) ? focusLostBlock(up.error) : { ok: false, detail: up.error };
      }
      return { ok: true };
    }

    if (action.do === "key-down" || action.do === "key-up") {
      // The recorder's low-level edges: press / release a key WITHOUT the bundled
      // delay of key-hold, so concurrent holds (D held while Space taps) reproduce.
      // Same lazy session + blocked-degrade + INVALID_KEY-as-fail rules as key-tap.
      // A still-held key at the end is released by teardown's end_session.
      const session = await this.ensureInputSession();
      if ("blocked" in session) return { ok: false, blocked: true, detail: session.detail };
      if ("error" in session) return { ok: false, detail: session.error };

      const op = action.do === "key-down" ? "input.key_down" : "input.key_up";
      const result = await this.op(op, { key: action.key });
      if ("error" in result) {
        return isFocusLost(result) ? focusLostBlock(result.error) : { ok: false, detail: result.error };
      }
      return { ok: true };
    }

    if (action.do === "wait") {
      // A pure wall-clock delay between recorded edges — no input, no session. A key
      // held by an earlier key-down stays held (the pump re-queues it each frame), so
      // the game advances under it for the recorded duration.
      await delay(action.durationMs);
      return { ok: true };
    }

    let params: Record<string, unknown>;
    if (action.do === "drag") {
      try {
        params = await this.dragParams(action);
      } catch (error) {
        // A viewport fetch needed to denormalize a releaseNorm drag failed: a transport
        // loss rethrows (harness fault), any other bridge/shape error is a clean action
        // failure (never a silent release at (0,0)).
        if (isConnectionError(error)) throw error;
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    } else {
      params = { action: "click", locator: action.locator };
    }

    // An op-level error (e.g. the locator no longer resolves — a renamed/removed
    // element) is a clean action failure, not a crash; transport errors rethrow.
    const result = await this.op("ui.dispatch_pointer", params);
    if ("error" in result) return { ok: false, detail: result.error };
    const actuated = result.data.actuated === true;
    // Capture the verbatim actuation evidence (used by `minigame capture` to build an
    // honest flow.json); the engine ignores it.
    const d = result.data as Record<string, unknown>;
    const raw = {
      actuated,
      // The bridge reports `handlerTarget` as a LOCATOR OBJECT ({scene,path,instanceId,
      // globalObjectId}) — extract its `.path`. (The earlier `typeof === "string"` guard
      // matched neither, silently dropping it, so flow.json had no handlerTarget at all.)
      // `raycastHit` is a BOOLEAN (did the ray hit a graphic), NOT a target path.
      handlerTarget: locatorPath(d.handlerTarget),
      raycastHit: typeof d.raycastHit === "boolean" ? d.raycastHit : undefined,
      handlersFired: Array.isArray(d.handlersFired) ? (d.handlersFired as string[]) : undefined,
    };
    return actuated
      ? { ok: true, raw }
      : { ok: false, detail: `not actuated (raycastHit=${result.data.raycastHit ?? false})`, raw };
  }

  async waitForAnchor(anchor: Anchor): Promise<AnchorResult> {
    const timeoutMs = anchor.timeoutMs ?? this.defaultAnchorTimeoutMs;
    if (anchor.kind === "ui-visible") {
      return this.pollVisible(anchor.locator, timeoutMs);
    }
    // condition anchor → wait_for_condition
    const result = await this.op(
      "runtime.wait_for_condition",
      { ...conditionParams(anchor), playMode: "playing", timeoutMs },
      timeoutMs + 5000,
    );
    if ("error" in result) return { reached: false, actual: result.error };
    return result.data.passed === true
      ? { reached: true }
      : { reached: false, actual: stringifyActual(result.data.actual) };
  }

  async confirmReached(
    cond: MinigameReachedCondition,
    timeoutMs: number,
  ): Promise<{ reached: boolean; actual?: string }> {
    const result = await this.op(
      "runtime.wait_for_condition",
      { ...conditionParams({ ...cond, locator: parseContractLocator(cond.locator) }), playMode: "playing", timeoutMs },
      timeoutMs + 5000,
    );
    if ("error" in result) return { reached: false, actual: result.error };
    return result.data.passed === true
      ? { reached: true }
      : { reached: false, actual: stringifyActual(result.data.actual) };
  }

  async capture(id: string, settleMs?: number): Promise<CaptureOutcome> {
    if (this.alignedCaptureFps !== undefined) {
      return this.alignedCapture(id, settleMs, this.alignedCaptureFps);
    }
    // Let the resulting screen settle (spawn/fall/transition animations) before the
    // screenshot, so the artifact isn't a mid-animation frame. Bounded by the trace.
    if (settleMs && settleMs > 0) await delay(settleMs);
    // The bridge returns `image_base64` (the MCP server normally writes the file
    // for `outputPath`, but this driver talks straight to the bridge). So decode
    // and write it here, and report an artifact ONLY if an image actually came
    // back — never a path that was not written.
    const result = await this.op("editor.screenshot", { view: "game", format: "png" }, 15000);
    if ("error" in result) return {};
    const base64 = result.data.image_base64;
    if (typeof base64 !== "string" || base64.length === 0) return {};
    return this.writeCaptureBytes(id, base64);
  }

  /**
   * THE ALIGNED SEAM. The wall-clock pair (sleep here, screenshot there) becomes ONE bridge
   * call: the settle runs inside a single tick loop with the game-time step pinned, and the
   * frame is taken on the exact frame the settle completes.
   *
   * The wire timeout is stated AT THE CALL rather than left to `defaultTimeoutMs`: this
   * driver talks straight to the bridge and never passes through `resolveOpTimeoutMs`, so
   * nothing else would widen the default for a long settle. It is the settle's own wall cost
   * plus 15s, which sits comfortably above the bridge's own budget (the settle plus 8s).
   * The DEADLINE that decides the outcome must be the bridge's honest one, never this timer
   * firing first and turning a measurable harness fault into an anonymous timeout.
   */
  private async alignedCapture(
    id: string,
    settleMs: number | undefined,
    fps: number,
  ): Promise<CaptureOutcome> {
    const settleFrames = alignedSettleFrames(settleMs, fps);
    const timeoutMs = (settleFrames / fps) * 1000 + 15000;
    const result = await this.op(
      "replay.settle_and_capture",
      { settleFrames, captureFps: fps, format: "png", view: "game" },
      timeoutMs,
    );
    if ("error" in result) {
      // NEVER A SILENT MISSING CAPTURE. The bridge refuses to return a frame it could not
      // place in game time (a starved editor, an interrupted settle), and that refusal is
      // harness evidence: it rides back so the run is tiered 2, not graded as drift and not
      // dropped from the report.
      return { harnessFault: `aligned settle failed for capture "${id}": ${result.error}` };
    }
    const base64 = result.data.image_base64;
    if (typeof base64 !== "string" || base64.length === 0) {
      return { harnessFault: `aligned settle for capture "${id}" returned no image` };
    }
    this.maybeWarnPhysicsCadence(fps, result.data.fixedDeltaTime);
    const framesElapsed =
      typeof result.data.framesElapsed === "number" ? result.data.framesElapsed : undefined;
    return { ...(await this.writeCaptureBytes(id, base64)), ...(framesElapsed !== undefined ? { framesElapsed } : {}) };
  }

  /** Decode + write one capture's bytes and report the path it really wrote. */
  private async writeCaptureBytes(id: string, base64: string): Promise<CaptureOutcome> {
    const bytes = Buffer.from(base64, "base64");
    const outputPath = `${this.captureDir}/${id}.png`;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { artifact: outputPath, sha256 };
  }

  /**
   * ADVISORY, NEVER A REFUSAL (S3). When 1/fps does not line up with the project's physics
   * step, the game still runs: it just steps physics an uneven number of times per rendered
   * frame, which a feel-sensitive trace can notice. Refusing here would block a legitimate
   * replay over a cadence the operator may well accept; saying nothing would let a changed
   * feel look like drift. So: print it once, from the project's REAL `fixedDeltaTime` as
   * reported by the bridge, never from an assumed 0.02.
   */
  private maybeWarnPhysicsCadence(fps: number, fixedDeltaTime: unknown): void {
    if (this.cadenceNoticePrinted) return;
    if (typeof fixedDeltaTime !== "number" || !Number.isFinite(fixedDeltaTime) || fixedDeltaTime <= 0) {
      return;
    }
    this.cadenceNoticePrinted = true;
    const note = physicsCadenceNote(fps, fixedDeltaTime);
    if (note) console.error(`[loombridge trace] ${note}`);
  }

  async evaluateAssertion(assertion: Assertion): Promise<AssertionOutcome> {
    const result = await this.op("runtime.assert_condition", conditionParams(assertion), 10000);
    if ("error" in result) return { pass: false, actual: result.error };
    return {
      pass: result.data.passed === true,
      actual: stringifyActual(result.data.actual),
    };
  }

  async readConsole(): Promise<ConsoleOutcome> {
    const data = this.data(
      await this.send("editor.console_logs", { count: 200 }),
      "editor.console_logs",
    );
    const logs = Array.isArray(data.logs) ? (data.logs as Array<Record<string, unknown>>) : [];
    const errors = logs
      .filter((log) => typeof log.type === "string" && this.errorLogTypes.has(log.type))
      .map((log) => (typeof log.message === "string" ? log.message : String(log.message)));
    return { errorCount: errors.length, errors };
  }

  /**
   * Full-scene UI dump (`ui.get_screen_rects` with NO locators → every loaded UI
   * graphic, with real path/role/text/visibility). Used by `minigame capture` to
   * snapshot a state's layout; throws on a bridge error (the caller fails the state).
   */
  async dumpScreenRects(): Promise<Record<string, unknown>> {
    const result = await this.op("ui.get_screen_rects", {}, 15000);
    if ("error" in result) throw new Error(`ui.get_screen_rects failed: ${result.error}`);
    return result.data;
  }

  async teardown(): Promise<void> {
    // Close the keyboard input session if we opened one (releasing any still-held
    // key). Best-effort: a failed end_session must not surface as a run error —
    // a Play-Mode reset would also reclaim the session — and the engine calls this
    // in a `finally`, swallowing throws.
    this.stopKeepalive();
    if (this.inputSession !== "open") return;
    this.inputSession = "none";
    this.inputSessionId = undefined;
    await this.trySend("input.end_session", {});
  }

  /**
   * Ping `input.keepalive` on a timer while a session is open — the bridge reclaims
   * an input session with HELD KEYS after a 30s idle (only the op-layer wires a
   * keepalive lease, which this driver bypasses by sending ops directly). Without
   * this, a key held across long/cumulative `wait`s is released mid-replay and the
   * run silently diverges. Best-effort: a dropped ping just retries next tick.
   */
  private startKeepalive(): void {
    if (this.keepaliveTimer || !this.inputSessionId) return;
    const sessionId = this.inputSessionId;
    this.keepaliveTimer = setInterval(() => {
      void this.trySend("input.keepalive", { sessionId });
    }, this.keepaliveIntervalMs);
    // Don't let the heartbeat keep the process alive on its own.
    (this.keepaliveTimer as { unref?: () => void }).unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  // ───────────────────────────── internals ─────────────────────────────

  /**
   * Build the `ui.dispatch_pointer` params for a drag.
   * - No `releaseNorm` ⇒ params are byte-identical to the legacy form (`to_locator`,
   *   optional `travelPx`) — regression-safe.
   * - With `releaseNorm` ⇒ release at a RAW screen point instead of a raycast element:
   *   denormalize against the LIVE viewport (fetched + cached once per drive) and pass
   *   `to_x`/`to_y` in place of `to_locator`. `travelPx` still rides along when set.
   */
  private async dragParams(
    action: Extract<Action, { do: "drag" }>,
  ): Promise<Record<string, unknown>> {
    // Rescale travel per device. travelPx is ABSOLUTE screen px recorded at a known
    // record-time height; the game converts screen-travel→progress by dividing by the
    // canvas scale factor (∝ screen height), so the SAME px under-shoots on a taller
    // viewport (the multi-aspect re-drive). Multiply by deviceHeight / recordHeight to
    // reproduce the same on-canvas travel. Absent travelRefHeight ⇒ pass raw (legacy).
    let travel: Record<string, unknown> = {};
    if (action.travelPx !== undefined) {
      let px = action.travelPx;
      if (action.travelRefHeight !== undefined && action.travelRefHeight > 0) {
        const vp = await this.getViewport();
        px = action.travelPx * (vp.height / action.travelRefHeight);
      }
      travel = { travelPx: px };
    }
    if (action.releaseNorm) {
      const vp = await this.getViewport();
      return {
        action: "drag",
        locator: action.from,
        to_x: action.releaseNorm.x * vp.width,
        to_y: action.releaseNorm.y * vp.height,
        ...travel,
      };
    }
    return { action: "drag", locator: action.from, to_locator: action.to, ...travel };
  }

  /**
   * The live viewport (px), fetched once per drive from `ui.get_screen_rects`
   * (`{ viewport: { width, height, aspect } }`) and cached — a denormalize target for
   * a `releaseNorm` drag. Throws if the bridge returns no usable viewport (rather than
   * silently releasing at (0,0)); the dispatch surfaces that as a clean action failure.
   */
  private async getViewport(): Promise<{ width: number; height: number }> {
    if (this.viewport) return this.viewport;
    const result = await this.op("ui.get_screen_rects", {});
    if ("error" in result) throw new Error(result.error);
    const vp = result.data.viewport as { width?: unknown; height?: unknown } | undefined;
    const width = vp?.width;
    const height = vp?.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("ui.get_screen_rects returned no usable viewport (cannot denormalize release point)");
    }
    this.viewport = { width, height };
    return this.viewport;
  }

  /**
   * The live Game view size for a RECORDER to write onto the trace, or `null` when the
   * editor could not state one.
   *
   * NULL RATHER THAN A THROW, and that asymmetry with {@link getViewport} is the point. A
   * drag that needs to denormalize a release point has no honest fallback, so it throws and
   * the dispatch fails. A recording does: the viewport is PROVENANCE on the trace, the
   * pixel gate re-derives the real sizes from the decoded frames either way, and a
   * demonstration a human just performed once must never be thrown away because a
   * screen-rects round trip came back empty. Absent is already the back-compatible reading.
   *
   * ROUNDED TO WHOLE PIXELS, because the bridge reports the viewport as floats and a frame
   * is an integer number of pixels. A stamped `1920.0000001` would print as an unfamiliar
   * number in a resolution sentence and would be refused by the trace parser.
   */
  async recordedViewport(): Promise<{ width: number; height: number } | null> {
    try {
      const vp = await this.getViewport();
      const width = Math.round(vp.width);
      const height = Math.round(vp.height);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch {
      return null;
    }
  }

  /**
   * Lazily open an input session on the InputSystem backend (the ONLY backend that
   * injects gameplay keys — EditorEvent reaches IMGUI/uGUI only). Returns `blocked`
   * (latched) when the Input System is unavailable (a legacy-only project) or an
   * existing session is on a non-gameplay backend, so keyboard actions degrade
   * honestly instead of silently injecting nothing. Result shapes mirror dispatch:
   * `{ ok }` | `{ blocked, detail }` | `{ error }`.
   *
   * WORLD TAPS OPEN IT TOO (S5), not just keys. The session's backend applies the
   * focus-independent InputSystem overrides and owns restoring them at `end_session`, which
   * is what lets a simulated pointer tap reach an UNFOCUSED Game View; a one-shot tap has no
   * such owner and is refused when unfocused. Same session, same lifecycle, one open per
   * drive.
   */
  private async ensureInputSession(): Promise<
    { ok: true } | { blocked: true; detail: string } | { error: string }
  > {
    if (this.inputSession === "open") return { ok: true };
    if (this.inputSession === "unavailable") {
      return { blocked: true, detail: this.inputSessionBlockDetail };
    }

    const begun = await this.op("input.begin_session", { backend: "InputSystem" });
    if ("error" in begun) {
      // A missing/disabled Input System is a capability gap → blocked, keyed on the
      // stable error CODES (message as a fallback). Anything else is a real failure.
      const unavailable =
        begun.code === "INPUT_SYSTEM_NOT_INSTALLED" ||
        begun.code === "INPUT_BACKEND_UNAVAILABLE" ||
        begun.code === "INPUT_CAPABILITY_BLOCKED" ||
        /Input System|input backend|input capability/i.test(begun.error);
      if (unavailable) {
        this.inputSession = "unavailable";
        this.inputSessionBlockDetail = begun.error;
        return { blocked: true, detail: begun.error };
      }
      return { error: begun.error };
    }

    // Guard a silent non-gameplay backend: if a session already existed on
    // EditorEvent (created:false), keys would inject nothing — block honestly.
    if (begun.data.backend !== "InputSystem") {
      this.inputSession = "unavailable";
      this.inputSessionBlockDetail = `input session is on backend '${begun.data.backend}', which cannot inject gameplay keys (needs InputSystem)`;
      return { blocked: true, detail: this.inputSessionBlockDetail };
    }

    this.inputSession = "open";
    this.inputSessionId =
      typeof begun.data.sessionId === "string" ? begun.data.sessionId : undefined;
    this.startKeepalive();
    return { ok: true };
  }

  /** Poll ui.get_screen_rects until the locator is visible or the deadline passes. */
  private async pollVisible(locator: Locator, timeoutMs: number): Promise<AnchorResult> {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "not observed";
    for (;;) {
      const visible = await this.queryVisible(locator);
      if (visible.isVisible) return { reached: true };
      lastReason = visible.reason ?? "hidden";
      if (Date.now() >= deadline) return { reached: false, actual: lastReason };
      await delay(this.pollIntervalMs);
    }
  }

  private async queryVisible(
    locator: Locator,
  ): Promise<{ isVisible: boolean; reason?: string }> {
    const result = await this.op("ui.get_screen_rects", { locators: [locator] });
    if ("error" in result) return { isVisible: false, reason: result.error };
    const objects = Array.isArray(result.data.objects)
      ? (result.data.objects as Array<Record<string, unknown>>)
      : [];
    const obj = objects[0];
    if (!obj) return { isVisible: false, reason: "not-found" };
    // A locator that fails to resolve comes back as { locator, error } with no
    // isVisible — surface that precise reason rather than a generic "hidden".
    const reason =
      typeof obj.error === "string"
        ? obj.error
        : typeof obj.visibilityReason === "string"
          ? obj.visibilityReason
          : undefined;
    // The uGUI hit-target pattern: a handler target whose OWN Image is alpha-0 (or
    // disabled) with the visible art on child objects. The recorder anchors on the
    // handler target, so a strict own-graphic rule fails an anchor the player can
    // plainly see and tap (live case: KidsAdventure's hub tiles). The bridge reports
    // `descendantVisible` for exactly these two reasons; accept it as anchor-visible.
    // Every other failure (inactive, canvas-disabled, off-screen, zero-size, and
    // transparent WITHOUT visible child art) stays a refusal.
    if (
      obj.isVisible !== true &&
      (reason === "graphic-transparent" || reason === "graphic-disabled") &&
      obj.descendantVisible === true
    ) {
      return { isVisible: true };
    }
    // The bare invisible gesture catcher: an alpha-0, SPRITE-LESS Image whose whole job
    // is to receive drags/taps (live case: KidsChef's MixZone stir surface; its visible
    // cues, bowl and whisk, are SIBLINGS, so descendantVisible is honestly false). Such
    // an element was never going to be "visible"; the recorded gesture actuated on it,
    // and the honest anchor question is "is the catcher ready to receive input": active
    // (else reason is `inactive`), unhidden by canvas/CanvasGroup (else those reasons),
    // ON-screen, and raycastable. Transparent-only: a DISABLED graphic does not raycast,
    // so it can never be "ready". An element WITH a sprite is real art fading out, not a
    // catcher; it stays a refusal. Phase-readiness is the state gates' job, not this
    // anchor's. `descendantVisible === false` also pins the bridge to one that emits the
    // field: on an older bridge nothing is relaxed.
    if (
      obj.isVisible !== true &&
      reason === "graphic-transparent" &&
      obj.descendantVisible === false &&
      obj.raycastTarget === true &&
      obj.isOffScreen !== true &&
      obj.spriteName == null
    ) {
      return { isVisible: true };
    }
    return { isVisible: obj.isVisible === true, reason };
  }

  /**
   * Run an op, returning its `data`. An op-LEVEL error (the handler returned a
   * BridgeException, e.g. a locator that no longer resolves) becomes a clean
   * `{ error }` so the engine reports a divergence; a TRANSPORT error
   * (connection lost) rethrows, since that is a harness failure, not a game one.
   */
  /**
   * Resolve a world-space target's CURRENT screen-center px (bottom-left, matching
   * input.pointer_tap). Collider bounds match what a Physics2D.OverlapPoint game
   * raycasts; falls back to renderer bounds for a colliderless-but-tappable target.
   * Returns an error for an unresolved (ephemeral), off-screen, or degenerate target.
   */
  private async resolveWorldScreenPoint(
    locator: Locator,
  ): Promise<{ x: number; y: number } | { error: string }> {
    type Rect = { x: number; y: number; width: number; height: number };
    type Read =
      | { error: string }
      | { rect: Rect | null; offScreen: boolean; viewport?: { width?: number; height?: number } };

    const read = async (boundsMode: string): Promise<Read> => {
      const rects = await this.op("scene.get_screen_rects", { locators: [locator], boundsMode });
      if ("error" in rects) return { error: rects.error };
      const obj = (rects.data.objects as Array<Record<string, unknown>> | undefined)?.[0];
      return {
        rect: (obj?.screenRect as Rect | null | undefined) ?? null,
        offScreen: obj?.isOffScreen === true,
        viewport: rects.data.viewport as { width?: number; height?: number } | undefined,
      };
    };

    const collider = await read("collider");
    if ("error" in collider) return collider;
    // collider bounds match a Physics2D.OverlapPoint game; fall back to renderer
    // bounds for a colliderless-but-tappable target.
    const found: Read = collider.rect ? collider : await read("renderer");
    if ("error" in found) return found;

    if (!found.rect) {
      return { error: `world-tap ${locator.path}: no screen bounds (not found / not rendered)` };
    }
    if (found.offScreen) return { error: `world-tap ${locator.path}: off-screen` };

    const { x: rx, y: ry, width: w, height: h } = found.rect;
    if (![rx, ry, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
      return { error: `world-tap ${locator.path}: degenerate screen bounds ${JSON.stringify(found.rect)}` };
    }

    const x = rx + w / 2;
    const y = ry + h / 2;
    const vp = found.viewport;
    if (vp?.width && vp?.height && (x < 0 || y < 0 || x > vp.width || y > vp.height)) {
      return { error: `world-tap ${locator.path}: center (${x.toFixed(0)},${y.toFixed(0)}) outside viewport` };
    }
    return { x, y };
  }

  private async op(
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ data: Record<string, unknown> } | { error: string; code?: string }> {
    try {
      return { data: this.data(await this.send(command, params, timeoutMs), command) };
    } catch (error) {
      if (isConnectionError(error)) throw error;
      return {
        error: error instanceof Error ? error.message : String(error),
        code: (error as { bridgeCode?: string }).bridgeCode,
      };
    }
  }

  /** Unwrap a BridgeResponse, throwing on bridge error (caught by `op`). */
  private data(response: BridgeResponse, command: string): Record<string, unknown> {
    if (response.status === "error") {
      const error = new Error(
        `${command} failed: ${response.error?.message ?? "unknown bridge error"}`,
      );
      // Carry the bridge error CODE so callers can branch on the stable contract
      // (e.g. INPUT_BACKEND_UNAVAILABLE → blocked) rather than a prose message.
      (error as { bridgeCode?: string }).bridgeCode = response.error?.code;
      throw error;
    }
    return (response.data ?? {}) as Record<string, unknown>;
  }

  /** Send and swallow errors (best-effort, e.g. stopping an already-stopped editor). */
  private async trySend(command: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.send(command, params);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Is this op error the bridge refusing to deliver input to an UNFOCUSED Game View?
 *
 * Keyed on the stable error CODE, with the message only as a fallback for an older bridge.
 * The distinction it carries is the whole point: the capability is present and the project
 * supports it, so this is the MACHINE not being in a state to deliver the input.
 */
function isFocusLost(error: { error: string; code?: string }): boolean {
  return error.code === "FOCUS_REQUIRED" || /Game[- ]View focus/i.test(error.error);
}

/**
 * A focus loss is BLOCKED with its own reason, never an action failure (S5).
 *
 * As an action failure it read as a game divergence: the report would say the game did not
 * respond to a tap, when what actually happened is that a human clicked away from the editor
 * (or a modal stole focus) and the bridge honestly refused to pretend the tap landed. The
 * blocked tier says "this run could not be driven", which is the true statement, and
 * `focus-lost` says which harness condition caused it.
 */
function focusLostBlock(detail: string): DispatchResult {
  return { ok: false, blocked: true, blockedReason: "focus-lost", detail };
}

function conditionParams(spec: ConditionSpec): Record<string, unknown> {
  return {
    locator: spec.locator,
    component: spec.component,
    property_path: spec.property_path,
    operator: spec.operator,
    expected: spec.expected,
    tolerance: spec.tolerance,
  };
}

function parseContractLocator(locator: string): Locator {
  const colon = locator.indexOf(":");
  if (colon < 0) return { path: locator };
  return { scene: locator.slice(0, colon), path: locator.slice(colon + 1) };
}

/**
 * The bridge reports a target (`handlerTarget`) as a locator OBJECT
 * `{ scene, path, instanceId, globalObjectId }` (LocatorResolver.BuildLocator). Extract
 * its hierarchy `path`; tolerate a bare string for forward/backward compatibility.
 */
function locatorPath(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (v && typeof v === "object") {
    const p = (v as { path?: unknown }).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost/i.test(
    message,
  );
}

function stringifyActual(actual: unknown): string {
  if (actual === undefined) return "undefined";
  if (typeof actual === "string") return actual;
  return JSON.stringify(actual);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
