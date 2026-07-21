using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Project-configurable allowlist for the bridge's two code-execution surfaces:
    /// `capture.invoke_static` (reflection-invoke a project static method) and
    /// `editor.execute_menu_item` (run an Editor menu item). This is the security
    /// gate for RCL-T06 — generalising the previously hardcoded single-method
    /// allowlist into a list the PROJECT OWNER vets, without ever invoking arbitrary
    /// code unguarded.
    ///
    /// The allowlist = built-in defaults UNION an optional project file at
    /// `&lt;projectRoot&gt;/.loomtide/editor-allowlist.json`:
    /// <code>
    /// {
    ///   "staticMethods": ["MyBuilder.WriteLayout"],
    ///   "menuItems": ["Tools/MyGame/Generate Blockout"]
    /// }
    /// </code>
    /// Read FRESH on every invocation so a human can edit it without restarting
    /// Unity. Anything not listed is REFUSED. Menu items have NO built-in default
    /// (strict: a project must opt every menu in explicitly); the only built-in
    /// static method is the platformer tiling capture entry point.
    /// </summary>
    internal sealed class EditorInvokeAllowlist
    {
        /// <summary>The single built-in static-method entry point (platformer tiling slice).</summary>
        internal const string DefaultStaticMethod = "GroundTiling.WriteTileCaptures";

        /// <summary>Project config file, relative to the Unity project root.</summary>
        internal const string ConfigRelativePath = ".loomtide/editor-allowlist.json";

        /// <summary>Test seam: when set, <see cref="Load"/> returns this instead of reading disk. Never set in production.</summary>
        internal static EditorInvokeAllowlist OverrideForTests;

        internal HashSet<string> StaticMethods { get; }
        internal HashSet<string> MenuItems { get; }

        /// <summary>Absolute path of the config file consulted (for diagnostics); null when none resolved.</summary>
        internal string ConfigPath { get; }

        private EditorInvokeAllowlist(HashSet<string> staticMethods, HashSet<string> menuItems, string configPath)
        {
            StaticMethods = staticMethods;
            MenuItems = menuItems;
            ConfigPath = configPath;
        }

        internal bool IsStaticMethodAllowed(string key) => key != null && StaticMethods.Contains(key);

        internal bool IsMenuItemAllowed(string menuPath) => menuPath != null && MenuItems.Contains(menuPath);

        internal string StaticMethodsForError() => Describe(StaticMethods);

        internal string MenuItemsForError() => Describe(MenuItems);

        private static string Describe(HashSet<string> set) =>
            set.Count == 0 ? "<none>" : string.Join(", ", set.OrderBy(s => s, StringComparer.Ordinal));

        /// <summary>
        /// The effective allowlist for the running Unity project (built-ins UNION the
        /// project config). Reads disk fresh; honours <see cref="OverrideForTests"/>.
        /// </summary>
        internal static EditorInvokeAllowlist Load()
        {
            if (OverrideForTests != null) return OverrideForTests;
            return LoadFrom(ResolveProjectRoot());
        }

        /// <summary>
        /// Builds the allowlist from a specific project root. Built-in defaults are
        /// always present; the project file (if any) ADDS to them. A malformed config
        /// file is ignored (defaults still apply) rather than throwing — a broken file
        /// can only ever REDUCE what is reachable, never widen it past the file's intent.
        /// </summary>
        internal static EditorInvokeAllowlist LoadFrom(string projectRoot)
        {
            var staticMethods = new HashSet<string>(StringComparer.Ordinal) { DefaultStaticMethod };
            var menuItems = new HashSet<string>(StringComparer.Ordinal);

            string configPath = string.IsNullOrEmpty(projectRoot)
                ? null
                : Path.GetFullPath(Path.Combine(projectRoot, ConfigRelativePath));

            if (configPath != null && File.Exists(configPath))
            {
                try
                {
                    JObject parsed = JObject.Parse(File.ReadAllText(configPath));
                    AddStrings(staticMethods, parsed["staticMethods"]);
                    AddStrings(menuItems, parsed["menuItems"]);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[UnityBridge] Ignoring malformed {ConfigRelativePath}: {ex.Message}");
                }
            }

            return new EditorInvokeAllowlist(staticMethods, menuItems, configPath);
        }

        private static void AddStrings(HashSet<string> target, JToken token)
        {
            if (token is JArray array)
            {
                foreach (JToken item in array)
                {
                    string value = item?.Type == JTokenType.String ? item.Value<string>() : null;
                    if (!string.IsNullOrWhiteSpace(value)) target.Add(value.Trim());
                }
            }
        }

        /// <summary>Test seam: build an allowlist inline (no disk), for driving the handler gate.</summary>
        internal static EditorInvokeAllowlist ForTests(IEnumerable<string> staticMethods, IEnumerable<string> menuItems)
        {
            return new EditorInvokeAllowlist(
                new HashSet<string>(staticMethods ?? Enumerable.Empty<string>(), StringComparer.Ordinal),
                new HashSet<string>(menuItems ?? Enumerable.Empty<string>(), StringComparer.Ordinal),
                null);
        }

        /// <summary>Unity project root (parent of Assets/), falling back to the process cwd.</summary>
        internal static string ResolveProjectRoot()
        {
            string fromData = Path.GetDirectoryName(Application.dataPath);
            return Path.GetFullPath(string.IsNullOrEmpty(fromData) ? Directory.GetCurrentDirectory() : fromData);
        }
    }
}
