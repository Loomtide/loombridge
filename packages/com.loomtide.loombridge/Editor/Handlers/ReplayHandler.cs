using System;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Replay-verification ops. Today this category owns exactly one op,
    /// <c>replay.settle_and_capture</c>: the CAPTURE-ALIGNED settle.
    ///
    /// WHY IT EXISTS. A replay's capture settle used to be a wall-clock sleep in the
    /// driver (setTimeout, then editor.screenshot). Between those two calls the game
    /// free-runs at whatever rate the editor happens to tick, so the GAME TIME at which
    /// the frame is taken varies run to run: animation phase skew that the pixel gate
    /// cannot distinguish from real drift. This op moves the whole settle inside ONE
    /// bridge-controlled tick loop with Time.captureDeltaTime pinned, and takes the
    /// screenshot IN-LOOP on the exact frame the settle completes
    /// (the runtime.capture_sequence precedent), so the capture lands at a
    /// deterministic game time.
    ///
    /// WHAT IT DOES NOT FIX, stated here because the honest residual belongs next to the
    /// mechanism: alignment fixes CLOCK-driven nondeterminism (Time.time, deltaTime,
    /// Animator). It cannot fix seed-driven nondeterminism (unseeded Random,
    /// autoRandomSeed particles) or realtime-driven animation (realtimeSinceStartup,
    /// DateTime, Stopwatch), and it does not align the windows OUTSIDE the settle (the
    /// driver's action round trips and its anchor polling).
    /// </summary>
    public class ReplayHandler : IOpHandler
    {
        /// <summary>
        /// Wall-clock slack over the settle's own game-time cost, checked EVERY tick. Same
        /// value and same reason as editor.tick: a stalled clock (Time.timeScale 0, a paused
        /// game) must not spin while holding global Time state.
        /// </summary>
        private const double RealtimeSlackSeconds = 8.0;

        /// <summary>Frame-count safety cap: a typo must not pin the editor for an hour.</summary>
        private const int MaxSettleFrames = 100000;

        /// <summary>Capture-rate sanity cap (the driver's own range is narrower, [10,120]).</summary>
        private const int MaxCaptureFps = 1000;

        public bool IsAsync(string opName)
        {
            return opName == "settle_and_capture";
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            throw new BridgeException(ErrorCodes.NOT_FOUND, $"Unknown replay op: '{opName}'");
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            if (opName != "settle_and_capture")
            {
                onError(new BridgeException(ErrorCodes.NOT_FOUND, $"Unknown async replay op: '{opName}'"));
                return;
            }

            HandleSettleAndCapture(parameters, respond, onError);
        }

        // Advance exactly `settleFrames` player-loop frames at a pinned 1/captureFps
        // game-time step, then capture the Game View ON THAT FRAME and return it.
        private void HandleSettleAndCapture(JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            int? settleFrames = parameters?.Value<int?>("settleFrames");
            int captureFps = parameters?.Value<int?>("captureFps") ?? 60;
            string format = parameters?.Value<string>("format") ?? "png";
            string view = parameters?.Value<string>("view") ?? "game";
            int maxWidth = parameters?.Value<int?>("maxWidth") ?? 1024;
            int quality = parameters?.Value<int?>("quality") ?? 75;

            // Validate first, so a malformed call is told why regardless of play state.
            if (!settleFrames.HasValue || settleFrames.Value <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "replay.settle_and_capture requires 'settleFrames' (an integer > 0): the number of " +
                    "pinned player-loop frames to advance before the capture."));
                return;
            }
            if (settleFrames.Value > MaxSettleFrames)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Parameter 'settleFrames' is {settleFrames.Value}, above the {MaxSettleFrames} cap."));
                return;
            }
            // captureFps 0 is NOT accepted here (unlike editor.tick, where 0 means "do not
            // pin"): an unpinned settle is exactly the nondeterminism this op exists to
            // remove, so accepting 0 would hand back an unaligned frame under an aligned name.
            if (captureFps <= 0 || captureFps > MaxCaptureFps)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Parameter 'captureFps' must be an integer in [1, {MaxCaptureFps}] (got {captureFps}); " +
                    "0 would leave the clock unpinned, which is the nondeterminism this op removes."));
                return;
            }
            if (format != "png" && format != "jpg" && format != "jpeg")
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Parameter 'format' must be 'png' or 'jpg' (got '{format}')."));
                return;
            }

            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "replay.settle_and_capture requires Play Mode (a stopped editor does not run the game loop). " +
                    "Call editor.play first."));
                return;
            }

            int targetFrames = settleFrames.Value;
            double realStart = EditorApplication.timeSinceStartup;
            double realBudgetSec = (double)targetFrames / captureFps + RealtimeSlackSeconds;

            // The canonical pin idiom (editor.tick): force the player loop to tick while the
            // editor is unfocused, and pin the game-time step so every frame of the settle
            // advances the same amount of game time. Both are restored on EVERY exit path.
            //
            // THE RESTORE TARGET COMES FROM ReplayCapturePin, NOT FROM THE LIVE VALUE. Reading
            // Time.captureDeltaTime here would be correct only if nothing had leaked a pin: an
            // editor that never ticked after a previous settle (the failure mode this op is
            // most exposed to) still holds THAT op's pinned value, so "restore what I found"
            // would restore the pollution and call it the original. Remember() restores any
            // leaked pin FIRST and hands back the true pre-pin values.
            ReplayCapturePin.Pinned pin = ReplayCapturePin.Remember();
            bool restoreRunInBackground = pin.RunInBackground;
            float restoreCaptureDeltaTime = pin.CaptureDeltaTime;
            Application.runInBackground = true;
            Time.captureDeltaTime = 1f / captureFps;

            EditorApplication.CallbackFunction tick = null;
            Action<PlayModeStateChange> onPlayModeChanged = null;
            AssemblyReloadEvents.AssemblyReloadCallback onBeforeReload = null;
            bool finished = false;
            // The count of EDITOR UPDATE ticks this settle consumed (the editor.tick
            // `advancedFrames` precedent, and the same quantity): in Play Mode each editor
            // update drives one player-loop frame, so it is the frame count in every case the
            // op accepts. It is reported so the caller can bind the aligned stamp to real
            // evidence rather than to the request it made.
            int advancedFrames = 0;
            // AX8: TAKEN BEFORE THE FIRST ADVANCE, so `settledMs` spans all `settleFrames`.
            // Latching it inside the first tick (the shape editor.tick uses, where it measures
            // a duration budget rather than reporting a settle) started the clock AFTER one
            // frame had already been stepped, so a 15-frame settle at 60 fps reported 233ms of
            // game time for the 250ms it really advanced: an off-by-one frame in the evidence
            // the report shows a human.
            double startTime = Time.timeAsDouble;
            // Keep any held input session alive across the settle, so a key held by the
            // replay is not reclaimed by the idle watchdog mid-capture.
            IDisposable keepAlive = null;

            Action cleanup = () =>
            {
                keepAlive?.Dispose();
                EditorApplication.update -= tick;
                if (onPlayModeChanged != null) EditorApplication.playModeStateChanged -= onPlayModeChanged;
                if (onBeforeReload != null) AssemblyReloadEvents.beforeAssemblyReload -= onBeforeReload;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
                // Drop the ownership marker LAST: while it is set, a bootstrap-time guard (or
                // the next settle) is entitled to restore these same values on our behalf, and
                // that is only safe until we have done it ourselves.
                ReplayCapturePin.Release();
            };

            // Interrupted mid-settle (play-mode exit or an imminent domain reload): the tick
            // closure is destroyed and cleanup() would never run. Time.captureDeltaTime is a
            // NATIVE global that play-exit/reload do NOT reset, so the editor would be left
            // pinned in capture mode. Restore eagerly and report exactly once.
            Action<string> interrupt = (reason) =>
            {
                if (finished) return;
                finished = true;
                cleanup();
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "replay.settle_and_capture interrupted mid-settle: " + reason +
                    " No frame was captured. HARNESS FAULT (capture tier): never a game defect and never drift."));
            };
            onPlayModeChanged = (change) =>
            {
                if (change == PlayModeStateChange.ExitingPlayMode ||
                    change == PlayModeStateChange.EnteredEditMode)
                    interrupt("Play Mode exited.");
            };
            onBeforeReload = () => interrupt("domain reload.");

            tick = () =>
            {
                if (finished) return;
                try
                {
                    // No start-time latch here: `startTime` was taken BEFORE the first advance
                    // (see its declaration). Latching on the first tick, which is the shape
                    // editor.tick uses for a duration budget, would drop one frame from every
                    // reported settle.
                    advancedFrames++;

                    // Wall-clock guard, checked EVERY tick: a starved or stalled editor must
                    // not spin holding global Time state.
                    bool realtimeExceeded =
                        (EditorApplication.timeSinceStartup - realStart) >= realBudgetSec;

                    if (advancedFrames < targetFrames && !realtimeExceeded) return;

                    finished = true;

                    if (realtimeExceeded && advancedFrames < targetFrames)
                    {
                        // A DEADLINE HIT IS AN ERROR, NOT A DEGRADED CAPTURE. The settle did not
                        // complete, so a frame taken here sits at an unknown game time and is not
                        // comparable evidence, and returning it would let a starved editor read as
                        // pixel drift. The caller marks this capture a harness fault.
                        double spent = EditorApplication.timeSinceStartup - realStart;
                        cleanup();
                        onError(new BridgeException(ErrorCodes.TIMEOUT,
                            $"replay.settle_and_capture hit its wall-clock budget ({realBudgetSec:0.##}s, spent " +
                            $"{spent:0.##}s) after {advancedFrames} of {targetFrames} settle frames at " +
                            $"{captureFps} fps: the editor did not tick fast enough (backgrounded/starved editor, " +
                            "a stalled game clock, or Time.timeScale 0). HARNESS FAULT (capture tier): a frame at " +
                            "the wrong game time is not comparable evidence, so no frame was returned. This is " +
                            "never a game defect and never drift."));
                        return;
                    }

                    // The settle completed: capture ON THIS FRAME, inside the loop, before the
                    // pin is released and before the editor can advance the game any further.
                    JObject shot = ScreenshotCapture.CaptureScreenshot(view, maxWidth, format, quality, null, null);
                    double settledMs = (Time.timeAsDouble - startTime) * 1000.0;
                    cleanup();

                    shot["framesElapsed"] = advancedFrames;
                    shot["settleFrames"] = targetFrames;
                    shot["captureFps"] = captureFps;
                    shot["settledMs"] = Math.Round(settledMs, 3);
                    // Always false on a successful response (a deadline hit is an ERROR above).
                    // Stated anyway so the field is present in the evidence rather than inferred.
                    shot["realtimeDeadlineHit"] = false;
                    // The project's real physics cadence, so the caller can say honestly whether
                    // 1/captureFps lines up with it instead of assuming Unity's 0.02 default.
                    shot["fixedDeltaTime"] = Time.fixedDeltaTime;
                    respond(shot);
                }
                catch (BridgeException bex)
                {
                    finished = true;
                    cleanup();
                    onError(bex);
                }
                catch (Exception ex)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "replay.settle_and_capture failed mid-settle: " + ex.Message, ex));
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.playModeStateChanged += onPlayModeChanged;
            AssemblyReloadEvents.beforeAssemblyReload += onBeforeReload;
            EditorApplication.update += tick;
        }
    }
    /// <summary>
    /// PIN OWNERSHIP FOR THE ALIGNED SETTLE, against a never-ticking editor.
    ///
    /// The failure this exists for: <c>replay.settle_and_capture</c> restores
    /// <c>Time.captureDeltaTime</c> and <c>Application.runInBackground</c> from a tick
    /// callback and from eager interrupt hooks, and all of those need the editor to keep
    /// running. An editor that stops ticking entirely (a modal dialog, a hard freeze, a
    /// process killed between the pin and the first tick) leaves both pinned, and
    /// <c>Time.captureDeltaTime</c> is a NATIVE global that neither play-exit nor a domain
    /// reload resets. The editor then renders as fast as it can, forever, and the next settle
    /// reads that polluted value as its own "original" and restores it at the end: the leak
    /// becomes permanent through the very code meant to undo it.
    ///
    /// So the pre-pin values live in <see cref="SessionState"/> (editor-session scoped, and
    /// survives a domain reload, which is exactly the lifetime of the leak) behind an OWNER
    /// MARKER, and there are two recoveries: the next op restores before it pins
    /// (<see cref="Remember"/>), and the bridge bootstrap restores at load
    /// (<see cref="RestoreLeakedPin"/>). Editor restart needs no recovery: these are runtime
    /// globals that come up fresh.
    ///
    /// Keys are namespaced under <c>Loombridge.</c>: SessionState is one flat editor-wide
    /// dictionary shared with Unity itself and every other package in the project.
    /// </summary>
    public static class ReplayCapturePin
    {
        private const string OwnerKey = "Loombridge.replay.settlePin.owned";
        private const string CaptureDeltaTimeKey = "Loombridge.replay.settlePin.captureDeltaTime";
        private const string RunInBackgroundKey = "Loombridge.replay.settlePin.runInBackground";

        /// <summary>The global Time/run state as it was BEFORE a settle pinned it.</summary>
        public struct Pinned
        {
            public float CaptureDeltaTime;
            public bool RunInBackground;
        }

        /// <summary>True while a settle claims ownership of the pinned globals.</summary>
        public static bool IsOwned => SessionState.GetBool(OwnerKey, false);

        /// <summary>
        /// Claim the pin and return the values to restore when the settle ends.
        ///
        /// RESTORES A LEAKED PIN FIRST. When the marker is already set, a previous settle
        /// never reached its cleanup, so the LIVE values are that op's pinned ones and the
        /// stored ones are the true originals: they are put back and handed on as this op's
        /// restore target. Without this the polluted clock would be recorded as the original
        /// and written back at the end of every subsequent settle.
        /// </summary>
        public static Pinned Remember()
        {
            if (IsOwned)
            {
                Pinned leaked = Stored();
                Time.captureDeltaTime = leaked.CaptureDeltaTime;
                Application.runInBackground = leaked.RunInBackground;
                Store(leaked);
                return leaked;
            }

            Pinned current = new Pinned
            {
                CaptureDeltaTime = Time.captureDeltaTime,
                RunInBackground = Application.runInBackground
            };
            Store(current);
            return current;
        }

        /// <summary>Drop the ownership marker (the caller has already restored the values).</summary>
        public static void Release()
        {
            SessionState.EraseBool(OwnerKey);
            SessionState.EraseFloat(CaptureDeltaTimeKey);
            SessionState.EraseBool(RunInBackgroundKey);
        }

        /// <summary>
        /// BOOTSTRAP-TIME RECOVERY: if a settle left the globals pinned, put them back and say
        /// so, exactly once. Returns true when it restored something, so the caller logs one
        /// line and nothing is announced on the overwhelmingly common clean boot.
        /// </summary>
        public static bool RestoreLeakedPin()
        {
            if (!IsOwned) return false;
            Pinned leaked = Stored();
            Time.captureDeltaTime = leaked.CaptureDeltaTime;
            Application.runInBackground = leaked.RunInBackground;
            Release();
            return true;
        }

        private static Pinned Stored()
        {
            return new Pinned
            {
                // 0 is Unity's own "not pinned" value for captureDeltaTime, so it is the safe
                // default for a marker whose payload somehow went missing: an unpinned editor
                // renders normally, which is the state a human expects to find.
                CaptureDeltaTime = SessionState.GetFloat(CaptureDeltaTimeKey, 0f),
                RunInBackground = SessionState.GetBool(RunInBackgroundKey, false)
            };
        }

        private static void Store(Pinned values)
        {
            SessionState.SetFloat(CaptureDeltaTimeKey, values.CaptureDeltaTime);
            SessionState.SetBool(RunInBackgroundKey, values.RunInBackground);
            SessionState.SetBool(OwnerKey, true);
        }
    }
}
