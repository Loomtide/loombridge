using System;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles script/code operations: create, read, modify, and attach scripts.
    /// Validates paths are under the Unity Assets directory for security.
    /// </summary>
    public class CodeHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "create_script":
                    return HandleCreateScript(parameters);
                case "read_script":
                    return HandleReadScript(parameters);
                case "modify_script":
                    return HandleModifyScript(parameters);
                case "attach_script":
                    return HandleAttachScript(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown code op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in CodeHandler
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Code op '{opName}' is not async.");
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleCreateScript(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            string content = parameters.Value<string>("content");
            if (content == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'content'");

            ValidateAssetPath(path);

            if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Script path must end with '.cs': '{path}'");

            string fullPath = GetFullPath(path);

            string ifExists = parameters.Value<string>("if_exists") ?? "error";
            if (ifExists != "error" && ifExists != "replace" && ifExists != "skip")
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Invalid 'if_exists': '{ifExists}'. Expected 'error', 'replace', or 'skip'.");

            if (File.Exists(fullPath))
            {
                if (ifExists == "error")
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Script already exists: '{path}'. Use code.modify_script to update, or pass if_exists='replace' or 'skip'.");

                if (ifExists == "skip")
                    return new JObject
                    {
                        ["path"] = path,
                        ["skipped"] = true
                    };
            }

            string directory = Path.GetDirectoryName(fullPath);
            if (!Directory.Exists(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllText(fullPath, content);
            // NOTE: this synchronous import triggers a compile + domain reload PER call,
            // which briefly drops the WebSocket — fine for a one-off, but authoring many
            // scripts back-to-back this way is fragile (parallel calls can race the
            // reload). A clean per-call "defer compile" flag is NOT trivially available:
            // deferring would require bracketing AssetDatabase.StartAssetEditing/
            // StopAssetEditing (and compilation-pipeline locking) across SEPARATE MCP
            // calls, which the per-call op model can't hold open safely. The documented
            // workaround (verify/build skills) is therefore to author every .cs via the
            // filesystem Write tool, then trigger ONE editor.refresh_assets — a single
            // compile/reload instead of N. Keep this op for single-file edits.
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            ShowWorkVisualizer.SelectAsset(path);

            return new JObject
            {
                ["path"] = path,
                ["replaced"] = ifExists == "replace" && File.Exists(fullPath)
            };
        }

        private JObject HandleReadScript(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            ValidateAssetPath(path);

            string fullPath = GetFullPath(path);
            if (!File.Exists(fullPath))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Script not found: '{path}'");

            string content = File.ReadAllText(fullPath);

            return new JObject
            {
                ["content"] = content,
                ["path"] = path
            };
        }

        private JObject HandleModifyScript(JObject parameters)
        {
            string path = parameters.Value<string>("path");
            if (string.IsNullOrEmpty(path))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'path'");

            string content = parameters.Value<string>("content");
            if (content == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'content'");

            ValidateAssetPath(path);

            string fullPath = GetFullPath(path);
            if (!File.Exists(fullPath))
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Script not found: '{path}'");

            File.WriteAllText(fullPath, content);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            ShowWorkVisualizer.SelectAsset(path);

            return new JObject
            {
                ["path"] = path
            };
        }

        private JObject HandleAttachScript(JObject parameters)
        {
            JObject locator = parameters.Value<JObject>("locator");
            if (locator == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'locator'");

            string scriptName = parameters.Value<string>("script_name");
            if (string.IsNullOrEmpty(scriptName))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'script_name'");

            GameObject go = LocatorResolver.Resolve(locator);

            // Resolve via MonoScript asset lookup to avoid duplicate class name collisions
            string[] guids = AssetDatabase.FindAssets($"t:MonoScript {scriptName}");
            MonoScript targetScript = null;

            foreach (string guid in guids)
            {
                string assetPath = AssetDatabase.GUIDToAssetPath(guid);
                MonoScript ms = AssetDatabase.LoadAssetAtPath<MonoScript>(assetPath);
                if (ms != null && ms.name == scriptName)
                {
                    if (targetScript != null)
                        throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                            $"Ambiguous script name '{scriptName}': found multiple MonoScript assets. " +
                            "Use code.attach_script with a unique script name.");
                    targetScript = ms;
                }
            }

            if (targetScript == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"MonoScript '{scriptName}' not found. " +
                    "Ensure the script has compiled successfully.");

            Type scriptType = targetScript.GetClass();
            if (scriptType == null)
                throw new BridgeException(ErrorCodes.NOT_FOUND,
                    $"Script '{scriptName}' has no compiled class. " +
                    "Check for compile errors.");

            if (!typeof(MonoBehaviour).IsAssignableFrom(scriptType))
                throw new BridgeException(ErrorCodes.INVALID_TYPE,
                    $"Type '{scriptName}' is not a MonoBehaviour and cannot be attached as a script.");

            Undo.AddComponent(go, scriptType);
            ShowWorkVisualizer.SelectObject(go);

            return new JObject
            {
                ["attached"] = true,
                ["script_name"] = scriptName,
                ["locator"] = LocatorResolver.BuildLocator(go)
            };
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        /// <summary>
        /// Validates that the given path is under the Unity Assets directory.
        /// Prevents writing files outside the project.
        /// </summary>
        private static void ValidateAssetPath(string path)
        {
            if (!path.StartsWith("Assets/") && !path.StartsWith("Assets\\"))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Path must be under 'Assets/': '{path}'");
            }

            // Check for path traversal (use separator boundary to prevent AssetsEvil/ bypass)
            string normalized = Path.GetFullPath(Path.Combine(Application.dataPath, "..", path));
            string assetsDir = Path.GetFullPath(Application.dataPath) + Path.DirectorySeparatorChar;
            if (!normalized.StartsWith(assetsDir))
            {
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Path escapes Assets directory: '{path}'");
            }
        }

        private static string GetFullPath(string assetPath)
        {
            return Path.Combine(Application.dataPath, "..", assetPath);
        }
    }
}
