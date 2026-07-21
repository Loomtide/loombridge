using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode tests for L3a per-tick runtime-member sampling (RuntimeFieldSampler), the
    /// generic reflected getter behind capture_input_motion's sampledFields. These exercise
    /// the resolve-once reflection + scalar-type guard + per-tick sample + honest-or-omit
    /// unresolved reporting WITHOUT Play Mode (the reflection is pure). The in-loop
    /// invocation inside the live capture loop is only provable on a real bridge in Play Mode.
    /// </summary>
    [TestFixture]
    public class RuntimeFieldSamplerTests
    {
        /// <summary>Fixture component with runtime-readable scalar members to drive across ticks.</summary>
        private class SampleProbe : MonoBehaviour
        {
            public bool flag;            // public field (bool scalar)
            public int counter;          // public field (int scalar)
            public Vector3 vec;          // non-scalar field -> must be UNRESOLVED
            public float Speed { get; set; }       // public property (float scalar)
            public KeyCode key;          // enum field -> underlying number
            private bool _hidden;        // non-public -> not found
            public bool Hidden => _hidden;
            public bool Throws => throw new System.InvalidOperationException("boom"); // getter throws at read time
            public bool? maybeFlag;      // nullable scalar -> must be UNRESOLVED (a null read can't be in-band)
        }

        private GameObject _go;
        private SampleProbe _probe;

        [SetUp]
        public void SetUp()
        {
            _go = new GameObject("RuntimeFieldSamplerFixture");
            _probe = _go.AddComponent<SampleProbe>();
        }

        [TearDown]
        public void TearDown()
        {
            if (_go != null)
                Object.DestroyImmediate(_go);
        }

        // Resolve helper that returns the fixture GameObject (locator value is irrelevant here;
        // RuntimeFieldSampler injects the resolver so we bypass the editor-only LocatorResolver).
        private System.Func<JObject, GameObject> ResolveToFixture() => _ => _go;

        private static JObject Spec(string id, string typeName, string propertyPath)
        {
            return new JObject
            {
                ["id"] = id,
                ["locator"] = new JObject { ["path"] = "ignored" },
                ["type_name"] = typeName,
                ["property_path"] = propertyPath,
            };
        }

        [Test]
        public void BoolField_SamplesValuePerTickOnPositionClock()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("flag", "SampleProbe", "flag"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            _probe.flag = false;
            sampler.SampleTick(0);
            _probe.flag = true;
            sampler.SampleTick(16.0);
            sampler.SampleTick(32.0);

            JObject entry = sampler.ToTimelineEntry();
            Assert.AreEqual("flag", entry.Value<string>("id"));
            Assert.IsNull(entry["unresolved"], "a resolved field has no unresolved reason");

            JArray s = entry.Value<JArray>("samples");
            Assert.AreEqual(3, s.Count);
            Assert.AreEqual(0.0, s[0].Value<double>("tMs"), 1e-9);
            Assert.AreEqual(false, s[0].Value<bool>("value"));
            Assert.AreEqual(16.0, s[1].Value<double>("tMs"), 1e-9);
            Assert.AreEqual(true, s[1].Value<bool>("value"));
            Assert.AreEqual(true, s[2].Value<bool>("value"));
        }

        [Test]
        public void IntField_RecordsNumberValues()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("counter", "SampleProbe", "counter"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            _probe.counter = 5;
            sampler.SampleTick(0);
            _probe.counter = 7;
            sampler.SampleTick(10);

            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(5, s[0].Value<int>("value"));
            Assert.AreEqual(7, s[1].Value<int>("value"));
        }

        [Test]
        public void FloatProperty_IsSampled()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("speed", "SampleProbe", "Speed"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            _probe.Speed = 3.5f;
            sampler.SampleTick(0);

            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(3.5, s[0].Value<double>("value"), 1e-6);
        }

        [Test]
        public void EnumField_RecordsUnderlyingNumber()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("key", "SampleProbe", "key"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            _probe.key = KeyCode.Space;
            sampler.SampleTick(0);

            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual((long)KeyCode.Space, s[0].Value<long>("value"));
        }

        [Test]
        public void BogusPropertyPath_IsUnresolvedWithReason_NotFabricated()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("bogus", "SampleProbe", "nonexistentMember"), ResolveToFixture());

            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("nonexistentMember", sampler.UnresolvedReason);

            // It must NOT sample, and must NOT fabricate a 0/false.
            sampler.SampleTick(0);
            JObject entry = sampler.ToTimelineEntry();
            Assert.AreEqual("bogus", entry.Value<string>("id"));
            Assert.AreEqual(0, entry.Value<JArray>("samples").Count, "an unresolved field records no samples");
            Assert.IsNotNull(entry["unresolved"]);
            StringAssert.Contains("nonexistentMember", entry.Value<string>("unresolved"));
        }

        [Test]
        public void ReadTimeThrow_FlagsReadError_NoInBandNull()
        {
            // The getter resolves (it's a bool property) but THROWS when read. A read-time
            // throw must NOT append an in-band null among real values — it flags the field
            // with a readError and stops sampling, so a downstream sync gate refuses it
            // rather than coercing null→false (a fabricated reading).
            var sampler = RuntimeFieldSampler.Resolve(Spec("throws", "SampleProbe", "Throws"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, "the bool property resolves; the failure is at READ time, not resolution");

            sampler.SampleTick(0);
            sampler.SampleTick(16.0);
            JObject entry = sampler.ToTimelineEntry();

            Assert.IsNotNull(entry["readError"], "a read-time throw must surface a readError");
            StringAssert.Contains("boom", entry.Value<string>("readError"));
            // No fabricated in-band samples: every recorded sample (if any) is a real read,
            // never a null standing in for a failed read.
            foreach (JObject s in entry.Value<JArray>("samples"))
                Assert.AreNotEqual(JTokenType.Null, s["value"].Type, "no in-band null sample");
        }

        [Test]
        public void NonScalarMember_IsUnresolved()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("vec", "SampleProbe", "vec"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved, "a Vector3 field is not a JSON scalar");
            StringAssert.Contains("not a JSON scalar", sampler.UnresolvedReason);
        }

        [Test]
        public void NullableScalarMember_IsUnresolved_NoInBandNull()
        {
            // A nullable scalar would let a null read become an in-band null sample
            // indistinguishable from a real value — rejected at resolve time.
            var sampler = RuntimeFieldSampler.Resolve(Spec("maybe", "SampleProbe", "maybeFlag"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved, "a nullable scalar must not resolve");
            StringAssert.Contains("nullable scalar", sampler.UnresolvedReason);
        }

        [Test]
        public void NonPublicMember_IsUnresolved()
        {
            var sampler = RuntimeFieldSampler.Resolve(Spec("hidden", "SampleProbe", "_hidden"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved, "a private field must not resolve");
        }

        [Test]
        public void MissingComponent_IsUnresolvedWithReason()
        {
            // AudioSource is a real, resolvable type but is NOT on the fixture GameObject.
            var sampler = RuntimeFieldSampler.Resolve(Spec("sfx", "AudioSource", "isPlaying"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("not present", sampler.UnresolvedReason);
        }

        [Test]
        public void AudioSource_IsPlaying_ResolvesAsRuntimeMember()
        {
            // The canonical L3a signal: AudioSource.isPlaying is a runtime-only property
            // (not a serialized field) — proves the reflected getter reaches it.
            _go.AddComponent<AudioSource>();
            var sampler = RuntimeFieldSampler.Resolve(Spec("sfx", "AudioSource", "isPlaying"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            sampler.SampleTick(0); // not playing in edit mode -> false, honestly read
            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(1, s.Count);
            Assert.AreEqual(false, s[0].Value<bool>("value"));
        }

        [Test]
        public void MissingTypeOrPath_IsUnresolved()
        {
            var noType = RuntimeFieldSampler.Resolve(
                new JObject { ["id"] = "x", ["locator"] = new JObject(), ["property_path"] = "flag" },
                ResolveToFixture());
            Assert.IsFalse(noType.IsResolved);
            StringAssert.Contains("type_name", noType.UnresolvedReason);

            // Neither property_path NOR method_name supplied -> unresolved naming both options.
            var noMember = RuntimeFieldSampler.Resolve(
                new JObject { ["id"] = "x", ["locator"] = new JObject(), ["type_name"] = "SampleProbe" },
                ResolveToFixture());
            Assert.IsFalse(noMember.IsResolved);
            StringAssert.Contains("property_path", noMember.UnresolvedReason);
            StringAssert.Contains("method_name", noMember.UnresolvedReason);
        }

        // ---- L3a.1 method-getter path (e.g. Animator.GetBool("jumping")) ----

        /// <summary>Fixture component exposing scalar-returning methods (the GetBool analog).</summary>
        private class MethodProbe : MonoBehaviour
        {
            private readonly System.Collections.Generic.Dictionary<string, bool> _bools =
                new System.Collections.Generic.Dictionary<string, bool>();
            public void SetFlag(string name, bool v) { _bools[name] = v; }

            // Overloaded read: by name (string) and by id (int) — mirrors Animator.GetBool.
            public bool GetFlag(string name) => _bools.TryGetValue(name, out bool v) && v;
            public bool GetFlag(int id) => false;

            public int CountFor(string name) => name == null ? -1 : name.Length;     // scalar (int) return
            public void Mutate(string name) { _bools[name] = true; }                  // void return -> rejected
            public Vector3 VecFor(string name) => Vector3.up;                          // non-scalar return -> rejected
            public bool NoArg() => true;                                               // zero-arg scalar method

            // Two scalar-returning overloads that BOTH bind an integer token (long & double accept
            // an integer kind) -> the spec is ambiguous and must be refused, not resolved by order.
            public long Ambig(long x) => x;
            public double Ambig(double x) => x;

            // A scalar getter that THROWS at invocation -> readError flagged (unwrapped cause), stops.
            public bool ThrowsMethod(string name) => throw new System.InvalidOperationException("kaboom");

            // Enum arg in, enum return out (enum coerces to/from the underlying integer).
            public KeyCode EnumReturn(int i) => i == 0 ? KeyCode.Space : KeyCode.A;
            public int EnumArg(KeyCode k) => (int)k;
        }

        private static JObject MethodSpec(string id, string typeName, string methodName, params object[] args)
        {
            var a = new JArray();
            foreach (object x in args) a.Add(x);
            return new JObject
            {
                ["id"] = id,
                ["locator"] = new JObject { ["path"] = "ignored" },
                ["type_name"] = typeName,
                ["method_name"] = methodName,
                ["args"] = a,
            };
        }

        [Test]
        public void MethodGetter_BoolByStringArg_SamplesPerTick()
        {
            var mp = _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("jumping", "MethodProbe", "GetFlag", "jumping"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            mp.SetFlag("jumping", false);
            sampler.SampleTick(0);
            mp.SetFlag("jumping", true);
            sampler.SampleTick(16.0);

            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(2, s.Count);
            Assert.AreEqual(false, s[0].Value<bool>("value"));
            Assert.AreEqual(true, s[1].Value<bool>("value"));
        }

        [Test]
        public void MethodGetter_OverloadResolvesByArgKind_StringNotInt()
        {
            // GetFlag has (string) and (int) overloads; a STRING arg must bind to the (string)
            // overload (the int overload's coercion fails), not silently pick the wrong one.
            var mp = _go.AddComponent<MethodProbe>();
            mp.SetFlag("moving", true);
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("moving", "MethodProbe", "GetFlag", "moving"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            sampler.SampleTick(0);
            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(true, s[0].Value<bool>("value"), "string arg must bind GetFlag(string), which sees the set flag");
        }

        [Test]
        public void MethodGetter_IntReturn_IsSampledAsNumber()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("len", "MethodProbe", "CountFor", "abcd"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            sampler.SampleTick(0);
            Assert.AreEqual(4, sampler.ToTimelineEntry().Value<JArray>("samples")[0].Value<int>("value"));
        }

        [Test]
        public void MethodGetter_ZeroArg_Resolves()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("noarg", "MethodProbe", "NoArg"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);
            sampler.SampleTick(0);
            Assert.AreEqual(true, sampler.ToTimelineEntry().Value<JArray>("samples")[0].Value<bool>("value"));
        }

        [Test]
        public void MethodGetter_VoidReturn_IsUnresolved_RejectsMutators()
        {
            // A void method (SetBool analog) is not a scalar getter — it must be UNRESOLVED so a
            // mutator can never be invoked per-tick as if it read a value.
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("mut", "MethodProbe", "Mutate", "jumping"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("not a JSON scalar", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_NonScalarReturn_IsUnresolved()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("vec", "MethodProbe", "VecFor", "x"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("not a JSON scalar", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_WrongArgCount_IsUnresolvedWithReason()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("jumping", "MethodProbe", "GetFlag" /* no args */), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("arg", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_WrongArgType_IsUnresolved()
        {
            // GetFlag(string)/(int) — a BOOL arg matches neither overload's parameter kind.
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("jumping", "MethodProbe", "GetFlag", true), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
        }

        [Test]
        public void MethodGetter_MissingMethod_IsUnresolvedWithReason()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("x", "MethodProbe", "NoSuchMethod", "a"), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved);
            StringAssert.Contains("NoSuchMethod", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_AmbiguousOverload_IsRefused_NotOrderResolved()
        {
            // Ambig(long)/Ambig(double) BOTH accept an integer token; binding by reflection order
            // would be a coin-flip, so the spec must be REFUSED as ambiguous (honest-or-omit).
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("amb", "MethodProbe", "Ambig", 5), ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved, "two overloads bind an integer arg -> ambiguous, must not resolve");
            StringAssert.Contains("ambiguous", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_ReadTimeThrow_FlagsReadError_UnwrappedCause()
        {
            // A method getter that throws at invocation must flag readError and STOP sampling, and
            // the message must carry the REAL cause ('kaboom'), not the reflection wrapper
            // ("Exception has been thrown by the target of an invocation.") — MethodInfo.Invoke wraps.
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("boom", "MethodProbe", "ThrowsMethod", "x"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, "resolves (bool return); the failure is at READ time");

            sampler.SampleTick(0);
            sampler.SampleTick(16.0);
            JObject entry = sampler.ToTimelineEntry();
            Assert.IsNotNull(entry["readError"], "a read-time throw must surface a readError");
            StringAssert.Contains("kaboom", entry.Value<string>("readError"));
            foreach (JObject s in entry.Value<JArray>("samples"))
                Assert.AreNotEqual(JTokenType.Null, s["value"].Type, "no in-band null sample");
        }

        [Test]
        public void MethodGetter_EnumReturn_RecordsUnderlyingNumber()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("ek", "MethodProbe", "EnumReturn", 0), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);
            sampler.SampleTick(0);
            Assert.AreEqual((long)KeyCode.Space, sampler.ToTimelineEntry().Value<JArray>("samples")[0].Value<long>("value"));
        }

        [Test]
        public void MethodGetter_EnumArg_ByUnderlyingInteger_Resolves()
        {
            _go.AddComponent<MethodProbe>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("ea", "MethodProbe", "EnumArg", (int)KeyCode.Space), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);
            sampler.SampleTick(0);
            Assert.AreEqual((int)KeyCode.Space, sampler.ToTimelineEntry().Value<JArray>("samples")[0].Value<int>("value"));
        }

        [Test]
        public void Resolve_BothPropertyPathAndMethodName_IsRefused()
        {
            // The two getter shapes are mutually exclusive; a spec naming both must be UNRESOLVED,
            // never a silent sample of whichever one wins (the P1 footgun).
            _go.AddComponent<MethodProbe>();
            var spec = MethodSpec("both", "MethodProbe", "NoArg");
            spec["property_path"] = "flag";
            var sampler = RuntimeFieldSampler.Resolve(spec, ResolveToFixture());
            Assert.IsFalse(sampler.IsResolved, "naming both property_path and method_name must be refused");
            StringAssert.Contains("not both", sampler.UnresolvedReason);
        }

        [Test]
        public void MethodGetter_Animator_GetBool_ResolvesOnRealUnityType()
        {
            // The canonical L3a.1 signal on a REAL Unity type: Animator.GetBool(string) is a
            // scalar-returning method with no backing field — proves the method getter reaches it.
            _go.AddComponent<Animator>();
            var sampler = RuntimeFieldSampler.Resolve(
                MethodSpec("jumping", "Animator", "GetBool", "jumping"), ResolveToFixture());
            Assert.IsTrue(sampler.IsResolved, sampler.UnresolvedReason);

            sampler.SampleTick(0); // no controller/param in edit mode -> false, honestly read
            JArray s = sampler.ToTimelineEntry().Value<JArray>("samples");
            Assert.AreEqual(1, s.Count);
            Assert.AreEqual(false, s[0].Value<bool>("value"));
        }
    }
}
