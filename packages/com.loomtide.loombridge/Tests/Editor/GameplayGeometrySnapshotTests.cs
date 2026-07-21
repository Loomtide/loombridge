using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the "art scene safety profile" ops (RLH-W3):
    /// scene.snapshot_gameplay_geometry + scene.compare_gameplay_geometry. Motivating principle
    /// (art-integration dogfood, "Art Is A Parallel Vertical"): an art pass must be VISUAL-ONLY, so
    /// graybox colliders/triggers/LOS-blockers and serialized gameplay tuning must survive it
    /// UNCHANGED — and something must PROVE it. These tests pin the honesty rules: a deterministic
    /// byte-identical snapshot, verdict=unchanged on an untouched scene, precise field-level diffs on
    /// mutation, removed/added on delete/create, a refusal (never an empty diff) for a missing or
    /// schema-mismatched baseline, and tolerance-respecting float comparison.
    /// </summary>
    [TestFixture]
    public class GameplayGeometrySnapshotTests
    {
        private SceneHandler _scene;
        private string _dir;
        private string _baselineRel;
        private string _baselineAbs;
        private const string TestScenePath = "Assets/GameplayGeometryTestsScene.unity";

        [SetUp]
        public void SetUp()
        {
            _scene = new SceneHandler();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Project-relative scratch dir under the project root (Temp/ is gitignored, non-Asset).
            _dir = "Temp/GameplayGeometryTests";
            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string absDir = Path.Combine(projectRoot, _dir);
            if (Directory.Exists(absDir))
                Directory.Delete(absDir, true);
            _baselineRel = _dir + "/baseline.json";
            _baselineAbs = Path.Combine(projectRoot, _baselineRel);
        }

        [TearDown]
        public void TearDown()
        {
            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string absDir = Path.Combine(projectRoot, _dir);
            if (Directory.Exists(absDir))
                Directory.Delete(absDir, true);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestScenePath) != null)
                AssetDatabase.DeleteAsset(TestScenePath);
        }

        private static GameObject MakeBox(string name, Vector3 pos, bool isTrigger = false)
        {
            var go = new GameObject(name);
            go.transform.position = pos;
            var box = go.AddComponent<BoxCollider>();
            box.isTrigger = isTrigger;
            box.size = new Vector3(2f, 1f, 3f);
            return go;
        }

        private JObject Snapshot(string relPath, JObject extra = null)
        {
            var p = new JObject { ["output_path"] = relPath };
            if (extra != null)
                foreach (var prop in extra.Properties())
                    p[prop.Name] = prop.Value;
            return _scene.HandleOp("snapshot_gameplay_geometry", p);
        }

        private JObject Compare(string baselineRel, JObject tolerance = null)
        {
            var p = new JObject { ["baseline_path"] = baselineRel };
            if (tolerance != null)
                p["tolerance"] = tolerance;
            return _scene.HandleOp("compare_gameplay_geometry", p);
        }

        // ─────────────────────────────────────────────
        // snapshot
        // ─────────────────────────────────────────────

        [Test]
        public void Snapshot_IsDeterministic_TwoSnapshotsByteIdentical()
        {
            MakeBox("Wall", new Vector3(1, 0, 2));
            MakeBox("Trigger", new Vector3(-3, 0, 0), isTrigger: true);

            Snapshot(_dir + "/a.json");
            Snapshot(_dir + "/b.json");

            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string a = File.ReadAllText(Path.Combine(projectRoot, _dir, "a.json"));
            string b = File.ReadAllText(Path.Combine(projectRoot, _dir, "b.json"));
            Assert.AreEqual(a, b, "two snapshots of an unchanged scene must be byte-identical");
        }

        [Test]
        public void Snapshot_ExcludesRenderers_RecordsColliderGeometryAndTransform()
        {
            GameObject wall = MakeBox("Wall", new Vector3(1, 2, 3));
            // A renderer must NOT change the record — visual-only data is excluded by design.
            wall.AddComponent<MeshRenderer>();

            JObject result = Snapshot(_baselineRel);
            Assert.AreEqual(GameplayGeometrySnapshot.SchemaVersion, result.Value<int>("schema_version"));

            JObject doc = JObject.Parse(File.ReadAllText(_baselineAbs));
            JArray objects = doc.Value<JArray>("objects");
            Assert.AreEqual(1, objects.Count, "one collider-bearing object");

            JObject obj = (JObject)objects[0];
            Assert.IsNull(obj["renderer"], "no renderer/visual key may appear");
            Assert.AreEqual("Wall", obj.Value<string>("path").TrimStart('/'));
            JObject collider = (JObject)obj.Value<JArray>("colliders")[0];
            Assert.AreEqual("BoxCollider", collider.Value<string>("type"));
            Assert.AreEqual("3d", collider.Value<string>("dimension"));
            Assert.IsFalse(collider.Value<bool>("is_trigger"));
            Assert.AreEqual(2f, collider.Value<JObject>("size").Value<float>("x"), 1e-6);
            // World transform lives on the object once (transform-independent collider record).
            Assert.AreEqual(3f, obj.Value<JObject>("transform").Value<JObject>("position").Value<float>("z"), 1e-6);
        }

        // ─────────────────────────────────────────────
        // compare: unchanged
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_UnchangedScene_VerdictUnchanged()
        {
            MakeBox("Wall", new Vector3(1, 0, 2));
            MakeBox("Blocker", new Vector3(5, 0, 0));
            Snapshot(_baselineRel);

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("unchanged", result.Value<string>("verdict"));
            Assert.AreEqual(2, result.Value<int>("unchanged_count"));
            Assert.AreEqual(0, result.Value<JArray>("added").Count);
            Assert.AreEqual(0, result.Value<JArray>("removed").Count);
            Assert.AreEqual(0, result.Value<JArray>("modified").Count);
        }

        // ─────────────────────────────────────────────
        // compare: modified
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_MovedCollider_ReportsModifiedTransformPosition()
        {
            GameObject wall = MakeBox("Wall", new Vector3(1, 0, 2));
            Snapshot(_baselineRel);

            wall.transform.position = new Vector3(1, 0, 5); // moved beyond tolerance on Z

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            JArray modified = result.Value<JArray>("modified");
            JObject hit = modified.OfType<JObject>().FirstOrDefault(m => m.Value<string>("field") == "transform.position");
            Assert.IsNotNull(hit, "a move must surface as a transform.position diff");
            Assert.AreEqual(2f, hit.Value<JObject>("baseline").Value<float>("z"), 1e-6);
            Assert.AreEqual(5f, hit.Value<JObject>("current").Value<float>("z"), 1e-6);
        }

        [Test]
        public void Compare_FlippedTrigger_ReportsModifiedIsTrigger()
        {
            GameObject wall = MakeBox("Wall", new Vector3(0, 0, 0), isTrigger: false);
            Snapshot(_baselineRel);

            wall.GetComponent<BoxCollider>().isTrigger = true;

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            JObject hit = result.Value<JArray>("modified").OfType<JObject>()
                .FirstOrDefault(m => m.Value<string>("field") == "colliders[0].is_trigger");
            Assert.IsNotNull(hit, "a trigger flip must surface as colliders[0].is_trigger");
            Assert.IsFalse(hit.Value<bool>("baseline"));
            Assert.IsTrue(hit.Value<bool>("current"));
        }

        [Test]
        public void Compare_ResizedColliderLocalGeometry_ReportsModifiedSize()
        {
            GameObject wall = MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            wall.GetComponent<BoxCollider>().size = new Vector3(2f, 1f, 9f); // z 3 -> 9

            JObject result = Compare(_baselineRel);
            JObject hit = result.Value<JArray>("modified").OfType<JObject>()
                .FirstOrDefault(m => m.Value<string>("field") == "colliders[0].size");
            Assert.IsNotNull(hit, "a local collider resize must surface as colliders[0].size");
        }

        // ─────────────────────────────────────────────
        // compare: removed / added
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_DeletedObject_ReportsRemoved()
        {
            MakeBox("Keep", new Vector3(0, 0, 0));
            GameObject gone = MakeBox("Gone", new Vector3(4, 0, 0));
            Snapshot(_baselineRel);

            Object.DestroyImmediate(gone);

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            Assert.AreEqual(1, result.Value<JArray>("removed").Count);
            Assert.AreEqual("Gone", ((JObject)result.Value<JArray>("removed")[0]).Value<string>("path").TrimStart('/'));
            Assert.AreEqual(0, result.Value<JArray>("added").Count);
            Assert.AreEqual(1, result.Value<int>("unchanged_count"), "the surviving object is unchanged");
        }

        [Test]
        public void Compare_AddedObject_ReportsAdded()
        {
            MakeBox("Original", Vector3.zero);
            Snapshot(_baselineRel);

            MakeBox("NewBlocker", new Vector3(7, 0, 0));

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            Assert.AreEqual(1, result.Value<JArray>("added").Count);
            Assert.AreEqual("NewBlocker", ((JObject)result.Value<JArray>("added")[0]).Value<string>("path").TrimStart('/'));
            Assert.AreEqual(0, result.Value<JArray>("removed").Count);
        }

        [Test]
        public void Compare_RenamedObject_ShowsAsRemovedPlusAdded_NoFuzzyMatch()
        {
            GameObject go = MakeBox("Beacon", Vector3.zero);
            Snapshot(_baselineRel);

            go.name = "BeaconArt"; // rename only — identical geometry

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            Assert.AreEqual(1, result.Value<JArray>("removed").Count, "the old path is removed");
            Assert.AreEqual(1, result.Value<JArray>("added").Count, "the new path is added — no fuzzy identity match");
        }

        // ─────────────────────────────────────────────
        // compare: tolerance
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_SubToleranceJitter_VerdictUnchanged()
        {
            GameObject wall = MakeBox("Wall", new Vector3(1f, 0f, 2f));
            Snapshot(_baselineRel);

            // Nudge by less than the default 0.001 position tolerance.
            wall.transform.position = new Vector3(1.0005f, 0f, 2.0004f);

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("unchanged", result.Value<string>("verdict"),
                "a sub-tolerance jitter must NOT be reported as a change");
            Assert.AreEqual(0, result.Value<JArray>("modified").Count);
        }

        [Test]
        public void Compare_TighterToleranceCatchesWhatDefaultAllows()
        {
            GameObject wall = MakeBox("Wall", new Vector3(0f, 0f, 0f));
            Snapshot(_baselineRel);

            wall.transform.position = new Vector3(0f, 0f, 0.0005f); // within default 0.001

            Assert.AreEqual("unchanged", Compare(_baselineRel).Value<string>("verdict"),
                "default tolerance permits the tiny move");

            JObject tight = Compare(_baselineRel, new JObject { ["position"] = 0.0001 });
            Assert.AreEqual("changed", tight.Value<string>("verdict"),
                "a tighter tolerance catches the same move");
        }

        // ─────────────────────────────────────────────
        // compare: refusals (never an empty diff)
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_MissingBaseline_RefusesNotFound()
        {
            MakeBox("Wall", Vector3.zero);
            var ex = Assert.Throws<BridgeException>(() => Compare(_dir + "/does-not-exist.json"));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code,
                "a missing baseline is a refusal, never an empty diff");
        }

        [Test]
        public void Compare_SchemaMismatchBaseline_RefusesInvalidParams()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_baselineAbs));
            File.WriteAllText(_baselineAbs, new JObject
            {
                ["schema_version"] = 999,
                ["objects"] = new JArray()
            }.ToString());

            var ex = Assert.Throws<BridgeException>(() => Compare(_baselineRel));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code,
                "a schema-mismatched baseline is a refusal, never an empty diff");
        }

        [Test]
        public void Compare_CorruptBaseline_RefusesInvalidParams()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_baselineAbs));
            File.WriteAllText(_baselineAbs, "{ this is not json ");

            var ex = Assert.Throws<BridgeException>(() => Compare(_baselineRel));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Snapshot_MissingOutputPath_RefusesInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _scene.HandleOp("snapshot_gameplay_geometry", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Snapshot_AbsoluteOutputPath_RefusesInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() => _scene.HandleOp(
                "snapshot_gameplay_geometry", new JObject { ["output_path"] = "/etc/evil.json" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Snapshot_EscapingOutputPath_RefusesInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() => _scene.HandleOp(
                "snapshot_gameplay_geometry", new JObject { ["output_path"] = "../escape.json" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // filters
        // ─────────────────────────────────────────────

        [Test]
        public void Snapshot_LayerFilter_KeepsOnlyMatchingLayer()
        {
            GameObject onDefault = MakeBox("OnDefault", Vector3.zero);   // layer 0 (Default)
            GameObject onWater = MakeBox("OnWater", new Vector3(3, 0, 0));
            onWater.layer = 4; // Water (built-in)

            Snapshot(_baselineRel, new JObject { ["layers"] = new JArray { 4 } });

            JObject doc = JObject.Parse(File.ReadAllText(_baselineAbs));
            JArray objects = doc.Value<JArray>("objects");
            Assert.AreEqual(1, objects.Count, "only the layer-4 object survives the filter");
            Assert.AreEqual("OnWater", ((JObject)objects[0]).Value<string>("path").TrimStart('/'));

            // The stored filter drives compare's live re-walk over the SAME surface.
            Assert.AreEqual("unchanged", Compare(_baselineRel).Value<string>("verdict"));

            // Moving the FILTERED-OUT object does not register (out of the stored surface).
            onDefault.transform.position = new Vector3(0, 0, 20);
            Assert.AreEqual("unchanged", Compare(_baselineRel).Value<string>("verdict"),
                "a change to a filtered-out object is outside the snapshot surface");
        }

        [Test]
        public void Snapshot_UnknownLayerName_Refuses()
        {
            MakeBox("Wall", Vector3.zero);
            var ex = Assert.Throws<BridgeException>(() => _scene.HandleOp("snapshot_gameplay_geometry",
                new JObject { ["output_path"] = _baselineRel, ["layers"] = new JArray { "NoSuchLayerXYZ" } }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code,
                "an unknown layer name is refused, never silently matching nothing");
        }

        // ─────────────────────────────────────────────
        // H1: collider-less ancestor deactivation
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_DeactivatedColliderlessAncestor_ReportsActiveInHierarchyChanged()
        {
            // The false-unchanged vector: an art pass deactivates a grouping parent ("turned off the
            // old Graybox container"). The parent has NO collider so it is not snapshotted itself, and
            // each child's active_self stays TRUE — only active_in_hierarchy flips. That must be a
            // changed verdict, never unchanged.
            var group = new GameObject("GrayboxGroup"); // no collider
            GameObject wallA = MakeBox("WallA", new Vector3(1, 0, 0));
            GameObject wallB = MakeBox("WallB", new Vector3(4, 0, 0));
            wallA.transform.SetParent(group.transform, true);
            wallB.transform.SetParent(group.transform, true);
            Snapshot(_baselineRel);

            group.SetActive(false);

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"),
                "deactivating a collider-less ancestor must read as CHANGED");
            var hits = result.Value<JArray>("modified").OfType<JObject>()
                .Where(m => m.Value<string>("field") == "active_in_hierarchy")
                .ToList();
            Assert.AreEqual(2, hits.Count, "both children must report an active_in_hierarchy diff");
            foreach (JObject hit in hits)
            {
                Assert.IsTrue(hit.Value<bool>("baseline"));
                Assert.IsFalse(hit.Value<bool>("current"));
            }
        }

        // ─────────────────────────────────────────────
        // H2: scene-asset-path keys + duplicate-key refusal
        // ─────────────────────────────────────────────

        [Test]
        public void Snapshot_SavedScene_KeyIsSceneAssetPathQualified()
        {
            MakeBox("Wall", Vector3.zero);
            Assert.IsTrue(EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), TestScenePath));

            Snapshot(_baselineRel);
            JObject doc = JObject.Parse(File.ReadAllText(_baselineAbs));
            string key = ((JObject)doc.Value<JArray>("objects")[0]).Value<string>("key");
            StringAssert.StartsWith(TestScenePath + "|", key,
                "identity must be keyed by the scene ASSET PATH (scene NAME is not unique across additive loads)");

            // The path-qualified key round-trips through compare on the same live scene.
            Assert.AreEqual("unchanged", Compare(_baselineRel).Value<string>("verdict"));
        }

        [Test]
        public void Snapshot_UntitledScene_KeyDisambiguatesByLoadIndex()
        {
            MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);
            JObject doc = JObject.Parse(File.ReadAllText(_baselineAbs));
            JObject obj = (JObject)doc.Value<JArray>("objects")[0];
            string key = obj.Value<string>("key");
            StringAssert.EndsWith("#0|" + obj.Value<string>("path"), key,
                "an untitled scene falls back to name + '#' + load index so two untitled scenes cannot collide");
        }

        [Test]
        public void Compare_DuplicateKeysInBaseline_RefusesInvalidParams()
        {
            // A snapshot with colliding identities cannot honestly diff — any change to the shadowed
            // object would be invisible. Refuse, never keep-first.
            MakeBox("Wall", Vector3.zero);
            Directory.CreateDirectory(Path.GetDirectoryName(_baselineAbs));
            var dup = new JObject
            {
                ["key"] = "Assets/X.unity|/Wall",
                ["path"] = "/Wall",
                ["scene"] = "X",
                ["colliders"] = new JArray(),
            };
            File.WriteAllText(_baselineAbs, new JObject
            {
                ["schema_version"] = GameplayGeometrySnapshot.SchemaVersion,
                ["objects"] = new JArray { dup, dup.DeepClone() },
            }.ToString());

            var ex = Assert.Throws<BridgeException>(() => Compare(_baselineRel));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("Duplicate gameplay-geometry key 'Assets/X.unity|/Wall'", ex.Message,
                "the refusal must NAME the colliding key");
        }

        [Test]
        public void Compare_V1Baseline_RefusedWithResnapshotMessage()
        {
            // A v1 baseline cannot prove the v2 invariants (path-qualified keys, mesh fingerprint,
            // active_in_hierarchy) — an additive-tolerant read is wrong for an honesty tool.
            MakeBox("Wall", Vector3.zero);
            Directory.CreateDirectory(Path.GetDirectoryName(_baselineAbs));
            File.WriteAllText(_baselineAbs, new JObject
            {
                ["schema_version"] = 1,
                ["objects"] = new JArray(),
            }.ToString());

            var ex = Assert.Throws<BridgeException>(() => Compare(_baselineRel));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("Re-snapshot", ex.Message);
        }

        // ─────────────────────────────────────────────
        // M1: tolerance laundering bounds
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_OversizedPositionTolerance_RefusesInvalidParams()
        {
            MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            var ex = Assert.Throws<BridgeException>(
                () => Compare(_baselineRel, new JObject { ["position"] = 9999 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code,
                "an unbounded position tolerance would launder any move — refuse above the cap");
        }

        [Test]
        public void Compare_OversizedRotationTolerance_RefusesInvalidParams()
        {
            MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            var ex = Assert.Throws<BridgeException>(
                () => Compare(_baselineRel, new JObject { ["rotation"] = 10 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code, "rotation tolerance above 5 degrees is refused");
        }

        [Test]
        public void Compare_NegativeTolerance_RefusesInvalidParams()
        {
            MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            var ex = Assert.Throws<BridgeException>(
                () => Compare(_baselineRel, new JObject { ["size"] = -0.5 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Compare_MaxAllowedTolerance_AcceptedAndEchoed()
        {
            MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            JObject result = Compare(_baselineRel, new JObject { ["position"] = 0.1, ["rotation"] = 5, ["size"] = 0.1 });
            Assert.AreEqual("unchanged", result.Value<string>("verdict"));
            Assert.AreEqual(0.1, result.Value<JObject>("tolerance").Value<double>("position"), 1e-9,
                "the applied tolerance is echoed in the result");
        }

        // ─────────────────────────────────────────────
        // M2: MeshCollider fingerprint
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_SameNamedMeshSwap_ReportsModifiedFingerprint()
        {
            var go = new GameObject("MeshWall");
            var mc = go.AddComponent<MeshCollider>();
            var mesh1 = new Mesh { name = "GeomMesh" };
            mesh1.vertices = new[] { Vector3.zero, Vector3.right, Vector3.up };
            mesh1.triangles = new[] { 0, 1, 2 };
            mc.sharedMesh = mesh1;

            var mesh2 = new Mesh { name = "GeomMesh" }; // SAME name — the spoof vector
            mesh2.vertices = new[] { Vector3.zero, Vector3.right, Vector3.up, Vector3.forward * 3f };
            mesh2.triangles = new[] { 0, 1, 2, 0, 2, 3 };
            try
            {
                Snapshot(_baselineRel);

                mc.sharedMesh = mesh2;

                JObject result = Compare(_baselineRel);
                Assert.AreEqual("changed", result.Value<string>("verdict"),
                    "a same-named mesh swap must NOT read unchanged — name alone is spoofable");
                var fields = result.Value<JArray>("modified").OfType<JObject>()
                    .Select(m => m.Value<string>("field")).ToList();
                CollectionAssert.Contains(fields, "colliders[0].vertex_count",
                    "the vertex-count fingerprint must catch the swap");
                CollectionAssert.Contains(fields, "colliders[0].triangle_count");
            }
            finally
            {
                Object.DestroyImmediate(mesh1);
                Object.DestroyImmediate(mesh2);
            }
        }

        // ─────────────────────────────────────────────
        // exact-match field flips (layer / tag / active_self)
        // ─────────────────────────────────────────────

        [Test]
        public void Compare_FlippedLayer_ReportsModifiedLayer()
        {
            GameObject wall = MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            wall.layer = 4; // Water (built-in)

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            JObject hit = result.Value<JArray>("modified").OfType<JObject>()
                .FirstOrDefault(m => m.Value<string>("field") == "layer");
            Assert.IsNotNull(hit, "a layer flip must surface as field 'layer'");
            Assert.AreEqual(0, hit.Value<int>("baseline"));
            Assert.AreEqual(4, hit.Value<int>("current"));
        }

        [Test]
        public void Compare_FlippedTag_ReportsModifiedTag()
        {
            GameObject wall = MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            wall.tag = "Player"; // built-in tag

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            JObject hit = result.Value<JArray>("modified").OfType<JObject>()
                .FirstOrDefault(m => m.Value<string>("field") == "tag");
            Assert.IsNotNull(hit, "a tag flip must surface as field 'tag'");
            Assert.AreEqual("Untagged", hit.Value<string>("baseline"));
            Assert.AreEqual("Player", hit.Value<string>("current"));
        }

        [Test]
        public void Compare_DeactivatedObjectItself_ReportsModifiedActiveSelf()
        {
            GameObject wall = MakeBox("Wall", Vector3.zero);
            Snapshot(_baselineRel);

            wall.SetActive(false);

            JObject result = Compare(_baselineRel);
            Assert.AreEqual("changed", result.Value<string>("verdict"));
            var fields = result.Value<JArray>("modified").OfType<JObject>()
                .Select(m => m.Value<string>("field")).ToList();
            CollectionAssert.Contains(fields, "active_self");
            CollectionAssert.Contains(fields, "active_in_hierarchy",
                "deactivating the object itself flips both active fields");
        }
    }
}
