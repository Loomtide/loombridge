using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Version-portable object-identity helpers.
    ///
    /// Unity 6000.5 promoted the classic InstanceID APIs to <c>[Obsolete(error: true)]</c>
    /// (CS0619 — a HARD compile error that <c>#pragma warning disable</c> cannot silence) in
    /// favour of the new "EntityId" APIs, which do NOT exist on the previous supported editors
    /// (2022.3 / 6000.3). Route every identity lookup through here so the <c>#if</c> lives in one place.
    ///
    /// Currency is <c>long</c>, not <c>int</c>: on 6000.5 the EntityId→int conversion is ALSO
    /// obsolete-as-error ("EntityId will not be representable by an int in the future"), so we go
    /// through the non-obsolete <c>EntityId.ToULong</c>/<c>FromULong</c>. <c>long</c> (rather than
    /// <c>ulong</c>) keeps the pre-6000.5 path's negative instance IDs as small, JSON/JS-safe numbers
    /// on the wire instead of huge reinterpreted values.
    /// </summary>
    internal static class EntityIdCompat
    {
        /// <summary>Stable per-object id — GetEntityId() on 6000.5+, GetInstanceID() before.</summary>
        public static long Id(Object obj)
        {
#if UNITY_6000_5_OR_NEWER
            return unchecked((long)EntityId.ToULong(obj.GetEntityId()));
#else
            return obj.GetInstanceID();
#endif
        }

        /// <summary>Resolve the object an id from <see cref="Id"/> refers to (null if none).</summary>
        public static Object ToObject(long id)
        {
#if UNITY_6000_5_OR_NEWER
            return EditorUtility.EntityIdToObject(EntityId.FromULong(unchecked((ulong)id)));
#else
            return EditorUtility.InstanceIDToObject(unchecked((int)id));
#endif
        }

        /// <summary>Id of the object a SerializedProperty references (0 when unset/missing).</summary>
        public static long ObjectRefId(SerializedProperty prop)
        {
#if UNITY_6000_5_OR_NEWER
            return unchecked((long)EntityId.ToULong(prop.objectReferenceEntityIdValue));
#else
            return prop.objectReferenceInstanceIDValue;
#endif
        }
    }
}
