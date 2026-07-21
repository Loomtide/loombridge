using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Runtime
{
    /// <summary>
    /// Auto-detect a scene's game-phase state signal at RECORD time (Phase 2 / D1-B).
    ///
    /// Across a hub→game recording each scene has its OWN phase manager (HomeManager, then
    /// ChefGameManager) that only exists once that scene loads. So the recorder can't be handed one
    /// global <c>--state-signal</c>; it must find the active scene's signal live, when that scene is
    /// entered mid-recording. This is the direct-reflection sibling of the bridge-driven TypeScript
    /// discovery in <c>minigame-statesignal-discover.ts</c> — it MUST stay behaviourally identical to
    /// that proven, unit-tested scorer (same builtin filter, same scoring ladder, same tie-break), so
    /// the signal a scene yields here matches what scan would have detected for the same scene.
    ///
    /// Conservative + ADVISORY: it only returns a binding when a custom component has a PUBLIC enum
    /// member whose NAME reads as a game phase/state. Nothing confident found ⇒ <c>Found == false</c>
    /// and the scene's gestures simply get no gate (invariant #4 then reports that scene honestly).
    /// </summary>
    public static class StateSignalAutoDetector
    {
        public struct Result
        {
            public bool Found;
            public string Path;       // BuildRuntimePath of the winning component's GameObject
            public string Component;  // component type name (e.g. "ChefGameManager")
            public string Property;   // public enum member name (e.g. "phase")
        }

        /// <summary>
        /// Common Unity/UI/render component type names whose enum members are never a game phase
        /// (Image.type, Canvas.renderMode, …). Skipping them avoids false positives. Mirrors the TS
        /// BUILTIN_COMPONENTS set exactly. The phase/state NAME filter below is the real correctness guard.
        /// </summary>
        private static readonly HashSet<string> BuiltinComponents = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Transform", "RectTransform", "Canvas", "CanvasRenderer", "CanvasScaler", "GraphicRaycaster",
            "Image", "RawImage", "Text", "TextMeshProUGUI", "TextMeshPro", "TMP_Text", "Button", "Toggle",
            "ToggleGroup", "Slider", "Scrollbar", "ScrollRect", "Dropdown", "TMP_Dropdown", "InputField",
            "TMP_InputField", "Mask", "RectMask2D", "Selectable", "LayoutElement", "HorizontalLayoutGroup",
            "VerticalLayoutGroup", "GridLayoutGroup", "ContentSizeFitter", "AspectRatioFitter", "Outline",
            "Shadow", "PositionAsUV1", "EventTrigger", "EventSystem", "StandaloneInputModule",
            "InputSystemUIInputModule", "BaseInputModule", "Camera", "AudioSource", "AudioListener",
            "Light", "SpriteRenderer", "MeshRenderer", "MeshFilter", "SkinnedMeshRenderer", "Animator",
            "Animation", "ParticleSystem", "ParticleSystemRenderer", "Rigidbody", "Rigidbody2D",
            "BoxCollider", "BoxCollider2D", "CircleCollider2D", "PolygonCollider2D", "CapsuleCollider2D",
            "SphereCollider", "CapsuleCollider", "MeshCollider", "CompositeCollider2D", "LineRenderer",
            "TrailRenderer", "SortingGroup", "Grid", "Tilemap", "TilemapRenderer", "PlayerInput",
        };

        private static readonly Regex PlainIdentifier = new Regex("^[A-Za-z_][A-Za-z0-9_]*$");

        private struct Candidate
        {
            public GameObject Go;
            public string Component;
            public string Property;
            public int EnumValueCount;
            public int Score;
        }

        /// <summary>
        /// Walk <paramref name="scene"/>'s custom components for the best public enum phase/state member.
        /// <paramref name="pathOf"/> builds the runtime path of the winning GameObject (the observer's
        /// BuildRuntimePath) so the tie-break (and the returned Path) match the recorder's locator format.
        /// Never throws — any reflection hiccup yields the best candidate found so far (or none).
        /// </summary>
        public static Result Detect(Scene scene, Func<GameObject, string> pathOf)
        {
            var candidates = new List<Candidate>();
            try
            {
                if (!scene.IsValid() || !scene.isLoaded)
                    return default;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    // include inactive — a phase manager is often on an always-present root that may be inactive
                    MonoBehaviour[] behaviours = root.GetComponentsInChildren<MonoBehaviour>(true);
                    foreach (MonoBehaviour mb in behaviours)
                    {
                        if (mb == null) // a missing/broken script
                            continue;
                        string typeName = mb.GetType().Name;
                        if (BuiltinComponents.Contains(typeName))
                            continue;
                        CollectFromComponent(mb, typeName, candidates);
                    }
                }
            }
            catch
            {
                // Advisory: a reflection failure must never break recording — fall through to whatever we found.
            }

            return Pick(candidates, pathOf);
        }

        private static void CollectFromComponent(MonoBehaviour mb, string typeName, List<Candidate> candidates)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;
            Type type = mb.GetType();

            foreach (PropertyInfo prop in type.GetProperties(flags))
            {
                if (!prop.CanRead || !prop.PropertyType.IsEnum) continue;
                if (prop.GetIndexParameters().Length != 0) continue; // indexers aren't reflectable by name
                TryAdd(mb, typeName, prop.Name, prop.PropertyType, candidates);
            }
            foreach (FieldInfo field in type.GetFields(flags))
            {
                if (!field.FieldType.IsEnum) continue;
                TryAdd(mb, typeName, field.Name, field.FieldType, candidates);
            }
        }

        private static void TryAdd(MonoBehaviour mb, string typeName, string memberName, Type enumType, List<Candidate> candidates)
        {
            string[] enumValues = Enum.GetNames(enumType);
            int? score = ScoreStateSignalProperty(typeName, memberName, enumValues);
            if (score == null) return;
            candidates.Add(new Candidate
            {
                Go = mb.gameObject,
                Component = typeName,
                Property = memberName,
                EnumValueCount = enumValues.Length,
                Score = score.Value,
            });
        }

        /// <summary>Lower-cased, non-alphanumerics stripped ("Game Phase" → "gamephase"). Mirrors normalizeName.</summary>
        private static string NormalizeName(string raw)
        {
            return Regex.Replace(raw.ToLowerInvariant(), "[^a-z0-9]", "");
        }

        /// <summary>
        /// Score an enum member as a game phase/state signal, or null if it doesn't read as one.
        /// A LINE-FOR-LINE port of scoreStateSignalProperty (minigame-statesignal-discover.ts). The
        /// reflection member name serves as BOTH serializedPath and displayName (there is no separate
        /// serialized path under direct reflection).
        /// </summary>
        public static int? ScoreStateSignalProperty(string componentName, string memberName, string[] enumValues)
        {
            if (enumValues == null || enumValues.Length < 2) return null;
            if (memberName.StartsWith("_")) return null;                 // private convention; read by public name
            if (!PlainIdentifier.IsMatch(memberName)) return null;        // nested/array path → unreadable by name

            string prop = NormalizeName(memberName);
            bool Matches(string needle) => prop.Contains(needle);

            int propScore;
            bool weakFamily = false;
            if (prop == "phase" || prop == "gamephase") propScore = 6;
            else if (prop == "state" || prop == "gamestate") propScore = 5;
            else if (Matches("phase")) propScore = 5;
            else if (Matches("state")) propScore = 4;
            else if (Matches("step") || Matches("stage") || Matches("screen") || Matches("mode") || Matches("status") || Matches("round"))
            {
                propScore = 2;
                weakFamily = true;
            }
            else return null;

            // The weak family (mode/step/stage/…) is easily a binary toggle (RGB/HSV, On/Off) rather than a
            // game phase — require ≥3 values so a real multi-screen state machine, not a 2-way switch, qualifies.
            if (weakFamily && enumValues.Length < 3) return null;

            string comp = componentName.ToLowerInvariant();
            int componentBonus = 0;
            if (comp.Contains("manager")) componentBonus = 3;
            else if (comp.Contains("controller")) componentBonus = 2;
            else if (comp.Contains("director") || comp.Contains("sequencer") || comp.Contains("flow")) componentBonus = 2;
            else if (comp.Contains("game")) componentBonus = 2;

            // Viability gate: a clear phase/state name stands alone; the weaker family only counts on a
            // manager-ish component. Anything else is too weak to risk a false signal.
            bool viable = propScore >= 4 || (propScore >= 2 && componentBonus >= 2);
            if (!viable) return null;

            return propScore + componentBonus;
        }

        /// <summary>
        /// Deterministic tie-break so a scene always yields the same signal: higher score → more enum
        /// values → shorter locator → lexicographic. Mirrors pickStateSignal. Resolves each candidate's
        /// path here (via pathOf) because the tie-break depends on locator length/order.
        /// </summary>
        private static Result Pick(List<Candidate> candidates, Func<GameObject, string> pathOf)
        {
            bool have = false;
            Candidate best = default;
            string bestPath = null;
            foreach (Candidate c in candidates)
            {
                string path = pathOf(c.Go) ?? "";
                if (!have || Better(c, path, best, bestPath))
                {
                    best = c;
                    bestPath = path;
                    have = true;
                }
            }
            if (!have) return default;
            return new Result { Found = true, Path = bestPath, Component = best.Component, Property = best.Property };
        }

        /// <summary>True when candidate <paramref name="c"/> (with resolved <paramref name="cPath"/>) outranks the current best.</summary>
        private static bool Better(Candidate c, string cPath, Candidate best, string bestPath)
        {
            if (c.Score != best.Score) return c.Score > best.Score;
            if (c.EnumValueCount != best.EnumValueCount) return c.EnumValueCount > best.EnumValueCount;
            if (cPath.Length != bestPath.Length) return cPath.Length < bestPath.Length;
            return string.CompareOrdinal(cPath, bestPath) < 0;
        }
    }
}
