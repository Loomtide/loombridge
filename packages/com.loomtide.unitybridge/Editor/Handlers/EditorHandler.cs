using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.PackageManager;
using UnityEngine;
using UnityEngine.Rendering;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles editor-level operations: screenshots, play mode control,
    /// state queries, console access, undo groups, and deterministic waits.
    /// </summary>
    public class EditorHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return opName == "wait_for" || opName == "tick";
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "screenshot":
                    return HandleScreenshot(parameters);
                case "set_game_view_size":
                    return HandleSetGameViewSize(parameters);
                case "focus_game_view":
                    return HandleFocusGameView();
                case "get_state":
                    return HandleGetState(parameters);
                case "get_project_diagnostics":
                    return HandleGetProjectDiagnostics(parameters);
                case "audit_mobile_assets":
                    return HandleAuditMobileAssets(parameters);
                case "play":
                    return HandlePlay(parameters);
                case "stop":
                    return HandleStop(parameters);
                case "pause":
                    return HandlePause(parameters);
                case "set_run_in_background":
                    return HandleSetRunInBackground(parameters);
                case "console_logs":
                    return HandleConsoleLogs(parameters);
                case "clear_console":
                    return HandleClearConsole(parameters);
                case "begin_undo_group":
                    return HandleBeginUndoGroup(parameters);
                case "end_undo_group":
                    return HandleEndUndoGroup(parameters);
                case "refresh_assets":
                    return HandleRefreshAssets(parameters);
                case "set_show_work":
                    return HandleSetShowWork(parameters);
                case "show_work_pulse":
                    return HandleShowWorkPulse(parameters);
                case "execute_menu_item":
                    return HandleExecuteMenuItem(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown editor op: '{opName}'");
            }
        }

        /// <summary>
        /// RCL-T06: run an Editor menu item by path via EditorApplication.ExecuteMenuItem,
        /// STRICTLY gated by the project-configurable allowlist. This is a code-execution
        /// surface (a menu can build, delete, or mutate the project), so a menuPath that is
        /// not on the allowlist is REFUSED — never invoked. Menu items have no built-in
        /// default; a project opts each one in via menuItems[] in .loomtide/editor-allowlist.json.
        /// Enables the re-runnable Editor-builder-script pattern (a [MenuItem] that rebuilds a
        /// blockout) without exposing arbitrary menu execution.
        /// </summary>
        private JObject HandleExecuteMenuItem(JObject parameters)
        {
            string menuPath = parameters?.Value<string>("menuPath");
            if (string.IsNullOrWhiteSpace(menuPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'menuPath'");
            menuPath = menuPath.Trim();

            EditorInvokeAllowlist allowlist = EditorInvokeAllowlist.Load();
            if (!allowlist.IsMenuItemAllowed(menuPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"editor.execute_menu_item refused '{menuPath}': not on the allowlist [{allowlist.MenuItemsForError()}]. " +
                    $"Menu items are a code-execution surface; add \"{menuPath}\" to menuItems[] in {EditorInvokeAllowlist.ConfigRelativePath} to enable it.");

            bool executed = EditorApplication.ExecuteMenuItem(menuPath);
            return new JObject
            {
                ["menuPath"] = menuPath,
                // false means the gate passed but Unity found no enabled menu item at that path
                // (wrong path, or the item's validate function disabled it) — distinct from a refusal.
                ["executed"] = executed,
            };
        }

        private JObject HandleRefreshAssets(JObject parameters)
        {
            AssetDatabase.Refresh(ImportAssetOptions.Default);
            return new JObject
            {
                ["refreshed"] = true,
                ["is_compiling"] = EditorApplication.isCompiling,
                ["is_updating"] = EditorApplication.isUpdating
            };
        }

        private JObject HandleSetShowWork(JObject parameters)
        {
            bool enabled = parameters?.Value<bool?>("enabled") ?? true;
            ShowWorkVisualizer.Enabled = enabled;
            return new JObject
            {
                ["show_work_enabled"] = ShowWorkVisualizer.Enabled
            };
        }

        private JObject HandleShowWorkPulse(JObject parameters)
        {
            JObject locator = JsonValueCoercer.Rehydrate(parameters?["locator"]) as JObject;
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "show_work_pulse requires locator.");

            GameObject go = LocatorResolver.Resolve(locator);
            string note = parameters?.Value<string>("note");
            bool frame = parameters?.Value<bool?>("frame") ?? false;
            string componentType = parameters?.Value<string>("component_type");
            Component component = null;
            if (!string.IsNullOrEmpty(componentType))
                component = go.GetComponent(componentType);

            ShowWorkVisualizer.PulseImportantObject(go, note, frame, component);
            return new JObject
            {
                ["show_work_enabled"] = ShowWorkVisualizer.Enabled,
                ["name"] = go.name,
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["component_expanded"] = component != null
            };
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            switch (opName)
            {
                case "wait_for":
                    HandleWaitFor(parameters, respond, onError);
                    break;
                case "tick":
                    HandleTick(parameters, respond, onError);
                    break;
                default:
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Editor op '{opName}' is not async."));
                    break;
            }
        }

        // ─────────────────────────────────────────────
        // Sync Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleScreenshot(JObject parameters)
        {
            string view = parameters?.Value<string>("view") ?? "scene";
            int maxWidth = parameters?.Value<int?>("maxWidth") ?? 1024;
            string format = parameters?.Value<string>("format") ?? "jpeg";
            int quality = parameters?.Value<int?>("quality") ?? 75;
            // Rehydrate in case a client pre-stringified these structured args (some MCP
            // hosts stringify values whose schema type they don't know).
            JObject focusLocator = JsonValueCoercer.Rehydrate(parameters?["focusLocator"]) as JObject;
            JArray annotateBounds = JsonValueCoercer.Rehydrate(parameters?["annotateBounds"]) as JArray;

            return ScreenshotCapture.CaptureScreenshot(
                view, maxWidth, format, quality, focusLocator, annotateBounds);
        }

        /// <summary>
        /// Sets the Game View render resolution to {width, height} px so a Scale-With-Screen-Size
        /// uGUI canvas re-lays-out at that aspect (CanvasScaler re-evaluates). Returns the applied
        /// size + aspect plus the previous size so the caller can restore it. The op is idempotent:
        /// to restore, call again with previousWidth/previousHeight.
        /// </summary>
        private JObject HandleSetGameViewSize(JObject parameters)
        {
            int? width = parameters?.Value<int?>("width");
            int? height = parameters?.Value<int?>("height");
            if (width == null || height == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "set_game_view_size requires integer 'width' and 'height'.");
            if (width.Value <= 0 || height.Value <= 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "set_game_view_size 'width' and 'height' must be positive.");

            GameViewSizing.SetResult r = GameViewSizing.SetSize(width.Value, height.Value);
            if (!r.Ok)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"set_game_view_size failed: {r.Error}");

            float aspect = r.Height > 0 ? (float)r.Width / r.Height : 0f;
            return new JObject
            {
                ["width"] = r.Width,
                ["height"] = r.Height,
                ["aspect"] = aspect,
                ["previousWidth"] = r.PreviousWidth,
                ["previousHeight"] = r.PreviousHeight
            };
        }

        // RCL-T09: focus is best-effort, never a hard block. A headless/background editor often
        // can't acquire OS Game-View focus, which used to hard-fail FOCUS_REQUIRED and strand any
        // sim-driving flow. Instead, when focus can't be grabbed we degrade gracefully: enable
        // Application.runInBackground (in Play Mode) so the player loop keeps ticking unfocused —
        // the same lever measure_motion / editor.tick pull — and return a SOFT success with
        // focusDegraded:true. Callers proceed: deterministic sim-advance (editor.tick) and the
        // in-loop capture ops don't need real OS focus.
        private JObject HandleFocusGameView()
        {
            bool available = GameViewFocus.IsGameViewAvailable();
            bool focused = available && GameViewFocus.EnsureGameViewFocused();

            if (focused)
            {
                return new JObject
                {
                    ["gameViewAvailable"] = available,
                    ["gameViewFocused"] = true,
                    ["focusDegraded"] = false
                };
            }

            bool runInBackground = Application.runInBackground;
            if (EditorApplication.isPlaying)
            {
                Application.runInBackground = true;
                runInBackground = Application.runInBackground;
            }

            return new JObject
            {
                ["gameViewAvailable"] = available,
                ["gameViewFocused"] = false,
                ["focusDegraded"] = true,
                ["runInBackground"] = runInBackground,
                ["note"] = "Could not acquire Game View focus; enabled runInBackground so the player " +
                           "loop still ticks unfocused. Use editor.tick for a deterministic sim-advance."
            };
        }

        private JObject HandleGetState(JObject parameters)
        {
            string playMode;
            if (EditorApplication.isPlaying)
            {
                playMode = EditorApplication.isPaused ? "paused" : "playing";
            }
            else
            {
                playMode = "stopped";
            }

            JToken selectedLocator = JValue.CreateNull();
            if (Selection.activeGameObject != null)
            {
                selectedLocator = LocatorResolver.BuildLocator(Selection.activeGameObject);
            }

            var state = new JObject
            {
                ["play_mode"] = playMode,
                ["paused"] = EditorApplication.isPaused,
                ["compiling"] = EditorApplication.isCompiling,
                ["updating"] = EditorApplication.isUpdating,
                ["show_work_enabled"] = ShowWorkVisualizer.Enabled,
                ["selected_object_locator"] = selectedLocator
            };

            // Surface console errors/exceptions so a thrown exception in Play Mode can't be silently
            // missed (clear_console before play, then error_count > 0 here flags it; pull console_logs
            // for the full stack).
            JObject errors = TraceCollector.GetErrorSummary();
            state["error_count"] = errors["error_count"];
            if (errors["last_error"] != null)
                state["last_error"] = errors["last_error"];

            // GRL-B01: surface a pre-existing COMPILE error (distinct from a runtime console error —
            // a compile error keeps error_count at 0 because no new edit recompiled). Present only
            // when a compile error is affirmatively detected, so a green editor's get_state is
            // unchanged. This is what editor.play settle-failure attribution reads.
            JObject compileError = CompileWatcher.GetCompileErrorState();
            if (compileError != null)
                state["compile_error"] = compileError;

            return state;
        }

        // Known OPTIONAL built-in Unity modules (com.unity.modules.*) whose ABSENCE from the
        // registered-package set means they were disabled/removed from the project manifest.
        // GetAllRegisteredPackages() lists enabled built-in modules as regular packages, so a
        // module in this list that is NOT registered is genuinely disabled. The list is
        // intentionally focused on modules that break generated gameplay/FX/import code when
        // missing — the dogfood incident was ParticleSystem + ScreenCapture disabled while
        // error_count stayed 0. Always-on core modules are omitted (they never read as disabled).
        private static readonly string[] KnownOptionalBuiltInModules =
        {
            "com.unity.modules.particlesystem",
            "com.unity.modules.physics",
            "com.unity.modules.physics2d",
            "com.unity.modules.animation",
            "com.unity.modules.audio",
            "com.unity.modules.video",
            "com.unity.modules.screencapture",
            "com.unity.modules.terrain",
            "com.unity.modules.terrainphysics",
            "com.unity.modules.ui",
            "com.unity.modules.uielements",
            "com.unity.modules.imgui",
            "com.unity.modules.tilemap",
            "com.unity.modules.ai",
            "com.unity.modules.imageconversion",
            "com.unity.modules.cloth",
            "com.unity.modules.vehicles",
            "com.unity.modules.wind",
            "com.unity.modules.director",
            "com.unity.modules.unitywebrequest",
            "com.unity.modules.unitywebrequesttexture",
            "com.unity.modules.unitywebrequestaudio",
            "com.unity.modules.vr",
            "com.unity.modules.xr",
        };

        /// <summary>
        /// Project-level capability diagnostics — the "why does a symbol/module appear missing
        /// while error_count stays 0?" probe from the late-polish dogfood learnings §10. Reports
        /// the Unity version, active render pipeline, the installed package set, a best-effort
        /// list of disabled built-in modules (null + package_query_failed when the package query
        /// broke), editor/player script-assembly counts, and the last compile result. Results
        /// reflect the package registry at call time — very early after a domain reload the
        /// registry may still be resolving.
        /// </summary>
        private JObject HandleGetProjectDiagnostics(JObject parameters)
        {
            var result = new JObject
            {
                ["unity_version"] = Application.unityVersion,
                ["render_pipeline"] = DetectRenderPipeline(),
            };

            HashSet<string> installedNames;
            result["installed_packages"] = CollectInstalledPackages(out installedNames);

            // D2: query failure must be distinguishable from "genuinely none disabled". A null
            // (or empty — every project resolves core modules, so an empty set means the query
            // broke) installed set yields disabled_built_in_modules: null +
            // package_query_failed: true — NEVER an empty array. [] is reserved for the positive
            // claim "the query worked and every known optional module is enabled".
            bool packageQueryFailed = installedNames == null || installedNames.Count == 0;
            result["package_query_failed"] = packageQueryFailed;
            result["disabled_built_in_modules"] = packageQueryFailed
                ? (JToken)JValue.CreateNull()
                : CollectDisabledBuiltInModules(installedNames);

            // Script-assembly counts (the compilation graph) as a coarse "is the build what I
            // expect?" signal. D3: the parameterless GetAssemblies() returns the EDITOR assembly
            // set on current Unity — so both sets are requested explicitly and reported apart.
            result["editor_assembly_count"] = CountAssemblies(AssembliesType.Editor);
            result["player_assembly_count"] = CountAssemblies(AssembliesType.Player);

            // Latest compile result the CompileWatcher has seen (unattributed — the full last
            // compile, not scoped to a wait). Null when no compilation has completed this session.
            JObject lastCompile = CompileWatcher.GetCompileResult();
            result["last_compile"] = lastCompile ?? (JToken)JValue.CreateNull();

            return result;
        }

        // Reports the active render pipeline as { mode: URP|HDRP|built-in|custom, asset_type }.
        // currentRenderPipeline reflects any quality-level override; defaultRenderPipeline is the
        // graphics-settings fallback. A null asset means the legacy built-in pipeline.
        private static JObject DetectRenderPipeline()
        {
            RenderPipelineAsset rp = GraphicsSettings.currentRenderPipeline
                ?? GraphicsSettings.defaultRenderPipeline;

            if (rp == null)
            {
                return new JObject
                {
                    ["mode"] = "built-in",
                    ["asset_type"] = JValue.CreateNull(),
                };
            }

            string typeName = rp.GetType().Name;
            string mode;
            if (typeName.IndexOf("Universal", StringComparison.OrdinalIgnoreCase) >= 0)
                mode = "URP";
            else if (typeName.IndexOf("HDRenderPipeline", StringComparison.OrdinalIgnoreCase) >= 0
                     || typeName.IndexOf("HDRP", StringComparison.OrdinalIgnoreCase) >= 0)
                mode = "HDRP";
            else
                mode = "custom";

            return new JObject
            {
                ["mode"] = mode,
                ["asset_type"] = typeName,
            };
        }

        private static int CountAssemblies(AssembliesType type)
        {
            try
            {
                Assembly[] assemblies = CompilationPipeline.GetAssemblies(type);
                return assemblies?.Length ?? 0;
            }
            catch (Exception)
            {
                return 0;
            }
        }

        // Returns the installed package list; `names` is null when the query FAILED (threw or
        // returned null) so the caller can report failure instead of an ambiguous empty result.
        private static JArray CollectInstalledPackages(out HashSet<string> names)
        {
            var arr = new JArray();
            names = null;
            UnityEditor.PackageManager.PackageInfo[] packages;
            try
            {
                // Available since 2021.1; the project targets 6000.3. Returns direct AND indirect
                // (including built-in module) dependencies resolved for the project.
                packages = UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages();
            }
            catch (Exception)
            {
                return arr;
            }

            if (packages == null)
                return arr;

            names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (UnityEditor.PackageManager.PackageInfo p in packages)
            {
                if (p == null || string.IsNullOrEmpty(p.name))
                    continue;
                names.Add(p.name);
                arr.Add(new JObject
                {
                    ["name"] = p.name,
                    ["version"] = p.version,
                });
            }
            return arr;
        }

        // Only called with a successfully-queried, non-empty installed set — the caller reports
        // a failed/empty query as disabled_built_in_modules: null + package_query_failed: true.
        private static JArray CollectDisabledBuiltInModules(HashSet<string> installedNames)
        {
            var arr = new JArray();
            if (installedNames == null || installedNames.Count == 0)
                return arr;

            foreach (string module in KnownOptionalBuiltInModules)
            {
                if (!installedNames.Contains(module))
                    arr.Add(module);
            }
            return arr;
        }

        // ─────────────────────────────────────────────
        //  editor.audit_mobile_assets  (RLT2 mobile-audit; late-polish learnings §9)
        // ─────────────────────────────────────────────
        //
        // Mobile optimization begins with a WEIGHT audit, not a guess: the dogfood incident
        // was a 30.7k-triangle T-wall mesh instanced 57× dominating the frame while textures
        // took the blame. This op measures that weight so the advisory report (loomtide
        // mobile-audit) can flag offenders BEFORE any change is made.
        //
        // SCOPE — honest and bounded (documented so the report can state it verbatim):
        //   • Textures / audio / meshes are collected ONLY from components on GameObjects in
        //     currently-LOADED scenes (UnityEngine.SceneManagement.SceneManager). This is the
        //     gameplay-relevant working set. Assets on disk that no loaded scene references are
        //     NOT walked — that keeps the pass off a full-project AssetDatabase scan (which on a
        //     large project is a multi-minute cost and would report art the level never loads).
        //   • Textures: shared-material textures of Renderers, plus SpriteRenderer sprites.
        //   • Audio: clips referenced by AudioSource components.
        //   • Meshes: sharedMesh of MeshFilter and SkinnedMeshRenderer, with an instance count =
        //     how many such components in the loaded scenes reference that same mesh asset.
        //   • render_pipeline_settings is URP-specific and reflection-safe: null + a reason when
        //     no scriptable pipeline is active or the type is not URP (never a throw).
        // OUTPUT is BOUNDED: each category is sorted by its weight (meshes by triangle_load,
        // textures by estimated bytes, audio by file bytes), truncated to max_entries (default
        // 50), and carries total_count + truncated so a big project can't blow the response.
        // Read-only: no AssetDatabase.Refresh, no scene mutation, main-thread only.
        private JObject HandleAuditMobileAssets(JObject parameters)
        {
            int maxEntries = 50;
            JToken maxToken = parameters?["max_entries"] ?? parameters?["maxEntries"];
            if (maxToken != null && maxToken.Type != JTokenType.Null)
            {
                if (maxToken.Type != JTokenType.Integer)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "'max_entries' must be a positive integer.");
                maxEntries = maxToken.Value<int>();
                if (maxEntries < 1)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "'max_entries' must be >= 1.");
            }

            // Collect the loaded-scene component working set once.
            var renderers = new List<Renderer>();
            var spriteRenderers = new List<SpriteRenderer>();
            var meshFilters = new List<MeshFilter>();
            var skinnedMeshes = new List<SkinnedMeshRenderer>();
            var audioSources = new List<AudioSource>();

            var loadedScenePaths = new JArray();
            int sceneCount = UnityEngine.SceneManagement.SceneManager.sceneCount;
            int loadedSceneCount = 0;
            for (int i = 0; i < sceneCount; i++)
            {
                var scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
                if (!scene.isLoaded)
                    continue;
                loadedSceneCount++;
                loadedScenePaths.Add(string.IsNullOrEmpty(scene.path) ? "(unsaved)" : scene.path);
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root == null)
                        continue;
                    // includeInactive:true — an inactive object still ships its meshes/textures.
                    renderers.AddRange(root.GetComponentsInChildren<Renderer>(true));
                    spriteRenderers.AddRange(root.GetComponentsInChildren<SpriteRenderer>(true));
                    meshFilters.AddRange(root.GetComponentsInChildren<MeshFilter>(true));
                    skinnedMeshes.AddRange(root.GetComponentsInChildren<SkinnedMeshRenderer>(true));
                    audioSources.AddRange(root.GetComponentsInChildren<AudioSource>(true));
                }
            }

            var result = new JObject
            {
                // Payload discriminator: `loomtide mobile-audit` REFUSES any --input file that
                // lacks it, so a wrong file (e.g. build-verdict.json) can never render as a
                // clean "no findings" audit. Bump payload_version on breaking shape changes.
                ["payload_kind"] = "mobile_asset_audit",
                ["payload_version"] = 1,
                ["max_entries"] = maxEntries,
                ["loaded_scene_count"] = loadedSceneCount,
                ["loaded_scenes"] = loadedScenePaths,
                ["textures"] = BuildTextureAudit(renderers, spriteRenderers, maxEntries),
                ["audio"] = BuildAudioAudit(audioSources, maxEntries),
                ["meshes"] = BuildMeshAudit(meshFilters, skinnedMeshes, maxEntries),
                ["quality_settings"] = BuildQualitySettings(),
                ["build_scenes"] = BuildBuildScenes(),
            };

            // URP-specific settings are best-effort + reflection-safe: never a throw.
            JObject rpReason;
            JObject rp = BuildRenderPipelineSettings(out rpReason);
            result["render_pipeline_settings"] = rp ?? (JToken)JValue.CreateNull();
            result["render_pipeline_settings_unavailable_reason"] =
                rp == null ? (rpReason?["reason"] ?? JValue.CreateNull()) : JValue.CreateNull();

            return result;
        }

        // Textures referenced by shared materials on Renderers + SpriteRenderer sprites in the
        // loaded scenes. Deduped by texture instance ID; sorted by estimated bytes desc.
        private static JObject BuildTextureAudit(
            List<Renderer> renderers, List<SpriteRenderer> spriteRenderers, int maxEntries)
        {
            var seen = new HashSet<long>();
            var entries = new List<JObject>();

            void Consider(Texture tex)
            {
                if (tex == null || !seen.Add(EntityIdCompat.Id(tex)))
                    return;

                string assetPath = AssetDatabase.GetAssetPath(tex) ?? "";
                string format = null;
                if (tex is Texture2D t2d)
                    format = t2d.format.ToString();

                string compression = null;
                if (!string.IsNullOrEmpty(assetPath))
                {
                    var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
                    if (importer != null)
                        compression = importer.textureCompression.ToString();
                }

                long estBytes = 0;
                try { estBytes = UnityEngine.Profiling.Profiler.GetRuntimeMemorySizeLong(tex); }
                catch { estBytes = 0; }

                entries.Add(new JObject
                {
                    ["path"] = string.IsNullOrEmpty(assetPath) ? "(built-in/instance)" : assetPath,
                    ["name"] = tex.name,
                    ["width"] = tex.width,
                    ["height"] = tex.height,
                    ["format"] = format ?? (JToken)JValue.CreateNull(),
                    ["compression"] = compression ?? (JToken)JValue.CreateNull(),
                    ["estimated_bytes"] = estBytes,
                });
            }

            foreach (var r in renderers)
            {
                if (r == null)
                    continue;
                foreach (var mat in r.sharedMaterials)
                {
                    if (mat == null)
                        continue;
                    foreach (var propName in mat.GetTexturePropertyNames())
                        Consider(mat.GetTexture(propName));
                }
            }
            foreach (var sr in spriteRenderers)
            {
                if (sr == null || sr.sprite == null)
                    continue;
                Consider(sr.sprite.texture);
            }

            entries.Sort((a, b) => CompareByLongThenPath(a, b, "estimated_bytes"));
            return BoundedCategory(entries, maxEntries);
        }

        // Audio clips referenced by AudioSource components; sorted by file bytes desc.
        private static JObject BuildAudioAudit(List<AudioSource> audioSources, int maxEntries)
        {
            var seen = new HashSet<long>();
            var entries = new List<JObject>();

            foreach (var src in audioSources)
            {
                if (src == null || src.clip == null || !seen.Add(EntityIdCompat.Id(src.clip)))
                    continue;
                AudioClip clip = src.clip;
                string assetPath = AssetDatabase.GetAssetPath(clip) ?? "";

                string loadType = null;
                string compressionFormat = null;
                if (!string.IsNullOrEmpty(assetPath))
                {
                    var importer = AssetImporter.GetAtPath(assetPath) as AudioImporter;
                    if (importer != null)
                    {
                        var settings = importer.defaultSampleSettings;
                        loadType = settings.loadType.ToString();
                        compressionFormat = settings.compressionFormat.ToString();
                    }
                }

                long fileBytes = -1;
                if (!string.IsNullOrEmpty(assetPath))
                {
                    try
                    {
                        var fi = new System.IO.FileInfo(assetPath);
                        if (fi.Exists)
                            fileBytes = fi.Length;
                    }
                    catch { fileBytes = -1; }
                }

                entries.Add(new JObject
                {
                    ["path"] = string.IsNullOrEmpty(assetPath) ? "(built-in/instance)" : assetPath,
                    ["name"] = clip.name,
                    ["length_seconds"] = clip.length,
                    ["channels"] = clip.channels,
                    ["frequency"] = clip.frequency,
                    ["load_type"] = loadType ?? (JToken)JValue.CreateNull(),
                    ["compression_format"] = compressionFormat ?? (JToken)JValue.CreateNull(),
                    ["file_bytes"] = fileBytes < 0 ? (JToken)JValue.CreateNull() : fileBytes,
                });
            }

            entries.Sort((a, b) => CompareByLongThenPath(a, b, "file_bytes"));
            return BoundedCategory(entries, maxEntries);
        }

        // Meshes referenced by MeshFilter/SkinnedMeshRenderer, with an instance count per shared
        // mesh (the 57× wall case). triangle_load = triangle_count × instance_count; sorted desc.
        private static JObject BuildMeshAudit(
            List<MeshFilter> meshFilters, List<SkinnedMeshRenderer> skinnedMeshes, int maxEntries)
        {
            // instanceId -> (mesh, count)
            var meshes = new Dictionary<long, Mesh>();
            var counts = new Dictionary<long, int>();

            void CountRef(Mesh m)
            {
                if (m == null)
                    return;
                long id = EntityIdCompat.Id(m);
                if (!meshes.ContainsKey(id))
                {
                    meshes[id] = m;
                    counts[id] = 0;
                }
                counts[id]++;
            }

            foreach (var mf in meshFilters)
                if (mf != null) CountRef(mf.sharedMesh);
            foreach (var smr in skinnedMeshes)
                if (smr != null) CountRef(smr.sharedMesh);

            var entries = new List<JObject>();
            int unreadableCount = 0;
            foreach (var kv in meshes)
            {
                Mesh m = kv.Value;
                int instances = counts[kv.Key];
                string countReason;
                long tris = SafeTriangleCount(m, out countReason);
                string assetPath = AssetDatabase.GetAssetPath(m) ?? "";
                long triangleLoad = tris < 0 ? -1 : tris * instances;

                var entry = new JObject
                {
                    ["path"] = string.IsNullOrEmpty(assetPath) ? "(built-in/instance)" : assetPath,
                    ["name"] = m.name,
                    ["vertex_count"] = m.vertexCount,
                    ["triangle_count"] = tris < 0 ? (JToken)JValue.CreateNull() : tris,
                    ["instance_count"] = instances,
                    ["triangle_load"] = triangleLoad < 0 ? (JToken)JValue.CreateNull() : triangleLoad,
                };
                if (countReason != null)
                {
                    // A blind spot must be VISIBLE, never silent: name why the count is missing
                    // and tally it so the report can flag "the audit may be missing offenders".
                    entry["reason"] = countReason;
                    unreadableCount++;
                }
                entries.Add(entry);
            }

            entries.Sort((a, b) => CompareByLongThenPath(a, b, "triangle_load"));
            JObject category = BoundedCategory(entries, maxEntries);
            category["unreadable_count"] = unreadableCount;
            return category;
        }

        // Total triangles across every triangle-topology submesh, via Mesh.GetIndexCount —
        // which (per UnityCsReference Mesh.cs) has NO canAccess/isReadable gate: it validates the
        // submesh index and reads the SubMesh descriptor metadata the draw call itself uses, so
        // it works on NON-READABLE meshes (imported FBX defaults Read/Write OFF — the §9 wall).
        // GetIndices/GetTriangles must NOT be used here: on a non-readable mesh they log an error
        // and return an EMPTY array — a silent false-zero triangle count, the worst failure mode.
        // Non-triangle-topology submeshes (lines/points/quads) carry no triangles and are skipped.
        // Returns -1 + a reason when the count is unobtainable — reported as null triangle_count
        // so a missing number is never mistaken for a cheap zero-triangle mesh.
        private static long SafeTriangleCount(Mesh mesh, out string reason)
        {
            reason = null;
            if (mesh == null)
            {
                reason = "no mesh";
                return -1;
            }
            try
            {
                long total = 0;
                int subMeshes = mesh.subMeshCount;
                for (int s = 0; s < subMeshes; s++)
                {
                    if (mesh.GetTopology(s) != MeshTopology.Triangles)
                        continue;
                    total += mesh.GetIndexCount(s) / 3;
                }
                return total;
            }
            catch (Exception ex)
            {
                reason = "triangle count unavailable: " + ex.Message;
                return -1;
            }
        }

        // Sort helper: numeric field DESC (a null/absent value sorts last), tie-broken by path ASC
        // then name ASC so the bounded output is deterministic.
        private static int CompareByLongThenPath(JObject a, JObject b, string numericField)
        {
            long av = a[numericField] != null && a[numericField].Type != JTokenType.Null
                ? a.Value<long>(numericField) : long.MinValue;
            long bv = b[numericField] != null && b[numericField].Type != JTokenType.Null
                ? b.Value<long>(numericField) : long.MinValue;
            if (av != bv)
                return bv.CompareTo(av); // descending
            int byPath = string.CompareOrdinal(a.Value<string>("path"), b.Value<string>("path"));
            if (byPath != 0)
                return byPath;
            return string.CompareOrdinal(a.Value<string>("name"), b.Value<string>("name"));
        }

        // Wrap a sorted entry list into { entries: top-N, total_count, truncated }.
        private static JObject BoundedCategory(List<JObject> entries, int maxEntries)
        {
            int total = entries.Count;
            bool truncated = total > maxEntries;
            var arr = new JArray();
            for (int i = 0; i < entries.Count && i < maxEntries; i++)
                arr.Add(entries[i]);
            return new JObject
            {
                ["entries"] = arr,
                ["total_count"] = total,
                ["truncated"] = truncated,
            };
        }

        // Engine-wide quality settings (always available — QualitySettings is core). Shadow
        // distance/resolution/cascades + MSAA sample count read here; URP may override some of
        // these in render_pipeline_settings.
        private static JObject BuildQualitySettings()
        {
            return new JObject
            {
                ["level_name"] = QualitySettings.names != null &&
                                 QualitySettings.GetQualityLevel() < QualitySettings.names.Length
                    ? QualitySettings.names[QualitySettings.GetQualityLevel()]
                    : (JToken)JValue.CreateNull(),
                ["shadow_distance"] = QualitySettings.shadowDistance,
                ["shadow_resolution"] = QualitySettings.shadowResolution.ToString(),
                ["shadow_cascades"] = QualitySettings.shadowCascades,
                ["msaa"] = QualitySettings.antiAliasing,
                ["vsync_count"] = QualitySettings.vSyncCount,
                ["pixel_light_count"] = QualitySettings.pixelLightCount,
            };
        }

        // URP-specific render settings via REFLECTION (the bridge does not depend on the URP
        // package): returns null + a reason JObject when no scriptable pipeline is active or the
        // active pipeline is not URP. Never throws — degrades to null.
        private static JObject BuildRenderPipelineSettings(out JObject reason)
        {
            reason = null;
            RenderPipelineAsset rp = GraphicsSettings.currentRenderPipeline
                ?? GraphicsSettings.defaultRenderPipeline;

            if (rp == null)
            {
                reason = new JObject { ["reason"] = "no scriptable render pipeline active (built-in pipeline)" };
                return null;
            }

            string typeName = rp.GetType().Name;
            if (typeName.IndexOf("Universal", StringComparison.OrdinalIgnoreCase) < 0)
            {
                reason = new JObject { ["reason"] = $"active render pipeline is {typeName}, not URP; URP-specific settings not read" };
                return null;
            }

            var settings = new JObject { ["asset_type"] = typeName };
            AddReflected(settings, rp, "shadow_distance", "shadowDistance");
            AddReflected(settings, rp, "msaa_sample_count", "msaaSampleCount");
            AddReflected(settings, rp, "render_scale", "renderScale");
            AddReflected(settings, rp, "supports_hdr", "supportsHDR");
            AddReflected(settings, rp, "main_light_shadow_resolution", "mainLightShadowmapResolution");
            AddReflected(settings, rp, "shadow_cascade_count", "shadowCascadeCount");
            return settings;
        }

        // Reflect one public instance property off an object; add it under outKey when present.
        // Absent property (an older/newer URP where the name differs) is simply omitted — never a throw.
        private static void AddReflected(JObject target, object obj, string outKey, string propName)
        {
            try
            {
                var prop = obj.GetType().GetProperty(propName);
                if (prop == null)
                    return;
                object v = prop.GetValue(obj);
                if (v == null) { target[outKey] = JValue.CreateNull(); return; }
                if (v is bool b) target[outKey] = b;
                else if (v is int i) target[outKey] = i;
                else if (v is float f) target[outKey] = f;
                else if (v is double d) target[outKey] = d;
                else target[outKey] = v.ToString();
            }
            catch
            {
                // Degrade: a reflection fault leaves the key absent.
            }
        }

        // The build-scene list (EditorBuildSettings.scenes) — path + enabled flag. Small by
        // nature, so reported in full (not bounded by max_entries).
        private static JArray BuildBuildScenes()
        {
            var arr = new JArray();
            EditorBuildSettingsScene[] scenes = EditorBuildSettings.scenes;
            if (scenes == null)
                return arr;
            foreach (var s in scenes)
            {
                if (s == null)
                    continue;
                arr.Add(new JObject
                {
                    ["path"] = s.path,
                    ["enabled"] = s.enabled,
                });
            }
            return arr;
        }

        private JObject HandlePlay(JObject parameters)
        {
            EditorApplication.isPlaying = true;
            return new JObject { ["play_mode"] = "playing" };
        }

        private JObject HandleStop(JObject parameters)
        {
            EditorApplication.isPlaying = false;
            return new JObject { ["play_mode"] = "stopped" };
        }

        private JObject HandlePause(JObject parameters)
        {
            EditorApplication.isPaused = !EditorApplication.isPaused;
            return new JObject
            {
                ["paused"] = EditorApplication.isPaused
            };
        }

        // When the bridge drives Play Mode from the BACKGROUND (the editor app isn't focused —
        // the normal case while an agent drives via MCP), Unity suspends the game player loop:
        // MonoBehaviour.Update + coroutines stop ticking, so any game-logic-gated transition
        // (an animated nav, a coroutine that calls SceneManager.LoadScene, an async load) never
        // runs. Setting Application.runInBackground = true keeps the player loop ticking while
        // unfocused — the same lever RuntimeHandler/InputSystemRuntimePump pull. Call this AFTER
        // play mode is confirmed (it's a runtime property; setting it pre-reload wouldn't stick);
        // it reverts to the project default on play-stop.
        private JObject HandleSetRunInBackground(JObject parameters)
        {
            bool enabled = parameters?.Value<bool?>("enabled") ?? true;
            Application.runInBackground = enabled;
            return new JObject { ["run_in_background"] = Application.runInBackground };
        }

        // GRL-B03: recent Console entries with optional size/severity guards. A single 61,309-char
        // log line once blew the client token budget, forcing a grep of the saved log file just to
        // read a cohort's own output. 'count' takes the most-recent N (newest-last / chronological).
        // Optional, all BACKWARD-COMPATIBLE (omit for the pre-existing behavior):
        //   - severity (error|warning|log) / errors_only: filter to that level BEFORE the count cap,
        //     so errors_only returns the last N ERRORS (not errors within the last N of any type).
        //   - max_chars: truncate each entry's message + stackTrace to that length, stamping the
        //     entry truncated:true + original_message_length so the cut is HONEST, never silent.
        private JObject HandleConsoleLogs(JObject parameters)
        {
            int count = parameters?.Value<int?>("count") ?? 50;
            string severity = ParseSeverityFilter(parameters);

            int? maxChars = parameters?.Value<int?>("max_chars") ?? parameters?.Value<int?>("maxChars");
            if (maxChars.HasValue && maxChars.Value < 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "'max_chars' must be >= 0.");

            // No severity filter → the original code path, byte-identical for existing callers
            // (e.g. the verification pipeline's count:200). A filter uses the newest-first walk.
            JArray logs = severity == null
                ? TraceCollector.GetRecentLogs(count)
                : TraceCollector.GetRecentLogs(count, severity);

            int truncatedCount = 0;
            if (maxChars.HasValue)
            {
                foreach (JObject entry in logs.Children<JObject>())
                {
                    bool truncated = false;
                    truncated |= TruncateLogField(entry, "message", maxChars.Value);
                    truncated |= TruncateLogField(entry, "stackTrace", maxChars.Value);
                    if (truncated)
                    {
                        entry["truncated"] = true;
                        truncatedCount++;
                    }
                }
            }

            var result = new JObject
            {
                ["logs"] = logs,
                ["returned"] = logs.Count,
            };
            if (severity != null) result["severity"] = severity;
            if (maxChars.HasValue)
            {
                result["max_chars"] = maxChars.Value;
                result["truncated_count"] = truncatedCount;
            }
            return result;
        }

        // Truncate a string field to maxChars, stamping original_<field>_length when cut. Returns
        // true when truncation happened. maxChars==0 is a hard cap to empty (still honestly reported).
        private static bool TruncateLogField(JObject entry, string field, int maxChars)
        {
            string value = entry.Value<string>(field);
            if (value == null || value.Length <= maxChars) return false;
            entry[field] = value.Substring(0, maxChars);
            entry["original_" + field + "_length"] = value.Length;
            return true;
        }

        // Resolve the severity filter from 'severity' (error/warning/log) and/or 'errors_only'
        // (sugar for severity=error). Returns null when neither is supplied (no filter). A
        // contradictory pair (errors_only:true + severity:'warning') is refused, not silently picked.
        private static string ParseSeverityFilter(JObject parameters)
        {
            string severity = parameters?.Value<string>("severity");
            bool? errorsOnly = parameters?.Value<bool?>("errors_only") ?? parameters?.Value<bool?>("errorsOnly");

            if (!string.IsNullOrEmpty(severity))
            {
                if (severity != "error" && severity != "warning" && severity != "log")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'severity': '{severity}'. Expected one of error, warning, log.");
                if (errorsOnly == true && severity != "error")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"'errors_only' contradicts 'severity':'{severity}'. Provide just one.");
                return severity;
            }
            if (errorsOnly == true)
                return "error";
            return null;
        }

        private JObject HandleClearConsole(JObject parameters)
        {
            TraceCollector.ClearLogs();
            return new JObject { ["cleared"] = true };
        }

        private JObject HandleBeginUndoGroup(JObject parameters)
        {
            string name = parameters?.Value<string>("name") ?? "UnityBridge Operation";
            Undo.SetCurrentGroupName(name);
            return new JObject { ["group_name"] = name };
        }

        private JObject HandleEndUndoGroup(JObject parameters)
        {
            int group = Undo.GetCurrentGroup();
            Undo.CollapseUndoOperations(group);
            return new JObject { ["collapsed_group"] = group };
        }

        // ─────────────────────────────────────────────
        // Async Op Implementations
        // ─────────────────────────────────────────────

        private void HandleWaitFor(JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            WaitEngine.WaitFor(parameters, respond, onError);
        }

        // RCL-T09: deterministically ADVANCE the simulation by N frames or a duration, with NO
        // screenshot/sampling overhead (unlike measure_motion). Same focus-independent setup
        // measure_motion uses — force Application.runInBackground=true so the player loop ticks
        // unfocused, and (when captureFps>0) pin Time.captureDeltaTime so each tick is a fixed
        // game-time step — then step the editor/player loop and restore both. Use this to let
        // game logic settle after wiring/input without a sleep and without focus_game_view
        // (which can't grab focus headless). Requires Play Mode (a stopped editor doesn't run
        // game Update). Returns { advancedFrames, advancedMs }.
        private void HandleTick(JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            int? frames = parameters?.Value<int?>("frames");
            double? durationMs = parameters?.Value<double?>("durationMs");
            int captureFps = parameters?.Value<int?>("captureFps") ?? 60;

            // Validate params first (so a malformed call is told why regardless of play state).
            if (frames.HasValue == durationMs.HasValue)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "editor.tick requires exactly one of 'frames' (int > 0) or 'durationMs' (number > 0)."));
                return;
            }
            if (frames.HasValue && frames.Value <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'frames' must be > 0."));
                return;
            }
            if (durationMs.HasValue && durationMs.Value <= 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS, "Parameter 'durationMs' must be > 0."));
                return;
            }
            if (captureFps < 0)
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Parameter 'captureFps' must be >= 0 (0 disables capture-rate pinning)."));
                return;
            }

            if (!EditorApplication.isPlaying)
            {
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "editor.tick requires Play Mode (a stopped editor does not run the game loop). " +
                    "Call editor.play first."));
                return;
            }

            double durationSec = (durationMs ?? 0) / 1000.0;
            const int maxFrames = 2000000; // frame-count safety cap

            // Wall-clock budget: a stalled game clock (Time.timeScale==0 / paused game /
            // captureFps:0 with no advance) must NOT spin holding global Time state. Cap a few
            // seconds past the requested window, comfortably under the server's op timeout.
            double realStart = EditorApplication.timeSinceStartup;
            double realBudgetSec = (durationMs.HasValue ? durationSec : 0) + 8.0;

            bool restoreRunInBackground = Application.runInBackground;
            Application.runInBackground = true;
            float restoreCaptureDeltaTime = Time.captureDeltaTime;
            if (captureFps > 0)
                Time.captureDeltaTime = 1f / captureFps;

            EditorApplication.CallbackFunction tick = null;
            Action<PlayModeStateChange> onPlayModeChanged = null;
            AssemblyReloadEvents.AssemblyReloadCallback onBeforeReload = null;
            bool finished = false;
            int advancedFrames = 0;
            double startTime = -1;
            // Keep any held input session alive so a key_down → editor.tick → key_up sequence
            // doesn't lose its held key to the idle watchdog mid-advance.
            IDisposable keepAlive = null;

            // Restore global Time/runInBackground state and detach every hook. Idempotent.
            Action cleanup = () =>
            {
                keepAlive?.Dispose();
                EditorApplication.update -= tick;
                if (onPlayModeChanged != null) EditorApplication.playModeStateChanged -= onPlayModeChanged;
                if (onBeforeReload != null) AssemblyReloadEvents.beforeAssemblyReload -= onBeforeReload;
                Time.captureDeltaTime = restoreCaptureDeltaTime;
                Application.runInBackground = restoreRunInBackground;
            };

            // If the advance is interrupted (play-mode exit or an imminent domain reload), the tick
            // closure is destroyed and cleanup() would never run — Time.captureDeltaTime is a NATIVE
            // global NOT reset by play-exit/reload, so the editor would be left pinned in capture mode
            // (renders as fast as possible, high CPU). Restore eagerly and report exactly once.
            Action<string> interrupt = (reason) =>
            {
                if (finished) return;
                finished = true;
                cleanup();
                onError(new BridgeException(ErrorCodes.PLAY_MODE_REQUIRED,
                    "editor.tick interrupted mid-advance: " + reason));
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

                    bool gameDone = frames.HasValue
                        ? advancedFrames >= frames.Value
                        : (now - startTime) >= durationSec;
                    // Wall-clock guard: terminate if the real-time budget is exceeded (stalled/paused
                    // clock) or the frame cap is hit, even if game-time never reached the target.
                    bool realtimeExceeded = (EditorApplication.timeSinceStartup - realStart) >= realBudgetSec;
                    bool capHit = advancedFrames >= maxFrames;

                    if (gameDone || realtimeExceeded || capHit)
                    {
                        finished = true;
                        double advancedMs = (Time.timeAsDouble - startTime) * 1000.0;
                        cleanup();
                        respond(new JObject
                        {
                            ["advancedFrames"] = advancedFrames,
                            ["advancedMs"] = System.Math.Round(advancedMs, 2),
                            ["realtimeDeadlineHit"] = realtimeExceeded && !gameDone
                        });
                    }
                }
                catch (Exception ex)
                {
                    finished = true;
                    cleanup();
                    onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "editor.tick failed mid-advance: " + ex.Message, ex));
                }
            };

            keepAlive = InputService.KeepActiveSessionsAlive();
            EditorApplication.playModeStateChanged += onPlayModeChanged;
            AssemblyReloadEvents.beforeAssemblyReload += onBeforeReload;
            EditorApplication.update += tick;
        }
    }
}
