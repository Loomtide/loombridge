using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Sets the Unity Game View render resolution to a fixed {width, height} so that a
    /// "Scale With Screen Size" uGUI CanvasScaler genuinely RE-LAYS-OUT at that aspect.
    ///
    /// Mechanism: the Game View's resolution is driven by the internal
    /// UnityEditor.GameViewSizes singleton (a per-group list of GameViewSize entries) and the
    /// active GameView window's selectedSizeIndex. Unity exposes no public API for either, so we
    /// reflect into both: add (or reuse) a FixedResolution GameViewSize of the requested w/h in
    /// the current group, then point the active GameView at it. Once selected, Unity resizes the
    /// real game render target — Screen.width/height change, every Canvas re-runs layout, and the
    /// existing screenshot / get_screen_rects paths (which read Handles.GetMainGameViewSize())
    /// observe the new size with no change.
    ///
    /// Reflection target shape (stable across 2022.3 .. 6000.3 LTS):
    ///   UnityEditor.GameViewSizes (singleton via ScriptableSingleton)
    ///     .currentGroup : UnityEditor.GameViewSizeGroup
    ///       .GetTotalCount() / .GetGameViewSize(int) / .AddCustomSize(GameViewSize) / .IndexOf(...)
    ///   UnityEditor.GameViewSize(GameViewSizeType type, int width, int height, string baseText)
    ///   UnityEditor.GameView.SizeSelectionCallback(int index, object obj)  // selects + repaints
    /// </summary>
    public static class GameViewSizing
    {
        private const int MinDimension = 16;
        private const int MaxDimension = 8192;

        private static readonly Type GameViewType =
            Type.GetType("UnityEditor.GameView, UnityEditor");

        /// <summary>
        /// Result of a size-set attempt. Ok==false carries a human-readable Error (no throw).
        /// </summary>
        public struct SetResult
        {
            public bool Ok;
            public string Error;
            public int Width;
            public int Height;
            public int PreviousWidth;
            public int PreviousHeight;
        }

        /// <summary>
        /// Sets the main Game View to a fixed width x height. Returns SetResult; never throws for
        /// expected failures (no GameView, reflection shape changed) — those return Ok=false so the
        /// editor is never left in a broken state by an unhandled exception.
        /// </summary>
        public static SetResult SetSize(int width, int height)
        {
            var result = new SetResult { Ok = false };

            // Record the prior size up front so the caller can restore it. Handles.GetMainGameViewSize
            // is the same source screenshot / get_screen_rects read, so previous*/current* are
            // directly comparable to what those ops report.
            Vector2 prior = Handles.GetMainGameViewSize();
            result.PreviousWidth = Mathf.RoundToInt(prior.x);
            result.PreviousHeight = Mathf.RoundToInt(prior.y);

            // Clamp absurd inputs rather than handing Unity a degenerate render target.
            width = Mathf.Clamp(width, MinDimension, MaxDimension);
            height = Mathf.Clamp(height, MinDimension, MaxDimension);
            result.Width = width;
            result.Height = height;

            if (GameViewType == null)
            {
                result.Error = "UnityEditor.GameView type not found (no editor GUI?).";
                return result;
            }

            try
            {
                EditorWindow gameView = GetActiveGameView();
                if (gameView == null)
                {
                    result.Error = "No active Game View window to resize.";
                    return result;
                }

                object currentGroup = GetCurrentGroup();
                if (currentGroup == null)
                {
                    result.Error = "Could not access GameViewSizes.currentGroup via reflection.";
                    return result;
                }

                int index = FindOrAddFixedSize(currentGroup, width, height);
                if (index < 0)
                {
                    result.Error = $"Failed to add/find a {width}x{height} Game View size.";
                    return result;
                }

                if (!SelectSize(gameView, index))
                {
                    result.Error = "Failed to select the Game View size (SizeSelectionCallback missing).";
                    return result;
                }

                // Force a synchronous relayout so the new aspect is observable on the very next op:
                // resizing the render target alone does not immediately re-run CanvasScaler.
                Canvas.ForceUpdateCanvases();
                gameView.Repaint();

                result.Ok = true;
                return result;
            }
            catch (Exception ex)
            {
                // Defensive: any reflection mismatch returns an error result, never a throw that
                // would surface as INTERNAL_ERROR or leave the view half-changed.
                result.Error = $"GameView resize failed: {ex.GetType().Name}: {ex.Message}";
                return result;
            }
        }

        private static EditorWindow GetActiveGameView()
        {
            // Reuse an already-open Game View if present; only create one if the project has none.
            UnityEngine.Object[] open = Resources.FindObjectsOfTypeAll(GameViewType);
            if (open != null && open.Length > 0)
                return open[0] as EditorWindow;

            return EditorWindow.GetWindow(GameViewType, false, "Game", false);
        }

        private static object GetCurrentGroup()
        {
            Type sizesType = Type.GetType("UnityEditor.GameViewSizes, UnityEditor");
            if (sizesType == null)
                return null;

            // GameViewSizes is a ScriptableSingleton<GameViewSizes>; the instance lives on the base.
            Type singletonType = typeof(ScriptableSingleton<>).MakeGenericType(sizesType);
            PropertyInfo instanceProp = singletonType.GetProperty(
                "instance", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            object sizesInstance = instanceProp?.GetValue(null);
            if (sizesInstance == null)
                return null;

            PropertyInfo currentGroupProp = sizesType.GetProperty(
                "currentGroup", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return currentGroupProp?.GetValue(sizesInstance);
        }

        /// <summary>
        /// Returns the index (within the current group) of a FixedResolution size matching w/h,
        /// reusing an existing match to avoid an unbounded list of duplicate custom sizes across
        /// repeated calls. Returns -1 on reflection failure.
        /// </summary>
        private static int FindOrAddFixedSize(object group, int width, int height)
        {
            Type groupType = group.GetType();
            MethodInfo getTotalCount = groupType.GetMethod("GetTotalCount");
            MethodInfo getGameViewSize = groupType.GetMethod("GetGameViewSize");
            if (getTotalCount == null || getGameViewSize == null)
                return -1;

            int total = (int)getTotalCount.Invoke(group, null);
            for (int i = 0; i < total; i++)
            {
                object size = getGameViewSize.Invoke(group, new object[] { i });
                if (size == null)
                    continue;
                if (SizeMatchesFixed(size, width, height))
                    return i;
            }

            // No reusable match — add a fresh FixedResolution custom size.
            object newSize = BuildFixedSize(width, height);
            if (newSize == null)
                return -1;

            MethodInfo addCustomSize = groupType.GetMethod("AddCustomSize");
            if (addCustomSize == null)
                return -1;
            addCustomSize.Invoke(group, new object[] { newSize });

            // The just-added size is last in the list.
            int newTotal = (int)getTotalCount.Invoke(group, null);
            return newTotal - 1;
        }

        private static bool SizeMatchesFixed(object size, int width, int height)
        {
            Type sizeType = size.GetType();
            // FixedResolution sizes have a concrete width/height (not aspect-ratio based).
            PropertyInfo wProp = sizeType.GetProperty("width");
            PropertyInfo hProp = sizeType.GetProperty("height");
            PropertyInfo typeProp = sizeType.GetProperty("sizeType");
            if (wProp == null || hProp == null || typeProp == null)
                return false;

            int w = (int)wProp.GetValue(size);
            int h = (int)hProp.GetValue(size);
            string sizeType_ = typeProp.GetValue(size)?.ToString() ?? string.Empty;
            return w == width && h == height && sizeType_ == "FixedResolution";
        }

        private static object BuildFixedSize(int width, int height)
        {
            Type sizeType = Type.GetType("UnityEditor.GameViewSize, UnityEditor");
            Type sizeTypeEnum = Type.GetType("UnityEditor.GameViewSizeType, UnityEditor");
            if (sizeType == null || sizeTypeEnum == null)
                return null;

            object fixedResolution = Enum.Parse(sizeTypeEnum, "FixedResolution");
            string label = $"Loomtide {width}x{height}";

            // Newer Unity ctor: (GameViewSizeType, int width, int height, string baseText)
            ConstructorInfo ctor = sizeType.GetConstructor(
                new[] { sizeTypeEnum, typeof(int), typeof(int), typeof(string) });
            if (ctor != null)
                return ctor.Invoke(new[] { fixedResolution, width, height, (object)label });

            return null;
        }

        private static bool SelectSize(EditorWindow gameView, int index)
        {
            // GameView.SizeSelectionCallback(int indexClicked, object objectSelected) both sets
            // selectedSizeIndex AND triggers the internal resize+repaint — the same path the Game
            // View's resolution dropdown uses, so layout is applied exactly as a manual change.
            MethodInfo callback = GameViewType.GetMethod(
                "SizeSelectionCallback",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (callback != null)
            {
                callback.Invoke(gameView, new object[] { index, null });
                return true;
            }

            // Fallback: set the selectedSizeIndex property directly (older layouts).
            PropertyInfo selectedIndexProp = GameViewType.GetProperty(
                "selectedSizeIndex",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (selectedIndexProp != null && selectedIndexProp.CanWrite)
            {
                selectedIndexProp.SetValue(gameView, index);
                return true;
            }

            return false;
        }
    }
}
