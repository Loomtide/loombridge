using System;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityEngine;
using UnityEngine.EventSystems;

namespace UnityBridge.Tests
{
    /// <summary>
    /// The observer resolves a clicked/dragged object's hierarchy path at GESTURE time
    /// via its own <c>BuildRuntimePath</c> (a runtime mirror of
    /// <c>LocatorResolver.GetHierarchyPathWithIndex</c>, so the reparent-path fix can run
    /// before the EventSystem processes a drop). The two builders are hand-cloned across
    /// an assembly boundary, so this pins the load-bearing contract: a path the observer
    /// emits RESOLVES BACK to the same GameObject through <c>LocatorResolver</c> — the
    /// real requirement — including duplicate-named siblings (the indexed-segment case).
    /// </summary>
    [TestFixture]
    public class InputObserverPathTests
    {
        private GameObject _root;
        private Type _pump;
        private MethodInfo _buildRuntimePath;

        [SetUp]
        public void SetUp()
        {
            _pump = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("UnityBridge.Runtime.InputObserverRuntimePump"))
                .FirstOrDefault(t => t != null);
            Assert.NotNull(_pump, "InputObserverRuntimePump type not found (observe runtime assembly not loaded).");
            _buildRuntimePath = _pump.GetMethod("BuildRuntimePath", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(_buildRuntimePath, "BuildRuntimePath(GameObject) not found on the observer.");
        }

        [TearDown]
        public void TearDown()
        {
            if (_root != null)
                UnityEngine.Object.DestroyImmediate(_root);
        }

        private string GesturePath(GameObject go) => (string)_buildRuntimePath.Invoke(null, new object[] { go });

