using Newtonsoft.Json.Linq;

namespace UnityBridge.Core
{
    /// <summary>
    /// Builds deterministic capability signals that handlers can reuse for fail-fast gating.
    /// </summary>
    public static class UnityBridgeCapabilities
    {
        public static JObject BuildInputCapabilitySignal(JObject inputCapabilities)
        {
            bool backendAvailable = inputCapabilities?["backend"]?.Value<bool?>("available") ?? false;
            string selectedBackend = inputCapabilities?["backend"]?.Value<string>("selected") ?? "none";

            if (backendAvailable)
            {
                return new JObject
                {
                    ["supported"] = true,
                    ["deterministic"] = true,
                    ["reason"] = $"Input capability supported via backend '{selectedBackend}'.",
                    ["blockerCode"] = null
                };
            }

            return new JObject
            {
                ["supported"] = false,
                ["deterministic"] = true,
                ["reason"] = "Input capability blocked: no available input backend.",
                ["blockerCode"] = ErrorCodes.INPUT_CAPABILITY_BLOCKED
            };
        }

        public static void EnsureInputCapabilityOrThrow(string opName, JObject inputCapabilities)
        {
            JObject signal = BuildInputCapabilitySignal(inputCapabilities);
            if (signal.Value<bool>("supported"))
                return;

            string reason = signal.Value<string>("reason")
                ?? "Input capability blocked.";
            throw new BridgeException(
                ErrorCodes.INPUT_CAPABILITY_BLOCKED,
                $"Input capability blocked for '{opName}': {reason}");
        }
    }
}
