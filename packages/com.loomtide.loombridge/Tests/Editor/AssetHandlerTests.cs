using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class AssetHandlerTests
    {
        private AssetHandler _handler;
        private const string TestSpritePath = "Assets/TestAssetHandlerSprite.png";
        private const string TestImportedSpritePath = "Assets/TestAssetHandlerImportedSprite.png";
        private const string TestAtlasSpritePath = "Assets/TestAssetHandlerAtlas.png";
        private const string TestMaterialPath = "Assets/TestAssetHandlerMat.mat";
        private const string TestPbrMaterialPath = "Assets/TestAssetHandlerPbrMat.mat";
        private const string TestPrefabPath = "Assets/TestAssetHandlerPrefab.prefab";
        private const string TestPrefabVariantPath = "Assets/TestAssetHandlerPrefabVariant.prefab";
        private const string TestPrefabVariantAliasPath = "Assets/TestAssetHandlerPrefabVariantAlias.prefab";
        private const string TestPackedTexturePath = "Assets/TestAssetHandlerPacked.png";
        private const string TestScenePath = "Assets/TestAssetHandlerScene.unity";
        private const string TestControllerPath = "Assets/TestAssetHandlerController.controller";
        private const string TestMeshPath = "Assets/TestAssetHandlerMesh.asset";
        private const string TestMultiMeshPath = "Assets/TestAssetHandlerMultiMesh.asset";
        private const string TestChildPrefabPath = "Assets/TestAssetHandlerChildPrefab.prefab";
        private const string TestChildVariantPath = "Assets/TestAssetHandlerChildVariant.prefab";
        private const string TestMaskMapPath = "Assets/TestAssetHandlerMaskMap.png";
        private const string TestOcclusionSpritePath = "Assets/TestAssetHandlerOcclusion.png";
        private const string TestUrpMaterialPath = "Assets/TestAssetHandlerUrpMat.mat";
        private const string TestBadShaderMaterialPath = "Assets/TestAssetHandlerBadShaderMat.mat";
        private const string TestWavPath = "Assets/TestAssetHandlerAudio.wav";
        private string _tempExternalImagePath;
        private string _tempInvalidImagePath;

        [SetUp]
        public void SetUp()
        {
            _handler = new AssetHandler();
        }

        [TearDown]
        public void TearDown()
        {
            if (AssetDatabase.LoadAssetAtPath<Object>(TestSpritePath) != null)
                AssetDatabase.DeleteAsset(TestSpritePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestImportedSpritePath) != null)
                AssetDatabase.DeleteAsset(TestImportedSpritePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestAtlasSpritePath) != null)
                AssetDatabase.DeleteAsset(TestAtlasSpritePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestMaterialPath) != null)
                AssetDatabase.DeleteAsset(TestMaterialPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPbrMaterialPath) != null)
                AssetDatabase.DeleteAsset(TestPbrMaterialPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPrefabVariantPath) != null)
                AssetDatabase.DeleteAsset(TestPrefabVariantPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPrefabVariantAliasPath) != null)
                AssetDatabase.DeleteAsset(TestPrefabVariantAliasPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPrefabPath) != null)
                AssetDatabase.DeleteAsset(TestPrefabPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestPackedTexturePath) != null)
                AssetDatabase.DeleteAsset(TestPackedTexturePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestScenePath) != null)
                AssetDatabase.DeleteAsset(TestScenePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestControllerPath) != null)
                AssetDatabase.DeleteAsset(TestControllerPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestMeshPath) != null)
                AssetDatabase.DeleteAsset(TestMeshPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestMultiMeshPath) != null)
                AssetDatabase.DeleteAsset(TestMultiMeshPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestChildVariantPath) != null)
                AssetDatabase.DeleteAsset(TestChildVariantPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestChildPrefabPath) != null)
                AssetDatabase.DeleteAsset(TestChildPrefabPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestMaskMapPath) != null)
                AssetDatabase.DeleteAsset(TestMaskMapPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestOcclusionSpritePath) != null)
                AssetDatabase.DeleteAsset(TestOcclusionSpritePath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestUrpMaterialPath) != null)
                AssetDatabase.DeleteAsset(TestUrpMaterialPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestBadShaderMaterialPath) != null)
                AssetDatabase.DeleteAsset(TestBadShaderMaterialPath);
            if (AssetDatabase.LoadAssetAtPath<Object>(TestWavPath) != null)
                AssetDatabase.DeleteAsset(TestWavPath);
            if (!string.IsNullOrEmpty(_tempExternalImagePath) && File.Exists(_tempExternalImagePath))
                File.Delete(_tempExternalImagePath);
            if (!string.IsNullOrEmpty(_tempInvalidImagePath) && File.Exists(_tempInvalidImagePath))
                File.Delete(_tempInvalidImagePath);
        }

        [Test]
        public void IsAsync_ReturnsFalse()
        {
            Assert.IsFalse(_handler.IsAsync("create_sprite"));
            Assert.IsFalse(_handler.IsAsync("create_material"));
        }

        [Test]
        public void CreateSprite_CreatesFileOnDisk()
        {
            var parameters = new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 16,
                ["height"] = 16,
                ["color"] = new JObject { ["r"] = 1f, ["g"] = 0f, ["b"] = 0f, ["a"] = 1f }
            };

            JObject result = _handler.HandleOp("create_sprite", parameters);

            Assert.AreEqual(TestSpritePath, result.Value<string>("path"));
            Assert.AreEqual(16, result.Value<int>("width"));

            string fullPath = Path.Combine(Application.dataPath, "..", TestSpritePath);
            Assert.IsTrue(File.Exists(fullPath), "PNG file should exist on disk");
        }

        [Test]
        public void CreateSprite_FromSourcePath_ImportsExternalImage()
        {
            _tempExternalImagePath = Path.Combine(Path.GetTempPath(), $"asset-handler-{System.Guid.NewGuid()}.png");
            Texture2D tempTexture = new Texture2D(8, 10, TextureFormat.RGBA32, false);
            var pixels = new Color[80];
            for (int i = 0; i < pixels.Length; i++) pixels[i] = Color.green;
            tempTexture.SetPixels(pixels);
            tempTexture.Apply();
            File.WriteAllBytes(_tempExternalImagePath, tempTexture.EncodeToPNG());
            Object.DestroyImmediate(tempTexture);

            var parameters = new JObject
            {
                ["path"] = TestImportedSpritePath,
                ["source_path"] = _tempExternalImagePath
            };

            JObject result = _handler.HandleOp("create_sprite", parameters);
            Assert.AreEqual(TestImportedSpritePath, result.Value<string>("path"));
            Assert.AreEqual("source_path", result.Value<string>("source"));

            Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(TestImportedSpritePath);
            Assert.IsNotNull(sprite, "Imported external image should produce Sprite asset");
        }

        [Test]
        public void CreateSprite_WithGridSlicing_ImportsNamedSubSpritesAndAssignsByName()
        {
            _tempExternalImagePath = Path.Combine(Path.GetTempPath(), $"asset-handler-atlas-{System.Guid.NewGuid()}.png");
            Texture2D tempTexture = new Texture2D(64, 32, TextureFormat.RGBA32, false);
            for (int y = 0; y < 32; y++)
            {
                for (int x = 0; x < 64; x++)
                {
                    tempTexture.SetPixel(x, y, x < 32 ? Color.red : Color.green);
                }
            }
            tempTexture.Apply();
            File.WriteAllBytes(_tempExternalImagePath, tempTexture.EncodeToPNG());
            Object.DestroyImmediate(tempTexture);

            var createParameters = new JObject
            {
                ["path"] = TestAtlasSpritePath,
                ["source_path"] = _tempExternalImagePath,
                ["sprite_mode"] = "multiple",
                ["pixels_per_unit"] = 100,
                ["slicing"] = new JObject
                {
                    ["mode"] = "grid",
                    ["cell"] = new JObject { ["width"] = 32, ["height"] = 32 },
                    ["sprites"] = new JArray
                    {
                        new JObject { ["name"] = "tile.left", ["column"] = 0, ["row"] = 0 },
                        new JObject { ["name"] = "tile.right", ["column"] = 1, ["row"] = 0 }
                    }
                }
            };

            JObject createResult = _handler.HandleOp("create_sprite", createParameters);
            string[] spriteNames = AssetDatabase.LoadAllAssetsAtPath(TestAtlasSpritePath)
                .OfType<Sprite>()
                .Select(sprite => sprite.name)
                .OrderBy(name => name)
                .ToArray();

            Assert.AreEqual("multiple", createResult.Value<string>("sprite_mode"));
            CollectionAssert.AreEquivalent(new[] { "tile.left", "tile.right" }, spriteNames);

            GameObject target = new GameObject("NamedSpriteTarget");
            try
            {
                SpriteRenderer renderer = target.AddComponent<SpriteRenderer>();
                JObject assignResult = _handler.HandleOp("assign_sprite", new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(target),
                    ["sprite_path"] = TestAtlasSpritePath,
                    ["sprite_name"] = "tile.right"
                });

                Assert.AreEqual("tile.right", assignResult.Value<string>("sprite_name"));
                Assert.AreEqual("tile.right", renderer.sprite.name);
            }
            finally
            {
                Object.DestroyImmediate(target);
            }
        }

        [Test]
        public void CreateSprite_NonPowerOfTwoSheet_KeepsNativeSizeAndSlices()
        {
            // 132x33 is non-power-of-two on both axes. Unity's default npotScale
            // (ToNearest) would rescale it to 128x32, shrinking the texture so the
            // four 33px grid cells (132px wide) fall outside bounds and slicing throws.
            // The handler must set npotScale=None so the native size is preserved.
            _tempExternalImagePath = Path.Combine(Path.GetTempPath(), $"asset-handler-npot-{System.Guid.NewGuid()}.png");
            Texture2D tempTexture = new Texture2D(132, 33, TextureFormat.RGBA32, false);
            tempTexture.SetPixels(Enumerable.Repeat(Color.cyan, 132 * 33).ToArray());
            tempTexture.Apply();
            File.WriteAllBytes(_tempExternalImagePath, tempTexture.EncodeToPNG());
            Object.DestroyImmediate(tempTexture);

            var createParameters = new JObject
            {
                ["path"] = TestAtlasSpritePath,
                ["source_path"] = _tempExternalImagePath,
                ["sprite_mode"] = "multiple",
                ["filter_mode"] = "Point",
                ["slicing"] = new JObject
                {
                    ["mode"] = "grid",
                    ["cell"] = new JObject { ["width"] = 33, ["height"] = 33 },
                    ["sprites"] = new JArray
                    {
                        new JObject { ["name"] = "f0", ["column"] = 0, ["row"] = 0 },
                        new JObject { ["name"] = "f1", ["column"] = 1, ["row"] = 0 },
                        new JObject { ["name"] = "f2", ["column"] = 2, ["row"] = 0 },
                        new JObject { ["name"] = "f3", ["column"] = 3, ["row"] = 0 }
                    }
                }
            };

            JObject createResult = _handler.HandleOp("create_sprite", createParameters);

            // Native size preserved (not rescaled to 128x32).
            Assert.AreEqual(132, createResult.Value<int>("width"));
            Assert.AreEqual(33, createResult.Value<int>("height"));

            string[] spriteNames = AssetDatabase.LoadAllAssetsAtPath(TestAtlasSpritePath)
                .OfType<Sprite>()
                .Select(sprite => sprite.name)
                .OrderBy(name => name)
                .ToArray();
            CollectionAssert.AreEquivalent(new[] { "f0", "f1", "f2", "f3" }, spriteNames);

            var importer = (TextureImporter)AssetImporter.GetAtPath(TestAtlasSpritePath);
            Assert.AreEqual(TextureImporterNPOTScale.None, importer.npotScale);
        }

        [Test]
        public void CreateSprite_InvalidSourceExtension_Throws()
        {
            _tempInvalidImagePath = Path.Combine(Path.GetTempPath(), $"asset-handler-{System.Guid.NewGuid()}.txt");
            File.WriteAllText(_tempInvalidImagePath, "not an image");

            var parameters = new JObject
            {
                ["path"] = TestImportedSpritePath,
                ["source_path"] = _tempInvalidImagePath
            };

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("create_sprite", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("extension", ex.Message);
        }

        [Test]
        public void CreateSprite_PathTraversal_Throws()
        {
            var parameters = new JObject
            {
                ["path"] = "Assets/../../../etc/evil.png",
                ["width"] = 1,
                ["height"] = 1
            };

            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("create_sprite", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void CreateSprite_NonAssetsPath_Throws()
        {
            var parameters = new JObject
            {
                ["path"] = "/tmp/evil.png",
                ["width"] = 1,
                ["height"] = 1
            };

            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("create_sprite", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void CreateMaterial_CreatesAsset()
        {
            var parameters = new JObject
            {
                ["path"] = TestMaterialPath,
                ["shader"] = "Standard"
            };

            JObject result = _handler.HandleOp("create_material", parameters);

            Assert.AreEqual(TestMaterialPath, result.Value<string>("path"));

            Material mat = AssetDatabase.LoadAssetAtPath<Material>(TestMaterialPath);
            Assert.IsNotNull(mat, "Material asset should exist");
        }

        [Test]
        public void SetTextureImportSettings_CanMarkTextureAsNormalMap()
        {
            var createSprite = new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8,
                ["color"] = new JObject { ["r"] = 0.5f, ["g"] = 0.5f, ["b"] = 1f, ["a"] = 1f }
            };
            _handler.HandleOp("create_sprite", createSprite);

            JObject result = _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["texture_type"] = "NormalMap",
                ["sRGB"] = false,
                ["mipmaps"] = true
            });

            var importer = (TextureImporter)AssetImporter.GetAtPath(TestSpritePath);
            Assert.AreEqual("NormalMap", result.Value<string>("texture_type"));
            Assert.AreEqual(TextureImporterType.NormalMap, importer.textureType);
            Assert.IsFalse(importer.sRGBTexture);
            Assert.IsTrue(importer.mipmapEnabled);
        }

        [Test]
        public void SetTextureImportSettings_SpriteTypeWithoutMode_DefaultsToSingle()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8
            });

            // Force Multiple (unsliced) so we can prove the Sprite-type default resets it.
            JObject toMultiple = _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["sprite_mode"] = "multiple"
            });
            Assert.AreEqual("Multiple", toMultiple.Value<string>("sprite_import_mode"));
            Assert.AreEqual(SpriteImportMode.Multiple,
                ((TextureImporter)AssetImporter.GetAtPath(TestSpritePath)).spriteImportMode);

            // Marking it Sprite type WITHOUT a sprite_mode must default back to Single so
            // it yields exactly one usable sprite (an unsliced Multiple texture has none).
            JObject result = _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["texture_type"] = "Sprite"
            });

            Assert.AreEqual("Single", result.Value<string>("sprite_import_mode"));
            var importer = (TextureImporter)AssetImporter.GetAtPath(TestSpritePath);
            Assert.AreEqual(SpriteImportMode.Single, importer.spriteImportMode);
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<Sprite>(TestSpritePath),
                "A Single-mode Sprite texture must expose a usable sprite");
        }

        [Test]
        public void SetTextureImportSettings_ExplicitMultipleMode_IsHonored()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8
            });

            JObject result = _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["texture_type"] = "Sprite",
                ["sprite_mode"] = "multiple"
            });

            Assert.AreEqual("Multiple", result.Value<string>("sprite_import_mode"));
            Assert.AreEqual(SpriteImportMode.Multiple,
                ((TextureImporter)AssetImporter.GetAtPath(TestSpritePath)).spriteImportMode);
        }

        [Test]
        public void SetTextureImportSettings_SpriteTypeOnSlicedSheet_PreservesMultipleMode()
        {
            _tempExternalImagePath = Path.Combine(Path.GetTempPath(), $"asset-handler-sliced-{System.Guid.NewGuid()}.png");
            Texture2D tempTexture = new Texture2D(64, 32, TextureFormat.RGBA32, false);
            tempTexture.Apply();
            File.WriteAllBytes(_tempExternalImagePath, tempTexture.EncodeToPNG());
            Object.DestroyImmediate(tempTexture);

            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestAtlasSpritePath,
                ["source_path"] = _tempExternalImagePath,
                ["sprite_mode"] = "multiple",
                ["slicing"] = new JObject
                {
                    ["mode"] = "grid",
                    ["cell"] = new JObject { ["width"] = 32, ["height"] = 32 },
                    ["sprites"] = new JArray
                    {
                        new JObject { ["name"] = "tile.a", ["column"] = 0, ["row"] = 0 },
                        new JObject { ["name"] = "tile.b", ["column"] = 1, ["row"] = 0 }
                    }
                }
            });

            // Re-passing texture_type:"Sprite" without sprite_mode must NOT wipe the
            // slices of an already-sliced Multiple sheet — the default-to-Single guard
            // is only for the unsliced-Multiple (zero sprites) failure mode.
            JObject result = _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestAtlasSpritePath,
                ["texture_type"] = "Sprite"
            });

            Assert.AreEqual("Multiple", result.Value<string>("sprite_import_mode"));
            string[] spriteNames = AssetDatabase.LoadAllAssetsAtPath(TestAtlasSpritePath)
                .OfType<Sprite>()
                .Select(sprite => sprite.name)
                .OrderBy(name => name)
                .ToArray();
            CollectionAssert.AreEquivalent(new[] { "tile.a", "tile.b" }, spriteNames);
        }

        [Test]
        public void SetTextureImportSettings_UnsupportedSpriteMode_Throws()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8
            });

            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("set_texture_import_settings", new JObject
                {
                    ["path"] = TestSpritePath,
                    ["sprite_mode"] = "atlas"
                }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("sprite_mode", ex.Message);
        }

        [Test]
        public void AssignSprite_MultipleUnslicedTexture_DiagnosesImportMode()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8
            });
            _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["sprite_mode"] = "multiple"
            });

            GameObject target = new GameObject("MultipleUnslicedTarget");
            try
            {
                target.AddComponent<SpriteRenderer>();
                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("assign_sprite", new JObject
                    {
                        ["locator"] = LocatorResolver.BuildLocator(target),
                        ["sprite_path"] = TestSpritePath
                    }));

                Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
                StringAssert.Contains("Multiple", ex.Message);
                StringAssert.Contains("ZERO", ex.Message);
                StringAssert.Contains("sprite_mode", ex.Message);
            }
            finally
            {
                Object.DestroyImmediate(target);
            }
        }

        [Test]
        public void AssignSprite_NonSpriteTexture_DiagnosesTextureType()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8
            });
            _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["texture_type"] = "Default"
            });

            GameObject target = new GameObject("NonSpriteTarget");
            try
            {
                target.AddComponent<SpriteRenderer>();
                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("assign_sprite", new JObject
                    {
                        ["locator"] = LocatorResolver.BuildLocator(target),
                        ["sprite_path"] = TestSpritePath
                    }));

                Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
                StringAssert.Contains("not Sprite", ex.Message);
                StringAssert.Contains("Default", ex.Message);
            }
            finally
            {
                Object.DestroyImmediate(target);
            }
        }

        [Test]
        public void CreateMaterial_AssignsPbrTextureSlotsAndRendererMaterials()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 8,
                ["height"] = 8,
                ["color"] = new JObject { ["r"] = 1f, ["g"] = 0.4f, ["b"] = 0.1f, ["a"] = 1f }
            });

            JObject result = _handler.HandleOp("create_material", new JObject
            {
                ["path"] = TestPbrMaterialPath,
                ["shader"] = "Standard",
                ["base_map"] = TestSpritePath,
                ["emission_map"] = TestSpritePath,
                ["emission_color"] = new JObject { ["r"] = 1f, ["g"] = 0.6f, ["b"] = 0.1f, ["a"] = 1f },
                ["emission_intensity"] = 2f
            });

            Assert.AreEqual(TestPbrMaterialPath, result.Value<string>("path"));
            Assert.AreEqual(TestSpritePath, result.Value<string>("base_map"));
            Assert.AreEqual(TestSpritePath, result.Value<string>("emission_map"));

            Material mat = AssetDatabase.LoadAssetAtPath<Material>(TestPbrMaterialPath);
            Assert.IsNotNull(mat, "Material asset should exist");
            Assert.AreEqual(AssetDatabase.LoadAssetAtPath<Texture>(TestSpritePath), mat.mainTexture);
            Assert.IsTrue(mat.IsKeywordEnabled("_EMISSION"));

            GameObject go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            try
            {
                JObject assign = _handler.HandleOp("set_renderer_materials", new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(go),
                    ["materials"] = new JArray { TestPbrMaterialPath },
                    ["strict_submesh_count"] = true
                });

                Assert.AreEqual(1, assign.Value<int>("count"));
                Assert.AreEqual(mat, go.GetComponent<Renderer>().sharedMaterial);
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void ChannelPack_WritesMetallicAndSmoothnessChannels()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 4,
                ["height"] = 4,
                ["color"] = new JObject { ["r"] = 0.75f, ["g"] = 0.75f, ["b"] = 0.75f, ["a"] = 1f }
            });
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestImportedSpritePath,
                ["width"] = 4,
                ["height"] = 4,
                ["color"] = new JObject { ["r"] = 0.25f, ["g"] = 0.25f, ["b"] = 0.25f, ["a"] = 1f }
            });
            _handler.HandleOp("set_texture_import_settings", new JObject
            {
                ["path"] = TestSpritePath,
                ["readable"] = false
            });

            JObject result = _handler.HandleOp("channel_pack", new JObject
            {
                ["path"] = TestPackedTexturePath,
                ["metallic_path"] = TestSpritePath,
                ["roughness_path"] = TestImportedSpritePath,
                ["mipmaps"] = false
            });

            Assert.AreEqual("R=metallic,A=smoothness", result.Value<string>("layout"));
            Texture2D packed = AssetDatabase.LoadAssetAtPath<Texture2D>(TestPackedTexturePath);
            Assert.IsNotNull(packed);
            Color px = packed.GetPixel(0, 0);
            Assert.That(px.r, Is.EqualTo(0.75f).Within(0.02f));
            Assert.That(px.a, Is.EqualTo(0.75f).Within(0.02f));

            var importer = (TextureImporter)AssetImporter.GetAtPath(TestPackedTexturePath);
            Assert.IsFalse(importer.sRGBTexture);
            Assert.IsFalse(importer.mipmapEnabled);
            var sourceImporter = (TextureImporter)AssetImporter.GetAtPath(TestSpritePath);
            Assert.IsFalse(sourceImporter.isReadable, "channel_pack should restore source texture readability after sampling");
        }

        [Test]
        public void CreatePrefab_SavesGameObjectAsPrefab()
        {
            GameObject go = new GameObject("TestPrefabSource");
            try
            {
                var locator = LocatorResolver.BuildLocator(go);
                var parameters = new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = locator
                };

                JObject result = _handler.HandleOp("create_prefab", parameters);

                Assert.AreEqual(TestPrefabPath, result.Value<string>("path"));

                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(TestPrefabPath);
                Assert.IsNotNull(prefab, "Prefab asset should exist");
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void CreatePrefab_WithConnectSource_ConnectsSceneInstance()
        {
            GameObject go = new GameObject("TestPrefabConnectedSource");
            try
            {
                var locator = LocatorResolver.BuildLocator(go);
                var parameters = new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = locator,
                    ["connect_source"] = true
                };

                JObject result = _handler.HandleOp("create_prefab", parameters);

                Assert.AreEqual(TestPrefabPath, result.Value<string>("path"));
                Assert.IsTrue(result.Value<bool>("connected_source"));
                Assert.AreEqual(PrefabInstanceStatus.Connected, PrefabUtility.GetPrefabInstanceStatus(go));
            }
            finally
            {
                Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void CreatePrefabVariant_CreatesVariantLinkedToBaseWithOverrides()
        {
            _handler.HandleOp("create_material", new JObject
            {
                ["path"] = TestMaterialPath,
                ["shader"] = "Standard",
                ["color"] = new JObject { ["r"] = 0f, ["g"] = 1f, ["b"] = 0f, ["a"] = 1f }
            });

            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseSource.name = "BaseCrate";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                JObject result = _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["base_prefab_path"] = TestPrefabPath,
                    ["path"] = TestPrefabVariantPath,
                    ["overrides"] = new JObject
                    {
                        ["local_scale"] = new JObject { ["x"] = 2f, ["y"] = 3f, ["z"] = 4f },
                        ["renderer_materials"] = new JArray { TestMaterialPath }
                    }
                });

                Assert.AreEqual(TestPrefabVariantPath, result.Value<string>("path"));
                Assert.AreEqual("Variant", result.Value<string>("prefab_asset_type"));

                GameObject variant = AssetDatabase.LoadAssetAtPath<GameObject>(TestPrefabVariantPath);
                Assert.IsNotNull(variant, "Prefab variant asset should exist");
                Assert.AreEqual(PrefabAssetType.Variant, PrefabUtility.GetPrefabAssetType(variant));
                Assert.AreEqual(Path.GetFileNameWithoutExtension(TestPrefabVariantPath), variant.name);
                Assert.That(variant.transform.localScale.x, Is.EqualTo(2f).Within(0.001f));
                Assert.That(variant.transform.localScale.y, Is.EqualTo(3f).Within(0.001f));
                Assert.That(variant.transform.localScale.z, Is.EqualTo(4f).Within(0.001f));

                GameObject source = PrefabUtility.GetCorrespondingObjectFromSource(variant);
                Assert.IsNotNull(source, "Variant should retain a corresponding base prefab source");
                Assert.AreEqual(TestPrefabPath, AssetDatabase.GetAssetPath(source));

                Material material = AssetDatabase.LoadAssetAtPath<Material>(TestMaterialPath);
                Assert.AreEqual(material, variant.GetComponent<Renderer>().sharedMaterial);

                Scene activeScene = SceneManager.GetActiveScene();
                Assert.IsTrue(EditorSceneManager.SaveScene(activeScene, TestScenePath),
                    "Test scene should save so dirty-state regression starts from a clean baseline");
                activeScene = SceneManager.GetActiveScene();
                Assert.IsFalse(activeScene.isDirty, "Saved test scene should be clean before variant creation");

                _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["basePrefabPath"] = TestPrefabPath,
                    ["variantPath"] = TestPrefabVariantAliasPath,
                    ["overrides"] = new JObject
                    {
                        ["local_scale"] = new JObject { ["x"] = 1.5f }
                    }
                });

                Assert.IsFalse(activeScene.isDirty, "Creating a prefab variant should not dirty the active scene");
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void CreatePrefabVariant_WithMissingMaterial_ReturnsNotFound()
        {
            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseSource.name = "BaseCrate";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("create_prefab_variant", new JObject
                    {
                        ["base_prefab_path"] = TestPrefabPath,
                        ["path"] = TestPrefabVariantPath,
                        ["overrides"] = new JObject
                        {
                            ["renderer_materials"] = new JArray { "Assets/MissingPrefabVariantMaterial.mat" }
                        }
                    }));

                Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
                StringAssert.Contains("Material not found", ex.Message);
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void ReplaceWithPrefab_PreservesSiblingIndexAndRequiresExpectedScene()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject parent = new GameObject("ReplacementParent");
            GameObject first = new GameObject("First");
            GameObject source = new GameObject("ReplaceMe");
            GameObject last = new GameObject("Last");
            first.transform.SetParent(parent.transform);
            source.transform.SetParent(parent.transform);
            last.transform.SetParent(parent.transform);
            source.transform.localPosition = new Vector3(1f, 2f, 3f);
            source.transform.localScale = new Vector3(2f, 3f, 4f);

            GameObject prefabSource = new GameObject("ReplacementPrefabSource");
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(prefabSource)
                });
                Assert.IsTrue(EditorSceneManager.SaveScene(scene, TestScenePath));

                var mismatch = Assert.Throws<BridgeException>(() => _handler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(source) },
                    ["expected_scene_path"] = "Assets/NotTheActiveScene.unity"
                }));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, mismatch.Code);
                StringAssert.Contains("Active scene mismatch", mismatch.Message);

                JObject result = _handler.HandleOp("replace_with_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locators"] = new JArray { LocatorResolver.BuildLocator(source) },
                    ["expected_scene_path"] = TestScenePath,
                    ["allow_dirty_scene"] = true
                });

                Assert.AreEqual(1, result.Value<JArray>("replacements").Count);
                Assert.AreEqual("First", parent.transform.GetChild(0).name);
                Assert.AreEqual(Path.GetFileNameWithoutExtension(TestPrefabPath), parent.transform.GetChild(1).name);
                Assert.AreEqual("Last", parent.transform.GetChild(2).name);
                Transform replacement = parent.transform.GetChild(1);
                Assert.That(replacement.localPosition.x, Is.EqualTo(1f).Within(0.001f));
                Assert.That(replacement.localScale.z, Is.EqualTo(4f).Within(0.001f));
                Assert.AreEqual(PrefabInstanceStatus.Connected, PrefabUtility.GetPrefabInstanceStatus(replacement.gameObject));
            }
            finally
            {
                Object.DestroyImmediate(prefabSource);
            }
        }

        [Test]
        public void CreatePrefabVariant_MeshFilterMeshOverride_BindsMesh()
        {
            var mesh = new Mesh { name = "OverrideMesh" };
            AssetDatabase.CreateAsset(mesh, TestMeshPath);

            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseSource.name = "MeshBase";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["base_prefab_path"] = TestPrefabPath,
                    ["path"] = TestPrefabVariantPath,
                    ["overrides"] = new JObject
                    {
                        ["mesh_filter_mesh"] = new JObject { ["asset_path"] = TestMeshPath }
                    }
                });

                GameObject variant = AssetDatabase.LoadAssetAtPath<GameObject>(TestPrefabVariantPath);
                Assert.IsNotNull(variant, "Prefab variant should exist");
                Mesh expected = AssetDatabase.LoadAssetAtPath<Mesh>(TestMeshPath);
                Assert.AreEqual(expected, variant.GetComponent<MeshFilter>().sharedMesh,
                    "Variant MeshFilter should bind the overridden mesh");
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void CreatePrefabVariant_AmbiguousMesh_RefusesUnlessSubAssetGiven()
        {
            var meshA = new Mesh { name = "MeshA" };
            AssetDatabase.CreateAsset(meshA, TestMultiMeshPath);
            var meshB = new Mesh { name = "MeshB" };
            AssetDatabase.AddObjectToAsset(meshB, TestMultiMeshPath);
            AssetDatabase.ImportAsset(TestMultiMeshPath);

            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseSource.name = "MeshBase";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("create_prefab_variant", new JObject
                    {
                        ["base_prefab_path"] = TestPrefabPath,
                        ["path"] = TestPrefabVariantPath,
                        ["overrides"] = new JObject
                        {
                            ["mesh_filter_mesh"] = new JObject { ["asset_path"] = TestMultiMeshPath }
                        }
                    }));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
                // Shared AssetReferenceResolver wording: lists the Mesh-assignable
                // candidates and asks for 'sub_asset'.
                StringAssert.Contains("Ambiguous reference", ex.Message);
                StringAssert.Contains("MeshB", ex.Message);
                StringAssert.Contains("sub_asset", ex.Message);

                _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["base_prefab_path"] = TestPrefabPath,
                    ["path"] = TestPrefabVariantPath,
                    ["overrides"] = new JObject
                    {
                        ["mesh_filter_mesh"] = new JObject
                        {
                            ["asset_path"] = TestMultiMeshPath,
                            ["sub_asset"] = "MeshB"
                        }
                    }
                });

                GameObject variant = AssetDatabase.LoadAssetAtPath<GameObject>(TestPrefabVariantPath);
                Assert.AreEqual("MeshB", variant.GetComponent<MeshFilter>().sharedMesh.name,
                    "sub_asset should disambiguate the named mesh");
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void CreatePrefabVariant_ChildPathOverride_TargetsChildAndRefusesUnknownPath()
        {
            _handler.HandleOp("create_material", new JObject
            {
                ["path"] = TestMaterialPath,
                ["shader"] = "Standard",
                ["color"] = new JObject { ["r"] = 0f, ["g"] = 1f, ["b"] = 0f, ["a"] = 1f }
            });

            GameObject root = new GameObject("ChildVariantRoot");
            GameObject child = GameObject.CreatePrimitive(PrimitiveType.Cube);
            child.name = "Barrel";
            child.transform.SetParent(root.transform);
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestChildPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(root)
                });

                _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["base_prefab_path"] = TestChildPrefabPath,
                    ["path"] = TestChildVariantPath,
                    ["overrides"] = new JObject
                    {
                        ["overrides_by_path"] = new JObject
                        {
                            ["Barrel"] = new JObject
                            {
                                ["renderer_materials"] = new JArray { TestMaterialPath }
                            }
                        }
                    }
                });

                GameObject variant = AssetDatabase.LoadAssetAtPath<GameObject>(TestChildVariantPath);
                Assert.IsNotNull(variant, "Child-targeted variant should exist");
                Transform barrel = variant.transform.Find("Barrel");
                Assert.IsNotNull(barrel, "Variant should retain the 'Barrel' child");
                Material material = AssetDatabase.LoadAssetAtPath<Material>(TestMaterialPath);
                Assert.AreEqual(material, barrel.GetComponent<Renderer>().sharedMaterial,
                    "overrides_by_path should assign the material to the addressed child");

                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("create_prefab_variant", new JObject
                    {
                        ["base_prefab_path"] = TestChildPrefabPath,
                        ["path"] = TestChildVariantPath,
                        ["overrides"] = new JObject
                        {
                            ["overrides_by_path"] = new JObject
                            {
                                ["DoesNotExist"] = new JObject
                                {
                                    ["renderer_materials"] = new JArray { TestMaterialPath }
                                }
                            }
                        }
                    }));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
                StringAssert.Contains("DoesNotExist", ex.Message);
                StringAssert.Contains("Barrel", ex.Message);
            }
            finally
            {
                Object.DestroyImmediate(root);
            }
        }

        [Test]
        public void CreatePrefabVariant_ColliderSizeOnBox_AppliesSizeAndCenter()
        {
            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseSource.name = "BoxColliderBase";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                _handler.HandleOp("create_prefab_variant", new JObject
                {
                    ["base_prefab_path"] = TestPrefabPath,
                    ["path"] = TestPrefabVariantPath,
                    ["overrides"] = new JObject
                    {
                        ["collider_size"] = new JObject
                        {
                            ["size"] = new JObject { ["x"] = 2f, ["y"] = 3f, ["z"] = 4f },
                            ["center"] = new JObject { ["y"] = 1f }
                        }
                    }
                });

                GameObject variant = AssetDatabase.LoadAssetAtPath<GameObject>(TestPrefabVariantPath);
                BoxCollider box = variant.GetComponent<BoxCollider>();
                Assert.IsNotNull(box, "Cube variant should have a BoxCollider");
                Assert.That(box.size.x, Is.EqualTo(2f).Within(0.001f));
                Assert.That(box.size.z, Is.EqualTo(4f).Within(0.001f));
                Assert.That(box.center.y, Is.EqualTo(1f).Within(0.001f));
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void CreatePrefabVariant_ColliderSizeOnWrongType_Refuses()
        {
            GameObject baseSource = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            baseSource.name = "SphereColliderBase";
            try
            {
                _handler.HandleOp("create_prefab", new JObject
                {
                    ["path"] = TestPrefabPath,
                    ["locator"] = LocatorResolver.BuildLocator(baseSource)
                });

                BridgeException ex = Assert.Throws<BridgeException>(() =>
                    _handler.HandleOp("create_prefab_variant", new JObject
                    {
                        ["base_prefab_path"] = TestPrefabPath,
                        ["path"] = TestPrefabVariantPath,
                        ["overrides"] = new JObject
                        {
                            ["collider_size"] = new JObject
                            {
                                ["size"] = new JObject { ["x"] = 2f, ["y"] = 2f, ["z"] = 2f }
                            }
                        }
                    }));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
                StringAssert.Contains("SphereCollider", ex.Message);
            }
            finally
            {
                Object.DestroyImmediate(baseSource);
            }
        }

        [Test]
        public void CreateMaterial_TransparentAdditive_SetsUrpBlendQueueAndKeywords()
        {
            Shader urp = Shader.Find("Universal Render Pipeline/Lit");
            if (urp == null)
                Assert.Ignore("URP (Universal Render Pipeline/Lit) is not installed in this project; "
                    + "skipping URP surface-option assertions.");

            _handler.HandleOp("create_material", new JObject
            {
                ["path"] = TestUrpMaterialPath,
                ["shader"] = "Universal Render Pipeline/Lit",
                ["surface"] = "transparent",
                ["blend"] = "additive"
            });

            Material mat = AssetDatabase.LoadAssetAtPath<Material>(TestUrpMaterialPath);
            Assert.IsNotNull(mat);
            Assert.That(mat.GetFloat("_Surface"), Is.EqualTo(1f).Within(0.001f), "_Surface should be Transparent(1)");
            Assert.That(mat.GetFloat("_ZWrite"), Is.EqualTo(0f).Within(0.001f), "Transparent disables ZWrite");
            Assert.AreEqual((int)UnityEngine.Rendering.RenderQueue.Transparent, mat.renderQueue,
                "Transparent surface uses the Transparent render queue (3000)");
            Assert.That(mat.GetFloat("_SrcBlend"), Is.EqualTo((float)UnityEngine.Rendering.BlendMode.One).Within(0.001f),
                "Additive SrcBlend should be One");
            Assert.That(mat.GetFloat("_DstBlend"), Is.EqualTo((float)UnityEngine.Rendering.BlendMode.One).Within(0.001f),
                "Additive DstBlend should be One");
            Assert.IsTrue(mat.IsKeywordEnabled("_SURFACE_TYPE_TRANSPARENT"),
                "Transparent surface enables _SURFACE_TYPE_TRANSPARENT");
        }

        [Test]
        public void CreateMaterial_DecalFlags_DisableSpecularAndEnvironmentReflections()
        {
            Shader urp = Shader.Find("Universal Render Pipeline/Lit");
            if (urp == null)
                Assert.Ignore("URP (Universal Render Pipeline/Lit) is not installed in this project; "
                    + "skipping URP decal-flag assertions.");

            _handler.HandleOp("create_material", new JObject
            {
                ["path"] = TestUrpMaterialPath,
                ["shader"] = "Universal Render Pipeline/Lit",
                ["specular_highlights"] = false,
                ["environment_reflections"] = false,
                ["render_queue"] = 3100
            });

            Material mat = AssetDatabase.LoadAssetAtPath<Material>(TestUrpMaterialPath);
            Assert.IsNotNull(mat);
            Assert.That(mat.GetFloat("_SpecularHighlights"), Is.EqualTo(0f).Within(0.001f));
            Assert.IsTrue(mat.IsKeywordEnabled("_SPECULARHIGHLIGHTS_OFF"));
            Assert.That(mat.GetFloat("_EnvironmentReflections"), Is.EqualTo(0f).Within(0.001f));
            Assert.IsTrue(mat.IsKeywordEnabled("_ENVIRONMENTREFLECTIONS_OFF"));
            Assert.AreEqual(3100, mat.renderQueue, "Explicit render_queue should win");
        }

        [Test]
        public void CreateMaterial_SurfaceOnIncompatibleShader_Refuses()
        {
            // Unlit/Color is a built-in (non-URP) shader with no _Surface property, so it is
            // always available regardless of whether URP is installed. Refuse-not-skip: the
            // handler must refuse naming the shader, not silently set nothing.
            BridgeException ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("create_material", new JObject
                {
                    ["path"] = TestBadShaderMaterialPath,
                    ["shader"] = "Unlit/Color",
                    ["surface"] = "transparent"
                }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("Unlit/Color", ex.Message);
            StringAssert.Contains("_Surface", ex.Message);
            Assert.IsNull(AssetDatabase.LoadAssetAtPath<Material>(TestBadShaderMaterialPath),
                "A refused surface option should not leave a material asset behind");
        }

        [Test]
        public void ChannelPack_MaskMapPreset_WritesMetallicOcclusionAndSmoothness()
        {
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestSpritePath,
                ["width"] = 4,
                ["height"] = 4,
                ["color"] = new JObject { ["r"] = 0.8f, ["g"] = 0.8f, ["b"] = 0.8f, ["a"] = 1f }
            });
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestOcclusionSpritePath,
                ["width"] = 4,
                ["height"] = 4,
                ["color"] = new JObject { ["r"] = 0.5f, ["g"] = 0.5f, ["b"] = 0.5f, ["a"] = 1f }
            });
            _handler.HandleOp("create_sprite", new JObject
            {
                ["path"] = TestImportedSpritePath,
                ["width"] = 4,
                ["height"] = 4,
                ["color"] = new JObject { ["r"] = 0.25f, ["g"] = 0.25f, ["b"] = 0.25f, ["a"] = 1f }
            });

            JObject result = _handler.HandleOp("channel_pack", new JObject
            {
                ["path"] = TestMaskMapPath,
                ["preset"] = "mask_map",
                ["metallic_path"] = TestSpritePath,
                ["occlusion_path"] = TestOcclusionSpritePath,
                ["roughness_path"] = TestImportedSpritePath,
                ["mipmaps"] = false
            });

            Assert.AreEqual("mask_map", result.Value<string>("preset"));
            Assert.AreEqual("R=metallic,G=occlusion,B=detail,A=smoothness", result.Value<string>("layout"));

            Texture2D packed = AssetDatabase.LoadAssetAtPath<Texture2D>(TestMaskMapPath);
            Assert.IsNotNull(packed);
            Color px = packed.GetPixel(0, 0);
            Assert.That(px.r, Is.EqualTo(0.8f).Within(0.02f), "R = metallic");
            Assert.That(px.g, Is.EqualTo(0.5f).Within(0.02f), "G = occlusion");
            Assert.That(px.b, Is.EqualTo(0f).Within(0.02f), "B = detail (default 0)");
            Assert.That(px.a, Is.EqualTo(0.75f).Within(0.02f), "A = smoothness (1 - roughness)");
        }

        [Test]
        public void UnknownOp_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("nonexistent", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ─────────────────────────────────────────────
        // list_sub_assets / model importer introspection
        //
        // A real .fbx fixture is not available in the test project, so the
        // model-importer paths (inspect/configure applied to a ModelImporter)
        // are covered by live smoke, not EditMode. What IS testable offline:
        //  - list_sub_assets over a native multi-sub-asset asset (an
        //    AnimatorController with an added AnimationClip sub-asset)
        //  - the not-imported / no-such-asset error path
        //  - inspect/configure refusal on a NON-model asset
        // ─────────────────────────────────────────────

        // Creates an AnimatorController (main asset + AnimatorStateMachine sub-asset)
        // and adds an AnimationClip as a hidden sub-asset, so LoadAllAssetsAtPath
        // returns several objects of differing types — a native stand-in for the
        // FBX (mesh + avatar + clips) multi-sub-asset shape.
        private void CreateMultiSubAssetController()
        {
            var controller = AnimatorController.CreateAnimatorControllerAtPath(TestControllerPath);
            controller.AddMotion(new AnimationClip { name = "InlineMotion" });
            var extraClip = new AnimationClip { name = "SubAssetClip" };
            AssetDatabase.AddObjectToAsset(extraClip, TestControllerPath);
            AssetDatabase.ImportAsset(TestControllerPath, ImportAssetOptions.ForceSynchronousImport);
        }

        [Test]
        public void ListSubAssets_ReturnsMainAndSubAssetsWithFileIds()
        {
            CreateMultiSubAssetController();

            JObject result = _handler.HandleOp("list_sub_assets",
                new JObject { ["asset_path"] = TestControllerPath });

            Assert.AreEqual(TestControllerPath, result.Value<string>("asset_path"));
            var subAssets = result.Value<JArray>("sub_assets");
            Assert.IsNotNull(subAssets);
            Assert.Greater(subAssets.Count, 1, "controller should expose a main asset plus sub-assets");
            Assert.AreEqual(subAssets.Count, result.Value<int>("count"));

            // Exactly one main asset (the AnimatorController).
            int mainCount = subAssets.Count(t => t.Value<bool>("isMainAsset"));
            Assert.AreEqual(1, mainCount, "exactly one sub-asset should be the main asset");
            JToken main = subAssets.First(t => t.Value<bool>("isMainAsset"));
            Assert.AreEqual("AnimatorController", main.Value<string>("type"));

            // Every entry reports a resolvable fileID + guid; the guid is the asset's.
            string expectedGuid = AssetDatabase.AssetPathToGUID(TestControllerPath);
            foreach (JToken entry in subAssets)
            {
                Assert.IsNotNull(entry.Value<string>("name"));
                Assert.IsNotNull(entry.Value<string>("type"));
                // NB: entry["fileID"] is non-null even for a JSON null token, so
                // assert on the token TYPE — a null fileID/guid means
                // TryGetGUIDAndLocalFileIdentifier failed for the object.
                Assert.AreNotEqual(JTokenType.Null, entry["fileID"].Type,
                    "each sub-asset should carry a non-null fileID");
                Assert.AreNotEqual(JTokenType.Null, entry["guid"].Type,
                    "each sub-asset should carry a non-null guid");
                Assert.AreEqual(expectedGuid, entry.Value<string>("guid"),
                    "all sub-assets share the containing asset's guid");
            }

            // The AnimationClip sub-asset carries the per-type extras.
            JToken clipEntry = subAssets.FirstOrDefault(t => t.Value<string>("type") == "AnimationClip");
            Assert.IsNotNull(clipEntry, "AnimationClip sub-asset should be listed");
            Assert.AreEqual(JTokenType.Float, clipEntry["length"].Type,
                "AnimationClip entry should include a numeric length");
            Assert.AreEqual(JTokenType.Boolean, clipEntry["isLooping"].Type,
                "AnimationClip entry should include a boolean isLooping");
        }

        [Test]
        public void ListSubAssets_NoSuchAsset_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("list_sub_assets",
                new JObject { ["asset_path"] = "Assets/DoesNotExist_AssetHandlerTest.fbx" }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
            StringAssert.Contains("No such asset", ex.Message);
        }

        [Test]
        public void ListSubAssets_MissingAssetPath_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("list_sub_assets", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void ListSubAssets_PathOutsideAssets_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("list_sub_assets",
                new JObject { ["asset_path"] = "../outside.fbx" }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void InspectModelImporter_OnNonModel_RefusesWithInvalidType()
        {
            CreateMultiSubAssetController();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("inspect_model_importer",
                new JObject { ["asset_path"] = TestControllerPath }));
            Assert.AreEqual(ErrorCodes.INVALID_TYPE, ex.Code);
            StringAssert.Contains("not a model", ex.Message);
        }

        [Test]
        public void ConfigureModelImporter_OnNonModel_RefusesWithInvalidType()
        {
            CreateMultiSubAssetController();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("configure_model_importer",
                new JObject
                {
                    ["asset_path"] = TestControllerPath,
                    ["animation_type"] = "Human"
                }));
            Assert.AreEqual(ErrorCodes.INVALID_TYPE, ex.Code);
        }

        [Test]
        public void InspectModelImporter_NoSuchAsset_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("inspect_model_importer",
                new JObject { ["asset_path"] = "Assets/DoesNotExist_AssetHandlerTest.fbx" }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void ListSubAssets_OnFolder_SaysFolderNotFileNotFound()
        {
            const string folderPath = "Assets/TestAssetHandlerFolder";
            AssetDatabase.CreateFolder("Assets", "TestAssetHandlerFolder");
            try
            {
                var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("list_sub_assets",
                    new JObject { ["asset_path"] = folderPath }));
                Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
                StringAssert.Contains("folder", ex.Message);
            }
            finally
            {
                AssetDatabase.DeleteAsset(folderPath);
            }
        }

        [Test]
        public void ValidateClipNameUniqueness_RefusesCollision_NamingTheDuplicates()
        {
            // ModelImporterClipAnimation is constructible without a model asset, so
            // the clip-rename collision refusal is testable offline even though the
            // full configure_model_importer path needs a real FBX (live smoke).
            var clips = new[]
            {
                new ModelImporterClipAnimation { name = "Walk", takeName = "Take 001" },
                new ModelImporterClipAnimation { name = "Walk", takeName = "Take 002" },
                new ModelImporterClipAnimation { name = "Idle", takeName = "Take 003" }
            };

            var ex = Assert.Throws<BridgeException>(
                () => AssetHandler.ValidateClipNameUniqueness(clips));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("'Walk'", ex.Message);
            StringAssert.DoesNotContain("'Idle'", ex.Message);
        }

        [Test]
        public void ValidateClipNameUniqueness_AllowsUniqueNames()
        {
            var clips = new[]
            {
                new ModelImporterClipAnimation { name = "Walk", takeName = "Take 001" },
                new ModelImporterClipAnimation { name = "Idle", takeName = "Take 002" }
            };

            Assert.DoesNotThrow(() => AssetHandler.ValidateClipNameUniqueness(clips));
        }

        // ─────────────────────────────────────────────
        // inspect_audio_importer / configure_audio_importer
        //
        // Unlike the model-importer path (no .fbx fixture available offline), a
        // valid PCM .wav can be generated in-test and imported as a real
        // AudioClip, so the audio importer round-trip IS covered in EditMode.
        // ─────────────────────────────────────────────

        // Writes a minimal valid 16-bit mono PCM WAV at TestWavPath and imports it
        // as an AudioClip. Mirrors the ComponentHandlerTests BuildPcmWav helper.
        private void CreateTestWav()
        {
            const int sampleRate = 22050;
            const int sampleCount = 4410; // 0.2s
            const short channels = 1;
            const short bitsPerSample = 16;

            int byteRate = sampleRate * channels * (bitsPerSample / 8);
            short blockAlign = (short)(channels * (bitsPerSample / 8));
            int dataBytes = sampleCount * blockAlign;

            using (var stream = new MemoryStream())
            using (var w = new BinaryWriter(stream))
            {
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
                    double t = (double)i / sampleRate;
                    short s = (short)(System.Math.Sin(t * 2 * System.Math.PI * 220) * 4000);
                    w.Write(s);
                }
                w.Flush();
                File.WriteAllBytes(Path.Combine(Application.dataPath, "..", TestWavPath), stream.ToArray());
            }

            AssetDatabase.ImportAsset(TestWavPath, ImportAssetOptions.ForceSynchronousImport);
        }

        [Test]
        public void InspectAudioImporter_OnNonAudio_RefusesWithInvalidType()
        {
            CreateMultiSubAssetController();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("inspect_audio_importer",
                new JObject { ["asset_path"] = TestControllerPath }));
            Assert.AreEqual(ErrorCodes.INVALID_TYPE, ex.Code);
            StringAssert.Contains("not an audio clip", ex.Message);
        }

        [Test]
        public void ConfigureAudioImporter_OnNonAudio_RefusesWithInvalidType()
        {
            CreateMultiSubAssetController();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestControllerPath,
                    ["force_to_mono"] = true
                }));
            Assert.AreEqual(ErrorCodes.INVALID_TYPE, ex.Code);
        }

        [Test]
        public void InspectAudioImporter_NoSuchAsset_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("inspect_audio_importer",
                new JObject { ["asset_path"] = "Assets/DoesNotExist_AssetHandlerTest.wav" }));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void InspectAudioImporter_MissingAssetPath_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("inspect_audio_importer", new JObject()));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void InspectAudioImporter_ReturnsImportStateAndClipFacts()
        {
            CreateTestWav();

            JObject result = _handler.HandleOp("inspect_audio_importer",
                new JObject { ["asset_path"] = TestWavPath });

            Assert.AreEqual(TestWavPath, result.Value<string>("asset_path"));
            Assert.AreEqual(JTokenType.Boolean, result["force_to_mono"].Type);
            Assert.AreEqual(JTokenType.Boolean, result["load_in_background"].Type);
            Assert.AreEqual(JTokenType.Boolean, result["ambisonic"].Type);

            var settings = result.Value<JObject>("default_sample_settings");
            Assert.IsNotNull(settings, "inspect must return default_sample_settings");
            Assert.IsNotNull(settings.Value<string>("load_type"));
            Assert.IsNotNull(settings.Value<string>("compression_format"));
            Assert.AreEqual(JTokenType.Float, settings["quality"].Type);
            Assert.IsNotNull(settings.Value<string>("sample_rate_setting"));
            Assert.AreNotEqual(JTokenType.Null, settings["sample_rate_override"].Type);
            Assert.AreEqual(JTokenType.Boolean, settings["preload_audio_data"].Type);
            // conversionMode: public int32 struct field on 6000.3 (undocumented,
            // no public enum type) — inspect must dump it so the payload is a
            // complete settings snapshot.
            Assert.AreEqual(JTokenType.Integer, settings["conversion_mode"].Type,
                "inspect must include the raw conversion_mode int");

            // The imported AudioClip main asset carries the resolved clip facts.
            var clip = result.Value<JObject>("clip");
            Assert.IsNotNull(clip, "a loadable AudioClip should populate clip facts");
            Assert.AreEqual(1, clip.Value<int>("channels"), "the fixture is mono");
            Assert.AreEqual(22050, clip.Value<int>("frequency"), "the fixture sample rate");
            Assert.Greater(clip.Value<int>("samples"), 0);
            Assert.Greater(clip.Value<float>("length"), 0f);
        }

        [Test]
        public void ConfigureAudioImporter_RoundtripsSettings()
        {
            CreateTestWav();

            // conversionMode semantics are undocumented, so the roundtrip re-writes
            // the CURRENT value (a known-safe int) rather than probing arbitrary ones.
            int currentConversionMode = _handler.HandleOp("inspect_audio_importer",
                    new JObject { ["asset_path"] = TestWavPath })
                .Value<JObject>("default_sample_settings")
                .Value<int>("conversion_mode");

            JObject result = _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestWavPath,
                    ["force_to_mono"] = true,
                    ["load_in_background"] = true,
                    ["preload_audio_data"] = false,
                    ["load_type"] = "Streaming",
                    ["compression_format"] = "Vorbis",
                    ["quality"] = 0.35f,
                    ["sample_rate_setting"] = "OverrideSampleRate",
                    ["sample_rate_override"] = 22050,
                    ["conversion_mode"] = currentConversionMode
                });

            Assert.IsTrue(result.Value<bool>("force_to_mono"));
            Assert.IsTrue(result.Value<bool>("load_in_background"));

            var settings = result.Value<JObject>("default_sample_settings");
            Assert.AreEqual("Streaming", settings.Value<string>("load_type"));
            Assert.AreEqual("Vorbis", settings.Value<string>("compression_format"));
            Assert.AreEqual("OverrideSampleRate", settings.Value<string>("sample_rate_setting"));
            Assert.AreEqual(22050, settings.Value<long>("sample_rate_override"));
            Assert.IsFalse(settings.Value<bool>("preload_audio_data"));
            Assert.AreEqual(0.35f, settings.Value<float>("quality"), 0.05f);
            Assert.AreEqual(currentConversionMode, settings.Value<int>("conversion_mode"),
                "conversion_mode int must round-trip through configure");

            // Re-inspecting reads the persisted (reimported) state — the write stuck.
            JObject reinspect = _handler.HandleOp("inspect_audio_importer",
                new JObject { ["asset_path"] = TestWavPath });
            Assert.IsTrue(reinspect.Value<bool>("force_to_mono"));
            Assert.AreEqual("Streaming",
                reinspect.Value<JObject>("default_sample_settings").Value<string>("load_type"));
        }

        [Test]
        public void ConfigureAudioImporter_AcceptsRawEnumInt()
        {
            CreateTestWav();

            // AudioClipLoadType.Streaming == 2; AudioCompressionFormat.PCM == 0.
            JObject result = _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestWavPath,
                    ["load_type"] = 2,
                    ["compression_format"] = 0
                });

            var settings = result.Value<JObject>("default_sample_settings");
            Assert.AreEqual("Streaming", settings.Value<string>("load_type"));
            Assert.AreEqual("PCM", settings.Value<string>("compression_format"));
        }

        [Test]
        public void ConfigureAudioImporter_InvalidLoadType_RefusesListingValidValues()
        {
            CreateTestWav();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestWavPath,
                    ["load_type"] = "NotARealLoadType"
                }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("load_type", ex.Message);
            StringAssert.Contains("Streaming", ex.Message);
            StringAssert.Contains("DecompressOnLoad", ex.Message);
        }

        [Test]
        public void ConfigureAudioImporter_InvalidQuality_Refuses()
        {
            CreateTestWav();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestWavPath,
                    ["quality"] = 1.5f
                }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("quality", ex.Message);
        }

        [Test]
        public void ConfigureAudioImporter_NegativeSampleRateOverride_Refuses()
        {
            CreateTestWav();

            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("configure_audio_importer",
                new JObject
                {
                    ["asset_path"] = TestWavPath,
                    ["sample_rate_override"] = -1
                }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("sample_rate_override", ex.Message);
        }
    }
}