        private static GameObject Child(GameObject parent, string name)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent.transform, false);
            return go;
        }

        private sealed class DragOnlyHandler : MonoBehaviour, IBeginDragHandler, IDragHandler
        {
            public void OnBeginDrag(PointerEventData eventData) { }

            public void OnDrag(PointerEventData eventData) { }
        }

        [Test]
        public void GestureTimePath_RoundTripsThroughResolver_UniqueNames()
        {
            _root = new GameObject("ObsPathRoot_Unique");
            GameObject leaf = Child(Child(_root, "A"), "Leaf");

            string path = GesturePath(leaf);
            GameObject resolved = LocatorResolver.Resolve(new JObject { ["path"] = path });

            Assert.AreSame(leaf, resolved, $"observer path '{path}' did not resolve back to the leaf");
        }

        [Test]
        public void GestureTimePath_RoundTripsThroughResolver_DuplicateSiblings()
        {
            _root = new GameObject("ObsPathRoot_Dup");
            GameObject first = Child(_root, "Item");
            GameObject second = Child(_root, "Item");

            string p0 = GesturePath(first);
            string p1 = GesturePath(second);

            Assert.AreNotEqual(p0, p1, "duplicate-named siblings must get distinct indexed paths");
            Assert.AreSame(first, LocatorResolver.Resolve(new JObject { ["path"] = p0 }), $"'{p0}' did not resolve to the first Item");
            Assert.AreSame(second, LocatorResolver.Resolve(new JObject { ["path"] = p1 }), $"'{p1}' did not resolve to the second Item");
        }

        /// <summary>
        /// The inert-tap filter's load-bearing decision: a tap routes to a pointer handler
        /// (kept) only when an interactive element is in its ancestry; a bare backdrop Image
        /// routes nowhere (dropped). Guards against a future change widening the filter to
        /// drop a real Button — the "no silent loss" bar. Mirrors how the EventSystem routes
        /// a click, so a `false` is exactly a tap that would do nothing in the game.
        /// </summary>
        [Test]
        public void RoutesToPointerHandler_KeepsButton_DropsBareBackdrop()
        {
            MethodInfo routes = _pump.GetMethod("RoutesToPointerHandler", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(routes, "RoutesToPointerHandler(GameObject) not found on the observer.");
            bool Routes(GameObject go) => (bool)routes.Invoke(null, new object[] { go });

            _root = new GameObject("InertTapRoot", typeof(RectTransform), typeof(Canvas));

            // A real button: its child label routes up to the Button's pointer handler.
            var button = new GameObject("Button", typeof(RectTransform), typeof(UnityEngine.UI.Image), typeof(UnityEngine.UI.Button));
            button.transform.SetParent(_root.transform, false);
            var label = new GameObject("Label", typeof(RectTransform), typeof(UnityEngine.UI.Text));
            label.transform.SetParent(button.transform, false);

            // A bare, raycast-catching backdrop with no handler — the inert case.
            var backdrop = new GameObject("Backdrop", typeof(RectTransform), typeof(UnityEngine.UI.Image));
            backdrop.transform.SetParent(_root.transform, false);

            Assert.IsTrue(Routes(label), "a tap on a button's child label must route to the Button handler (kept)");
            Assert.IsTrue(Routes(button), "a tap on the Button itself routes to its handler (kept)");
            Assert.IsFalse(Routes(backdrop), "a tap on a bare Image backdrop routes to no handler (dropped as inert)");
            Assert.IsFalse(Routes(null), "a null target routes nowhere");
        }

        /// <summary>
        /// The gesture-time state-signal buffer must exist and stay PARALLEL-LENGTH with the
        /// other recorded buffers: every Record() pushes exactly one entry to it, so a replay
        /// can index a click's precondition by the same i it uses for the path. Also pins the
        /// new getter's name (the Editor reflects it by string) and that a no-signal session
        /// records nulls (behaviour-identical to before the feature). Exercised by driving
        /// Record() directly via reflection, since the EventSystem path can't run headless.
        /// </summary>
        [Test]
        public void StateSignalBuffer_StaysParallel_AndDefaultsNull_WhenNoSignalDeclared()
        {
            MethodInfo begin = _pump.GetMethod(
                "BeginObserver",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(string), typeof(string), typeof(string) },
                null);
            Assert.NotNull(begin, "BeginObserver(string,string,string) not found — signal arity not wired.");

            MethodInfo end = _pump.GetMethod("EndObserver", BindingFlags.Public | BindingFlags.Static);
            MethodInfo getStateSignal = _pump.GetMethod("GetRecordedStateSignal", BindingFlags.Public | BindingFlags.Static);
            MethodInfo getPaths = _pump.GetMethod("GetRecordedPaths", BindingFlags.Public | BindingFlags.Static);
            MethodInfo getKinds = _pump.GetMethod("GetRecordedKinds", BindingFlags.Public | BindingFlags.Static);
            MethodInfo getTimes = _pump.GetMethod("GetRecordedTimesMs", BindingFlags.Public | BindingFlags.Static);
            MethodInfo record = _pump.GetMethod(
                "Record",
                BindingFlags.NonPublic | BindingFlags.Static,
                null,
                new[] { typeof(GameObject), typeof(GameObject), typeof(string), typeof(float) },
                null);
            Assert.NotNull(getStateSignal, "GetRecordedStateSignal() not found — getter name must match the Editor reflection string.");
            Assert.NotNull(record, "Record(GameObject,GameObject,string,float) not found.");

            try
            {
                // Begin WITHOUT a declared signal — sampling off, every entry must be null.
                begin.Invoke(null, new object[] { null, null, null });

                _root = new GameObject("StateSignalRoot");
                GameObject a = Child(_root, "A");
                GameObject b = Child(_root, "B");

                record.Invoke(null, new object[] { a, (GameObject)null, "ui", 10f });
                record.Invoke(null, new object[] { b, a, "ui", 20f });

                var paths = (string[])getPaths.Invoke(null, null);
                var kinds = (string[])getKinds.Invoke(null, null);
                var times = (float[])getTimes.Invoke(null, null);
                var signals = (string[])getStateSignal.Invoke(null, null);

                Assert.AreEqual(2, paths.Length, "two gestures recorded");
                Assert.AreEqual(paths.Length, signals.Length, "stateSignal buffer must be parallel to paths");
                Assert.AreEqual(paths.Length, kinds.Length, "kinds buffer must be parallel to paths");
                Assert.AreEqual(paths.Length, times.Length, "times buffer must be parallel to paths");
                Assert.IsNull(signals[0], "no signal declared → null precondition");
                Assert.IsNull(signals[1], "no signal declared → null precondition");
            }
            finally
            {
                end.Invoke(null, null);
            }

            // EndObserver must clear the new buffer alongside the rest.
            var afterEnd = (string[])getStateSignal.Invoke(null, null);
            Assert.AreEqual(0, afterEnd.Length, "EndObserver must clear the stateSignal buffer");
        }

        [Test]
        public void RoutesToDragHandler_KeepsDragOnlyElement_DropsButtonAndBareBackdrop()
        {
            MethodInfo routes = _pump.GetMethod("RoutesToDragHandler", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(routes, "RoutesToDragHandler(GameObject) not found on the observer.");
            bool Routes(GameObject go) => (bool)routes.Invoke(null, new object[] { go });

            _root = new GameObject("DragRouteRoot", typeof(RectTransform), typeof(Canvas));

            var dragOnly = new GameObject("DragOnly", typeof(RectTransform), typeof(UnityEngine.UI.Image), typeof(DragOnlyHandler));
            dragOnly.transform.SetParent(_root.transform, false);
            var dragChild = new GameObject("DragChild", typeof(RectTransform), typeof(UnityEngine.UI.Text));
            dragChild.transform.SetParent(dragOnly.transform, false);

            var button = new GameObject("Button", typeof(RectTransform), typeof(UnityEngine.UI.Image), typeof(UnityEngine.UI.Button));
            button.transform.SetParent(_root.transform, false);

            var backdrop = new GameObject("Backdrop", typeof(RectTransform), typeof(UnityEngine.UI.Image));
            backdrop.transform.SetParent(_root.transform, false);

            Assert.IsTrue(Routes(dragOnly), "a drag-only element must route to its drag handler");
            Assert.IsTrue(Routes(dragChild), "a child of a drag-only element must route up to the drag handler");
            Assert.IsFalse(Routes(button), "a plain Button has pointer handlers, but no drag handler");
            Assert.IsFalse(Routes(backdrop), "a bare Image backdrop routes to no drag handler");
            Assert.IsFalse(Routes(null), "a null target routes nowhere");
        }

        /// <summary>
        /// The generic-gesture primitives (Path A) ride parallel buffers next to the existing
        /// path/kind/time ones. This pins the buffer-parallelism invariant the TS consumer codes
        /// against: after BeginObserver (a clean session) every recorded-buffer getter returns the
        /// SAME length, and the three new getters exist with the EXACT names the Editor reflection
        /// wrapper looks up (GetRecordedTravelPx / GetRecordedReleaseNx / GetRecordedReleaseNy).
        /// We can't synthesize real input here, so this asserts the empty-session parallelism and
        /// getter presence; live validation covers the populated-buffer sentinel values.
        /// </summary>
        [Test]
        public void GenericGesturePrimitives_GettersExist_AndBuffersStayParallel()
        {
            float[] InvokeFloatGetter(string name)
            {
                MethodInfo m = _pump.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                Assert.NotNull(m, $"{name}() not found on the observer (must match the Editor StaticMethod lookup).");
                return (float[])m.Invoke(null, null);
            }
            string[] InvokeStringGetter(string name)
            {
                MethodInfo m = _pump.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                Assert.NotNull(m, $"{name}() not found on the observer.");
                return (string[])m.Invoke(null, null);
            }

            MethodInfo begin = _pump.GetMethod("BeginObserver", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            MethodInfo end = _pump.GetMethod("EndObserver", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            Assert.NotNull(begin, "BeginObserver() not found.");
            Assert.NotNull(end, "EndObserver() not found.");

            begin.Invoke(null, null);
            try
            {
                int n = InvokeStringGetter("GetRecordedPaths").Length;
                Assert.AreEqual(n, InvokeStringGetter("GetRecordedToPaths").Length, "toPaths buffer length must match paths");
                Assert.AreEqual(n, InvokeStringGetter("GetRecordedKinds").Length, "kinds buffer length must match paths");
                Assert.AreEqual(n, InvokeFloatGetter("GetRecordedTimesMs").Length, "timesMs buffer length must match paths");
                Assert.AreEqual(n, InvokeFloatGetter("GetRecordedTravelPx").Length, "travelPx buffer length must match paths");
                Assert.AreEqual(n, InvokeFloatGetter("GetRecordedReleaseNx").Length, "releaseNx buffer length must match paths");
                Assert.AreEqual(n, InvokeFloatGetter("GetRecordedReleaseNy").Length, "releaseNy buffer length must match paths");
                Assert.AreEqual(n, InvokeStringGetter("GetRecordedScenes").Length, "scenes buffer length must match paths");
            }
            finally
            {
                end.Invoke(null, null);
            }
        }
    }
}
