using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityBridge.UI;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.U2D.Sprites;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles asset operations: sprite/material/prefab creation,
    /// prefab instantiation, and sprite assignment.
    /// </summary>
    public class AssetHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "create_sprite":
                    return HandleCreateSprite(parameters);
                case "create_material":
                    return HandleCreateMaterial(parameters);
                case "create_prefab":
                    return HandleCreatePrefab(parameters);
                case "create_prefab_variant":
                    return HandleCreatePrefabVariant(parameters);
                case "replace_with_prefab":
                    return HandleReplaceWithPrefab(parameters);
                case "instantiate_prefab":
                    return HandleInstantiatePrefab(parameters);
                case "set_texture_import_settings":
                    return HandleSetTextureImportSettings(parameters);
                case "channel_pack":
                    return HandleChannelPack(parameters);
                case "set_renderer_materials":
                    return HandleSetRendererMaterials(parameters);
                case "list_sub_assets":
                    return HandleListSubAssets(parameters);
                case "inspect_model_importer":
                    return HandleInspectModelImporter(parameters);
                case "configure_model_importer":
                    return HandleConfigureModelImporter(parameters);
                case "inspect_audio_importer":
                    return HandleInspectAudioImporter(parameters);
                case "configure_audio_importer":
                    return HandleConfigureAudioImporter(parameters);
                case "assign_sprite":
                    return HandleAssignSprite(parameters);
                case "picker_open":
                    return HandlePickerOpen(parameters);
                case "picker_state":
                    return HandlePickerState(parameters);
                case "picker_close":
                    return HandlePickerClose(parameters);
                case "browser_open":
                    return HandleBrowserOpen(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown asset op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in AssetHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Asset op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleCreateSprite(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            ValidateAssetPath(path);
            ValidateSpriteFileExtension(path);

            string sourcePath = parameters.Value<string>("source_path");
            string sourceUrl = parameters.Value<string>("source_url");
            if (!string.IsNullOrEmpty(sourcePath) && !string.IsNullOrEmpty(sourceUrl))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide only one external source: either 'source_path' or 'source_url'");
            }

            int width = parameters.Value<int?>("width") ?? 32;
            int height = parameters.Value<int?>("height") ?? 32;

            byte[] imageBytes = TryLoadExternalImageBytes(sourcePath, sourceUrl);
            if (imageBytes == null)
            {
                // Parse color (default white)
                Color fillColor = Color.white;
                JObject colorObj = parameters.Value<JObject>("color");
                if (colorObj != null)
                    fillColor = ColorParsing.ParseColor(colorObj);

                // Create a texture and fill with color
                Texture2D tex = new Texture2D(width, height, TextureFormat.RGBA32, false);
                Color[] pixels = new Color[width * height];
                for (int i = 0; i < pixels.Length; i++)
                    pixels[i] = fillColor;
                tex.SetPixels(pixels);
                tex.Apply();

                imageBytes = tex.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(tex);
            }

            string fullPath = GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!Directory.Exists(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllBytes(fullPath, imageBytes);

            string spriteMode = parameters.Value<string>("sprite_mode") ?? "single";
            if (spriteMode != "single" && spriteMode != "multiple")
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unsupported sprite_mode '{spriteMode}'. Use 'single' or 'multiple'.");

            // Import, then configure as a Sprite. Dimensions are read AFTER the sprite
            // settings are applied and reimported — not from the first default import —
            // because npotScale governs the imported texture's size (see below).
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            TextureImporter importer = AssetImporter.GetAtPath(path) as TextureImporter;
            JArray importedSprites = null;
            int finalWidth = width;
            int finalHeight = height;

            if (importer != null)
            {
                importer.textureType = TextureImporterType.Sprite;
                // Sprite sheets / pixel art must keep their native dimensions. Unity's
                // default npotScale (ToNearest) rescales a non-power-of-two texture to
                // the closest POT, which shifts every pixel coordinate so grid slices
                // fall outside bounds (e.g. a 304px saw sheet rescaled to 256, or a
                // 640px flag sheet). None preserves the source resolution so the slice
                // rects computed against finalWidth/finalHeight line up exactly.
                importer.npotScale = TextureImporterNPOTScale.None;
                importer.mipmapEnabled = false; // crisp sprites; mipmaps blur pixel art
                // CPU-readable (Read/Write enabled) so downstream introspection can read
                // the raw pixels — scene.get_bounds computes alpha-trimmed visibleBounds
                // by sampling the texture, which silently falls back to full-rect bounds
                // when the texture isn't readable (the "texture not CPU-readable" gap that
                // made grounded-item alignment unverifiable). Default on; pass
                // readable:false to opt out for large textures where the memory cost
                // matters and visible bounds aren't needed.
                importer.isReadable = parameters.Value<bool?>("readable") ?? true;
                importer.spriteImportMode = spriteMode == "multiple"
                    ? SpriteImportMode.Multiple
                    : SpriteImportMode.Single;
                importer.spritePixelsPerUnit = parameters.Value<float?>("pixels_per_unit") ?? 100f;
                string filterMode = parameters.Value<string>("filter_mode");
                if (!string.IsNullOrEmpty(filterMode))
                    importer.filterMode = ParseFilterMode(filterMode);

                // Apply the base settings (incl. npotScale) and reimport so the texture
                // is at its true native size before slice rects are computed.
                importer.SaveAndReimport();

                Texture2D importedTexture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                finalWidth = importedTexture != null ? importedTexture.width : width;
                finalHeight = importedTexture != null ? importedTexture.height : height;

                if (importer.spriteImportMode == SpriteImportMode.Multiple)
                {
                    SpriteRect[] spriteRects = BuildSpriteRects(
                        parameters.Value<JObject>("slicing"),
                        finalWidth,
                        finalHeight);
                    ApplySpriteRects(importer, spriteRects);
                    importedSprites = new JArray(spriteRects.Select(rect => new JObject
                    {
                        ["name"] = rect.name,
                        ["rect"] = new JObject
                        {
                            ["x"] = rect.rect.x,
                            ["y"] = rect.rect.y,
                            ["width"] = rect.rect.width,
                            ["height"] = rect.rect.height
                        }
                    }));
                    importer.SaveAndReimport();
                }
            }
            else
            {
                Texture2D importedTexture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                finalWidth = importedTexture != null ? importedTexture.width : width;
                finalHeight = importedTexture != null ? importedTexture.height : height;
            }

            var result = new JObject
            {
                ["path"] = path,
                ["width"] = finalWidth,
                ["height"] = finalHeight,
                ["sprite_mode"] = spriteMode,
                ["source"] = !string.IsNullOrEmpty(sourcePath)
                    ? "source_path"
                    : (!string.IsNullOrEmpty(sourceUrl) ? "source_url" : "generated")
            };
            if (importedSprites != null)
                result["sprites"] = importedSprites;
            ShowWorkVisualizer.SelectAsset(path);
            return result;
        }

        private JObject HandleCreateMaterial(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            ValidateAssetPath(path);

            string shaderName = parameters.Value<string>("shader") ?? "Standard";
            if (shaderName == "URP/Lit")
                shaderName = "Universal Render Pipeline/Lit";
            Shader shader = Shader.Find(shaderName);
            if (shader == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Shader not found: '{shaderName}'");

            Material mat = new Material(shader);

            // Optional color
            JObject colorObj = parameters.Value<JObject>("color");
            if (colorObj != null)
                mat.color = ColorParsing.ParseColor(colorObj);

            // Optional main texture. Accept either 'texture' or 'mainTexture' as an
            // asset-path string (e.g. "Assets/Art/Sky.png"). The texture is assigned to
            // the shader's main texture slot (mat.mainTexture → "_MainTex" on Standard /
            // Sprites shaders). This lets agents build parallax/material setups without
            // hand-authoring .mat files just to reference a texture GUID.
            string texturePath = parameters.Value<string>("texture")
                ?? parameters.Value<string>("mainTexture");
            bool textureAssigned = false;
            if (!string.IsNullOrEmpty(texturePath))
            {
                Texture mainTexture = LoadTexture(texturePath);
                mat.mainTexture = mainTexture;
                SetTextureIfPropertyExists(mat, "_BaseMap", mainTexture);
                SetTextureIfPropertyExists(mat, "_MainTex", mainTexture);
                textureAssigned = true;
            }

            string baseMapPath = parameters.Value<string>("base_map") ?? parameters.Value<string>("baseMap");
            if (!string.IsNullOrEmpty(baseMapPath))
            {
                Texture baseMap = LoadTexture(baseMapPath);
                mat.mainTexture = baseMap;
                SetTextureIfPropertyExists(mat, "_BaseMap", baseMap);
                SetTextureIfPropertyExists(mat, "_MainTex", baseMap);
            }

            string normalMapPath = parameters.Value<string>("normal_map") ?? parameters.Value<string>("normalMap");
            if (!string.IsNullOrEmpty(normalMapPath))
            {
                Texture normalMap = LoadTexture(normalMapPath);
                SetTextureIfPropertyExists(mat, "_BumpMap", normalMap);
                SetFloatIfPropertyExists(mat, "_BumpScale", parameters.Value<float?>("normal_scale") ?? 1f);
                mat.EnableKeyword("_NORMALMAP");
            }

            string metallicMapPath = parameters.Value<string>("metallic_map") ?? parameters.Value<string>("metallicMap");
            if (!string.IsNullOrEmpty(metallicMapPath))
            {
                Texture metallicMap = LoadTexture(metallicMapPath);
                SetTextureIfPropertyExists(mat, "_MetallicGlossMap", metallicMap);
                SetFloatIfPropertyExists(mat, "_Metallic", parameters.Value<float?>("metallic") ?? 1f);
                SetFloatIfPropertyExists(mat, "_Smoothness", parameters.Value<float?>("smoothness") ?? 0.5f);
                mat.EnableKeyword("_METALLICSPECGLOSSMAP");
            }

            string emissionMapPath = parameters.Value<string>("emission_map") ?? parameters.Value<string>("emissionMap");
            JObject emissionColorObj = parameters.Value<JObject>("emission_color")
                ?? parameters.Value<JObject>("emissionColor");
            if (!string.IsNullOrEmpty(emissionMapPath) || emissionColorObj != null)
            {
                if (!string.IsNullOrEmpty(emissionMapPath))
                    SetTextureIfPropertyExists(mat, "_EmissionMap", LoadTexture(emissionMapPath));

                Color emissionColor = ParseColor(emissionColorObj, Color.white);
                float intensity = parameters.Value<float?>("emission_intensity")
                    ?? parameters.Value<float?>("emissionIntensity")
                    ?? 1f;
                SetColorIfPropertyExists(mat, "_EmissionColor", emissionColor * intensity);
                mat.EnableKeyword("_EMISSION");
                mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            }

            // URP surface / blend / decal-safe options. Refuse-not-skip: if the caller
            // asks for a surface feature the shader can't express, RequireShaderProperty
            // refuses naming the shader rather than silently setting nothing.
            string surface = (parameters.Value<string>("surface") ?? "").Trim().ToLowerInvariant();
            string blend = (parameters.Value<string>("blend") ?? "").Trim().ToLowerInvariant();
            int? renderQueue = parameters.Value<int?>("render_queue") ?? parameters.Value<int?>("renderQueue");
            bool? specularHighlights = parameters.Value<bool?>("specular_highlights")
                ?? parameters.Value<bool?>("specularHighlights");
            bool? environmentReflections = parameters.Value<bool?>("environment_reflections")
                ?? parameters.Value<bool?>("environmentReflections");
            bool surfaceOptionsApplied = ApplyUrpSurfaceOptions(
                mat, shaderName, surface, blend, renderQueue, specularHighlights, environmentReflections);

            // Ensure directory exists
            string fullPath = GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!Directory.Exists(directory))
                Directory.CreateDirectory(directory);

            AssetDatabase.CreateAsset(mat, path);
            AssetDatabase.SaveAssets();

            var result = new JObject
            {
                ["path"] = path,
                ["shader"] = shaderName
            };
            if (textureAssigned)
                result["texture"] = texturePath;
            if (!string.IsNullOrEmpty(baseMapPath))
                result["base_map"] = baseMapPath;
            if (!string.IsNullOrEmpty(normalMapPath))
                result["normal_map"] = normalMapPath;
            if (!string.IsNullOrEmpty(metallicMapPath))
                result["metallic_map"] = metallicMapPath;
            if (!string.IsNullOrEmpty(emissionMapPath))
                result["emission_map"] = emissionMapPath;
            if (surfaceOptionsApplied || !string.IsNullOrEmpty(surface) || !string.IsNullOrEmpty(blend))
            {
                if (!string.IsNullOrEmpty(surface))
                    result["surface"] = surface;
                if (!string.IsNullOrEmpty(blend))
                    result["blend"] = blend;
            }
            result["render_queue"] = mat.renderQueue;
            if (specularHighlights.HasValue)
                result["specular_highlights"] = specularHighlights.Value;
            if (environmentReflections.HasValue)
                result["environment_reflections"] = environmentReflections.Value;
            ShowWorkVisualizer.SelectAsset(mat);
            return result;
        }

        /// <summary>
        /// Applies URP Lit-style surface-type, blend, render-queue, and decal-safe
        /// (specular/environment-reflection) options. Returns true when any option was
        /// requested. Refuses (refuse-not-skip) when the shader lacks a targeted property.
        ///
        /// URP keyword/blend wiring mirrors what the URP Lit ShaderGUI applies
        /// (com.unity.render-pipelines.universal BaseShaderGUI.SetupMaterialBlendModeInternal
        /// and LitGUI/ShaderGraphLitGUI.SetMaterialKeywords):
        ///   - _Surface: 0 = Opaque, 1 = Transparent
        ///   - Opaque:      _SrcBlend=One, _DstBlend=Zero, _ZWrite=1, queue=Geometry(2000),
        ///                  keyword _SURFACE_TYPE_TRANSPARENT off, _ALPHAPREMULTIPLY_ON off
        ///   - Transparent: _ZWrite=0, queue=Transparent(3000), keyword _SURFACE_TYPE_TRANSPARENT on
        ///       * alpha    (_Blend=0): _SrcBlend=SrcAlpha, _DstBlend=OneMinusSrcAlpha
        ///       * additive (_Blend=2): _SrcBlend=One,      _DstBlend=One (per this op's spec)
        ///   - _SPECULARHIGHLIGHTS_OFF is ENABLED when _SpecularHighlights == 0
        ///   - _ENVIRONMENTREFLECTIONS_OFF is ENABLED when _EnvironmentReflections == 0
        /// </summary>
        private static bool ApplyUrpSurfaceOptions(
            Material mat, string shaderName, string surface, string blend,
            int? renderQueue, bool? specularHighlights, bool? environmentReflections)
        {
            bool wantsSurface = !string.IsNullOrEmpty(surface);
            bool wantsBlend = !string.IsNullOrEmpty(blend);
            bool applied = false;

            if (wantsSurface || wantsBlend)
            {
                RequireShaderProperty(mat, shaderName, "_Surface", "surface/blend options");
                RequireShaderProperty(mat, shaderName, "_SrcBlend", "surface/blend options");
                RequireShaderProperty(mat, shaderName, "_DstBlend", "surface/blend options");
                RequireShaderProperty(mat, shaderName, "_ZWrite", "surface/blend options");

                bool transparent;
                if (wantsSurface)
                {
                    if (surface == "opaque") transparent = false;
                    else if (surface == "transparent") transparent = true;
                    else throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported surface '{surface}'. Use 'opaque' or 'transparent'.");
                }
                else
                {
                    // A blend without an explicit surface implies a transparent surface.
                    transparent = true;
                }

                string blendMode = wantsBlend ? blend : "alpha";
                if (blendMode != "alpha" && blendMode != "additive")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported blend '{blend}'. Use 'alpha' or 'additive'.");

                if (!transparent)
                {
                    mat.SetFloat("_Surface", 0f);
                    mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);
                    mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero);
                    mat.SetFloat("_ZWrite", 1f);
                    SetFloatIfPropertyExists(mat, "_Blend", 0f);
                    mat.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
                    mat.DisableKeyword("_ALPHAPREMULTIPLY_ON");
                    mat.SetOverrideTag("RenderType", "Opaque");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Geometry;
                }
                else
                {
                    mat.SetFloat("_Surface", 1f);
                    mat.SetFloat("_ZWrite", 0f);
                    mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                    mat.DisableKeyword("_ALPHAPREMULTIPLY_ON");
                    if (blendMode == "additive")
                    {
                        mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);
                        mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.One);
                        SetFloatIfPropertyExists(mat, "_Blend", 2f);
                        SetFloatIfPropertyExists(mat, "_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
                    }
                    else
                    {
                        mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                        mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                        SetFloatIfPropertyExists(mat, "_Blend", 0f);
                        SetFloatIfPropertyExists(mat, "_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                    }
                    SetFloatIfPropertyExists(mat, "_SrcBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
                    mat.SetOverrideTag("RenderType", "Transparent");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
                }
                applied = true;
            }

            if (specularHighlights.HasValue)
            {
                RequireShaderProperty(mat, shaderName, "_SpecularHighlights", "specular_highlights");
                mat.SetFloat("_SpecularHighlights", specularHighlights.Value ? 1f : 0f);
                if (specularHighlights.Value) mat.DisableKeyword("_SPECULARHIGHLIGHTS_OFF");
                else mat.EnableKeyword("_SPECULARHIGHLIGHTS_OFF");
                applied = true;
            }

            if (environmentReflections.HasValue)
            {
                RequireShaderProperty(mat, shaderName, "_EnvironmentReflections", "environment_reflections");
                mat.SetFloat("_EnvironmentReflections", environmentReflections.Value ? 1f : 0f);
                if (environmentReflections.Value) mat.DisableKeyword("_ENVIRONMENTREFLECTIONS_OFF");
                else mat.EnableKeyword("_ENVIRONMENTREFLECTIONS_OFF");
                applied = true;
            }

            // An explicit render-queue override wins over the surface-type default.
            if (renderQueue.HasValue)
            {
                mat.renderQueue = renderQueue.Value;
                applied = true;
            }

            return applied;
        }

        private static void RequireShaderProperty(Material mat, string shaderName, string property, string feature)
        {
            if (!mat.HasProperty(property))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Cannot apply {feature}: shader '{shaderName}' has no property '{property}'.");
        }

        private JObject HandleCreatePrefab(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            ValidateAssetPath(path);

            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            ValidateExpectedScene(parameters, false);
            GameObject go = LocatorResolver.Resolve(locator);

            // Ensure directory exists
            string fullPath = GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!Directory.Exists(directory))
                Directory.CreateDirectory(directory);

            bool connectSource = parameters.Value<bool?>("connect_source")
                ?? parameters.Value<bool?>("connectSource")
                ?? false;
            GameObject prefab;
            if (connectSource)
            {
                bool success;
                prefab = PrefabUtility.SaveAsPrefabAssetAndConnect(go, path, InteractionMode.AutomatedAction, out success);
                if (!success)
                    prefab = null;
            }
            else
            {
                prefab = PrefabUtility.SaveAsPrefabAsset(go, path);
            }
            if (prefab == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Failed to create prefab at: '{path}'");

            ShowWorkVisualizer.SelectAsset(prefab);

            return new JObject
            {
                ["path"] = path,
                ["name"] = prefab.name,
                ["connected_source"] = connectSource && PrefabUtility.GetPrefabInstanceStatus(go) == PrefabInstanceStatus.Connected
            };
        }

        private JObject HandleReplaceWithPrefab(JObject parameters)
        {
            ValidateExpectedScene(parameters, true);

            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Prefab not found at: '{path}'");

            JArray locators = parameters.Value<JArray>("locators");
            if (locators == null || locators.Count == 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required non-empty parameter: 'locators'");

            bool dryRun = parameters.Value<bool?>("dry_run")
                ?? parameters.Value<bool?>("dryRun")
                ?? false;

            // remap_references (default false → behavior unchanged): BEFORE destroying each source,
            // find EVERY external serialized reference into its hierarchy (root, components, and all
            // DESCENDANTS — the scan surface equals the destroy surface); AFTER instantiating the
            // replacement, re-point them to the corresponding object on the new instance: resolve the
            // referenced object's RELATIVE path under the source on the replacement, then match
            // components by TYPE + INDEX on that resolved child. A reference whose child path or
            // component type is absent on the replacement is reported as unmapped (NOT silently
            // dropped) — the honest dogfood-incident fix. The remap scan is UNBOUNDED (a capped remap
            // would silently miss references).
            bool remapReferences = parameters.Value<bool?>("remap_references")
                ?? parameters.Value<bool?>("remapReferences")
                ?? false;

            // allow_cross_scene_remap (default false): expected_scene_path guards only the ACTIVE
            // scene, but external references can live in OTHER loaded scenes. Writing there would
            // silently escape the scene guard, so a live remap REFUSES (before ANY mutation) when a
            // reference outside the active scene exists — unless this flag explicitly permits it.
            bool allowCrossSceneRemap = parameters.Value<bool?>("allow_cross_scene_remap")
                ?? parameters.Value<bool?>("allowCrossSceneRemap")
                ?? false;

            var replacements = new JArray();

            // Resolve all sources up front so the cross-scene refusal below can run before ANY
            // mutation (validate-then-apply: a refusal must leave every locator untouched).
            var sources = new List<GameObject>();
            foreach (JObject locator in locators.OfType<JObject>())
                sources.Add(LocatorResolver.Resolve(locator));

            // Live remap: pre-scan every source's external references WHILE ALL sources are alive,
            // then refuse on a cross-scene write before the first instantiate/destroy.
            List<List<ReferenceScanner.ReferenceHit>> preScannedHits = null;
            if (remapReferences && !dryRun)
            {
                preScannedHits = new List<List<ReferenceScanner.ReferenceHit>>(sources.Count);
                Scene activeScene = SceneManager.GetActiveScene();
                var crossScenePaths = new SortedSet<string>(StringComparer.Ordinal);
                foreach (GameObject source in sources)
                {
                    List<ReferenceScanner.ReferenceHit> hits = ReferenceScanner.ScanExternalReferencesTo(source);
                    preScannedHits.Add(hits);
                    foreach (ReferenceScanner.ReferenceHit hit in hits)
                    {
                        if (hit.ReferencingComponent != null
                            && hit.ReferencingComponent.gameObject.scene != activeScene)
                        {
                            crossScenePaths.Add(
                                ReferenceScanner.DescribeScenePath(hit.ReferencingComponent.gameObject.scene) ?? "<unknown>");
                        }
                    }
                }
                if (!allowCrossSceneRemap && crossScenePaths.Count > 0)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "remap_references would write serialized references in loaded scene(s) OUTSIDE the " +
                        $"expected_scene_path-guarded active scene: {string.Join(", ", crossScenePaths)}. " +
                        "Pass allow_cross_scene_remap:true to permit those writes (nothing has been mutated).");
            }

            for (int sourceIndex = 0; sourceIndex < sources.Count; sourceIndex++)
            {
                GameObject source = sources[sourceIndex];
                Transform sourceTransform = source.transform;
                Transform parent = sourceTransform.parent;
                int siblingIndex = sourceTransform.GetSiblingIndex();
                Vector3 localPosition = sourceTransform.localPosition;
                Quaternion localRotation = sourceTransform.localRotation;
                Vector3 localScale = sourceTransform.localScale;
                string beforeLocator = LocatorResolver.BuildLocator(source)?.ToString(Newtonsoft.Json.Formatting.None);

                var entry = new JObject
                {
                    ["before"] = LocatorResolver.BuildLocator(source),
                    ["parent"] = parent != null ? LocatorResolver.BuildLocator(parent.gameObject) : null,
                    ["sibling_index"] = siblingIndex,
                    ["local_position"] = VectorToJson(localPosition),
                    ["local_rotation_euler"] = VectorToJson(sourceTransform.localEulerAngles),
                    ["local_scale"] = VectorToJson(localScale)
                };

                if (!dryRun)
                {
                    // External references were captured in the pre-scan phase WHILE ALL sources were
                    // still alive (after destroy they resolve to nothing), and before any instantiate
                    // so a new instance's own components are never mistaken for a reference to a source.
                    List<ReferenceScanner.ReferenceHit> externalHits = remapReferences
                        ? preScannedHits[sourceIndex]
                        : null;

                    GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    Undo.RegisterCreatedObjectUndo(instance, $"Replace {source.name} with {prefab.name}");
                    if (parent != null)
                        Undo.SetTransformParent(instance.transform, parent, $"Parent {instance.name}");
                    instance.transform.SetSiblingIndex(Mathf.Min(siblingIndex, parent != null ? parent.childCount - 1 : SceneManager.GetActiveScene().rootCount - 1));
                    instance.transform.localPosition = localPosition;
                    instance.transform.localRotation = localRotation;
                    instance.transform.localScale = localScale;

                    if (remapReferences)
                        RemapReferences(externalHits, instance, entry);

                    Undo.DestroyObjectImmediate(source);
                    entry["after"] = LocatorResolver.BuildLocator(instance);
                }
                else
                {
                    entry["after"] = null;
                    if (remapReferences)
                    {
                        // Dry run: report which references WOULD be remapped/unmapped without mutating.
                        // Mappability is knowable WITHOUT instantiating — the prefab ASSET's hierarchy
                        // (child paths + component type/index) is what the instance will have — so the
                        // dry run evaluates each hit against prefab.transform and reports would-be-
                        // unmapped honestly instead of a rosy everything-remaps answer.
                        List<ReferenceScanner.ReferenceHit> externalHits =
                            ReferenceScanner.ScanExternalReferencesTo(source);
                        var remapped = new JArray();
                        var unmapped = new JArray();
                        foreach (ReferenceScanner.ReferenceHit hit in externalHits)
                        {
                            JObject info = ReferenceScanner.ReferenceHitToJson(hit);
                            UnityEngine.Object wouldTarget = ResolveMappingTarget(hit, prefab.transform, out string reason);
                            if (wouldTarget == null)
                            {
                                info["reason"] = reason;
                                unmapped.Add(info);
                            }
                            else
                            {
                                remapped.Add(info);
                            }
                        }
                        entry["remapped"] = remapped;
                        entry["unmapped"] = unmapped;
                    }
                }

                entry["before_locator"] = beforeLocator;
                replacements.Add(entry);
            }

            if (!dryRun)
            {
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
                AssetDatabase.SaveAssets();
            }

            return new JObject
            {
                ["path"] = path,
                ["dry_run"] = dryRun,
                ["remap_references"] = remapReferences,
                ["replacements"] = replacements
            };
        }

        /// <summary>
        /// Re-point each captured external reference from the destroyed source's object graph to the
        /// corresponding object on <paramref name="instance"/> (the new prefab instance): resolve the
        /// hit's RELATIVE path (the referenced object's path under the source; "" = the root) on the
        /// instance, then a GameObject reference re-points to that resolved GameObject and a component
        /// reference to GetComponents(type)[index] on it. When the replacement lacks the child path or
        /// the component type/index, the reference is reported under 'unmapped' with a reason and left
        /// untouched (it becomes a Missing ref on destroy — surfaced, not hidden). Writes
        /// 'remapped'/'unmapped' JArrays onto <paramref name="entry"/>.
        /// </summary>
        private static void RemapReferences(List<ReferenceScanner.ReferenceHit> hits, GameObject instance, JObject entry)
        {
            var remapped = new JArray();
            var unmapped = new JArray();

            foreach (ReferenceScanner.ReferenceHit hit in hits)
            {
                Component referencing = hit.ReferencingComponent;
                // The referencing component could have been destroyed between scan and remap (e.g. it
                // lived under ANOTHER source replaced earlier in this same call); guard rather than
                // throw on a fake-null.
                if (referencing == null)
                    continue;

                JObject info = ReferenceScanner.ReferenceHitToJson(hit);

                UnityEngine.Object newTarget = ResolveMappingTarget(hit, instance.transform, out string reason);
                if (newTarget == null)
                {
                    info["reason"] = reason;
                    unmapped.Add(info);
                    continue;
                }

                using (var so = new SerializedObject(referencing))
                {
                    SerializedProperty prop = so.FindProperty(hit.PropertyPath);
                    if (prop == null || prop.propertyType != SerializedPropertyType.ObjectReference)
                    {
                        info["reason"] = "property path no longer resolves on referencing component";
                        unmapped.Add(info);
                        continue;
                    }

                    Undo.RecordObject(referencing, "Remap serialized reference");
                    prop.objectReferenceValue = newTarget;
                    // ApplyModifiedProperties returns false when nothing was actually written — count
                    // that as unmapped (the reference did NOT get re-pointed), never as a rosy success.
                    if (!so.ApplyModifiedProperties())
                    {
                        info["reason"] = "ApplyModifiedProperties reported no write for the re-pointed value";
                        unmapped.Add(info);
                        continue;
                    }
                }

                GameObject newTargetGo = newTarget is Component nc ? nc.gameObject : newTarget as GameObject;
                info["after"] = newTargetGo != null ? LocatorResolver.BuildLocator(newTargetGo) : null;
                remapped.Add(info);
            }

            entry["remapped"] = remapped;
            entry["unmapped"] = unmapped;
        }

        /// <summary>
        /// Resolve where a captured reference SHOULD point on a replacement hierarchy rooted at
        /// <paramref name="replacementRoot"/> (a live instance's transform, or the prefab ASSET's
        /// transform for a dry-run evaluation — the asset hierarchy is exactly what the instance
        /// will have). Resolves the hit's relative path first, then the component by type + index.
        /// Returns null with a specific <paramref name="reason"/> when unmappable.
        /// </summary>
        private static UnityEngine.Object ResolveMappingTarget(
            ReferenceScanner.ReferenceHit hit, Transform replacementRoot, out string reason)
        {
            reason = null;

            Transform resolved = ReferenceScanner.ResolveRelativePath(replacementRoot, hit.RelativePath);
            if (resolved == null)
            {
                reason = $"child path '{hit.RelativePath}' not found on the replacement";
                return null;
            }

            if (hit.ReferencesGameObject)
                return resolved.gameObject;

            if (hit.ReferencedComponentType == null)
            {
                reason = "reference target type could not be determined";
                return null;
            }

            Component[] candidates = resolved.gameObject.GetComponents(hit.ReferencedComponentType);
            if (candidates == null || hit.ReferencedComponentIndex >= candidates.Length)
            {
                string where = string.IsNullOrEmpty(hit.RelativePath) ? "the replacement root" : $"replacement child '{hit.RelativePath}'";
                reason = $"{where} has no '{hit.ReferencedComponentType.Name}' component at index {hit.ReferencedComponentIndex}";
                return null;
            }
            return candidates[hit.ReferencedComponentIndex];
        }

        private JObject HandleCreatePrefabVariant(JObject parameters)
        {
            string basePrefabPath = parameters.Value<string>("base_prefab_path")
                ?? parameters.Value<string>("basePrefabPath");
            if (string.IsNullOrEmpty(basePrefabPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'base_prefab_path'");

            string path = parameters.Value<string>("path")
                ?? parameters.Value<string>("variant_path")
                ?? parameters.Value<string>("variantPath");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            ValidateAssetPath(path);

            GameObject basePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(basePrefabPath);
            if (basePrefab == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Base prefab not found at: '{basePrefabPath}'");

            Scene previewScene = default;
            bool hasPreviewScene = false;
            GameObject instance = null;
            try
            {
                previewScene = EditorSceneManager.NewPreviewScene();
                hasPreviewScene = true;

                instance = (GameObject)PrefabUtility.InstantiatePrefab(basePrefab, previewScene);
                if (instance == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Failed to instantiate base prefab: '{basePrefabPath}'");

                ApplyPrefabVariantOverrides(instance, parameters.Value<JObject>("overrides") ?? parameters);

                string fullPath = GetFullPath(path);
                string directory = Path.GetDirectoryName(fullPath);
                if (!Directory.Exists(directory))
                    Directory.CreateDirectory(directory);

                GameObject variant = PrefabUtility.SaveAsPrefabAsset(instance, path);
                if (variant == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Failed to create prefab variant at: '{path}'");

                PrefabAssetType assetType = PrefabUtility.GetPrefabAssetType(variant);
                if (assetType != PrefabAssetType.Variant)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Created prefab at '{path}' but Unity reported asset type '{assetType}', not Variant.");

                ShowWorkVisualizer.SelectAsset(variant);

                return new JObject
                {
                    ["path"] = path,
                    ["base_prefab_path"] = basePrefabPath,
                    ["name"] = variant.name,
                    ["prefab_asset_type"] = assetType.ToString(),
                    ["base_name"] = basePrefab.name
                };
            }
            finally
            {
                if (instance != null)
                    UnityEngine.Object.DestroyImmediate(instance);
                if (hasPreviewScene)
                    EditorSceneManager.ClosePreviewScene(previewScene);
            }
        }

        private JObject HandleInstantiatePrefab(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Prefab not found at: '{path}'");

            ValidateExpectedScene(parameters, false);
            GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            Undo.RegisterCreatedObjectUndo(instance, $"Instantiate {prefab.name}");

            // Optional parent
            JObject parentLocator = parameters.Value<JObject>("parent");
            if (parentLocator != null)
            {
                GameObject parent = LocatorResolver.Resolve(parentLocator);
                Undo.SetTransformParent(instance.transform, parent.transform,
                    $"Set parent of {instance.name}");
            }

            // Optional position
            JObject position = parameters.Value<JObject>("position");
            if (position != null)
            {
                instance.transform.localPosition = new Vector3(
                    position.Value<float?>("x") ?? 0f,
                    position.Value<float?>("y") ?? 0f,
                    position.Value<float?>("z") ?? 0f);
            }

            ShowWorkVisualizer.SelectObject(instance);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(instance),
                ["name"] = instance.name
            };
        }

        private JObject HandleSetTextureImportSettings(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            TextureImporter importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Texture importer not found at path: '{path}'");

            string textureType = parameters.Value<string>("texture_type")
                ?? parameters.Value<string>("textureType");
            if (!string.IsNullOrEmpty(textureType))
                importer.textureType = ParseTextureImporterType(textureType);

            // Sprite import mode. An explicit sprite_mode wins; otherwise, when this call
            // marks the texture as a Sprite, default the mode to Single. The observed
            // failure this guards: textures that land Multiple/unsliced produce ZERO
            // sprite sub-assets, so a later assign_sprite fails "Sprite not found". Single
            // guarantees exactly one usable sprite; pass sprite_mode:"multiple" only when
            // the sheet will also be sliced (see create_sprite slicing).
            string spriteMode = parameters.Value<string>("sprite_mode")
                ?? parameters.Value<string>("spriteMode");
            if (!string.IsNullOrEmpty(spriteMode))
            {
                if (spriteMode != "single" && spriteMode != "multiple")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported sprite_mode '{spriteMode}'. Use 'single' or 'multiple'.");
                importer.spriteImportMode = spriteMode == "multiple"
                    ? SpriteImportMode.Multiple
                    : SpriteImportMode.Single;
            }
            else if (!string.IsNullOrEmpty(textureType)
                && importer.textureType == TextureImporterType.Sprite
                && !HasSlicedSprites(importer, path))
            {
                importer.spriteImportMode = SpriteImportMode.Single;
            }

            bool? srgb = parameters.Value<bool?>("sRGB")
                ?? parameters.Value<bool?>("srgb");
            if (srgb.HasValue)
                importer.sRGBTexture = srgb.Value;

            bool? mipmaps = parameters.Value<bool?>("mipmaps")
                ?? parameters.Value<bool?>("mipmapEnabled");
            if (mipmaps.HasValue)
                importer.mipmapEnabled = mipmaps.Value;

            bool? readable = parameters.Value<bool?>("readable");
            if (readable.HasValue)
                importer.isReadable = readable.Value;

            string alphaSource = parameters.Value<string>("alpha_source")
                ?? parameters.Value<string>("alphaSource");
            if (!string.IsNullOrEmpty(alphaSource))
                importer.alphaSource = ParseAlphaSource(alphaSource);

            importer.SaveAndReimport();

            return new JObject
            {
                ["path"] = path,
                ["texture_type"] = importer.textureType.ToString(),
                ["sprite_import_mode"] = importer.spriteImportMode.ToString(),
                ["sRGB"] = importer.sRGBTexture,
                ["mipmaps"] = importer.mipmapEnabled,
                ["readable"] = importer.isReadable,
                ["alpha_source"] = importer.alphaSource.ToString()
            };
        }

        private JObject HandleSetRendererMaterials(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            JArray materialPaths = parameters.Value<JArray>("materials");
            if (materialPaths == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'materials'");

            GameObject go = LocatorResolver.Resolve(locator);
            Renderer renderer = go.GetComponent<Renderer>();
            if (renderer == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Renderer not found on '{go.name}'");

            var materials = new Material[materialPaths.Count];
            for (int i = 0; i < materialPaths.Count; i++)
            {
                string materialPath = materialPaths[i].Value<string>();
                Material material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                if (material == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Material not found at path: '{materialPath}'");
                materials[i] = material;
            }

            bool strictSubmeshCount = parameters.Value<bool?>("strict_submesh_count")
                ?? parameters.Value<bool?>("strictSubmeshCount")
                ?? false;
            if (strictSubmeshCount)
            {
                int submeshCount = GetSubmeshCount(renderer);
                if (submeshCount > 0 && submeshCount != materials.Length)
                {
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Renderer has {submeshCount} submesh(es), but {materials.Length} material(s) were provided.");
                }
            }

            Undo.RecordObject(renderer, $"Set materials on {go.name}");
            renderer.sharedMaterials = materials;
            EditorUtility.SetDirty(renderer);

            return new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["materials"] = new JArray(materialPaths),
                ["count"] = materials.Length
            };
        }

        // ─────────────────────────────────────────────
        // Model importer + sub-asset introspection
        //
        // Eliminates the manual FBX rig loop observed in the art-integration
        // dogfood: cloning a known-good .fbx.meta with a fresh guid to
        // configure import, then grepping a temp prefab for `m_Animation:`
        // to discover clip fileIDs. list_sub_assets surfaces those fileIDs
        // directly; inspect/configure_model_importer replace hand-edited
        // .fbx.meta clipAnimations/avatarSetup/animationType.
        // ─────────────────────────────────────────────

        private JObject HandleListSubAssets(JObject parameters)
        {
            string assetPath = ResolveAssetPathParam(parameters);

            UnityEngine.Object[] assets = LoadAllAssetsWithRefreshRetry(assetPath);

            var subAssets = new JArray();
            foreach (UnityEngine.Object obj in assets)
            {
                if (obj == null)
                    continue;
                subAssets.Add(DescribeSubAsset(obj));
            }

            return new JObject
            {
                ["asset_path"] = assetPath,
                ["count"] = subAssets.Count,
                ["sub_assets"] = subAssets
            };
        }

        private JObject DescribeSubAsset(UnityEngine.Object obj)
        {
            var entry = new JObject
            {
                ["name"] = obj.name,
                ["type"] = obj.GetType().Name,
                ["isMainAsset"] = AssetDatabase.IsMainAsset(obj)
            };

            // fileID (localId) + guid via TryGetGUIDAndLocalFileIdentifier. This is
            // the same fileID the dogfood session hand-grepped out of a temp prefab.
            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(obj, out string guid, out long fileId))
            {
                entry["fileID"] = fileId;
                entry["guid"] = guid;
            }
            else
            {
                entry["fileID"] = null;
                entry["guid"] = null;
            }

            if (obj is AnimationClip clip)
            {
                entry["length"] = clip.length;
                entry["isLooping"] = clip.isLooping;
            }
            else if (obj is Avatar avatar)
            {
                entry["isHuman"] = avatar.isHuman;
                entry["isValid"] = avatar.isValid;
            }

            return entry;
        }

        private JObject HandleInspectModelImporter(JObject parameters)
        {
            string assetPath = ResolveAssetPathParam(parameters);
            ModelImporter importer = GetModelImporterOrRefuse(assetPath);
            return BuildModelImporterPayload(assetPath, importer);
        }

        private JObject HandleConfigureModelImporter(JObject parameters)
        {
            string assetPath = ResolveAssetPathParam(parameters);
            ModelImporter importer = GetModelImporterOrRefuse(assetPath);

            bool animationDiscoveryChanged = false;

            JToken animationType = parameters["animation_type"] ?? parameters["animationType"];
            if (animationType != null && animationType.Type != JTokenType.Null)
            {
                importer.animationType = ParseEnum<ModelImporterAnimationType>(animationType, "animation_type");
                animationDiscoveryChanged = true;
            }

            JToken avatarSetup = parameters["avatar_setup"] ?? parameters["avatarSetup"];
            if (avatarSetup != null && avatarSetup.Type != JTokenType.Null)
            {
                importer.avatarSetup = ParseEnum<ModelImporterAvatarSetup>(avatarSetup, "avatar_setup");
                animationDiscoveryChanged = true;
            }

            bool? importAnimation = parameters.Value<bool?>("import_animation")
                ?? parameters.Value<bool?>("importAnimation");
            if (importAnimation.HasValue)
            {
                importer.importAnimation = importAnimation.Value;
                animationDiscoveryChanged = true;
            }

            float? globalScale = parameters.Value<float?>("global_scale")
                ?? parameters.Value<float?>("globalScale");
            if (globalScale.HasValue)
                importer.globalScale = globalScale.Value;

            bool? useFileScale = parameters.Value<bool?>("use_file_scale")
                ?? parameters.Value<bool?>("useFileScale");
            if (useFileScale.HasValue)
                importer.useFileScale = useFileScale.Value;

            JArray clipOverrides = parameters.Value<JArray>("clip_overrides")
                ?? parameters.Value<JArray>("clipOverrides");

            // Take discovery (defaultClipAnimations / importedTakeInfos) reflects the
            // LAST import. When this call changes an animation-discovery setting
            // (animation_type / avatar_setup / import_animation — e.g. flipping an FBX
            // off the NoAvatar default, which imports zero clips) AND supplies
            // clip_overrides in the same call, the overrides must be seeded from the
            // takes the NEW settings produce, not the stale pre-change set (which may
            // be empty). So: reimport once to refresh discovery, re-fetch the importer,
            // then apply the overrides and reimport again — two internal reimports in
            // one op call, so enable-and-loop works in a single request.
            if (animationDiscoveryChanged && clipOverrides != null && clipOverrides.Count > 0)
            {
                importer.SaveAndReimport();
                importer = AssetImporter.GetAtPath(assetPath) as ModelImporter ?? importer;
            }

            if (clipOverrides != null && clipOverrides.Count > 0)
                ApplyClipOverrides(importer, clipOverrides);

            // A ModelImporter reimport re-serializes the asset and its sub-assets but
            // does NOT compile scripts, so it never triggers a domain reload — unlike
            // package.add/remove (see CLAUDE.md "Op Development Gotchas"). A synchronous
            // response is therefore safe; WaitEngine/socket state survives the reimport.
            // Rigged-model reimports are still SLOW (routinely past the 10s wire
            // fallback), so the registry entry declares a realistic defaultTimeoutMs
            // and advertises a per-call timeoutMs (read by resolveOpTimeoutMs for
            // every op, sync or async).
            importer.SaveAndReimport();

            // Reload the importer post-reimport so the returned payload reflects the
            // resolved (possibly Unity-normalized) values, not the in-memory pre-save ones.
            ModelImporter reloaded = AssetImporter.GetAtPath(assetPath) as ModelImporter ?? importer;
            return BuildModelImporterPayload(assetPath, reloaded);
        }

        private void ApplyClipOverrides(ModelImporter importer, JArray clipOverrides)
        {
            // Seed from the current user clipAnimations if present, else from the
            // auto-generated defaultClipAnimations (the takes Unity discovers in the
            // model). Overriding a take = editing its ModelImporterClipAnimation and
            // writing the array back — matching the .fbx.meta clipAnimations hand-edit
            // the dogfood session performed to force loopTime on.
            List<ModelImporterClipAnimation> clips = importer.clipAnimations != null
                && importer.clipAnimations.Length > 0
                    ? importer.clipAnimations.ToList()
                    : importer.defaultClipAnimations.ToList();

            var availableTakes = clips.Select(c => c.takeName).ToList();

            foreach (JToken token in clipOverrides)
            {
                if (!(token is JObject overrideObj))
                    continue;

                string takeName = overrideObj.Value<string>("take_name")
                    ?? overrideObj.Value<string>("takeName");
                if (string.IsNullOrEmpty(takeName))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Each clip override requires a 'take_name'.");

                ModelImporterClipAnimation clip = clips.FirstOrDefault(c => c.takeName == takeName);
                if (clip == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"No take named '{takeName}' on model. Available takes: " +
                        (availableTakes.Count > 0 ? string.Join(", ", availableTakes) : "(none)"));

                string newName = overrideObj.Value<string>("name");
                if (!string.IsNullOrEmpty(newName))
                    clip.name = newName;

                bool? loopTime = overrideObj.Value<bool?>("loop_time")
                    ?? overrideObj.Value<bool?>("loopTime");
                if (loopTime.HasValue)
                    clip.loopTime = loopTime.Value;

                float? firstFrame = overrideObj.Value<float?>("first_frame")
                    ?? overrideObj.Value<float?>("firstFrame");
                if (firstFrame.HasValue)
                    clip.firstFrame = firstFrame.Value;

                float? lastFrame = overrideObj.Value<float?>("last_frame")
                    ?? overrideObj.Value<float?>("lastFrame");
                if (lastFrame.HasValue)
                    clip.lastFrame = lastFrame.Value;
            }

            ValidateClipNameUniqueness(clips);

            importer.clipAnimations = clips.ToArray();
        }

        // Refuses when the FINAL clip-name set (renamed + untouched clips together)
        // contains duplicates. Unity does not deduplicate clip sub-asset names —
        // colliding names get mangled unpredictably and fileID stability breaks —
        // so a silent collision is worse than a refusal. Internal for direct
        // EditMode testing (ModelImporterClipAnimation is constructible without a
        // model asset; the full ApplyClipOverrides path needs a real ModelImporter).
        internal static void ValidateClipNameUniqueness(IEnumerable<ModelImporterClipAnimation> clips)
        {
            var duplicates = clips
                .GroupBy(c => c.name)
                .Where(g => g.Count() > 1)
                .Select(g => g.Key)
                .ToList();

            if (duplicates.Count > 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Clip name collision after applying clip_overrides: " +
                    string.Join(", ", duplicates.Select(d => $"'{d}'")) +
                    ". Every resulting clip name (renamed and untouched alike) must be unique.");
        }

        private JObject BuildModelImporterPayload(string assetPath, ModelImporter importer)
        {
            var clipAnimations = new JArray();
            foreach (ModelImporterClipAnimation clip in importer.clipAnimations)
                clipAnimations.Add(DescribeClipAnimation(clip));

            var defaultClipNames = new JArray();
            foreach (ModelImporterClipAnimation clip in importer.defaultClipAnimations)
                defaultClipNames.Add(clip.name);

            var takeNames = new JArray();
            foreach (TakeInfo take in importer.importedTakeInfos)
                takeNames.Add(take.name);

            return new JObject
            {
                ["asset_path"] = assetPath,
                ["animationType"] = importer.animationType.ToString(),
                ["avatarSetup"] = importer.avatarSetup.ToString(),
                ["importAnimation"] = importer.importAnimation,
                ["globalScale"] = importer.globalScale,
                ["useFileScale"] = importer.useFileScale,
                ["fileScale"] = importer.fileScale,
                ["materialImportMode"] = importer.materialImportMode.ToString(),
                ["clipAnimations"] = clipAnimations,
                ["defaultClipAnimations"] = defaultClipNames,
                ["importedTakeInfos"] = takeNames
            };
        }

        private static JObject DescribeClipAnimation(ModelImporterClipAnimation clip)
        {
            return new JObject
            {
                ["name"] = clip.name,
                ["takeName"] = clip.takeName,
                ["firstFrame"] = clip.firstFrame,
                ["lastFrame"] = clip.lastFrame,
                ["loopTime"] = clip.loopTime
            };
        }

        // Resolves the asset_path parameter (accepts snake or camel alias) and
        // validates it is under Assets/.
        private static string ResolveAssetPathParam(JObject parameters)
        {
            string assetPath = parameters.Value<string>("asset_path")
                ?? parameters.Value<string>("assetPath");
            if (string.IsNullOrEmpty(assetPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'asset_path'");
            ValidateAssetPath(assetPath);
            return assetPath;
        }

        // LoadAllAssetsAtPath, then a single targeted synchronous import + retry to
        // close the observed import-refresh race (a freshly written model may not be
        // imported yet). Deliberately ImportAsset(path, ForceSynchronousImport) and
        // NOT AssetDatabase.Refresh(): a global Refresh can pick up unrelated dirty
        // scripts and trigger a recompile → domain reload → lost response (the
        // CLAUDE.md gotcha); a single-asset import cannot recompile anything else.
        // If still empty, distinguish "no such asset" / "folder" / "exists but not
        // yet imported" from the project-relative path.
        private static UnityEngine.Object[] LoadAllAssetsWithRefreshRetry(string assetPath)
        {
            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            if (assets != null && assets.Length > 0)
                return assets;

            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
            assets = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            if (assets != null && assets.Length > 0)
                return assets;

            string fullPath = GetFullPath(assetPath);
            if (Directory.Exists(fullPath))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Path is a folder, not a loadable asset: '{assetPath}'. " +
                    "Pass the path of an asset file inside it.");
            if (File.Exists(fullPath))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Asset file exists on disk but is not yet imported (no loadable assets): '{assetPath}'. " +
                    "Wait for import to finish (editor.wait_for) or re-run after a refresh.");

            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"No such asset: '{assetPath}' (file not found on disk).");
        }

        // Returns the ModelImporter for the path, or refuses cleanly if the importer
        // is a different type (e.g. a native .anim, a texture, or a .mat).
        private static ModelImporter GetModelImporterOrRefuse(string assetPath)
        {
            AssetImporter importer = AssetImporter.GetAtPath(assetPath);
            if (importer == null)
            {
                string fullPath = GetFullPath(assetPath);
                if (Directory.Exists(fullPath))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Path is a folder, not a model asset: '{assetPath}'.");
                if (File.Exists(fullPath))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Asset file exists on disk but has no importer yet (not imported): '{assetPath}'.");
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No such asset: '{assetPath}' (file not found on disk).");
            }

            if (!(importer is ModelImporter modelImporter))
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Asset '{assetPath}' is not a model (importer is {importer.GetType().Name}). " +
                    "inspect/configure_model_importer only apply to model assets (.fbx/.obj/.dae/etc).");

            return modelImporter;
        }

        private static TEnum ParseEnum<TEnum>(JToken token, string paramName) where TEnum : struct
        {
            // Accept either the enum name (e.g. "Human") or the underlying int
            // (e.g. 3 / the raw .fbx.meta value) for ergonomics.
            if (token.Type == JTokenType.Integer)
            {
                int value = token.Value<int>();
                if (Enum.IsDefined(typeof(TEnum), value))
                    return (TEnum)Enum.ToObject(typeof(TEnum), value);
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Invalid '{paramName}' value {value}. Valid: " +
                    string.Join(", ", Enum.GetNames(typeof(TEnum))));
            }

            string name = token.Value<string>();
            if (Enum.TryParse(name, ignoreCase: true, out TEnum parsed) && Enum.IsDefined(typeof(TEnum), parsed))
                return parsed;

            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"Invalid '{paramName}' value '{name}'. Valid: " +
                string.Join(", ", Enum.GetNames(typeof(TEnum))));
        }

        // ─────────────────────────────────────────────
        // inspect_audio_importer / configure_audio_importer
        //
        // The audio analogue of the model-importer trio: read + write the
        // AudioImporter import state that the SFX dogfood tuned by
        // hand (load type, compression, force-to-mono, sample-rate override,
        // preload, background loading) so a generated-SFX pass can set
        // role-specific import settings (short critical SFX = DecompressOnLoad
        // + PCM/ADPCM; music/ambience = Streaming) without editing .wav.meta.
        //
        // Unity 6000.3 API surface (verified by IL-disassembling the installed
        // 6000.3.9f1 UnityEditor.CoreModule.dll — not just the ScriptReference):
        //  - AudioImporter carries forceToMono / loadInBackground / ambisonic /
        //    defaultSampleSettings (an AudioImporterSampleSettings struct, get+set).
        //  - preloadAudioData exists BOTH importer-level AND as a struct field on
        //    6000.3. AudioImporter.preloadAudioData is still in the assembly but is
        //    [Obsolete("Preload audio data has been moved to AudioImporter.
        //    SampleSettings as a per platform local setting", error: true)] — an
        //    ERROR-level obsolete, so referencing it fails compilation. The struct
        //    field AudioImporterSampleSettings.preloadAudioData is therefore the
        //    writable surface, and it round-trips atomically with the rest of
        //    defaultSampleSettings in one struct assignment.
        //  - AudioImporterSampleSettings DOES have `public int32 conversionMode`
        //    on 6000.3. It is undocumented and that field is the only occurrence
        //    of the name in the assembly (no public enum type exists), so it is
        //    surfaced as a raw int: always included in the inspect payload and
        //    accepted as an optional integer configure param — name-based enum
        //    parsing is not possible.
        // Platform-specific override settings (GetOverrideSampleSettings /
        // SetOverrideSampleSettings) are OUT OF SCOPE for this slice — only the
        // default platform settings are read and written.
        // ─────────────────────────────────────────────

        private JObject HandleInspectAudioImporter(JObject parameters)
        {
            string assetPath = ResolveAssetPathParam(parameters);
            AudioImporter importer = GetAudioImporterOrRefuse(assetPath);
            return BuildAudioImporterPayload(assetPath, importer);
        }

        private JObject HandleConfigureAudioImporter(JObject parameters)
        {
            string assetPath = ResolveAssetPathParam(parameters);
            AudioImporter importer = GetAudioImporterOrRefuse(assetPath);

            bool? forceToMono = parameters.Value<bool?>("force_to_mono")
                ?? parameters.Value<bool?>("forceToMono");
            if (forceToMono.HasValue)
                importer.forceToMono = forceToMono.Value;

            bool? loadInBackground = parameters.Value<bool?>("load_in_background")
                ?? parameters.Value<bool?>("loadInBackground");
            if (loadInBackground.HasValue)
                importer.loadInBackground = loadInBackground.Value;

            // AudioImporterSampleSettings is a struct: read a copy, mutate the copy,
            // then assign the whole struct back — mutating importer.defaultSampleSettings
            // in place is a no-op because the getter returns a value copy.
            AudioImporterSampleSettings settings = importer.defaultSampleSettings;

            JToken loadType = parameters["load_type"] ?? parameters["loadType"];
            if (loadType != null && loadType.Type != JTokenType.Null)
                settings.loadType = ParseEnum<AudioClipLoadType>(loadType, "load_type");

            JToken compressionFormat = parameters["compression_format"] ?? parameters["compressionFormat"];
            if (compressionFormat != null && compressionFormat.Type != JTokenType.Null)
                settings.compressionFormat = ParseEnum<AudioCompressionFormat>(compressionFormat, "compression_format");

            JToken sampleRateSetting = parameters["sample_rate_setting"] ?? parameters["sampleRateSetting"];
            if (sampleRateSetting != null && sampleRateSetting.Type != JTokenType.Null)
                settings.sampleRateSetting = ParseEnum<AudioSampleRateSetting>(sampleRateSetting, "sample_rate_setting");

            float? quality = parameters.Value<float?>("quality");
            if (quality.HasValue)
            {
                if (quality.Value < 0f || quality.Value > 1f)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'quality' value {quality.Value}. Must be between 0 and 1 (compression amount).");
                settings.quality = quality.Value;
            }

            JToken sampleRateOverride = parameters["sample_rate_override"] ?? parameters["sampleRateOverride"];
            if (sampleRateOverride != null && sampleRateOverride.Type != JTokenType.Null)
            {
                long value = sampleRateOverride.Value<long>();
                if (value < 0)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid 'sample_rate_override' value {value}. Must be a non-negative sample rate in Hz.");
                settings.sampleRateOverride = (uint)value;
            }

            bool? preloadAudioData = parameters.Value<bool?>("preload_audio_data")
                ?? parameters.Value<bool?>("preloadAudioData");
            if (preloadAudioData.HasValue)
                settings.preloadAudioData = preloadAudioData.Value;

            // conversionMode is a public but undocumented raw int field on the
            // struct (no public enum type exists in the 6000.3 assembly), so it
            // is passed through as an integer without name-based validation.
            int? conversionMode = parameters.Value<int?>("conversion_mode")
                ?? parameters.Value<int?>("conversionMode");
            if (conversionMode.HasValue)
                settings.conversionMode = conversionMode.Value;

            importer.defaultSampleSettings = settings;

            // An AudioImporter reimport re-encodes the clip but does NOT compile
            // scripts, so it never triggers a domain reload (unlike package.add/remove
            // — see CLAUDE.md "Op Development Gotchas"). A synchronous response is
            // therefore safe; WaitEngine/socket state survives. Re-encoding a long
            // clip can still exceed the 10s wire fallback, so the registry entry
            // declares a 90s defaultTimeoutMs and a per-call timeoutMs.
            importer.SaveAndReimport();

            AudioImporter reloaded = AssetImporter.GetAtPath(assetPath) as AudioImporter ?? importer;
            return BuildAudioImporterPayload(assetPath, reloaded);
        }

        // Returns the AudioImporter for the path, or refuses cleanly if the importer
        // is a different type (e.g. a texture, a model, or a native .mixer).
        private static AudioImporter GetAudioImporterOrRefuse(string assetPath)
        {
            AssetImporter importer = AssetImporter.GetAtPath(assetPath);
            if (importer == null)
            {
                string fullPath = GetFullPath(assetPath);
                if (Directory.Exists(fullPath))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Path is a folder, not an audio asset: '{assetPath}'.");
                if (File.Exists(fullPath))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Asset file exists on disk but has no importer yet (not imported): '{assetPath}'.");
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No such asset: '{assetPath}' (file not found on disk).");
            }

            if (!(importer is AudioImporter audioImporter))
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Asset '{assetPath}' is not an audio clip (importer is {importer.GetType().Name}). " +
                    "inspect/configure_audio_importer only apply to audio assets (.wav/.ogg/.mp3/.aiff/etc).");

            return audioImporter;
        }

        private static JObject BuildAudioImporterPayload(string assetPath, AudioImporter importer)
        {
            AudioImporterSampleSettings settings = importer.defaultSampleSettings;

            var defaultSampleSettings = new JObject
            {
                ["load_type"] = settings.loadType.ToString(),
                ["compression_format"] = settings.compressionFormat.ToString(),
                ["quality"] = settings.quality,
                ["sample_rate_setting"] = settings.sampleRateSetting.ToString(),
                ["sample_rate_override"] = settings.sampleRateOverride,
                ["preload_audio_data"] = settings.preloadAudioData,
                // Undocumented public int field — reported raw so inspect is a
                // complete dump of the struct; no enum name exists to resolve.
                ["conversion_mode"] = settings.conversionMode
            };

            var payload = new JObject
            {
                ["asset_path"] = assetPath,
                ["force_to_mono"] = importer.forceToMono,
                ["load_in_background"] = importer.loadInBackground,
                ["ambisonic"] = importer.ambisonic,
                ["default_sample_settings"] = defaultSampleSettings
            };

            // The imported AudioClip main asset carries the resolved clip facts
            // (length/channels/frequency/samples). Include them only when the clip
            // is loadable — a not-yet-imported or broken asset must not fabricate them.
            AudioClip clip = AssetDatabase.LoadAssetAtPath<AudioClip>(assetPath);
            if (clip != null)
            {
                payload["clip"] = new JObject
                {
                    ["length"] = clip.length,
                    ["channels"] = clip.channels,
                    ["frequency"] = clip.frequency,
                    ["samples"] = clip.samples
                };
            }
            else
            {
                payload["clip"] = null;
            }

            return payload;
        }

        private JObject HandleChannelPack(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");
            ValidateAssetPath(path);
            ValidateSpriteFileExtension(path);

            string preset = (parameters.Value<string>("preset") ?? "metallic_smoothness")
                .Trim().ToLowerInvariant();
            if (preset == "mask_map" || preset == "maskmap")
                return HandleChannelPackMaskMap(parameters, path);
            if (preset != "metallic_smoothness" && preset != "metallicsmoothness")
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unsupported channel_pack preset '{preset}'. Use 'metallic_smoothness' or 'mask_map'.");

            string metallicPath = parameters.Value<string>("metallic_path")
                ?? parameters.Value<string>("metallicPath");
            string roughnessPath = parameters.Value<string>("roughness_path")
                ?? parameters.Value<string>("roughnessPath");
            if (string.IsNullOrEmpty(metallicPath) && string.IsNullOrEmpty(roughnessPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "At least one of 'metallic_path' or 'roughness_path' is required.");

            TextureImporter metallicImporter = null;
            TextureImporter roughnessImporter = null;
            bool metallicWasReadable = true;
            bool roughnessWasReadable = true;
            Color[] metallicPixels;
            Color[] roughnessPixels;
            int width;
            int height;
            // Restore in finally: a load failure or dimension-mismatch throw must not
            // leave an already-loaded source permanently readable.
            try
            {
                Texture2D metallic = !string.IsNullOrEmpty(metallicPath)
                    ? LoadReadableTexture(metallicPath, out metallicImporter, out metallicWasReadable)
                    : null;
                Texture2D roughness = !string.IsNullOrEmpty(roughnessPath)
                    ? LoadReadableTexture(roughnessPath, out roughnessImporter, out roughnessWasReadable)
                    : null;
                width = metallic != null ? metallic.width : roughness.width;
                height = metallic != null ? metallic.height : roughness.height;
                if (roughness != null && (roughness.width != width || roughness.height != height))
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Metallic and roughness textures must have identical dimensions.");

                metallicPixels = metallic != null ? metallic.GetPixels() : null;
                roughnessPixels = roughness != null ? roughness.GetPixels() : null;
            }
            finally
            {
                RestoreReadableFlag(metallicImporter, metallicWasReadable);
                if (roughnessImporter != metallicImporter)
                    RestoreReadableFlag(roughnessImporter, roughnessWasReadable);
            }

            Texture2D packed = new Texture2D(width, height, TextureFormat.RGBA32, false, true);
            Color[] pixels = new Color[width * height];
            for (int i = 0; i < pixels.Length; i++)
            {
                float m = metallicPixels != null ? metallicPixels[i].grayscale : 0f;
                float smoothness = roughnessPixels != null ? 1f - roughnessPixels[i].grayscale : 0.5f;
                pixels[i] = new Color(m, 0f, 0f, smoothness);
            }
            packed.SetPixels(pixels);
            packed.Apply();

            try
            {
                string fullPath = GetFullPath(path);
                string directory = Path.GetDirectoryName(fullPath);
                if (!Directory.Exists(directory))
                    Directory.CreateDirectory(directory);
                File.WriteAllBytes(fullPath, packed.EncodeToPNG());
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(packed);
            }

            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            TextureImporter importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer != null)
            {
                importer.textureType = TextureImporterType.Default;
                importer.sRGBTexture = false;
                importer.mipmapEnabled = parameters.Value<bool?>("mipmaps") ?? true;
                importer.isReadable = parameters.Value<bool?>("readable") ?? true;
                importer.SaveAndReimport();
            }

            return new JObject
            {
                ["path"] = path,
                ["metallic_path"] = metallicPath,
                ["roughness_path"] = roughnessPath,
                ["width"] = width,
                ["height"] = height,
                ["layout"] = "R=metallic,A=smoothness"
            };
        }

        /// <summary>
        /// HDRP-style mask map preset: R=Metallic, G=Occlusion(AO), B=Detail mask,
        /// A=Smoothness (from 1-roughness, or a direct smoothness map). Every channel is
        /// optional; missing channels default to metallic=0, occlusion=1 (no occlusion),
        /// detail=0, smoothness=0.5. Composed from the same readable-load/restore helpers
        /// as the metallic_smoothness preset.
        /// </summary>
        private JObject HandleChannelPackMaskMap(JObject parameters, string path)
        {
            string metallicPath = parameters.Value<string>("metallic_path")
                ?? parameters.Value<string>("metallicPath");
            string occlusionPath = parameters.Value<string>("occlusion_path")
                ?? parameters.Value<string>("occlusionPath")
                ?? parameters.Value<string>("ao_path")
                ?? parameters.Value<string>("aoPath");
            string detailPath = parameters.Value<string>("detail_path")
                ?? parameters.Value<string>("detailPath")
                ?? parameters.Value<string>("detail_mask_path")
                ?? parameters.Value<string>("detailMaskPath");
            string roughnessPath = parameters.Value<string>("roughness_path")
                ?? parameters.Value<string>("roughnessPath");
            string smoothnessPath = parameters.Value<string>("smoothness_path")
                ?? parameters.Value<string>("smoothnessPath");
            if (!string.IsNullOrEmpty(roughnessPath) && !string.IsNullOrEmpty(smoothnessPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Provide only one of 'roughness_path' or 'smoothness_path' for the mask_map preset.");

            if (string.IsNullOrEmpty(metallicPath) && string.IsNullOrEmpty(occlusionPath)
                && string.IsNullOrEmpty(detailPath) && string.IsNullOrEmpty(roughnessPath)
                && string.IsNullOrEmpty(smoothnessPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "mask_map preset requires at least one of 'metallic_path', 'occlusion_path', "
                    + "'detail_path', 'roughness_path', or 'smoothness_path'.");

            // Restore in finally: a dimension-mismatch throw mid-sequence must not leave
            // earlier sources permanently readable (their import settings are user assets).
            var restore = new List<KeyValuePair<TextureImporter, bool>>();
            Color[] metallicPixels, occlusionPixels, detailPixels, roughnessPixels, smoothnessPixels;
            int width = 0, height = 0;
            try
            {
                metallicPixels = SampleGrayscaleChannel(metallicPath, restore, ref width, ref height);
                occlusionPixels = SampleGrayscaleChannel(occlusionPath, restore, ref width, ref height);
                detailPixels = SampleGrayscaleChannel(detailPath, restore, ref width, ref height);
                roughnessPixels = SampleGrayscaleChannel(roughnessPath, restore, ref width, ref height);
                smoothnessPixels = SampleGrayscaleChannel(smoothnessPath, restore, ref width, ref height);
            }
            finally
            {
                foreach (var kv in restore)
                    RestoreReadableFlag(kv.Key, kv.Value);
            }

            if (width <= 0 || height <= 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "mask_map preset could not determine texture dimensions from any input.");

            Texture2D packed = new Texture2D(width, height, TextureFormat.RGBA32, false, true);
            Color[] pixels = new Color[width * height];
            for (int i = 0; i < pixels.Length; i++)
            {
                float m = metallicPixels != null ? metallicPixels[i].grayscale : 0f;
                float ao = occlusionPixels != null ? occlusionPixels[i].grayscale : 1f;
                float detail = detailPixels != null ? detailPixels[i].grayscale : 0f;
                float smoothness = smoothnessPixels != null
                    ? smoothnessPixels[i].grayscale
                    : (roughnessPixels != null ? 1f - roughnessPixels[i].grayscale : 0.5f);
                pixels[i] = new Color(m, ao, detail, smoothness);
            }
            packed.SetPixels(pixels);
            packed.Apply();

            try
            {
                string fullPath = GetFullPath(path);
                string directory = Path.GetDirectoryName(fullPath);
                if (!Directory.Exists(directory))
                    Directory.CreateDirectory(directory);
                File.WriteAllBytes(fullPath, packed.EncodeToPNG());
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(packed);
            }

            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            TextureImporter importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer != null)
            {
                importer.textureType = TextureImporterType.Default;
                importer.sRGBTexture = false;
                importer.mipmapEnabled = parameters.Value<bool?>("mipmaps") ?? true;
                importer.isReadable = parameters.Value<bool?>("readable") ?? true;
                importer.SaveAndReimport();
            }

            return new JObject
            {
                ["path"] = path,
                ["preset"] = "mask_map",
                ["metallic_path"] = metallicPath,
                ["occlusion_path"] = occlusionPath,
                ["detail_path"] = detailPath,
                ["roughness_path"] = roughnessPath,
                ["smoothness_path"] = smoothnessPath,
                ["width"] = width,
                ["height"] = height,
                ["layout"] = "R=metallic,G=occlusion,B=detail,A=smoothness"
            };
        }

        /// <summary>
        /// Loads a texture path readable, returns its pixels, and records the importer +
        /// prior readable flag for later restore. Establishes width/height on first use and
        /// enforces that every subsequent channel matches. Returns null for an empty path.
        /// </summary>
        private static Color[] SampleGrayscaleChannel(
            string texturePath,
            List<KeyValuePair<TextureImporter, bool>> restore,
            ref int width,
            ref int height)
        {
            if (string.IsNullOrEmpty(texturePath))
                return null;

            Texture2D texture = LoadReadableTexture(texturePath, out TextureImporter importer, out bool wasReadable);
            if (importer != null && !restore.Any(kv => kv.Key == importer))
                restore.Add(new KeyValuePair<TextureImporter, bool>(importer, wasReadable));

            if (width == 0 && height == 0)
            {
                width = texture.width;
                height = texture.height;
            }
            else if (texture.width != width || texture.height != height)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"mask_map channel '{texturePath}' is {texture.width}x{texture.height}, "
                    + $"but a prior channel established {width}x{height}. All channels must match.");
            }

            return texture.GetPixels();
        }

        private JObject HandleAssignSprite(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string spritePath = parameters.Value<string>("sprite_path");
            if (string.IsNullOrEmpty(spritePath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'sprite_path'");

            string spriteName = parameters.Value<string>("sprite_name");
            Sprite sprite = LoadSpriteAtPath(spritePath, spriteName);
            if (sprite == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    DiagnoseMissingSprite(spritePath, spriteName));

            GameObject go = LocatorResolver.Resolve(locator);

            // Try SpriteRenderer first, then UI Image
            SpriteRenderer sr = go.GetComponent<SpriteRenderer>();
            if (sr != null)
            {
                Undo.RecordObject(sr, $"Assign sprite to {go.name}");
                sr.sprite = sprite;
                Vector2 spriteSize = sprite.bounds.size;

                BoxCollider2D box = go.GetComponent<BoxCollider2D>();
                if (box != null && IsNearZero(box.size))
                {
                    Undo.RecordObject(box, $"Auto-fit BoxCollider2D for {go.name}");
                    box.size = spriteSize;
                    box.offset = sprite.bounds.center;
                }

                ShowWorkVisualizer.SelectObject(go);

                return new JObject
                {
                    ["assigned_to"] = "SpriteRenderer",
                    ["sprite_path"] = spritePath,
                    ["sprite_name"] = sprite.name,
                    ["locator"] = LocatorResolver.BuildLocator(go)
                };
            }

            UnityEngine.UI.Image image = go.GetComponent<UnityEngine.UI.Image>();
            if (image != null)
            {
                Undo.RecordObject(image, $"Assign sprite to {go.name}");
                image.sprite = sprite;
                ShowWorkVisualizer.SelectObject(go);
                return new JObject
                {
                    ["assigned_to"] = "Image",
                    ["sprite_path"] = spritePath,
                    ["sprite_name"] = sprite.name,
                    ["locator"] = LocatorResolver.BuildLocator(go)
                };
            }

            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"No SpriteRenderer or Image component found on '{go.name}'");
        }

        // ─────────────────────────────────────────────
        // Asset Picker (human-in-the-loop selection)
        //
        // Generic "choose options with thumbnails" surface. Pump-safe: ops only
        // read/write static window state and open/close the EditorWindow — they
        // never block the main thread and never open a native modal dialog.
        // The agent proposes (picker_open), the user confirms/cancels in the
        // window, and the agent polls picker_state for the outcome.
        // ─────────────────────────────────────────────

        private JObject HandlePickerOpen(JObject parameters)
        {
            if (parameters == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing picker proposal parameters.");

            LoombridgeAssetPicker.Open(parameters);

            return new JObject
            {
                ["opened"] = true
            };
        }

        private JObject HandlePickerState(JObject parameters)
        {
            var selection = new JObject();
            foreach (KeyValuePair<string, string> pair in LoombridgeAssetPicker.Selection)
                selection[pair.Key] = pair.Value;

            return new JObject
            {
                ["status"] = LoombridgeAssetPicker.Status,
                ["selection"] = selection
            };
        }

        private JObject HandlePickerClose(JObject parameters)
        {
            LoombridgeAssetPicker.ClosePicker();

            return new JObject
            {
                ["closed"] = true
            };
        }

        private JObject HandleBrowserOpen(JObject parameters)
        {
            if (parameters == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing asset browser payload parameters.");

            LoombridgeAssetBrowser.Open(parameters);

            return new JObject
            {
                ["opened"] = true
            };
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        private static FilterMode ParseFilterMode(string value)
        {
            if (value == "Point")
                return FilterMode.Point;
            if (value == "Bilinear")
                return FilterMode.Bilinear;
            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"Unsupported filter_mode '{value}'. Use 'Point' or 'Bilinear'.");
        }

        private static TextureImporterType ParseTextureImporterType(string value)
        {
            switch (value)
            {
                case "Default": return TextureImporterType.Default;
                case "NormalMap":
                case "Normal map":
                case "normal": return TextureImporterType.NormalMap;
                case "Sprite": return TextureImporterType.Sprite;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported texture_type '{value}'. Use Default, NormalMap, or Sprite.");
            }
        }

        private static TextureImporterAlphaSource ParseAlphaSource(string value)
        {
            switch (value)
            {
                case "None": return TextureImporterAlphaSource.None;
                case "Input":
                case "FromInput": return TextureImporterAlphaSource.FromInput;
                case "GrayScale":
                case "FromGrayScale": return TextureImporterAlphaSource.FromGrayScale;
                default:
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Unsupported alpha_source '{value}'. Use None, FromInput, or FromGrayScale.");
            }
        }

        private static Texture LoadTexture(string path)
        {
            Texture texture = AssetDatabase.LoadAssetAtPath<Texture>(path);
            if (texture == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Texture not found at path: '{path}'");
            return texture;
        }

        private static Texture2D LoadReadableTexture(
            string path,
            out TextureImporter importer,
            out bool wasReadable)
        {
            importer = AssetImporter.GetAtPath(path) as TextureImporter;
            wasReadable = true;
            if (importer != null && !importer.isReadable)
            {
                wasReadable = false;
                importer.isReadable = true;
                importer.SaveAndReimport();
            }

            Texture2D texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (texture == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Texture not found at path: '{path}'");
            return texture;
        }

        private static void RestoreReadableFlag(TextureImporter importer, bool wasReadable)
        {
            if (importer == null || wasReadable || !importer.isReadable)
                return;
            importer.isReadable = false;
            importer.SaveAndReimport();
        }

        private static void SetTextureIfPropertyExists(Material mat, string property, Texture texture)
        {
            if (mat.HasProperty(property))
                mat.SetTexture(property, texture);
        }

        private static void SetFloatIfPropertyExists(Material mat, string property, float value)
        {
            if (mat.HasProperty(property))
                mat.SetFloat(property, value);
        }

        private static void SetColorIfPropertyExists(Material mat, string property, Color value)
        {
            if (mat.HasProperty(property))
                mat.SetColor(property, value);
        }

        private static Color ParseColor(JObject obj, Color fallback)
        {
            if (obj == null)
                return fallback;
            return new Color(
                obj.Value<float?>("r") ?? fallback.r,
                obj.Value<float?>("g") ?? fallback.g,
                obj.Value<float?>("b") ?? fallback.b,
                obj.Value<float?>("a") ?? fallback.a);
        }

        private static JObject VectorToJson(Vector3 value)
        {
            return new JObject
            {
                ["x"] = value.x,
                ["y"] = value.y,
                ["z"] = value.z
            };
        }

        private static int GetSubmeshCount(Renderer renderer)
        {
            MeshFilter meshFilter = renderer.GetComponent<MeshFilter>();
            if (meshFilter != null && meshFilter.sharedMesh != null)
                return meshFilter.sharedMesh.subMeshCount;
            SkinnedMeshRenderer skinned = renderer as SkinnedMeshRenderer;
            if (skinned != null && skinned.sharedMesh != null)
                return skinned.sharedMesh.subMeshCount;
            return 0;
        }

        private static void ApplyPrefabVariantOverrides(GameObject instance, JObject overrides)
        {
            if (overrides == null)
                return;

            JObject localPosition = overrides.Value<JObject>("local_position")
                ?? overrides.Value<JObject>("localPosition")
                ?? overrides.Value<JObject>("position");
            if (localPosition != null)
            {
                instance.transform.localPosition = new Vector3(
                    localPosition.Value<float?>("x") ?? instance.transform.localPosition.x,
                    localPosition.Value<float?>("y") ?? instance.transform.localPosition.y,
                    localPosition.Value<float?>("z") ?? instance.transform.localPosition.z);
            }

            JObject rotation = overrides.Value<JObject>("local_rotation_euler")
                ?? overrides.Value<JObject>("localRotationEuler")
                ?? overrides.Value<JObject>("rotation_euler");
            if (rotation != null)
            {
                instance.transform.localEulerAngles = new Vector3(
                    rotation.Value<float?>("x") ?? instance.transform.localEulerAngles.x,
                    rotation.Value<float?>("y") ?? instance.transform.localEulerAngles.y,
                    rotation.Value<float?>("z") ?? instance.transform.localEulerAngles.z);
            }

            JObject localScale = overrides.Value<JObject>("local_scale")
                ?? overrides.Value<JObject>("localScale")
                ?? overrides.Value<JObject>("scale");
            if (localScale != null)
            {
                instance.transform.localScale = new Vector3(
                    localScale.Value<float?>("x") ?? instance.transform.localScale.x,
                    localScale.Value<float?>("y") ?? instance.transform.localScale.y,
                    localScale.Value<float?>("z") ?? instance.transform.localScale.z);
            }

            // Root-level component overrides. These target the first matching component
            // in the variant's hierarchy (GetComponentInChildren), matching the original
            // first-renderer material behavior. `overrides_by_path` (below) is the precise
            // form that addresses a specific child.
            JObject rootMesh = overrides.Value<JObject>("mesh_filter_mesh")
                ?? overrides.Value<JObject>("meshFilterMesh");
            if (rootMesh != null)
                ApplyMeshFilterMeshOverride(instance, rootMesh, true, instance.name);

            JArray rendererMaterials = overrides.Value<JArray>("renderer_materials")
                ?? overrides.Value<JArray>("rendererMaterials");
            if (rendererMaterials != null)
                ApplyRendererMaterialsOverride(instance, rendererMaterials, true, instance.name);

            JObject rootCollider = overrides.Value<JObject>("collider_size")
                ?? overrides.Value<JObject>("colliderSize");
            if (rootCollider != null)
                ApplyColliderSizeOverride(instance, rootCollider, true, instance.name);

            // Child-path targeted overrides: address specific children of the variant root
            // by their relative transform path. This is the precise form; an unknown child
            // path refuses with the available child paths (bounded).
            JObject byPath = overrides.Value<JObject>("overrides_by_path")
                ?? overrides.Value<JObject>("overridesByPath");
            if (byPath != null)
            {
                foreach (JProperty entry in byPath.Properties())
                {
                    string childPath = entry.Name;
                    Transform child = string.IsNullOrEmpty(childPath)
                        ? null
                        : instance.transform.Find(childPath);
                    if (child == null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"overrides_by_path: child path '{childPath}' not found under '{instance.name}'. "
                            + DescribeAvailableChildPaths(instance.transform));

                    JObject childOverrides = entry.Value as JObject;
                    if (childOverrides == null)
                        continue;

                    JObject childMesh = childOverrides.Value<JObject>("mesh_filter_mesh")
                        ?? childOverrides.Value<JObject>("meshFilterMesh");
                    if (childMesh != null)
                        ApplyMeshFilterMeshOverride(child.gameObject, childMesh, false, childPath);

                    JArray childMaterials = childOverrides.Value<JArray>("renderer_materials")
                        ?? childOverrides.Value<JArray>("rendererMaterials");
                    if (childMaterials != null)
                        ApplyRendererMaterialsOverride(child.gameObject, childMaterials, false, childPath);

                    JObject childCollider = childOverrides.Value<JObject>("collider_size")
                        ?? childOverrides.Value<JObject>("colliderSize");
                    if (childCollider != null)
                        ApplyColliderSizeOverride(child.gameObject, childCollider, false, childPath);
                }
            }
        }

        private static void ApplyRendererMaterialsOverride(
            GameObject target, JArray rendererMaterials, bool searchChildren, string label)
        {
            Renderer renderer = searchChildren
                ? target.GetComponentInChildren<Renderer>()
                : target.GetComponent<Renderer>();
            if (renderer == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"renderer_materials: Renderer not found on '{label}'");

            var materials = new Material[rendererMaterials.Count];
            for (int i = 0; i < rendererMaterials.Count; i++)
            {
                string materialPath = rendererMaterials[i].Value<string>();
                Material material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                if (material == null)
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Material not found at path: '{materialPath}'");
                materials[i] = material;
            }
            renderer.sharedMaterials = materials;
            EditorUtility.SetDirty(renderer);
        }

        private static void ApplyMeshFilterMeshOverride(
            GameObject target, JObject meshRef, bool searchChildren, string label)
        {
            MeshFilter meshFilter = searchChildren
                ? target.GetComponentInChildren<MeshFilter>()
                : target.GetComponent<MeshFilter>();
            if (meshFilter == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"mesh_filter_mesh: MeshFilter not found on '{label}'");

            string assetPath = meshRef.Value<string>("asset_path")
                ?? meshRef.Value<string>("assetPath");
            if (string.IsNullOrEmpty(assetPath))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "mesh_filter_mesh requires 'asset_path'.");
            string subAsset = meshRef.Value<string>("sub_asset")
                ?? meshRef.Value<string>("subAsset");

            // Resolve through the shared AssetReferenceResolver (same policy as animator
            // motion resolution): a typed scan that matches more than one Mesh with no
            // 'sub_asset' selector refuses (INVALID_PARAMS) listing the candidates.
            UnityEngine.Object resolved = AssetReferenceResolver.Load(
                assetPath, typeof(Mesh), subAsset, refuseAmbiguousTypedMatch: true);
            Mesh resolvedMesh = resolved as Mesh;
            if (resolvedMesh == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"mesh_filter_mesh: asset at '{assetPath}' resolved to "
                    + $"'{(resolved != null ? resolved.GetType().Name : "null")}', not a Mesh.");

            meshFilter.sharedMesh = resolvedMesh;
            EditorUtility.SetDirty(meshFilter);
        }

        private static void ApplyColliderSizeOverride(
            GameObject target, JObject spec, bool searchChildren, string label)
        {
            Collider collider = searchChildren
                ? target.GetComponentInChildren<Collider>()
                : target.GetComponent<Collider>();
            if (collider == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"collider_size: Collider not found on '{label}'");

            bool hasSize = spec.Property("size") != null;
            bool hasRadius = spec.Property("radius") != null;
            bool hasHeight = spec.Property("height") != null;
            JObject center = spec.Value<JObject>("center");

            if (collider is BoxCollider box)
            {
                if (hasRadius || hasHeight)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"collider_size fields 'radius'/'height' require a Sphere/Capsule collider, "
                        + $"but '{label}' has a BoxCollider (use 'size'/'center').");
                JObject size = spec.Value<JObject>("size");
                if (size != null)
                    box.size = ReadVector3(size, box.size);
                if (center != null)
                    box.center = ReadVector3(center, box.center);
                EditorUtility.SetDirty(box);
            }
            else if (collider is SphereCollider sphere)
            {
                if (hasSize || hasHeight)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"collider_size fields 'size'/'height' require a Box/Capsule collider, "
                        + $"but '{label}' has a SphereCollider (use 'radius'/'center').");
                if (hasRadius)
                    sphere.radius = spec.Value<float>("radius");
                if (center != null)
                    sphere.center = ReadVector3(center, sphere.center);
                EditorUtility.SetDirty(sphere);
            }
            else if (collider is CapsuleCollider capsule)
            {
                if (hasSize)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"collider_size field 'size' requires a BoxCollider, "
                        + $"but '{label}' has a CapsuleCollider (use 'radius'/'height'/'center').");
                if (hasRadius)
                    capsule.radius = spec.Value<float>("radius");
                if (hasHeight)
                    capsule.height = spec.Value<float>("height");
                if (center != null)
                    capsule.center = ReadVector3(center, capsule.center);
                EditorUtility.SetDirty(capsule);
            }
            else
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"collider_size supports Box/Sphere/Capsule colliders, "
                    + $"but '{label}' has a {collider.GetType().Name}.");
            }
        }

        private static Vector3 ReadVector3(JObject obj, Vector3 fallback)
        {
            return new Vector3(
                obj.Value<float?>("x") ?? fallback.x,
                obj.Value<float?>("y") ?? fallback.y,
                obj.Value<float?>("z") ?? fallback.z);
        }

        private static string DescribeAvailableChildPaths(Transform root)
        {
            const int maxPaths = 40;
            var paths = new List<string>();
            bool truncated = false;
            foreach (Transform t in root.GetComponentsInChildren<Transform>(true))
            {
                if (t == root)
                    continue;
                if (paths.Count >= maxPaths)
                {
                    truncated = true;
                    break;
                }
                paths.Add(RelativeTransformPath(root, t));
            }

            if (paths.Count == 0)
                return "The variant root has no children.";
            string joined = string.Join(", ", paths.Select(p => "'" + p + "'"));
            return $"Available child paths: {joined}" + (truncated ? ", …" : "") + ".";
        }

        private static string RelativeTransformPath(Transform root, Transform target)
        {
            var segments = new List<string>();
            Transform current = target;
            while (current != null && current != root)
            {
                segments.Add(current.name);
                current = current.parent;
            }
            segments.Reverse();
            return string.Join("/", segments);
        }

        private static void ValidateExpectedScene(JObject parameters, bool required)
        {
            string expected = parameters.Value<string>("expected_scene_path")
                ?? parameters.Value<string>("expectedScenePath");
            Scene activeScene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(expected))
            {
                if (required)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Missing required parameter: 'expected_scene_path' for scene-mutating prefab replacement.");
                return;
            }

            string actual = activeScene.path ?? "";
            if (!string.Equals(NormalizeScenePath(actual), NormalizeScenePath(expected), StringComparison.Ordinal))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Active scene mismatch. Expected '{expected}', active scene is '{actual}'.");
            }

            bool allowDirty = parameters.Value<bool?>("allow_dirty_scene")
                ?? parameters.Value<bool?>("allowDirtyScene")
                ?? false;
            if (activeScene.isDirty && !allowDirty)
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Active scene '{actual}' has unsaved changes. Pass allow_dirty_scene:true or save before mutating.");
            }
        }

        private static string NormalizeScenePath(string path)
        {
            return (path ?? "").Replace("\\", "/").TrimEnd('/');
        }

        // Never destroy an already-sliced sheet: forcing Single on a Multiple-mode
        // texture that HAS sprite sub-assets would silently wipe its slices. The
        // default-to-Single guard exists only for the unsliced-Multiple failure mode
        // (zero usable sprites), so a sliced sheet is left untouched.
        private static bool HasSlicedSprites(TextureImporter importer, string path)
        {
            return importer.spriteImportMode == SpriteImportMode.Multiple
                && AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().Any();
        }

        // Turns the bare "Sprite not found" miss into an actionable diagnosis. The
        // dominant real-world cause is an import-settings problem, not a wrong path:
        // a texture that isn't Sprite type, or one left Sprite Mode Multiple but never
        // sliced (zero sub-sprites). Name the exact cause and the fix op.
        private static string DiagnoseMissingSprite(string spritePath, string spriteName)
        {
            string named = string.IsNullOrEmpty(spriteName) ? "" : $" (named '{spriteName}')";

            TextureImporter importer = AssetImporter.GetAtPath(spritePath) as TextureImporter;
            if (importer == null)
            {
                if (AssetDatabase.LoadMainAssetAtPath(spritePath) == null)
                    return $"Sprite not found at: '{spritePath}'{named} — no asset exists at this path. Check the path.";
                return $"Sprite not found at: '{spritePath}'{named} — the asset at this path is not a texture, so it has no sprites.";
            }

            if (importer.textureType != TextureImporterType.Sprite)
                return $"Sprite not found at: '{spritePath}'{named} — the texture's Texture Type is '{importer.textureType}', not Sprite. "
                    + "Set it to Sprite first (asset.set_texture_import_settings texture_type:\"Sprite\").";

            Sprite[] subSprites = AssetDatabase.LoadAllAssetsAtPath(spritePath).OfType<Sprite>().ToArray();
            if (importer.spriteImportMode == SpriteImportMode.Multiple && subSprites.Length == 0)
                return $"Sprite not found at: '{spritePath}'{named} — the texture is Sprite Mode 'Multiple' but has ZERO sprite sub-assets (it was never sliced). "
                    + "Either slice it (asset.create_sprite with sprite_mode:\"multiple\" + slicing) or make it a single sprite "
                    + "(asset.set_texture_import_settings sprite_mode:\"single\").";

            if (!string.IsNullOrEmpty(spriteName) && subSprites.Length > 0)
            {
                string available = string.Join(", ", subSprites.Select(s => s.name));
                return $"Sprite '{spriteName}' not found at: '{spritePath}' — available sprites: [{available}].";
            }

            return string.IsNullOrEmpty(spriteName)
                ? $"Sprite not found at: '{spritePath}'"
                : $"Sprite '{spriteName}' not found at: '{spritePath}'";
        }

        private static Sprite LoadSpriteAtPath(string spritePath, string spriteName)
        {
            if (string.IsNullOrEmpty(spriteName))
            {
                Sprite direct = AssetDatabase.LoadAssetAtPath<Sprite>(spritePath);
                if (direct != null)
                    return direct;
            }

            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(spritePath);
            foreach (UnityEngine.Object asset in assets)
            {
                Sprite sprite = asset as Sprite;
                if (sprite == null)
                    continue;
                if (string.IsNullOrEmpty(spriteName) || sprite.name == spriteName)
                    return sprite;
            }

            return null;
        }

        private static SpriteRect[] BuildSpriteRects(JObject slicing, int textureWidth, int textureHeight)
        {
            if (slicing == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter for multiple sprite import: 'slicing'");

            JArray sprites = slicing.Value<JArray>("sprites");
            if (sprites == null || sprites.Count == 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Sprite slicing requires a non-empty 'sprites' array.");

            string mode = slicing.Value<string>("mode");
            if (mode == "grid")
                return BuildGridSpriteRects(slicing, sprites, textureWidth, textureHeight);
            if (mode == "rects")
                return BuildExplicitSpriteRects(slicing, sprites, textureHeight);

            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                $"Unsupported sprite slicing mode: '{mode}'");
        }

        private static SpriteRect[] BuildGridSpriteRects(JObject slicing, JArray sprites, int textureWidth, int textureHeight)
        {
            JObject cell = slicing.Value<JObject>("cell");
            if (cell == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Grid sprite slicing requires 'cell'.");

            int cellWidth = cell.Value<int?>("width") ?? 0;
            int cellHeight = cell.Value<int?>("height") ?? 0;
            if (cellWidth <= 0 || cellHeight <= 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Grid sprite slicing cell width and height must be positive.");

            JObject offset = slicing.Value<JObject>("offset");
            JObject spacing = slicing.Value<JObject>("spacing");
            int offsetX = offset?.Value<int?>("x") ?? 0;
            int offsetY = offset?.Value<int?>("y") ?? 0;
            int spacingX = spacing?.Value<int?>("x") ?? 0;
            int spacingY = spacing?.Value<int?>("y") ?? 0;
            Vector2 defaultPivot = ParsePivot(slicing["pivot"]);
            var rects = new List<SpriteRect>();

            foreach (JObject sprite in sprites.OfType<JObject>())
            {
                string name = sprite.Value<string>("name");
                int column = sprite.Value<int?>("column") ?? -1;
                int row = sprite.Value<int?>("row") ?? -1;
                int x = offsetX + column * (cellWidth + spacingX);
                int topY = offsetY + row * (cellHeight + spacingY);
                int y = textureHeight - topY - cellHeight;
                if (string.IsNullOrEmpty(name) || column < 0 || row < 0 || x < 0 || y < 0 || x + cellWidth > textureWidth)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Grid sprite slice '{name}' is outside texture bounds.");

                rects.Add(new SpriteRect
                {
                    name = name,
                    spriteID = GUID.Generate(),
                    rect = new Rect(x, y, cellWidth, cellHeight),
                    alignment = SpriteAlignment.Custom,
                    pivot = ParsePivot(sprite["pivot"], defaultPivot)
                });
            }

            return rects.ToArray();
        }

        private static SpriteRect[] BuildExplicitSpriteRects(JObject slicing, JArray sprites, int textureHeight)
        {
            Vector2 defaultPivot = ParsePivot(slicing["pivot"]);
            var rects = new List<SpriteRect>();

            foreach (JObject sprite in sprites.OfType<JObject>())
            {
                string name = sprite.Value<string>("name");
                JObject rect = sprite.Value<JObject>("rect");
                if (string.IsNullOrEmpty(name) || rect == null)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        "Each explicit sprite slice requires 'name' and 'rect'.");

                float x = rect.Value<float?>("x") ?? -1f;
                float topY = rect.Value<float?>("y") ?? -1f;
                float width = rect.Value<float?>("width") ?? 0f;
                float height = rect.Value<float?>("height") ?? 0f;
                if (x < 0f || topY < 0f || width <= 0f || height <= 0f)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Explicit sprite slice '{name}' has invalid rect values.");

                rects.Add(new SpriteRect
                {
                    name = name,
                    spriteID = GUID.Generate(),
                    rect = new Rect(x, textureHeight - topY - height, width, height),
                    alignment = SpriteAlignment.Custom,
                    pivot = ParsePivot(sprite["pivot"], defaultPivot)
                });
            }

            return rects.ToArray();
        }

        private static Vector2 ParsePivot(JToken token)
        {
            return ParsePivot(token, new Vector2(0.5f, 0.5f));
        }

        private static Vector2 ParsePivot(JToken token, Vector2 fallback)
        {
            if (token == null || token.Type == JTokenType.Null)
                return fallback;

            JObject obj = token as JObject;
            if (obj != null)
                return new Vector2(
                    Mathf.Clamp01(obj.Value<float?>("x") ?? fallback.x),
                    Mathf.Clamp01(obj.Value<float?>("y") ?? fallback.y));

            switch (token.Value<string>())
            {
                case "bottom": return new Vector2(0.5f, 0f);
                case "top": return new Vector2(0.5f, 1f);
                case "left": return new Vector2(0f, 0.5f);
                case "right": return new Vector2(1f, 0.5f);
                case "bottomLeft": return new Vector2(0f, 0f);
                case "bottomRight": return new Vector2(1f, 0f);
                case "topLeft": return new Vector2(0f, 1f);
                case "topRight": return new Vector2(1f, 1f);
                default: return new Vector2(0.5f, 0.5f);
            }
        }

        private static void ApplySpriteRects(TextureImporter importer, SpriteRect[] spriteRects)
        {
            if (spriteRects.Length == 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Multiple sprite import requires at least one sprite slice.");

            var factory = new SpriteDataProviderFactories();
            factory.Init();
            ISpriteEditorDataProvider dataProvider = factory.GetSpriteEditorDataProviderFromObject(importer);
            if (dataProvider == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Unity Sprite Editor data provider is unavailable. Ensure the 2D Sprite package is installed.");

            dataProvider.InitSpriteEditorDataProvider();
            dataProvider.SetSpriteRects(spriteRects);
            ISpriteNameFileIdDataProvider nameProvider = dataProvider.GetDataProvider<ISpriteNameFileIdDataProvider>();
            if (nameProvider != null)
            {
                nameProvider.SetNameFileIdPairs(spriteRects.Select(rect =>
                    new SpriteNameFileIdPair(rect.name, rect.spriteID)));
            }
            dataProvider.Apply();
        }

        private static void ValidateAssetPath(string path)
        {
            if (!path.StartsWith("Assets/") && !path.StartsWith("Assets\\"))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Path must be under 'Assets/': '{path}'");
            }

            string normalized = Path.GetFullPath(Path.Combine(Application.dataPath, "..", path));
            string assetsDir = Path.GetFullPath(Application.dataPath) + Path.DirectorySeparatorChar;
            if (!normalized.StartsWith(assetsDir))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Path escapes Assets directory: '{path}'");
            }
        }

        private static string GetFullPath(string assetPath)
        {
            return Path.Combine(Application.dataPath, "..", assetPath);
        }

        private static bool IsNearZero(Vector2 value)
        {
            return value.x <= 0.001f && value.y <= 0.001f;
        }

        private static void ValidateSpriteFileExtension(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg")
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unsupported sprite file extension '{ext}'. Use .png, .jpg, or .jpeg");
            }
        }

        private static byte[] TryLoadExternalImageBytes(string sourcePath, string sourceUrl)
        {
            if (!string.IsNullOrEmpty(sourcePath))
            {
                string resolvedPath = Path.GetFullPath(sourcePath);
                ValidateSpriteFileExtension(resolvedPath);

                if (!File.Exists(resolvedPath))
                {
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"External source file not found: '{sourcePath}'");
                }

                return File.ReadAllBytes(resolvedPath);
            }

            if (!string.IsNullOrEmpty(sourceUrl))
            {
                if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out Uri uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                {
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Invalid source_url. Must be absolute http/https URL: '{sourceUrl}'");
                }

                ValidateSpriteFileExtension(uri.AbsolutePath);

                try
                {
                    using (var client = new WebClient())
                    {
                        return client.DownloadData(uri);
                    }
                }
                catch (Exception ex)
                {
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Failed to download source_url: {ex.Message}");
                }
            }

            return null;
        }
    }
}
