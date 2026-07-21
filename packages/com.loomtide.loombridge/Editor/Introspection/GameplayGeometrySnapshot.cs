using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Serializes and diffs the GAMEPLAY GEOMETRY of the loaded scenes — colliders, triggers, layers,
    /// tags, active-state, and transforms — while DELIBERATELY excluding all renderer / visual-only
    /// data. This is the "art scene safety profile" from the art-integration dogfood (backlog item #12,
    /// principle "Art Is A Parallel Vertical"): an art pass must be visual-only, so graybox colliders,
    /// LOS blockers, triggers, and serialized gameplay tuning must survive it UNCHANGED. Today nothing
    /// proves that; this pairs with a future CLI gate ("art pass changed no gameplay geometry").
    ///
    /// Two entry points:
    ///   • <see cref="BuildSnapshot"/> — walk the loaded scenes, emit a deterministic JSON document.
    ///     Two snapshots of an unchanged scene are BYTE-IDENTICAL: objects are sorted by a stable
    ///     scene-qualified key, colliders keep their component order, and every value comes straight
    ///     from the transform / collider (no timestamps, no instance IDs, no renderer state).
    ///   • <see cref="Compare"/> — re-walk the LIVE scenes and diff against a baseline document, using
    ///     the baseline's OWN stored filters so the two walks cover the same surface. Honest by design:
    ///     verdict is "changed" whenever anything was added, removed, or modified beyond tolerance.
    ///
    /// The JSON shape is a stable contract (the CLI parses it): see <see cref="SchemaVersion"/>. A
    /// rename shows up as removed+added (no fuzzy matching — identity is the scene-qualified path).
    /// </summary>
    public static class GameplayGeometrySnapshot
    {
        /// <summary>
        /// Schema version of the emitted document. The compare path refuses a baseline whose
        /// schema_version does not match (never an empty diff) — including OLDER versions: an old
        /// baseline cannot prove the current invariants, and an additive-tolerant read is wrong for
        /// an honesty tool. v2: identity keys are scene-ASSET-PATH-qualified (scene.name is not
        /// unique across additively-loaded scenes), MeshCollider records carry
        /// vertex_count/triangle_count/bounds, and active_in_hierarchy participates in the diff.
        /// </summary>
        public const int SchemaVersion = 2;

        // Default float tolerances for the compare path (overridable per-call).
        public const double DefaultPositionTolerance = 0.001;
        public const double DefaultRotationToleranceDeg = 0.1;
        public const double DefaultSizeTolerance = 0.001;

        // Upper bounds for caller-supplied tolerances. The tolerance knob exists for float noise, not
        // for laundering: an unbounded tolerance (position: 9999) would make ANY move read unchanged.
        // These caps are generous for numeric jitter yet useless for hiding a real change; the compare
        // op refuses anything above them (and anything negative).
        public const double MaxPositionSizeTolerance = 0.1;
        public const double MaxRotationToleranceDeg = 5.0;

        // ─────────────────────────────────────────────
        // Snapshot
        // ─────────────────────────────────────────────

        /// <summary>
        /// Walk every loaded scene and serialize the gameplay geometry of each GameObject that carries
        /// a Collider or Collider2D. <paramref name="includeTags"/> (when non-null) keeps only objects
        /// whose tag is in the set; <paramref name="layers"/> (when non-null) keeps only objects whose
        /// layer index is in the set. Both filters are stored back into the document so a later compare
        /// re-walks the identical surface. Deterministic: objects sorted by scene-qualified key.
        /// </summary>
        public static JObject BuildSnapshot(HashSet<string> includeTags, HashSet<int> layers)
        {
            var records = new List<GeometryRecord>();
            var scenePaths = new List<string>();

            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded)
                    continue;

                scenePaths.Add(ReferenceScanner.DescribeScenePath(scene) ?? scene.name);
                string scenePath = ReferenceScanner.DescribeScenePath(scene);

                // Identity prefix for the diff key. scene.name is NOT unique across additively-loaded
                // scenes (same-named scene assets in different folders), so key on the ASSET PATH.
                // Only an untitled scene has no path — fall back to name + load index so two untitled
                // scenes cannot collide either.
                string sceneIdentity = !string.IsNullOrEmpty(scene.path)
                    ? scene.path
                    : scene.name + "#" + i;

                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (Transform t in root.GetComponentsInChildren<Transform>(true))
                    {
                        GameObject go = t.gameObject;

                        // Gather colliders in component order (deterministic, faithful to the object).
                        var colliders = new List<Component>();
                        foreach (Component c in go.GetComponents<Component>())
                        {
                            if (c is Collider || c is Collider2D)
                                colliders.Add(c);
                        }
                        if (colliders.Count == 0)
                            continue;

                        if (includeTags != null && !includeTags.Contains(go.tag))
                            continue;
                        if (layers != null && !layers.Contains(go.layer))
                            continue;

                        records.Add(new GeometryRecord
                        {
                            SceneIdentity = sceneIdentity,
                            SceneName = scene.name,
                            ScenePath = scenePath,
                            Path = LocatorResolver.BuildLocator(go)?.Value<string>("path") ?? go.name,
                            GameObject = go,
                            Colliders = colliders,
                        });
                    }
                }
            }

            // Stable identity + ordering: scene ASSET PATH (or name#index for untitled) then hierarchy
            // path (ordinal). Keys are unique, so the sort has no equal-key ties and the output is
            // independent of traversal order — re-snapshots are byte-identical.
            records.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));

            var objectsArr = new JArray();
            int colliderCount = 0;
            foreach (GeometryRecord rec in records)
            {
                JObject obj = BuildObjectJson(rec);
                colliderCount += ((JArray)obj["colliders"]).Count;
                objectsArr.Add(obj);
            }

            return new JObject
            {
                ["schema_version"] = SchemaVersion,
                ["generated_by"] = "scene.snapshot_gameplay_geometry",
                ["scenes"] = new JArray(scenePaths.Cast<object>().ToArray()),
                ["filters"] = new JObject
                {
                    ["include_tags"] = includeTags != null
                        ? new JArray(includeTags.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToArray())
                        : (JToken)JValue.CreateNull(),
                    ["layers"] = layers != null
                        ? new JArray(layers.OrderBy(x => x).Cast<object>().ToArray())
                        : (JToken)JValue.CreateNull(),
                },
                ["counts"] = new JObject
                {
                    ["objects"] = objectsArr.Count,
                    ["colliders"] = colliderCount,
                },
                ["objects"] = objectsArr,
            };
        }

        private sealed class GeometryRecord
        {
            /// <summary>Scene asset path, or name + "#" + load index for an untitled scene — the UNIQUE key prefix.</summary>
            public string SceneIdentity;
            public string SceneName;
            public string ScenePath;
            public string Path;
            public GameObject GameObject;
            public List<Component> Colliders;
            public string Key => SceneIdentity + "|" + Path;
        }

        private static JObject BuildObjectJson(GeometryRecord rec)
        {
            GameObject go = rec.GameObject;
            Transform t = go.transform;

            var collidersArr = new JArray();
            foreach (Component c in rec.Colliders)
                collidersArr.Add(BuildColliderJson(c));

            return new JObject
            {
                ["key"] = rec.Key,
                ["scene"] = rec.SceneName,
                ["scene_path"] = rec.ScenePath != null ? (JToken)rec.ScenePath : JValue.CreateNull(),
                ["path"] = rec.Path,
                ["layer"] = go.layer,
                ["layer_name"] = LayerMask.LayerToName(go.layer),
                ["tag"] = go.tag,
                ["active_self"] = go.activeSelf,
                ["active_in_hierarchy"] = go.activeInHierarchy,
                ["transform"] = new JObject
                {
                    ["position"] = Vec3(t.position),
                    ["rotation"] = Quat(t.rotation),
                    ["scale"] = Vec3(t.lossyScale),
                },
                ["colliders"] = collidersArr,
            };
        }

        /// <summary>
        /// Serialize a single collider's LOCAL-space gameplay geometry. Common keys (type, dimension,
        /// is_trigger, enabled) come first; type-specific geometry follows. World placement is NOT
        /// stored here — it lives once on the owning object's transform, so the collider record is
        /// transform-independent and a pure move surfaces as a transform.position diff.
        /// </summary>
        private static JObject BuildColliderJson(Component c)
        {
            var obj = new JObject
            {
                ["type"] = c.GetType().Name,
            };

            if (c is Collider c3)
            {
                obj["dimension"] = "3d";
                obj["is_trigger"] = c3.isTrigger;
                obj["enabled"] = c3.enabled;

                switch (c3)
                {
                    case BoxCollider box:
                        obj["center"] = Vec3(box.center);
                        obj["size"] = Vec3(box.size);
                        break;
                    case SphereCollider sphere:
                        obj["center"] = Vec3(sphere.center);
                        obj["radius"] = sphere.radius;
                        break;
                    case CapsuleCollider cap:
                        obj["center"] = Vec3(cap.center);
                        obj["radius"] = cap.radius;
                        obj["height"] = cap.height;
                        obj["direction"] = cap.direction;
                        break;
                    case CharacterController cc:
                        obj["center"] = Vec3(cc.center);
                        obj["radius"] = cc.radius;
                        obj["height"] = cc.height;
                        break;
                    case MeshCollider mesh:
                        obj["convex"] = mesh.convex;
                        if (mesh.sharedMesh != null)
                        {
                            Mesh m = mesh.sharedMesh;
                            obj["shared_mesh"] = m.name;
                            // A name alone is trivially spoofable (same-named swap) and blind to an
                            // in-place mesh edit: fingerprint with counts + local bounds. Full vertex
                            // hashing is overkill; counts + bounds catch the realistic swaps.
                            obj["vertex_count"] = m.vertexCount;
                            int indexCount = 0;
                            for (int sub = 0; sub < m.subMeshCount; sub++)
                                indexCount += (int)m.GetIndexCount(sub);
                            obj["triangle_count"] = indexCount / 3;
                            Bounds mb = m.bounds;
                            obj["bounds"] = new JObject
                            {
                                ["center"] = Vec3(mb.center),
                                ["size"] = Vec3(mb.size),
                            };
                        }
                        else
                        {
                            // No counts/bounds keys when meshless — the union-of-keys compare flags a
                            // null↔assigned transition as modified on every fingerprint field.
                            obj["shared_mesh"] = JValue.CreateNull();
                        }
                        break;
                    // Other 3D collider types (Terrain, Wheel) are recorded by type + common fields
                    // only — enough for a diff to catch an add/remove/trigger flip.
                }
            }
            else if (c is Collider2D c2)
            {
                obj["dimension"] = "2d";
                obj["is_trigger"] = c2.isTrigger;
                obj["enabled"] = c2.enabled;
                obj["offset"] = Vec2(c2.offset);

                switch (c2)
                {
                    case BoxCollider2D box:
                        obj["size"] = Vec2(box.size);
                        obj["edge_radius"] = box.edgeRadius;
                        break;
                    case CircleCollider2D circle:
                        obj["radius"] = circle.radius;
                        break;
                    case CapsuleCollider2D cap:
                        obj["size"] = Vec2(cap.size);
                        obj["direction"] = (int)cap.direction;
                        break;
                    case PolygonCollider2D poly:
                        obj["point_count"] = poly.points.Length;
                        obj["points"] = Vec2Array(poly.points);
                        break;
                    case EdgeCollider2D edge:
                        obj["edge_radius"] = edge.edgeRadius;
                        obj["point_count"] = edge.points.Length;
                        obj["points"] = Vec2Array(edge.points);
                        break;
                    case CompositeCollider2D composite:
                        obj["geometry_type"] = composite.geometryType.ToString();
                        obj["generation_type"] = composite.generationType.ToString();
                        break;
                }
            }

            return obj;
        }

        // ─────────────────────────────────────────────
        // Compare
        // ─────────────────────────────────────────────

        /// <summary>
        /// Diff the LIVE scenes against <paramref name="baseline"/>. The live walk uses the baseline's
        /// OWN stored filters (include_tags / layers) so both cover the same surface. Returns
        /// { verdict: "unchanged"|"changed", unchanged_count, added:[...], removed:[...],
        ///   modified:[{ path, scene, field, baseline, current }], tolerance:{...} }.
        /// verdict is "changed" iff added, removed, or modified is non-empty.
        /// </summary>
        public static JObject Compare(JObject baseline, double posTol, double rotTolDeg, double sizeTol)
        {
            // Re-walk live scenes with the baseline's filters (same surface, apples-to-apples).
            HashSet<string> includeTags = ParseTagFilter(baseline);
            HashSet<int> layers = ParseLayerFilter(baseline);
            JObject live = BuildSnapshot(includeTags, layers);

            var baseByKey = IndexByKey(baseline.Value<JArray>("objects"), "baseline");
            var liveByKey = IndexByKey(live.Value<JArray>("objects"), "live");

            var added = new JArray();
            var removed = new JArray();
            var modified = new JArray();
            int unchanged = 0;

            // Deterministic ordering of reported keys.
            var allKeys = new SortedSet<string>(StringComparer.Ordinal);
            foreach (string k in baseByKey.Keys) allKeys.Add(k);
            foreach (string k in liveByKey.Keys) allKeys.Add(k);

            foreach (string key in allKeys)
            {
                bool inBase = baseByKey.TryGetValue(key, out JObject b);
                bool inLive = liveByKey.TryGetValue(key, out JObject l);

                if (inBase && !inLive)
                {
                    removed.Add(Descriptor(b));
                    continue;
                }
                if (!inBase && inLive)
                {
                    added.Add(Descriptor(l));
                    continue;
                }

                var mods = CompareObject(b, l, posTol, rotTolDeg, sizeTol);
                if (mods.Count == 0)
                {
                    unchanged++;
                }
                else
                {
                    foreach (JObject m in mods)
                        modified.Add(m);
                }
            }

            bool changed = added.Count > 0 || removed.Count > 0 || modified.Count > 0;

            return new JObject
            {
                ["schema_version"] = SchemaVersion,
                ["verdict"] = changed ? "changed" : "unchanged",
                ["unchanged_count"] = unchanged,
                ["added"] = added,
                ["removed"] = removed,
                ["modified"] = modified,
                ["tolerance"] = new JObject
                {
                    ["position"] = posTol,
                    ["rotation"] = rotTolDeg,
                    ["size"] = sizeTol,
                },
                ["filters"] = baseline["filters"] != null ? baseline["filters"].DeepClone() : JValue.CreateNull(),
            };
        }

        /// <summary>
        /// Index snapshot objects by their identity key. A DUPLICATE key is a REFUSAL, not a
        /// keep-first: colliding identities mean any change to the shadowed object would be invisible
        /// — a snapshot that cannot honestly diff must not produce a verdict at all.
        /// </summary>
        private static Dictionary<string, JObject> IndexByKey(JArray objects, string side)
        {
            var map = new Dictionary<string, JObject>(StringComparer.Ordinal);
            if (objects == null)
                return map;
            foreach (JToken tok in objects)
            {
                if (tok is JObject o)
                {
                    string key = o.Value<string>("key");
                    if (key == null)
                        continue;
                    if (map.ContainsKey(key))
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Duplicate gameplay-geometry key '{key}' in the {side} snapshot: colliding identities " +
                            "cannot be honestly diffed (a change to the shadowed object would be invisible). Refusing.");
                    map[key] = o;
                }
            }
            return map;
        }

        private static JObject Descriptor(JObject o)
        {
            return new JObject
            {
                ["path"] = o.Value<string>("path"),
                ["scene"] = o.Value<string>("scene"),
                ["colliders"] = o.Value<JArray>("colliders")?.Count ?? 0,
            };
        }

        private static List<JObject> CompareObject(JObject b, JObject l, double posTol, double rotTolDeg, double sizeTol)
        {
            var mods = new List<JObject>();
            string path = l.Value<string>("path");
            string scene = l.Value<string>("scene");

            void Mod(string field, JToken bv, JToken cv) =>
                mods.Add(new JObject { ["path"] = path, ["scene"] = scene, ["field"] = field, ["baseline"] = bv, ["current"] = cv });

            // Exact-match gameplay fields.
            if (b.Value<int>("layer") != l.Value<int>("layer"))
                Mod("layer", b["layer"], l["layer"]);
            if (b.Value<string>("tag") != l.Value<string>("tag"))
                Mod("tag", b["tag"], l["tag"]);
            if (b.Value<bool>("active_self") != l.Value<bool>("active_self"))
                Mod("active_self", b["active_self"], l["active_self"]);
            // active_in_hierarchy must be compared too: deactivating a COLLIDER-LESS ANCESTOR (e.g.
            // "turned off the old Graybox container") kills every child collider in play while each
            // child's own active_self stays true — without this check that reads as unchanged.
            if (b.Value<bool>("active_in_hierarchy") != l.Value<bool>("active_in_hierarchy"))
                Mod("active_in_hierarchy", b["active_in_hierarchy"], l["active_in_hierarchy"]);

            // Transform: tolerance-aware.
            JObject bt = b.Value<JObject>("transform");
            JObject lt = l.Value<JObject>("transform");
            if (bt != null && lt != null)
            {
                if (!Vec3Within(bt["position"], lt["position"], posTol))
                    Mod("transform.position", bt["position"], lt["position"]);
                if (!QuatWithin(bt["rotation"], lt["rotation"], rotTolDeg))
                    Mod("transform.rotation", bt["rotation"], lt["rotation"]);
                if (!Vec3Within(bt["scale"], lt["scale"], sizeTol))
                    Mod("transform.scale", bt["scale"], lt["scale"]);
            }

            // Colliders.
            JArray bc = b.Value<JArray>("colliders") ?? new JArray();
            JArray lc = l.Value<JArray>("colliders") ?? new JArray();
            if (bc.Count != lc.Count)
            {
                Mod("colliders.count", bc.Count, lc.Count);
            }
            else
            {
                for (int i = 0; i < bc.Count; i++)
                    CompareCollider(i, (JObject)bc[i], (JObject)lc[i], posTol, sizeTol, Mod);
            }

            return mods;
        }

        // Keys compared with the POSITION tolerance (local offsets/centers).
        private static readonly HashSet<string> PositionKeys = new HashSet<string> { "center", "offset" };
        // Keys compared with the SIZE tolerance (extents / radii / heights).
        private static readonly HashSet<string> SizeKeys = new HashSet<string> { "size", "radius", "height", "edge_radius" };

        private static void CompareCollider(int index, JObject b, JObject l, double posTol, double sizeTol, Action<string, JToken, JToken> mod)
        {
            string prefix = $"colliders[{index}]";

            // Union of keys so an added/removed field is caught, deterministic order.
            var keys = new SortedSet<string>(StringComparer.Ordinal);
            foreach (JProperty p in b.Properties()) keys.Add(p.Name);
            foreach (JProperty p in l.Properties()) keys.Add(p.Name);

            foreach (string k in keys)
            {
                JToken bv = b[k];
                JToken lv = l[k];
                string field = prefix + "." + k;

                if (bv == null || lv == null)
                {
                    mod(field, bv ?? JValue.CreateNull(), lv ?? JValue.CreateNull());
                    continue;
                }

                if (PositionKeys.Contains(k))
                {
                    bool within = IsVec2(bv) ? Vec2Within(bv, lv, posTol) : Vec3Within(bv, lv, posTol);
                    if (!within) mod(field, bv, lv);
                }
                else if (SizeKeys.Contains(k))
                {
                    bool within = (bv.Type == JTokenType.Object)
                        ? (IsVec2(bv) ? Vec2Within(bv, lv, sizeTol) : Vec3Within(bv, lv, sizeTol))
                        : ScalarWithin(bv, lv, sizeTol);
                    if (!within) mod(field, bv, lv);
                }
                else if (k == "points")
                {
                    if (!PointsWithin(bv as JArray, lv as JArray, posTol)) mod(field, bv, lv);
                }
                else if (k == "bounds")
                {
                    // MeshCollider mesh-local bounds fingerprint: center + size within size tolerance.
                    bool within = bv is JObject bo && lv is JObject lo
                        && Vec3Within(bo["center"], lo["center"], sizeTol)
                        && Vec3Within(bo["size"], lo["size"], sizeTol);
                    if (!within) mod(field, bv, lv);
                }
                else
                {
                    // type, dimension, is_trigger, enabled, direction, convex, point_count,
                    // vertex_count, triangle_count, geometry_type, generation_type, shared_mesh → exact.
                    if (!JToken.DeepEquals(bv, lv)) mod(field, bv, lv);
                }
            }
        }

        // ─────────────────────────────────────────────
        // Filter parsing (from a baseline document)
        // ─────────────────────────────────────────────

        private static HashSet<string> ParseTagFilter(JObject baseline)
        {
            JToken tags = baseline["filters"]?["include_tags"];
            if (tags == null || tags.Type == JTokenType.Null)
                return null;
            if (tags is JArray arr)
                return new HashSet<string>(arr.Select(x => x.ToString()));
            return null;
        }

        private static HashSet<int> ParseLayerFilter(JObject baseline)
        {
            JToken layers = baseline["filters"]?["layers"];
            if (layers == null || layers.Type == JTokenType.Null)
                return null;
            if (layers is JArray arr)
                return new HashSet<int>(arr.Select(x => x.Value<int>()));
            return null;
        }

        // ─────────────────────────────────────────────
        // Float / vector helpers
        // ─────────────────────────────────────────────

        private static JObject Vec3(Vector3 v) => new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z };
        private static JObject Vec2(Vector2 v) => new JObject { ["x"] = v.x, ["y"] = v.y };
        private static JObject Quat(Quaternion q) => new JObject { ["x"] = q.x, ["y"] = q.y, ["z"] = q.z, ["w"] = q.w };

        private static JArray Vec2Array(Vector2[] points)
        {
            var arr = new JArray();
            foreach (Vector2 p in points)
                arr.Add(Vec2(p));
            return arr;
        }

        private static bool IsVec2(JToken t) => t is JObject o && o["z"] == null && o["x"] != null && o["y"] != null;

        private static bool Vec3Within(JToken a, JToken b, double tol)
        {
            if (a == null || b == null) return ReferenceEquals(a, b);
            return Math.Abs((a.Value<double?>("x") ?? 0) - (b.Value<double?>("x") ?? 0)) <= tol
                && Math.Abs((a.Value<double?>("y") ?? 0) - (b.Value<double?>("y") ?? 0)) <= tol
                && Math.Abs((a.Value<double?>("z") ?? 0) - (b.Value<double?>("z") ?? 0)) <= tol;
        }

        private static bool Vec2Within(JToken a, JToken b, double tol)
        {
            if (a == null || b == null) return ReferenceEquals(a, b);
            return Math.Abs((a.Value<double?>("x") ?? 0) - (b.Value<double?>("x") ?? 0)) <= tol
                && Math.Abs((a.Value<double?>("y") ?? 0) - (b.Value<double?>("y") ?? 0)) <= tol;
        }

        private static bool ScalarWithin(JToken a, JToken b, double tol)
        {
            double av = a.Value<double>();
            double bv = b.Value<double>();
            return Math.Abs(av - bv) <= tol;
        }

        private static bool QuatWithin(JToken a, JToken b, double tolDeg)
        {
            if (a == null || b == null) return ReferenceEquals(a, b);
            Quaternion qa = new Quaternion(
                a.Value<float?>("x") ?? 0, a.Value<float?>("y") ?? 0,
                a.Value<float?>("z") ?? 0, a.Value<float?>("w") ?? 1);
            Quaternion qb = new Quaternion(
                b.Value<float?>("x") ?? 0, b.Value<float?>("y") ?? 0,
                b.Value<float?>("z") ?? 0, b.Value<float?>("w") ?? 1);
            return Quaternion.Angle(qa, qb) <= tolDeg;
        }

        private static bool PointsWithin(JArray a, JArray b, double tol)
        {
            if (a == null || b == null) return ReferenceEquals(a, b);
            if (a.Count != b.Count) return false;
            for (int i = 0; i < a.Count; i++)
            {
                if (!Vec2Within(a[i], b[i], tol))
                    return false;
            }
            return true;
        }
    }
}
