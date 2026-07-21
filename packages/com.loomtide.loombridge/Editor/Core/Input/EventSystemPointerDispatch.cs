using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;

namespace UnityBridge.Core
{
    /// <summary>
    /// Dispatches synthetic pointer events to uGUI through the EventSystem
    /// (<see cref="ExecuteEvents"/>), independent of the active input module.
    ///
    /// This is the mechanism behind action-trace UI driving: because it invokes
    /// the handler interfaces directly, it actuates uGUI controls on games using
    /// the legacy <c>StandaloneInputModule</c> as well as the new
    /// <c>InputSystemUIInputModule</c> — without modifying game code and without
    /// runtime-patching the engine. See the Replay Verification UI-dispatch spike.
    /// </summary>
    public static class EventSystemPointerDispatch
    {
        private const int MaxDragLegs = 2000;
        private const float MaxOscillationAmplitude = 60f;
        private const float DragEpsilon = 0.001f;

        public struct Result
        {
            public GameObject handlerTarget;
            public Vector2 screenPoint;
            public List<string> handlersFired;
            public bool raycastHit;
        }

        /// <summary>
        /// Dispatch a full down → up → click sequence at <paramref name="screenPoint"/>,
        /// targeting the click handler resolved from <paramref name="target"/> (or the
        /// raycast hit under the point when <paramref name="target"/> is null).
        /// </summary>
        public static Result Click(GameObject target, Vector2 screenPoint, int button = 0)
        {
            EventSystem es = RequireEventSystem();
            var pointer = NewPointer(es, screenPoint, button);
            pointer.pressPosition = screenPoint;
            bool raycastHit = Raycast(es, pointer);

            GameObject basis = target != null ? target : pointer.pointerCurrentRaycast.gameObject;
            if (basis == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No UI element under screen point ({screenPoint.x:0.#}, {screenPoint.y:0.#}) and no target locator provided.");

            var fired = new List<string>();

            GameObject pressTarget = ExecuteEvents.ExecuteHierarchy(basis, pointer, ExecuteEvents.pointerDownHandler);
            if (pressTarget != null) fired.Add("pointerDown");
            pointer.pointerPress = pressTarget;

            GameObject upTarget = pressTarget != null ? pressTarget : basis;
            if (ExecuteEvents.Execute(upTarget, pointer, ExecuteEvents.pointerUpHandler)) fired.Add("pointerUp");

            GameObject clickHandler = ExecuteEvents.GetEventHandler<IPointerClickHandler>(basis);
            if (clickHandler != null && ExecuteEvents.Execute(clickHandler, pointer, ExecuteEvents.pointerClickHandler))
                fired.Add("pointerClick");

            return new Result
            {
                handlerTarget = clickHandler != null ? clickHandler : basis,
                screenPoint = screenPoint,
                handlersFired = fired,
                raycastHit = raycastHit,
            };
        }

        /// <summary>
        /// Dispatch a down → beginDrag → drag(steps) → endDrag → up sequence from
        /// <paramref name="from"/> to <paramref name="to"/>, targeting the drag handler
        /// resolved from <paramref name="target"/>.
        /// </summary>
        public static Result Drag(GameObject target, Vector2 from, Vector2 to, int button = 0, int steps = 4, float travelPx = 0f)
        {
            EventSystem es = RequireEventSystem();
            var pointer = NewPointer(es, from, button);
            bool raycastHit = Raycast(es, pointer);
            pointer.pressPosition = from;

            GameObject basis = target != null ? target : pointer.pointerCurrentRaycast.gameObject;
            if (basis == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No UI element under screen point ({from.x:0.#}, {from.y:0.#}) and no target locator provided.");

            var fired = new List<string>();
            GameObject dragHandler = ExecuteEvents.GetEventHandler<IDragHandler>(basis);
            pointer.pointerDrag = dragHandler;

            ExecuteEvents.Execute(basis, pointer, ExecuteEvents.pointerDownHandler);
            ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.initializePotentialDrag);
            if (ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.beginDragHandler)) fired.Add("beginDrag");

            Vector2 prev = from;
            int n = Mathf.Max(1, steps);
            bool dragged = false;
            float straight = Vector2.Distance(from, to);
            if (travelPx <= 0f || travelPx <= straight)
            {
                for (int i = 1; i <= n; i++)
                {
                    Vector2 p = Vector2.Lerp(from, to, (float)i / n);
                    dragged |= ExecuteDragStep(dragHandler, pointer, ref prev, p);
                }
            }
            else
            {
                Vector2 path = to - from;
                Vector2 axis = straight > DragEpsilon
                    ? new Vector2(-path.y, path.x).normalized
                    : Vector2.right;
                float amp = OscillationAmplitude(target != null ? target : dragHandler, travelPx - straight);
                float remainingExtra = travelPx - straight;
                int legs = 0;
                int sign = 1;

                while (remainingExtra > DragEpsilon && legs + 2 < MaxDragLegs)
                {
                    float leg = Mathf.Min(amp, remainingExtra * 0.5f);
                    Vector2 outPoint = from + axis * (sign * leg);
                    dragged |= ExecuteDragStep(dragHandler, pointer, ref prev, outPoint);
                    dragged |= ExecuteDragStep(dragHandler, pointer, ref prev, from);
                    remainingExtra -= leg * 2f;
                    sign *= -1;
                    legs += 2;
                }

                dragged |= ExecuteDragStep(dragHandler, pointer, ref prev, to);
            }
            if (dragged) fired.Add("drag");

            // uGUI fires OnDrop on the element under the release point (before endDrag) —
            // without it a drag-and-DROP never triggers the drop logic. Exclude the
            // dragged element itself (it follows the pointer and sits on top, whether or
            // not the game dropped its raycast blocking) so the drop reaches the zone
            // beneath it — mirroring the observer's drop-target resolution.
            pointer.position = to;
            pointer.delta = Vector2.zero;
            var dropResults = new List<RaycastResult>();
            es.RaycastAll(pointer, dropResults);
            foreach (RaycastResult dropHit in dropResults)
            {
                GameObject go = dropHit.gameObject;
                if (go == null || (basis != null && go.transform.IsChildOf(basis.transform)))
                    continue;
                pointer.pointerCurrentRaycast = dropHit;
                if (ExecuteEvents.ExecuteHierarchy(go, pointer, ExecuteEvents.dropHandler) != null)
                    fired.Add("drop");
                break;
            }

            // endDrag/up intentionally see the final (release) position + the drop-target
            // raycast — matching real uGUI, which processes them at the release point.
            if (ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.endDragHandler)) fired.Add("endDrag");
            ExecuteEvents.Execute(basis, pointer, ExecuteEvents.pointerUpHandler);

            return new Result
            {
                handlerTarget = dragHandler != null ? dragHandler : basis,
                screenPoint = to,
                handlersFired = fired,
                raycastHit = raycastHit,
            };
        }

        private static bool ExecuteDragStep(GameObject dragHandler, PointerEventData pointer, ref Vector2 prev, Vector2 next)
        {
            pointer.delta = next - prev;
            pointer.position = next;
            prev = next;
            return ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.dragHandler);
        }

        private static float OscillationAmplitude(GameObject basis, float extraTravel)
        {
            float amp = Mathf.Min(MaxOscillationAmplitude, Mathf.Max(1f, extraTravel * 0.5f));
            RectTransform rect = basis != null ? basis.GetComponent<RectTransform>() : null;
            if (rect != null)
            {
                float minSize = Mathf.Min(Mathf.Abs(rect.rect.width), Mathf.Abs(rect.rect.height));
                if (minSize > DragEpsilon)
                    amp = Mathf.Min(amp, Mathf.Max(1f, minSize * 0.25f));
            }
            return amp;
        }

        /// <summary>
        /// State for a SUSTAINED (held) drag: a pointer pressed + dragged to an offset and held
        /// there across many frames (the joystick-hold gesture), released later via <see cref="Release"/>.
        /// Unlike <see cref="Drag"/> (which presses, drags, and releases in one synchronous call —
        /// good for drag-and-drop), a held drag keeps the pointer DOWN so a control that integrates
        /// over time (an on-screen joystick driving run speed) stays deflected while motion is sampled.
        /// </summary>
        public sealed class HeldDrag
        {
            public PointerEventData pointer;
            public GameObject dragHandler;   // resolved IDragHandler (may be null if the target has none)
            public GameObject basis;         // the press/up target element
            public Vector2 held;             // current held screen point
            public List<string> handlersFired;
            public bool raycastHit;
            public bool released;
        }

        /// <summary>
        /// Press at <paramref name="from"/> and drag to <paramref name="to"/>, leaving the pointer
        /// DOWN (no up). Fires pointerDown → initializePotentialDrag → beginDrag → one drag step to
        /// <paramref name="to"/>. The returned handle is re-asserted each tick via <see cref="HoldTick"/>
        /// and released via <see cref="Release"/>. Mirrors <see cref="Drag"/>'s target/raycast resolution.
        /// </summary>
        public static HeldDrag BeginHold(GameObject target, Vector2 from, Vector2 to, int button = 0)
        {
            EventSystem es = RequireEventSystem();
            var pointer = NewPointer(es, from, button);
            bool raycastHit = Raycast(es, pointer);
            pointer.pressPosition = from;

            GameObject basis = target != null ? target : pointer.pointerCurrentRaycast.gameObject;
            if (basis == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No UI element under screen point ({from.x:0.#}, {from.y:0.#}) and no target locator provided.");

            var fired = new List<string>();
            GameObject dragHandler = ExecuteEvents.GetEventHandler<IDragHandler>(basis);
            pointer.pointerDrag = dragHandler;

            if (ExecuteEvents.Execute(basis, pointer, ExecuteEvents.pointerDownHandler)) fired.Add("pointerDown");
            pointer.pointerPress = basis;
            ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.initializePotentialDrag);
            if (ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.beginDragHandler)) fired.Add("beginDrag");

            pointer.delta = to - from;
            pointer.position = to;
            if (ExecuteEvents.Execute(dragHandler, pointer, ExecuteEvents.dragHandler)) fired.Add("drag");

            return new HeldDrag
            {
                pointer = pointer,
                dragHandler = dragHandler,
                basis = basis,
                held = to,
                handlersFired = fired,
                raycastHit = raycastHit,
                released = false,
            };
        }

        /// <summary>
        /// Press a uGUI target and keep the pointer down without dragging. Used for
        /// hold/release buttons such as mobile jump short-hop. Release with
        /// <see cref="Release"/> so pointerUp is recorded in the same handler list.
        /// </summary>
        public static HeldDrag BeginPressHold(GameObject target, Vector2 at, int button = 0)
        {
            EventSystem es = RequireEventSystem();
            var pointer = NewPointer(es, at, button);
            bool raycastHit = Raycast(es, pointer);
            pointer.pressPosition = at;

            GameObject basis = target != null ? target : pointer.pointerCurrentRaycast.gameObject;
            if (basis == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"No UI element under screen point ({at.x:0.#}, {at.y:0.#}) and no target locator provided.");

            var fired = new List<string>();
            if (ExecuteEvents.Execute(basis, pointer, ExecuteEvents.pointerDownHandler)) fired.Add("pointerDown");
            pointer.pointerPress = basis;

            return new HeldDrag
            {
                pointer = pointer,
                dragHandler = null,
                basis = basis,
                held = at,
                handlersFired = fired,
                raycastHit = raycastHit,
                released = false,
            };
        }

        /// <summary>
        /// Re-assert the held deflection: re-dispatch OnDrag at the SAME held point (delta 0). A
        /// joystick that recomputes its value only in OnDrag stays deflected; one that latches its
        /// last value is unaffected. No-op once released or when the target has no drag handler.
        /// Makes the hold robust across joystick implementations without assuming the control
        /// latches its value between drag events.
        /// </summary>
        public static void HoldTick(HeldDrag h)
        {
            if (h == null || h.released || h.dragHandler == null)
                return;
            h.pointer.delta = Vector2.zero;
            h.pointer.position = h.held;
            ExecuteEvents.Execute(h.dragHandler, h.pointer, ExecuteEvents.dragHandler);
        }

        /// <summary>
        /// Release a held drag: endDrag → pointerUp at the held point, so a joystick resets to
        /// center (OnPointerUp) and the control sees a clean release. Idempotent.
        /// </summary>
        public static void Release(HeldDrag h)
        {
            if (h == null || h.released)
                return;
            h.pointer.position = h.held;
            h.pointer.delta = Vector2.zero;
            if (h.dragHandler != null && ExecuteEvents.Execute(h.dragHandler, h.pointer, ExecuteEvents.endDragHandler))
                h.handlersFired.Add("endDrag");
            if (ExecuteEvents.Execute(h.basis, h.pointer, ExecuteEvents.pointerUpHandler))
                h.handlersFired.Add("pointerUp");
            h.released = true;
        }

        private static EventSystem RequireEventSystem()
        {
            // EventSystem.current is only auto-set by the player loop, so it can be
            // null even when an EventSystem exists (e.g. before the first tick, or in
            // edit-mode contexts). Fall back to locating one in the scene.
            EventSystem es = EventSystem.current;
            if (es == null)
                es = Object.FindFirstObjectByType<EventSystem>();
            if (es == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    "No active EventSystem in the scene; cannot dispatch UI pointer events.");
            return es;
        }

        private static PointerEventData NewPointer(EventSystem es, Vector2 screenPoint, int button)
        {
            return new PointerEventData(es)
            {
                position = screenPoint,
                button = ToInputButton(button),
            };
        }

        private static bool Raycast(EventSystem es, PointerEventData pointer)
        {
            var results = new List<RaycastResult>();
            es.RaycastAll(pointer, results);
            if (results.Count == 0) return false;
            pointer.pointerCurrentRaycast = results[0];
            pointer.pointerPressRaycast = results[0];
            return true;
        }

        private static PointerEventData.InputButton ToInputButton(int button)
        {
            switch (button)
            {
                case 1: return PointerEventData.InputButton.Right;
                case 2: return PointerEventData.InputButton.Middle;
                default: return PointerEventData.InputButton.Left;
            }
        }
    }
}
