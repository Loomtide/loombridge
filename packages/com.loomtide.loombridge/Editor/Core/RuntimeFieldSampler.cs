using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Introspection;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// L3a per-tick runtime-member sampling for runtime.capture_input_motion.
    ///
    /// The in-loop motion sampler records transform.position and nothing else; the L3
    /// cross-modal sync metrics need a NON-transform signal (a sound firing, a particle
    /// spawning) timelined on the SAME deterministic tick clock as the position samples.
    /// Those signals are runtime-only API (AudioSource.isPlaying,
    /// ParticleSystem.particleCount/isEmitting) — NOT serialized fields, so
    /// PropertyIntrospector.DescribeProperties (SerializedObject iteration) cannot read
    /// them. This sampler resolves a plain reflected PropertyInfo/FieldInfo getter — OR a
    /// scalar-returning METHOD getter (L3a.1: `Animator.GetBool("jumping")`, a signal with no
    /// readable field) — on the live component instance ONCE at capture start, then invokes it
    /// per tick.
    ///
    /// Honest-or-omit: a field that cannot be resolved (no GameObject / no component / no
    /// member / non-scalar member) is recorded with a reason and never sampled — it never
    /// fabricates a 0/false value.
    ///
    /// Reflection (the resolved getter + the scalar-type guard) is pure and editor-only;
    /// it is exercised by RuntimeFieldSamplerTests in EditMode WITHOUT Play Mode. The
    /// per-tick INVOCATION inside the play-mode capture loop is only provable on a live
    /// bridge.
    /// </summary>
    public sealed class RuntimeFieldSampler
    {
        /// <summary>The caller-supplied id echoed back in the response timeline.</summary>
        public string Id { get; }

        /// <summary>
        /// Non-null when the field could NOT be resolved: the honest reason. When set, the
        /// field is reported with this reason and is NEVER sampled.
        /// </summary>
        public string UnresolvedReason { get; }

        public bool IsResolved => UnresolvedReason == null && _getter != null;

        private readonly Func<object> _getter;          // reads the live member value
        private readonly Func<object, JToken> _toScalar; // coerces it to a JSON scalar
        private readonly List<JObject> _samples = new List<JObject>(2048);
        private string _readError;                       // set if a getter threw mid-capture

        private RuntimeFieldSampler(string id, Func<object> getter, Func<object, JToken> toScalar)
        {
            Id = id;
            _getter = getter;
            _toScalar = toScalar;
        }

        private RuntimeFieldSampler(string id, string unresolvedReason)
        {
            Id = id;
            UnresolvedReason = unresolvedReason;
        }

        /// <summary>
        /// Resolves a single sampledFields spec to a sampler. Two getter shapes are supported:
        ///   { id, locator, type_name, property_path }          — a public property/field
        ///   { id, locator, type_name, method_name, args:[...] } — a public scalar-returning method
        /// The method form is L3a.1: a signal that is ONLY reachable through a method call, e.g. a
        /// Unity Animator parameter (`Animator.GetBool("jumping")` — there is no `jumping` field to
        /// read). Resolution is done ONCE; the per-tick read just invokes the cached getter. Any
        /// failure yields an UNRESOLVED sampler carrying a reason (never throws for a missing GO /
        /// component / member / method — those are honest-or-omit data, not errors).
        ///
        /// <paramref name="resolveGameObject"/> is injected so this stays decoupled from the
        /// editor-only LocatorResolver (and so tests can resolve a fixture GameObject directly).
        /// </summary>
        public static RuntimeFieldSampler Resolve(JObject spec, Func<JObject, GameObject> resolveGameObject)
        {
            string methodName = spec?.Value<string>("method_name");
            string propertyPath = spec?.Value<string>("property_path");

            string id = spec?.Value<string>("id");
            if (string.IsNullOrEmpty(id))
                id = propertyPath ?? methodName ?? "field";

            string typeName = spec?.Value<string>("type_name");

            if (string.IsNullOrEmpty(typeName))
                return new RuntimeFieldSampler(id, "missing 'type_name'");
            if (string.IsNullOrEmpty(methodName) && string.IsNullOrEmpty(propertyPath))
                return new RuntimeFieldSampler(id, "missing 'property_path' or 'method_name'");
            // property_path and method_name are mutually exclusive. The schema can't express
            // an XOR, so enforce it HERE (the single chokepoint both transports flow through) —
            // refuse rather than silently preferring one, so a spec that names both is a visible
            // UNRESOLVED, not a sample of the wrong member.
            if (!string.IsNullOrEmpty(methodName) && !string.IsNullOrEmpty(propertyPath))
                return new RuntimeFieldSampler(id,
                    "specify EITHER 'property_path' OR 'method_name', not both");

            JObject locator = spec?.Value<JObject>("locator");
            if (locator == null)
                return new RuntimeFieldSampler(id, "missing 'locator'");

            GameObject go;
            try
            {
                go = resolveGameObject(locator);
            }
            catch (Exception ex)
            {
                return new RuntimeFieldSampler(id, $"locator unresolved: {ex.Message}");
            }
            if (go == null)
                return new RuntimeFieldSampler(id, "locator resolved to no GameObject");

            Type componentType = PropertyIntrospector.ResolveComponentType(typeName);
            if (componentType == null)
                return new RuntimeFieldSampler(id, $"component type '{typeName}' not found");

            Component component = go.GetComponent(componentType);
            if (component == null)
                return new RuntimeFieldSampler(id, $"component '{typeName}' not present on GameObject");

            if (!string.IsNullOrEmpty(methodName))
                return BuildMethodSampler(id, component, componentType, methodName, spec?.Value<JArray>("args"));

            return BuildMemberSampler(id, component, componentType, propertyPath);
        }

        /// <summary>
        /// Builds the reflected getter for a public instance METHOD named <paramref name="methodName"/>
        /// that returns a JSON scalar (bool / integral / floating / enum), invoked with literal
        /// <paramref name="args"/> bound ONCE at resolve time. The canonical use is a Unity Animator
        /// parameter read — `Animator.GetBool("jumping")` — where the signal has no readable field.
        ///
        /// Overload resolution is by ARGUMENT COUNT + JSON-token kind: among public instance methods
        /// of that name, an overload BINDS when its parameter count matches and every parameter
        /// accepts its JSON arg (string→string, bool→bool, integer→integral/float/enum, float→float)
        /// AND its return type is a JSON scalar. A void / non-scalar return never binds — which
        /// naturally rejects mutators like SetBool (void). If EXACTLY ONE overload binds it is
        /// chosen; if MORE THAN ONE binds the spec is AMBIGUOUS and UNRESOLVED (we refuse rather
        /// than let unspecified GetMethods() order pick — honest-or-omit over a coin-flip). Args are
        /// coerced ONCE; the per-tick read re-invokes with the SAME bound argument objects.
        ///
        /// The method MUST be a pure read-only getter: it is invoked every tick, so a side-effecting
        /// method (even one returning a scalar) would mutate the very capture it samples. Reflection
        /// can't prove purity; the caller is responsible for naming a getter (the void guard only
        /// stops the obvious void mutators).
        /// </summary>
        private static RuntimeFieldSampler BuildMethodSampler(
            string id, Component component, Type componentType, string methodName, JArray args)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;
            var argTokens = args ?? new JArray();

            // Reasons are ranked so the reported message is the most useful when nothing binds:
            // a non-scalar/void RETURN (the mutator-rejection case) outranks an arg mismatch, which
            // outranks an arg-count mismatch. Without this, SetBool(string,bool)/(int,bool) called
            // with one arg would report "takes 2 args" instead of surfacing the void return.
            string countReason = null, argReason = null, returnReason = null;
            bool sawNameMatch = false;

            MethodInfo chosen = null;
            object[] chosenArgs = null;
            Func<object, JToken> chosenCoercer = null;
            int bindCount = 0;

            foreach (MethodInfo m in componentType.GetMethods(flags))
            {
                if (m.Name != methodName)
                    continue;
                sawNameMatch = true;

                ParameterInfo[] ps = m.GetParameters();
                if (ps.Length != argTokens.Count)
                {
                    countReason = $"method '{methodName}' overload takes {ps.Length} arg(s), {argTokens.Count} supplied";
                    continue;
                }

                // Coerce every JSON arg to its parameter type by token kind; a method that takes a
                // ref/out parameter is unsupported (we can't supply one honestly).
                object[] candidate = new object[ps.Length];
                bool ok = true;
                for (int i = 0; i < ps.Length; i++)
                {
                    if (ps[i].ParameterType.IsByRef)
                    {
                        ok = false;
                        argReason = $"method '{methodName}' has a by-ref parameter (unsupported)";
                        break;
                    }
                    if (!TryCoerceArg(argTokens[i], ps[i].ParameterType, out candidate[i], out string why))
                    {
                        ok = false;
                        argReason = $"arg {i} for '{methodName}' {why}";
                        break;
                    }
                }
                if (!ok)
                    continue;

                Func<object, JToken> retCoercer = ScalarCoercerFor(m.ReturnType);
                if (retCoercer == null)
                {
                    returnReason = $"method '{methodName}' returns '{m.ReturnType.Name}', not a JSON scalar (bool/integer/float/enum)";
                    continue;
                }

                // A fully-bindable scalar-returning overload. Don't take the first — count them, so
                // an ambiguous spec (two overloads accepting the SAME token kind, e.g. Foo(long) /
                // Foo(double) on an integer arg) is REFUSED rather than resolved by reflection order.
                bindCount++;
                if (chosen == null)
                {
                    chosen = m;
                    chosenArgs = candidate;
                    chosenCoercer = retCoercer;
                }
            }

            if (bindCount == 1)
            {
                MethodInfo method = chosen;
                object[] boundArgs = chosenArgs;
                Func<object> getter = () => method.Invoke(component, boundArgs);
                return new RuntimeFieldSampler(id, getter, chosenCoercer);
            }
            if (bindCount > 1)
                return new RuntimeFieldSampler(id,
                    $"'{methodName}' is ambiguous: {bindCount} overloads bind these args — qualify the args to disambiguate");

            if (!sawNameMatch)
                return new RuntimeFieldSampler(id,
                    $"no public instance method '{methodName}' on '{componentType.Name}'");
            return new RuntimeFieldSampler(id,
                returnReason ?? argReason ?? countReason
                    ?? $"no usable overload of '{methodName}' on '{componentType.Name}'");
        }

        /// <summary>
        /// Coerces a JSON arg token to a method parameter type, matching by token KIND so overload
        /// resolution is deterministic (a string token never silently satisfies an int parameter).
        /// Supported parameter types: string, bool, integral, float/double/decimal, enum (by
        /// underlying integer or by name). Returns false with a reason for anything else.
        /// </summary>
        private static bool TryCoerceArg(JToken token, Type paramType, out object value, out string reason)
        {
            value = null;
            reason = null;
            Type t = Nullable.GetUnderlyingType(paramType) ?? paramType;
            JTokenType kind = token?.Type ?? JTokenType.Null;

            try
            {
                if (t == typeof(string))
                {
                    if (kind != JTokenType.String) { reason = $"expects a string, got {kind}"; return false; }
                    value = token.Value<string>();
                    return true;
                }
                if (t == typeof(bool))
                {
                    if (kind != JTokenType.Boolean) { reason = $"expects a bool, got {kind}"; return false; }
                    value = token.Value<bool>();
                    return true;
                }
                if (t.IsEnum)
                {
                    if (kind == JTokenType.Integer) { value = Enum.ToObject(t, token.Value<long>()); return true; }
                    if (kind == JTokenType.String) { value = Enum.Parse(t, token.Value<string>()); return true; }
                    reason = $"expects enum '{t.Name}' (integer or name), got {kind}";
                    return false;
                }
                if (t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort) ||
                    t == typeof(int) || t == typeof(uint) || t == typeof(long) || t == typeof(ulong))
                {
                    if (kind != JTokenType.Integer) { reason = $"expects an integer, got {kind}"; return false; }
                    value = Convert.ChangeType(token.Value<long>(), t);
                    return true;
                }
                if (t == typeof(float) || t == typeof(double) || t == typeof(decimal))
                {
                    if (kind != JTokenType.Integer && kind != JTokenType.Float)
                    { reason = $"expects a number, got {kind}"; return false; }
                    value = Convert.ChangeType(token.Value<double>(), t);
                    return true;
                }
            }
            catch (Exception ex)
            {
                reason = $"could not convert {kind} to '{t.Name}': {ex.Message}";
                return false;
            }

            reason = $"parameter type '{t.Name}' is unsupported (only string/bool/number/enum args)";
            return false;
        }

        /// <summary>
        /// Builds the reflected getter for a public instance PropertyInfo (with a getter)
        /// OR FieldInfo named <paramref name="propertyPath"/>, guarded to JSON-scalar member
        /// types (bool / integral / floating / enum). A non-scalar member is UNRESOLVED.
        /// </summary>
        private static RuntimeFieldSampler BuildMemberSampler(
            string id, Component component, Type componentType, string propertyPath)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;

            Type memberType;
            Func<object> getter;

            PropertyInfo prop = componentType.GetProperty(propertyPath, flags);
            if (prop != null)
            {
                if (!prop.CanRead || prop.GetGetMethod() == null)
                    return new RuntimeFieldSampler(id, $"property '{propertyPath}' has no public getter");
                if (prop.GetIndexParameters().Length != 0)
                    return new RuntimeFieldSampler(id, $"property '{propertyPath}' is an indexer (unsupported)");
                memberType = prop.PropertyType;
                getter = () => prop.GetValue(component, null);
            }
            else
            {
                FieldInfo field = componentType.GetField(propertyPath, flags);
                if (field == null)
                    return new RuntimeFieldSampler(id,
                        $"no public instance property or field '{propertyPath}' on '{componentType.Name}'");
                memberType = field.FieldType;
                getter = () => field.GetValue(component);
            }

            // Reject a NULLABLE scalar at resolve time: a null read would otherwise become
            // an in-band `null` sample indistinguishable from a real value (the same
            // fabricated-reading hazard the readError path eliminates for throws). Keeping
            // "resolved ⇒ never an in-band null" airtight. (A future need could add a
            // per-sample null flag; no real L3 signal is a nullable scalar.)
            if (Nullable.GetUnderlyingType(memberType) != null)
                return new RuntimeFieldSampler(id,
                    $"member '{propertyPath}' is a nullable scalar ('{memberType.Name}') — a null read can't be honestly distinguished from a real value (unsupported)");

            Func<object, JToken> toScalar = ScalarCoercerFor(memberType);
            if (toScalar == null)
                return new RuntimeFieldSampler(id,
                    $"member '{propertyPath}' type '{memberType.Name}' is not a JSON scalar (bool/integer/float/enum)");

            return new RuntimeFieldSampler(id, getter, toScalar);
        }

        /// <summary>
        /// Returns a coercer producing a JSON scalar (bool -> bool, integral/float -> number,
        /// enum -> underlying integral number) for the member type, or null if the type is
        /// not a supported scalar. This is the scalar-type guard — anything non-scalar
        /// (string, Vector3, object reference, struct, ...) is rejected at resolve time so a
        /// non-scalar value is NEVER recorded.
        /// </summary>
        public static Func<object, JToken> ScalarCoercerFor(Type type)
        {
            if (type == null)
                return null;

            Type t = Nullable.GetUnderlyingType(type) ?? type;

            if (t.IsEnum)
                return v => v == null ? JValue.CreateNull() : new JValue(Convert.ToInt64(v));

            if (t == typeof(bool))
                return v => v == null ? JValue.CreateNull() : new JValue((bool)v);

            if (t == typeof(byte) || t == typeof(sbyte) ||
                t == typeof(short) || t == typeof(ushort) ||
                t == typeof(int) || t == typeof(uint) ||
                t == typeof(long))
                return v => v == null ? JValue.CreateNull() : new JValue(Convert.ToInt64(v));

            if (t == typeof(ulong))
                return v => v == null ? JValue.CreateNull() : new JValue(Convert.ToUInt64(v));

            if (t == typeof(float) || t == typeof(double))
                return v => v == null ? JValue.CreateNull() : new JValue(Convert.ToDouble(v));

            if (t == typeof(decimal))
                return v => v == null ? JValue.CreateNull() : new JValue(Convert.ToDouble(v));

            return null;
        }

        /// <summary>
        /// Reads the live member and appends a { tMs, value } sample on the position clock.
        /// No-op for an UNRESOLVED or already-read-errored field. A getter that throws at
        /// read time flags the field with a readError and stops sampling (never appends a
        /// misleading in-band null) — the field is reported degraded, not silently clean.
        /// </summary>
        public void SampleTick(double tMs)
        {
            if (!IsResolved || _readError != null)
                return;

            JToken value;
            try
            {
                value = _toScalar(_getter());
            }
            catch (Exception ex)
            {
                // A read-time throw must NOT become an in-band null among real values — a
                // downstream sync gate would coerce null→false/0 (a fabricated reading) with
                // no signal it's degraded. Flag the whole field with a readError and STOP
                // sampling it: honest-or-omit at the field level, so L3b refuses it.
                // Both getter shapes throw THROUGH reflection — PropertyInfo.GetValue and
                // MethodInfo.Invoke wrap the getter's own throw in a TargetInvocationException —
                // so unwrap it to surface the REAL cause, not the generic reflection wrapper.
                Exception cause = (ex is TargetInvocationException tie && tie.InnerException != null)
                    ? tie.InnerException
                    : ex;
                _readError = $"read failed at tMs {System.Math.Round(tMs, 2)}: {cause.Message}";
                return;
            }

            _samples.Add(new JObject
            {
                ["tMs"] = System.Math.Round(tMs, 2),
                ["value"] = value
            });
        }

        /// <summary>
        /// Builds this field's timeline entry: { id, samples:[{tMs,value}] } for a resolved
        /// field, or { id, samples:[], unresolved: reason } for an unresolved one.
        /// </summary>
        public JObject ToTimelineEntry()
        {
            var entry = new JObject { ["id"] = Id };

            if (!IsResolved)
            {
                entry["samples"] = new JArray();
                entry["unresolved"] = UnresolvedReason ?? "unresolved";
                return entry;
            }

            var arr = new JArray();
            foreach (JObject s in _samples)
                arr.Add(s);
            entry["samples"] = arr;
            // A getter that threw mid-capture flags the field as degraded (the samples
            // collected before the throw are honest, but the field is incomplete) so a
            // downstream gate treats it as untrusted rather than reading the stream as clean.
            if (_readError != null)
                entry["readError"] = _readError;
            return entry;
        }
    }
}
