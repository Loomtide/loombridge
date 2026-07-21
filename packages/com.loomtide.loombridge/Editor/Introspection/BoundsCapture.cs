using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Introspection
{
    /// <summary>
    /// Computes world-space bounds for a GameObject's colliders and renderers — the
    /// numeric counterpart to a screenshot. Answers "where is the collider vs where is
    /// the visible sprite vs the ground" as data, so alignment bugs (e.g. a character
    /// whose feet float above its collider) are measurable, not just eyeballed.
    ///
    /// Also exposes a combined-bounds helper used to frame a camera (focused capture,
    /// SceneView framing) on an object.
    /// </summary>
    public static class BoundsCapture
    {
        /// <summary>
        /// Resolves the locator and returns a structured world-bounds readout: transform,
        /// every Collider2D/Collider, and every Renderer (each as a world AABB with
        /// min/max/center/size). Adds convenience fields comparing the visible (renderer)
        /// bottom to the collider bottom — the common "feet float" check in one read.
        /// </summary>
        public static JObject Describe(JObject locator, bool includeDebug = false)
        {
            GameObject go = LocatorResolver.Resolve(locator);

            var colliders = new JArray();
            foreach (Collider2D c in go.GetComponents<Collider2D>())
                colliders.Add(BoundsToJObject(c.GetType().Name, c.bounds));
            foreach (Collider c in go.GetComponents<Collider>())
                colliders.Add(BoundsToJObject(c.GetType().Name, c.bounds));

            var renderers = new JArray();
            foreach (Renderer r in go.GetComponents<Renderer>())
            {
                JObject rj = BoundsToJObject(r.GetType().Name, r.bounds);
                // For sprites, also report the *opaque* (visible) bounds of the current
                // frame — the full quad bounds above include transparent padding. The raw
                // scan details (visibleDebug) are verbose, so only emitted when requested.
                if (r is SpriteRenderer sr)
                {
                    bool ok;
                    Bounds spriteVisible;
                    string reason;
                    if (includeDebug)
                    {
                        ok = SpriteOpaqueBounds.TryComputeWorld(sr, out spriteVisible, out reason, out JObject visibleDebug);
                        if (visibleDebug != null)
                            rj["visibleDebug"] = visibleDebug;
                    }
                    else
                    {
                        ok = SpriteOpaqueBounds.TryComputeWorld(sr, out spriteVisible, out reason);
                    }

                    if (ok)
                        rj["visibleBounds"] = BoundsToJObject("opaque", spriteVisible);
                    else
                        rj["visibleBoundsUnavailable"] = reason;
                }
                renderers.Add(rj);
            }

            Transform t = go.transform;
            var result = new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(go),
                ["name"] = go.name,
                ["transform"] = new JObject
                {
                    ["position"] = Vec3(t.position),
                    ["lossyScale"] = Vec3(t.lossyScale),
                },
                ["colliders"] = colliders,
                ["renderers"] = renderers,
            };

            // Convenience bottoms. The headline check is the VISIBLE feet (opaque pixels
            // of the current frame) vs the collider bottom: when the visible feet sit
            // above the collider bottom (positive), a grounded character floats — the
            // exact symptom this tooling debugs. rendererBottomY (full quad) is kept for
            // reference but cannot see the float on its own (it includes padding and is
            // constant across frames).
            Bounds? rb = CombinedBounds(go, includeColliders: false, includeRenderers: true);
            Bounds? cb = CombinedBounds(go, includeColliders: true, includeRenderers: false);
            Bounds? vb = CombinedOpaqueBounds(go);
            if (rb.HasValue) result["rendererBottomY"] = rb.Value.min.y;
            if (cb.HasValue) result["colliderBottomY"] = cb.Value.min.y;
            if (vb.HasValue) result["visibleBottomY"] = vb.Value.min.y;
            if (vb.HasValue && cb.HasValue)
                result["visibleFeetAboveColliderBottom"] = vb.Value.min.y - cb.Value.min.y;

            return result;
        }

        /// <summary>
        /// Combined world bounds across the object (and optionally children) from renderers
        /// and/or colliders. Used both for the convenience fields above and for framing a
        /// camera on the object. Returns null when nothing measurable exists.
        /// </summary>
        public static Bounds? CombinedBounds(GameObject go, bool includeColliders = true,
            bool includeRenderers = true, bool includeChildren = true)
        {
            bool has = false;
            Bounds acc = new Bounds(go.transform.position, Vector3.zero);

            void Add(Bounds b)
            {
                if (!has) { acc = b; has = true; }
                else acc.Encapsulate(b);
            }

            if (includeRenderers)
            {
                Renderer[] rs = includeChildren
                    ? go.GetComponentsInChildren<Renderer>()
                    : go.GetComponents<Renderer>();
                foreach (Renderer r in rs)
                    if (r != null && r.enabled) Add(r.bounds);
            }

            if (includeColliders)
            {
                if (includeChildren)
                {
                    foreach (Collider2D c in go.GetComponentsInChildren<Collider2D>()) Add(c.bounds);
                    foreach (Collider c in go.GetComponentsInChildren<Collider>()) Add(c.bounds);
                }
                else
                {
                    foreach (Collider2D c in go.GetComponents<Collider2D>()) Add(c.bounds);
                    foreach (Collider c in go.GetComponents<Collider>()) Add(c.bounds);
                }
            }

            return has ? acc : (Bounds?)null;
        }

        /// <summary>
        /// Combined world bounds of the OPAQUE (visible) pixels across the object's
        /// SpriteRenderers (and optionally children) for their current frames. Returns
        /// null when none are measurable. Used for the visible-feet float metric and the
        /// annotated-capture overlay.
        /// </summary>
        public static Bounds? CombinedOpaqueBounds(GameObject go, bool includeChildren = true)
        {
            SpriteRenderer[] srs = includeChildren
                ? go.GetComponentsInChildren<SpriteRenderer>()
                : go.GetComponents<SpriteRenderer>();

            bool has = false;
            Bounds acc = default;
            foreach (SpriteRenderer sr in srs)
            {
                if (sr == null || !sr.enabled) continue;
                if (!SpriteOpaqueBounds.TryComputeWorld(sr, out Bounds vb, out _)) continue;
                if (!has) { acc = vb; has = true; }
                else acc.Encapsulate(vb);
            }
            return has ? acc : (Bounds?)null;
        }

        private static JObject BoundsToJObject(string type, Bounds b)
        {
            return new JObject
            {
                ["type"] = type,
                ["min"] = Vec3(b.min),
                ["max"] = Vec3(b.max),
                ["center"] = Vec3(b.center),
                ["size"] = Vec3(b.size),
            };
        }

        private static JObject Vec3(Vector3 v) => new JObject { ["x"] = v.x, ["y"] = v.y, ["z"] = v.z };
    }
}
