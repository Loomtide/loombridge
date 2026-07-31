using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class ComponentHandlerTests
    {
        private ComponentHandler _handler;
        private GameObject _testGo;
        private GameObject _targetGo;
        private string _tempAssetPath;
        private string _tempWavPath;
        private string _tempMixerPath;
        private string _tempMultiAssetPath;

        [SetUp]
        public void SetUp()
        {
            _handler = new ComponentHandler();
            _testGo = new GameObject("ComponentHandlerTestObject");
            _targetGo = new GameObject("ComponentHandlerTargetObject");
        }

        [TearDown]
        public void TearDown()
        {
            if (!string.IsNullOrEmpty(_tempAssetPath))
            {
                AssetDatabase.DeleteAsset(_tempAssetPath);
                _tempAssetPath = null;
            }

            if (!string.IsNullOrEmpty(_tempWavPath))
            {
                AssetDatabase.DeleteAsset(_tempWavPath);
                _tempWavPath = null;
            }

            if (!string.IsNullOrEmpty(_tempMixerPath))
            {
                AssetDatabase.DeleteAsset(_tempMixerPath);
                _tempMixerPath = null;
            }

            if (!string.IsNullOrEmpty(_tempMultiAssetPath))
            {
                AssetDatabase.DeleteAsset(_tempMultiAssetPath);
                _tempMultiAssetPath = null;
            }

            if (_targetGo != null)
                UnityEngine.Object.DestroyImmediate(_targetGo);

            if (_testGo != null)
                UnityEngine.Object.DestroyImmediate(_testGo);
        }

        // ─────────────────────────────────────────────
        // component.add
        // ─────────────────────────────────────────────

        [Test]
        public void Add_Rigidbody2D_ComponentExists()
        {
            var locator = LocatorResolver.BuildLocator(_testGo);
            var parameters = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "Rigidbody2D"
            };

            JObject result = _handler.HandleOp("add", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual("Rigidbody2D", result.Value<string>("component_type"));
            Assert.IsNotNull(_testGo.GetComponent<Rigidbody2D>());
        }

        // ─────────────────────────────────────────────
        // component.list
        // ─────────────────────────────────────────────

        [Test]
        public void List_ReturnsKnownComponents()
        {
            _testGo.AddComponent<Rigidbody2D>();
            var locator = LocatorResolver.BuildLocator(_testGo);
            var parameters = new JObject
            {
                ["locator"] = locator
            };

            JObject result = _handler.HandleOp("list", parameters);

            Assert.IsNotNull(result);
            JArray components = result.Value<JArray>("components");
            Assert.IsNotNull(components);
            Assert.Greater(components.Count, 0);

            // Should contain Transform (always present) and Rigidbody2D
            bool hasTransform = false;
            bool hasRigidbody2D = false;
            foreach (JToken item in components)
            {
                string typeName = item.Value<string>("type_name");
                if (typeName == "Transform") hasTransform = true;
                if (typeName == "Rigidbody2D") hasRigidbody2D = true;
            }
            Assert.IsTrue(hasTransform, "Should list Transform");
            Assert.IsTrue(hasRigidbody2D, "Should list Rigidbody2D");
        }

        // ─────────────────────────────────────────────
        // component.set_property + component.get_properties
        // ─────────────────────────────────────────────

        [Test]
        public void SetProperty_Float_ReadBackVerified()
        {
            _testGo.AddComponent<Rigidbody2D>();
            var locator = LocatorResolver.BuildLocator(_testGo);

            // Set gravityScale via set_property
            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "Rigidbody2D",
                ["property_path"] = "m_GravityScale",
                ["value"] = 5.0f
            };

            JObject setResult = _handler.HandleOp("set_property", setParams);
            Assert.IsNotNull(setResult);

            // Read back via get_properties with include_paths filter
            var getParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "Rigidbody2D",
                ["include_paths"] = new JArray { "m_GravityScale" }
            };

            JObject getResult = _handler.HandleOp("get_properties", getParams);
            Assert.IsNotNull(getResult);

            JArray props = getResult.Value<JArray>("properties");
            Assert.IsNotNull(props);
            Assert.AreEqual(1, props.Count);

            float gravityScale = (props[0] as JObject).Value<float>("currentValue");
            Assert.AreEqual(5.0f, gravityScale, 0.001f);
        }

        [Test]
        public void SetProperty_ObjectReference_LocatorAssignsTransform()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            var locator = LocatorResolver.BuildLocator(_testGo);
            var targetLocator = LocatorResolver.BuildLocator(_targetGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "targetTransform",
                ["value"] = new JObject
                {
                    ["locator"] = targetLocator
                }
            };

            _handler.HandleOp("set_property", setParams);

            Assert.AreEqual(_targetGo.transform, component.targetTransform);
        }

        [Test]
        public void SetProperty_ObjectReference_AssetPathStringAssignsAsset()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            string assetPath = CreateTempAsset();
            var locator = LocatorResolver.BuildLocator(_testGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "assetRef",
                ["value"] = assetPath
            };

            _handler.HandleOp("set_property", setParams);

            Assert.IsNotNull(component.assetRef);
            Assert.AreEqual("DummyAsset", component.assetRef.name);
        }

        [Test]
        public void SetProperty_ObjectReference_NullClearsReference()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            component.targetGameObject = _targetGo;
            var locator = LocatorResolver.BuildLocator(_testGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "targetGameObject",
                ["value"] = JValue.CreateNull()
            };

            _handler.HandleOp("set_property", setParams);

            Assert.IsNull(component.targetGameObject);
        }

        [Test]
        public void SetProperty_ObjectReference_LocatorTypeMismatchThrowsInvalidType()
        {
            _testGo.AddComponent<ObjectReferenceTestComponent>();
            var locator = LocatorResolver.BuildLocator(_testGo);
            var targetLocator = LocatorResolver.BuildLocator(_targetGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "assetRef",
                ["value"] = new JObject
                {
                    ["locator"] = targetLocator
                }
            };

            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("set_property", setParams));

            Assert.AreEqual(ErrorCodes.INVALID_TYPE, ex.Code);
        }

        [Test]
        public void SetProperty_Array_Ints_SetsAllElements()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            var locator = LocatorResolver.BuildLocator(_testGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "numbers",
                ["value"] = new JArray { 1, 2, 3 }
            };

            _handler.HandleOp("set_property", setParams);

            Assert.AreEqual(new[] { 1, 2, 3 }, component.numbers);
        }

        [Test]
        public void SetProperty_Array_ObjectReferences_SetsAllElements()
        {
            // Sprite[] animation frames go through this path: an array of asset
            // references, each resolved (here by typed search) to the expected type.
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            string assetPath = CreateTempAsset();
            var locator = LocatorResolver.BuildLocator(_testGo);

            var setParams = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "assetRefs",
                ["value"] = new JArray { assetPath, assetPath }
            };

            _handler.HandleOp("set_property", setParams);

            Assert.IsNotNull(component.assetRefs);
            Assert.AreEqual(2, component.assetRefs.Length);
            Assert.AreEqual("DummyAsset", component.assetRefs[0].name);
            Assert.AreEqual("DummyAsset", component.assetRefs[1].name);
        }

        // ─────────────────────────────────────────────
        // component.remove
        // ─────────────────────────────────────────────

        [Test]
        public void Remove_Rigidbody2D_ComponentGone()
        {
            _testGo.AddComponent<Rigidbody2D>();
            var locator = LocatorResolver.BuildLocator(_testGo);
            var parameters = new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "Rigidbody2D"
            };

            JObject result = _handler.HandleOp("remove", parameters);
            Assert.IsNotNull(result);

            Assert.IsNull(_testGo.GetComponent<Rigidbody2D>());
        }

        // ─────────────────────────────────────────────
        // Error Cases
        // ─────────────────────────────────────────────

        [Test]
        public void UnknownOp_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("totally_unknown", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void IsAsync_AlwaysFalse()
        {
            Assert.IsFalse(_handler.IsAsync("list"));
            Assert.IsFalse(_handler.IsAsync("add"));
            Assert.IsFalse(_handler.IsAsync("remove"));
        }

        private string CreateTempAsset()
        {
            string dir = "Assets/Temp";
            Directory.CreateDirectory(dir);
            _tempAssetPath = $"{dir}/ComponentHandlerTests-{Guid.NewGuid():N}.asset";

            var asset = ScriptableObject.CreateInstance<DummyObjectAsset>();
            asset.name = "DummyAsset";
            AssetDatabase.CreateAsset(asset, _tempAssetPath);
            AssetDatabase.SaveAssets();
            AssetDatabase.ImportAsset(_tempAssetPath, ImportAssetOptions.ForceSynchronousImport);

            return _tempAssetPath;
        }

        // ─────────────────────────────────────────────
        // RLH-W2: AudioClip + AudioMixerGroup object-reference parity
        //
        // These prove the generic resolver already binds audio refs the same way it binds
        // Sprites — the field's PPtr<> type is resolved by short name (AudioClip /
        // AudioMixerGroup) and AssetReferenceResolver.Load returns the main asset (AudioClip
        // of a .wav) or the named sub-asset (an AudioMixerGroup of a .mixer). No resolver
        // change was needed; these are the regression proof + the documentation anchor.
        // ─────────────────────────────────────────────

        [Test]
        public void SetProperty_ObjectReference_AudioClip_BindsFromWavAssetPath()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            string wavPath = CreateTempWav();
            var locator = LocatorResolver.BuildLocator(_testGo);

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "audioClip",
                ["value"] = wavPath // string asset path, resolved to the AudioClip main asset
            });

            Assert.IsNotNull(component.audioClip, "AudioClip field must bind from a .wav asset path");
            Assert.IsInstanceOf<AudioClip>(component.audioClip);
        }

        [Test]
        public void SetProperty_ObjectReference_AudioMixerGroup_BindsSubAssetFromMixer()
        {
            // Headless AudioMixer creation can surface benign editor error logs; tolerate them so
            // this proves the BINDING, not the editor's mixer-authoring chatter.
            LogAssert.ignoreFailingMessages = true;
            try
            {
                string mixerPath = TryCreateTempMixer(out string masterGroupName);
                if (mixerPath == null)
                {
                    Assert.Inconclusive(
                        "Could not create an AudioMixer headlessly on this Unity version " +
                        "(UnityEditor.Audio.AudioMixerController.CreateMixerControllerAtPath not " +
                        "reachable). The named-sub-asset selection path is still covered " +
                        "unconditionally by SetProperty_ObjectReference_NamedSubAsset_SelectsByName" +
                        "NotMainAsset, and the type resolution by SetProperty_ObjectReference_" +
                        "AudioMixerGroup_TypeResolves; live-smoke covers the end-to-end mixer bind.");
                    return;
                }

                var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
                var locator = LocatorResolver.BuildLocator(_testGo);

                _handler.HandleOp("set_property", new JObject
                {
                    ["locator"] = locator,
                    ["type_name"] = "ObjectReferenceTestComponent",
                    ["property_path"] = "mixerGroup",
                    ["value"] = new JObject
                    {
                        // The .mixer's main asset is the AudioMixer; the group is a named sub-asset.
                        ["asset_path"] = mixerPath,
                        ["sub_asset"] = masterGroupName
                    }
                });

                Assert.IsNotNull(component.mixerGroup,
                    "AudioMixerGroup field must bind from { asset_path: <.mixer>, sub_asset: <group> }");
                Assert.IsInstanceOf<UnityEngine.Audio.AudioMixerGroup>(component.mixerGroup);
                Assert.AreEqual(masterGroupName, component.mixerGroup.name,
                    "the named group sub-asset must be the one bound");
            }
            finally
            {
                LogAssert.ignoreFailingMessages = false;
            }
        }

        // Deterministic (no mixer asset needed): the field's PPtr<AudioMixerGroup> type must
        // resolve to the real AudioMixerGroup type via the short-name fallback. If this regressed,
        // an AudioMixerGroup bind would fail its assignability check even with a valid .mixer.
        [Test]
        public void SetProperty_ObjectReference_AudioMixerGroup_TypeResolves()
        {
            _testGo.AddComponent<ObjectReferenceTestComponent>();
            var locator = LocatorResolver.BuildLocator(_testGo);

            // A bogus asset path makes Load throw NOT_FOUND — but ONLY after the field type
            // resolved. A type-resolution regression would surface as INVALID_PARAMS/other, not
            // the NOT_FOUND we assert here, so this pins the PPtr<AudioMixerGroup> resolution.
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "mixerGroup",
                ["value"] = new JObject
                {
                    ["asset_path"] = "Assets/Temp/NoSuchMixer.mixer",
                    ["sub_asset"] = "Master"
                }
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code,
                "a missing .mixer path must fail as NOT_FOUND (type resolved, asset absent)");
        }

        // D4: UNCONDITIONAL coverage of the named-sub-asset selection path the mixer bind rides
        // (AssetReferenceResolver.Load's typed scan + name match) — the mixer test above can go
        // Inconclusive when headless mixer creation is unavailable, so a regression in
        // named-non-Sprite-sub-asset selection must not be able to hide behind it. This fixture
        // is a plain .asset whose main asset and two same-typed sub-assets share a type, so ONLY
        // the sub_asset name can (and must) select the right object.
        [Test]
        public void SetProperty_ObjectReference_NamedSubAsset_SelectsByNameNotMainAsset()
        {
            var component = _testGo.AddComponent<ObjectReferenceTestComponent>();
            string multiPath = CreateTempMultiSubAsset();
            var locator = LocatorResolver.BuildLocator(_testGo);

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "assetRef",
                ["value"] = new JObject
                {
                    ["asset_path"] = multiPath,
                    ["sub_asset"] = "SubB"
                }
            });

            Assert.IsNotNull(component.assetRef, "named sub-asset must bind");
            Assert.AreEqual("SubB", component.assetRef.name,
                "sub_asset must select the NAMED sub-asset, not the main asset or first typed match");
            Assert.AreNotEqual(AssetDatabase.LoadAssetAtPath<DummyObjectAsset>(multiPath),
                component.assetRef, "the bound object must not be the main asset");
        }

        // Main DummyObjectAsset + two same-typed named sub-assets in one .asset file.
        private string CreateTempMultiSubAsset()
        {
            string dir = "Assets/Temp";
            Directory.CreateDirectory(dir);
            _tempMultiAssetPath = $"{dir}/ComponentHandlerTests-{Guid.NewGuid():N}.asset";

            var main = ScriptableObject.CreateInstance<DummyObjectAsset>();
            main.name = "MainAsset";
            AssetDatabase.CreateAsset(main, _tempMultiAssetPath);

            var subA = ScriptableObject.CreateInstance<DummyObjectAsset>();
            subA.name = "SubA";
            AssetDatabase.AddObjectToAsset(subA, _tempMultiAssetPath);

            var subB = ScriptableObject.CreateInstance<DummyObjectAsset>();
            subB.name = "SubB";
            AssetDatabase.AddObjectToAsset(subB, _tempMultiAssetPath);

            AssetDatabase.SaveAssets();
            AssetDatabase.ImportAsset(_tempMultiAssetPath, ImportAssetOptions.ForceSynchronousImport);
            return _tempMultiAssetPath;
        }

        // Writes a minimal valid 16-bit mono PCM WAV and imports it as an AudioClip.
        private string CreateTempWav()
        {
            string dir = "Assets/Temp";
            Directory.CreateDirectory(dir);
            _tempWavPath = $"{dir}/ComponentHandlerTests-{Guid.NewGuid():N}.wav";

            const int sampleRate = 8000;
            const int sampleCount = 800; // 0.1s
            byte[] wav = BuildPcmWav(sampleRate, sampleCount);
            File.WriteAllBytes(_tempWavPath, wav);
            AssetDatabase.ImportAsset(_tempWavPath, ImportAssetOptions.ForceSynchronousImport);
            return _tempWavPath;
        }

        private static byte[] BuildPcmWav(int sampleRate, int sampleCount)
        {
            using (var stream = new MemoryStream())
            using (var w = new BinaryWriter(stream))
            {
                const short channels = 1;
                const short bitsPerSample = 16;
                int byteRate = sampleRate * channels * (bitsPerSample / 8);
                short blockAlign = (short)(channels * (bitsPerSample / 8));
                int dataBytes = sampleCount * blockAlign;

                w.Write(new[] { 'R', 'I', 'F', 'F' });
                w.Write(36 + dataBytes);
                w.Write(new[] { 'W', 'A', 'V', 'E' });
                w.Write(new[] { 'f', 'm', 't', ' ' });
                w.Write(16);              // fmt chunk size
                w.Write((short)1);        // PCM
                w.Write(channels);
                w.Write(sampleRate);
                w.Write(byteRate);
                w.Write(blockAlign);
                w.Write(bitsPerSample);
                w.Write(new[] { 'd', 'a', 't', 'a' });
                w.Write(dataBytes);
                for (int i = 0; i < sampleCount; i++)
                {
                    // A quiet sine so the clip is non-empty but tiny.
                    double t = (double)i / sampleRate;
                    short s = (short)(Math.Sin(t * 2 * Math.PI * 220) * 4000);
                    w.Write(s);
                }
                w.Flush();
                return stream.ToArray();
            }
        }

        // Creates a .mixer headlessly via the internal AudioMixerController editor API (reflection,
        // so the test compiles without a hard UnityEditor.Audio reference and degrades to
        // Inconclusive if the API is unavailable). Returns the asset path + its master group name,
        // or null when creation is not possible on this Unity version.
        private string TryCreateTempMixer(out string masterGroupName)
        {
            masterGroupName = "Master";
            try
            {
                Type controllerType = null;
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    controllerType = asm.GetType("UnityEditor.Audio.AudioMixerController", false);
                    if (controllerType != null)
                        break;
                }
                if (controllerType == null)
                    return null;

                var method = controllerType.GetMethod(
                    "CreateMixerControllerAtPath",
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic |
                    System.Reflection.BindingFlags.Static,
                    null,
                    new[] { typeof(string) },
                    null);
                if (method == null)
                    return null;

                string dir = "Assets/Temp";
                Directory.CreateDirectory(dir);
                string mixerPath = $"{dir}/ComponentHandlerTests-{Guid.NewGuid():N}.mixer";
                method.Invoke(null, new object[] { mixerPath });
                AssetDatabase.ImportAsset(mixerPath, ImportAssetOptions.ForceSynchronousImport);

                // Confirm a group sub-asset actually exists and capture its name.
                UnityEngine.Object[] all = AssetDatabase.LoadAllAssetsAtPath(mixerPath);
                if (all == null)
                    return null;
                foreach (UnityEngine.Object o in all)
                {
                    if (o is UnityEngine.Audio.AudioMixerGroup group)
                    {
                        masterGroupName = group.name;
                        _tempMixerPath = mixerPath;
                        return mixerPath;
                    }
                }

                AssetDatabase.DeleteAsset(mixerPath);
                return null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ─────────────────────────────────────────────
        // RCL-T08: universal `enabled` + Camera friendly clip-plane names
        // ─────────────────────────────────────────────

        [Test]
        public void SetProperty_Enabled_DisablesRendererNotGameObject()
        {
            MeshRenderer renderer = _testGo.AddComponent<MeshRenderer>();
            Assert.IsTrue(renderer.enabled, "precondition: renderer starts enabled");
            Assert.IsTrue(_testGo.activeSelf, "precondition: GameObject starts active");

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "MeshRenderer",
                ["property_path"] = "enabled",
                ["value"] = false
            });

            Assert.AreEqual("enabled", result.Value<string>("property_path"));
            Assert.IsFalse(renderer.enabled, "`enabled`=false must DISABLE the renderer");
            Assert.IsTrue(_testGo.activeSelf,
                "`enabled` must affect the COMPONENT, never deactivate the GameObject");
        }

        [Test]
        public void SetProperty_Enabled_OnBehaviour_TogglesBehaviour()
        {
            var behaviour = _testGo.AddComponent<ObjectReferenceTestComponent>();
            behaviour.enabled = true;

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "enabled",
                ["value"] = false
            });

            Assert.IsFalse(behaviour.enabled, "`enabled` resolves on an arbitrary Behaviour");
        }

        [Test]
        public void SetProperty_CameraFar_ChangesClipPlaneViaFriendlyName()
        {
            Camera cam = _testGo.AddComponent<Camera>();
            cam.farClipPlane = 1000f;

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Camera",
                ["property_path"] = "far",
                ["value"] = 250f
            });

            // Friendly "far" resolves to the serialized "far clip plane" path.
            Assert.AreEqual("far clip plane", result.Value<string>("property_path"));
            Assert.AreEqual(250f, cam.farClipPlane, 0.01f, "Camera.far must update the far clip plane");
        }

        [Test]
        public void SetProperty_CameraFieldOfView_ResolvesAlias()
        {
            Camera cam = _testGo.AddComponent<Camera>();

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Camera",
                ["property_path"] = "fieldOfView",
                ["value"] = 75f
            });

            Assert.AreEqual(75f, cam.fieldOfView, 0.01f, "Camera.fieldOfView alias must update the FOV");
        }

        // ─────────────────────────────────────────────
        // RCL-T05: "GameObject" pseudo-component in set_property
        // ─────────────────────────────────────────────

        [Test]
        public void SetProperty_GameObjectPseudoComponent_SetsLayer()
        {
            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "GameObject",
                ["property_path"] = "m_Layer",
                ["value"] = 5 // built-in "UI" layer
            });

            Assert.AreEqual("GameObject", result.Value<string>("type_name"));
            Assert.AreEqual(5, _testGo.layer, "GameObject pseudo-component must set m_Layer");
        }

        [Test]
        public void SetProperty_GameObjectPseudoComponent_SetsTagViaFriendlyAlias()
        {
            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "GameObject",
                ["property_path"] = "tag", // friendly alias → m_TagString
                ["value"] = "Player" // built-in tag
            });

            Assert.AreEqual("Player", _testGo.tag, "GameObject 'tag' alias must set m_TagString");
        }

        [Test]
        public void SetProperty_GameObjectPseudoComponent_UnknownProperty_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "GameObject",
                ["property_path"] = "m_NoSuchField",
                ["value"] = 1
            }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ─────────────────────────────────────────────
        // RLH-W1: nested serialized property paths (uGUI Text.fontSize → m_FontData.m_FontSize)
        // ─────────────────────────────────────────────

        [Test]
        public void SetProperty_TextFontSize_ViaFriendlyAlias()
        {
            UnityEngine.UI.Text text = _testGo.AddComponent<UnityEngine.UI.Text>();
            text.fontSize = 14;

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Text",
                ["property_path"] = "fontSize", // friendly alias → nested m_FontData.m_FontSize
                ["value"] = 32
            });

            Assert.AreEqual("m_FontData.m_FontSize", result.Value<string>("property_path"),
                "friendly 'fontSize' must resolve to the nested serialized path");
            Assert.AreEqual(32, text.fontSize, "Text.fontSize must update through the nested path");
        }

        [Test]
        public void SetProperty_TextFontSize_ViaDottedSerializedPath()
        {
            UnityEngine.UI.Text text = _testGo.AddComponent<UnityEngine.UI.Text>();
            text.fontSize = 14;

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Text",
                ["property_path"] = "m_FontData.m_FontSize", // fully-serialized dotted path
                ["value"] = 24
            });

            Assert.AreEqual("m_FontData.m_FontSize", result.Value<string>("property_path"));
            Assert.AreEqual(24, text.fontSize, "fully-serialized dotted path must set Text.fontSize");
        }

        [Test]
        public void SetProperty_TextFontSize_ViaFriendlyDottedPath()
        {
            UnityEngine.UI.Text text = _testGo.AddComponent<UnityEngine.UI.Text>();

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Text",
                ["property_path"] = "fontData.fontSize", // both segments matched by camelCase(displayName)
                ["value"] = 40
            });

            Assert.AreEqual("m_FontData.m_FontSize", result.Value<string>("property_path"),
                "each friendly segment must map to its serialized child name");
            Assert.AreEqual(40, text.fontSize);
        }

        [Test]
        public void SetProperty_TextAlignment_NestedEnumViaAlias()
        {
            UnityEngine.UI.Text text = _testGo.AddComponent<UnityEngine.UI.Text>();

            // Enum set takes the enumValueIndex (int); TextAnchor is contiguous so 4 == MiddleCenter.
            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Text",
                ["property_path"] = "alignment", // → m_FontData.m_Alignment (enum)
                ["value"] = (int)TextAnchor.MiddleCenter
            });

            Assert.AreEqual("m_FontData.m_Alignment", result.Value<string>("property_path"),
                "friendly 'alignment' must resolve to the nested serialized enum path");
            Assert.AreEqual(TextAnchor.MiddleCenter, text.alignment,
                "nested enum must set through the m_FontData alias");
        }

        [Test]
        public void SetProperty_DottedPath_BadSegment_ThrowsWithSegmentAndChildren()
        {
            _testGo.AddComponent<UnityEngine.UI.Text>();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Text",
                ["property_path"] = "m_FontData.m_NoSuchField",
                ["value"] = 1
            }));

            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("m_NoSuchField", ex.Message, "error must name the failing segment");
            StringAssert.Contains("Available children", ex.Message, "error must list the parent's children");
            StringAssert.Contains("m_FontSize", ex.Message,
                "the listed children must be the real siblings under the last-resolved parent");
        }

        // Regression: the single-name (non-dotted) path is untouched by the dotted branch — a
        // plain camelCase friendly name still resolves to its top-level serialized property.
        [Test]
        public void SetProperty_SingleName_StillResolvesTopLevelSerializedProperty()
        {
            var rb = _testGo.AddComponent<Rigidbody2D>();

            JObject result = _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Rigidbody2D",
                ["property_path"] = "gravityScale",
                ["value"] = 3.5f
            });

            Assert.AreEqual(3.5f, rb.gravityScale, 0.001f,
                "single-name resolution must be unchanged by the nested-path feature");
            Assert.IsFalse(result.Value<string>("property_path").Contains("."),
                "a single-name resolve must not produce a dotted path");
        }

        // ─────────────────────────────────────────────
        // E20 / L117: the WRITE-ONLY introspection class closes
        //
        // set_property has long accepted `m_Enabled` and `m_SortingOrder`; get_properties
        // could not read either back, because the SerializedObject iterator NextVisible()
        // walks skips them. An agent could therefore set a value and had no way to confirm
        // it landed: three Canvas scrim-sorting fixes were abandoned as unverifiable for
        // exactly this reason.
        // ─────────────────────────────────────────────

        [Test]
        public void GetProperties_ReadsBackAnEnabledFlagSetThroughSetProperty()
        {
            var behaviour = _testGo.AddComponent<ObjectReferenceTestComponent>();
            behaviour.enabled = true;
            JObject locator = LocatorResolver.BuildLocator(_testGo);

            // Control: the read reports the live TRUE before anything is written.
            JObject before = _handler.HandleOp("get_properties", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["include_paths"] = new JArray { "m_Enabled" }
            });
            JObject beforeProp = FindProperty(before, "m_Enabled");
            Assert.IsNotNull(beforeProp, "m_Enabled must be readable at all (it was omitted entirely)");
            Assert.IsTrue(beforeProp.Value<bool>("currentValue"));

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["property_path"] = "enabled",
                ["value"] = false
            });
            Assert.IsFalse(behaviour.enabled, "precondition: the write really landed on the component");

            JObject after = _handler.HandleOp("get_properties", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "ObjectReferenceTestComponent",
                ["include_paths"] = new JArray { "m_Enabled" }
            });
            JObject afterProp = FindProperty(after, "m_Enabled");
            Assert.IsNotNull(afterProp);
            Assert.IsFalse(afterProp.Value<bool>("currentValue"),
                "the read-back must follow the write, or set_property is unverifiable");
        }

        [Test]
        public void GetProperties_ReadsBackASpriteRendererSortingOrder()
        {
            SpriteRenderer sr = _testGo.AddComponent<SpriteRenderer>();
            JObject locator = LocatorResolver.BuildLocator(_testGo);

            _handler.HandleOp("set_property", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "SpriteRenderer",
                ["property_path"] = "m_SortingOrder",
                ["value"] = 42
            });
            Assert.AreEqual(42, sr.sortingOrder, "precondition: the write really landed");

            JObject result = _handler.HandleOp("get_properties", new JObject
            {
                ["locator"] = locator,
                ["type_name"] = "SpriteRenderer",
                ["include_paths"] = new JArray { "m_SortingOrder" }
            });
            JObject prop = FindProperty(result, "m_SortingOrder");
            Assert.IsNotNull(prop, "the SERIALIZED spelling set_property takes must also be readable");
            Assert.AreEqual(42, prop.Value<int>("currentValue"));
        }

        [Test]
        public void GetProperties_ReadsBackACanvasSortingOrderAndOverrideFlag()
        {
            // Canvas is NOT a Renderer, so the existing Renderer-sorting fallback never
            // covered it: this was the fully unverifiable case.
            //
            // The canvas under test is NESTED under a root canvas, because overrideSorting is
            // only meaningful on a child canvas (Unity ignores the flag on a root one), and a
            // nested scrim canvas over a HUD is the exact shape that went unverifiable live.
            var rootGo = new GameObject("RootCanvasForNesting");
            var canvasGo = new GameObject("CanvasUnderTest");
            try
            {
                rootGo.AddComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
                canvasGo.transform.SetParent(rootGo.transform, false);
                Canvas canvas = canvasGo.AddComponent<Canvas>();
                JObject locator = LocatorResolver.BuildLocator(canvasGo);

                _handler.HandleOp("set_property", new JObject
                {
                    ["locator"] = locator,
                    ["type_name"] = "Canvas",
                    ["property_path"] = "overrideSorting",
                    ["value"] = true
                });
                _handler.HandleOp("set_property", new JObject
                {
                    ["locator"] = locator,
                    ["type_name"] = "Canvas",
                    ["property_path"] = "sortingOrder",
                    ["value"] = 7
                });
                Assert.AreEqual(7, canvas.sortingOrder, "precondition: the write really landed");

                JObject result = _handler.HandleOp("get_properties", new JObject
                {
                    ["locator"] = locator,
                    ["type_name"] = "Canvas"
                });
                JObject order = FindProperty(result, "m_SortingOrder");
                Assert.IsNotNull(order, "Canvas sorting order had NO read path at all before this");
                Assert.AreEqual(7, order.Value<int>("currentValue"));

                JObject over = FindProperty(result, "m_OverrideSorting");
                Assert.IsNotNull(over,
                    "sortingOrder does nothing on a nested Canvas without overrideSorting: reading one without the other answers half the question");
                Assert.AreEqual(canvas.overrideSorting, over.Value<bool>("currentValue"),
                    "the read-back must agree with the live component, never with what the caller asked for");
                Assert.IsTrue(over.Value<bool>("currentValue"),
                    "a nested canvas accepts overrideSorting, so the write landed and the read must show it");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(canvasGo);
                UnityEngine.Object.DestroyImmediate(rootGo);
            }
        }

        [Test]
        public void GetProperties_DoesNotFabricateWellKnownFieldsOnAComponentThatLacksThem()
        {
            // POSITIVE CONTROL for the honest-or-omit half. Transform is not a Behaviour and
            // not a Renderer: it has no m_Enabled and no sorting, and the appender must emit
            // NOTHING rather than inventing a plausible default.
            JObject result = _handler.HandleOp("get_properties", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "Transform"
            });
            Assert.IsNull(FindProperty(result, "m_Enabled"),
                "Transform has no enabled flag; a fabricated one would be worse than an absent one");
            Assert.IsNull(FindProperty(result, "m_SortingOrder"));
        }

        [Test]
        public void GetProperties_WellKnownFieldsRespectTheSearchFilter()
        {
            _testGo.AddComponent<SpriteRenderer>();
            JObject result = _handler.HandleOp("get_properties", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["type_name"] = "SpriteRenderer",
                ["search"] = "sorting"
            });
            Assert.IsNotNull(FindProperty(result, "m_SortingOrder"));
            Assert.IsNull(FindProperty(result, "m_Enabled"),
                "the appended fields must honour search exactly like the iterator's own do");
        }

        /// <summary>The descriptor for a serializedPath in a get_properties response, or null.</summary>
        private static JObject FindProperty(JObject getPropertiesResult, string serializedPath)
        {
            JArray props = getPropertiesResult.Value<JArray>("properties");
            if (props == null)
                return null;
            foreach (JToken token in props)
            {
                JObject o = token as JObject;
                if (o != null && o.Value<string>("serializedPath") == serializedPath)
                    return o;
            }
            return null;
        }

        public class DummyObjectAsset : ScriptableObject
        {
        }

        public class ObjectReferenceTestComponent : MonoBehaviour
        {
            public GameObject targetGameObject;
            public Transform targetTransform;
            public DummyObjectAsset assetRef;
            public DummyObjectAsset[] assetRefs;
            public int[] numbers;
            public AudioClip audioClip;
            public UnityEngine.Audio.AudioMixerGroup mixerGroup;
        }
    }
}
