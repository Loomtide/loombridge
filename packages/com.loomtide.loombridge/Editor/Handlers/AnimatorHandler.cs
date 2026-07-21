using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles animator operations: imperative controller manipulation and
    /// declarative spec reconciliation. Graduated from AnimatorSpike.
    /// </summary>
    public class AnimatorHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "create_controller":
                    return HandleCreateController(parameters);
                case "add_parameter":
                    return HandleAddParameter(parameters);
                case "add_state":
                    return HandleAddState(parameters);
                case "set_default_state":
                    return HandleSetDefaultState(parameters);
                case "add_transition":
                    return HandleAddTransition(parameters);
                case "assign_controller":
                    return HandleAssignController(parameters);
                case "get_state_machine":
                    return HandleGetStateMachine(parameters);
                case "set_state_motion":
                    return HandleSetStateMotion(parameters);
                case "apply_spec":
                    return HandleApplySpec(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown animator op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in AnimatorHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Animator op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Imperative Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleCreateController(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            // Ensure directory exists
            string directory = System.IO.Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory) && !System.IO.Directory.Exists(directory))
            {
                string fullDir = System.IO.Path.Combine(Application.dataPath, "..",
                    directory);
                if (!System.IO.Directory.Exists(fullDir))
                    System.IO.Directory.CreateDirectory(fullDir);
            }

            // Delete existing controller if present
            if (AssetDatabase.LoadAssetAtPath<AnimatorController>(path) != null)
                AssetDatabase.DeleteAsset(path);

            AnimatorController controller = AnimatorController.CreateAnimatorControllerAtPath(path);
            EditorUtility.SetDirty(controller);
            AssetDatabase.SaveAssets();

            return new JObject
            {
                ["path"] = path,
                ["created"] = true
            };
        }

        private JObject HandleAddParameter(JObject parameters)
        {
            AnimatorController controller = LoadController(parameters);

            string paramName = parameters.Value<string>("name");
            if (string.IsNullOrEmpty(paramName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'name'");

            string paramType = parameters.Value<string>("type") ?? "Float";
            AnimatorControllerParameterType type = ParseParameterType(paramType);

            controller.AddParameter(paramName, type);

            // Set default value if specified
            var controllerParams = controller.parameters;
            for (int i = 0; i < controllerParams.Length; i++)
            {
                if (controllerParams[i].name == paramName)
                {
                    switch (type)
                    {
                        case AnimatorControllerParameterType.Float:
                            controllerParams[i].defaultFloat = parameters.Value<float?>("defaultValue") ?? 0f;
                            break;
                        case AnimatorControllerParameterType.Int:
                            controllerParams[i].defaultInt = parameters.Value<int?>("defaultValue") ?? 0;
                            break;
                        case AnimatorControllerParameterType.Bool:
                            controllerParams[i].defaultBool = parameters.Value<bool?>("defaultValue") ?? false;
                            break;
                    }
                    controller.parameters = controllerParams;
                    break;
                }
            }

            EditorUtility.SetDirty(controller);

            return new JObject
            {
                ["name"] = paramName,
                ["type"] = paramType
            };
        }

        private JObject HandleAddState(JObject parameters)
        {
            AnimatorController controller = LoadController(parameters);
            int layerIndex = parameters.Value<int?>("layer") ?? 0;

            if (layerIndex >= controller.layers.Length)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Layer index {layerIndex} out of range (controller has {controller.layers.Length} layers)");

            string stateName = parameters.Value<string>("state_name");
            if (string.IsNullOrEmpty(stateName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'state_name'");

            AnimatorStateMachine sm = controller.layers[layerIndex].stateMachine;

            JObject posObj = parameters.Value<JObject>("position");
            Vector3 pos = posObj != null
                ? new Vector3(posObj.Value<float>("x"), posObj.Value<float>("y"), 0)
                : Vector3.zero;

            sm.AddState(stateName, pos);
            EditorUtility.SetDirty(controller);

            return new JObject
            {
                ["state_name"] = stateName,
                ["layer"] = layerIndex
            };
        }

        private JObject HandleSetDefaultState(JObject parameters)
        {
            AnimatorController controller = LoadController(parameters);
            int layerIndex = parameters.Value<int?>("layer") ?? 0;

            if (layerIndex >= controller.layers.Length)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Layer index {layerIndex} out of range");

            string stateName = parameters.Value<string>("state_name");
            if (string.IsNullOrEmpty(stateName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'state_name'");

            AnimatorStateMachine sm = controller.layers[layerIndex].stateMachine;
            AnimatorState state = FindState(sm, stateName);
            if (state == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"State '{stateName}' not found in layer {layerIndex}");

            sm.defaultState = state;
            EditorUtility.SetDirty(controller);

            return new JObject
            {
                ["default_state"] = stateName,
                ["layer"] = layerIndex
            };
        }

        private JObject HandleAddTransition(JObject parameters)
        {
            AnimatorController controller = LoadController(parameters);
            int layerIndex = parameters.Value<int?>("layer") ?? 0;

            if (layerIndex >= controller.layers.Length)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Layer index {layerIndex} out of range");

            string fromName = parameters.Value<string>("from");
            if (string.IsNullOrEmpty(fromName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'from'");

            string toName = parameters.Value<string>("to");
            if (string.IsNullOrEmpty(toName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'to'");

            AnimatorStateMachine sm = controller.layers[layerIndex].stateMachine;
            AnimatorState toState = FindState(sm, toName);
            if (toState == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Destination state '{toName}' not found");

            AnimatorStateTransition transition;
            if (fromName == "*")
            {
                transition = sm.AddAnyStateTransition(toState);
            }
            else
            {
                AnimatorState fromState = FindState(sm, fromName);
                if (fromState == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Source state '{fromName}' not found");
                transition = fromState.AddTransition(toState);
            }

            // Configure transition properties
            transition.hasExitTime = parameters.Value<bool?>("hasExitTime") ?? false;
            if (transition.hasExitTime)
                transition.exitTime = parameters.Value<float?>("exitTime") ?? 0.9f;
            transition.duration = parameters.Value<float?>("duration") ?? 0.1f;

            // Add conditions
            JArray conditions = parameters.Value<JArray>("conditions");
            if (conditions != null)
            {
                foreach (JObject condSpec in conditions)
                {
                    string parameter = condSpec.Value<string>("parameter");
                    string mode = condSpec.Value<string>("mode");
                    float threshold = condSpec.Value<float?>("threshold") ?? 0f;
                    transition.AddCondition(ParseConditionMode(mode), threshold, parameter);
                }
            }

            EditorUtility.SetDirty(controller);

            return new JObject
            {
                ["from"] = fromName,
                ["to"] = toName
            };
        }

        private JObject HandleAssignController(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            if (controller == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"AnimatorController not found at: '{path}'");

            GameObject go = LocatorResolver.Resolve(locator);
            Animator animator = go.GetComponent<Animator>();
            if (animator == null)
            {
                animator = Undo.AddComponent<Animator>(go);
            }

            Undo.RecordObject(animator, $"Assign AnimatorController to {go.name}");
            animator.runtimeAnimatorController = controller;

            return new JObject
            {
                ["assigned"] = true,
                ["controller_name"] = controller.name,
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        private JObject HandleGetStateMachine(JObject parameters)
        {
            AnimatorController controller = LoadController(parameters);
            return SerializeController(controller);
        }

        /// <summary>
        /// Binds (or re-binds) the motion clip and/or playback speed of an existing
        /// state. Resolves the motion via the shared <see cref="AssetReferenceResolver"/>
        /// so a native <c>.anim</c> and an imported FBX/GLB clip sub-asset both bind
        /// through the AssetDatabase-typed reference — the Unity API sets the correct
        /// motion ref type (2 vs 3) automatically, which is exactly why this beats YAML
        /// editing. At least one of 'motion'/'speed' is required (speed-only updates are
        /// allowed). A no-op re-bind reports motionChanged/speedChanged=false and skips
        /// the SetDirty/SaveAssets write entirely.
        /// </summary>
        private JObject HandleSetStateMotion(JObject parameters)
        {
            string path = parameters.Value<string>("controller_path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'controller_path'");

            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            if (controller == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"AnimatorController not found at: '{path}'");

            int layerIndex = parameters.Value<int?>("layer") ?? 0;
            if (layerIndex < 0 || layerIndex >= controller.layers.Length)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Layer index {layerIndex} out of range (controller has {controller.layers.Length} layers)");

            string stateName = parameters.Value<string>("state_name");
            if (string.IsNullOrEmpty(stateName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'state_name'");

            AnimatorStateMachine sm = controller.layers[layerIndex].stateMachine;
            AnimatorState state = FindState(sm, stateName);
            if (state == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"State '{stateName}' not found in layer {layerIndex}");

            bool hasMotionParam = parameters.Property("motion") != null
                && parameters["motion"].Type != JTokenType.Null;
            bool hasSpeedParam = parameters.Property("speed") != null
                && parameters["speed"].Type != JTokenType.Null;
            if (!hasMotionParam && !hasSpeedParam)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide 'motion' ({ asset_path, sub_asset? }, a string asset path, or " +
                    "{ clear: true } to unbind) and/or 'speed'.");

            bool motionChanged = false;
            if (hasMotionParam)
            {
                Motion motion = ResolveStateMotion(parameters["motion"], stateName);
                if (state.motion != motion)
                {
                    state.motion = motion;
                    motionChanged = true;
                }
            }

            bool speedChanged = false;
            if (hasSpeedParam)
            {
                float speed = parameters.Value<float>("speed");
                if (Math.Abs(state.speed - speed) > 0.0001f)
                {
                    state.speed = speed;
                    speedChanged = true;
                }
            }

            if (motionChanged || speedChanged)
            {
                EditorUtility.SetDirty(controller);
                AssetDatabase.SaveAssets();
            }

            return new JObject
            {
                ["controller_path"] = path,
                ["state_name"] = stateName,
                ["layer"] = layerIndex,
                ["motion"] = state.motion != null ? state.motion.name : (string)null,
                ["motionBound"] = state.motion != null,
                ["motionChanged"] = motionChanged,
                ["speedChanged"] = speedChanged,
                ["speed"] = state.speed
            };
        }

        // ─────────────────────────────────────────────
        // Declarative Op Implementation
        // ─────────────────────────────────────────────

        private JObject HandleApplySpec(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            JObject spec = parameters.Value<JObject>("spec");
            if (spec == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'spec'");

            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);

            // Phase 1 — validate the ENTIRE spec (unknown keys anywhere in it,
            // transition endpoints, defaultState) and resolve every motion reference
            // up front (any AssetDatabase refresh-and-retry happens here). No mutation
            // occurs until the whole spec is valid, so a refused spec leaves the
            // controller untouched — and a not-yet-existing controller uncreated.
            Dictionary<string, Motion> resolvedMotions =
                ValidateSpecAndResolveMotions(controller, spec);

            if (controller == null)
            {
                string fullPath = System.IO.Path.GetFullPath(
                    System.IO.Path.Combine(Application.dataPath, "..", path));
                string directory = System.IO.Path.GetDirectoryName(fullPath);
                if (!string.IsNullOrEmpty(directory) && !System.IO.Directory.Exists(directory))
                    System.IO.Directory.CreateDirectory(directory);
                controller = AnimatorController.CreateAnimatorControllerAtPath(path);
            }

            // Phase 2 — mutate.
            JObject result = ApplySpec(controller, spec, resolvedMotions);

            AssetDatabase.SaveAssets();

            return result;
        }

        // ─────────────────────────────────────────────
        // Phase 1 — whole-spec validation (refuse-not-skip)
        // ─────────────────────────────────────────────

        private static readonly string[] SupportedSpecKeys = { "parameters", "layers" };
        private static readonly string[] SupportedParameterKeys = { "name", "type", "defaultValue" };
        private static readonly string[] SupportedLayerKeys = { "name", "defaultState", "states", "transitions" };
        private static readonly string[] SupportedStateKeys = { "name", "position", "motion", "speed" };
        private static readonly string[] SupportedTransitionKeys = { "from", "to", "hasExitTime", "exitTime", "duration", "conditions" };
        private static readonly string[] SupportedConditionKeys = { "parameter", "mode", "threshold" };
        private static readonly string[] SupportedMotionKeys = { "asset_path", "sub_asset", "clear" };

        /// <summary>
        /// Refuse-not-skip: any key the handler does not support, anywhere in the spec,
        /// is a hard INVALID_PARAMS refusal naming the key and its location — never a
        /// silent drop. Mirrors the repo-wide "refuse a missing/unknown binding, never
        /// skip" verification invariant.
        /// </summary>
        private static void RefuseUnknownKeys(JObject obj, string[] supported, string location)
        {
            List<string> unknown = null;
            foreach (JProperty prop in obj.Properties())
            {
                bool known = false;
                for (int i = 0; i < supported.Length; i++)
                {
                    if (prop.Name == supported[i]) { known = true; break; }
                }
                if (!known)
                {
                    if (unknown == null)
                        unknown = new List<string>();
                    unknown.Add(prop.Name);
                }
            }
            if (unknown != null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unsupported field(s) at {location}: {string.Join(", ", unknown)}. " +
                    $"Supported fields: {string.Join(", ", supported)}.");
        }

        private static JObject RequireObject(JToken token, string location)
        {
            JObject obj = token as JObject;
            if (obj == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"{location} must be an object.");
            return obj;
        }

        private static string MotionKey(int layerIndex, string stateName)
        {
            return layerIndex + ":" + stateName;
        }

        /// <summary>
        /// Phase 1 of apply_spec. Validates the ENTIRE spec before any mutation:
        /// unknown keys at every level (spec / parameters / layers / states /
        /// transitions / conditions / motion selectors), parameter types, condition
        /// modes, and transition endpoints + defaultState against the POST-APPLY state
        /// set (states already in the controller layer plus states this spec adds).
        /// Also resolves every state motion reference into a map, so any AssetDatabase
        /// refresh-and-retry happens here — before mutation. A refused spec throws
        /// (INVALID_PARAMS / NOT_FOUND) leaving the controller untouched.
        /// <paramref name="controller"/> may be null (controller not created yet).
        /// </summary>
        private static Dictionary<string, Motion> ValidateSpecAndResolveMotions(
            AnimatorController controller, JObject spec)
        {
            var resolvedMotions = new Dictionary<string, Motion>();

            RefuseUnknownKeys(spec, SupportedSpecKeys, "spec");

            JArray paramSpecs = spec.Value<JArray>("parameters") ?? new JArray();
            for (int i = 0; i < paramSpecs.Count; i++)
            {
                JObject paramSpec = RequireObject(paramSpecs[i], $"spec.parameters[{i}]");
                RefuseUnknownKeys(paramSpec, SupportedParameterKeys, $"spec.parameters[{i}]");
                if (string.IsNullOrEmpty(paramSpec.Value<string>("name")))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"spec.parameters[{i}] is missing required field 'name'.");
                ParseParameterType(paramSpec.Value<string>("type")); // refuses an unknown type up front
            }

            JArray layerSpecs = spec.Value<JArray>("layers") ?? new JArray();
            for (int layerIdx = 0; layerIdx < layerSpecs.Count; layerIdx++)
            {
                JObject layerSpec = RequireObject(layerSpecs[layerIdx], $"spec.layers[{layerIdx}]");
                RefuseUnknownKeys(layerSpec, SupportedLayerKeys, $"spec.layers[{layerIdx}]");

                // Endpoint checks run against the POST-APPLY state set: states already
                // present in this controller layer plus the states this spec adds.
                var postApplyStates = new HashSet<string>();
                if (controller != null && layerIdx < controller.layers.Length)
                {
                    foreach (var childState in controller.layers[layerIdx].stateMachine.states)
                        postApplyStates.Add(childState.state.name);
                }

                JArray stateSpecs = layerSpec.Value<JArray>("states") ?? new JArray();
                for (int s = 0; s < stateSpecs.Count; s++)
                {
                    JObject stateSpec = RequireObject(stateSpecs[s], $"spec.layers[{layerIdx}].states[{s}]");
                    string stateName = stateSpec.Value<string>("name");
                    RefuseUnknownKeys(stateSpec, SupportedStateKeys,
                        $"spec.layers[{layerIdx}].states[{s}]"
                        + (string.IsNullOrEmpty(stateName) ? "" : $" ('{stateName}')"));
                    if (string.IsNullOrEmpty(stateName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"spec.layers[{layerIdx}].states[{s}] is missing required field 'name'.");
                    postApplyStates.Add(stateName);

                    if (stateSpec.Property("motion") != null)
                        resolvedMotions[MotionKey(layerIdx, stateName)] =
                            ResolveStateMotion(stateSpec["motion"], stateName);
                }

                string defaultStateName = layerSpec.Value<string>("defaultState");
                if (!string.IsNullOrEmpty(defaultStateName) && !postApplyStates.Contains(defaultStateName))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"defaultState '{defaultStateName}' at spec.layers[{layerIdx}] does not name an " +
                        "existing or spec-defined state — refusing instead of skipping.");

                JArray transitionSpecs = layerSpec.Value<JArray>("transitions") ?? new JArray();
                for (int t = 0; t < transitionSpecs.Count; t++)
                {
                    JObject transSpec = RequireObject(transitionSpecs[t],
                        $"spec.layers[{layerIdx}].transitions[{t}]");
                    RefuseUnknownKeys(transSpec, SupportedTransitionKeys,
                        $"spec.layers[{layerIdx}].transitions[{t}]");

                    string fromName = transSpec.Value<string>("from");
                    string toName = transSpec.Value<string>("to");
                    if (string.IsNullOrEmpty(fromName) || string.IsNullOrEmpty(toName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"spec.layers[{layerIdx}].transitions[{t}] requires non-empty 'from' and 'to'.");
                    if (!postApplyStates.Contains(toName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Transition target '{toName}' at spec.layers[{layerIdx}].transitions[{t}] does not " +
                            "name an existing or spec-defined state — refusing instead of skipping.");
                    if (fromName != "*" && !postApplyStates.Contains(fromName))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Transition source '{fromName}' at spec.layers[{layerIdx}].transitions[{t}] does not " +
                            "name an existing or spec-defined state ('*' = AnyState) — refusing instead of skipping.");

                    JArray conditions = transSpec.Value<JArray>("conditions");
                    if (conditions != null)
                    {
                        for (int c = 0; c < conditions.Count; c++)
                        {
                            JObject condSpec = RequireObject(conditions[c],
                                $"spec.layers[{layerIdx}].transitions[{t}].conditions[{c}]");
                            RefuseUnknownKeys(condSpec, SupportedConditionKeys,
                                $"spec.layers[{layerIdx}].transitions[{t}].conditions[{c}]");
                            ParseConditionMode(condSpec.Value<string>("mode")); // refuses an unknown mode up front
                        }
                    }
                }
            }

            return resolvedMotions;
        }

        // ─────────────────────────────────────────────
        // Phase 2 — ApplySpec mutation (ported from AnimatorSpike)
        // Runs only after ValidateSpecAndResolveMotions passed; motions were
        // resolved in Phase 1 and are looked up here by (layer, state).
        // ─────────────────────────────────────────────

        private static JObject ApplySpec(AnimatorController controller, JObject spec,
            Dictionary<string, Motion> resolvedMotions)
        {
            var added = new JArray();
            var updated = new JArray();
            var unchanged = new JArray();

            // ── Parameters ──
            JArray paramSpecs = spec.Value<JArray>("parameters") ?? new JArray();
            var existingParams = new HashSet<string>(
                controller.parameters.Select(p => p.name));

            foreach (JObject paramSpec in paramSpecs)
            {
                string paramName = paramSpec.Value<string>("name");
                string paramType = paramSpec.Value<string>("type");
                AnimatorControllerParameterType type = ParseParameterType(paramType);

                if (existingParams.Contains(paramName))
                {
                    var controllerParams = controller.parameters;
                    bool needsUpdate = false;
                    for (int i = 0; i < controllerParams.Length; i++)
                    {
                        if (controllerParams[i].name == paramName)
                        {
                            if (controllerParams[i].type != type)
                            {
                                needsUpdate = true;
                                controllerParams[i].type = type;
                            }
                            switch (type)
                            {
                                case AnimatorControllerParameterType.Float:
                                    float specFloat = paramSpec.Value<float?>("defaultValue") ?? 0f;
                                    if (Math.Abs(controllerParams[i].defaultFloat - specFloat) > 0.0001f)
                                    {
                                        needsUpdate = true;
                                        controllerParams[i].defaultFloat = specFloat;
                                    }
                                    break;
                                case AnimatorControllerParameterType.Int:
                                    int specInt = paramSpec.Value<int?>("defaultValue") ?? 0;
                                    if (controllerParams[i].defaultInt != specInt)
                                    {
                                        needsUpdate = true;
                                        controllerParams[i].defaultInt = specInt;
                                    }
                                    break;
                                case AnimatorControllerParameterType.Bool:
                                    bool specBool = paramSpec.Value<bool?>("defaultValue") ?? false;
                                    if (controllerParams[i].defaultBool != specBool)
                                    {
                                        needsUpdate = true;
                                        controllerParams[i].defaultBool = specBool;
                                    }
                                    break;
                            }
                            if (needsUpdate)
                                controller.parameters = controllerParams;
                            break;
                        }
                    }

                    if (needsUpdate)
                        updated.Add($"param:{paramName}");
                    else
                        unchanged.Add($"param:{paramName}");
                }
                else
                {
                    controller.AddParameter(paramName, type);

                    var controllerParams = controller.parameters;
                    for (int i = 0; i < controllerParams.Length; i++)
                    {
                        if (controllerParams[i].name == paramName)
                        {
                            switch (type)
                            {
                                case AnimatorControllerParameterType.Float:
                                    controllerParams[i].defaultFloat = paramSpec.Value<float?>("defaultValue") ?? 0f;
                                    break;
                                case AnimatorControllerParameterType.Int:
                                    controllerParams[i].defaultInt = paramSpec.Value<int?>("defaultValue") ?? 0;
                                    break;
                                case AnimatorControllerParameterType.Bool:
                                    controllerParams[i].defaultBool = paramSpec.Value<bool?>("defaultValue") ?? false;
                                    break;
                            }
                            controller.parameters = controllerParams;
                            break;
                        }
                    }

                    added.Add($"param:{paramName}");
                }
            }

            // ── Layers + States ──
            JArray layerSpecs = spec.Value<JArray>("layers") ?? new JArray();

            for (int layerIdx = 0; layerIdx < layerSpecs.Count; layerIdx++)
            {
                JObject layerSpec = layerSpecs[layerIdx] as JObject;
                string layerName = layerSpec.Value<string>("name") ?? $"Layer {layerIdx}";

                AnimatorStateMachine sm;
                if (layerIdx < controller.layers.Length)
                {
                    sm = controller.layers[layerIdx].stateMachine;
                }
                else
                {
                    controller.AddLayer(layerName);
                    sm = controller.layers[layerIdx].stateMachine;
                    added.Add($"layer:{layerName}");
                }

                // ── States ──
                JArray stateSpecs = layerSpec.Value<JArray>("states") ?? new JArray();
                var existingStates = new Dictionary<string, AnimatorState>();
                foreach (var childState in sm.states)
                {
                    existingStates[childState.state.name] = childState.state;
                }

                var existingStatePositions = new Dictionary<string, Vector3>();
                foreach (var childState in sm.states)
                {
                    existingStatePositions[childState.state.name] = childState.position;
                }

                foreach (JObject stateSpec in stateSpecs)
                {
                    string stateName = stateSpec.Value<string>("name");

                    // Unknown-key refusal and motion resolution happened in Phase 1
                    // (ValidateSpecAndResolveMotions) — look the motion up by key.
                    bool hasMotion = stateSpec.Property("motion") != null;
                    Motion specMotion = null;
                    if (hasMotion)
                        resolvedMotions.TryGetValue(MotionKey(layerIdx, stateName), out specMotion);
                    bool hasSpeed = stateSpec.Property("speed") != null
                        && stateSpec["speed"].Type != JTokenType.Null;
                    float specSpeed = hasSpeed ? stateSpec.Value<float>("speed") : 0f;

                    if (existingStates.ContainsKey(stateName))
                    {
                        AnimatorState existing = existingStates[stateName];
                        bool changed = false;

                        JObject posObj = stateSpec.Value<JObject>("position");
                        if (posObj != null && existingStatePositions.ContainsKey(stateName))
                        {
                            Vector3 specPos = new Vector3(posObj.Value<float>("x"), posObj.Value<float>("y"), 0);
                            Vector3 currentPos = existingStatePositions[stateName];

                            if (Vector3.Distance(specPos, currentPos) > 0.01f)
                            {
                                var statesArray = sm.states;
                                for (int s = 0; s < statesArray.Length; s++)
                                {
                                    if (statesArray[s].state.name == stateName)
                                    {
                                        statesArray[s].position = specPos;
                                        break;
                                    }
                                }
                                sm.states = statesArray;
                                changed = true;
                            }
                        }

                        if (hasMotion && existing.motion != specMotion)
                        {
                            existing.motion = specMotion;
                            changed = true;
                        }

                        if (hasSpeed && Math.Abs(existing.speed - specSpeed) > 0.0001f)
                        {
                            existing.speed = specSpeed;
                            changed = true;
                        }

                        if (changed)
                            updated.Add(stateName);
                        else
                            unchanged.Add(stateName);
                    }
                    else
                    {
                        JObject posObj = stateSpec.Value<JObject>("position");
                        Vector3 pos = posObj != null
                            ? new Vector3(posObj.Value<float>("x"), posObj.Value<float>("y"), 0)
                            : Vector3.zero;

                        AnimatorState newState = sm.AddState(stateName, pos);
                        if (hasMotion)
                            newState.motion = specMotion;
                        if (hasSpeed)
                            newState.speed = specSpeed;
                        existingStates[stateName] = newState;
                        added.Add(stateName);
                    }
                }

                // ── Default state ──
                string defaultStateName = layerSpec.Value<string>("defaultState");
                if (!string.IsNullOrEmpty(defaultStateName))
                {
                    if (!existingStates.ContainsKey(defaultStateName))
                    {
                        // Phase 1 refuses a missing defaultState; defense-in-depth,
                        // never a silent skip.
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"defaultState '{defaultStateName}' not found in layer {layerIdx} — refusing.");
                    }
                    sm.defaultState = existingStates[defaultStateName];
                }

                // ── Transitions ──
                JArray transitionSpecs = layerSpec.Value<JArray>("transitions") ?? new JArray();
                foreach (JObject transSpec in transitionSpecs)
                {
                    string fromName = transSpec.Value<string>("from");
                    string toName = transSpec.Value<string>("to");

                    if (!existingStates.ContainsKey(toName))
                    {
                        // Phase 1 refuses missing endpoints; this is defense-in-depth,
                        // never a silent skip.
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Transition target '{toName}' not found in layer {layerIdx} — refusing.");
                    }

                    AnimatorState toState = existingStates[toName];
                    AnimatorStateTransition transition;

                    bool specHasExitTime = transSpec.Value<bool?>("hasExitTime") ?? false;
                    float specExitTime = transSpec.Value<float?>("exitTime") ?? 0.9f;
                    float specDuration = transSpec.Value<float?>("duration") ?? 0.1f;
                    JArray specConditions = transSpec.Value<JArray>("conditions");

                    if (fromName == "*")
                    {
                        AnimatorStateTransition existingTrans = sm.anyStateTransitions
                            .FirstOrDefault(t => t.destinationState == toState);

                        if (existingTrans != null)
                        {
                            if (TransitionNeedsUpdate(existingTrans, specHasExitTime, specExitTime, specDuration, specConditions))
                            {
                                UpdateTransitionProperties(existingTrans, specHasExitTime, specExitTime, specDuration, specConditions);
                                updated.Add($"transition:*->{toName}");
                            }
                            else
                            {
                                unchanged.Add($"transition:*->{toName}");
                            }
                            continue;
                        }

                        transition = sm.AddAnyStateTransition(toState);
                        added.Add($"transition:*->{toName}");
                    }
                    else if (existingStates.ContainsKey(fromName))
                    {
                        AnimatorState fromState = existingStates[fromName];

                        AnimatorStateTransition existingTrans = fromState.transitions
                            .FirstOrDefault(t => t.destinationState == toState);

                        if (existingTrans != null)
                        {
                            if (TransitionNeedsUpdate(existingTrans, specHasExitTime, specExitTime, specDuration, specConditions))
                            {
                                UpdateTransitionProperties(existingTrans, specHasExitTime, specExitTime, specDuration, specConditions);
                                updated.Add($"transition:{fromName}->{toName}");
                            }
                            else
                            {
                                unchanged.Add($"transition:{fromName}->{toName}");
                            }
                            continue;
                        }

                        transition = fromState.AddTransition(toState);
                        added.Add($"transition:{fromName}->{toName}");
                    }
                    else
                    {
                        // Phase 1 refuses missing endpoints; this is defense-in-depth,
                        // never a silent skip.
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Transition source '{fromName}' not found in layer {layerIdx} — refusing.");
                    }

                    // Configure new transition
                    transition.hasExitTime = specHasExitTime;
                    if (specHasExitTime)
                        transition.exitTime = specExitTime;
                    transition.duration = specDuration;

                    if (specConditions != null)
                    {
                        foreach (JObject condSpec in specConditions)
                        {
                            string parameter = condSpec.Value<string>("parameter");
                            string mode = condSpec.Value<string>("mode");
                            float threshold = condSpec.Value<float?>("threshold") ?? 0f;
                            transition.AddCondition(ParseConditionMode(mode), threshold, parameter);
                        }
                    }
                }
            }

            // Compute idempotency hash
            string specString = spec.ToString(Formatting.None);
            string hash;
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hashBytes = sha.ComputeHash(Encoding.UTF8.GetBytes(specString));
                hash = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant().Substring(0, 16);
            }

            EditorUtility.SetDirty(controller);

            return new JObject
            {
                ["added"] = added,
                ["updated"] = updated,
                ["unchanged"] = unchanged,
                ["idempotencyHash"] = hash
            };
        }

        // ─────────────────────────────────────────────
        // Serialization — ported from AnimatorSpike
        // ─────────────────────────────────────────────

        private static JObject SerializeController(AnimatorController controller)
        {
            var result = new JObject();

            // Parameters
            var paramsArray = new JArray();
            foreach (var param in controller.parameters)
            {
                var paramObj = new JObject
                {
                    ["name"] = param.name,
                    ["type"] = param.type.ToString()
                };

                switch (param.type)
                {
                    case AnimatorControllerParameterType.Float:
                        paramObj["defaultValue"] = param.defaultFloat;
                        break;
                    case AnimatorControllerParameterType.Int:
                        paramObj["defaultValue"] = param.defaultInt;
                        break;
                    case AnimatorControllerParameterType.Bool:
                        paramObj["defaultValue"] = param.defaultBool;
                        break;
                }

                paramsArray.Add(paramObj);
            }
            result["parameters"] = paramsArray;

            // Layers
            var layersArray = new JArray();
            foreach (var layer in controller.layers)
            {
                var layerObj = new JObject
                {
                    ["name"] = layer.name
                };

                AnimatorStateMachine sm = layer.stateMachine;

                // States
                var statesArray = new JArray();
                foreach (var childState in sm.states)
                {
                    var stateObj = new JObject
                    {
                        ["name"] = childState.state.name,
                        ["position"] = new JObject
                        {
                            ["x"] = childState.position.x,
                            ["y"] = childState.position.y
                        }
                    };

                    if (childState.state.transitions.Length > 0)
                    {
                        var transArray = new JArray();
                        foreach (var trans in childState.state.transitions)
                        {
                            transArray.Add(SerializeTransition(childState.state.name, trans));
                        }
                        stateObj["transitions"] = transArray;
                    }

                    statesArray.Add(stateObj);
                }
                layerObj["states"] = statesArray;

                // AnyState transitions
                if (sm.anyStateTransitions.Length > 0)
                {
                    var anyTransArray = new JArray();
                    foreach (var trans in sm.anyStateTransitions)
                    {
                        anyTransArray.Add(SerializeTransition("*", trans));
                    }
                    layerObj["anyStateTransitions"] = anyTransArray;
                }

                // Default state
                if (sm.defaultState != null)
                {
                    layerObj["defaultState"] = sm.defaultState.name;
                }

                layersArray.Add(layerObj);
            }
            result["layers"] = layersArray;

            return result;
        }

        private static JObject SerializeTransition(string fromName, AnimatorStateTransition trans)
        {
            var transObj = new JObject
            {
                ["from"] = fromName,
                ["to"] = trans.destinationState != null ? trans.destinationState.name : "(exit)",
                ["hasExitTime"] = trans.hasExitTime,
                ["exitTime"] = trans.exitTime,
                ["duration"] = trans.duration
            };

            if (trans.conditions.Length > 0)
            {
                var condsArray = new JArray();
                foreach (var cond in trans.conditions)
                {
                    condsArray.Add(new JObject
                    {
                        ["parameter"] = cond.parameter,
                        ["mode"] = cond.mode.ToString(),
                        ["threshold"] = cond.threshold
                    });
                }
                transObj["conditions"] = condsArray;
            }

            return transObj;
        }

        // ─────────────────────────────────────────────
        // Helpers — ported from AnimatorSpike
        // ─────────────────────────────────────────────

        private static bool TransitionNeedsUpdate(
            AnimatorStateTransition existing,
            bool specHasExitTime, float specExitTime, float specDuration,
            JArray specConditions)
        {
            if (existing.hasExitTime != specHasExitTime) return true;
            if (specHasExitTime && Math.Abs(existing.exitTime - specExitTime) > 0.0001f) return true;
            if (Math.Abs(existing.duration - specDuration) > 0.0001f) return true;

            var existingConds = existing.conditions;
            int specCondCount = specConditions?.Count ?? 0;
            if (existingConds.Length != specCondCount) return true;

            if (specConditions != null)
            {
                for (int i = 0; i < specCondCount; i++)
                {
                    JObject condSpec = specConditions[i] as JObject;
                    string specParam = condSpec.Value<string>("parameter");
                    AnimatorConditionMode specMode = ParseConditionMode(condSpec.Value<string>("mode"));
                    float specThreshold = condSpec.Value<float?>("threshold") ?? 0f;

                    bool found = false;
                    foreach (var ec in existingConds)
                    {
                        if (ec.parameter == specParam && ec.mode == specMode
                            && Math.Abs(ec.threshold - specThreshold) < 0.0001f)
                        {
                            found = true;
                            break;
                        }
                    }
                    if (!found) return true;
                }
            }

            return false;
        }

        private static void UpdateTransitionProperties(
            AnimatorStateTransition transition,
            bool specHasExitTime, float specExitTime, float specDuration,
            JArray specConditions)
        {
            transition.hasExitTime = specHasExitTime;
            if (specHasExitTime)
                transition.exitTime = specExitTime;
            transition.duration = specDuration;

            // Clear existing conditions and re-add from spec
            transition.conditions = new AnimatorCondition[0];

            if (specConditions != null)
            {
                foreach (JObject condSpec in specConditions)
                {
                    string parameter = condSpec.Value<string>("parameter");
                    string mode = condSpec.Value<string>("mode");
                    float threshold = condSpec.Value<float?>("threshold") ?? 0f;
                    transition.AddCondition(ParseConditionMode(mode), threshold, parameter);
                }
            }
        }

        private static AnimatorControllerParameterType ParseParameterType(string type)
        {
            switch (type)
            {
                case "Float": return AnimatorControllerParameterType.Float;
                case "Int": return AnimatorControllerParameterType.Int;
                case "Bool": return AnimatorControllerParameterType.Bool;
                case "Trigger": return AnimatorControllerParameterType.Trigger;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unknown parameter type: '{type}'. Valid: Float, Int, Bool, Trigger");
            }
        }

        private static AnimatorConditionMode ParseConditionMode(string mode)
        {
            switch (mode)
            {
                case "If": return AnimatorConditionMode.If;
                case "IfNot": return AnimatorConditionMode.IfNot;
                case "Greater": return AnimatorConditionMode.Greater;
                case "Less": return AnimatorConditionMode.Less;
                case "Equals": return AnimatorConditionMode.Equals;
                case "NotEqual": return AnimatorConditionMode.NotEqual;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unknown condition mode: '{mode}'. Valid: If, IfNot, Greater, Less, Equals, NotEqual");
            }
        }

        /// <summary>
        /// Loads an AnimatorController from the 'path' parameter.
        /// </summary>
        private static AnimatorController LoadController(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            if (controller == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"AnimatorController not found at: '{path}'");

            return controller;
        }

        /// <summary>
        /// Resolves a state motion clip from a spec token: a string asset path, or an
        /// object <c>{ asset_path, sub_asset? }</c> (sub_asset selects a named clip out
        /// of an imported FBX/GLB), or <c>{ clear: true }</c>/null to unbind. Any other
        /// key in the motion object is refused (a typo'd selector must never bind an
        /// arbitrary clip). Resolution goes through the shared
        /// <see cref="AssetReferenceResolver"/> (refresh-and-retry once), so both a
        /// native <c>.anim</c> and an imported clip sub-asset bind via the
        /// AssetDatabase-typed reference. When no sub_asset is given and the container
        /// holds MORE THAN ONE Motion-assignable sub-asset, refuses listing the
        /// candidates instead of silently binding the first. Refuses (INVALID_PARAMS)
        /// when the resolved asset is not an AnimationClip/Motion.
        /// </summary>
        private static Motion ResolveStateMotion(JToken motionToken, string stateName)
        {
            if (motionToken == null || motionToken.Type == JTokenType.Null)
                return null;

            string assetPath;
            string subAsset = null;

            if (motionToken.Type == JTokenType.String)
            {
                assetPath = motionToken.Value<string>();
            }
            else if (motionToken.Type == JTokenType.Object)
            {
                JObject mo = (JObject)motionToken;
                RefuseUnknownKeys(mo, SupportedMotionKeys, $"state '{stateName}' motion");
                if (mo.Value<bool?>("clear") ?? false)
                    return null;
                assetPath = mo.Value<string>("asset_path");
                subAsset = mo.Value<string>("sub_asset");
            }
            else
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"State '{stateName}' motion must be a string asset path or an object {{ asset_path, sub_asset? }}.");
            }

            if (string.IsNullOrEmpty(assetPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"State '{stateName}' motion requires an 'asset_path'.");

            UnityEngine.Object obj = AssetReferenceResolver.LoadWithRefreshRetry(
                assetPath, typeof(Motion), subAsset, refuseAmbiguousTypedMatch: true);
            Motion motion = obj as Motion;
            if (motion == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Asset at '{assetPath}'" +
                    (string.IsNullOrEmpty(subAsset) ? "" : $" (sub-asset '{subAsset}')") +
                    $" is not an AnimationClip/Motion (resolved a '{obj.GetType().Name}'). " +
                    "A state motion must be an AnimationClip (native .anim or an imported FBX/GLB clip) or a BlendTree.");
            return motion;
        }

        /// <summary>
        /// Finds a state by name in a state machine.
        /// </summary>
        private static AnimatorState FindState(AnimatorStateMachine sm, string stateName)
        {
            foreach (var childState in sm.states)
            {
                if (childState.state.name == stateName)
                    return childState.state;
            }
            return null;
        }
    }
}
