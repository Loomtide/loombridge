using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine.TestTools;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for EditorHandler. The async editor.tick happy path (RCL-T09) needs a
    /// running player loop, which EditMode tests cannot drive cleanly — that is covered by the
    /// live MCP smoke. These tests pin the SYNCHRONOUS refusal/validation paths, which fire
    /// before any update callback is registered.
    /// </summary>
    [TestFixture]
    public class EditorHandlerTests
    {
        private EditorHandler _handler;

        [SetUp]
        public void SetUp()
        {
            _handler = new EditorHandler();
        }

        [Test]
        public void Tick_IsAsync()
        {
            Assert.IsTrue(_handler.IsAsync("tick"), "editor.tick must be an async op");
        }

        // Runs the async op and returns whichever of {result, error} fired synchronously.
        private (JObject result, BridgeException error) RunTickSync(JObject parameters)
        {
            JObject captured = null;
            BridgeException capturedError = null;
            _handler.HandleOpAsync("tick", parameters,
                r => captured = r,
                e => capturedError = e);
            return (captured, capturedError);
        }

        [Test]
        public void Tick_NeitherFramesNorDuration_ThrowsInvalidParams()
        {
            var (result, error) = RunTickSync(new JObject());
            Assert.IsNull(result);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void Tick_BothFramesAndDuration_ThrowsInvalidParams()
        {
            var (result, error) = RunTickSync(new JObject { ["frames"] = 5, ["durationMs"] = 100 });
            Assert.IsNull(result);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void Tick_NonPositiveFrames_ThrowsInvalidParams()
        {
            var (_, error) = RunTickSync(new JObject { ["frames"] = 0 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void Tick_NegativeCaptureFps_ThrowsInvalidParams()
        {
            var (_, error) = RunTickSync(new JObject { ["frames"] = 5, ["captureFps"] = -1 });
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
        }

        [Test]
        public void Tick_ValidParamsButNotPlaying_ThrowsPlayModeRequired()
        {
            // EditMode tests are not in Play Mode, so a well-formed request refuses with
            // PLAY_MODE_REQUIRED rather than registering the advance loop.
            var (result, error) = RunTickSync(new JObject { ["frames"] = 10 });
            Assert.IsNull(result);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.PLAY_MODE_REQUIRED, error.Code);
        }

        [Test]
        public void FocusGameView_Degrades_DoesNotThrowFocusRequired()
        {
            // Headless/background EditMode cannot acquire OS focus. RCL-T09: instead of throwing
            // FOCUS_REQUIRED, focus_game_view returns a soft result with focusDegraded reported.
            // Opening a GameView under -nographics logs "[Error] No graphic device…" — that is an
            // expected environment artifact, not a handler fault, so tolerate failing log messages.
            LogAssert.ignoreFailingMessages = true;
            try
            {
                JObject result = _handler.HandleOp("focus_game_view", new JObject());
                Assert.IsNotNull(result, "focus_game_view must return a structured result, never throw FOCUS_REQUIRED");
                Assert.IsNotNull(result["focusDegraded"], "focus_game_view must report focusDegraded");
                bool focused = result.Value<bool>("gameViewFocused");
                bool degraded = result.Value<bool>("focusDegraded");
                // Real contract (NOT a tautology): focusDegraded is exactly the inverse of
                // gameViewFocused. A broken impl that reports degraded:false while unfocused fails here.
                Assert.AreEqual(!focused, degraded, "focusDegraded must equal !gameViewFocused");
            }
            finally
            {
                LogAssert.ignoreFailingMessages = false;
            }
        }

        // ─── RLH-W2: editor.get_project_diagnostics ───

        [Test]
        public void GetProjectDiagnostics_ReportsVersionRenderPipelineAndPackages()
        {
            JObject result = _handler.HandleOp("get_project_diagnostics", new JObject());
            Assert.IsNotNull(result);

            // unity_version is always present and non-empty.
            Assert.IsFalse(string.IsNullOrEmpty(result.Value<string>("unity_version")),
                "unity_version must be reported");

            // render_pipeline is an object with a mode in the documented set.
            JObject rp = result["render_pipeline"] as JObject;
            Assert.IsNotNull(rp, "render_pipeline must be an object");
            string mode = rp.Value<string>("mode");
            CollectionAssert.Contains(new[] { "URP", "HDRP", "built-in", "custom" }, mode,
                "render_pipeline.mode must be one of URP/HDRP/built-in/custom");
            Assert.IsTrue(rp.ContainsKey("asset_type"), "render_pipeline must report asset_type (null for built-in)");

            // installed_packages is a non-empty array of { name, version } — every Unity project
            // resolves at least the core built-in modules.
            JArray packages = result["installed_packages"] as JArray;
            Assert.IsNotNull(packages, "installed_packages must be an array");
            Assert.Greater(packages.Count, 0, "installed_packages must be non-empty");
            JObject firstPkg = packages[0] as JObject;
            Assert.IsNotNull(firstPkg);
            Assert.IsFalse(string.IsNullOrEmpty(firstPkg.Value<string>("name")), "each package must have a name");
            Assert.IsTrue(firstPkg.ContainsKey("version"), "each package entry must carry a version field");

            // D2: with a successful package query (packages non-empty above), the failure flag
            // must be false and disabled_built_in_modules must be an ARRAY (possibly empty —
            // [] is the positive "all known optional modules enabled" claim; null is reserved
            // for a failed query, paired with package_query_failed: true).
            Assert.IsFalse(result.Value<bool>("package_query_failed"),
                "package_query_failed must be false when installed_packages is non-empty");
            Assert.IsNotNull(result["disabled_built_in_modules"] as JArray,
                "disabled_built_in_modules must be an array on a successful query");

            // D3: editor and player assembly sets are reported separately (the parameterless
            // GetAssemblies() is the EDITOR set on current Unity). A live project always has
            // at least one editor assembly (this bridge package itself compiles into it).
            Assert.Greater(result.Value<int>("editor_assembly_count"), 0,
                "editor_assembly_count must be > 0 (the bridge package is an editor assembly)");
            Assert.GreaterOrEqual(result.Value<int>("player_assembly_count"), 0,
                "player_assembly_count must be >= 0");

            // last_compile is present (JSON null when nothing compiled this session).
            Assert.IsTrue(result.ContainsKey("last_compile"), "last_compile key must be present (null when none)");
        }

        // ─── RLT2: editor.audit_mobile_assets ───

        [Test]
        public void AuditMobileAssets_EmptyProject_ReturnsBoundedShapeWithoutThrowing()
        {
            // Refusal-free on an empty/default project: the op must return a fully-shaped,
            // bounded payload with all categories present (empty), never throw.
            JObject result = _handler.HandleOp("audit_mobile_assets", new JObject());
            Assert.IsNotNull(result);

            // D1: the payload discriminator the CLI refuses without — always present.
            Assert.AreEqual("mobile_asset_audit", result.Value<string>("payload_kind"),
                "payload_kind discriminator must be stamped");
            Assert.AreEqual(1, result.Value<int>("payload_version"), "payload_version must be 1");

            Assert.AreEqual(50, result.Value<int>("max_entries"), "default max_entries is 50");
            Assert.IsNotNull(result["loaded_scenes"] as JArray, "loaded_scenes must be an array");

            foreach (string cat in new[] { "textures", "audio", "meshes" })
            {
                JObject c = result[cat] as JObject;
                Assert.IsNotNull(c, $"{cat} category must be an object");
                Assert.IsNotNull(c["entries"] as JArray, $"{cat}.entries must be an array");
                Assert.IsTrue(c.ContainsKey("total_count"), $"{cat}.total_count must be present");
                Assert.IsTrue(c.ContainsKey("truncated"), $"{cat}.truncated must be present");
            }

            // D2: the mesh category always reports its triangle-count blind-spot tally.
            Assert.IsTrue((result["meshes"] as JObject).ContainsKey("unreadable_count"),
                "meshes.unreadable_count must be present (0 when every mesh counted)");

            // quality_settings is always present (QualitySettings is a core module).
            Assert.IsNotNull(result["quality_settings"] as JObject, "quality_settings must be an object");
            // build_scenes is always an array (possibly empty).
            Assert.IsNotNull(result["build_scenes"] as JArray, "build_scenes must be an array");
            // render_pipeline_settings is either an object or JSON null (never absent).
            Assert.IsTrue(result.ContainsKey("render_pipeline_settings"),
                "render_pipeline_settings key must be present (null when not URP)");
        }

        [Test]
        public void AuditMobileAssets_InvalidMaxEntries_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("audit_mobile_assets", new JObject { ["max_entries"] = 0 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void AuditMobileAssets_CountsSharedMeshInstances()
        {
            // Three cubes created via CreatePrimitive share the SAME built-in Cube mesh, so the
            // audit must report that mesh with instance_count == 3 and triangle_load == tris × 3.
            var cubes = new System.Collections.Generic.List<UnityEngine.GameObject>();
            try
            {
                for (int i = 0; i < 3; i++)
                    cubes.Add(UnityEngine.GameObject.CreatePrimitive(UnityEngine.PrimitiveType.Cube));

                JObject result = _handler.HandleOp("audit_mobile_assets", new JObject());
                JArray meshEntries = (result["meshes"] as JObject)["entries"] as JArray;
                Assert.IsNotNull(meshEntries);

                JObject cubeMesh = null;
                foreach (JObject e in meshEntries)
                {
                    if (e.Value<string>("name") == "Cube" && e.Value<int>("instance_count") >= 3)
                    {
                        cubeMesh = e;
                        break;
                    }
                }
                Assert.IsNotNull(cubeMesh, "the shared Cube mesh must appear with instance_count >= 3");
                int tris = cubeMesh.Value<int>("triangle_count");
                int instances = cubeMesh.Value<int>("instance_count");
                Assert.AreEqual(3, instances, "three cubes reference the same Cube mesh");
                Assert.Greater(tris, 0, "the Cube mesh has triangles");
                // triangle_load must be exactly tris × instances (the §9 headline metric).
                Assert.AreEqual((long)tris * instances, cubeMesh.Value<long>("triangle_load"),
                    "triangle_load = triangle_count × instance_count");
            }
            finally
            {
                foreach (var c in cubes)
                    if (c != null) UnityEngine.Object.DestroyImmediate(c);
            }
        }

        [Test]
        public void AuditMobileAssets_NonReadableMesh_StillCountsTriangles()
        {
            // D2a: the §9 wall is an imported FBX, and FBX import defaults Read/Write OFF.
            // Triangle counting uses Mesh.GetIndexCount, which (UnityCsReference Mesh.cs) has NO
            // canAccess gate — it reads the SubMesh descriptor metadata the draw call uses, so a
            // NON-READABLE mesh still gets a REAL triangle count (never null, and NEVER the
            // silent false zero that GetIndices' log-error-and-return-empty path would produce).
            // UploadMeshData(markNoLongerReadable: true) gives a truly non-readable mesh offline.
            var go = new UnityEngine.GameObject("NonReadableHost");
            UnityEngine.Mesh mesh = null;
            try
            {
                mesh = new UnityEngine.Mesh();
                mesh.name = "AuditNonReadableMesh";
                mesh.vertices = new[]
                {
                    new UnityEngine.Vector3(0, 0, 0),
                    new UnityEngine.Vector3(1, 0, 0),
                    new UnityEngine.Vector3(0, 1, 0),
                };
                mesh.triangles = new[] { 0, 1, 2 };
                mesh.UploadMeshData(true); // markNoLongerReadable — discards the CPU copy
                Assert.IsFalse(mesh.isReadable, "fixture precondition: the mesh must be non-readable");

                var mf = go.AddComponent<UnityEngine.MeshFilter>();
                mf.sharedMesh = mesh;
                go.AddComponent<UnityEngine.MeshRenderer>();

                JObject result = _handler.HandleOp("audit_mobile_assets", new JObject());
                JObject meshes = result["meshes"] as JObject;
                JArray meshEntries = meshes["entries"] as JArray;
                Assert.IsNotNull(meshEntries);

                JObject entry = null;
                foreach (JObject e in meshEntries)
                {
                    if (e.Value<string>("name") == "AuditNonReadableMesh")
                    {
                        entry = e;
                        break;
                    }
                }
                Assert.IsNotNull(entry, "the non-readable mesh must appear in the audit");
                // The count is REAL (1 triangle), not null and not a false zero.
                Assert.AreEqual(JTokenType.Integer, entry["triangle_count"].Type,
                    "triangle_count must be a number for a non-readable mesh (GetIndexCount is ungated)");
                Assert.AreEqual(1, entry.Value<int>("triangle_count"), "3 indices / 3 = 1 triangle");
                Assert.AreEqual(1, entry.Value<int>("instance_count"));
                Assert.AreEqual(1L, entry.Value<long>("triangle_load"));
                Assert.IsFalse(entry.ContainsKey("reason"),
                    "a successfully-counted mesh carries no reason field");
                // And it therefore does NOT tally into the blind-spot count.
                Assert.AreEqual(0, meshes.Value<int>("unreadable_count"),
                    "a counted non-readable mesh is not 'unreadable' for audit purposes");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
                if (mesh != null) UnityEngine.Object.DestroyImmediate(mesh);
            }
        }

        [Test]
        public void AuditMobileAssets_ReportsTextureForCreatedSprite()
        {
            // A SpriteRenderer with a created sprite must yield a texture entry (proving the
            // SpriteRenderer walk is wired, not just material textures).
            var go = new UnityEngine.GameObject("SpriteHost");
            UnityEngine.Texture2D tex = null;
            try
            {
                tex = new UnityEngine.Texture2D(64, 64);
                tex.name = "AuditProbeTex";
                var sprite = UnityEngine.Sprite.Create(
                    tex, new UnityEngine.Rect(0, 0, 64, 64), new UnityEngine.Vector2(0.5f, 0.5f));
                var sr = go.AddComponent<UnityEngine.SpriteRenderer>();
                sr.sprite = sprite;

                JObject result = _handler.HandleOp("audit_mobile_assets", new JObject());
                JArray texEntries = (result["textures"] as JObject)["entries"] as JArray;
                Assert.IsNotNull(texEntries);

                bool found = false;
                foreach (JObject e in texEntries)
                {
                    if (e.Value<string>("name") == "AuditProbeTex")
                    {
                        Assert.AreEqual(64, e.Value<int>("width"), "texture width reported");
                        Assert.AreEqual(64, e.Value<int>("height"), "texture height reported");
                        found = true;
                        break;
                    }
                }
                Assert.IsTrue(found, "the created sprite's texture must appear in the texture audit");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
                if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
            }
        }

        [Test]
        public void AuditMobileAssets_TruncatesToMaxEntries()
        {
            // With more distinct meshes than max_entries, the mesh category must truncate and
            // report the true total. Primitive types give distinct built-in meshes.
            var objs = new System.Collections.Generic.List<UnityEngine.GameObject>();
            try
            {
                foreach (var pt in new[]
                {
                    UnityEngine.PrimitiveType.Cube,
                    UnityEngine.PrimitiveType.Sphere,
                    UnityEngine.PrimitiveType.Capsule,
                })
                    objs.Add(UnityEngine.GameObject.CreatePrimitive(pt));

                JObject result = _handler.HandleOp("audit_mobile_assets", new JObject { ["max_entries"] = 1 });
                JObject meshes = result["meshes"] as JObject;
                JArray entries = meshes["entries"] as JArray;
                Assert.AreEqual(1, entries.Count, "entries capped to max_entries");
                Assert.GreaterOrEqual(meshes.Value<int>("total_count"), 3, "total_count reports the full count");
                Assert.IsTrue(meshes.Value<bool>("truncated"), "truncated flag set when capped");
            }
            finally
            {
                foreach (var o in objs)
                    if (o != null) UnityEngine.Object.DestroyImmediate(o);
            }
        }

        // ─── RCL-T06: editor.execute_menu_item allowlist gate ───

        [Test]
        public void ExecuteMenuItem_MissingMenuPath_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("execute_menu_item", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void ExecuteMenuItem_NotOnAllowlist_Refuses()
        {
            // Default allowlist has NO menu items, so any path is refused — never invoked.
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("execute_menu_item", new JObject { ["menuPath"] = "File/Build Settings..." }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("not on the allowlist", ex.Message);
        }

        [Test]
        public void ExecuteMenuItem_OnAllowlist_PassesGateAndReports()
        {
            EditorInvokeAllowlist.OverrideForTests = EditorInvokeAllowlist.ForTests(
                new[] { "GroundTiling.WriteTileCaptures" },
                new[] { "Tools/Loomtide/Nonexistent Probe" });
            // ExecuteMenuItem on a nonexistent path logs "[Error] ExecuteMenuItem failed because there
            // is no menu named…" — an expected Unity artifact of probing a fake path (the point of the
            // test: prove the gate let the call THROUGH to ExecuteMenuItem), not a handler fault. So
            // tolerate failing log messages for this assertion.
            LogAssert.ignoreFailingMessages = true;
            try
            {
                // The path is allowlisted, so the gate must NOT refuse. Unity finds no enabled
                // menu item at this fake path, so executed=false — proving the call reached
                // ExecuteMenuItem rather than being refused at the gate.
                JObject result = _handler.HandleOp("execute_menu_item",
                    new JObject { ["menuPath"] = "Tools/Loomtide/Nonexistent Probe" });
                Assert.IsNotNull(result);
                Assert.AreEqual("Tools/Loomtide/Nonexistent Probe", result.Value<string>("menuPath"));
                Assert.IsNotNull(result["executed"], "must report whether Unity executed the item");
                Assert.IsFalse(result.Value<bool>("executed"), "a nonexistent menu path executes to false");
            }
            finally
            {
                LogAssert.ignoreFailingMessages = false;
                EditorInvokeAllowlist.OverrideForTests = null;
            }
        }

        // ─────────────────────────────────────────────
        // console_logs size/severity guards (GRL-B03)
        // ─────────────────────────────────────────────

        [Test]
        public void ConsoleLogs_NoGuards_BackwardCompatible()
        {
            JObject result = _handler.HandleOp("console_logs", new JObject { ["count"] = 5 });
            Assert.IsNotNull(result.Value<JArray>("logs"), "logs array is always present");
            // Guard-specific fields must be absent when no guard is requested.
            Assert.IsNull(result["severity"], "no severity field without a filter");
            Assert.IsNull(result["max_chars"], "no max_chars field without truncation");
        }

        [Test]
        public void ConsoleLogs_MaxChars_TruncatesHonestly()
        {
            _handler.HandleOp("clear_console", new JObject());
            string big = new string('x', 5000);
            UnityEngine.Debug.Log(big);

            JObject result = _handler.HandleOp("console_logs",
                new JObject { ["count"] = 10, ["max_chars"] = 100 });

            JObject entry = null;
            foreach (JObject e in result.Value<JArray>("logs").Children<JObject>())
            {
                if ((e.Value<string>("message") ?? "").StartsWith("x")) { entry = e; break; }
            }
            Assert.IsNotNull(entry, "the logged entry should be present");
            Assert.AreEqual(100, entry.Value<string>("message").Length, "message truncated to max_chars");
            Assert.IsTrue(entry.Value<bool>("truncated"), "truncated flag set on the cut entry");
            Assert.AreEqual(5000, entry.Value<int>("original_message_length"),
                "the honest pre-truncation length is reported");
            Assert.GreaterOrEqual(result.Value<int>("truncated_count"), 1);
        }

        [Test]
        public void ConsoleLogs_SeverityWarning_ReturnsOnlyWarnings()
        {
            _handler.HandleOp("clear_console", new JObject());
            UnityEngine.Debug.Log("info-marker");
            UnityEngine.Debug.LogWarning("warn-marker");

            JObject result = _handler.HandleOp("console_logs", new JObject { ["severity"] = "warning" });
            JArray logs = result.Value<JArray>("logs");
            Assert.GreaterOrEqual(logs.Count, 1, "at least the warning we logged");
            foreach (JObject e in logs.Children<JObject>())
                Assert.AreEqual("warning", e.Value<string>("type"), "severity filter returns only that level");
            Assert.AreEqual("warning", result.Value<string>("severity"));
        }

        [Test]
        public void ConsoleLogs_ErrorsOnly_ReturnsOnlyErrors()
        {
            _handler.HandleOp("clear_console", new JObject());
            UnityEngine.Debug.Log("info-only-marker");
            UnityEngine.Debug.LogWarning("warn-only-marker");

            JObject result = _handler.HandleOp("console_logs", new JObject { ["errors_only"] = true });
            foreach (JObject e in result.Value<JArray>("logs").Children<JObject>())
                Assert.AreEqual("error", e.Value<string>("type"));
            Assert.AreEqual("error", result.Value<string>("severity"), "errors_only resolves to severity=error");
        }

        [Test]
        public void ConsoleLogs_InvalidSeverity_Refuses()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("console_logs", new JObject { ["severity"] = "bogus" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void ConsoleLogs_ContradictorySeverityAndErrorsOnly_Refuses()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("console_logs",
                    new JObject { ["severity"] = "warning", ["errors_only"] = true }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void ConsoleLogs_NegativeMaxChars_Refuses()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("console_logs", new JObject { ["max_chars"] = -1 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // editor.play compile-error attribution (GRL-B01)
        // ─────────────────────────────────────────────

        [Test]
        public void GetState_NoCompileError_OmitsCompileErrorBlock()
        {
            // This test only runs because the editor + test assemblies COMPILED — so there is no
            // pending compile error, and get_state must not fabricate a compile_error block
            // (attribution is affirmative-only; never a guess).
            JObject result = _handler.HandleOp("get_state", new JObject());
            Assert.IsNull(result["compile_error"],
                "compile_error must be absent when no compile error is present");
        }

        [Test]
        public void CompileWatcher_NoError_ReturnsNull()
        {
            // Same honesty invariant at the source: with the assemblies compiled, the probe returns
            // null rather than an empty/guessed block.
            Assert.IsNull(UnityBridge.Core.CompileWatcher.GetCompileErrorState());
        }
    }
}
