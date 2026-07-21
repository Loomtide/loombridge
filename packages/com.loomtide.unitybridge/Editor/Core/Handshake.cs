using Newtonsoft.Json.Linq;
using UnityEditor.PackageManager;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Handles the bridge.initialize handshake command.
    /// Registers itself with a BridgeServer to respond to handshake requests.
    /// </summary>
    public static class Handshake
    {
        // Fallback only — used when the package version can't be resolved (e.g. the
        // bridge is loaded from loose source rather than as a UPM package). Keep it in
        // sync with package.json as a floor; the real value is read from PackageInfo.
        private const string FallbackPluginVersion = "0.2.0";
        private const int ProtocolVersion = 1;

        // The bridge's advertised plugin version. Derived from the RESOLVED package
        // manifest (package.json#version) so it can never drift from what ships —
        // whether installed as a file: tarball dependency, a Git URL, or embedded.
        private static string PluginVersion
        {
            get
            {
                try
                {
                    var info = PackageInfo.FindForAssembly(typeof(Handshake).Assembly);
                    if (info != null && !string.IsNullOrEmpty(info.version)) return info.version;
                }
                catch { /* fall through to the floor */ }
                return FallbackPluginVersion;
            }
        }

        /// <summary>
        /// Registers the bridge.initialize handler with the given server.
        /// </summary>
        public static void Register(BridgeServer server)
        {
            server.RegisterHandler("bridge.initialize", (id, parameters) =>
            {
                var data = new JObject
                {
                    ["engine"] = "unity",
                    ["engineVersion"] = Application.unityVersion,
                    ["pluginVersion"] = PluginVersion,
                    ["port"] = server.ActivePort,
                    ["protocolVersion"] = ProtocolVersion,
                    ["sessionId"] = server.SessionId,
                    ["capabilities"] = new JObject
                    {
                        ["screenshotTargets"] = new JArray("scene", "game"),
                        ["supportedCategories"] = new JArray(
                            "scene", "editor", "component", "code", "animator", "ui", "asset", "input"),
                        ["maxPayloadBytes"] = 5242880, // 5MB
                        ["supportsAnimatorSpec"] = true,
                        ["supportsGlobalObjectId"] = true
                    }
                };
                data.Merge(ProjectIdentity.ToJson());

                Debug.Log(
                    $"[UnityBridge] Handshake completed (sessionId: {server.SessionId}, "
                    + $"port: {server.ActivePort}, protocolVersion: {ProtocolVersion})");
                return BridgeResponse.Success(id, data);
            });
        }
    }
}
