using UnityEditor;
using UnityEditorInternal;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Optional editor-only visual cues for demo recordings. When enabled, bridge
    /// ops select the object or asset they just changed so the Hierarchy, Project,
    /// Inspector, and Scene view visibly follow the agent's work.
    /// </summary>
    public static class ShowWorkVisualizer
    {
        private const string PrefKey = "UnityBridge.ShowWorkMode";
        private const string MenuPath = "Window/Loomtide/Show Work Mode";

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(PrefKey, false);
            set => EditorPrefs.SetBool(PrefKey, value);
        }

        [MenuItem(MenuPath)]
        private static void ToggleMenu()
        {
            Enabled = !Enabled;
            Debug.Log($"[UnityBridge] Show Work Mode {(Enabled ? "enabled" : "disabled")}");
        }

        [MenuItem(MenuPath, true)]
        private static bool ToggleMenuValidate()
        {
            Menu.SetChecked(MenuPath, Enabled);
            return true;
        }

        public static void SelectObject(GameObject go, bool ping = true, bool frame = false)
        {
            if (!Enabled || go == null)
                return;

            Selection.activeGameObject = go;
            RepaintEditorWindows();
            if (ping)
                EditorGUIUtility.PingObject(go);
            if (frame)
                FrameGameObject(go);
        }

        public static void SelectAsset(string assetPath, bool ping = true)
        {
            if (!Enabled || string.IsNullOrEmpty(assetPath))
                return;

            Object asset = AssetDatabase.LoadMainAssetAtPath(assetPath);
            if (asset == null)
                return;

            Selection.activeObject = asset;
            RepaintEditorWindows();
            if (ping)
                EditorGUIUtility.PingObject(asset);
        }

        public static void SelectAsset(Object asset, bool ping = true)
        {
            if (!Enabled || asset == null)
                return;

            Selection.activeObject = asset;
            RepaintEditorWindows();
            if (ping)
                EditorGUIUtility.PingObject(asset);
        }

        /// <summary>
        /// Emit a concise, consistently-prefixed Console line describing a programmatic
        /// change so it is captured on camera during a Show Work recording. No-op when
        /// Show Work is disabled. Callers format the detail (e.g. "/Player PlayerController.moveSpeed = 7").
        /// </summary>
        public static void LogChange(string message)
        {
            if (!Enabled || string.IsNullOrEmpty(message))
                return;

            Debug.Log($"[ShowWork] {message}");
        }

        /// <summary>
        /// Expand the given component's foldout in the Inspector so a just-added or
        /// just-edited component (and its changed field) is visible without a manual click.
        /// No-op when Show Work is disabled. Also repaints so a backgrounded editor follows.
        /// </summary>
        public static void ExpandComponent(Component component)
        {
            if (!Enabled || component == null)
                return;

            InternalEditorUtility.SetIsInspectorExpanded(component, true);
            RepaintEditorWindows();
        }

        /// <summary>
        /// Lightweight high-signal beat for generated editor scripts and bulk builders.
        /// Selects/pings the object, optionally frames it in SceneView, expands a relevant
        /// component, and emits one concise Console line. This lets a fast one-shot builder
        /// keep the recording legible without routing every create/set through bridge ops.
        /// </summary>
        public static void PulseImportantObject(GameObject go, string note = null, bool frame = false, Component component = null)
        {
            if (!Enabled || go == null)
                return;

            SelectObject(go, ping: true, frame: frame);
            if (component != null)
                ExpandComponent(component);

            string label = string.IsNullOrEmpty(note) ? go.name : note;
            Debug.Log($"[ShowWork] {label} - {GetHierarchyPath(go)}");
        }

        /// <summary>
        /// Force Inspector/Hierarchy/Scene windows to redraw immediately. A backgrounded
        /// or unfocused editor suppresses window repaints, so a programmatic Selection
        /// change otherwise leaves the Inspector empty/stale until a manual click.
        /// </summary>
        private static void RepaintEditorWindows()
        {
            InternalEditorUtility.RepaintAllViews();
            EditorApplication.RepaintHierarchyWindow();
        }

        private static void FrameGameObject(GameObject go)
        {
            SceneView sv = SceneView.lastActiveSceneView;
            if (sv == null && SceneView.sceneViews != null && SceneView.sceneViews.Count > 0)
                sv = SceneView.sceneViews[0] as SceneView;
            if (sv == null)
                return;

            Bounds? bounds = UnityBridge.Introspection.BoundsCapture.CombinedBounds(go);
            if (bounds.HasValue)
                sv.Frame(bounds.Value, instant: true);
            sv.Repaint();
        }

        private static string GetHierarchyPath(GameObject go)
        {
            if (go == null)
                return "";

            string path = go.name;
            Transform current = go.transform.parent;
            while (current != null)
            {
                path = current.name + "/" + path;
                current = current.parent;
            }
            return "/" + path;
        }
    }
}
