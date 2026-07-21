using System;
using System.Reflection;
using UnityBridge.Core;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Reflection bridge to the runtime InputSystemRuntimePump. The runtime pump lives in
    /// an ENABLE_INPUT_SYSTEM-gated assembly, so the Editor assembly cannot reference it
    /// directly.
    /// </summary>
    public static class SimulatedPointerBridge
    {
        private static Type _type;
        private static MethodInfo _tapAt;

        public static void TapAt(float x, float y)
        {
            Resolve();
            try
            {
                _tapAt.Invoke(null, new object[] { x, y });
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                throw ex.InnerException;
            }
        }

        private static void Resolve()
        {
            if (_tapAt != null)
                return;

            _type = ResolveType("UnityBridge.Runtime.InputSystemRuntimePump");
            if (_type == null)
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "Simulated pointer unavailable - the Input System is not enabled (needs ENABLE_INPUT_SYSTEM).");

            _tapAt = _type.GetMethod(
                "TapPointerAt", BindingFlags.Public | BindingFlags.Static, null,
                new[] { typeof(float), typeof(float) }, null);
            if (_tapAt == null)
                throw new BridgeException(ErrorCodes.INPUT_BACKEND_UNAVAILABLE,
                    "InputSystemRuntimePump.TapPointerAt(float,float) not found - bridge runtime out of date.");
        }

        private static Type ResolveType(string fullName)
        {
            Type type = Type.GetType(fullName);
            if (type != null)
                return type;

            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type loaded = assembly.GetType(fullName, false);
                if (loaded != null)
                    return loaded;
            }
            return null;
        }
    }
}
