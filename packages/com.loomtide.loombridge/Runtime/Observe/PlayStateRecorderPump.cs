using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace UnityBridge.Runtime
{
    /// <summary>
    /// THE PLAY-MODE STATE RECORDER (evidence arc stage 3; ledger L97/L98/L122).
    ///
    /// Samples the player's position and the game's own win/score/lives fields EVERY
    /// Update, into global static ring buffers a second bridge client drains after the
    /// fact. It is the <see cref="InputObserverRuntimePump"/> pattern applied to state
    /// instead of clicks, and it exists for the same reason that one does: the bridge
    /// runs on the editor tick, so anything it polls over the wire is sampled tens of
    /// milliseconds apart, and a single-frame teleport lands entirely between two
    /// polls. The completion evidence this repo needs (was the level PLAYED, or was
    /// the player moved onto the goal?) is exactly a per-frame continuity question, so
    /// the sampling has to happen in the game's own loop.
    ///
    /// WHY A SECOND CLIENT DRAINS IT. The agent drives the game from its OWN bridge
    /// connection while the CLI observes; multi-client is real and already proven by
    /// the observe-a-human-session recorder. The CLI opens the window, the agent
    /// plays, the CLI drains. Neither side can type a verdict field: every headline in
    /// playability.json is derived from these buffers.
    ///
    /// WHAT IT DOES NOT SURVIVE, recorded rather than papered over:
    ///   - a DOMAIN RELOAD wipes these statics, and that is fine: a drain then reports
    ///     recording=false with an empty buffer, and the CLI refuses rather than
    ///     minting a window it did not record (an empty buffer must never read as a
    ///     clean session);
    ///   - PLAY EXIT destroys the pump GameObject, so <see cref="IsRecording"/> goes
    ///     false the same way, which is the honest report of "the window closed early";
    ///   - a RING WRAP is counted, never hidden: <see cref="GetDroppedSamples"/> is
    ///     non-zero and the derivation REFUSES, because the one frame it cannot see is
    ///     exactly where a teleport would hide.
    ///
    /// Execution order -32000 matches the observer: sample before the game's own
    /// scripts run this frame, so the recorded state is the state the previous frame
    /// left behind (a consistent, well-defined sampling point).
    /// </summary>
    [DefaultExecutionOrder(-32000)]
    public sealed class PlayStateRecorderPump : MonoBehaviour
    {
        /// <summary>
        /// Default ring capacity, in samples. 36000 samples is 10 minutes at 60Hz
        /// (and still 5 minutes at 120Hz), which covers every hand-driven level
        /// completion this evidence class is for, at a cost of roughly 36000 * 44
        /// bytes = 1.6 MB of managed arrays. Sized in SAMPLES rather than seconds
        /// deliberately: the buffer's job is to hold every frame, so the honest unit
        /// is frames, and a game running at a higher frame rate gets a shorter window
        /// rather than a silently decimated one.
        /// </summary>
        public const int DefaultCapacity = 36000;

        /// <summary>Hard ceiling, so a typo cannot ask for a gigabyte of ring.</summary>
        public const int MaxCapacity = 500000;

        /// <summary>Sentinel for a numeric field that could not be read this sample.</summary>
        public const double UnreadableNumber = double.NaN;

        /// <summary>Sentinel for a bool field that could not be read this sample (win column).</summary>
        public const int UnreadableBool = -1;

        private static PlayStateRecorderPump _instance;
        private static bool _recording;
        private static string _sessionId;
        private static double _startTimeUnscaled;

        // Ring buffers, all parallel, all of length _capacity.
        private static int _capacity;
        private static double[] _tMs;
        private static int[] _frame;
        private static long[] _fixedTick;
        private static float[] _x;
        private static float[] _y;
        private static float[] _z;
        private static int[] _win;
        private static double[] _score;
        private static double[] _lives;

        /// <summary>Next write index into the ring.</summary>
        private static int _head;

        /// <summary>Samples TAKEN since the session began (may exceed the capacity).</summary>
        private static long _totalSampled;

        /// <summary>Fixed ticks counted by this recorder since the session began.</summary>
        private static long _fixedTickCount;

        // The declared seam.
        private static string _playerPath;
        private static string _statePath;
        private static string _stateComponent;
        private static string _winField;
        private static string _scoreField;
        private static string _livesField;

        // Resolution caches, re-resolved on demand when an object goes away.
        private static GameObject _playerObject;
        private static Component _stateComponentInstance;
        private static readonly HashSet<string> _unreadableFields = new HashSet<string>();

        private const BindingFlags MemberFlags = BindingFlags.Public | BindingFlags.Instance;

        /// <summary>
        /// Start recording, or return false when a session is already live (the caller
        /// then reports the EXISTING session: starting an active recorder is idempotent
        /// by design, so a retried op cannot silently discard a window mid-drive).
        /// </summary>
        public static bool BeginRecording(
            string sessionId,
            string playerPath,
            string statePath,
            string stateComponent,
            string winField,
            string scoreField,
            string livesField,
            int capacity)
        {
            if (IsRecording())
                return false;

            _capacity = capacity > 0 ? Mathf.Min(capacity, MaxCapacity) : DefaultCapacity;
            _tMs = new double[_capacity];
            _frame = new int[_capacity];
            _fixedTick = new long[_capacity];
            _x = new float[_capacity];
            _y = new float[_capacity];
            _z = new float[_capacity];
            _win = new int[_capacity];
            _score = new double[_capacity];
            _lives = new double[_capacity];
            _head = 0;
            _totalSampled = 0;
            _fixedTickCount = 0;

            _sessionId = sessionId;
            _playerPath = playerPath;
            _statePath = statePath;
            _stateComponent = stateComponent;
            _winField = winField;
            _scoreField = scoreField;
            _livesField = livesField;
            _playerObject = null;
            _stateComponentInstance = null;
            _unreadableFields.Clear();

            _startTimeUnscaled = Time.unscaledTimeAsDouble;
            _recording = true;
            EnsureInstance();
            // Take the OPENING sample synchronously, so the caller gets the state at
            // window open in the start response: the win-already-true refusal (H7) binds
            // to the recorder's own read, not to a separate op on a separate tick.
            SampleNow();
            return true;
        }

        /// <summary>Stop and release the buffers. Callers drain BEFORE calling this.</summary>
        public static void EndRecording()
        {
            _recording = false;
            _tMs = null;
            _frame = null;
            _fixedTick = null;
            _x = null;
            _y = null;
            _z = null;
            _win = null;
            _score = null;
            _lives = null;
            _capacity = 0;
            _head = 0;
            _totalSampled = 0;
            _fixedTickCount = 0;
            _sessionId = null;
            _playerPath = null;
            _statePath = null;
            _stateComponent = null;
            _winField = null;
            _scoreField = null;
            _livesField = null;
            _playerObject = null;
            _stateComponentInstance = null;
            _unreadableFields.Clear();
            DestroyInstance();
        }

        /// <summary>
        /// True only while a live recorder is actually sampling. Distinguishes "the
        /// window recorded nothing" from "the recorder died" (play exit, domain
        /// reload), so a drain can never return an empty buffer that reads like a
        /// clean short session.
        /// </summary>
        public static bool IsRecording()
        {
            return _recording && _instance != null;
        }

        public static string GetSessionId()
        {
            return _sessionId;
        }

        /// <summary>Samples retained in the ring right now (capped at the capacity).</summary>
        public static int GetSampleCount()
        {
            return (int)Math.Min(_totalSampled, (long)_capacity);
        }

        /// <summary>Samples TAKEN since the session began, including any the ring overwrote.</summary>
        public static long GetTotalSampled()
        {
            return _totalSampled;
        }

        /// <summary>Samples the ring OVERWROTE. Non-zero means the window has a hole in it.</summary>
        public static long GetDroppedSamples()
        {
            return Math.Max(0, _totalSampled - _capacity);
        }

        public static int GetCapacity()
        {
            return _capacity;
        }

        /// <summary>Fixed physics ticks this recorder counted since the session began.</summary>
        public static long GetFixedTickCount()
        {
            return _fixedTickCount;
        }

        /// <summary>Declared fields that failed to read at least once (never silently zeroed).</summary>
        public static string[] GetUnreadableFields()
        {
            var list = new List<string>(_unreadableFields);
            list.Sort(StringComparer.Ordinal);
            return list.ToArray();
        }

        // Chronological buffer readers. Each returns the retained samples oldest-first,
        // so a wrapped ring reads in order without the caller knowing where the head is.

        public static double[] GetTimesMs()
        {
            var outArr = new double[GetSampleCount()];
            CopyChronological(_tMs, outArr);
            return outArr;
        }

        public static int[] GetFrames()
        {
            var outArr = new int[GetSampleCount()];
            CopyChronological(_frame, outArr);
            return outArr;
        }

        public static long[] GetFixedTicks()
        {
            var outArr = new long[GetSampleCount()];
            CopyChronological(_fixedTick, outArr);
            return outArr;
        }

        public static float[] GetX()
        {
            var outArr = new float[GetSampleCount()];
            CopyChronological(_x, outArr);
            return outArr;
        }

        public static float[] GetY()
        {
            var outArr = new float[GetSampleCount()];
            CopyChronological(_y, outArr);
            return outArr;
        }

        public static float[] GetZ()
        {
            var outArr = new float[GetSampleCount()];
            CopyChronological(_z, outArr);
            return outArr;
        }

        /// <summary>Win column: 1 true, 0 false, -1 UNREADABLE (never coerced to false).</summary>
        public static int[] GetWin()
        {
            var outArr = new int[GetSampleCount()];
            CopyChronological(_win, outArr);
            return outArr;
        }

        /// <summary>Score column; NaN marks a sample whose read failed.</summary>
        public static double[] GetScore()
        {
            var outArr = new double[GetSampleCount()];
            CopyChronological(_score, outArr);
            return outArr;
        }

        /// <summary>Lives column; NaN marks a sample whose read failed.</summary>
        public static double[] GetLives()
        {
            var outArr = new double[GetSampleCount()];
            CopyChronological(_lives, outArr);
            return outArr;
        }

        private static void CopyChronological<T>(T[] ring, T[] destination)
        {
            int count = destination.Length;
            if (count == 0 || ring == null)
                return;
            // Not wrapped: the ring is already chronological from 0.
            int start = _totalSampled <= _capacity ? 0 : _head;
            for (int i = 0; i < count; i++)
                destination[i] = ring[(start + i) % _capacity];
        }

        private static void EnsureInstance()
        {
            if (_instance != null)
                return;

            var go = new GameObject("[Loombridge] PlayStateRecorderPump");
            go.hideFlags = HideFlags.HideAndDontSave;
            // Same guard as the observer: DontDestroyOnLoad is play-mode-only and throws
            // from an editor context, and EditMode tests drive this pump directly.
            if (Application.isPlaying)
                DontDestroyOnLoad(go);
            _instance = go.AddComponent<PlayStateRecorderPump>();
        }

        private static void DestroyInstance()
        {
            if (_instance == null)
                return;
            if (Application.isPlaying)
                Destroy(_instance.gameObject);
            else
                DestroyImmediate(_instance.gameObject);
            _instance = null;
        }

        private void Update()
        {
            if (!_recording)
                return;
            SampleNow();
        }

        private void FixedUpdate()
        {
            if (!_recording)
                return;
            _fixedTickCount++;
        }

        /// <summary>
        /// Take one sample. Public so the opening sample can be taken synchronously at
        /// BeginRecording, and so the EditMode tests can drive the ring without a
        /// running player loop.
        /// </summary>
        public static void SampleNow()
        {
            if (!_recording || _tMs == null)
                return;

            int slot = _head;
            _tMs[slot] = (Time.unscaledTimeAsDouble - _startTimeUnscaled) * 1000.0;
            _frame[slot] = Time.frameCount;
            _fixedTick[slot] = _fixedTickCount;

            GameObject player = ResolvePlayer();
            if (player != null)
            {
                Vector3 position = player.transform.position;
                _x[slot] = position.x;
                _y[slot] = position.y;
                _z[slot] = position.z;
            }
            else
            {
                // The player is gone (destroyed mid-window). Record NaN rather than the
                // previous position: a repeated position would read as "standing still".
                _x[slot] = float.NaN;
                _y[slot] = float.NaN;
                _z[slot] = float.NaN;
                _unreadableFields.Add("player.position");
            }

            Component state = ResolveState();
            _win[slot] = ReadBool(state, _winField);
            _score[slot] = ReadNumber(state, _scoreField);
            _lives[slot] = ReadNumber(state, _livesField);

            _head = (_head + 1) % _capacity;
            _totalSampled++;
        }

        private static GameObject ResolvePlayer()
        {
            if (_playerObject != null)
                return _playerObject;
            _playerObject = RuntimePathResolver.Resolve(_playerPath);
            return _playerObject;
        }

        private static Component ResolveState()
        {
            if (_stateComponentInstance != null)
                return _stateComponentInstance;
            GameObject go = RuntimePathResolver.Resolve(_statePath);
            if (go == null)
                return null;
            if (string.IsNullOrEmpty(_stateComponent))
                return null;
            _stateComponentInstance = FindComponentByTypeName(go, _stateComponent);
            return _stateComponentInstance;
        }

        /// <summary>
        /// Resolve a component by type name without Unity's string GetComponent overload,
        /// which returns null for nested types (the EditMode fakes) and is fragile for
        /// namespaced ones. Matches Type.Name first, then FullName, over the object's
        /// live components.
        /// </summary>
        internal static Component FindComponentByTypeName(GameObject go, string typeName)
        {
            if (go == null || string.IsNullOrEmpty(typeName))
                return null;
            foreach (Component component in go.GetComponents<Component>())
            {
                if (component == null)
                    continue;
                Type type = component.GetType();
                if (type.Name == typeName || type.FullName == typeName)
                    return component;
            }
            return null;
        }

        /// <summary>
        /// Read a declared public bool member. Returns the UnreadableBool sentinel when
        /// the component, the member, or the value is not there: an unreadable field is
        /// recorded as unreadable and refuses downstream, never coerced to false.
        /// </summary>
        private static int ReadBool(Component component, string member)
        {
            object value = ReadMember(component, member);
            if (value is bool flag)
                return flag ? 1 : 0;
            if (value != null)
                _unreadableFields.Add(member + " (not a bool)");
            return UnreadableBool;
        }

        /// <summary>Read a declared public numeric member; NaN when unreadable.</summary>
        private static double ReadNumber(Component component, string member)
        {
            object value = ReadMember(component, member);
            if (value == null)
                return UnreadableNumber;
            try
            {
                return Convert.ToDouble(value);
            }
            catch
            {
                _unreadableFields.Add(member + " (not numeric)");
                return UnreadableNumber;
            }
        }

        private static object ReadMember(Component component, string member)
        {
            if (component == null || string.IsNullOrEmpty(member))
            {
                if (!string.IsNullOrEmpty(member))
                    _unreadableFields.Add(member + " (component unresolved)");
                return null;
            }
            try
            {
                Type type = component.GetType();
                PropertyInfo property = type.GetProperty(member, MemberFlags);
                if (property != null && property.CanRead)
                    return property.GetValue(component);
                FieldInfo field = type.GetField(member, MemberFlags);
                if (field != null)
                    return field.GetValue(component);
                _unreadableFields.Add(member + " (no such public member)");
                return null;
            }
            catch (Exception ex)
            {
                _unreadableFields.Add(member + " (" + ex.GetType().Name + ")");
                return null;
            }
        }

        private void OnDisable()
        {
            if (_instance == this)
                _instance = null;
        }
    }
}
