#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

/// <summary>
/// One-shot editor helper that conforms the generated parallax-backdrop PNGs
/// (Assets/Art/Background/bg-*.png) to crisp tiling sprites: Sprite type, Point filter,
/// Repeat wrap (so the sky/stars/hills can tile), PPU 100, no compression. Runs on script
/// reload and is idempotent (skips textures already conformed). Also exposed as a menu item.
/// </summary>
public static class BackgroundTextureImporter
{
    private static readonly string[] Paths =
    {
        "Assets/Art/Background/bg-stars.png",
        "Assets/Art/Background/bg-hills.png",
        "Assets/Art/Background/bg-glow.png",
    };

    [UnityEditor.Callbacks.DidReloadScripts]
    private static void OnScriptsReloaded() => ConformAll(force: false);

    [MenuItem("Loomtide/Conform Background Textures")]
    public static void ConformMenu() => ConformAll(force: true);

    private static void ConformAll(bool force)
    {
        foreach (var path in Paths)
        {
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) continue;

            bool needsChange = force
                || importer.textureType != TextureImporterType.Sprite
                || importer.filterMode != FilterMode.Point
                || importer.wrapMode != TextureWrapMode.Repeat;
            if (!needsChange) continue;

            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = 100;
            importer.filterMode = FilterMode.Point;
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.mipmapEnabled = false;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.alphaIsTransparency = true;

            EditorUtility.SetDirty(importer);
            importer.SaveAndReimport();
            Debug.Log("[BackgroundTextureImporter] Conformed " + path);
        }
    }
}
#endif
