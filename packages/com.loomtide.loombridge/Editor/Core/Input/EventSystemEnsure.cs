using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;

namespace UnityBridge.Core
{
    /// <summary>
    /// Ensures the loaded scene has an EventSystem with a working UI input module, so uGUI buttons
    /// and touch controls actually receive input (RCL-T14: ui.create_canvas used to leave a canvas
    /// with no EventSystem, silently swallowing every tap).
    ///
    /// Module selection follows the project's ACTIVE input handling (ProjectSettings
    /// `activeInputHandler`: 0 = old Input Manager, 1 = new Input System, 2 = both):
    ///   • new-input projects get <c>InputSystemUIInputModule</c> (resolved via reflection so the
    ///     bridge keeps compiling without a hard Unity.InputSystem dependency),
    ///   • old-input projects get the legacy <c>StandaloneInputModule</c>.
    /// A scene that already has an EventSystem is left in place (its module is added only if missing),
    /// so we never stack two EventSystems or clobber a game's own configuration.
    /// </summary>
    public static class EventSystemEnsure
    {
        public struct Result
        {
            public EventSystem eventSystem;
            public bool created;       // a new EventSystem GameObject was created
            public bool addedModule;   // a UI input module was added to an existing/new EventSystem
            public string moduleType;  // the module type name now present (or "unknown")
        }

        /// <summary>
        /// Returns the scene's EventSystem, creating one (with the right input module) if absent.
        /// Idempotent: a second call on a scene that already has an EventSystem + module is a no-op
        /// beyond returning the existing one.
        /// </summary>
        public static Result Ensure()
        {
            EventSystem existing = EventSystem.current;
            if (existing == null)
                existing = UnityEngine.Object.FindFirstObjectByType<EventSystem>();

            if (existing != null)
            {
                bool addedModule = EnsureModule(existing.gameObject, out string moduleName);
                return new Result
                {
                    eventSystem = existing,
                    created = false,
                    addedModule = addedModule,
                    moduleType = moduleName,
                };
            }

            var go = new GameObject("EventSystem");
            Undo.RegisterCreatedObjectUndo(go, "Create EventSystem");
            EventSystem es = go.AddComponent<EventSystem>();
            EnsureModule(go, out string createdModuleName);

            return new Result
            {
                eventSystem = es,
                created = true,
                addedModule = true,
                moduleType = createdModuleName,
            };
        }

        /// <summary>
        /// Adds a UI input module to <paramref name="go"/> if it has none. Returns true when a module
        /// was added. <paramref name="moduleName"/> is the type name of the module now present.
        /// </summary>
        private static bool EnsureModule(GameObject go, out string moduleName)
        {
            BaseInputModule current = go.GetComponent<BaseInputModule>();
            if (current != null)
            {
                moduleName = current.GetType().Name;
                return false;
            }

            Type moduleType = ResolvePreferredModuleType();
            if (moduleType != null)
            {
                Component added = go.AddComponent(moduleType);
                moduleName = added != null ? added.GetType().Name : moduleType.Name;
                return added != null;
            }

            // Fallback: legacy module (always available in com.unity.ugui).
            StandaloneInputModule standalone = go.AddComponent<StandaloneInputModule>();
            moduleName = standalone.GetType().Name;
            return true;
        }

        /// <summary>
        /// Picks the UI input module type for the project's active input handling. Prefers
        /// InputSystemUIInputModule when the project uses the new Input System (and the type resolves);
        /// otherwise StandaloneInputModule. Returns null to signal "use the legacy fallback".
        /// </summary>
        private static Type ResolvePreferredModuleType()
        {
            int handler = ReadActiveInputHandler(); // 0 old, 1 new, 2 both, -1 unknown
            Type inputSystemModule = ResolveInputSystemUIModuleType();

            // New-input or both → InputSystemUIInputModule when available.
            if ((handler == 1 || handler == 2) && inputSystemModule != null)
                return inputSystemModule;

            // Old-input only → legacy.
            if (handler == 0)
                return typeof(StandaloneInputModule);

            // Unknown handler: fall back to the new module if the package is present (a project that
            // has the Input System package installed almost always uses it), else legacy.
            if (handler < 0 && inputSystemModule != null)
                return inputSystemModule;

            return typeof(StandaloneInputModule);
        }

        /// <summary>
        /// Resolves UnityEngine.InputSystem.UI.InputSystemUIInputModule via reflection (assembly
        /// Unity.InputSystem), or null when the new Input System package is not installed.
        /// </summary>
        private static Type ResolveInputSystemUIModuleType()
        {
            const string fullName = "UnityEngine.InputSystem.UI.InputSystemUIInputModule";
            Type t = Type.GetType(fullName + ", Unity.InputSystem");
            if (t != null)
                return t;

            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                t = asm.GetType(fullName, false);
                if (t != null)
                    return t;
            }
            return null;
        }

        /// <summary>
        /// Reads ProjectSettings `activeInputHandler` (0 old / 1 new / 2 both); -1 if unreadable.
        /// This is the only reliable signal of which input backend is enabled.
        /// </summary>
        private static int ReadActiveInputHandler()
        {
            try
            {
                UnityEngine.Object[] assets =
                    AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset");
                if (assets == null || assets.Length == 0)
                    return -1;

                var so = new SerializedObject(assets[0]);
                SerializedProperty prop = so.FindProperty("activeInputHandler");
                int value = prop != null ? prop.intValue : -1;
                so.Dispose();
                return value;
            }
            catch
            {
                return -1;
            }
        }
    }
}
