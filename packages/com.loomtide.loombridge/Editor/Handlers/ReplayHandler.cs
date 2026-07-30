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
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            Time.captureDeltaTime = 1f / captureFps;

            EditorApplication.CallbackFunction tick = null;
            Action<PlayModeStateChange> onPlayModeChanged = null;
            AssemblyReloadEvents.AssemblyReloadCallback onBeforeReload = null;
            bool finished = false;
            int advancedFrames = 0;
            double startTime = -1;
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
                    double now = Time.timeAsDouble;
                    if (startTime < 0) startTime = now;
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
}
