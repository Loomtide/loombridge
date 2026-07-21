using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class AnimatorHandlerTests
    {
        private AnimatorHandler _handler;
        private const string TestControllerPath = "Assets/TestAnimatorHandler.controller";
        private const string TestClipAPath = "Assets/TestAnimatorHandlerClipA.anim";
        private const string TestClipBPath = "Assets/TestAnimatorHandlerClipB.anim";

        [SetUp]
        public void SetUp()
        {
            _handler = new AnimatorHandler();
            CleanUpTestAssets();
        }

        [TearDown]
        public void TearDown()
        {
            CleanUpTestAssets();
        }

        private static void CleanUpTestAssets()
        {
            if (AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath) != null)
                AssetDatabase.DeleteAsset(TestControllerPath);
            if (AssetDatabase.LoadAssetAtPath<AnimationClip>(TestClipAPath) != null)
                AssetDatabase.DeleteAsset(TestClipAPath);
            if (AssetDatabase.LoadAssetAtPath<AnimationClip>(TestClipBPath) != null)
                AssetDatabase.DeleteAsset(TestClipBPath);
        }

        private static AnimationClip CreateClip(string path, string clipName)
        {
            var clip = new AnimationClip { name = clipName };
            AssetDatabase.CreateAsset(clip, path);
            AssetDatabase.ImportAsset(path);
            return clip;
        }

        private static AnimatorState FindState(AnimatorController controller, string stateName)
        {
            foreach (var childState in controller.layers[0].stateMachine.states)
            {
                if (childState.state.name == stateName)
                    return childState.state;
            }
            return null;
        }

        [Test]
        public void IsAsync_ReturnsFalse()
        {
            Assert.IsFalse(_handler.IsAsync("create_controller"));
            Assert.IsFalse(_handler.IsAsync("apply_spec"));
        }

        [Test]
        public void CreateController_CreatesAsset()
        {
            var parameters = new JObject { ["path"] = TestControllerPath };
            JObject result = _handler.HandleOp("create_controller", parameters);

            Assert.AreEqual(TestControllerPath, result.Value<string>("path"));
            Assert.IsTrue(result.Value<bool>("created"));

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            Assert.IsNotNull(controller);
        }

        [Test]
        public void AddParameter_AddsToController()
        {
            // Create controller first
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });

            var parameters = new JObject
            {
                ["path"] = TestControllerPath,
                ["name"] = "Speed",
                ["type"] = "Float",
                ["defaultValue"] = 1.5f
            };
            _handler.HandleOp("add_parameter", parameters);

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            Assert.AreEqual(1, controller.parameters.Length);
            Assert.AreEqual("Speed", controller.parameters[0].name);
            Assert.AreEqual(AnimatorControllerParameterType.Float, controller.parameters[0].type);
            Assert.AreEqual(1.5f, controller.parameters[0].defaultFloat, 0.001f);
        }

        [Test]
        public void AddState_AddsToStateMachine()
        {
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });

            var parameters = new JObject
            {
                ["path"] = TestControllerPath,
                ["state_name"] = "Idle"
            };
            JObject result = _handler.HandleOp("add_state", parameters);

            Assert.AreEqual("Idle", result.Value<string>("state_name"));

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            // Default layer has 1 auto-created state + our added state
            bool found = false;
            foreach (var s in controller.layers[0].stateMachine.states)
            {
                if (s.state.name == "Idle") { found = true; break; }
            }
            Assert.IsTrue(found, "Idle state should exist");
        }

        [Test]
        public void GetStateMachine_ReturnsJsonStructure()
        {
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            _handler.HandleOp("add_parameter", new JObject
            {
                ["path"] = TestControllerPath,
                ["name"] = "Speed",
                ["type"] = "Float"
            });

            JObject result = _handler.HandleOp("get_state_machine",
                new JObject { ["path"] = TestControllerPath });

            Assert.IsNotNull(result["parameters"]);
            Assert.IsNotNull(result["layers"]);
            Assert.AreEqual(1, ((JArray)result["parameters"]).Count);
        }

        [Test]
        public void ApplySpec_CreatesControllerOnFirstUse()
        {
            // apply_spec should create the controller if it doesn't exist
            var spec = new JObject
            {
                ["parameters"] = new JArray
                {
                    new JObject { ["name"] = "Speed", ["type"] = "Float", ["defaultValue"] = 0 }
                },
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "Idle", ["position"] = new JObject { ["x"] = 200, ["y"] = 0 } }
                        },
                        ["transitions"] = new JArray(),
                        ["defaultState"] = "Idle"
                    }
                }
            };

            var parameters = new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = spec
            };

            JObject result = _handler.HandleOp("apply_spec", parameters);

            Assert.IsNotNull(result["added"]);
            Assert.IsTrue(((JArray)result["added"]).Count > 0);

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            Assert.IsNotNull(controller, "Controller should have been created");
        }

        [Test]
        public void ApplySpec_Idempotent_SecondApplyAllUnchanged()
        {
            var spec = new JObject
            {
                ["parameters"] = new JArray
                {
                    new JObject { ["name"] = "Jump", ["type"] = "Trigger" }
                },
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "Idle", ["position"] = new JObject { ["x"] = 200, ["y"] = 0 } }
                        },
                        ["transitions"] = new JArray(),
                        ["defaultState"] = "Idle"
                    }
                }
            };

            var parameters = new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = spec
            };

            // First apply
            _handler.HandleOp("apply_spec", parameters);

            // Second apply — should be all unchanged
            JObject result2 = _handler.HandleOp("apply_spec", parameters);

            JArray added2 = result2.Value<JArray>("added");
            JArray unchanged2 = result2.Value<JArray>("unchanged");
            Assert.AreEqual(0, added2.Count, "Second apply should add nothing");
            Assert.IsTrue(unchanged2.Count > 0, "Second apply should have unchanged items");
        }

        [Test]
        public void ApplySpec_BindsStateMotionFromNativeClip_NonNullMotion()
        {
            // (a) A state carrying a 'motion' asset path must end up with non-null m_Motion —
            // the exact regression the art-integration dogfood hit (states created with null motion).
            CreateClip(TestClipAPath, "IdleClip");

            var spec = new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject
                            {
                                ["name"] = "Idle",
                                ["position"] = new JObject { ["x"] = 200, ["y"] = 0 },
                                ["motion"] = TestClipAPath
                            }
                        },
                        ["defaultState"] = "Idle"
                    }
                }
            };

            _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = spec
            });

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            AnimatorState idle = FindState(controller, "Idle");
            Assert.IsNotNull(idle, "Idle state should exist");
            Assert.IsNotNull(idle.motion, "Idle state m_Motion must be bound (non-null)");
            Assert.AreEqual(TestClipAPath, AssetDatabase.GetAssetPath(idle.motion),
                "Bound motion should be the created clip asset");
        }

        [Test]
        public void ApplySpec_UnsupportedStateField_RefusesInvalidParams()
        {
            // (b) An unsupported state field is a hard refusal, never a silent drop.
            var spec = new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "Idle", ["bogusField"] = 42 }
                        }
                    }
                }
            };

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = spec
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("bogusField", ex.Message,
                "Refusal must name the unsupported field");
        }

        [Test]
        public void SetStateMotion_BindsAndRebindsExistingState()
        {
            // (c) set_state_motion binds an existing state's motion, then re-binds to another clip.
            _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject
                {
                    ["layers"] = new JArray
                    {
                        new JObject
                        {
                            ["name"] = "Base Layer",
                            ["states"] = new JArray { new JObject { ["name"] = "Idle" } },
                            ["defaultState"] = "Idle"
                        }
                    }
                }
            });

            CreateClip(TestClipAPath, "A");
            CreateClip(TestClipBPath, "B");

            // Bind A
            JObject bindA = _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipAPath }
            });
            Assert.IsTrue(bindA.Value<bool>("motionBound"));

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            AnimatorState idle = FindState(controller, "Idle");
            Assert.IsNotNull(idle.motion, "Motion should be bound after first set_state_motion");
            Assert.AreEqual(TestClipAPath, AssetDatabase.GetAssetPath(idle.motion));

            // Re-bind B, and set a speed.
            JObject bindB = _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipBPath },
                ["speed"] = 1.5f
            });
            Assert.IsTrue(bindB.Value<bool>("motionChanged"), "Re-bind to a new clip should report motionChanged");
            Assert.IsTrue(bindB.Value<bool>("speedChanged"), "New speed should report speedChanged");

            controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            idle = FindState(controller, "Idle");
            Assert.AreEqual(TestClipBPath, AssetDatabase.GetAssetPath(idle.motion),
                "Motion should be re-bound to the second clip");
            Assert.AreEqual(1.5f, idle.speed, 0.001f, "Speed should have been applied");

            // D7: a no-op re-bind (same clip, same speed) must NOT claim a change.
            JObject noOp = _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipBPath },
                ["speed"] = 1.5f
            });
            Assert.IsTrue(noOp.Value<bool>("motionBound"), "Motion stays bound on a no-op re-bind");
            Assert.IsFalse(noOp.Value<bool>("motionChanged"), "No-op re-bind must not claim motionChanged");
            Assert.IsFalse(noOp.Value<bool>("speedChanged"), "No-op speed must not claim speedChanged");
        }

        [Test]
        public void SetStateMotion_SpeedOnly_UpdatesWithoutMotion()
        {
            // D7: motion is optional when speed is provided (speed-only update).
            _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject
                {
                    ["layers"] = new JArray
                    {
                        new JObject
                        {
                            ["name"] = "Base Layer",
                            ["states"] = new JArray { new JObject { ["name"] = "Idle" } }
                        }
                    }
                }
            });

            JObject result = _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["speed"] = 2.0f
            });
            Assert.IsTrue(result.Value<bool>("speedChanged"));
            Assert.IsFalse(result.Value<bool>("motionChanged"));
            Assert.IsFalse(result.Value<bool>("motionBound"), "No motion was provided or previously bound");

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            AnimatorState idle = FindState(controller, "Idle");
            Assert.AreEqual(2.0f, idle.speed, 0.001f);
            Assert.IsNull(idle.motion, "Speed-only update must not touch the motion");
        }

        [Test]
        public void SetStateMotion_NeitherMotionNorSpeed_RefusesInvalidParams()
        {
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            _handler.HandleOp("add_state", new JObject
            {
                ["path"] = TestControllerPath,
                ["state_name"] = "Idle"
            });

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle"
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void SetStateMotion_UnknownMotionKey_RefusesInvalidParams()
        {
            // D2: a typo'd motion selector (assetPath instead of asset_path) must refuse,
            // never fall through and bind an arbitrary clip.
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            _handler.HandleOp("add_state", new JObject
            {
                ["path"] = TestControllerPath,
                ["state_name"] = "Idle"
            });
            CreateClip(TestClipAPath, "A");

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["assetPath"] = TestClipAPath }
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("assetPath", ex.Message, "Refusal must name the unknown motion key");
        }

        [Test]
        public void SetStateMotion_AmbiguousContainer_RefusesListingCandidates()
        {
            // D5: a container with more than one Motion-assignable sub-asset and NO
            // sub_asset selector must refuse listing the candidates, not bind the first.
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            _handler.HandleOp("add_state", new JObject
            {
                ["path"] = TestControllerPath,
                ["state_name"] = "Idle"
            });

            var main = new AnimationClip { name = "MainClip" };
            AssetDatabase.CreateAsset(main, TestClipAPath);
            var extra = new AnimationClip { name = "ExtraClip" };
            AssetDatabase.AddObjectToAsset(extra, TestClipAPath);
            AssetDatabase.ImportAsset(TestClipAPath);

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipAPath }
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            // Unity renames a MAIN asset to its file name on import, so "MainClip"
            // becomes the file's base name in the candidate list — assert on that,
            // not the pre-import object name.
            string mainName = Path.GetFileNameWithoutExtension(TestClipAPath);
            StringAssert.Contains(mainName, ex.Message, "Ambiguity refusal should list candidate names");
            StringAssert.Contains("ExtraClip", ex.Message, "Ambiguity refusal should list candidate names");

            // An explicit sub_asset disambiguates and binds.
            JObject bound = _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipAPath, ["sub_asset"] = "ExtraClip" }
            });
            Assert.IsTrue(bound.Value<bool>("motionBound"));
            Assert.AreEqual("ExtraClip", bound.Value<string>("motion"));
        }

        [Test]
        public void SetStateMotion_MissingSubAsset_ErrorsDistinguishably()
        {
            // (d) A sub_asset that does not exist (even after a refresh-and-retry) returns a
            // distinguishable error noting the asset may not be imported yet.
            _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject
                {
                    ["layers"] = new JArray
                    {
                        new JObject
                        {
                            ["name"] = "Base Layer",
                            ["states"] = new JArray { new JObject { ["name"] = "Idle" } }
                        }
                    }
                }
            });

            CreateClip(TestClipAPath, "A");

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "Idle",
                ["motion"] = new JObject { ["asset_path"] = TestClipAPath, ["sub_asset"] = "DoesNotExist" }
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
            StringAssert.Contains("imported", ex.Message,
                "The distinguishable error should note the asset may not be imported yet");
        }

        [Test]
        public void SetStateMotion_UnknownState_ThrowsNotFound()
        {
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            CreateClip(TestClipAPath, "A");

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_state_motion", new JObject
            {
                ["controller_path"] = TestControllerPath,
                ["state_name"] = "NoSuchState",
                ["motion"] = new JObject { ["asset_path"] = TestClipAPath }
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ─────────────────────────────────────────────
        // D1 — whole-spec refusal surface (refuse-not-skip)
        // ─────────────────────────────────────────────

        private BridgeException AssertApplySpecRefuses(JObject spec, string expectedInMessage)
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = spec
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains(expectedInMessage, ex.Message,
                $"Refusal must name '{expectedInMessage}'");
            return ex;
        }

        [Test]
        public void ApplySpec_UnknownTopLevelKey_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray(),
                ["bogusTop"] = true
            }, "bogusTop");
        }

        [Test]
        public void ApplySpec_UnknownParameterKey_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["parameters"] = new JArray
                {
                    new JObject { ["name"] = "Speed", ["type"] = "Float", ["bogusParam"] = 1 }
                }
            }, "bogusParam");
        }

        [Test]
        public void ApplySpec_UnknownLayerKey_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject { ["name"] = "Base Layer", ["bogusLayer"] = "x" }
                }
            }, "bogusLayer");
        }

        [Test]
        public void ApplySpec_UnknownTransitionKey_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "A" },
                            new JObject { ["name"] = "B" }
                        },
                        ["transitions"] = new JArray
                        {
                            new JObject { ["from"] = "A", ["to"] = "B", ["bogusTrans"] = 1 }
                        }
                    }
                }
            }, "bogusTrans");
        }

        [Test]
        public void ApplySpec_UnknownConditionKey_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["parameters"] = new JArray
                {
                    new JObject { ["name"] = "Go", ["type"] = "Bool" }
                },
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "A" },
                            new JObject { ["name"] = "B" }
                        },
                        ["transitions"] = new JArray
                        {
                            new JObject
                            {
                                ["from"] = "A",
                                ["to"] = "B",
                                ["conditions"] = new JArray
                                {
                                    new JObject { ["parameter"] = "Go", ["mode"] = "If", ["bogusCond"] = 1 }
                                }
                            }
                        }
                    }
                }
            }, "bogusCond");
        }

        [Test]
        public void ApplySpec_UnknownMotionKey_Refuses()
        {
            // D2: a typo'd motion selector inside apply_spec must refuse.
            CreateClip(TestClipAPath, "A");
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject
                            {
                                ["name"] = "Idle",
                                ["motion"] = new JObject { ["assetPath"] = TestClipAPath }
                            }
                        }
                    }
                }
            }, "assetPath");
        }

        [Test]
        public void ApplySpec_TransitionToMissingState_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray { new JObject { ["name"] = "A" } },
                        ["transitions"] = new JArray
                        {
                            new JObject { ["from"] = "A", ["to"] = "Ghost" }
                        }
                    }
                }
            }, "Ghost");
        }

        [Test]
        public void ApplySpec_TransitionFromMissingState_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray { new JObject { ["name"] = "A" } },
                        ["transitions"] = new JArray
                        {
                            new JObject { ["from"] = "Ghost", ["to"] = "A" }
                        }
                    }
                }
            }, "Ghost");
        }

        [Test]
        public void ApplySpec_DefaultStateMissing_Refuses()
        {
            AssertApplySpecRefuses(new JObject
            {
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray { new JObject { ["name"] = "A" } },
                        ["defaultState"] = "Ghost"
                    }
                }
            }, "Ghost");
        }

        [Test]
        public void ApplySpec_TransitionToExistingControllerState_IsAccepted()
        {
            // Endpoint validation runs against the POST-APPLY set, which includes states
            // already in the controller but absent from this spec.
            _handler.HandleOp("create_controller", new JObject { ["path"] = TestControllerPath });
            _handler.HandleOp("add_state", new JObject
            {
                ["path"] = TestControllerPath,
                ["state_name"] = "Existing"
            });

            JObject result = _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject
                {
                    ["layers"] = new JArray
                    {
                        new JObject
                        {
                            ["name"] = "Base Layer",
                            ["states"] = new JArray { new JObject { ["name"] = "New" } },
                            ["transitions"] = new JArray
                            {
                                new JObject { ["from"] = "New", ["to"] = "Existing" }
                            }
                        }
                    }
                }
            });

            JArray added = result.Value<JArray>("added");
            bool foundTransition = false;
            foreach (var item in added)
            {
                if (item.ToString() == "transition:New->Existing") { foundTransition = true; break; }
            }
            Assert.IsTrue(foundTransition, "Transition to a pre-existing controller state should be added");
        }

        // ─────────────────────────────────────────────
        // D3 — atomicity (validate-then-apply)
        // ─────────────────────────────────────────────

        [Test]
        public void ApplySpec_RefusedSpec_LeavesControllerUntouched()
        {
            // Establish a known-good controller: 1 parameter, 1 state.
            _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject
                {
                    ["parameters"] = new JArray
                    {
                        new JObject { ["name"] = "Speed", ["type"] = "Float" }
                    },
                    ["layers"] = new JArray
                    {
                        new JObject
                        {
                            ["name"] = "Base Layer",
                            ["states"] = new JArray { new JObject { ["name"] = "Idle" } },
                            ["defaultState"] = "Idle"
                        }
                    }
                }
            });

            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            int paramCountBefore = controller.parameters.Length;
            int stateCountBefore = controller.layers[0].stateMachine.states.Length;

            // A spec that adds a new parameter and a VALID first state, but whose second
            // state carries an unknown field: the whole apply must refuse and mutate NOTHING.
            var badSpec = new JObject
            {
                ["parameters"] = new JArray
                {
                    new JObject { ["name"] = "Jump", ["type"] = "Trigger" }
                },
                ["layers"] = new JArray
                {
                    new JObject
                    {
                        ["name"] = "Base Layer",
                        ["states"] = new JArray
                        {
                            new JObject { ["name"] = "Run" },
                            new JObject { ["name"] = "Bad", ["bogusField"] = 1 }
                        }
                    }
                }
            };

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = badSpec
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);

            controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath);
            Assert.AreEqual(paramCountBefore, controller.parameters.Length,
                "A refused spec must not add parameters");
            Assert.AreEqual(stateCountBefore, controller.layers[0].stateMachine.states.Length,
                "A refused spec must not add states");
            Assert.IsNull(FindState(controller, "Run"),
                "Even the valid state before the refusal point must not be applied");
        }

        [Test]
        public void ApplySpec_RefusedSpec_DoesNotCreateMissingController()
        {
            // Validation runs BEFORE the controller is created, so a refused spec on a
            // nonexistent path leaves no empty controller behind.
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("apply_spec", new JObject
            {
                ["path"] = TestControllerPath,
                ["spec"] = new JObject { ["bogusTop"] = 1 }
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            Assert.IsNull(AssetDatabase.LoadAssetAtPath<AnimatorController>(TestControllerPath),
                "A refused spec must not create the controller asset");
        }

        [Test]
        public void UnknownOp_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("nonexistent", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }
    }
}
