using System;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Introspection;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class PropertyIntrospectorTests
    {
        // ─────────────────────────────────────────────
        // ResolveComponentType Tests
        // ─────────────────────────────────────────────

        [Test]
        public void ResolveComponentType_KnownType_ReturnsCorrectType()
        {
            Type result = PropertyIntrospector.ResolveComponentType("Rigidbody2D");
            Assert.AreEqual(typeof(Rigidbody2D), result);
        }

        [Test]
        public void ResolveComponentType_Transform_ReturnsCorrectType()
        {
            Type result = PropertyIntrospector.ResolveComponentType("Transform");
            Assert.AreEqual(typeof(Transform), result);
        }

        [Test]
        public void ResolveComponentType_SpriteRenderer_ReturnsCorrectType()
        {
            Type result = PropertyIntrospector.ResolveComponentType("SpriteRenderer");
            Assert.AreEqual(typeof(SpriteRenderer), result);
        }

        [Test]
        public void ResolveComponentType_Camera_ReturnsCorrectType()
        {
            Type result = PropertyIntrospector.ResolveComponentType("Camera");
            Assert.AreEqual(typeof(Camera), result);
        }

        [Test]
        public void ResolveComponentType_FallbackType_SearchesAssemblies()
        {
            // CharacterController is not in the common lookup table but exists in UnityEngine
            Type result = PropertyIntrospector.ResolveComponentType("CharacterController");
            Assert.AreEqual(typeof(CharacterController), result);
        }

        [Test]
        public void ResolveComponentType_NonexistentType_ReturnsNull()
        {
            Type result = PropertyIntrospector.ResolveComponentType("CompletelyFakeComponent12345");
            Assert.IsNull(result);
        }

        // ─────────────────────────────────────────────
        // FriendlyNameResolver Tests
        // ─────────────────────────────────────────────

        [Test]
        public void ResolvePropertyPath_ExactMatch_ReturnsPath()
        {
            GameObject go = new GameObject("FriendlyNameTest");
            try
            {
                var rb = go.AddComponent<Rigidbody2D>();
                string path = FriendlyNameResolver.ResolvePropertyPath(rb, "m_BodyType");
                Assert.AreEqual("m_BodyType", path);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void ResolvePropertyPath_ZeroMatches_ThrowsInvalidParams()
        {
            GameObject go = new GameObject("FriendlyNameZeroTest");
            try
            {
                var rb = go.AddComponent<Rigidbody2D>();
                var ex = Assert.Throws<BridgeException>(() =>
                    FriendlyNameResolver.ResolvePropertyPath(rb, "totallyBogusProperty"));
                Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        // ─────────────────────────────────────────────
        // DescribeProperties Tests
        // ─────────────────────────────────────────────

        [Test]
        public void DescribeProperties_ReturnsValidDescriptors()
        {
            GameObject go = new GameObject("DescribePropsTest");
            try
            {
                var rb = go.AddComponent<Rigidbody2D>();
                JArray props = PropertyIntrospector.DescribeProperties(rb);
                Assert.IsNotNull(props);
                Assert.Greater(props.Count, 0);

                // Each descriptor should have expected fields
                JObject first = props[0] as JObject;
                Assert.IsNotNull(first);
                Assert.IsNotNull(first.Value<string>("displayName"));
                Assert.IsNotNull(first.Value<string>("serializedPath"));
                Assert.IsNotNull(first.Value<string>("type"));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void DescribeProperties_WithSearch_FiltersResults()
        {
            GameObject go = new GameObject("DescribeSearchTest");
            try
            {
                var rb = go.AddComponent<Rigidbody2D>();
                JArray allProps = PropertyIntrospector.DescribeProperties(rb);
                JArray filtered = PropertyIntrospector.DescribeProperties(rb, search: "mass");

                Assert.IsNotNull(filtered);
                Assert.Greater(allProps.Count, filtered.Count,
                    "Filtered results should be fewer than all properties");

                foreach (JToken item in filtered)
                {
                    JObject prop = item as JObject;
                    string displayName = prop.Value<string>("displayName").ToLowerInvariant();
                    string serializedPath = prop.Value<string>("serializedPath").ToLowerInvariant();
                    Assert.IsTrue(
                        displayName.Contains("mass") || serializedPath.Contains("mass"),
                        $"Filtered property should contain 'mass': {displayName} / {serializedPath}");
                }
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void DescribeProperties_WithIncludePaths_ReturnsOnlySpecified()
        {
            GameObject go = new GameObject("DescribeIncludeTest");
            try
            {
                var rb = go.AddComponent<Rigidbody2D>();
                string[] paths = new[] { "m_BodyType" };
                JArray result = PropertyIntrospector.DescribeProperties(rb, includePaths: paths);

                Assert.IsNotNull(result);
                Assert.AreEqual(1, result.Count);
                Assert.AreEqual("m_BodyType", (result[0] as JObject).Value<string>("serializedPath"));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        // ─────────────────────────────────────────────
        // Renderer sorting (surfaced via the Renderer API, not the iterator)
        // ─────────────────────────────────────────────

        [Test]
        public void DescribeProperties_SpriteRenderer_SurfacesSortingOrder()
        {
            GameObject go = new GameObject("SortingTest");
            try
            {
                var sr = go.AddComponent<SpriteRenderer>();
                sr.sortingOrder = 7;

                JArray props = PropertyIntrospector.DescribeProperties(sr);

                JObject sorting = FindByPath(props, "sortingOrder");
                Assert.IsNotNull(sorting, "sortingOrder should be surfaced for a SpriteRenderer");
                Assert.AreEqual("int", sorting.Value<string>("type"));
                Assert.AreEqual(7, sorting.Value<int>("currentValue"));

                Assert.IsNotNull(FindByPath(props, "sortingLayerName"), "sortingLayerName should be surfaced");
                Assert.IsNotNull(FindByPath(props, "sortingLayerID"), "sortingLayerID should be surfaced");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void DescribeProperties_SortingRespectsIncludePaths()
        {
            GameObject go = new GameObject("SortingIncludeTest");
            try
            {
                var sr = go.AddComponent<SpriteRenderer>();
                sr.sortingOrder = 3;

                JArray result = PropertyIntrospector.DescribeProperties(sr, includePaths: new[] { "sortingOrder" });
                Assert.AreEqual(1, result.Count);
                Assert.AreEqual("sortingOrder", (result[0] as JObject).Value<string>("serializedPath"));
                Assert.AreEqual(3, (result[0] as JObject).Value<int>("currentValue"));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        // ─────────────────────────────────────────────
        // Array expansion (arraySize + element summary)
        // ─────────────────────────────────────────────

        [Test]
        public void DescribeProperties_ArrayProperty_ExpandsSizeAndElements()
        {
            GameObject go = new GameObject("ArrayExpandTest");
            try
            {
                // Camera2DSetup-free: use a component with a public array field. ParticleSystem
                // lacks a simple array; instead drive through an ad-hoc component is not allowed
                // in EditMode tests, so target a built-in array: LineRenderer positions.
                var lr = go.AddComponent<LineRenderer>();
                lr.positionCount = 3;
                lr.SetPosition(0, new Vector3(0, 0, 0));
                lr.SetPosition(1, new Vector3(1, 1, 0));
                lr.SetPosition(2, new Vector3(2, 2, 0));

                JArray props = PropertyIntrospector.DescribeProperties(lr);

                // Find any descriptor flagged isArray (LineRenderer serializes m_Positions).
                JObject arrayProp = null;
                foreach (JToken t in props)
                {
                    JObject o = t as JObject;
                    if (o != null && o.Value<bool?>("isArray") == true)
                    {
                        arrayProp = o;
                        break;
                    }
                }

                Assert.IsNotNull(arrayProp, "An array property should be flagged isArray with expansion");
                Assert.GreaterOrEqual(arrayProp.Value<int>("arraySize"), 0);
                Assert.IsNotNull(arrayProp["elements"], "Array descriptor should include an elements summary");
                Assert.IsInstanceOf<JArray>(arrayProp["elements"]);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        private static JObject FindByPath(JArray props, string serializedPath)
        {
            foreach (JToken t in props)
            {
                JObject o = t as JObject;
                if (o != null && o.Value<string>("serializedPath") == serializedPath)
                    return o;
            }
            return null;
        }

        // ─────────────────────────────────────────────
        // DescribePublicProperties (RCL-T10) Tests
        // ─────────────────────────────────────────────

        /// <summary>A component whose live state is a public PROPERTY with no [SerializeField] backing.</summary>
        private sealed class HealthFixture : MonoBehaviour
        {
            public int Current { get; set; } = 7;
            public float Ratio => 0.5f;
            public bool IsAlive => Current > 0;
            public Vector3 LastHitDirection { get; set; } = new Vector3(1f, 2f, 3f);
            // An object-returning getter must NOT be read (side-effect / non-simple): a property that
            // would throw if invoked, to prove the reader never touches object-typed getters.
            public Transform Buddy { get { throw new InvalidOperationException("must not be read"); } }
        }

        [Test]
        public void DescribePublicProperties_ReadsPublicProperty_WithoutSerializeField()
        {
            var go = new GameObject("HealthGO");
            try
            {
                var health = go.AddComponent<HealthFixture>();
                health.Current = 42;

                JArray props = PropertyIntrospector.DescribePublicProperties(health);
                JObject current = FindByName(props, "Current");

                Assert.IsNotNull(current, "Public property 'Current' should be surfaced");
                Assert.AreEqual(42, current.Value<int>("value"));
                Assert.AreEqual("Int32", current.Value<string>("type"));

                // A computed bool/float property is also readable.
                Assert.IsNotNull(FindByName(props, "IsAlive"));
                Assert.AreEqual(true, FindByName(props, "IsAlive").Value<bool>("value"));
                Assert.AreEqual(0.5f, FindByName(props, "Ratio").Value<float>("value"), 1e-4f);

                // A Vector3 property is surfaced as {x,y,z}.
                JObject dir = FindByName(props, "LastHitDirection");
                Assert.IsNotNull(dir);
                JObject v = dir.Value<JObject>("value");
                Assert.AreEqual(1f, v.Value<float>("x"), 1e-4f);
                Assert.AreEqual(3f, v.Value<float>("z"), 1e-4f);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void DescribePublicProperties_SkipsObjectReturningGetters()
        {
            var go = new GameObject("HealthGO");
            try
            {
                var health = go.AddComponent<HealthFixture>();
                // Must not throw even though Buddy's getter throws — object-typed getters are filtered
                // out BEFORE invocation, so the side-effecting/throwing getter is never read.
                JArray props = PropertyIntrospector.DescribePublicProperties(health);
                Assert.IsNull(FindByName(props, "Buddy"), "Object-returning getter must be skipped, not read");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        private static JObject FindByName(JArray props, string name)
        {
            foreach (JToken t in props)
            {
                JObject o = t as JObject;
                if (o != null && o.Value<string>("name") == name)
                    return o;
            }
            return null;
        }
    }
}
