using Newtonsoft.Json.Linq;

namespace UnityBridge.Core
{
    /// <summary>
    /// Defense-in-depth helper for clients that pre-stringify JSON values.
    ///
    /// Some MCP hosts coerce tool-call arguments to strings when the input schema
    /// does not declare an explicit type. This helper detects a JString that
    /// re-parses to a non-string JSON token and returns the parsed shape so
    /// downstream handlers see the intended type (object, number, bool, null, array).
    ///
    /// Plain strings (asset paths, names, text) are returned unchanged.
    /// </summary>
    public static class JsonValueCoercer
    {
        public static JToken Rehydrate(JToken input)
        {
            if (input == null || input.Type != JTokenType.String)
                return input;

            string raw = input.Value<string>();
            if (string.IsNullOrEmpty(raw))
                return input;

            char first = raw[0];
            bool looksLikeJson =
                first == '{' || first == '[' ||
                raw == "null" || raw == "true" || raw == "false" ||
                (first >= '0' && first <= '9') || first == '-';

            if (!looksLikeJson)
                return input;

            try
            {
                JToken parsed = JToken.Parse(raw);
                return parsed.Type == JTokenType.String ? input : parsed;
            }
            catch
            {
                return input;
            }
        }
    }
}
