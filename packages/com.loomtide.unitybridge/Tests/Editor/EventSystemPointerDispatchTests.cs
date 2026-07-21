using NUnit.Framework;
using UnityBridge.Core;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace UnityBridge.Tests
{
    /// <summary>
    /// Spike proof for module-independent uGUI dispatch (Replay Verification
    /// UI-dispatch spike). The EventSystem here is driven by the LEGACY
    /// <see cref="StandaloneInputModule"/> — the module that blocks the existing
    /// SendEvent-based click path. These tests assert that EventSystem/ExecuteEvents
    /// dispatch actuates real uGUI controls *despite* that module being active,
    /// with no game-code change.
    /// </summary>
    [TestFixture]
    public class EventSystemPointerDispatchTests
    {
        private GameObject _root;
        private GameObject _eventSystemGo;

        [SetUp]
        public void SetUp()
        {
            _root = new GameObject("DispatchTestRoot");

            _eventSystemGo = new GameObject("EventSystem");
            _eventSystemGo.transform.SetParent(_root.transform, false);
            _eventSystemGo.AddComponent<EventSystem>();
            _eventSystemGo.AddComponent<StandaloneInputModule>();
        }

        [TearDown]
        public void TearDown()
        {
            if (_root != null)
                Object.DestroyImmediate(_root);
        }

        [Test]
        public void Click_ActuatesButton_DespiteStandaloneInputModule()
        {
            // Sanity: the legacy module is the active one.
            Assert.IsNotNull(_eventSystemGo.GetComponent<StandaloneInputModule>(),
                "Test must run with the legacy StandaloneInputModule present.");

            GameObject canvas = NewCanvas();
            (GameObject buttonGo, Button button) = NewButton(canvas);

            int clicks = 0;
            button.onClick.AddListener(() => clicks++);

            EventSystemPointerDispatch.Result result =
                EventSystemPointerDispatch.Click(buttonGo, ScreenCenter(buttonGo));

            Assert.AreEqual(1, clicks, "Button onClick should fire via ExecuteEvents pointerClick.");
            CollectionAssert.Contains(result.handlersFired, "pointerClick");
            Assert.Greater(result.handlersFired.Count, 0, "Result should report fired handlers.");
        }

        [Test]
        public void Click_TogglesToggle_DespiteStandaloneInputModule()
        {
            GameObject canvas = NewCanvas();

            var toggleGo = new GameObject("Toggle", typeof(RectTransform));
            toggleGo.transform.SetParent(canvas.transform, false);
            ((RectTransform)toggleGo.transform).sizeDelta = new Vector2(40, 40);
            toggleGo.AddComponent<Image>();
            Toggle toggle = toggleGo.AddComponent<Toggle>();
            toggle.isOn = false;

            EventSystemPointerDispatch.Click(toggleGo, ScreenCenter(toggleGo));

            Assert.IsTrue(toggle.isOn, "Toggle should flip on via ExecuteEvents pointerClick.");
        }

        [Test]
        public void Drag_FiresDragSequence_DespiteStandaloneInputModule()
        {
            GameObject canvas = NewCanvas();

            var dragGo = new GameObject("DragTarget", typeof(RectTransform));
            dragGo.transform.SetParent(canvas.transform, false);
            ((RectTransform)dragGo.transform).sizeDelta = new Vector2(120, 120);
            dragGo.AddComponent<Image>();
            DragRecorder recorder = dragGo.AddComponent<DragRecorder>();

            Vector2 from = ScreenCenter(dragGo);
            Vector2 to = from + new Vector2(80f, 0f);

            EventSystemPointerDispatch.Result result =
                EventSystemPointerDispatch.Drag(dragGo, from, to);

            Assert.IsTrue(recorder.beganDrag, "IBeginDragHandler should fire.");
            Assert.Greater(recorder.dragCount, 0, "IDragHandler should fire at least once.");
            Assert.IsTrue(recorder.endedDrag, "IEndDragHandler should fire.");
            CollectionAssert.Contains(result.handlersFired, "beginDrag");
            CollectionAssert.Contains(result.handlersFired, "endDrag");
        }

        [Test]
        public void BeginHold_DeflectsJoystick_AndKeepsPointerDown()
        {
            GameObject canvas = NewCanvas();
            (GameObject stickGo, JoystickStub stick) = NewJoystick(canvas);
            stick.center = ScreenCenter(stickGo);

            Vector2 from = ScreenCenter(stickGo);
            Vector2 to = from + new Vector2(200f, 0f); // well past the radius -> full right deflection

            EventSystemPointerDispatch.HeldDrag h = EventSystemPointerDispatch.BeginHold(stickGo, from, to);

            Assert.IsFalse(h.released, "the hold keeps the pointer DOWN (not released)");
            Assert.IsFalse(stick.pointerUp, "no pointerUp should fire while held");
            Assert.Greater(stick.dragCount, 0, "OnDrag should fire to set the deflection");
            Assert.AreEqual(1f, stick.Horizontal, 1e-4, "a drag past the radius clamps to full right deflection");
            CollectionAssert.Contains(h.handlersFired, "drag");
        }

        [Test]
        public void HoldTick_ReassertsDeflection_AcrossFrames()
        {
            GameObject canvas = NewCanvas();
            (GameObject stickGo, JoystickStub stick) = NewJoystick(canvas);
            stick.center = ScreenCenter(stickGo);
            Vector2 from = ScreenCenter(stickGo);

            EventSystemPointerDispatch.HeldDrag h =
                EventSystemPointerDispatch.BeginHold(stickGo, from, from + new Vector2(200f, 0f));
            int afterBegin = stick.dragCount;

            // Simulate a control that would decay without continued drag events.
            stick.ForceZeroForTest();
            EventSystemPointerDispatch.HoldTick(h);

            Assert.Greater(stick.dragCount, afterBegin, "HoldTick should re-dispatch OnDrag");
            Assert.AreEqual(1f, stick.Horizontal, 1e-4, "HoldTick re-asserts the held deflection");
        }

        [Test]
        public void Release_ResetsJoystick_AndIsIdempotent()
        {
            GameObject canvas = NewCanvas();
            (GameObject stickGo, JoystickStub stick) = NewJoystick(canvas);
            stick.center = ScreenCenter(stickGo);
            Vector2 from = ScreenCenter(stickGo);

            EventSystemPointerDispatch.HeldDrag h =
                EventSystemPointerDispatch.BeginHold(stickGo, from, from + new Vector2(200f, 0f));
            Assert.AreEqual(1f, stick.Horizontal, 1e-4);

            EventSystemPointerDispatch.Release(h);
            Assert.IsTrue(h.released);
            Assert.IsTrue(stick.pointerUp, "Release fires pointerUp");
            Assert.AreEqual(0f, stick.Horizontal, 1e-4, "OnPointerUp resets the joystick to center");
            CollectionAssert.Contains(h.handlersFired, "pointerUp");

            // Idempotent: a second Release does nothing (e.g. cleanup after an early release).
            int upCount = stick.pointerUpCount;
            EventSystemPointerDispatch.Release(h);
            Assert.AreEqual(upCount, stick.pointerUpCount, "Release is idempotent");
        }

        [Test]
        public void BeginHold_TargetWithoutDragHandler_StillPressesAndReleases()
        {
            // A plain button has no IDragHandler: BeginHold must not throw, 'drag' must NOT fire,
            // HoldTick is a no-op, and Release still delivers pointerUp.
            GameObject canvas = NewCanvas();
            (GameObject buttonGo, _) = NewButton(canvas);

            Vector2 from = ScreenCenter(buttonGo);
            EventSystemPointerDispatch.HeldDrag h =
                EventSystemPointerDispatch.BeginHold(buttonGo, from, from + new Vector2(50f, 0f));

            Assert.IsNull(h.dragHandler, "a plain button exposes no IDragHandler");
            CollectionAssert.DoesNotContain(h.handlersFired, "drag");
            Assert.DoesNotThrow(() => EventSystemPointerDispatch.HoldTick(h), "HoldTick is a no-op without a drag handler");
            Assert.DoesNotThrow(() => EventSystemPointerDispatch.Release(h));
            Assert.IsTrue(h.released);
        }

        [Test]
        public void HeldDrag_GameHandlerThrow_IsContained_PointerStillReleases()
        {
            // A joystick whose OnDrag THROWS must not propagate out of BeginHold/HoldTick (Unity's
            // ExecuteEvents swallows+logs handler exceptions), so the per-tick re-assert can't crash
            // the capture loop, and Release must STILL deliver pointerUp (the joystick can't be left
            // stuck deflected). The op loop additionally guards this; here we pin the primitive layer.
            LogAssert.ignoreFailingMessages = true; // tolerate the logged OnDrag exception
            try
            {
                GameObject canvas = NewCanvas();
                var go = new GameObject("ThrowingJoystick", typeof(RectTransform));
                go.transform.SetParent(canvas.transform, false);
                ((RectTransform)go.transform).sizeDelta = new Vector2(120, 120);
                go.AddComponent<Image>();
                ThrowingDragStub stick = go.AddComponent<ThrowingDragStub>();

                Vector2 from = ScreenCenter(go);
                EventSystemPointerDispatch.HeldDrag h = null;
                Assert.DoesNotThrow(
                    () => h = EventSystemPointerDispatch.BeginHold(go, from, from + new Vector2(120f, 0f)),
                    "a throwing OnDrag must be contained by ExecuteEvents, not propagated out of BeginHold");
                Assert.DoesNotThrow(() => EventSystemPointerDispatch.HoldTick(h), "HoldTick must not propagate a handler throw");
                Assert.DoesNotThrow(() => EventSystemPointerDispatch.Release(h), "Release must not propagate a handler throw");
                Assert.IsTrue(h.released);
                Assert.IsTrue(stick.pointerUp, "pointerUp is still delivered despite OnDrag throwing");
            }
            finally
            {
                LogAssert.ignoreFailingMessages = false;
            }
        }

        [Test]
        public void Click_NoEventSystem_Throws()
        {
            Object.DestroyImmediate(_eventSystemGo);
            // Guard against a stray EventSystem leaking in from another fixture —
            // the FindFirstObjectByType fallback would otherwise mask this case.
            Assert.IsNull(Object.FindFirstObjectByType<EventSystem>(),
                "Test precondition: no EventSystem should exist in the scene.");

            GameObject canvas = NewCanvas();
            (GameObject buttonGo, _) = NewButton(canvas);

            var ex = Assert.Throws<BridgeException>(
                () => EventSystemPointerDispatch.Click(buttonGo, ScreenCenter(buttonGo)));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        // ───────────────────────── helpers ─────────────────────────

        private GameObject NewCanvas()
        {
            var go = new GameObject("Canvas");
            go.transform.SetParent(_root.transform, false);
            Canvas canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            go.AddComponent<GraphicRaycaster>();
            return go;
        }

        private static (GameObject, Button) NewButton(GameObject canvas)
        {
            var go = new GameObject("Button", typeof(RectTransform));
            go.transform.SetParent(canvas.transform, false);
            ((RectTransform)go.transform).sizeDelta = new Vector2(160, 40);
            go.AddComponent<Image>();
            Button button = go.AddComponent<Button>();
            return (go, button);
        }

        private static Vector2 ScreenCenter(GameObject go)
        {
            var rt = go.GetComponent<RectTransform>();
            return RectTransformUtility.WorldToScreenPoint(null, rt.TransformPoint(rt.rect.center));
        }

        private class DragRecorder : MonoBehaviour,
            IBeginDragHandler, IDragHandler, IEndDragHandler
        {
            public bool beganDrag;
            public int dragCount;
            public bool endedDrag;

            public void OnBeginDrag(PointerEventData eventData) => beganDrag = true;
            public void OnDrag(PointerEventData eventData) => dragCount++;
            public void OnEndDrag(PointerEventData eventData) => endedDrag = true;
        }

        private static (GameObject, JoystickStub) NewJoystick(GameObject canvas)
        {
            var go = new GameObject("Joystick", typeof(RectTransform));
            go.transform.SetParent(canvas.transform, false);
            ((RectTransform)go.transform).sizeDelta = new Vector2(120, 120);
            go.AddComponent<Image>();
            JoystickStub stick = go.AddComponent<JoystickStub>();
            return (go, stick);
        }

        /// <summary>
        /// Minimal stand-in for a Joystick-Pack joystick: OnPointerDown/OnDrag set a normalized,
        /// clamped Horizontal from the pointer's x relative to a center; OnPointerUp resets to 0.
        /// Mirrors how a legacy-Input title's Fixed Joystick feeds MoveByTouch (linearVelocity.x = moveSpeed
        /// * Horizontal), so the held-drag primitives can be proven without the third-party asset.
        /// </summary>
        private class JoystickStub : MonoBehaviour,
            IPointerDownHandler, IDragHandler, IPointerUpHandler
        {
            public float radius = 50f;
            public Vector2 center;
            public float Horizontal { get; private set; }
            public int dragCount;
            public bool pointerUp;
            public int pointerUpCount;

            public void OnPointerDown(PointerEventData e) => SetFrom(e.position);
            public void OnDrag(PointerEventData e) { dragCount++; SetFrom(e.position); }
            public void OnPointerUp(PointerEventData e) { Horizontal = 0f; pointerUp = true; pointerUpCount++; }

            // Test hook: simulate a control whose value would decay without continued drag events.
            public void ForceZeroForTest() => Horizontal = 0f;

            private void SetFrom(Vector2 pos) => Horizontal = Mathf.Clamp((pos.x - center.x) / radius, -1f, 1f);
        }

        /// <summary>A control whose OnDrag throws — to prove a game-handler throw is contained.</summary>
        private class ThrowingDragStub : MonoBehaviour,
            IPointerDownHandler, IDragHandler, IPointerUpHandler
        {
            public bool pointerUp;
            public void OnPointerDown(PointerEventData e) { }
            public void OnDrag(PointerEventData e) => throw new System.InvalidOperationException("drag-boom");
            public void OnPointerUp(PointerEventData e) => pointerUp = true;
        }
    }
}
