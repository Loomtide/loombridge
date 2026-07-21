using System.IO;
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
    [TestFixture]
    public class SceneHandlerTests
    {
        private SceneHandler _handler;
        private string _fixturePath;

        [SetUp]
        public void SetUp()
        {
            _handler = new SceneHandler();
            _fixturePath = "Assets/SceneHandlerTests_Fixture.unity";

            Scene fixture = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(fixture, _fixturePath);
        }

        [TearDown]
        public void TearDown()
        {
            if (!string.IsNullOrEmpty(_fixturePath) && File.Exists(_fixturePath))
            {
                AssetDatabase.DeleteAsset(_fixturePath);
            }

            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        [Test]
        public void OpenScene_ValidPath_LoadsScene()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var parameters = new JObject { ["path"] = _fixturePath };
            JObject result = _handler.HandleOp("open_scene", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual(_fixturePath, result.Value<string>("scene_path"));
            Assert.AreEqual("SceneHandlerTests_Fixture", result.Value<string>("scene_name"));
            Assert.IsTrue(result.Value<bool>("is_loaded"));
            Assert.AreEqual(_fixturePath, SceneManager.GetActiveScene().path);
        }

        [Test]
        public void OpenScene_MissingPath_ThrowsInvalidParams()
        {
            var parameters = new JObject();
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("open_scene", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void OpenScene_NonexistentPath_ThrowsNotFound()
        {
            var parameters = new JObject { ["path"] = "Assets/__does_not_exist__.unity" };
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("open_scene", parameters));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void OpenScene_InvalidMode_ThrowsInvalidParams()
        {
            var parameters = new JObject { ["path"] = _fixturePath, ["mode"] = "Bogus" };
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("open_scene", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void OpenScene_AdditiveMode_AddsSceneAndKeepsExisting()
        {
            Scene baseScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            int countBefore = SceneManager.sceneCount;

            var parameters = new JObject
            {
                ["path"] = _fixturePath,
                ["mode"] = "Additive"
            };
            JObject result = _handler.HandleOp("open_scene", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual(_fixturePath, result.Value<string>("scene_path"));
            Assert.AreEqual(countBefore + 1, SceneManager.sceneCount);
        }

        // ─────────────────────────────────────────────
        // duplicate_object
        // ─────────────────────────────────────────────

        [Test]
        public void DuplicateObject_CopiesObjectAndComponents()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject source = _handler.HandleOp("create_object", new JObject { ["name"] = "Original" });
            GameObject sourceGo = LocatorResolver.Resolve(source.Value<JObject>("locator"));
            sourceGo.AddComponent<BoxCollider>();

            JObject result = _handler.HandleOp("duplicate_object",
                new JObject { ["locator"] = source.Value<JObject>("locator") });

            GameObject clone = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.IsNotNull(clone);
            Assert.AreNotEqual(EntityIdCompat.Id(sourceGo), EntityIdCompat.Id(clone));
            // No "(Clone)" suffix accumulation: defaults to the source name.
            Assert.AreEqual("Original", clone.name);
            Assert.IsNotNull(clone.GetComponent<BoxCollider>());
        }

        [Test]
        public void DuplicateObject_ExplicitName_IsHonored()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject source = _handler.HandleOp("create_object", new JObject { ["name"] = "Original" });

            JObject result = _handler.HandleOp("duplicate_object", new JObject
            {
                ["locator"] = source.Value<JObject>("locator"),
                ["name"] = "Copy"
            });

            GameObject clone = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.AreEqual("Copy", clone.name);
        }

        [Test]
        public void DuplicateObject_MissingLocator_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("duplicate_object", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // set_parent
        // ─────────────────────────────────────────────

        [Test]
        public void SetParent_ReparentsUnderTarget()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject { ["name"] = "Parent" });
            JObject child = _handler.HandleOp("create_object", new JObject { ["name"] = "Child" });
            GameObject parentGo = LocatorResolver.Resolve(parent.Value<JObject>("locator"));
            GameObject childGo = LocatorResolver.Resolve(child.Value<JObject>("locator"));

            _handler.HandleOp("set_parent", new JObject
            {
                ["locator"] = child.Value<JObject>("locator"),
                ["parent"] = parent.Value<JObject>("locator")
            });

            Assert.AreSame(parentGo.transform, childGo.transform.parent);
        }

        [Test]
        public void SetParent_OmittedParent_UnparentsToRoot()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject { ["name"] = "Parent" });
            JObject child = _handler.HandleOp("create_object", new JObject
            {
                ["name"] = "Child",
                ["parent"] = parent.Value<JObject>("locator")
            });
            GameObject childGo = LocatorResolver.Resolve(child.Value<JObject>("locator"));
            Assert.IsNotNull(childGo.transform.parent);

            // Re-resolve after reparenting: the hierarchy path in the original locator
            // changes once the object moves, so resolve fresh from the returned locator.
            JObject result = _handler.HandleOp("set_parent", new JObject
            {
                ["locator"] = child.Value<JObject>("locator")
            });
            GameObject moved = LocatorResolver.Resolve(result.Value<JObject>("locator"));

            Assert.IsNull(moved.transform.parent);
        }

        [Test]
        public void SetParent_MissingLocator_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("set_parent", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // set_sibling_index (GRL-B02)
        // ─────────────────────────────────────────────

        // Build a parent "Panel" with children [A, B, C] in that sibling order (create_object
        // appends each new child as the last sibling). Returns the resolved GameObjects.
        private (GameObject parent, GameObject a, GameObject b, GameObject c) MakeThreeChildren()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject { ["name"] = "Panel" });
            JObject pl = parent.Value<JObject>("locator");
            JObject a = _handler.HandleOp("create_object", new JObject { ["name"] = "A", ["parent"] = pl });
            JObject b = _handler.HandleOp("create_object", new JObject { ["name"] = "B", ["parent"] = pl });
            JObject c = _handler.HandleOp("create_object", new JObject { ["name"] = "C", ["parent"] = pl });
            return (
                LocatorResolver.Resolve(pl),
                LocatorResolver.Resolve(a.Value<JObject>("locator")),
                LocatorResolver.Resolve(b.Value<JObject>("locator")),
                LocatorResolver.Resolve(c.Value<JObject>("locator"))
            );
        }

        [Test]
        public void SetSiblingIndex_AbsoluteIndex_Reorders()
        {
            var (parent, _, _, c) = MakeThreeChildren(); // [A, B, C]
            JObject result = _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(c),
                ["index"] = 0
            });
            Assert.AreEqual(2, result.Value<int>("oldIndex"));
            Assert.AreEqual(0, result.Value<int>("newIndex"));
            Assert.AreEqual(3, result.Value<int>("siblingCount"));
            Assert.AreEqual("C", parent.transform.GetChild(0).name);
            Assert.AreEqual("A", parent.transform.GetChild(1).name);
            Assert.AreEqual("B", parent.transform.GetChild(2).name);
        }

        [Test]
        public void SetSiblingIndex_BeforeSiblingByName_Reorders()
        {
            var (parent, _, _, c) = MakeThreeChildren(); // [A, B, C]
            // Put C immediately before A → [C, A, B]
            _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(c),
                ["before"] = "A"
            });
            Assert.AreEqual("C", parent.transform.GetChild(0).name);
            Assert.AreEqual("A", parent.transform.GetChild(1).name);
            Assert.AreEqual("B", parent.transform.GetChild(2).name);
        }

        [Test]
        public void SetSiblingIndex_AfterSiblingByLocator_Reorders()
        {
            var (parent, a, b, _) = MakeThreeChildren(); // [A, B, C]
            // Put A immediately after B → [B, A, C]
            _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(a),
                ["after"] = LocatorResolver.BuildLocator(b)
            });
            Assert.AreEqual("B", parent.transform.GetChild(0).name);
            Assert.AreEqual("A", parent.transform.GetChild(1).name);
            Assert.AreEqual("C", parent.transform.GetChild(2).name);
        }

        [Test]
        public void SetSiblingIndex_IsUndoable()
        {
            var (parent, _, _, c) = MakeThreeChildren(); // [A, B, C]
            // The fixture's create_object ops are undo-registered and batchmode never splits undo
            // groups, so PerformUndo on the shared group would rewind past the creations and
            // destroy the whole hierarchy. Isolate the reorder in its own group.
            Undo.IncrementCurrentGroup();
            _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(c),
                ["index"] = 0
            });
            Assert.AreEqual("C", parent.transform.GetChild(0).name);

            Undo.PerformUndo();

            // RegisterFullObjectHierarchyUndo may restore by recreating objects — re-resolve from
            // the scene instead of trusting cached references.
            GameObject parentAfter = GameObject.Find("Panel");
            Assert.IsNotNull(parentAfter, "undo must not destroy the hierarchy");
            Assert.AreEqual("A", parentAfter.transform.GetChild(0).name, "undo restores the original sibling order");
            Assert.AreEqual("C", parentAfter.transform.GetChild(2).name);
        }

        [Test]
        public void SetSiblingIndex_MissingLocator_Refuses()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("set_sibling_index", new JObject { ["index"] = 0 }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetSiblingIndex_NoPositionArg_Refuses()
        {
            var (_, a, _, _) = MakeThreeChildren();
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_sibling_index",
                new JObject { ["locator"] = LocatorResolver.BuildLocator(a) }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetSiblingIndex_ConflictingArgs_Refuses()
        {
            var (_, a, _, _) = MakeThreeChildren();
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(a),
                ["index"] = 0,
                ["before"] = "B"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetSiblingIndex_OutOfRangeIndex_RefusesNotClamps()
        {
            var (parent, a, _, _) = MakeThreeChildren(); // 3 children, valid indices 0..2
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(a),
                ["index"] = 5
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            // Order must be untouched by a refused reorder.
            Assert.AreEqual("A", parent.transform.GetChild(0).name);
        }

        [Test]
        public void SetSiblingIndex_ReferenceIsSelf_Refuses()
        {
            var (_, a, _, _) = MakeThreeChildren();
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(a),
                ["before"] = "A"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetSiblingIndex_ReferenceUnderDifferentParent_Refuses()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject p1 = _handler.HandleOp("create_object", new JObject { ["name"] = "P1" });
            JObject p2 = _handler.HandleOp("create_object", new JObject { ["name"] = "P2" });
            JObject c1 = _handler.HandleOp("create_object",
                new JObject { ["name"] = "C1", ["parent"] = p1.Value<JObject>("locator") });
            JObject c2 = _handler.HandleOp("create_object",
                new JObject { ["name"] = "C2", ["parent"] = p2.Value<JObject>("locator") });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_sibling_index", new JObject
            {
                ["locator"] = c1.Value<JObject>("locator"),
                ["before"] = c2.Value<JObject>("locator")
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // create_primitive (RCL-T01)
        // ─────────────────────────────────────────────

        [Test]
        public void CreatePrimitive_Cube_HasMeshAndCollider()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("create_primitive",
                new JObject { ["primitive"] = "Cube", ["name"] = "Block" });

            GameObject go = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.IsNotNull(go);
            Assert.AreEqual("Block", go.name);
            Assert.IsNotNull(go.GetComponent<MeshFilter>(), "primitive must have a mesh");
            Assert.IsNotNull(go.GetComponent<MeshRenderer>(), "primitive must have a renderer");
            Assert.IsNotNull(go.GetComponent<BoxCollider>(), "Cube must keep its auto box collider by default");
        }

        [Test]
        public void CreatePrimitive_AddColliderFalse_RemovesCollider()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("create_primitive",
                new JObject { ["primitive"] = "Sphere", ["addCollider"] = false });

            GameObject go = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.IsNotNull(go.GetComponent<MeshRenderer>(), "renderer must remain");
            Assert.IsNull(go.GetComponent<Collider>(), "addCollider:false must strip the auto collider");
        }

        [Test]
        public void CreatePrimitive_DefaultsNameToPrimitiveType()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("create_primitive", new JObject { ["primitive"] = "Capsule" });

            GameObject go = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.AreEqual("Capsule", go.name);
        }

        [Test]
        public void CreatePrimitive_AppliesParentAndTransform()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject { ["name"] = "Arena" });
            GameObject parentGo = LocatorResolver.Resolve(parent.Value<JObject>("locator"));

            JObject result = _handler.HandleOp("create_primitive", new JObject
            {
                ["primitive"] = "Cube",
                ["name"] = "Wall",
                ["parent"] = parent.Value<JObject>("locator"),
                ["worldPosition"] = new JObject { ["x"] = 5f, ["y"] = 0f, ["z"] = 2f },
                ["scale"] = new JObject { ["x"] = 10f, ["y"] = 1f, ["z"] = 0.5f }
            });

            GameObject go = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.AreSame(parentGo.transform, go.transform.parent);
            Assert.AreEqual(5f, go.transform.position.x, 0.001f);
            Assert.AreEqual(2f, go.transform.position.z, 0.001f);
            Assert.AreEqual(new Vector3(10f, 1f, 0.5f), go.transform.localScale);
        }

        [Test]
        public void CreatePrimitive_WorldPositionWinsOverLocalPosition_AndAppliesRotation()
        {
            // Under a non-origin parent, 'position' (local) and 'worldPosition' (absolute) are both
            // supplied. worldPosition must WIN (it is applied AFTER position). A wrong-order impl
            // would leave the object at parent.world(10) + local(5) = 15 and FAIL this. Rotation is
            // also asserted so a dropped-rotation impl fails.
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject
            {
                ["name"] = "Parent",
                ["worldPosition"] = new JObject { ["x"] = 10f, ["y"] = 0f, ["z"] = 0f }
            });
            GameObject parentGo = LocatorResolver.Resolve(parent.Value<JObject>("locator"));
            Assert.AreEqual(10f, parentGo.transform.position.x, 0.001f, "parent must sit at world x=10");

            JObject result = _handler.HandleOp("create_primitive", new JObject
            {
                ["primitive"] = "Cube",
                ["name"] = "Wall",
                ["parent"] = parent.Value<JObject>("locator"),
                ["position"] = new JObject { ["x"] = 5f, ["y"] = 0f, ["z"] = 0f },        // local → world 15 if it wrongly wins
                ["worldPosition"] = new JObject { ["x"] = 100f, ["y"] = 0f, ["z"] = 0f }, // absolute → must win
                ["rotation"] = new JObject { ["x"] = 0f, ["y"] = 90f, ["z"] = 0f }
            });

            GameObject go = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.AreSame(parentGo.transform, go.transform.parent);
            Assert.AreEqual(100f, go.transform.position.x, 0.001f,
                "worldPosition must win over local position (not parent.world + local = 15)");
            Assert.AreEqual(90f, go.transform.eulerAngles.y, 0.01f, "rotation (local euler y=90) must be applied");
        }

        [Test]
        public void CreatePrimitive_MissingPrimitive_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("create_primitive", new JObject { ["name"] = "x" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void CreatePrimitive_InvalidPrimitive_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("create_primitive", new JObject { ["primitive"] = "Pyramid" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // find_object (RCL-T04): unified with get_snapshot, benign not-found
        // ─────────────────────────────────────────────

        [Test]
        public void FindObject_ByName_ReturnsFoundTrueWithLocator()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            _handler.HandleOp("create_object", new JObject { ["name"] = "Player" });

            JObject result = _handler.HandleOp("find_object", new JObject { ["name"] = "Player" });

            Assert.IsTrue(result.Value<bool>("found"));
            Assert.IsNotNull(result.Value<JObject>("locator"));
        }

        [Test]
        public void FindObject_ByPath_ResolvesSpecificallyIndexZeroOfDuplicateSiblings()
        {
            // Two root siblings share a name but are DISTINGUISHABLE (different world x). get_snapshot
            // resolves index 0 via the path; find_object{path} must resolve the SAME specific object —
            // a resolver that returned index 1 (or nulled on ambiguity) would FAIL this.
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Resolve the first immediately (while still unambiguous) to pin its identity.
            JObject firstLoc = _handler.HandleOp("create_object", new JObject
            {
                ["name"] = "Enemy_Chaser",
                ["worldPosition"] = new JObject { ["x"] = 7f, ["y"] = 0f, ["z"] = 0f }
            });
            long firstId = EntityIdCompat.Id(LocatorResolver.Resolve(firstLoc.Value<JObject>("locator")));

            _handler.HandleOp("create_object", new JObject
            {
                ["name"] = "Enemy_Chaser",
                ["worldPosition"] = new JObject { ["x"] = 99f, ["y"] = 0f, ["z"] = 0f }
            });

            JObject result = _handler.HandleOp("find_object", new JObject { ["path"] = "/Enemy_Chaser" });

            Assert.IsTrue(result.Value<bool>("found"), "path with a duplicate name must resolve index 0, not null");
            GameObject resolved = LocatorResolver.Resolve(result.Value<JObject>("locator"));
            Assert.AreEqual(firstId, EntityIdCompat.Id(resolved),
                "must resolve the FIRST sibling (index 0), not the second");
            // The reported transform is the index-0 sibling's (x=7), not the index-1 sibling's (x=99).
            Assert.AreEqual(7f, result.Value<JObject>("position").Value<float>("x"), 0.001f);
        }

        [Test]
        public void FindObject_BenignMiss_ReturnsFoundFalseWithoutThrowing()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // No throw (so the OpExecutor captures no error screenshot); a structured miss instead.
            JObject byName = _handler.HandleOp("find_object", new JObject { ["name"] = "Ghost" });
            Assert.IsFalse(byName.Value<bool>("found"));
            Assert.IsTrue(byName["locator"] == null || byName["locator"].Type == JTokenType.Null);

            JObject byPath = _handler.HandleOp("find_object", new JObject { ["path"] = "/Ghost" });
            Assert.IsFalse(byPath.Value<bool>("found"));
        }

        [Test]
        public void FindObject_NoSelector_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("find_object", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // set_layer / set_tag (RCL-T05)
        // ─────────────────────────────────────────────

        [Test]
        public void SetLayer_ByName_SetsLayerIndex()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Wall" });
            GameObject go = LocatorResolver.Resolve(obj.Value<JObject>("locator"));

            // "UI" is a built-in layer at index 5.
            JObject result = _handler.HandleOp("set_layer", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["layer"] = "UI"
            });

            Assert.AreEqual(5, result.Value<int>("layer"));
            Assert.AreEqual("UI", result.Value<string>("layerName"));
            Assert.AreEqual(5, go.layer, "set_layer by name must set go.layer");
        }

        [Test]
        public void SetLayer_ByIndex_SetsLayer()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Wall" });
            GameObject go = LocatorResolver.Resolve(obj.Value<JObject>("locator"));

            // Index 2 = built-in "Ignore Raycast".
            _handler.HandleOp("set_layer", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["layer"] = 2
            });

            Assert.AreEqual(2, go.layer, "set_layer by index must set go.layer");
        }

        [Test]
        public void SetLayer_IncludeChildren_AppliesToHierarchy()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject parent = _handler.HandleOp("create_object", new JObject { ["name"] = "Arena" });
            JObject child = _handler.HandleOp("create_object", new JObject
            {
                ["name"] = "Cover",
                ["parent"] = parent.Value<JObject>("locator")
            });
            GameObject parentGo = LocatorResolver.Resolve(parent.Value<JObject>("locator"));
            GameObject childGo = LocatorResolver.Resolve(child.Value<JObject>("locator"));

            _handler.HandleOp("set_layer", new JObject
            {
                ["locator"] = parent.Value<JObject>("locator"),
                ["layer"] = 5,
                ["includeChildren"] = true
            });

            Assert.AreEqual(5, parentGo.layer);
            Assert.AreEqual(5, childGo.layer, "includeChildren must recurse to descendants");
        }

        [Test]
        public void SetLayer_UnknownName_ThrowsNotFound()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Wall" });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_layer", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["layer"] = "NoSuchLayer_ZZ"
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void SetLayer_OutOfRangeIndex_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Wall" });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_layer", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["layer"] = 99
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetTag_ExistingTag_SetsTag()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Hero" });
            GameObject go = LocatorResolver.Resolve(obj.Value<JObject>("locator"));

            // "Player" is a built-in tag.
            JObject result = _handler.HandleOp("set_tag", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["tag"] = "Player"
            });

            Assert.AreEqual("Player", result.Value<string>("tag"));
            Assert.AreEqual("Player", go.tag, "set_tag must set go.tag");
        }

        [Test]
        public void SetTag_UndefinedTag_ThrowsNotFound()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Hero" });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_tag", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator"),
                ["tag"] = "NoSuchTag_ZZ"
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void SetTag_MissingTag_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            JObject obj = _handler.HandleOp("create_object", new JObject { ["name"] = "Hero" });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_tag", new JObject
            {
                ["locator"] = obj.Value<JObject>("locator")
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // Render settings (RLH-W1)
        // ─────────────────────────────────────────────

        private const string TestSkyboxMaterialPath = "Assets/SceneHandlerTests_Skybox.mat";

        private static JObject Color(float r, float g, float b, float a = 1f)
        {
            return new JObject { ["r"] = r, ["g"] = g, ["b"] = b, ["a"] = a };
        }

        private static void AssertColorEquals(JObject color, float r, float g, float b, float a)
        {
            Assert.AreEqual(r, color.Value<float>("r"), 1e-4f, "r");
            Assert.AreEqual(g, color.Value<float>("g"), 1e-4f, "g");
            Assert.AreEqual(b, color.Value<float>("b"), 1e-4f, "b");
            Assert.AreEqual(a, color.Value<float>("a"), 1e-4f, "a");
        }

        [Test]
        public void GetRenderSettings_ReturnsFullPayload()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("get_render_settings", new JObject());

            Assert.IsNotNull(result);
            Assert.IsNotNull(result.Value<string>("ambientMode"), "ambientMode present");
            Assert.IsNotNull(result.Value<string>("fogMode"), "fogMode present");
            Assert.IsNotNull(result.Value<JObject>("ambientColor"), "ambientColor present");
            Assert.IsNotNull(result.Value<JObject>("fogColor"), "fogColor present");
            Assert.IsNotNull(result.Value<JObject>("subtractiveShadowColor"), "subtractiveShadowColor present");
            // skyboxMaterial / sun / sunEnabled are nullable — the keys must exist even when null.
            Assert.IsTrue(result.ContainsKey("skyboxMaterial"), "skyboxMaterial key present");
            Assert.IsTrue(result.ContainsKey("sun"), "sun key present");
            Assert.IsTrue(result.ContainsKey("sunEnabled"), "sunEnabled key present");
            // ambientColor (ambientLight) and ambientSkyColor are the SAME underlying property —
            // the payload must report them as mirrors.
            Assert.IsTrue(JToken.DeepEquals(
                result.Value<JObject>("ambientColor"), result.Value<JObject>("ambientSkyColor")),
                "ambientColor must mirror ambientSkyColor (same underlying property)");
        }

        [Test]
        public void SetRenderSettings_FogAndAmbient_RoundTrips()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_mode"] = "Flat",
                ["ambient_color"] = Color(0.1f, 0.2f, 0.3f, 1f),
                ["fog"] = true,
                ["fog_mode"] = "Linear",
                ["fog_color"] = Color(1f, 0f, 0f, 1f),
                ["fog_start_distance"] = 12f,
                ["fog_end_distance"] = 90f
            });

            // set returns the resulting get payload.
            Assert.AreEqual("Flat", result.Value<string>("ambientMode"));
            AssertColorEquals(result.Value<JObject>("ambientColor"), 0.1f, 0.2f, 0.3f, 1f);
            Assert.IsTrue(result.Value<bool>("fog"));
            Assert.AreEqual("Linear", result.Value<string>("fogMode"));
            AssertColorEquals(result.Value<JObject>("fogColor"), 1f, 0f, 0f, 1f);
            Assert.AreEqual(12f, result.Value<float>("fogStartDistance"), 1e-4f);
            Assert.AreEqual(90f, result.Value<float>("fogEndDistance"), 1e-4f);

            // Applied to the live RenderSettings.
            Assert.AreEqual(UnityEngine.Rendering.AmbientMode.Flat, RenderSettings.ambientMode);
            Assert.IsTrue(RenderSettings.fog);
            Assert.AreEqual(FogMode.Linear, RenderSettings.fogMode);

            // Independent read-back via get_render_settings mirrors set's return.
            JObject readBack = _handler.HandleOp("get_render_settings", new JObject());
            Assert.AreEqual("Flat", readBack.Value<string>("ambientMode"));
            AssertColorEquals(readBack.Value<JObject>("fogColor"), 1f, 0f, 0f, 1f);

            // Mutating op must dirty the active scene.
            Assert.IsTrue(SceneManager.GetActiveScene().isDirty, "set_render_settings must mark the scene dirty");
        }

        [Test]
        public void SetRenderSettings_PartialUpdate_LeavesOtherFieldsUntouched()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Establish a baseline.
            _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_color"] = Color(0.25f, 0.5f, 0.75f, 1f),
                ["fog_density"] = 0.05f,
                ["fog"] = false
            });

            // Apply a partial update touching only 'fog'.
            JObject result = _handler.HandleOp("set_render_settings", new JObject
            {
                ["fog"] = true
            });

            // The changed field applied…
            Assert.IsTrue(result.Value<bool>("fog"));
            // …and the untouched fields are preserved.
            AssertColorEquals(result.Value<JObject>("ambientColor"), 0.25f, 0.5f, 0.75f, 1f);
            Assert.AreEqual(0.05f, result.Value<float>("fogDensity"), 1e-4f);
        }

        [Test]
        public void SetRenderSettings_InvalidAmbientMode_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_mode"] = "Bogus"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("Skybox", ex.Message, "should list valid ambient modes");
        }

        [Test]
        public void SetRenderSettings_InvalidFogMode_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["fog_mode"] = "Nope"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("Linear", ex.Message, "should list valid fog modes");
        }

        [Test]
        public void SetRenderSettings_SkyboxMaterial_AssignsFromAssetPath()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Create a material asset to assign as the skybox.
            Shader shader = Shader.Find("Standard");
            Assert.IsNotNull(shader, "Standard shader should be available");
            var skyMat = new Material(shader);
            AssetDatabase.CreateAsset(skyMat, TestSkyboxMaterialPath);
            AssetDatabase.SaveAssets();

            try
            {
                JObject result = _handler.HandleOp("set_render_settings", new JObject
                {
                    ["skybox_material"] = TestSkyboxMaterialPath
                });

                Assert.AreEqual(TestSkyboxMaterialPath, result.Value<string>("skyboxMaterial"));
                Assert.IsNotNull(RenderSettings.skybox, "skybox material should be assigned");
                Assert.AreEqual(TestSkyboxMaterialPath, AssetDatabase.GetAssetPath(RenderSettings.skybox));

                // Clearing via null.
                JObject cleared = _handler.HandleOp("set_render_settings", new JObject
                {
                    ["skybox_material"] = null
                });
                Assert.IsNull(cleared.Value<string>("skyboxMaterial"), "null skybox_material clears it");
                Assert.IsNull(RenderSettings.skybox);
            }
            finally
            {
                RenderSettings.skybox = null;
                if (AssetDatabase.LoadAssetAtPath<Object>(TestSkyboxMaterialPath) != null)
                    AssetDatabase.DeleteAsset(TestSkyboxMaterialPath);
            }
        }

        [Test]
        public void SetRenderSettings_MissingSkyboxMaterial_ThrowsNotFound()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["skybox_material"] = "Assets/__no_such_skybox__.mat"
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void SetRenderSettings_SaveOnUntitledScene_RefusesWithoutApplying()
        {
            // NewScene without saving → untitled (empty Scene.path).
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            RenderSettings.fog = false;

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["fog"] = true,
                ["save"] = true
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("untitled", ex.Message);

            // Atomicity: the refusal happens in the validation phase, BEFORE any write.
            Assert.IsFalse(RenderSettings.fog, "a refused call must not apply any field");
        }

        [Test]
        public void SetRenderSettings_BadSkyboxPath_IsAtomic_LeavesFogUntouched()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Baseline fog color via the op.
            _handler.HandleOp("set_render_settings", new JObject
            {
                ["fog_color"] = Color(0.1f, 0.2f, 0.3f, 1f)
            });

            // A call that fails on the skybox must not have applied the fog color first.
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["fog_color"] = Color(0f, 1f, 0f, 1f),
                ["skybox_material"] = "Assets/__no_such_skybox__.mat"
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);

            Color fogColor = RenderSettings.fogColor;
            Assert.AreEqual(0.1f, fogColor.r, 1e-4f, "failed call must leave fogColor untouched (atomic apply)");
            Assert.AreEqual(0.2f, fogColor.g, 1e-4f);
            Assert.AreEqual(0.3f, fogColor.b, 1e-4f);
        }

        [Test]
        public void SetRenderSettings_BothAmbientColorAliases_DifferentValues_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_color"] = Color(1f, 0f, 0f, 1f),
                ["ambient_sky_color"] = Color(0f, 0f, 1f, 1f)
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("alias", ex.Message, "should explain the aliasing");
        }

        [Test]
        public void SetRenderSettings_BothAmbientColorAliases_EqualValues_Succeeds()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            JObject result = _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_color"] = Color(0.3f, 0.4f, 0.5f, 1f),
                ["ambient_sky_color"] = Color(0.3f, 0.4f, 0.5f, 1f)
            });

            AssertColorEquals(result.Value<JObject>("ambientColor"), 0.3f, 0.4f, 0.5f, 1f);
            AssertColorEquals(result.Value<JObject>("ambientSkyColor"), 0.3f, 0.4f, 0.5f, 1f);
        }

        [Test]
        public void SetRenderSettings_EmptyParams_DoesNotDirtyScene()
        {
            // SetUp saved the fixture scene, so the active scene starts clean.
            Assert.IsFalse(SceneManager.GetActiveScene().isDirty, "precondition: scene starts clean");

            JObject result = _handler.HandleOp("set_render_settings", new JObject());

            Assert.IsNotNull(result, "no-op set still returns the payload");
            Assert.IsFalse(SceneManager.GetActiveScene().isDirty,
                "an empty set_render_settings call must not dirty the scene");
        }

        [Test]
        public void SetRenderSettings_CustomAmbientMode_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_mode"] = "Custom"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("ambient probe", ex.Message, "should explain WHY Custom is refused");
        }

        [Test]
        public void SetRenderSettings_NonObjectColor_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["ambient_color"] = "red"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("ambient_color", ex.Message);
        }

        [Test]
        public void SetRenderSettings_SkyboxPathIsNotAMaterial_ThrowsInvalidParams()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // The fixture scene asset exists but is a SceneAsset, not a Material.
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_render_settings", new JObject
            {
                ["skybox_material"] = _fixturePath
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("not a Material", ex.Message,
                "a wrong-typed asset should be distinguished from a missing one");
        }
    }
}
