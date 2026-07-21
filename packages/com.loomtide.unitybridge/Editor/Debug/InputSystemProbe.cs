#if LOOMTIDE_DEBUG
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
internal static class InputSystemProbe
{
    static InputSystemProbe()
    {
        var names = AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetName().Name)
            .Where(n => n.IndexOf("Input", StringComparison.OrdinalIgnoreCase) >= 0)
            .OrderBy(n => n)
            .ToArray();

        string joined = string.Join(",", names);
        Debug.Log($"[UnityBridge][Debug] assemblies={joined}");

        Type t1 = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem");
        Type t2 = Type.GetType("UnityEngine.InputSystem.Keyboard, Unity.InputSystem");
        Debug.Log($"[UnityBridge][Debug] typeLookup inputSystem={(t1 != null)} keyboard={(t2 != null)}");
    }
}
#endif
