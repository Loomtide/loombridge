using System.IO;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Show Work hook for filesystem-authored assets. Agents author most scripts on the
    /// filesystem and then call <c>editor.refresh_assets</c>, which imports them through
    /// the AssetDatabase rather than a bridge op — so the per-op Show Work select/ping
    /// hooks never fire and the newly-imported script/sprite is never highlighted in the
    /// Project window. This post-processor closes that gap: when Show Work is enabled it
    /// selects + pings the most relevant newly-IMPORTED asset(s) so the Project + Inspector
    /// visibly follow the import on a recording.
    ///
    /// Editor-only (lives under an Editor asmdef). No-op when Show Work is disabled or
    /// during play-mode churn, and only reacts to "interesting" imports (scripts, sprites/
    /// textures, prefabs, materials, scenes) so an unrelated reimport storm doesn't ping.
    /// </summary>
    public class ShowWorkAssetPostprocessor : AssetPostprocessor
    {
        // Extensions worth pinging. Scripts and sprites are the primary case (per the live
        // gap report); prefabs/materials/scenes round out the assets agents commonly author.
        private static readonly string[] InterestingExtensions =
        {
            ".cs",
            ".png", ".jpg", ".jpeg", ".tga", ".psd", ".gif",
            ".prefab",
            ".mat",
            ".unity",
            ".asset",
            ".anim", ".controller"
        };

        private static void OnPostprocessAllAssets(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths)
        {
            // Cheap early-outs first so the disabled/common path costs almost nothing.
            if (!ShowWorkVisualizer.Enabled)
                return;

            // Avoid play-mode churn: imports triggered while entering/in play mode (or while
            // recompiling) are noise, not agent authoring, and re-selecting then would fight
            // the user's runtime focus.
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling)
                return;

            if (importedAssets == null || importedAssets.Length == 0)
                return;

            // Prefer the last imported "interesting" asset (most-recently-authored wins).
            // Walk from the end so the freshest import is what the camera lands on.
            string target = null;
            for (int i = importedAssets.Length - 1; i >= 0; i--)
            {
                string path = importedAssets[i];
                if (IsInteresting(path))
                {
                    target = path;
                    break;
                }
            }

            if (string.IsNullOrEmpty(target))
                return;

            // Selecting/pinging mid-import-callback can be fragile (the AssetDatabase is
            // still settling). Defer one tick so the asset is fully imported and the
            // Project/Inspector windows are ready to follow.
            string deferred = target;
            EditorApplication.delayCall += () =>
            {
                // Re-check: Show Work may have been toggled off, or play mode entered,
                // during the delay.
                if (!ShowWorkVisualizer.Enabled)
                    return;
                if (EditorApplication.isPlayingOrWillChangePlaymode)
                    return;

                ShowWorkVisualizer.SelectAsset(deferred);
            };
        }

        private static bool IsInteresting(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath))
                return false;

            // Only project assets (skip Packages/ churn and bridge-internal traces).
            if (!assetPath.StartsWith("Assets/", System.StringComparison.Ordinal))
                return false;

            string ext = Path.GetExtension(assetPath);
            if (string.IsNullOrEmpty(ext))
                return false;

            foreach (string candidate in InterestingExtensions)
            {
                if (ext.Equals(candidate, System.StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            return false;
        }
    }
}
