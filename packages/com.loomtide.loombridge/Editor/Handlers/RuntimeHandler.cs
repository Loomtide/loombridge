using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using UnityEngine.Playables;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles generic runtime state inspection and condition evaluation operations.
    /// </summary>
    public class RuntimeHandler : IOpHandler
    {
        private static readonly Regex PathSegmentRegex = new Regex(@"^([^\[\]]+)?(?:\[(\d+)\])?$");
        private const string ClassificationPass = "pass";
        private const string ClassificationFail = "fail";
        private const string AssertionFailureCode = "ASSERTION_FAILED";

        public bool IsAsync(string opName)
        {
            return opName == "wait_for_condition" || opName == "measure_motion" || opName == "probe" || opName == "capture_sequence" || opName == "capture_input_motion" || opName == "capture_pointer_motion" || opName == "capture_pointer_hold_motion" || opName == "sample_animator";
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "get_snapshot":
                    return HandleGetSnapshot(parameters);
                case "assert_condition":
                    return HandleAssertCondition(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown runtime op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            switch (opName)
            {
                case "wait_for_condition":
                    HandleWaitForCondition(parameters, respond, onError);
                    return;
                case "measure_motion":
                    HandleMeasureMotion(parameters, respond, onError);
                    return;
                case "probe":
                    HandleProbe(parameters, respond, onError);
                    return;
                case "capture_sequence":
                    HandleCaptureSequence(parameters, respond, onError);
                    return;
                case "capture_input_motion":
                    HandleCaptureInputMotion(parameters, respond, onError);
                    return;
                case "capture_pointer_motion":
                    HandleCapturePointerMotion(parameters, respond, onError);
                    return;
                case "capture_pointer_hold_motion":
                    HandleCapturePointerHoldMotion(parameters, respond, onError);
                    return;
                case "sample_animator":
                    HandleSampleAnimator(parameters, respond, onError);
                    return;
                default:
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Runtime op '{opName}' is not async."));
                    return;
            }
        }

        private JObject HandleGetSnapshot(JObject parameters)
        {
            JObject locator = RequireLocator(parameters);
            GameObject go = LocatorResolver.Resolve(locator);

            HashSet<string> componentFilters = ParseStringSet(parameters?.Value<JArray>("components"));
            string[] includePaths = ParseStringArray(parameters?.Value<JArray>("include_paths"));

            var componentSnapshots = new JArray();
            foreach (Component component in go.GetComponents<Component>())
            {
                if (component == null)
                    continue;

                Type componentType = component.GetType();
                if (!MatchesComponentFilter(componentFilters, componentType))
                    continue;

                JArray properties = PropertyIntrospector.DescribeProperties(component, null, includePaths);
                // RCL-T10: ALSO surface public C# properties (e.g. a `Health.Current { get; }` with no
                // [SerializeField]) so live state is observable without an author adding a serialized
                // field. Additive — serialized fields stay in `properties`; reflected getters go here.
                JArray runtimeProperties = PropertyIntrospector.DescribePublicProperties(component, null, includePaths);
                componentSnapshots.Add(new JObject
                {
                    ["type_name"] = componentType.Name,
                    ["full_type_name"] = componentType.FullName,
                    ["properties"] = properties,
                    ["runtimeProperties"] = runtimeProperties
                });
            }

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["name"] = go.name,
                ["scene"] = go.scene.name,
                ["activeSelf"] = go.activeSelf,
                ["activeInHierarchy"] = go.activeInHierarchy,
                ["tag"] = go.tag,
                ["layer"] = go.layer,
                ["transform"] = BuildTransformSnapshot(go.transform),
                ["components"] = componentSnapshots
            };
        }

        private JObject HandleAssertCondition(JObject parameters)
        {
            return EvaluateCondition(parameters);
        }

        private void HandleWaitForCondition(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            JObject waitParams = parameters?.DeepClone() as JObject ?? new JObject();

            // Fast path for already-satisfied conditions.
            JObject initial = EvaluateCondition(waitParams);
            if (initial.Value<bool>("passed"))
            {
                initial["waited_ms"] = 0;
                respond(initial);
                return;
            }

            long timeoutMs = waitParams.Value<long?>("timeoutMs") ?? 30000;
            if (timeoutMs <= 0)
            {
                onError(new BridgeException(
                    ErrorCodes.TIMEOUT,
                    "runtime.wait_for_condition deterministic timeout before polling (timeoutMs <= 0)."));
                return;
            }

            JObject waitCondition = BuildWaitCondition(waitParams);
            JObject lastEvaluation = initial;

            WaitEngine.WaitFor(
                waitCondition,
                () =>
                {
                    lastEvaluation = EvaluateCondition(waitParams);
                    return lastEvaluation.Value<bool>("passed");
                },
                () => lastEvaluation,
                () =>
                {
                    string op = waitParams.Value<string>("operator") ?? "equals";
                    string prop = waitParams.Value<string>("property_path") ?? "<missing>";
                    return $"runtime.wait_for_condition deterministic timeout for '{prop}' with operator '{op}'.";
                },
                respond,
                onError);
        }

        private void HandleMeasureMotion(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            JObject locator = RequireLocator(parameters);
            GameObject go = LocatorResolver.Resolve(locator);

            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "runtime.measure_motion requires Play Mode (motion is only meaningful while playing)."));
                return;
            }

            // Duration-based sampling keyed off game time, so the captured window is
            // independent of editor frame rate (which swings ~10fps unfocused to
            // hundreds focused). captureFps pins Time.captureDeltaTime during sampling
            // so each tick advances a fixed game-time step — deterministic and
            // high-resolution regardless of focus. captureFps=0 disables pinning.
            double durationMs = parameters?.Value<double?>("durationMs") ?? 1200.0;
            int captureFps = parameters?.Value<int?>("captureFps") ?? 120;
            // S5c-b: emit the raw trajectory + physics-timestep provenance so the
            // offline re-derivation (feel-rederive / verify --profile §0) can re-compute
            // each value and reject a tampered one. measure_motion pins only
            // Time.captureDeltaTime (render cadence), never Time.fixedDeltaTime
            // (physics) — so we OBSERVE the project's real physics rate and record it
            // unchanged; "before" and "measurement" are equal by construction.
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? false;
            // RCL-T07(b): the wall-clock cost of a measure is ~ (durationSec * captureFps) editor
            // update ticks running at the BACKGROUNDED editor's slow tick rate — which the dogfood
            // read as a fixed ~10s/call overhead. fastForward requests an extra player-loop tick per
            // editor update so the SAME fixed game-time window finishes in less wall-clock. The returned
            // trajectory stays honest — samples remain keyed off Time.timeAsDouble and metrics re-derive
            // from (t, position). HOWEVER, pumping an extra player-loop tick can advance game time
            // between samples and so coarsen/shift the sampling cadence vs a non-fastForward run, so the
            // DERIVED feel values are NOT guaranteed byte-identical. It is a best-effort iteration
            // speed-up — do NOT use it for a gate-bound feel capture (default off; response echoes it).
            bool fastForward = parameters?.Value<bool?>("fastForward") ?? false;
            float projectFixedTimestep = Time.fixedDeltaTime;
            if (durationMs <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'durationMs' must be > 0."));
                return;
            }
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'captureFps' must be >= 0 (0 disables capture-rate pinning)."));
                return;
            }

            double durationSec = durationMs / 1000.0;
            int maxSamples = 200000; // safety cap
            var samples = new List<MotionMetrics.Sample>(2048);

            // Play mode pauses simulation when the editor is unfocused (the default
            // Application.runInBackground = false). Since the bridge drives Unity from a
            // background process, force the game to keep simulating during measurement,
            // otherwise time/motion never advance (timeout) or only the clock advances
            // while game logic stays frozen (zero motion).
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;

            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = 1f / captureFps;

            EditorApplication.CallbackFunction sampleTick = null;
            Action<PlayModeStateChange> onPlayModeChanged = null;
            AssemblyReloadEvents.AssemblyReloadCallback onBeforeReload = null;
            bool finished = false;
            double startTime = -1;
            // Keep any held input session alive for the whole measure window so the 30s
            // idle watchdog doesn't release a held key mid-measurement (key_down →
            // measure_motion → key_up). Released in cleanup on every exit path.
            IDisposable keepAlive = null;

            Action cleanup = () =>
            {
                keepAlive?.Dispose();
                EditorApplication.update -= sampleTick;
                if (onPlayModeChanged != null) EditorApplication.playModeStateChanged -= onPlayModeChanged;
                if (onBeforeReload != null) AssemblyReloadEvents.beforeAssemblyReload -= onBeforeReload;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            // If the measure window is interrupted (play-mode exit or an imminent domain reload),
            // the tick closure is destroyed and cleanup() would never run — Time.captureDeltaTime
            // is a NATIVE global NOT reset by play-exit/reload, so the editor would be left pinned
            // in capture mode. Restore eagerly and report exactly once (same guard as editor.tick).
            Action<string> interrupt = (reason) =>
            {
                if (finished) return;
                finished = true;
                cleanup();
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "runtime.measure_motion interrupted mid-window: " + reason));
            };
            onPlayModeChanged = (change) =>
            {
                if (change == PlayModeStateChange.ExitingPlayMode ||
                    change == PlayModeStateChange.EnteredEditMode)
                    interrupt("Play Mode exited.");
            };
            onBeforeReload = () => interrupt("domain reload.");

            sampleTick = () =>
            {
                if (finished) return;

                // The target may be destroyed mid-flight (e.g. respawn/scene change).
                if (go == null)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        "Measured GameObject was destroyed during sampling."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;

                samples.Add(new MotionMetrics.Sample(now, go.transform.position, go.transform.eulerAngles));

                // RCL-T07(b): pump the player loop so the next editor update advances game time
                // sooner — shrinks wall-clock for the same game-time window without altering it.
                if (fastForward)
                    EditorApplication.QueuePlayerLoopUpdate();

                bool durationReached = (now - startTime) >= durationSec;
                if (durationReached || samples.Count >= maxSamples)
                {
                    finished = true;
                    cleanup();
                    try
                    {
                        JObject metrics = MotionMetrics.Compute(samples, includeSamples, projectFixedTimestep, Time.fixedDeltaTime);
                        metrics["fastForward"] = fastForward;
                        respond(metrics);
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"runtime.measure_motion metric computation failed: {ex.Message}", ex));
                    }
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.playModeStateChanged += onPlayModeChanged;
            AssemblyReloadEvents.beforeAssemblyReload += onBeforeReload;
            EditorApplication.update += sampleTick;
        }

        /// <summary>
        /// runtime.sample_animator — HONEST animation-progress verification. Motivating
        /// incident: an unfocused/headless editor advances physics but NOT Animator time even
        /// with runInBackground, so an agent could "verify" an animation from a STATIC pose
        /// that was actually frozen. This op samples the Animator across a real window and
        /// reports whether animator time actually advanced (time_advancing), whether any
        /// requested bone moved (bones_moving), and — critically — a `status` that names the
        /// frozen-unfocused case (blocked_unfocused) instead of laundering it into a false pass.
        ///
        /// Honesty invariants:
        ///  - Never reports time_advancing:true from a single sample or identical timestamps —
        ///    at most one sample is recorded per tick (each carries a distinct game-time stamp),
        ///    and a window with &lt;2 distinct samples is refused as "insufficient_samples".
        ///  - time_advancing is computed PER STATE (consecutive samples sharing a fullPathHash):
        ///    Unity's normalizedTime for a looping state is MONOTONIC (integer part = loop
        ///    count), so a negative delta never means "the loop wrapped" — it means a state
        ///    TRANSITION, and comparing normalizedTime across two different states proves
        ///    nothing about either. Only consecutive same-state samples count as evidence.
        ///  - bones_moving measures SKELETAL-LOCAL motion (localRotation + localPosition), not
        ///    root motion: a physics-driven root moving with a frozen animator changes every
        ///    bone's WORLD position, which is exactly the laundering this op exists to prevent.
        ///  - Edit mode (paused scene) is single-shot: it reports the pose with status
        ///    "edit_mode_static" and NEVER time_advancing (there is no window to advance over).
        ///  - blocked_culled is checked BEFORE blocked_unfocused: cullingMode=CullCompletely on
        ///    an offscreen renderer stops animator time entirely — a focus-INDEPENDENT freeze
        ///    that must not be blamed on focus (and that a focused editor would otherwise
        ///    launder into "ok").
        ///  - blocked_unfocused is only reported when the animator was actually EXPECTED to
        ///    advance (enabled + controller + speed != 0 + activeInHierarchy + isInitialized)
        ///    yet did not, AND the editor application is inactive — an honestly-idle animator
        ///    (paused / speed 0 / no controller / inactive GameObject) is "ok", not "blocked".
        ///    NOTE (batchmode): isApplicationActive is ALWAYS false under -batchmode, so there
        ///    blocked_unfocused just means "editor app inactive". The sampling loop pins
        ///    Time.captureDeltaTime, so game time DID advance across the window — a frozen
        ///    animator under pinned game time is strong evidence of the Animator-update
        ///    throttle regardless of what the focus flag says (status_note spells this out).
        ///
        /// Play-mode sampling reuses measure_motion's focus-independent machinery: force
        /// Application.runInBackground=true (best-effort) and pin Time.captureDeltaTime so game
        /// time advances deterministically per tick regardless of focus. If the animator STILL
        /// does not advance while unfocused, that is exactly the defect this op surfaces.
        /// </summary>
        private void HandleSampleAnimator(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            GameObject go;
            Animator animator;
            string[] bonePaths;
            Transform[] boneTransforms;
            try
            {
                JObject locator = RequireLocator(parameters);
                go = LocatorResolver.Resolve(locator);
                animator = go.GetComponent<Animator>();
                if (animator == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"runtime.sample_animator: GameObject '{go.name}' has no Animator component.");

                bonePaths = ParseStringArray(parameters?.Value<JArray>("bones")) ?? Array.Empty<string>();
                boneTransforms = new Transform[bonePaths.Length];
                for (int i = 0; i < bonePaths.Length; i++)
                    boneTransforms[i] = go.transform.Find(bonePaths[i]);
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            // Focus signal used to tell an honestly-idle animation from a FROZEN one.
            // UnityEditorInternal.InternalEditorUtility.isApplicationActive is the editor's
            // application-focus flag (true only when Unity is the foreground application). It is
            // the most direct "does the editor have OS focus" signal available to editor code;
            // when the editor is backgrounded the player loop's Animator update is throttled/
            // skipped, which is the freeze this op detects.
            bool editorHasFocus = InternalEditorUtility.isApplicationActive;

            JObject locatorStr = LocatorResolver.BuildLocator(go);

            // EDIT MODE: paused scene — a single-shot pose read. Never time_advancing (there is
            // no window to advance over); the agent gets the pose plus an explicit
            // edit_mode_static so it can never mistake a frozen edit-mode pose for animation.
            if (!EditorApplication.isPlaying)
            {
                AnimatorFrameSample frame = CaptureAnimatorFrame(animator, boneTransforms, 0.0);
                var editResult = new JObject
                {
                    ["locator"] = locatorStr,
                    ["status"] = "edit_mode_static",
                    ["time_advancing"] = false,
                    ["bones_moving"] = false,
                    ["playMode"] = false,
                    ["editorHasFocus"] = editorHasFocus,
                    ["animatorPlaying"] = false,
                    ["culling_mode"] = animator.cullingMode.ToString(),
                    ["active_in_hierarchy"] = go.activeInHierarchy,
                    ["is_initialized"] = animator.isInitialized,
                    ["requestedSamples"] = 1,
                    ["sampleCount"] = 1,
                    ["distinctTimeSamples"] = 1,
                    ["bones"] = BuildBoneResolutionArray(bonePaths, boneTransforms),
                    ["samples"] = new JArray { AnimatorFrameToJson(frame, bonePaths, 0.0) }
                };
                respond(editResult);
                return;
            }

            // PLAY MODE: sample across real frames. 'durationMs' matches measure_motion's
            // naming; 'duration_ms' stays accepted as an alias.
            double durationMs = parameters?.Value<double?>("durationMs")
                ?? parameters?.Value<double?>("duration_ms")
                ?? 500.0;
            int requestedSamples = parameters?.Value<int?>("samples") ?? 8;
            // The schema advertises captureFps as a number — read it as one (an int read would
            // silently truncate a fractional value).
            double captureFps = parameters?.Value<double?>("captureFps") ?? 60.0;
            if (durationMs <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'durationMs' must be > 0."));
                return;
            }
            if (durationMs > MaxSampleAnimatorDurationMs)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Parameter 'durationMs' must be <= {MaxSampleAnimatorDurationMs} — the op's transport timeout is 30000ms, so a longer window would time out before the response could be sent."));
                return;
            }
            if (requestedSamples < 2)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'samples' must be >= 2 (a single sample can never establish time_advancing)."));
                return;
            }
            if (captureFps < 0 || double.IsNaN(captureFps) || double.IsInfinity(captureFps))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'captureFps' must be a finite number >= 0 (0 disables capture-rate pinning)."));
                return;
            }

            double durationSec = durationMs / 1000.0;
            double interval = durationSec / (requestedSamples - 1);

            // Best-effort focus-independent sim advance (same lever as measure_motion). If the
            // animator STILL doesn't advance while unfocused, that IS the defect we surface.
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = (float)(1.0 / captureFps);

            var frames = new List<AnimatorFrameSample>(requestedSamples + 2);
            double startTime = -1;
            double nextSampleSec = 0;
            bool finished = false;
            EditorApplication.CallbackFunction tick = null;
            Action<PlayModeStateChange> onPlayModeChanged = null;
            AssemblyReloadEvents.AssemblyReloadCallback onBeforeReload = null;

            // Restore global Time/runInBackground state and detach every hook. Idempotent.
            Action cleanup = () =>
            {
                EditorApplication.update -= tick;
                if (onPlayModeChanged != null) EditorApplication.playModeStateChanged -= onPlayModeChanged;
                if (onBeforeReload != null) AssemblyReloadEvents.beforeAssemblyReload -= onBeforeReload;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            // If the window is interrupted (play-mode exit or an imminent domain reload), the
            // tick closure is destroyed and cleanup() would never run — Time.captureDeltaTime is
            // a NATIVE global NOT reset by play-exit/reload, so the editor would be left pinned
            // in capture mode. Restore eagerly and report exactly once (same guard as editor.tick).
            Action<string> interrupt = (reason) =>
            {
                if (finished) return;
                finished = true;
                cleanup();
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "runtime.sample_animator interrupted mid-window: " + reason));
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

                if (go == null || animator == null)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        "runtime.sample_animator: the sampled GameObject/Animator was destroyed during sampling."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsed = now - startTime;

                // At most ONE sample per tick, so every recorded sample carries a distinct
                // game-time stamp — identical timestamps can never prove advancement.
                if (frames.Count < requestedSamples && elapsed >= nextSampleSec - 1e-9)
                {
                    frames.Add(CaptureAnimatorFrame(animator, boneTransforms, now));
                    do { nextSampleSec += interval; }
                    while (nextSampleSec <= elapsed + 1e-9 && frames.Count < requestedSamples);
                }

                if (frames.Count >= requestedSamples || elapsed >= durationSec)
                {
                    finished = true;
                    cleanup();
                    try
                    {
                        respond(BuildSampleAnimatorResult(frames, bonePaths, boneTransforms, locatorStr, go, animator, editorHasFocus, requestedSamples));
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"runtime.sample_animator result computation failed: {ex.Message}", ex));
                    }
                }
            };

            EditorApplication.playModeStateChanged += onPlayModeChanged;
            AssemblyReloadEvents.beforeAssemblyReload += onBeforeReload;
            EditorApplication.update += tick;
        }

        /// <summary>
        /// One captured Animator frame: state info, graph-playing, and per-bone LOCAL pose
        /// (BonePositions holds localPosition — skeletal-local motion, never root motion).
        /// </summary>
        private struct AnimatorFrameSample
        {
            public double TimeSec;
            public bool HasState;
            public int FullPathHash;
            public double NormalizedTime;
            public float StateSpeed;
            public float AnimatorSpeed;
            public bool GraphPlaying;
            public Quaternion[] BoneRotations;
            public Vector3[] BonePositions;
            public bool[] BoneResolved;
        }

        private static AnimatorFrameSample CaptureAnimatorFrame(Animator animator, Transform[] boneTransforms, double timeSec)
        {
            var s = new AnimatorFrameSample
            {
                TimeSec = timeSec,
                AnimatorSpeed = animator.speed
            };

            // GetCurrentAnimatorStateInfo is only meaningful once the animator is initialized
            // with a controller and at least one layer; otherwise report hasState:false rather
            // than a fabricated zeroed state.
            if (animator.isInitialized && animator.runtimeAnimatorController != null && animator.layerCount > 0)
            {
                AnimatorStateInfo info = animator.GetCurrentAnimatorStateInfo(0);
                s.HasState = true;
                s.FullPathHash = info.fullPathHash;
                s.NormalizedTime = info.normalizedTime;
                s.StateSpeed = info.speed;
            }

            try
            {
                PlayableGraph graph = animator.playableGraph;
                if (graph.IsValid())
                    s.GraphPlaying = graph.IsPlaying();
            }
            catch
            {
                // No/invalid playable graph (e.g. edit mode, no controller) — leave GraphPlaying false.
            }

            // LOCAL pose only (localRotation + localPosition): world position would make every
            // bone "move" whenever a physics-driven ROOT moves — even with a frozen animator —
            // which is exactly the false bones_moving:true this op exists to prevent.
            int n = boneTransforms.Length;
            s.BoneRotations = new Quaternion[n];
            s.BonePositions = new Vector3[n];
            s.BoneResolved = new bool[n];
            for (int i = 0; i < n; i++)
            {
                Transform t = boneTransforms[i];
                if (t != null)
                {
                    s.BoneRotations[i] = t.localRotation;
                    s.BonePositions[i] = t.localPosition;
                    s.BoneResolved[i] = true;
                }
            }
            return s;
        }

        private static JObject AnimatorFrameToJson(AnimatorFrameSample s, string[] bonePaths, double startSec)
        {
            var bonesArr = new JArray();
            for (int i = 0; i < bonePaths.Length; i++)
            {
                var bj = new JObject
                {
                    ["path"] = bonePaths[i],
                    ["resolved"] = s.BoneResolved != null && i < s.BoneResolved.Length && s.BoneResolved[i]
                };
                if (s.BoneResolved != null && i < s.BoneResolved.Length && s.BoneResolved[i])
                {
                    Quaternion r = s.BoneRotations[i];
                    bj["localRotation"] = new JObject { ["x"] = r.x, ["y"] = r.y, ["z"] = r.z, ["w"] = r.w };
                    bj["localPosition"] = ToVector3(s.BonePositions[i]);
                }
                bonesArr.Add(bj);
            }

            return new JObject
            {
                ["tMs"] = Math.Round((s.TimeSec - startSec) * 1000.0, 3),
                ["hasState"] = s.HasState,
                ["fullPathHash"] = s.FullPathHash,
                ["normalizedTime"] = s.NormalizedTime,
                ["stateSpeed"] = s.StateSpeed,
                ["animatorSpeed"] = s.AnimatorSpeed,
                ["graphPlaying"] = s.GraphPlaying,
                ["bones"] = bonesArr
            };
        }

        private static JArray BuildBoneResolutionArray(string[] bonePaths, Transform[] boneTransforms)
        {
            var arr = new JArray();
            for (int i = 0; i < bonePaths.Length; i++)
                arr.Add(new JObject { ["path"] = bonePaths[i], ["resolved"] = boneTransforms[i] != null });
            return arr;
        }

        private static JObject BuildSampleAnimatorResult(
            List<AnimatorFrameSample> frames,
            string[] bonePaths,
            Transform[] boneTransforms,
            JObject locatorStr,
            GameObject go,
            Animator animator,
            bool editorHasFocus,
            int requestedSamples)
        {
            double startSec = frames.Count > 0 ? frames[0].TimeSec : 0.0;

            // Distinct timestamps — identical-timestamp samples can never prove advancement.
            int distinct = 0;
            double prev = double.NaN;
            foreach (AnimatorFrameSample f in frames)
            {
                if (double.IsNaN(prev) || Math.Abs(f.TimeSec - prev) > 1e-9)
                {
                    distinct++;
                    prev = f.TimeSec;
                }
            }

            // (hash, normalizedTime) series over samples that actually carried a running state.
            // Advancement is judged PER STATE (consecutive same-hash samples): Unity's
            // normalizedTime is monotonic within a looping state, and comparing across a state
            // transition proves nothing.
            var stateHashes = new List<int>(frames.Count);
            var normTimes = new List<double>(frames.Count);
            foreach (AnimatorFrameSample f in frames)
            {
                if (!f.HasState) continue;
                stateHashes.Add(f.FullPathHash);
                normTimes.Add(f.NormalizedTime);
            }
            bool timeAdvancing = ComputeTimeAdvancing(stateHashes, normTimes);

            // bones_moving: any resolved bone whose rotation/position left the epsilon ball
            // relative to the first sample.
            bool bonesMoving = false;
            if (frames.Count >= 2 && bonePaths.Length > 0)
            {
                AnimatorFrameSample first = frames[0];
                for (int b = 0; b < bonePaths.Length && !bonesMoving; b++)
                {
                    if (first.BoneResolved == null || b >= first.BoneResolved.Length || !first.BoneResolved[b])
                        continue;
                    for (int i = 1; i < frames.Count; i++)
                    {
                        AnimatorFrameSample fi = frames[i];
                        if (fi.BoneResolved == null || b >= fi.BoneResolved.Length || !fi.BoneResolved[b])
                            continue;
                        if (BoneMoved(first.BoneRotations[b], fi.BoneRotations[b], first.BonePositions[b], fi.BonePositions[b]))
                        {
                            bonesMoving = true;
                            break;
                        }
                    }
                }
            }

            // The animator is EXPECTED to advance only if it is enabled, has a controller, is
            // not paused (speed != 0), sits on an ACTIVE GameObject, and is initialized. Only
            // then is a frozen normalizedTime evidence of a freeze — an inactive/uninitialized
            // animator honestly cannot advance, so blaming focus for it would mislabel the cause.
            bool activeInHierarchy = go != null && go.activeInHierarchy;
            bool isInitialized = animator != null && animator.isInitialized;
            bool animatorPlaying = animator != null && animator.enabled
                && animator.runtimeAnimatorController != null
                && Mathf.Abs(animator.speed) > 1e-6f
                && activeInHierarchy
                && isInitialized;
            // CullCompletely stops animator time entirely while the renderer is offscreen — a
            // focus-INDEPENDENT freeze that must be named before any focus-based diagnosis.
            bool culledCompletely = animator != null && animator.cullingMode == AnimatorCullingMode.CullCompletely;

            string status = ClassifyAnimatorStatus(false, animatorPlaying, editorHasFocus, culledCompletely, distinct, timeAdvancing);
            string statusNote = null;
            if (status == "blocked_culled")
            {
                statusNote = "cullingMode is CullCompletely and animator time did not advance: Unity stops " +
                    "animating a completely-culled (offscreen/invisible) renderer regardless of editor focus. " +
                    "Bring the object on camera or set cullingMode to AlwaysAnimate before verifying animation.";
            }
            else if (status == "blocked_unfocused")
            {
                statusNote = "The editor application is inactive (isApplicationActive=false — under -batchmode this " +
                    "is ALWAYS false, so there this status simply means 'editor app inactive') and animator time did " +
                    "not advance. The sampling window pinned Time.captureDeltaTime, so game time DID advance across " +
                    "it — a frozen animator under pinned game time is strong evidence of the unfocused Animator-update " +
                    "throttle regardless of the focus flag. Do NOT treat the sampled pose as a verified animation.";
            }

            var samplesArr = new JArray();
            foreach (AnimatorFrameSample f in frames)
                samplesArr.Add(AnimatorFrameToJson(f, bonePaths, startSec));

            AnimatorFrameSample last = frames.Count > 0 ? frames[frames.Count - 1] : default;
            var current = new JObject
            {
                ["hasState"] = last.HasState,
                ["fullPathHash"] = last.FullPathHash,
                ["normalizedTime"] = last.NormalizedTime,
                ["stateSpeed"] = last.StateSpeed
            };

            var result = new JObject
            {
                ["locator"] = locatorStr,
                ["status"] = status,
                ["time_advancing"] = timeAdvancing,
                ["bones_moving"] = bonesMoving,
                ["playMode"] = true,
                ["editorHasFocus"] = editorHasFocus,
                ["animatorPlaying"] = animatorPlaying,
                ["animatorSpeed"] = animator != null ? animator.speed : 0f,
                ["culling_mode"] = animator != null ? animator.cullingMode.ToString() : null,
                ["active_in_hierarchy"] = activeInHierarchy,
                ["is_initialized"] = isInitialized,
                ["graphPlaying"] = last.GraphPlaying,
                ["currentState"] = current,
                ["requestedSamples"] = requestedSamples,
                ["sampleCount"] = frames.Count,
                ["distinctTimeSamples"] = distinct,
                ["durationMs"] = frames.Count > 0 ? Math.Round((last.TimeSec - startSec) * 1000.0, 3) : 0.0,
                ["bones"] = BuildBoneResolutionArray(bonePaths, boneTransforms),
                ["samples"] = samplesArr
            };
            if (statusNote != null)
                result["status_note"] = statusNote;
            return result;
        }

        // ---- Pure, play-mode-independent verdict math (internal for the tests asmdef) ----

        /// <summary>
        /// Max play-mode sampling window. The op's transport defaultTimeoutMs is 30000; keep a
        /// 2000ms response margin so the window can never outlive its own timeout.
        /// </summary>
        internal const double MaxSampleAnimatorDurationMs = 28000.0;

        /// <summary>normalizedTime granularity below which two samples are "the same time".</summary>
        internal const double AnimatorNormalizedTimeEpsilon = 1e-4;

        /// <summary>Per-bone rotation delta (degrees) above which a bone is "moving".</summary>
        internal const float AnimatorBoneRotationEpsilonDeg = 0.05f;

        /// <summary>Per-bone LOCAL position delta above which a bone is "moving".</summary>
        internal const float AnimatorBonePositionEpsilon = 1e-4f;

        /// <summary>
        /// True iff any state's normalizedTime series shows forward progress across the window.
        /// Unity's normalizedTime for a looping state is MONOTONIC (the integer part is the loop
        /// count), so a negative delta never means "the loop wrapped" — it means a state
        /// TRANSITION, and comparing normalizedTime across two different states proves nothing
        /// about either. Advancement is therefore judged ONLY between CONSECUTIVE samples sharing
        /// the same fullPathHash: a frozen animator yields identical values (false); a running
        /// one increases within a state (true); a mid-window transition contributes nothing by
        /// itself (its cross-state pair is skipped). Refuses (false) for &lt;2 samples or
        /// mismatched series — a single sample can never establish advancement.
        /// </summary>
        internal static bool ComputeTimeAdvancing(IReadOnlyList<int> stateHashes, IReadOnlyList<double> normalizedTimes)
        {
            if (stateHashes == null || normalizedTimes == null)
                return false;
            if (stateHashes.Count != normalizedTimes.Count || normalizedTimes.Count < 2)
                return false;
            for (int i = 1; i < normalizedTimes.Count; i++)
            {
                if (stateHashes[i] != stateHashes[i - 1])
                    continue; // state transition — cross-state deltas prove nothing
                if (normalizedTimes[i] - normalizedTimes[i - 1] > AnimatorNormalizedTimeEpsilon)
                    return true; // forward progress within one state
            }
            return false;
        }

        /// <summary>
        /// True iff a bone's LOCAL rotation or LOCAL position left its epsilon ball between two
        /// samples (skeletal-local motion; root motion must never count as animation).
        /// </summary>
        internal static bool BoneMoved(Quaternion r0, Quaternion r1, Vector3 p0, Vector3 p1)
        {
            if (Quaternion.Angle(r0, r1) > AnimatorBoneRotationEpsilonDeg) return true;
            float posEps = AnimatorBonePositionEpsilon;
            return (p1 - p0).sqrMagnitude > posEps * posEps;
        }

        /// <summary>
        /// Honest status classification for runtime.sample_animator. Ordering matters:
        ///  - edit mode is always the static single-shot result;
        ///  - a window with &lt;2 distinct samples is refused (insufficient_samples) BEFORE any
        ///    advancement claim — you cannot diagnose a freeze you never observed advancing over;
        ///  - blocked_culled BEFORE blocked_unfocused: a CullCompletely freeze is focus-
        ///    independent (offscreen renderer), so it must not be blamed on focus — and on a
        ///    FOCUSED editor it would otherwise be laundered into "ok";
        ///  - blocked_unfocused only when the animator was EXPECTED to advance yet did not and
        ///    the editor application is inactive (the physics-advances-but-Animator-frozen
        ///    defect; under -batchmode isApplicationActive is always false, so there this reads
        ///    "editor app inactive");
        ///  - otherwise ok (including an honestly-idle animator that simply isn't animating).
        /// </summary>
        internal static string ClassifyAnimatorStatus(
            bool editMode,
            bool animatorPlaying,
            bool editorHasFocus,
            bool culledCompletely,
            int distinctSampleCount,
            bool timeAdvancing)
        {
            if (editMode) return "edit_mode_static";
            if (distinctSampleCount < 2) return "insufficient_samples";
            if (animatorPlaying && !timeAdvancing && culledCompletely) return "blocked_culled";
            if (animatorPlaying && !timeAdvancing && !editorHasFocus) return "blocked_unfocused";
            return "ok";
        }

        /// <summary>
        /// Captures an INPUT-DRIVEN trajectory in one call by injecting the declared keys
        /// INSIDE the sampling loop, instead of across two MCP calls (key_down then
        /// measure_motion). The inter-call latency gap (~150-250ms) let a fast controller
        /// traverse the whole runway and be walled before the measure window opened, so
        /// every run window read deltaX=0. Here the keys are driven from sample t=0 on the
        /// same EditorApplication.update ticks that sample the target, so the captured
        /// window observes the actual input-driven motion.
        ///
        /// Keys are driven through the SAME InputService/session/backend pipeline as the
        /// input.* ops (so an active input session, focus, Play Mode, and virtual-only
        /// injection all behave identically) — reached via UnityBridgeBootstrap.InputService
        /// so no new InputSystem reference enters the Editor assembly.
        ///
        /// captureFps defaults to 0 (do NOT pin Time.captureDeltaTime): the game loop runs
        /// at its live rate so injected input reaches the controller normally. captureFps>0
        /// pins the timestep like measure_motion (still injecting in-loop). The response
        /// matches measure_motion exactly (MotionMetrics.Compute, samples[]:{tMs,x,y}, plus
        /// fixed-timestep provenance) and adds a per-phase breakdown.
        /// </summary>
        /// <summary>
        /// Coerce a param token to a JArray, accepting either a real JArray or a
        /// JSON-stringified array (some MCP transports stringify a deeply-nested arg).
        /// Returns null for anything else (absent / not an array).
        /// </summary>
        private static JArray CoerceJArray(JToken token)
        {
            if (token is JArray arr)
                return arr;
            if (token is JValue v && v.Type == JTokenType.String)
            {
                try { return JArray.Parse((string)v.Value); }
                catch { return null; }
            }
            return null;
        }

        private void HandleCaptureInputMotion(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "runtime.capture_input_motion requires Play Mode (input-driven motion is only meaningful while playing)."));
                return;
            }

            JObject measureLocator = parameters?.Value<JObject>("measure");
            if (measureLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'measure' (a locator)."));
                return;
            }

            JArray phasesParam = parameters?.Value<JArray>("phases");
            if (phasesParam == null || phasesParam.Count == 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'phases' (a non-empty array of { keys, durationMs } or { keys, fixedTicks })."));
                return;
            }

            int captureFps = parameters?.Value<int?>("captureFps") ?? 0;
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'captureFps' must be >= 0 (0 disables capture-rate pinning so injected input runs at the live frame rate)."));
                return;
            }
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? true;

            float projectFixedTimestep = Time.fixedDeltaTime;

            // Parse + validate phases. Each phase's key names are resolved to canonical
            // KeyCode names up front (via InputKeyMap), both to fail fast on a bad key and
            // so the held-set diff inside the loop compares canonical names regardless of
            // input casing/aliases ("space" -> "Space", "1" -> "Alpha1").
            GameObject measureGo;
            var phases = new List<CaptureInputMotion.Phase>();
            var phaseInputParams = new List<List<JObject>>(); // per phase: pre-built {key} param objects
            try
            {
                measureGo = LocatorResolver.Resolve(measureLocator);

                foreach (JToken phaseTok in phasesParam)
                {
                    JObject phase = phaseTok as JObject;
                    if (phase == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each phase must be an object.");
                    bool hasDurationMs = phase["durationMs"] != null;
                    bool hasFixedTicks = phase["fixedTicks"] != null;
                    if (hasDurationMs == hasFixedTicks)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each phase must include exactly one of 'durationMs' or 'fixedTicks'.");
                    double fixedTicks = hasFixedTicks ? phase.Value<double>("fixedTicks") : 0.0;
                    if (hasFixedTicks && (double.IsNaN(fixedTicks) || double.IsInfinity(fixedTicks) || fixedTicks <= 0 || Math.Abs(fixedTicks - Math.Round(fixedTicks)) > 1e-9))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Phase 'fixedTicks' must be a positive integer.");
                    double durMs = hasDurationMs
                        ? phase.Value<double>("durationMs")
                        : fixedTicks * projectFixedTimestep * 1000.0;
                    if (double.IsNaN(durMs) || double.IsInfinity(durMs) || durMs <= 0)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, hasDurationMs ? "Phase 'durationMs' must be a finite number > 0." : "Phase 'fixedTicks' must be > 0.");

                    var canonicalKeys = new List<string>();
                    var keyParams = new List<JObject>();
                    JArray keysArr = phase.Value<JArray>("keys");
                    if (keysArr != null)
                    {
                        foreach (JToken keyTok in keysArr)
                        {
                            string keyName = keyTok?.Value<string>();
                            if (string.IsNullOrEmpty(keyName))
                                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Phase 'keys' entries must be non-empty key-name strings.");
                            // Throws INVALID_KEY on an unknown key — fail fast before driving.
                            string canonical = InputKeyMap.ResolveOrThrow(keyName).ToString();
                            if (!canonicalKeys.Contains(canonical))
                            {
                                canonicalKeys.Add(canonical);
                                keyParams.Add(new JObject { ["key"] = canonical });
                            }
                        }
                    }
                    phases.Add(new CaptureInputMotion.Phase(canonicalKeys, durMs, hasFixedTicks ? fixedTicks : (double?)null));
                    phaseInputParams.Add(keyParams);
                }
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            // Map a canonical key name -> the pre-built {key} param object, so the loop can
            // KeyDown/KeyUp by name without re-allocating.
            var keyParamByName = new Dictionary<string, JObject>(StringComparer.Ordinal);
            foreach (List<JObject> list in phaseInputParams)
                foreach (JObject p in list)
                    keyParamByName[p.Value<string>("key")] = p;

            // L3a: optional per-tick runtime-member sampling. Resolve each field ONCE here
            // (GameObject + component + reflected getter + scalar guard) so the per-tick loop
            // just invokes a cached getter. Unresolvable fields become honest-or-omit entries
            // (a reason, never a fabricated value) and are simply not sampled.
            var fieldSamplers = new List<RuntimeFieldSampler>();
            // Accept sampledFields as a JArray OR a JSON-stringified array: some MCP
            // transports stringify a deeply-nested arg (each entry carries a nested
            // `locator` object), so the token can arrive as a JSON string. Parse both.
            JArray sampledFieldsParam = CoerceJArray(parameters?["sampledFields"]);
            if (sampledFieldsParam != null)
            {
                foreach (JToken fieldTok in sampledFieldsParam)
                {
                    if (fieldTok is JObject fieldSpec)
                        fieldSamplers.Add(RuntimeFieldSampler.Resolve(fieldSpec, LocatorResolver.Resolve));
                }
            }

            double totalSec = CaptureInputMotion.TotalDurationMs(phases) / 1000.0;

            InputService inputService = UnityBridgeBootstrap.InputService;
            bool needsInputService = false;
            for (int i = 0; i < phases.Count; i++)
            {
                if (phases[i].Keys != null && phases[i].Keys.Count > 0)
                {
                    needsInputService = true;
                    break;
                }
            }
            if (needsInputService && inputService == null)
            {
                onError(new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "runtime.capture_input_motion cannot inject keys because the input service is unavailable."));
                return;
            }

            // Same focus-independent simulation setup as measure_motion. captureFps=0
            // leaves captureDeltaTime untouched (live rate) so injected input is processed.
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = 1f / captureFps;

            const int maxSamples = 200000;
            var samples = new List<MotionMetrics.Sample>(2048);
            var sampleElapsedMs = new List<double>(2048);
            var samplePhase = new List<int>(2048);
            var phaseStartFixedTick = new double?[phases.Count];
            var phaseEndFixedTick = new double?[phases.Count];
            var heldKeys = new HashSet<string>(StringComparer.Ordinal);
            double startTime = -1;
            int lastPhaseIndex = -2;
            bool finished = false;
            EditorApplication.CallbackFunction tick = null;
            IDisposable keepAlive = null;

            // Release every still-held key through the input pipeline. Best-effort: a
            // backend error during teardown must not mask the real result/error.
            Action releaseHeldKeys = () =>
            {
                foreach (string key in heldKeys)
                {
                    try
                    {
                        if (inputService != null && keyParamByName.TryGetValue(key, out JObject kp))
                            inputService.KeyUp(kp);
                    }
                    catch { /* best-effort release */ }
                }
                heldKeys.Clear();
            };

            Action cleanup = () =>
            {
                releaseHeldKeys();
                keepAlive?.Dispose();
                EditorApplication.update -= tick;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            tick = () =>
            {
                if (finished) return;

                if (measureGo == null)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        "Measured GameObject was destroyed during capture."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsed = now - startTime;
                double elapsedMs = elapsed * 1000.0;

                // Determine the keys that should be held this tick and diff against the
                // currently-held set, injecting only the changes (idempotent, minimal churn).
                ISet<string> wantKeys = CaptureInputMotion.ActiveKeysAtElapsed(phases, elapsedMs);
                int phaseIndex = CaptureInputMotion.PhaseIndexAtElapsed(phases, elapsedMs);
                double currentFixedTick = Math.Round(Time.fixedTimeAsDouble / projectFixedTimestep);
                if (phaseIndex != lastPhaseIndex)
                {
                    if (lastPhaseIndex >= 0 && lastPhaseIndex < phases.Count && phaseEndFixedTick[lastPhaseIndex] == null)
                        phaseEndFixedTick[lastPhaseIndex] = currentFixedTick;
                    if (phaseIndex >= 0 && phaseIndex < phases.Count && phaseStartFixedTick[phaseIndex] == null)
                        phaseStartFixedTick[phaseIndex] = currentFixedTick;
                    lastPhaseIndex = phaseIndex;
                }
                try
                {
                    // Release first (so a key shared across the boundary is not double-driven),
                    // then press newly-required keys.
                    var toRelease = new List<string>();
                    foreach (string held in heldKeys)
                        if (!wantKeys.Contains(held))
                            toRelease.Add(held);
                    foreach (string key in toRelease)
                    {
                        if (keyParamByName.TryGetValue(key, out JObject kp))
                            inputService.KeyUp(kp);
                        heldKeys.Remove(key);
                    }
                    foreach (string key in wantKeys)
                    {
                        if (heldKeys.Contains(key))
                            continue;
                        if (keyParamByName.TryGetValue(key, out JObject kp))
                            inputService.KeyDown(kp);
                        heldKeys.Add(key);
                    }
                }
                catch (BridgeException ex)
                {
                    // e.g. INPUT_SESSION_REQUIRED / PLAY_MODE_REQUIRED / FOCUS_REQUIRED from
                    // the input pipeline — surface it (cleanup releases any held keys).
                    finished = true;
                    cleanup();
                    onError(ex);
                    return;
                }
                catch (Exception ex)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        $"runtime.capture_input_motion input injection failed: {ex.Message}", ex));
                    return;
                }

                samples.Add(new MotionMetrics.Sample(now, measureGo.transform.position, measureGo.transform.eulerAngles));
                sampleElapsedMs.Add(elapsedMs);
                samplePhase.Add(phaseIndex < 0 ? phases.Count - 1 : phaseIndex);

                // L3a: record each resolved runtime field on the SAME tick/clock as the
                // position sample above (elapsedMs is the position sample's tMs).
                for (int f = 0; f < fieldSamplers.Count; f++)
                    fieldSamplers[f].SampleTick(elapsedMs);

                if (elapsed >= totalSec || samples.Count >= maxSamples)
                {
                    finished = true;
                    double finalFixedTick = Math.Round(Time.fixedTimeAsDouble / projectFixedTimestep);
                    if (phaseIndex >= 0 && phaseIndex < phases.Count && phaseEndFixedTick[phaseIndex] == null)
                        phaseEndFixedTick[phaseIndex] = finalFixedTick;
                    // Release held keys BEFORE responding so no key lingers into the
                    // inter-call gap (the editor keeps ticking the sim between MCP calls).
                    releaseHeldKeys();
                    keepAlive?.Dispose();
                    EditorApplication.update -= tick;
                    Time.captureDeltaTime = restoreCaptureDeltaTime;
                    Application.runInBackground = restoreRunInBackground;
                    try
                    {
                        JObject result = MotionMetrics.Compute(samples, includeSamples, projectFixedTimestep, Time.fixedDeltaTime);
                        result["phases"] = ComputeInputPhaseBreakdown(phases, samples, sampleElapsedMs, samplePhase, phaseStartFixedTick, phaseEndFixedTick);
                        // L3a: emit the per-field timeline only when sampledFields was requested,
                        // so existing callers see an unchanged response shape.
                        if (sampledFieldsParam != null)
                        {
                            var fieldTimeline = new JArray();
                            foreach (RuntimeFieldSampler fs in fieldSamplers)
                                fieldTimeline.Add(fs.ToTimelineEntry());
                            result["fieldTimeline"] = fieldTimeline;
                        }
                        respond(result);
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"runtime.capture_input_motion metric computation failed: {ex.Message}", ex));
                    }
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.update += tick;
        }

        /// <summary>
        /// Captures a POINTER-DRIVEN trajectory in one call by dispatching a single uGUI
        /// tap INSIDE the sampling loop, instead of across two MCP calls (an async
        /// measure_motion fired separately from a ui.dispatch_pointer). The inter-call WS
        /// round-trips put a ~450ms gap between the tap and sample-0, so timeToApex measured
        /// from the first sample was wrong and the launch had to be trimmed by hand. Here we
        /// sample a baseline for settleMs, then ONCE dispatch the tap on a tick (via
        /// EventSystemPointerDispatch.Click — the same path as ui.dispatch_pointer), latch
        /// the dispatch elapsedMs, and keep sampling for captureMs. The capture is therefore
        /// launch-aligned and timeToApexFromDispatchMs is clean. The pointer analog of
        /// capture_input_motion — for games driven by on-screen buttons (legacy-Input mobile
        /// titles that only respond to UI taps).
        ///
        /// captureFps defaults to 0 (do NOT pin Time.captureDeltaTime) so the EventSystem +
        /// game run at their live rate and the dispatch is processed normally. captureFps>0
        /// pins the timestep like measure_motion (still dispatching in-loop). Honest: if the
        /// dispatch never actuates (no raycast hit / no handler fired), the (flat) capture is
        /// still returned with dispatch.actuated:false so the caller sees WHY there was no
        /// motion — it is not surfaced as an error.
        /// </summary>
        private void HandleCapturePointerMotion(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "runtime.capture_pointer_motion requires Play Mode (pointer-driven motion is only meaningful while playing)."));
                return;
            }

            JObject measureLocator = parameters?.Value<JObject>("measure");
            if (measureLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'measure' (a locator)."));
                return;
            }

            JObject targetLocator = parameters?.Value<JObject>("target");
            JObject worldPointerParam = parameters?.Value<JObject>("world");
            if ((targetLocator == null) == (worldPointerParam == null))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "runtime.capture_pointer_motion requires exactly one drive target: 'target' (uGUI locator) OR 'world' ({x,y,z?,camera?})."));
                return;
            }

            double settleMs = parameters?.Value<double?>("settleMs") ?? 300.0;
            if (settleMs < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'settleMs' must be >= 0."));
                return;
            }
            double captureMs = parameters?.Value<double?>("captureMs") ?? 1000.0;
            if (captureMs <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'captureMs' must be > 0."));
                return;
            }

            int captureFps = parameters?.Value<int?>("captureFps") ?? 0;
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'captureFps' must be >= 0 (0 disables capture-rate pinning so the dispatched tap runs at the live frame rate)."));
                return;
            }
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? true;

            // Tap SCHEDULE. Default: one tap at `settleMs` (the original single-tap behaviour).
            // When `taps` is given (a non-empty array of { atMs }, elapsedMs-from-capture-start),
            // each tap is dispatched IN-LOOP at its time — so a multi-tap mechanism (e.g. a
            // double-jump = a 2nd tap while airborne) can be driven with PRECISE timing the loop
            // controls, not the jitter of separate MCP round-trips. Times must be ascending and >= 0.
            var tapTimes = new List<double>();
            JArray tapsParam = parameters?.Value<JArray>("taps");
            if (tapsParam != null)
            {
                if (tapsParam.Count == 0)
                {
                    onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'taps' must be a non-empty array of { atMs }."));
                    return;
                }
                double prev = -1;
                foreach (JToken tapTok in tapsParam)
                {
                    JObject tap = tapTok as JObject;
                    if (tap == null || tap["atMs"] == null)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Each 'taps' entry must include 'atMs'."));
                        return;
                    }
                    double atMs = tap.Value<double>("atMs");
                    if (atMs < 0 || atMs < prev)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "'taps[].atMs' must be >= 0 and in ascending order."));
                        return;
                    }
                    tapTimes.Add(atMs);
                    prev = atMs;
                }
            }
            else
            {
                tapTimes.Add(settleMs); // back-compat: single tap at settleMs
            }
            double lastTapAtMs = tapTimes[tapTimes.Count - 1];

            // Resolve the measured object and the tap target/world projection up front —
            // fail fast before any sampling state is set up.
            GameObject measureGo;
            GameObject target = null;
            WorldPointerProjection worldPointer = null;
            try
            {
                measureGo = LocatorResolver.Resolve(measureLocator);
                if (targetLocator != null)
                {
                    target = LocatorResolver.Resolve(targetLocator);
                }
                else
                {
                    if (!GameViewFocus.EnsureGameViewFocused())
                        throw new BridgeException(ErrorCodes.FOCUS_REQUIRED,
                            "runtime.capture_pointer_motion world tap needs Game-View focus (the simulated pointer routes to the focused Game View).");
                    worldPointer = ProjectWorldPointer(worldPointerParam);
                }
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            // L3a: optional per-tick runtime-member sampling (same as capture_input_motion).
            // Resolve each field ONCE here so the per-tick loop just invokes a cached getter.
            var fieldSamplers = new List<RuntimeFieldSampler>();
            JArray sampledFieldsParam = CoerceJArray(parameters?["sampledFields"]);
            if (sampledFieldsParam != null)
            {
                foreach (JToken fieldTok in sampledFieldsParam)
                {
                    if (fieldTok is JObject fieldSpec)
                        fieldSamplers.Add(RuntimeFieldSampler.Resolve(fieldSpec, LocatorResolver.Resolve));
                }
            }

            float projectFixedTimestep = Time.fixedDeltaTime;

            // Same focus-independent simulation setup as measure_motion/capture_input_motion.
            // captureFps=0 leaves captureDeltaTime untouched (live rate) so the EventSystem +
            // dispatched tap are processed normally.
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = 1f / captureFps;

            const int maxSamples = 200000;
            var samples = new List<MotionMetrics.Sample>(2048);
            var sampleElapsedMs = new List<double>(2048);
            double startTime = -1;
            bool finished = false;
            int nextTapIdx = 0;                                  // next scheduled tap to fire
            var tapActualMs = new List<double>();                // per tap: actual dispatch elapsedMs (-1 until fired)
            var tapResults = new List<PointerDispatchOutcome>(); // per tap: dispatch outcome
            for (int i = 0; i < tapTimes.Count; i++) { tapActualMs.Add(-1); tapResults.Add(default); }
            EditorApplication.CallbackFunction tick = null;

            Action cleanup = () =>
            {
                EditorApplication.update -= tick;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            tick = () =>
            {
                if (finished) return;

                if (measureGo == null)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        "Measured GameObject was destroyed during capture."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsed = now - startTime;
                double elapsedMs = elapsed * 1000.0;

                // Fire every scheduled tap whose time has elapsed this tick, IN-LOOP (a tick may
                // cover more than one if the schedule is dense / the frame was long).
                while (nextTapIdx < tapTimes.Count && elapsedMs >= tapTimes[nextTapIdx])
                {
                    if (targetLocator != null && target == null)
                    {
                        finished = true;
                        cleanup();
                        onError(new BridgeException(ErrorCodes.NOT_FOUND,
                            "Tap target GameObject was destroyed before dispatch."));
                        return;
                    }
                    try
                    {
                        if (target != null)
                        {
                            tapResults[nextTapIdx] = PointerDispatchOutcome.FromEventSystem(
                                EventSystemPointerDispatch.Click(target, ScreenPointOf(target), 0));
                        }
                        else
                        {
                            SimulatedPointerBridge.TapAt(worldPointer.Screen.x, worldPointer.Screen.y);
                            tapResults[nextTapIdx] = PointerDispatchOutcome.FromWorld(worldPointer);
                        }
                    }
                    catch (BridgeException ex)
                    {
                        finished = true;
                        cleanup();
                        onError(ex);
                        return;
                    }
                    catch (Exception ex)
                    {
                        finished = true;
                        cleanup();
                        onError(new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                            $"runtime.capture_pointer_motion pointer dispatch failed: {ex.Message}", ex));
                        return;
                    }
                    tapActualMs[nextTapIdx] = elapsedMs;
                    nextTapIdx++;
                }
                bool dispatched = nextTapIdx > 0;
                double pointerDispatchMs = dispatched ? tapActualMs[0] : -1; // launch ref = first tap

                samples.Add(new MotionMetrics.Sample(now, measureGo.transform.position, measureGo.transform.eulerAngles));
                sampleElapsedMs.Add(elapsedMs);

                // L3a: record each resolved runtime field on the SAME tick/clock as the
                // position sample (elapsedMs is the position sample's tMs).
                for (int f = 0; f < fieldSamplers.Count; f++)
                    fieldSamplers[f].SampleTick(elapsedMs);

                if (elapsedMs >= lastTapAtMs + captureMs || samples.Count >= maxSamples)
                {
                    finished = true;
                    cleanup();
                    try
                    {
                        JObject result = MotionMetrics.Compute(samples, includeSamples, projectFixedTimestep, Time.fixedDeltaTime);

                        // Launch reference: the elapsedMs the tap fired (null if never dispatched).
                        result["pointerDispatchMs"] = dispatched ? (JToken)pointerDispatchMs : JValue.CreateNull();

                        // Launch-aligned timeToApex: the apex must be a STRICT rise above the
                        // launch position (the y at the dispatch sample). A tap that produced NO
                        // rise (flat/falling — e.g. not grounded, or the tap did not register a
                        // jump) yields null, never a misleading 0 (honest-or-omit). Null when not
                        // dispatched too. The dispatch tick appends its own sample, so the first
                        // at/after-dispatch sample IS the launch baseline.
                        if (dispatched)
                        {
                            float launchY = float.NaN;
                            double apexElapsedMs = -1;
                            float apexY = float.NegativeInfinity;
                            for (int i = 0; i < samples.Count; i++)
                            {
                                if (sampleElapsedMs[i] < pointerDispatchMs) continue;
                                float y = samples[i].Position.y;
                                if (float.IsNaN(launchY)) launchY = y; // first at/after dispatch = launch
                                if (y > apexY)
                                {
                                    apexY = y;
                                    apexElapsedMs = sampleElapsedMs[i];
                                }
                            }
                            bool roseAboveLaunch = !float.IsNaN(launchY) && apexY > launchY && apexElapsedMs >= 0;
                            result["timeToApexFromDispatchMs"] = roseAboveLaunch
                                ? (JToken)Math.Round(apexElapsedMs - pointerDispatchMs, 2)
                                : JValue.CreateNull();
                        }
                        else
                        {
                            result["timeToApexFromDispatchMs"] = JValue.CreateNull();
                        }

                        // Per-tap outcomes (scheduled atMs, actual dispatch elapsedMs, actuation),
                        // so each tap of a multi-tap sequence is visible — a non-actuating tap is
                        // not silent. Helper builds one tap's JObject.
                        Func<int, JObject> tapJson = (i) =>
                        {
                            bool fired = tapActualMs[i] >= 0;
                            var firedArr = new JArray();
                            PointerDispatchOutcome outcome = tapResults[i];
                            if (fired && outcome.HandlersFired != null)
                                foreach (string h in outcome.HandlersFired) firedArr.Add(h);
                            var json = new JObject
                            {
                                ["atMs"] = tapTimes[i],
                                ["dispatchedMs"] = fired ? (JToken)Math.Round(tapActualMs[i], 2) : JValue.CreateNull(),
                                ["actuated"] = fired && outcome.Actuated.HasValue ? (JToken)outcome.Actuated.Value : JValue.CreateNull(),
                                ["raycastHit"] = fired && outcome.RaycastHit.HasValue ? (JToken)outcome.RaycastHit.Value : JValue.CreateNull(),
                                ["handlersFired"] = firedArr
                            };
                            if (fired && outcome.World != null) json["world"] = outcome.World;
                            if (fired && outcome.Screen != null) json["screen"] = outcome.Screen;
                            if (fired && outcome.Camera != null) json["camera"] = outcome.Camera;
                            if (fired && outcome.Mode != null) json["mode"] = outcome.Mode;
                            return json;
                        };
                        var tapsArr = new JArray();
                        for (int i = 0; i < tapTimes.Count; i++) tapsArr.Add(tapJson(i));
                        result["taps"] = tapsArr;

                        // Back-compat: `dispatch` = the FIRST tap's outcome (visible, not silent).
                        result["dispatch"] = dispatched ? tapJson(0) : JValue.CreateNull();

                        // L3a: emit the per-field timeline only when sampledFields was requested,
                        // so existing callers see an unchanged response shape.
                        if (sampledFieldsParam != null)
                        {
                            var fieldTimeline = new JArray();
                            foreach (RuntimeFieldSampler fs in fieldSamplers)
                                fieldTimeline.Add(fs.ToTimelineEntry());
                            result["fieldTimeline"] = fieldTimeline;
                        }

                        respond(result);
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"runtime.capture_pointer_motion metric computation failed: {ex.Message}", ex));
                    }
                }
            };

            EditorApplication.update += tick;
        }

        /// <summary>
        /// runtime.capture_pointer_hold_motion — capture motion while a uGUI control is driven by a
        /// sustained pointer hold. With dragTo, this is the joystick-hold analog of
        /// capture_pointer_motion's tap: at settleMs the pointer presses the target and drags to
        /// `dragTo` {dx,dy} (screen px from the target center), then HOLDS that deflection —
        /// re-asserting OnDrag each tick — so the player accelerates and reaches a steady run speed.
        /// Without dragTo, this is button mode: press, hold, and release without dragging (for jump
        /// buttons / short-hop). releaseMs or releaseFixedTicks can release before the window ends;
        /// fixed-tick release emits requested/actual tick evidence. The caller derives metrics from
        /// the returned samples (deterministic-CLI vs bridge split: the bridge captures, the CLI derives).
        ///
        /// Mirrors capture_pointer_motion's focus-independent sim + L3a sampledFields. Response adds
            /// holdDispatchMs, releaseMs (null if held to the end), and dispatch{actuated,raycastHit,
            /// handlersFired} so a non-engaging control is visible, not silent.
        /// </summary>
        private void HandleCapturePointerHoldMotion(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "runtime.capture_pointer_hold_motion requires Play Mode (pointer-driven motion is only meaningful while playing)."));
                return;
            }

            JObject measureLocator = parameters?.Value<JObject>("measure");
            if (measureLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'measure' (a locator)."));
                return;
            }
            JObject targetLocator = parameters?.Value<JObject>("target");
            if (targetLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'target' (a locator for the uGUI control to drag/hold, e.g. a joystick)."));
                return;
            }

            // dragTo = the held deflection as a screen-pixel offset from the target center. When
            // omitted, the op runs in button-hold mode: pointerDown, hold, pointerUp without drag.
            // When present, at least one of dx/dy must be non-zero — a zero offset would assert
            // no joystick direction (no movement).
            JObject dragTo = parameters?.Value<JObject>("dragTo");
            bool buttonHoldOnly = dragTo == null;
            double dx = dragTo?.Value<double?>("dx") ?? 0.0;
            double dy = dragTo?.Value<double?>("dy") ?? 0.0;
            if (!buttonHoldOnly && Math.Abs(dx) < 1e-6 && Math.Abs(dy) < 1e-6)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "'dragTo' must have a non-zero dx or dy (a zero offset asserts no direction)."));
                return;
            }

            double settleMs = parameters?.Value<double?>("settleMs") ?? 300.0;
            if (settleMs < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'settleMs' must be >= 0."));
                return;
            }
            double captureMs = parameters?.Value<double?>("captureMs") ?? 1500.0;
            if (captureMs <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'captureMs' must be > 0."));
                return;
            }

            // releaseMs (relative to the hold dispatch): release the drag this long AFTER it begins,
            // then keep sampling to the window end so deceleration is captured. null/absent => held
            // for the whole window (released at the end). Must be > 0 and <= captureMs.
            float projectFixedTimestep = Time.fixedDeltaTime;
            bool hasReleaseMs = parameters?["releaseMs"] != null;
            bool hasReleaseFixedTicks = parameters?["releaseFixedTicks"] != null;
            if (hasReleaseMs && hasReleaseFixedTicks)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Specify at most one of 'releaseMs' or 'releaseFixedTicks'."));
                return;
            }
            double? releaseAfterMs = hasReleaseMs ? parameters.Value<double?>("releaseMs") : null;
            double? requestedReleaseFixedTicks = hasReleaseFixedTicks ? parameters.Value<double?>("releaseFixedTicks") : null;
            if (requestedReleaseFixedTicks.HasValue && (
                double.IsNaN(requestedReleaseFixedTicks.Value) ||
                double.IsInfinity(requestedReleaseFixedTicks.Value) ||
                requestedReleaseFixedTicks.Value <= 0 ||
                Math.Abs(requestedReleaseFixedTicks.Value - Math.Round(requestedReleaseFixedTicks.Value)) > 1e-9))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'releaseFixedTicks' must be a positive integer."));
                return;
            }
            if (requestedReleaseFixedTicks.HasValue)
                releaseAfterMs = requestedReleaseFixedTicks.Value * projectFixedTimestep * 1000.0;
            if (releaseAfterMs.HasValue && (releaseAfterMs.Value <= 0 || releaseAfterMs.Value > captureMs))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Release timing must be > 0 and <= captureMs."));
                return;
            }

            int captureFps = parameters?.Value<int?>("captureFps") ?? 0;
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'captureFps' must be >= 0."));
                return;
            }
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? true;

            GameObject measureGo;
            GameObject target;
            try
            {
                measureGo = LocatorResolver.Resolve(measureLocator);
                target = LocatorResolver.Resolve(targetLocator);
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            var fieldSamplers = new List<RuntimeFieldSampler>();
            JArray sampledFieldsParam = CoerceJArray(parameters?["sampledFields"]);
            if (sampledFieldsParam != null)
            {
                foreach (JToken fieldTok in sampledFieldsParam)
                {
                    if (fieldTok is JObject fieldSpec)
                        fieldSamplers.Add(RuntimeFieldSampler.Resolve(fieldSpec, LocatorResolver.Resolve));
                }
            }

            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = 1f / captureFps;

            const int maxSamples = 200000;
            var samples = new List<MotionMetrics.Sample>(2048);
            var sampleElapsedMs = new List<double>(2048);
            double startTime = -1;
            bool finished = false;
            bool dispatched = false;
            double holdDispatchMs = -1;
            double releasedAtMs = -1;
            double holdStartFixedTick = -1;
            double releaseFixedTick = -1;
            EventSystemPointerDispatch.HeldDrag held = null;
            EditorApplication.CallbackFunction tick = null;

            Action cleanup = () =>
            {
                // Always release the held pointer on teardown so we never leave the joystick stuck
                // deflected (which would keep driving the player after the capture ends).
                try { if (held != null) EventSystemPointerDispatch.Release(held); } catch { }
                EditorApplication.update -= tick;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            tick = () =>
            {
                if (finished) return;

                if (measureGo == null)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND, "Measured GameObject was destroyed during capture."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsedMs = (now - startTime) * 1000.0;
                double currentFixedTick = Math.Round(Time.fixedTimeAsDouble / projectFixedTimestep);

                // ONCE at settleMs: press + drag the target to the held offset (joystick deflects).
                if (!dispatched && elapsedMs >= settleMs)
                {
                    if (target == null)
                    {
                        finished = true;
                        cleanup();
                        onError(new BridgeException(ErrorCodes.NOT_FOUND, "Drag target GameObject was destroyed before dispatch."));
                        return;
                    }
                    try
                    {
                        Vector2 from = ScreenPointOf(target);
                        if (buttonHoldOnly)
                        {
                            held = EventSystemPointerDispatch.BeginPressHold(target, from, 0);
                        }
                        else
                        {
                            Vector2 to = from + new Vector2((float)dx, (float)dy);
                            held = EventSystemPointerDispatch.BeginHold(target, from, to, 0);
                        }
                    }
                    catch (BridgeException ex) { finished = true; cleanup(); onError(ex); return; }
                    catch (Exception ex)
                    {
                        finished = true;
                        cleanup();
                        onError(new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                            $"runtime.capture_pointer_hold_motion drag dispatch failed: {ex.Message}", ex));
                        return;
                    }
                    holdDispatchMs = elapsedMs;
                    holdStartFixedTick = currentFixedTick;
                    dispatched = true;
                }

                // While held, re-assert the deflection every tick (robust across joystick impls),
                // then sample. This block re-enters game handler code (HoldTick/Release dispatch
                // OnDrag/OnPointerUp) and reads a live transform, so guard it: ANY unexpected throw
                // must still RELEASE the held pointer (never leave the joystick stuck deflected,
                // which would keep driving the player and corrupt later captures) and surface an
                // error — not re-throw out of the EditorApplication.update callback every frame
                // (the loop would never terminate, the op would hang, and the hold would persist).
                // ExecuteEvents already swallows+logs handler throws; this is defence in depth so
                // the "always release" invariant holds unconditionally.
                try
                {
                    if (dispatched && held != null && !held.released)
                    {
                        // Early release to capture deceleration, if requested.
                        bool shouldRelease = releaseAfterMs.HasValue && elapsedMs >= holdDispatchMs + releaseAfterMs.Value;
                        if (requestedReleaseFixedTicks.HasValue && holdStartFixedTick >= 0)
                            shouldRelease = currentFixedTick >= holdStartFixedTick + requestedReleaseFixedTicks.Value;
                        if (shouldRelease)
                        {
                            EventSystemPointerDispatch.Release(held);
                            releasedAtMs = elapsedMs;
                            releaseFixedTick = currentFixedTick;
                        }
                        else
                        {
                            EventSystemPointerDispatch.HoldTick(held);
                        }
                    }

                    samples.Add(new MotionMetrics.Sample(now, measureGo.transform.position, measureGo.transform.eulerAngles));
                    sampleElapsedMs.Add(elapsedMs);
                    for (int f = 0; f < fieldSamplers.Count; f++)
                        fieldSamplers[f].SampleTick(elapsedMs);
                }
                catch (Exception ex)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                        $"runtime.capture_pointer_hold_motion capture loop failed: {ex.Message}", ex));
                    return;
                }

                if (elapsedMs >= settleMs + captureMs || samples.Count >= maxSamples)
                {
                    finished = true;
                    // Capture the dispatch outcome + released flag BEFORE cleanup releases the hold.
                    bool wasReleasedEarly = held != null && held.released;
                    var firedSnapshot = held?.handlersFired != null ? new List<string>(held.handlersFired) : null;
                    bool raycastHit = held != null && held.raycastHit;
                    cleanup();
                    try
                    {
                        JObject result = MotionMetrics.Compute(samples, includeSamples, projectFixedTimestep, Time.fixedDeltaTime);
                        result["holdDispatchMs"] = dispatched ? (JToken)Math.Round(holdDispatchMs, 2) : JValue.CreateNull();
                        result["releaseMs"] = releasedAtMs >= 0 ? (JToken)Math.Round(releasedAtMs, 2) : JValue.CreateNull();
                        if (requestedReleaseFixedTicks.HasValue)
                        {
                            result["requestedFixedTicks"] = requestedReleaseFixedTicks.Value;
                            if (holdStartFixedTick >= 0 && releaseFixedTick >= 0)
                            {
                                result["fixedTickStart"] = holdStartFixedTick;
                                result["fixedTickEnd"] = releaseFixedTick;
                                result["actualFixedTicks"] = Math.Max(0.0, releaseFixedTick - holdStartFixedTick);
                            }
                        }

                        if (dispatched)
                        {
                            var fired = new JArray();
                            if (firedSnapshot != null)
                                foreach (string h in firedSnapshot) fired.Add(h);
                            bool actuated = firedSnapshot != null && (
                                buttonHoldOnly
                                    ? (held.raycastHit && firedSnapshot.Contains("pointerDown") && firedSnapshot.Contains("pointerUp"))
                                    : firedSnapshot.Contains("drag"));
                            result["dispatch"] = new JObject
                            {
                                ["actuated"] = actuated,
                                ["raycastHit"] = raycastHit,
                                ["handlersFired"] = fired
                            };
                        }
                        else
                        {
                            result["dispatch"] = JValue.CreateNull();
                        }

                        if (sampledFieldsParam != null)
                        {
                            var fieldTimeline = new JArray();
                            foreach (RuntimeFieldSampler fs in fieldSamplers)
                                fieldTimeline.Add(fs.ToTimelineEntry());
                            result["fieldTimeline"] = fieldTimeline;
                        }

                        respond(result);
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"runtime.capture_pointer_hold_motion metric computation failed: {ex.Message}", ex));
                    }
                }
            };

            EditorApplication.update += tick;
        }

        /// <summary>
        /// Screen point at the center of a uGUI element, accounting for the parent Canvas
        /// render mode (overlay uses no camera). Replicated from UIHandler.ScreenPointOf so
        /// RuntimeHandler can dispatch a tap in-loop without taking a dependency on UIHandler.
        /// </summary>
        private static Vector2 ScreenPointOf(GameObject go)
        {
            RectTransform rt = go.GetComponent<RectTransform>();
            Canvas canvas = go.GetComponentInParent<Canvas>();
            Camera cam = (canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay)
                ? canvas.worldCamera
                : null;
            Vector3 worldCenter = rt != null ? rt.TransformPoint(rt.rect.center) : go.transform.position;
            return RectTransformUtility.WorldToScreenPoint(cam, worldCenter);
        }

        private static WorldPointerProjection ProjectWorldPointer(JObject world)
        {
            if (!IsFiniteNumber(world?["x"]) || !IsFiniteNumber(world["y"]))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "runtime.capture_pointer_motion world tap requires finite numeric world x and y.");

            float x = world.Value<float>("x");
            float y = world.Value<float>("y");
            float z = IsFiniteNumber(world["z"]) ? world.Value<float>("z") : 0f;
            Camera camera = ResolveCamera(world.Value<JObject>("camera"));
            Vector3 screen = camera.WorldToScreenPoint(new Vector3(x, y, z));
            if (!IsFiniteFloat(screen.x) || !IsFiniteFloat(screen.y) || !IsFiniteFloat(screen.z) || screen.z <= 0f)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"runtime.capture_pointer_motion could not project world point ({x}, {y}, {z}) through camera '{camera.name}'.");

            Rect pixelRect = camera.pixelRect;
            if (!pixelRect.Contains(new Vector2(screen.x, screen.y)))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"runtime.capture_pointer_motion projected world point ({screen.x}, {screen.y}) is outside camera pixel rect {pixelRect}.");

            return new WorldPointerProjection
            {
                Screen = screen,
                WorldJson = new JObject { ["x"] = x, ["y"] = y, ["z"] = z },
                ScreenJson = new JObject { ["x"] = screen.x, ["y"] = screen.y, ["z"] = screen.z },
                CameraJson = LocatorResolver.BuildLocator(camera.gameObject)
            };
        }

        private static Camera ResolveCamera(JObject cameraLocator)
        {
            if (cameraLocator != null)
            {
                GameObject go = LocatorResolver.Resolve(cameraLocator);
                Camera camera = go.GetComponent<Camera>();
                if (camera == null)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"runtime.capture_pointer_motion camera locator does not resolve to a Camera: {cameraLocator.ToString(Newtonsoft.Json.Formatting.None)}");
                return camera;
            }

            Camera main = Camera.main;
            if (main == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    "runtime.capture_pointer_motion could not find Camera.main for world tap; pass world.camera:<locator>.");
            return main;
        }

        private static bool IsFiniteNumber(JToken token)
        {
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
                return false;
            double v = token.Value<double>();
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        private static bool IsFiniteFloat(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private sealed class WorldPointerProjection
        {
            public Vector3 Screen;
            public JObject WorldJson;
            public JObject ScreenJson;
            public JObject CameraJson;
        }

        private struct PointerDispatchOutcome
        {
            public bool? Actuated;
            public bool? RaycastHit;
            public List<string> HandlersFired;
            public JObject World;
            public JObject Screen;
            public JObject Camera;
            public string Mode;

            public static PointerDispatchOutcome FromEventSystem(EventSystemPointerDispatch.Result result)
            {
                return new PointerDispatchOutcome
                {
                    Actuated = result.handlersFired != null && result.handlersFired.Count > 0,
                    RaycastHit = result.raycastHit,
                    HandlersFired = result.handlersFired,
                    Mode = "ugui"
                };
            }

            public static PointerDispatchOutcome FromWorld(WorldPointerProjection projection)
            {
                return new PointerDispatchOutcome
                {
                    Actuated = null,
                    RaycastHit = null,
                    HandlersFired = new List<string>(),
                    World = projection.WorldJson,
                    Screen = projection.ScreenJson,
                    Camera = projection.CameraJson,
                    Mode = "world-input-system"
                };
            }
        }

        /// <summary>
        /// Per-phase breakdown over the captured samples, keyed by the phase index each
        /// sample was tagged with during the loop. Mirrors the per-phase fields probe emits.
        /// </summary>
        private static JArray ComputeInputPhaseBreakdown(
            List<CaptureInputMotion.Phase> phases,
            List<MotionMetrics.Sample> samples,
            List<double> sampleElapsedMs,
            List<int> samplePhase,
            double?[] phaseStartFixedTick,
            double?[] phaseEndFixedTick)
        {
            var arr = new JArray();
            for (int i = 0; i < phases.Count; i++)
            {
                bool any = false;
                float sx = 0, ex = 0, sy = 0, ey = 0, minY = 0, maxY = 0;
                int count = 0;
                for (int s = 0; s < samples.Count; s++)
                {
                    if (samplePhase[s] != i) continue;
                    Vector3 pos = samples[s].Position;
                    if (!any) { sx = pos.x; sy = pos.y; minY = maxY = pos.y; any = true; }
                    ex = pos.x; ey = pos.y;
                    if (pos.y < minY) minY = pos.y;
                    if (pos.y > maxY) maxY = pos.y;
                    count++;
                }

                var keysArr = new JArray();
                foreach (string k in phases[i].Keys)
                    keysArr.Add(k);

                var pj = new JObject
                {
                    ["index"] = i,
                    ["keys"] = keysArr,
                    ["requestedDurationMs"] = phases[i].DurationMs,
                    ["sampleCount"] = count
                };
                if (phases[i].RequestedFixedTicks.HasValue)
                    pj["requestedFixedTicks"] = phases[i].RequestedFixedTicks.Value;
                if (phaseStartFixedTick != null && phaseEndFixedTick != null &&
                    i < phaseStartFixedTick.Length && i < phaseEndFixedTick.Length &&
                    phaseStartFixedTick[i].HasValue && phaseEndFixedTick[i].HasValue)
                {
                    double startTick = phaseStartFixedTick[i].Value;
                    double endTick = phaseEndFixedTick[i].Value;
                    pj["fixedTickStart"] = startTick;
                    pj["fixedTickEnd"] = endTick;
                    pj["actualFixedTicks"] = Math.Max(0.0, endTick - startTick);
                }
                if (any)
                {
                    pj["startX"] = sx; pj["endX"] = ex; pj["deltaX"] = ex - sx;
                    pj["startY"] = sy; pj["endY"] = ey; pj["deltaY"] = ey - sy;
                    pj["minY"] = minY; pj["maxY"] = maxY;
                }
                arr.Add(pj);
            }
            return arr;
        }

        /// <summary>
        /// Deterministically drives one component property/field through a sequence of
        /// timed phases while sampling a target object's transform position — all inside a
        /// single focus-independent loop. Unlike driving input across separate MCP calls
        /// (where the editor ticks the sim during inter-call gaps and state runs away),
        /// the phase transitions and sampling happen on the same pinned-timestep ticks, so
        /// transient behaviour (camera follow on stop, recoil, knockback, ...) is
        /// reproducible. Game-agnostic: 'driver' and 'measure' are arbitrary objects.
        /// </summary>
        private void HandleProbe(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "runtime.probe requires Play Mode (motion is only meaningful while playing)."));
                return;
            }

            // measure: locator of the object whose transform.position is sampled.
            JObject measureLocator = parameters?.Value<JObject>("measure");
            if (measureLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'measure' (a locator)."));
                return;
            }

            // driver (single-driver form): { locator, type_name, property_path } — the
            // property/field set each phase via phases[].value. OPTIONAL when each phase
            // instead supplies its own phases[].drivers[] (multi-driver form). Both forms
            // share one sampling loop; per phase we apply EITHER the single-driver value OR
            // that phase's drivers[] list.
            JObject driver = parameters?.Value<JObject>("driver");
            bool hasSingleDriver = driver != null;

            JArray phasesParam = parameters?.Value<JArray>("phases");
            if (phasesParam == null || phasesParam.Count == 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'phases' (a non-empty array)."));
                return;
            }

            int captureFps = parameters?.Value<int?>("captureFps") ?? 120;
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'captureFps' must be >= 0."));
                return;
            }
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? false;

            // After the probe's final phase we re-apply every driver setter with 0, so a
            // left-set driver value (e.g. forceHorizontal=1) does NOT keep driving the
            // player during the inter-call gap before the next MCP call (the editor still
            // ticks the sim between calls, so a stuck force runs the player off the level
            // into a KillZone / into the flag = a false win). Numeric drivers zero cleanly;
            // non-numeric drivers (bool/string) are skipped (their reset attempt is
            // swallowed). Pass resetDriversOnEnd:false to leave the last value applied.
            bool resetDriversOnEnd = parameters?.Value<bool?>("resetDriversOnEnd") ?? true;

            GameObject measureGo;
            // Single-driver path: one setter + one value per phase (back-compat).
            Component singleDriverComponent = null;
            Action<JToken> applySingleDriverValue = null;
            var phaseValues = new List<JToken>();
            // Multi-driver path: a (setter, value) list per phase. Setters are cached so we
            // resolve each (locator,type,member) once, not every tick.
            var phaseDriverSetters = new List<List<(Action<JToken> setter, JToken value)>>();
            var setterCache = new Dictionary<string, Action<JToken>>();
            // Track every component referenced so the tick can detect destruction.
            var allDriverComponents = new List<Component>();
            // Every distinct driver setter, so we can zero them out when the probe ends.
            var allDriverSetters = new List<Action<JToken>>();
            var phaseDurationsMs = new List<double>();
            try
            {
                measureGo = LocatorResolver.Resolve(measureLocator);

                if (hasSingleDriver)
                {
                    JObject driverLocator = driver.Value<JObject>("locator");
                    string driverType = driver.Value<string>("type_name");
                    string driverMember = driver.Value<string>("property_path");
                    if (driverLocator == null || string.IsNullOrEmpty(driverType) || string.IsNullOrEmpty(driverMember))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            "Missing/invalid 'driver': expected { locator, type_name, property_path }.");
                    singleDriverComponent = ResolveDriverComponent(driverLocator, driverType);
                    allDriverComponents.Add(singleDriverComponent);
                    applySingleDriverValue = BuildDriverSetter(singleDriverComponent, driverMember);
                    allDriverSetters.Add(applySingleDriverValue);
                }

                foreach (JToken phaseTok in phasesParam)
                {
                    JObject phase = phaseTok as JObject;
                    if (phase == null || phase["durationMs"] == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each phase must include 'durationMs'.");
                    double durMs = phase.Value<double>("durationMs");
                    if (durMs <= 0)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Phase 'durationMs' must be > 0.");
                    phaseDurationsMs.Add(durMs);

                    JArray phaseDrivers = phase.Value<JArray>("drivers");
                    if (phaseDrivers != null && phaseDrivers.Count > 0)
                    {
                        // Multi-driver phase: set every listed driver at this phase boundary.
                        var setters = new List<(Action<JToken>, JToken)>();
                        foreach (JToken dTok in phaseDrivers)
                        {
                            JObject d = dTok as JObject;
                            JObject dLoc = d?.Value<JObject>("locator");
                            string dType = d?.Value<string>("type_name");
                            string dMember = d?.Value<string>("property_path");
                            if (dLoc == null || string.IsNullOrEmpty(dType) || string.IsNullOrEmpty(dMember) || d["value"] == null)
                                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                    "Each phase driver must be { locator, type_name, property_path, value }.");

                            string cacheKey = dLoc.ToString(Newtonsoft.Json.Formatting.None) + "|" + dType + "|" + dMember;
                            if (!setterCache.TryGetValue(cacheKey, out Action<JToken> setter))
                            {
                                Component comp = ResolveDriverComponent(dLoc, dType);
                                allDriverComponents.Add(comp);
                                setter = BuildDriverSetter(comp, dMember);
                                setterCache[cacheKey] = setter;
                                allDriverSetters.Add(setter);
                            }
                            setters.Add((setter, d["value"]));
                        }
                        phaseDriverSetters.Add(setters);
                        phaseValues.Add(phaseDrivers); // record drivers payload as the phase 'value'
                    }
                    else
                    {
                        // Single-driver phase: needs the top-level driver + a 'value'.
                        if (!hasSingleDriver)
                            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                "Phase has no 'drivers' and no top-level 'driver' provided. Supply phases[].drivers[] or a top-level 'driver' + phases[].value.");
                        if (phase["value"] == null)
                            throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Single-driver phase must include 'value'.");
                        var setters = new List<(Action<JToken>, JToken)>
                        {
                            (applySingleDriverValue, phase["value"])
                        };
                        phaseDriverSetters.Add(setters);
                        phaseValues.Add(phase["value"]);
                    }
                }
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            // Cumulative phase end times (game-seconds).
            var cumulativeEndSec = new double[phaseValues.Count];
            double acc = 0;
            for (int i = 0; i < phaseDurationsMs.Count; i++) { acc += phaseDurationsMs[i] / 1000.0; cumulativeEndSec[i] = acc; }
            double totalSec = acc;

            // The project's physics timestep BEFORE this measurement, echoed in the
            // result so a re-derivation can bind ticks to seconds without the writer
            // typing the number (stage 3; see ComputeProbeResult).
            float projectFixedTimestep = Time.fixedDeltaTime;

            // Force the sim to advance while backgrounded and pin the timestep, same as
            // measure_motion — this is what makes the run deterministic and focus-independent.
            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0) Time.captureDeltaTime = 1f / captureFps;

            const int maxSamples = 200000;
            var samples = new List<(double t, Vector3 pos, int phase)>(4096);
            int lastAppliedPhase = -1;
            double startTime = -1;
            bool finished = false;
            EditorApplication.CallbackFunction tick = null;
            // Keep any held input session alive for the whole probe window (see
            // measure_motion). Released in cleanup on every exit path.
            IDisposable keepAlive = null;

            Action cleanup = () =>
            {
                keepAlive?.Dispose();
                EditorApplication.update -= tick;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            tick = () =>
            {
                if (finished) return;
                if (measureGo == null || AnyDriverDestroyed(allDriverComponents))
                {
                    finished = true; cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND, "Measured or driver object was destroyed during probe."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsed = now - startTime;

                int phase = phaseValues.Count - 1;
                for (int i = 0; i < cumulativeEndSec.Length; i++)
                {
                    if (elapsed < cumulativeEndSec[i]) { phase = i; break; }
                }

                if (phase != lastAppliedPhase)
                {
                    try
                    {
                        foreach (var (setter, value) in phaseDriverSetters[phase])
                            setter(value);
                    }
                    catch (Exception ex)
                    {
                        finished = true; cleanup();
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"Failed to set driver value: {ex.Message}", ex));
                        return;
                    }
                    lastAppliedPhase = phase;
                }

                samples.Add((now, measureGo.transform.position, phase));

                if (elapsed >= totalSec || samples.Count >= maxSamples)
                {
                    finished = true;
                    // Zero out the last-set driver values BEFORE detaching the tick, while
                    // the driver components are still alive, so no force lingers into the
                    // inter-call gap. Best-effort: skip drivers that can't take 0.
                    if (resetDriversOnEnd)
                        ResetDriverSetters(allDriverSetters);
                    cleanup();
                    try { respond(ComputeProbeResult(samples, phaseValues, phaseDurationsMs, includeSamples, captureFps, projectFixedTimestep, Time.fixedDeltaTime)); }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"runtime.probe result computation failed: {ex.Message}", ex));
                    }
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.update += tick;
        }

        /// <summary>
        /// Drives the same phased runtime sequence as runtime.probe, but captures named
        /// screenshots inside that single deterministic loop. This removes the race where
        /// the agent probes a jump, then screenshots after the editor has advanced past the
        /// interesting state. Capture triggers are deliberately small and generic:
        ///   - start: first tick before gameplay has advanced
        ///   - end: final tick of the sequence
        ///   - atMs: first tick at/after a target elapsed time
        ///   - apexY: first tick after the measured object's Y starts descending
        /// </summary>
        private void HandleCaptureSequence(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "runtime.capture_sequence requires Play Mode."));
                return;
            }

            JObject measureLocator = parameters?.Value<JObject>("measure");
            if (measureLocator == null)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'measure' (a locator)."));
                return;
            }

            JArray phasesParam = parameters?.Value<JArray>("phases");
            if (phasesParam == null || phasesParam.Count == 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'phases' (a non-empty array)."));
                return;
            }

            JArray capturesParam = parameters?.Value<JArray>("captures");
            if (capturesParam == null || capturesParam.Count == 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'captures' (a non-empty array)."));
                return;
            }

            int captureFps = parameters?.Value<int?>("captureFps") ?? 120;
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'captureFps' must be >= 0."));
                return;
            }
            bool includeSamples = parameters?.Value<bool?>("includeSamples") ?? false;
            bool resetDriversOnEnd = parameters?.Value<bool?>("resetDriversOnEnd") ?? true;
            // Measurement provenance, same three fields as the probe (stage 3).
            float projectFixedTimestep = Time.fixedDeltaTime;

            GameObject measureGo;
            var phaseValues = new List<JToken>();
            var phaseDriverSetters = new List<List<(Action<JToken> setter, JToken value)>>();
            var setterCache = new Dictionary<string, Action<JToken>>();
            var allDriverComponents = new List<Component>();
            var allDriverSetters = new List<Action<JToken>>();
            var phaseDurationsMs = new List<double>();
            List<CaptureSpec> captureSpecs;
            try
            {
                measureGo = LocatorResolver.Resolve(measureLocator);
                BuildPhaseDrivers(parameters, phasesParam, phaseValues, phaseDriverSetters, setterCache,
                    allDriverComponents, allDriverSetters, phaseDurationsMs);
                captureSpecs = ParseCaptureSpecs(capturesParam);
            }
            catch (BridgeException ex) { onError(ex); return; }
            catch (Exception ex) { onError(new BridgeException(ErrorCodes.INVALID_PARAMS, ex.Message, ex)); return; }

            var cumulativeEndSec = new double[phaseValues.Count];
            double acc = 0;
            for (int i = 0; i < phaseDurationsMs.Count; i++) { acc += phaseDurationsMs[i] / 1000.0; cumulativeEndSec[i] = acc; }
            double totalSec = acc;

            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0) Time.captureDeltaTime = 1f / captureFps;

            const int maxSamples = 200000;
            var samples = new List<(double t, Vector3 pos, int phase)>(4096);
            var capturedFrames = new JArray();
            int lastAppliedPhase = -1;
            double startTime = -1;
            double previousY = double.NaN;
            double bestY = double.NegativeInfinity;
            double bestYElapsedMs = 0;
            bool finished = false;
            EditorApplication.CallbackFunction tick = null;
            // Keep any held input session alive for the whole capture window (see
            // measure_motion). Released in cleanup on every exit path.
            IDisposable keepAlive = null;

            Action cleanup = () =>
            {
                keepAlive?.Dispose();
                EditorApplication.update -= tick;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            Action<CaptureSpec, double, Vector3, int, string> captureNow = (spec, elapsedMs, pos, phase, trigger) =>
            {
                JObject shot = ScreenshotCapture.CaptureScreenshot(spec.View, spec.MaxWidth, spec.Format, spec.Quality, null, null);
                shot["id"] = spec.Id;
                shot["trigger"] = trigger;
                shot["elapsedMs"] = Math.Round(elapsedMs, 2);
                shot["phase"] = phase;
                shot["measurePosition"] = ToVector3(pos);
                capturedFrames.Add(shot);
                spec.Captured = true;
            };

            tick = () =>
            {
                if (finished) return;
                if (measureGo == null || AnyDriverDestroyed(allDriverComponents))
                {
                    finished = true; cleanup();
                    onError(new BridgeException(ErrorCodes.NOT_FOUND, "Measured or driver object was destroyed during capture_sequence."));
                    return;
                }

                double now = Time.timeAsDouble;
                if (startTime < 0) startTime = now;
                double elapsed = now - startTime;
                double elapsedMs = elapsed * 1000.0;

                int phase = phaseValues.Count - 1;
                for (int i = 0; i < cumulativeEndSec.Length; i++)
                {
                    if (elapsed < cumulativeEndSec[i]) { phase = i; break; }
                }

                if (phase != lastAppliedPhase)
                {
                    try
                    {
                        foreach (var (setter, value) in phaseDriverSetters[phase])
                            setter(value);
                    }
                    catch (Exception ex)
                    {
                        finished = true; cleanup();
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"Failed to set driver value: {ex.Message}", ex));
                        return;
                    }
                    lastAppliedPhase = phase;
                }

                Vector3 pos = measureGo.transform.position;
                samples.Add((now, pos, phase));
                if (pos.y > bestY)
                {
                    bestY = pos.y;
                    bestYElapsedMs = elapsedMs;
                }

                try
                {
                    foreach (CaptureSpec spec in captureSpecs)
                    {
                        if (spec.Captured)
                            continue;
                        if (spec.Trigger == "start" && samples.Count == 1)
                            captureNow(spec, elapsedMs, pos, phase, "start");
                        else if (spec.AtMs.HasValue && elapsedMs >= spec.AtMs.Value)
                            captureNow(spec, elapsedMs, pos, phase, "atMs");
                        else if (spec.Trigger == "apexY" && !double.IsNaN(previousY) && pos.y < previousY && previousY >= bestY - 0.0001d)
                            captureNow(spec, elapsedMs, pos, phase, "apexY");
                    }
                }
                catch (Exception ex)
                {
                    finished = true; cleanup();
                    onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"Failed to capture runtime frame: {ex.Message}", ex));
                    return;
                }

                previousY = pos.y;

                if (elapsed >= totalSec || samples.Count >= maxSamples)
                {
                    finished = true;
                    try
                    {
                        foreach (CaptureSpec spec in captureSpecs)
                        {
                            if (!spec.Captured && spec.Trigger == "end")
                                captureNow(spec, elapsedMs, pos, phase, "end");
                        }
                    }
                    catch (Exception ex)
                    {
                        cleanup();
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"Failed to capture final runtime frame: {ex.Message}", ex));
                        return;
                    }

                    if (resetDriversOnEnd)
                        ResetDriverSetters(allDriverSetters);
                    cleanup();
                    try
                    {
                        JObject result = ComputeProbeResult(samples, phaseValues, phaseDurationsMs, includeSamples,
                            captureFps, projectFixedTimestep, Time.fixedDeltaTime);
                        result["frames"] = capturedFrames;
                        result["captureCount"] = capturedFrames.Count;
                        result["requestedCaptureCount"] = captureSpecs.Count;
                        result["peakY"] = double.IsNegativeInfinity(bestY) ? 0 : bestY;
                        result["peakYElapsedMs"] = Math.Round(bestYElapsedMs, 2);
                        var missed = new JArray();
                        foreach (CaptureSpec spec in captureSpecs)
                        {
                            if (!spec.Captured)
                                missed.Add(new JObject { ["id"] = spec.Id, ["trigger"] = spec.Trigger, ["atMs"] = spec.AtMs });
                        }
                        if (missed.Count > 0)
                            result["missedCaptures"] = missed;
                        respond(result);
                    }
                    catch (Exception ex)
                    {
                        onError(new BridgeException(ErrorCodes.INVALID_PARAMS, $"runtime.capture_sequence result computation failed: {ex.Message}", ex));
                    }
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.update += tick;
        }

        /// <summary>
        /// Resolves a driver { locator, type_name } pair to a live Component, throwing a
        /// descriptive BridgeException if the type or the component cannot be found.
        /// </summary>
        private class CaptureSpec
        {
            public string Id;
            public string Trigger;
            public double? AtMs;
            public string View;
            public int MaxWidth;
            public string Format;
            public int Quality;
            public bool Captured;
        }

        private static List<CaptureSpec> ParseCaptureSpecs(JArray capturesParam)
        {
            var captures = new List<CaptureSpec>();
            foreach (JToken token in capturesParam)
            {
                JObject obj = token as JObject;
                if (obj == null)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each capture must be an object.");

                string id = obj.Value<string>("id");
                if (string.IsNullOrEmpty(id))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each capture must include non-empty 'id'.");

                double? atMs = obj.Value<double?>("atMs");
                string trigger = obj.Value<string>("trigger");
                if (string.IsNullOrEmpty(trigger))
                    trigger = atMs.HasValue ? "atMs" : "start";
                trigger = trigger.Trim();
                if (trigger != "start" && trigger != "end" && trigger != "apexY" && trigger != "atMs")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported capture trigger '{trigger}'. Valid: start, end, apexY, atMs.");
                if (trigger == "atMs" && !atMs.HasValue)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Capture trigger 'atMs' requires 'atMs'.");

                captures.Add(new CaptureSpec
                {
                    Id = id,
                    Trigger = trigger,
                    AtMs = atMs,
                    View = obj.Value<string>("view") ?? "game",
                    MaxWidth = obj.Value<int?>("maxWidth") ?? 1024,
                    Format = obj.Value<string>("format") ?? "png",
                    Quality = obj.Value<int?>("quality") ?? 75
                });
            }
            return captures;
        }

        private static void BuildPhaseDrivers(
            JObject parameters,
            JArray phasesParam,
            List<JToken> phaseValues,
            List<List<(Action<JToken> setter, JToken value)>> phaseDriverSetters,
            Dictionary<string, Action<JToken>> setterCache,
            List<Component> allDriverComponents,
            List<Action<JToken>> allDriverSetters,
            List<double> phaseDurationsMs)
        {
            JObject driver = parameters?.Value<JObject>("driver");
            bool hasSingleDriver = driver != null;
            Component singleDriverComponent = null;
            Action<JToken> applySingleDriverValue = null;

            if (hasSingleDriver)
            {
                JObject driverLocator = driver.Value<JObject>("locator");
                string driverType = driver.Value<string>("type_name");
                string driverMember = driver.Value<string>("property_path");
                if (driverLocator == null || string.IsNullOrEmpty(driverType) || string.IsNullOrEmpty(driverMember))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Missing/invalid 'driver': expected { locator, type_name, property_path }.");
                singleDriverComponent = ResolveDriverComponent(driverLocator, driverType);
                allDriverComponents.Add(singleDriverComponent);
                applySingleDriverValue = BuildDriverSetter(singleDriverComponent, driverMember);
                allDriverSetters.Add(applySingleDriverValue);
            }

            foreach (JToken phaseTok in phasesParam)
            {
                JObject phase = phaseTok as JObject;
                if (phase == null || phase["durationMs"] == null)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Each phase must include 'durationMs'.");
                double durMs = phase.Value<double>("durationMs");
                if (durMs <= 0)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Phase 'durationMs' must be > 0.");
                phaseDurationsMs.Add(durMs);

                JArray phaseDrivers = phase.Value<JArray>("drivers");
                if (phaseDrivers != null && phaseDrivers.Count > 0)
                {
                    var setters = new List<(Action<JToken>, JToken)>();
                    foreach (JToken dTok in phaseDrivers)
                    {
                        JObject d = dTok as JObject;
                        JObject dLoc = d?.Value<JObject>("locator");
                        string dType = d?.Value<string>("type_name");
                        string dMember = d?.Value<string>("property_path");
                        if (dLoc == null || string.IsNullOrEmpty(dType) || string.IsNullOrEmpty(dMember) || d["value"] == null)
                            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                "Each phase driver must be { locator, type_name, property_path, value }.");

                        string cacheKey = dLoc.ToString(Newtonsoft.Json.Formatting.None) + "|" + dType + "|" + dMember;
                        if (!setterCache.TryGetValue(cacheKey, out Action<JToken> setter))
                        {
                            Component comp = ResolveDriverComponent(dLoc, dType);
                            allDriverComponents.Add(comp);
                            setter = BuildDriverSetter(comp, dMember);
                            setterCache[cacheKey] = setter;
                            allDriverSetters.Add(setter);
                        }
                        setters.Add((setter, d["value"]));
                    }
                    phaseDriverSetters.Add(setters);
                    phaseValues.Add(phaseDrivers);
                }
                else
                {
                    if (!hasSingleDriver)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            "Phase has no 'drivers' and no top-level 'driver' provided. Supply phases[].drivers[] or a top-level 'driver' + phases[].value.");
                    if (phase["value"] == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Single-driver phase must include 'value'.");
                    var setters = new List<(Action<JToken>, JToken)>
                    {
                        (applySingleDriverValue, phase["value"])
                    };
                    phaseDriverSetters.Add(setters);
                    phaseValues.Add(phase["value"]);
                }
            }
        }

        private static Component ResolveDriverComponent(JObject locator, string typeName)
        {
            GameObject go = LocatorResolver.Resolve(locator);
            Type compType = PropertyIntrospector.ResolveComponentType(typeName);
            if (compType == null)
                throw new BridgeException(ErrorCodes.INVALID_TYPE, $"Could not resolve component type: '{typeName}'.");
            Component comp = go.GetComponent(compType);
            if (comp == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND, $"Component '{typeName}' not found on '{go.name}'.");
            return comp;
        }

        /// <summary>True if any tracked driver component has been destroyed (Unity null).</summary>
        private static bool AnyDriverDestroyed(List<Component> components)
        {
            foreach (Component c in components)
                if (c == null) return true;
            return false;
        }

        /// <summary>
        /// Resolves a writable public property or field by name on the component and
        /// returns a setter that coerces a JSON token to the member's type.
        /// </summary>
        private static Action<JToken> BuildDriverSetter(Component component, string memberName)
        {
            Type type = component.GetType();
            PropertyInfo pi = type.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance);
            if (pi != null && pi.CanWrite)
            {
                Type pt = pi.PropertyType;
                return token => pi.SetValue(component, CoerceToType(token, pt));
            }
            FieldInfo fi = type.GetField(memberName, BindingFlags.Public | BindingFlags.Instance);
            if (fi != null)
            {
                Type ft = fi.FieldType;
                return token => fi.SetValue(component, CoerceToType(token, ft));
            }
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"No writable public property/field '{memberName}' on component '{type.Name}'.");
        }

        private static object CoerceToType(JToken token, Type target)
        {
            if (target == typeof(float)) return token.Value<float>();
            if (target == typeof(double)) return token.Value<double>();
            if (target == typeof(int)) return token.Value<int>();
            if (target == typeof(bool)) return token.Value<bool>();
            if (target == typeof(string)) return token.Value<string>();
            return Convert.ChangeType(token.ToObject<object>(), target);
        }

        /// <summary>
        /// Re-applies every distinct driver setter with a 0 value so no driver-set force
        /// lingers after the probe ends. Each setter coerces the token to its member type;
        /// a numeric driver (forceHorizontal, etc.) zeros cleanly, while a bool/string
        /// driver throws on coercion of 0 — those resets are swallowed (best-effort), since
        /// "zero" is only meaningful for the numeric force fields this guard targets.
        /// </summary>
        private static void ResetDriverSetters(List<Action<JToken>> setters)
        {
            if (setters == null)
                return;

            JToken zero = new JValue(0);
            foreach (Action<JToken> setter in setters)
            {
                if (setter == null)
                    continue;
                try
                {
                    setter(zero);
                }
                catch
                {
                    // Non-numeric / read-only-at-reset driver — leave it as-is.
                }
            }
        }

        /// <summary>
        /// The probe/capture_sequence result, INCLUDING the measurement provenance the
        /// re-derivation gates require (evidence arc stage 3, ledger L75).
        ///
        /// WHY THE THREE EXTRA FIELDS. `runtime.probe` used to echo phases, sampleCount,
        /// totalDurationMs and samples, and nothing about HOW it sampled. Every feel
        /// source built on a probe (the whole-window dash) therefore had no
        /// `captureFps` and neither timestep field, and `validMeasurementSource`
        /// requires the timesteps: so the only route to a green dash was for the WRITER
        /// to type them, which is exactly what the door-one run did and disclosed
        /// (three probe sources with `captureFps: 60` and both timesteps as module
        /// constants). The measurement knows all three; echoing them removes the
        /// incentive to invent them. `captureFps` is the REQUESTED pin (0 means the
        /// capture rate was not pinned at all, which is honest to record as 0 rather
        /// than as the live rate).
        /// </summary>
        private static JObject ComputeProbeResult(
            List<(double t, Vector3 pos, int phase)> samples,
            List<JToken> phaseValues,
            List<double> phaseDurationsMs,
            bool includeSamples,
            int captureFps,
            double projectFixedTimestepBeforeMeasurement,
            double measurementFixedTimestep)
        {
            var phasesArr = new JArray();
            for (int i = 0; i < phaseValues.Count; i++)
            {
                bool any = false;
                double t0 = 0, t1 = 0;
                float sx = 0, ex = 0, sy = 0, ey = 0, minX = 0, maxX = 0, minY = 0, maxY = 0;
                int count = 0;
                foreach (var s in samples)
                {
                    if (s.phase != i) continue;
                    if (!any) { t0 = s.t; sx = s.pos.x; sy = s.pos.y; minX = maxX = s.pos.x; minY = maxY = s.pos.y; any = true; }
                    t1 = s.t; ex = s.pos.x; ey = s.pos.y;
                    if (s.pos.x < minX) minX = s.pos.x;
                    if (s.pos.x > maxX) maxX = s.pos.x;
                    if (s.pos.y < minY) minY = s.pos.y;
                    if (s.pos.y > maxY) maxY = s.pos.y;
                    count++;
                }

                var pj = new JObject
                {
                    ["index"] = i,
                    ["value"] = phaseValues[i],
                    ["requestedDurationMs"] = phaseDurationsMs[i],
                    ["sampleCount"] = count
                };
                if (any)
                {
                    pj["durationMs"] = Math.Round((t1 - t0) * 1000.0, 2);
                    pj["startX"] = sx; pj["endX"] = ex; pj["deltaX"] = ex - sx; pj["minX"] = minX; pj["maxX"] = maxX;
                    pj["startY"] = sy; pj["endY"] = ey; pj["deltaY"] = ey - sy; pj["minY"] = minY; pj["maxY"] = maxY;
                }
                phasesArr.Add(pj);
            }

            double total = samples.Count > 0 ? (samples[samples.Count - 1].t - samples[0].t) : 0;
            var result = new JObject
            {
                ["phases"] = phasesArr,
                ["sampleCount"] = samples.Count,
                ["totalDurationMs"] = Math.Round(total * 1000.0, 2),
                // Measurement provenance, the same three fields capture_input_motion
                // echoes through MotionMetrics.AttachProvenance. Emitted unconditionally
                // so an absent field always means "an older bridge", never "this run did
                // not pin anything".
                ["captureFps"] = captureFps,
                ["projectFixedTimestepBeforeMeasurement"] = Math.Round(projectFixedTimestepBeforeMeasurement, 6),
                ["measurementFixedTimestep"] = Math.Round(measurementFixedTimestep, 6)
            };

            if (includeSamples && samples.Count > 0)
            {
                double s0 = samples[0].t;
                var arr = new JArray();
                foreach (var s in samples)
                {
                    arr.Add(new JObject
                    {
                        ["tMs"] = Math.Round((s.t - s0) * 1000.0, 2),
                        ["x"] = s.pos.x,
                        ["y"] = s.pos.y,
                        ["phase"] = s.phase
                    });
                }
                result["samples"] = arr;
            }

            return result;
        }

        private static JObject EvaluateCondition(JObject parameters)
        {
            JObject locator = RequireLocator(parameters);
            GameObject go = LocatorResolver.Resolve(locator);

            string op = RequireOperator(parameters);
            string propertyPath = parameters?.Value<string>("property_path");
            if (string.IsNullOrEmpty(propertyPath))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'property_path'.");
            }

            if (parameters == null || parameters["expected"] == null)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'expected'.");
            }

            string componentTypeName = parameters.Value<string>("component");
            JToken expected = JsonValueCoercer.Rehydrate(parameters["expected"]).DeepClone();
            double tolerance = parameters.Value<double?>("tolerance") ?? 0.001d;
            string resolvedPath;
            JToken actual = ResolveActualValue(go, componentTypeName, propertyPath, out resolvedPath);

            bool passed = Compare(actual, expected, op, tolerance);

            return new JObject
            {
                ["deterministic"] = true,
                ["classification"] = passed ? ClassificationPass : ClassificationFail,
                ["failure_code"] = passed ? string.Empty : AssertionFailureCode,
                ["message"] = passed
                    ? "runtime.assert_condition deterministic pass."
                    : $"runtime.assert_condition deterministic fail for '{propertyPath}' with operator '{op}'.",
                ["passed"] = passed,
                ["operator"] = op,
                ["component"] = componentTypeName ?? string.Empty,
                ["property_path"] = propertyPath,
                ["resolved_path"] = resolvedPath,
                ["actual"] = actual?.DeepClone(),
                ["expected"] = expected,
                ["tolerance"] = tolerance
            };
        }

        private static JObject BuildWaitCondition(JObject parameters)
        {
            var waitCondition = new JObject();
            CopyIfPresent(parameters, waitCondition, "compiling");
            CopyIfPresent(parameters, waitCondition, "updating");
            CopyIfPresent(parameters, waitCondition, "playMode");
            CopyIfPresent(parameters, waitCondition, "frames");
            CopyIfPresent(parameters, waitCondition, "delayMs");
            CopyIfPresent(parameters, waitCondition, "timeoutMs");
            return waitCondition;
        }

        private static void CopyIfPresent(JObject source, JObject destination, string key)
        {
            if (source != null && source[key] != null)
                destination[key] = source[key];
        }

        private static JObject BuildTransformSnapshot(Transform transform)
        {
            return new JObject
            {
                ["position"] = ToVector3(transform.position),
                ["localPosition"] = ToVector3(transform.localPosition),
                ["eulerAngles"] = ToVector3(transform.eulerAngles),
                ["localScale"] = ToVector3(transform.localScale)
            };
        }

        private static JObject BuildObjectSnapshot(GameObject go)
        {
            return new JObject
            {
                ["name"] = go.name,
                ["scene"] = go.scene.name,
                ["activeSelf"] = go.activeSelf,
                ["activeInHierarchy"] = go.activeInHierarchy,
                ["tag"] = go.tag,
                ["layer"] = go.layer,
                ["transform"] = BuildTransformSnapshot(go.transform)
            };
        }

        private static JObject ToVector3(Vector3 value)
        {
            return new JObject
            {
                ["x"] = value.x,
                ["y"] = value.y,
                ["z"] = value.z
            };
        }

        private static JToken ResolveActualValue(GameObject go, string componentTypeName, string propertyPath, out string resolvedPath)
        {
            if (!string.IsNullOrEmpty(componentTypeName))
            {
                return ResolveComponentValue(go, componentTypeName, propertyPath, out resolvedPath);
            }

            JObject snapshot = BuildObjectSnapshot(go);
            if (!TryResolveTokenByPath(snapshot, propertyPath, out JToken resolvedToken))
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Property path '{propertyPath}' not found in runtime object snapshot.");
            }

            resolvedPath = propertyPath;
            return resolvedToken.DeepClone();
        }

        private static JToken ResolveComponentValue(
            GameObject go,
            string componentTypeName,
            string propertyPath,
            out string resolvedPath)
        {
            Type componentType = PropertyIntrospector.ResolveComponentType(componentTypeName);
            if (componentType == null)
            {
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Could not resolve component type: '{componentTypeName}'");
            }

            Component component = go.GetComponent(componentType);
            if (component == null)
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Component '{componentTypeName}' not found on '{go.name}'");
            }

            resolvedPath = FriendlyNameResolver.ResolvePropertyPath(component, propertyPath);
            JArray descriptors = PropertyIntrospector.DescribeProperties(component, null, new[] { resolvedPath });
            if (descriptors.Count == 0)
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Property '{resolvedPath}' not found on component '{componentTypeName}'.");
            }

            JToken value = descriptors[0]?["currentValue"];
            return value?.DeepClone() ?? JValue.CreateNull();
        }

        private static bool Compare(JToken actual, JToken expected, string op, double tolerance)
        {
            switch (op)
            {
                case "equals":
                    return AreEqual(actual, expected);
                case "not_equals":
                    return !AreEqual(actual, expected);
                case "greater_than":
                    return ReadNumber(actual, "actual") > ReadNumber(expected, "expected");
                case "less_than":
                    return ReadNumber(actual, "actual") < ReadNumber(expected, "expected");
                case "approx":
                    return Math.Abs(ReadNumber(actual, "actual") - ReadNumber(expected, "expected")) <= tolerance;
                case "contains":
                    return Contains(actual, expected);
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported operator '{op}'. Valid: equals, not_equals, greater_than, less_than, approx, contains.");
            }
        }

        private static bool AreEqual(JToken left, JToken right)
        {
            if (TryReadNumber(left, out double leftNumber) && TryReadNumber(right, out double rightNumber))
                return Math.Abs(leftNumber - rightNumber) <= 0.0000001d;

            return JToken.DeepEquals(left, right);
        }

        private static bool Contains(JToken actual, JToken expected)
        {
            if (actual == null || actual.Type == JTokenType.Null)
                return false;

            if (actual.Type == JTokenType.String)
            {
                string haystack = actual.Value<string>() ?? string.Empty;
                string needle = expected?.ToString() ?? string.Empty;
                return haystack.IndexOf(needle, StringComparison.Ordinal) >= 0;
            }

            if (actual is JArray array)
            {
                foreach (JToken item in array)
                {
                    if (AreEqual(item, expected))
                        return true;
                }
                return false;
            }

            if (actual is JObject obj)
            {
                if (expected?.Type == JTokenType.String)
                    return obj.Property(expected.Value<string>()) != null;

                foreach (JProperty property in obj.Properties())
                {
                    if (AreEqual(property.Value, expected))
                        return true;
                }

                return false;
            }

            throw new BridgeException(ErrorCodes.INVALID_TYPE,
                $"Operator 'contains' is not supported for actual value type '{actual.Type}'.");
        }

        private static double ReadNumber(JToken token, string label)
        {
            if (TryReadNumber(token, out double value))
                return value;

            throw new BridgeException(ErrorCodes.INVALID_TYPE,
                $"Expected numeric {label} value, got '{token?.Type.ToString() ?? "null"}'.");
        }

        private static bool TryReadNumber(JToken token, out double value)
        {
            value = 0d;
            if (token == null)
                return false;

            switch (token.Type)
            {
                case JTokenType.Integer:
                case JTokenType.Float:
                    value = token.Value<double>();
                    return true;
                default:
                    return false;
            }
        }

        private static bool TryResolveTokenByPath(JToken root, string path, out JToken resolved)
        {
            resolved = root;
            if (root == null || string.IsNullOrEmpty(path))
                return false;

            string[] segments = path.Split('.');
            foreach (string segment in segments)
            {
                if (string.IsNullOrEmpty(segment))
                    return false;

                Match match = PathSegmentRegex.Match(segment);
                if (!match.Success)
                    return false;

                string propertyName = match.Groups[1].Value;
                string indexGroup = match.Groups[2].Value;

                if (!string.IsNullOrEmpty(propertyName))
                {
                    if (!(resolved is JObject obj))
                        return false;

                    resolved = obj[propertyName];
                    if (resolved == null)
                        return false;
                }

                if (!string.IsNullOrEmpty(indexGroup))
                {
                    if (!(resolved is JArray array))
                        return false;

                    int index = int.Parse(indexGroup);
                    if (index < 0 || index >= array.Count)
                        return false;

                    resolved = array[index];
                }
            }

            return resolved != null;
        }

        private static JObject RequireLocator(JObject parameters)
        {
            JObject locator = parameters?.Value<JObject>("locator");
            if (locator == null)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");
            }

            return locator;
        }

        private static string RequireOperator(JObject parameters)
        {
            string op = parameters?.Value<string>("operator");
            if (string.IsNullOrEmpty(op))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'operator'.");
            }

            return op.Trim().ToLowerInvariant();
        }

        private static HashSet<string> ParseStringSet(JArray values)
        {
            if (values == null || values.Count == 0)
                return null;

            var parsed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JToken value in values)
            {
                string text = value?.Value<string>();
                if (!string.IsNullOrEmpty(text))
                    parsed.Add(text);
            }

            return parsed.Count > 0 ? parsed : null;
        }

        private static string[] ParseStringArray(JArray values)
        {
            if (values == null || values.Count == 0)
                return null;

            var parsed = new List<string>();
            foreach (JToken value in values)
            {
                string text = value?.Value<string>();
                if (!string.IsNullOrEmpty(text))
                    parsed.Add(text);
            }

            return parsed.Count > 0 ? parsed.ToArray() : null;
        }

        private static bool MatchesComponentFilter(HashSet<string> filters, Type componentType)
        {
            if (filters == null || filters.Count == 0)
                return true;

            return filters.Contains(componentType.Name) || filters.Contains(componentType.FullName);
        }
    }
}
