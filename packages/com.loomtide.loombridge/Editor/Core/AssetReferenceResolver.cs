using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Shared resolution of an asset reference from a path plus an optional named
    /// sub-asset. Extracted from ComponentHandler so any handler that binds an
    /// object reference (component property values, animator state motions, …)
    /// resolves sub-assets identically — a sliced Sprite out of a sheet's Texture2D,
    /// or an AnimationClip sub-asset of an imported FBX/GLB — via
    /// LoadAllAssetsAtPath. Using the AssetDatabase-typed reference (rather than a
    /// hand-authored YAML fileID) is what makes native <c>.anim</c> (motion ref
    /// <c>type: 2</c>) and imported FBX/GLB clip sub-assets (<c>type: 3</c>) both
    /// bind correctly without the caller caring which it is.
    /// </summary>
    public static class AssetReferenceResolver
    {
        /// <summary>
        /// Loads the asset at <paramref name="assetPath"/>. When
        /// <paramref name="subAsset"/> is provided, or <paramref name="expectedType"/>
        /// is a concrete type that may live as a sub-asset (e.g. Sprite, AnimationClip
        /// of an imported model), scans every asset at the path and returns the first
        /// candidate assignable to <paramref name="expectedType"/> (and name-matching
        /// <paramref name="subAsset"/> when given). Throws <see cref="BridgeException"/>
        /// (NOT_FOUND) when the path or the named sub-asset is missing.
        ///
        /// When <paramref name="refuseAmbiguousTypedMatch"/> is true and NO sub-asset name
        /// was given, a typed scan that matches MORE THAN ONE candidate refuses
        /// (INVALID_PARAMS) listing the candidate names instead of silently binding the
        /// first — e.g. an imported FBX with several takes, or a .controller containing
        /// several BlendTrees, must be disambiguated with an explicit sub_asset.
        /// </summary>
        public static UnityEngine.Object Load(string assetPath, Type expectedType, string subAsset,
            bool refuseAmbiguousTypedMatch = false)
        {
            if (string.IsNullOrEmpty(assetPath))
                return null;

            // A named sub-asset, or a concrete expected type (e.g. Sprite, AnimationClip)
            // that may live as a sub-asset of the main asset, requires scanning all assets
            // at the path. A sliced sheet's main asset is its Texture2D; an imported FBX's
            // main asset is its root GameObject — the individual Sprites/AnimationClips are
            // sub-assets. LoadAssetAtPath<Object> would return the main asset and fail the
            // typed assignability check.
            bool wantsTyped = expectedType != null && expectedType != typeof(UnityEngine.Object);
            if (!string.IsNullOrEmpty(subAsset) || wantsTyped)
            {
                UnityEngine.Object[] all = AssetDatabase.LoadAllAssetsAtPath(assetPath);
                if (all != null)
                {
                    UnityEngine.Object firstMatch = null;
                    List<string> matchNames = null;
                    foreach (UnityEngine.Object candidate in all)
                    {
                        if (candidate == null)
                            continue;
                        if (wantsTyped && !expectedType.IsAssignableFrom(candidate.GetType()))
                            continue;
                        if (!string.IsNullOrEmpty(subAsset) && candidate.name != subAsset)
                            continue;
                        if (!refuseAmbiguousTypedMatch || !string.IsNullOrEmpty(subAsset))
                            return candidate;
                        if (firstMatch == null)
                        {
                            firstMatch = candidate;
                            matchNames = new List<string>();
                        }
                        matchNames.Add(candidate.name);
                    }
                    if (firstMatch != null)
                    {
                        if (matchNames.Count > 1)
                            throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                                $"Ambiguous reference: '{assetPath}' contains {matchNames.Count} " +
                                $"'{expectedType.Name}'-assignable sub-assets ({string.Join(", ", matchNames)}). " +
                                "Specify 'sub_asset' to select one.");
                        return firstMatch;
                    }
                }

                if (!string.IsNullOrEmpty(subAsset))
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Sub-asset '{subAsset}'" +
                        (wantsTyped ? $" of type '{expectedType.Name}'" : "") +
                        $" not found at path: '{assetPath}'");
                // No sub-asset name given and no typed match — fall through to the main
                // asset so the caller's assignability check produces a clear type error.
            }

            UnityEngine.Object obj = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);
            if (obj == null)
            {
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Asset not found at path: '{assetPath}'");
            }

            return obj;
        }

        /// <summary>
        /// Same as <see cref="Load"/> but, on a NOT_FOUND miss, refreshes the
        /// AssetDatabase once and retries. This covers the case the art-integration
        /// dogfood hit: an imported FBX/GLB whose avatar/clip sub-assets are not yet
        /// materialized (Meshy FBX defaults <c>avatarSetup: 0</c>, so no clip
        /// sub-assets exist until the importer is configured/re-imported). On a second
        /// miss it rethrows a distinguishable NOT_FOUND noting the asset may not be
        /// imported yet, so the caller can tell "wrong path/name" apart from
        /// "not imported yet".
        /// </summary>
        public static UnityEngine.Object LoadWithRefreshRetry(string assetPath, Type expectedType, string subAsset,
            bool refuseAmbiguousTypedMatch = false)
        {
            try
            {
                return Load(assetPath, expectedType, subAsset, refuseAmbiguousTypedMatch);
            }
            catch (BridgeException ex) when (ex.Code == ErrorCodes.NOT_FOUND)
            {
                // Bounded to exactly one refresh-and-retry. An INVALID_PARAMS ambiguity
                // refusal is deliberately NOT retried — refreshing can't disambiguate.
                AssetDatabase.Refresh();
                try
                {
                    return Load(assetPath, expectedType, subAsset, refuseAmbiguousTypedMatch);
                }
                catch (BridgeException retryEx) when (retryEx.Code == ErrorCodes.NOT_FOUND)
                {
                    string subDesc = string.IsNullOrEmpty(subAsset) ? "" : $" sub-asset '{subAsset}'";
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Could not resolve{subDesc} at path '{assetPath}' after an AssetDatabase refresh. " +
                        "The asset may not be imported yet — for an imported FBX/GLB the avatar/clip " +
                        "sub-assets require the ModelImporter to be configured (e.g. avatarSetup) and the " +
                        "asset re-imported before its clips exist.");
                }
            }
        }
    }
}
