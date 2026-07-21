#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using TMPro;

/// <summary>
/// Editor-only one-shot builder that generates a TextMeshPro SDF font asset from the
/// imported Press Start 2P TTF (Assets/Fonts/PressStart2P-Regular.ttf) and writes it to
/// Assets/Fonts/PressStart2P SDF.asset. Runs once on domain reload if the asset is missing
/// (idempotent), so a headless refresh/recompile produces the asset without a manual menu click.
/// Also exposed as a menu item for manual rebuilds.
/// </summary>
public static class PressStart2PFontBuilder
{
    private const string TtfPath = "Assets/Fonts/PressStart2P-Regular.ttf";
    private const string OutPath = "Assets/Fonts/PressStart2P SDF.asset";

    // Runs synchronously on the main thread after every script reload (the editor being
    // backgrounded throttles delayCall, but this fires during reload). Idempotent.
    [UnityEditor.Callbacks.DidReloadScripts]
    private static void OnScriptsReloaded()
    {
        Debug.Log("[PressStart2PFontBuilder] DidReloadScripts fired; checking SDF asset.");
        BuildIfMissing();
    }

    [MenuItem("Loomtide/Build Press Start 2P TMP Font")]
    public static void BuildMenu() => Build(force: true);

    private static void BuildIfMissing()
    {
        if (AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(OutPath) != null)
        {
            Debug.Log("[PressStart2PFontBuilder] SDF asset already present at " + OutPath);
            return;
        }
        Build(force: false);
    }

    private static void Build(bool force)
    {
        if (!force && AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(OutPath) != null) return;

        Font source = AssetDatabase.LoadAssetAtPath<Font>(TtfPath);
        if (source == null)
        {
            Debug.LogWarning("[PressStart2PFontBuilder] Source TTF not found at " + TtfPath);
            return;
        }

        // Dynamic SDF font asset: 1024 atlas, sampling 90, padding 9, raster bevel/SDFAA.
        TMP_FontAsset fontAsset = TMP_FontAsset.CreateFontAsset(
            source,
            samplingPointSize: 90,
            atlasPadding: 9,
            renderMode: UnityEngine.TextCore.LowLevel.GlyphRenderMode.SDFAA,
            atlasWidth: 1024,
            atlasHeight: 1024,
            atlasPopulationMode: AtlasPopulationMode.Dynamic,
            enableMultiAtlasSupport: true);

        if (fontAsset == null)
        {
            Debug.LogError("[PressStart2PFontBuilder] CreateFontAsset returned null.");
            return;
        }

        fontAsset.name = "PressStart2P SDF";

        AssetDatabase.CreateAsset(fontAsset, OutPath);

        // Persist the atlas texture(s) and material as sub-assets so the .asset is self-contained.
        if (fontAsset.atlasTextures != null)
        {
            foreach (var tex in fontAsset.atlasTextures)
            {
                if (tex != null && !AssetDatabase.Contains(tex))
                {
                    tex.name = "PressStart2P Atlas";
                    AssetDatabase.AddObjectToAsset(tex, fontAsset);
                }
            }
        }
        if (fontAsset.material != null && !AssetDatabase.Contains(fontAsset.material))
        {
            fontAsset.material.name = "PressStart2P SDF Material";
            AssetDatabase.AddObjectToAsset(fontAsset.material, fontAsset);
        }

        EditorUtility.SetDirty(fontAsset);
        AssetDatabase.SaveAssets();
        AssetDatabase.ImportAsset(OutPath);
        Debug.Log("[PressStart2PFontBuilder] Created TMP font asset at " + OutPath);
    }
}
#endif
