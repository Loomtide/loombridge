using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles deterministic verification-capture invocation.
    ///
    /// `capture.invoke_static` calls a project-authored STATIC capture method by
    /// (component, method) and lets it write its own gate JSON into outDir — so a
    /// capture like the platformer `GroundTiling.WriteTileCaptures` is produced
    /// from RAW in-editor sampling, never hand-authored. The op shape is generic
    /// (component + method + outDir) but LOCKED to the project-configurable
    /// <see cref="EditorInvokeAllowlist"/> (RCL-T06): only vetted entry points may
    /// be invoked through the bridge. Anything off the allowlist is refused.
    /// </summary>
    public class CaptureHandler : IOpHandler
    {
        private static readonly Dictionary<string, string[]> ExpectedOutputs =
            new Dictionary<string, string[]>(StringComparer.Ordinal)
            {
                {
                    "GroundTiling.WriteTileCaptures",
                    new[] { "platform-tiles.json", "tile-render.json" }
                }
            };

        public bool IsAsync(string opName) => false;

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "invoke_static":
                    return HandleInvokeStatic(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND, $"Unknown capture op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            throw new BridgeException(ErrorCodes.NOT_FOUND, $"Capture op '{opName}' is not async.");
        }

        private JObject HandleInvokeStatic(JObject parameters)
        {
            string component = parameters.Value<string>("component");
            string method = parameters.Value<string>("method");
            string outDir = parameters.Value<string>("outDir");

            if (string.IsNullOrEmpty(component))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'component'");
            if (string.IsNullOrEmpty(method))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'method'");
            if (string.IsNullOrEmpty(outDir))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Missing required parameter: 'outDir'");

            string key = $"{component}.{method}";
            EditorInvokeAllowlist allowlist = EditorInvokeAllowlist.Load();
            if (!allowlist.IsStaticMethodAllowed(key))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"capture.invoke_static refused '{key}': not on the allowlist [{allowlist.StaticMethodsForError()}]. " +
                    $"Capture entry points are vetted; add \"{key}\" to staticMethods[] in {EditorInvokeAllowlist.ConfigRelativePath} to enable it.");

            Type type = ResolveType(component);
            if (type == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Capture component type '{component}' not found in any loaded assembly. " +
                    $"Author it (e.g. Assets/Scripts/Level/{component}.cs) and let it compile before capturing.");

            MethodInfo mi = type.GetMethod(method, BindingFlags.Public | BindingFlags.Static);
            if (mi == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Static method '{method}' not found on '{component}'.");

            ParameterInfo[] ps = mi.GetParameters();
            if (ps.Length != 1 || ps[0].ParameterType != typeof(string))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"'{key}' must have signature (string outDir); found {ps.Length} parameter(s).");

            // Absolute outDir so the method writes where the CLI expects regardless of Unity's cwd.
            string absOutDir = Path.IsPathRooted(outDir)
                ? outDir
                : Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), outDir));
            ValidateCaptureOutDir(absOutDir);
            Directory.CreateDirectory(absOutDir);
            string[] expected = ExpectedOutputs.ContainsKey(key) ? ExpectedOutputs[key] : Array.Empty<string>();
            foreach (string file in expected)
            {
                string target = Path.Combine(absOutDir, file);
                if (File.Exists(target))
                    File.Delete(target);
            }

            try
            {
                mi.Invoke(null, new object[] { absOutDir });
            }
            catch (TargetInvocationException tie)
            {
                Exception inner = tie.InnerException ?? tie;
                throw new BridgeException("INTERNAL_ERROR",
                    $"'{key}' threw during capture: {inner.Message}");
            }

            // Report only allowlisted expected outputs created by this invocation.
            // Stale JSON present before the call is deleted above and cannot be
            // re-stamped as current capture evidence by the CLI.
            string[] wrote = expected
                .Where(file => File.Exists(Path.Combine(absOutDir, file)))
                .ToArray();

            return new JObject
            {
                ["component"] = component,
                ["method"] = method,
                ["outDir"] = absOutDir,
                ["wrote"] = new JArray(wrote.Cast<object>().ToArray()),
                ["playMode"] = EditorApplication.isPlaying,
            };
        }

        private static Type ResolveType(string typeName)
        {
            // Exact short-name match across loaded assemblies (the project's
            // Assembly-CSharp included). Prefer a non-namespaced match first.
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                foreach (Type t in types)
                {
                    if (t != null && t.Name == typeName) return t;
                }
            }
            return null;
        }

        private static void ValidateCaptureOutDir(string absOutDir)
        {
            string projectRoot = Path.GetFullPath(Path.GetDirectoryName(Application.dataPath) ?? Directory.GetCurrentDirectory());
            string verifyRoot = Path.GetFullPath(Path.Combine(projectRoot, ".loombridge", "verify"));
            string target = Path.GetFullPath(absOutDir);
            if (!IsWithin(verifyRoot, target))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"capture.invoke_static refused outDir '{absOutDir}': capture writes must stay under '{verifyRoot}'.");
            }
        }

        private static bool IsWithin(string basePath, string targetPath)
        {
            string root = Path.GetFullPath(basePath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string target = Path.GetFullPath(targetPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(root, target, StringComparison.Ordinal))
                return true;
            return target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        }
    }
}
