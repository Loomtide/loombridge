using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the serialized-reference integrity ops (RLH-W2):
    /// scene.find_references_to, scene.validate_references, and the remap_references path on
    /// asset.replace_with_prefab. Motivating incident: a destructive prefab swap silently NULLs
    /// external serialized references into the replaced hierarchy — including refs to a CHILD
    /// under the replaced root (a minimap's cached extract-point ref pointed at a transform on a named
    /// child under the beacon), so the scan surface must equal the destroy surface.
    /// </summary>
    [TestFixture]
    public class ReferenceIntegrityTests
    {
        /// <summary>Empty marker component — stands in for the beacon's gameplay component (the extract point).</summary>
        public class BeaconExtractPoint : MonoBehaviour
        {
        }

        /// <summary>External referencer — mirrors a minimap component holding serialized refs into the beacon hierarchy.</summary>
        public class MinimapRefProbe : MonoBehaviour
        {
            public GameObject beaconGO;               // a reference to the target GameObject (root)
            public Transform beaconTransform;         // a reference to a built-in component (root or a CHILD)
            public BeaconExtractPoint extractPoint;   // a reference to a SCRIPT component in the hierarchy
        }

        private SceneHandler _sceneHandler;
        private AssetHandler _assetHandler;
        private const string TestPrefabPath = "Assets/ReferenceIntegrityTestsPrefab.prefab";
        private const string TestScenePath = "Assets/ReferenceIntegrityTestsScene.unity";

        [SetUp]
        public void SetUp()
        {
            _sceneHandler = new SceneHandler();
            _assetHandler = new AssetHandler();
        }

        [TearDown]
        public void TearDown()
        {
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPrefabPath) != null)
                AssetDatabase.DeleteAsset(TestPrefabPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestScenePath) != null)
                AssetDatabase.DeleteAsset(TestScenePath);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        private static JObject FindByPropertyPath(JArray arr, string propertyPath)
        {
            return arr.OfType<JObject>().FirstOrDefault(o => o.Value<string>("property_path") == propertyPath);
        }

        /// <summary>Beacon root + a named child "Mount"; the extract-point component lives on the CHILD (the incident shape).</summary>
        private static GameObject BuildBeaconWithMount(out GameObject mount)
        {
            var beacon = new GameObject("Beacon");
            mount = new GameObject("Mount");
            mount.transform.SetParent(beacon.transform);
            return beacon;
        }

        // ─────────────────────────────────────────────
        // scene.find_references_to
        // ─────────────────────────────────────────────

        [Test]
        public void FindReferencesTo_FindsGameObjectRefAndComponentRef()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var beacon = new GameObject("Beacon");
            BeaconExtractPoint extractPoint = beacon.AddComponent<BeaconExtractPoint>();
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconGO = beacon;               // → target GameObject
            probe.extractPoint = extractPoint;     // → a component on the target

            JObject result = _sceneHandler.HandleOp("find_references_to", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(beacon)
            });

            JArray refs = result.Value<JArray>("references");
            Assert.AreEqual(2, refs.Count, "expected exactly the GameObject ref and the component ref");
            Assert.IsFalse(result.Value<bool>("truncated"));

            JObject goHit = FindByPropertyPath(refs, "beaconGO");
            Assert.IsNotNull(goHit, "the [SerializeField] GameObject ref must be found");
            Assert.AreEqual("gameobject", goHit.Value<string>("references"));
            Assert.AreEqual("", goHit.Value<string>("relative_path"), "a root ref has an empty relative_path");
            Assert.AreEqual("MinimapRefProbe", goHit.Value<JObject>("referencing").Value<string>("component"));

            JObject compHit = FindByPropertyPath(refs, "extractPoint");
            Assert.IsNotNull(compHit, "the component ref must be found");
            Assert.AreEqual("BeaconExtractPoint", compHit.Value<string>("references"),
                "a component ref must report the target component's TYPE, not 'gameobject'");
        }

        [Test]
        public void FindReferencesTo_FindsRefToDescendantComponent_WithRelativePath()
        {
            // The incident shape: the referenced component lives on a CHILD under the target, and
            // a swap destroys the whole hierarchy — the scan surface must include descendants.
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject beacon = BuildBeaconWithMount(out GameObject mount);
            BeaconExtractPoint extractPoint = mount.AddComponent<BeaconExtractPoint>();
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.extractPoint = extractPoint;         // → component on the CHILD
            probe.beaconTransform = mount.transform;   // → built-in component on the CHILD

            JObject result = _sceneHandler.HandleOp("find_references_to", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(beacon)
            });

            JArray refs = result.Value<JArray>("references");
            JObject scriptHit = FindByPropertyPath(refs, "extractPoint");
            Assert.IsNotNull(scriptHit, "a ref to a component on a DESCENDANT must be found");
            Assert.AreEqual("BeaconExtractPoint", scriptHit.Value<string>("references"));
            Assert.AreEqual("Mount", scriptHit.Value<string>("relative_path"),
                "a descendant ref must carry the child's relative path under the target");

            JObject transformHit = FindByPropertyPath(refs, "beaconTransform");
            Assert.IsNotNull(transformHit, "a Transform ref to a descendant must be found");
            Assert.AreEqual("Mount", transformHit.Value<string>("relative_path"));
        }

        [Test]
        public void FindReferencesTo_UnrelatedTarget_ReturnsNoReferences()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var beacon = new GameObject("Beacon");
            var minimap = new GameObject("Minimap");
            minimap.AddComponent<MinimapRefProbe>().beaconGO = beacon;
            var unrelated = new GameObject("Unrelated");

            JObject result = _sceneHandler.HandleOp("find_references_to", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(unrelated)
            });

            Assert.AreEqual(0, result.Value<JArray>("references").Count,
                "an object nobody references must report zero inbound references");
        }

        [Test]
        public void FindReferencesTo_MissingLocator_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _sceneHandler.HandleOp("find_references_to", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // scene.validate_references
        // ─────────────────────────────────────────────

        [Test]
        public void ValidateReferences_ReportsNullRefAndOmitsWiredRef()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var wired = new GameObject("Wired");
            MinimapRefProbe probe = wired.AddComponent<MinimapRefProbe>();
            probe.beaconGO = wired;         // WIRED (non-null) → must NOT be reported
            probe.extractPoint = null;      // null component ref → must be reported
            probe.beaconTransform = null;   // null → must be reported

            JObject result = _sceneHandler.HandleOp("validate_references", new JObject
            {
                ["scope"] = LocatorResolver.BuildLocator(wired)
            });

            JArray nulls = result.Value<JArray>("null_references");
            JObject nullComp = FindByPropertyPath(nulls, "extractPoint");
            Assert.IsNotNull(nullComp, "a null serialized ObjectReference must be reported");
            Assert.AreEqual("MinimapRefProbe", nullComp.Value<string>("component"));
            Assert.IsFalse(nullComp.Value<bool>("missing"),
                "a never-assigned null is not a severed 'Missing' ref");

            Assert.IsNotNull(FindByPropertyPath(nulls, "beaconTransform"), "the null Transform ref must be reported");
            Assert.IsNull(FindByPropertyPath(nulls, "beaconGO"),
                "a WIRED (non-null) reference must NOT be reported — nullness is the only signal");
        }

        // ─────────────────────────────────────────────
        // asset.replace_with_prefab remap_references
        // ─────────────────────────────────────────────

        [Test]
        public void ReplaceWithPrefab_RemapReferences_RepointsRefsAndReportsUnmapped()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var beacon = new GameObject("Beacon");
            BeaconExtractPoint extractPoint = beacon.AddComponent<BeaconExtractPoint>();
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconGO = beacon;
            probe.beaconTransform = beacon.transform;
            probe.extractPoint = extractPoint;

            // Replacement prefab carries only a Transform — deliberately NO BeaconExtractPoint.
            var prefabSource = new GameObject("ReplacementPrefabSource");
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["remap_references"] = true
                });

                Assert.IsTrue(result.Value<bool>("remap_references"));
                var entry = (JObject)result.Value<JArray>("replacements")[0];
                JArray remapped = entry.Value<JArray>("remapped");
                JArray unmapped = entry.Value<JArray>("unmapped");

                // GameObject + Transform refs re-pointed onto the new instance.
                Assert.IsNotNull(FindByPropertyPath(remapped, "beaconGO"), "GameObject ref must be remapped");
                Assert.IsNotNull(FindByPropertyPath(remapped, "beaconTransform"), "Transform ref must be remapped");

                // The component type absent on the replacement is UNMAPPED, not silently dropped.
                JObject unmappedComp = FindByPropertyPath(unmapped, "extractPoint");
                Assert.IsNotNull(unmappedComp, "a ref to a missing component type must be reported unmapped");
                Assert.AreEqual("BeaconExtractPoint", unmappedComp.Value<string>("references"));
                StringAssert.Contains("BeaconExtractPoint", unmappedComp.Value<string>("reason"));

                // Live wiring: the external references now point at the NEW instance, not the destroyed beacon.
                GameObject instance = LocatorResolver.Resolve(entry.Value<JObject>("after"));
                Assert.IsTrue(probe.beaconGO != null, "GameObject ref must survive the swap (not severed)");
                Assert.AreSame(instance, probe.beaconGO, "GameObject ref must point at the replacement instance");
                Assert.AreSame(instance.transform, probe.beaconTransform, "Transform ref must point at the instance's Transform");
                // The unmapped ref is left null on destroy — surfaced via unmapped[], not hidden.
                Assert.IsTrue(probe.extractPoint == null, "the unmapped component ref nulls on destroy (reported, not preserved)");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_RemapReferences_ChildTransformRef_RepointsViaMatchingPath()
        {
            // The incident shape end-to-end: the ref points at a Transform on a CHILD ("Mount")
            // under the replaced root; the replacement prefab has a same-named child, so the remap
            // must resolve the relative path on the instance and re-point there.
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject beacon = BuildBeaconWithMount(out GameObject mount);
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconTransform = mount.transform;

            // Prefab with a matching "Mount" child.
            var prefabSource = new GameObject("ReplacementPrefabSource");
            var prefabMount = new GameObject("Mount");
            prefabMount.transform.SetParent(prefabSource.transform);
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["remap_references"] = true
                });

                var entry = (JObject)result.Value<JArray>("replacements")[0];
                JObject hit = FindByPropertyPath(entry.Value<JArray>("remapped"), "beaconTransform");
                Assert.IsNotNull(hit, "a child-Transform ref with a matching path must be REMAPPED");
                Assert.AreEqual("Mount", hit.Value<string>("relative_path"));
                Assert.AreEqual(0, entry.Value<JArray>("unmapped").Count, "nothing should be unmapped");

                GameObject instance = LocatorResolver.Resolve(entry.Value<JObject>("after"));
                Transform instanceMount = instance.transform.Find("Mount");
                Assert.IsNotNull(instanceMount, "instance must have the Mount child");
                Assert.IsTrue(probe.beaconTransform != null, "child ref must survive the swap");
                Assert.AreSame(instanceMount, probe.beaconTransform,
                    "the ref must point at the INSTANCE's Mount child, not the destroyed one");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_RemapReferences_ChildPathAbsent_ReportsUnmapped()
        {
            // The ref points at a child ("Mount") that the replacement does NOT have — the remap
            // must report it unmapped with a child-path reason, never silently drop it.
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject beacon = BuildBeaconWithMount(out GameObject mount);
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconTransform = mount.transform;

            var prefabSource = new GameObject("ReplacementPrefabSource"); // NO Mount child
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["remap_references"] = true
                });

                var entry = (JObject)result.Value<JArray>("replacements")[0];
                JObject hit = FindByPropertyPath(entry.Value<JArray>("unmapped"), "beaconTransform");
                Assert.IsNotNull(hit, "a child ref whose path is absent on the replacement must be UNMAPPED");
                StringAssert.Contains("child path", hit.Value<string>("reason"));
                StringAssert.Contains("Mount", hit.Value<string>("reason"));
                Assert.AreEqual(0, entry.Value<JArray>("remapped").Count);
                Assert.IsTrue(probe.beaconTransform == null, "the unmapped ref nulls on destroy (surfaced, not hidden)");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_DryRunRemap_EvaluatesAgainstPrefabAsset_ReportsUnmappedHonestly()
        {
            // Dry run must NOT report everything as remappable: mappability is evaluated against
            // the prefab ASSET's hierarchy (no instantiation, no mutation).
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject beacon = BuildBeaconWithMount(out GameObject mount);
            BeaconExtractPoint extractPoint = beacon.AddComponent<BeaconExtractPoint>();
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconGO = beacon;                   // root GO → mappable
            probe.beaconTransform = mount.transform;   // child "Mount" → NOT on the prefab → unmappable
            probe.extractPoint = extractPoint;         // component type NOT on the prefab → unmappable

            var prefabSource = new GameObject("ReplacementPrefabSource"); // no Mount, no BeaconExtractPoint
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["dry_run"] = true,
                    ["remap_references"] = true
                });

                Assert.IsTrue(result.Value<bool>("dry_run"));
                var entry = (JObject)result.Value<JArray>("replacements")[0];
                JArray remapped = entry.Value<JArray>("remapped");
                JArray unmapped = entry.Value<JArray>("unmapped");

                Assert.IsNotNull(FindByPropertyPath(remapped, "beaconGO"), "root GO ref would map");
                JObject childHit = FindByPropertyPath(unmapped, "beaconTransform");
                Assert.IsNotNull(childHit, "dry run must report the missing child path as would-be-unmapped");
                StringAssert.Contains("child path", childHit.Value<string>("reason"));
                JObject compHit = FindByPropertyPath(unmapped, "extractPoint");
                Assert.IsNotNull(compHit, "dry run must report the missing component type as would-be-unmapped");

                // Dry run mutates NOTHING: beacon alive, refs untouched.
                Assert.IsTrue(beacon != null && probe.extractPoint != null && probe.beaconTransform != null,
                    "dry run must not destroy or rewire anything");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_RemapReferences_CrossSceneRef_RefusedWithoutFlag_AllowedWithFlag()
        {
            // The referencing component lives in ANOTHER loaded scene: expected_scene_path guards
            // only the active scene, so a live remap must REFUSE (before ANY mutation) unless
            // allow_cross_scene_remap:true explicitly permits the cross-scene write.
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var beacon = new GameObject("Beacon");
            // Unity refuses additive NewScene while the active scene is untitled/unsaved —
            // save the primary scene to disk before creating the second one.
            Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath),
                "primary scene must save before an additive scene can be created");

            Scene extraScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            // Additive NewScene makes the NEW scene active — restore the saved primary
            // scene as active so the beacon lives in the guarded/expected scene and the
            // probe is genuinely cross-scene.
            SceneManager.SetActiveScene(scene);
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconGO = beacon;
            SceneManager.MoveGameObjectToScene(minimap, extraScene);
            Assert.AreNotEqual(SceneManager.GetActiveScene(), minimap.scene, "probe must live in the non-active scene");

            var prefabSource = new GameObject("ReplacementPrefabSource");
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                var ex = Assert.Throws<BridgeException>(() => _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["remap_references"] = true
                }));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
                StringAssert.Contains("allow_cross_scene_remap", ex.Message);
                Assert.IsTrue(beacon != null, "the refusal must land BEFORE any mutation — the source survives");
                Assert.IsTrue(probe.beaconGO != null, "no reference may have been touched by a refused call");

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true,
                    ["remap_references"] = true,
                    ["allow_cross_scene_remap"] = true
                });

                var entry = (JObject)result.Value<JArray>("replacements")[0];
                JObject hit = FindByPropertyPath(entry.Value<JArray>("remapped"), "beaconGO");
                Assert.IsNotNull(hit, "with the flag, the cross-scene ref must be remapped");
                Assert.IsNotNull(hit.Value<JObject>("referencing").Value<string>("scene_path"),
                    "each hit must report the referencing scene");
                GameObject instance = LocatorResolver.Resolve(entry.Value<JObject>("after"));
                Assert.AreSame(instance, probe.beaconGO, "the cross-scene ref points at the new instance");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_WithoutRemap_LeavesReferenceBehaviorUnchanged()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var beacon = new GameObject("Beacon");
            var minimap = new GameObject("Minimap");
            MinimapRefProbe probe = minimap.AddComponent<MinimapRefProbe>();
            probe.beaconGO = beacon;

            var prefabSource = new GameObject("ReplacementPrefabSource");
            try
            {
                _assetHandler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                JObject result = _assetHandler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(beacon) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true
                    // no remap_references → default false
                });

                Assert.IsFalse(result.Value<bool>("remap_references"));
                var entry = (JObject)result.Value<JArray>("replacements")[0];
                Assert.IsNull(entry["remapped"], "no remapped key when the flag is off");
                Assert.IsNull(entry["unmapped"], "no unmapped key when the flag is off");

                // Unchanged behavior: the external reference is silently severed by the destroy.
                Assert.IsTrue(probe.beaconGO == null,
                    "without remap_references the destroyed object's inbound ref is nulled (pre-existing behavior)");
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }
    }
}
