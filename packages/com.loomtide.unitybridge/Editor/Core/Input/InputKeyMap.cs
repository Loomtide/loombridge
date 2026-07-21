using System;
using System.Collections.Generic;
using System.Text;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Core.Input
{
    /// <summary>
    /// Key-name resolver backed by KeyCode enum names (no integer lookup tables).
    /// </summary>
    public static class InputKeyMap
    {
        private static readonly Dictionary<string, KeyCode> KeyByName = BuildKeyMap();

        public static KeyCode ResolveOrThrow(string keyName)
        {
            if (TryResolve(keyName, out KeyCode keyCode))
                return keyCode;

            throw new BridgeException(ErrorCodes.INVALID_KEY,
                $"Invalid key '{keyName}'. Use Unity KeyCode names (for example Space, LeftArrow, A).");
        }

        public static bool TryResolve(string keyName, out KeyCode keyCode)
        {
            keyCode = KeyCode.None;
            if (string.IsNullOrEmpty(keyName))
                return false;

            string normalized = NormalizeKeyName(keyName);
            if (string.IsNullOrEmpty(normalized))
                return false;

            return KeyByName.TryGetValue(normalized, out keyCode);
        }

        private static Dictionary<string, KeyCode> BuildKeyMap()
        {
            var map = new Dictionary<string, KeyCode>(StringComparer.Ordinal);

            foreach (KeyCode keyCode in Enum.GetValues(typeof(KeyCode)))
            {
                if (keyCode == KeyCode.None)
                    continue;

                string normalized = NormalizeKeyName(keyCode.ToString());
                if (string.IsNullOrEmpty(normalized) || map.ContainsKey(normalized))
                    continue;

                map[normalized] = keyCode;
            }

            // Numeric aliases for Alpha keys.
            map["0"] = KeyCode.Alpha0;
            map["1"] = KeyCode.Alpha1;
            map["2"] = KeyCode.Alpha2;
            map["3"] = KeyCode.Alpha3;
            map["4"] = KeyCode.Alpha4;
            map["5"] = KeyCode.Alpha5;
            map["6"] = KeyCode.Alpha6;
            map["7"] = KeyCode.Alpha7;
            map["8"] = KeyCode.Alpha8;
            map["9"] = KeyCode.Alpha9;
            map["spacebar"] = KeyCode.Space;
            map["esc"] = KeyCode.Escape;

            return map;
        }

        private static string NormalizeKeyName(string keyName)
        {
            if (string.IsNullOrEmpty(keyName))
                return string.Empty;

            var builder = new StringBuilder(keyName.Length);
            foreach (char c in keyName)
            {
                if (char.IsLetterOrDigit(c))
                    builder.Append(char.ToLowerInvariant(c));
            }

            return builder.ToString();
        }
    }
}
