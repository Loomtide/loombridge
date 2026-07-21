using System;
using Newtonsoft.Json.Linq;

namespace UnityBridge.Core
{
    /// <summary>
    /// Wire protocol request parsed from incoming WebSocket JSON.
    /// </summary>
    public class BridgeRequest
    {
        public string Id { get; private set; }
        public string Command { get; private set; }
        public JObject Params { get; private set; }

        private BridgeRequest() { }

        /// <summary>
        /// Parses a raw JSON string into a BridgeRequest.
        /// Throws on invalid JSON or missing fields.
        /// </summary>
        public static BridgeRequest Parse(string json)
        {
            JObject obj = JObject.Parse(json);

            string id = obj.Value<string>("id");
            if (string.IsNullOrEmpty(id))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required field: 'id'");

            string command = obj.Value<string>("command");
            if (string.IsNullOrEmpty(command))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required field: 'command'");

            return new BridgeRequest
            {
                Id = id,
                Command = command,
                Params = obj.Value<JObject>("params") ?? new JObject()
            };
        }
    }

    /// <summary>
    /// Immutable request context passed through bridge routing.
    /// Carries request identity without mutating op params.
    /// </summary>
    public sealed class BridgeRequestContext
    {
        public string RequestId { get; private set; }
        public string Command { get; private set; }
        public JObject Parameters { get; private set; }
        public string SessionId { get; private set; }

        public BridgeRequestContext(string requestId, string command, JObject parameters, string sessionId = null)
        {
            RequestId = string.IsNullOrEmpty(requestId) ? "unknown" : requestId;
            Command = command ?? string.Empty;
            Parameters = parameters ?? new JObject();
            SessionId = sessionId ?? string.Empty;
        }
    }

    /// <summary>
    /// Wire protocol response with static factory methods.
    /// All responses follow the shape: { id, status, data, error?, trace, timestamp }
    /// </summary>
    public static class BridgeResponse
    {
        /// <summary>
        /// Creates a success response with data and optional trace.
        /// </summary>
        public static JObject Success(string id, JObject data, JObject trace = null)
        {
            return new JObject
            {
                ["id"] = id,
                ["status"] = "success",
                ["data"] = data,
                ["trace"] = trace ?? new JObject { ["consoleDelta"] = new JArray() },
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }

        /// <summary>
        /// Creates an error response with code, message, and optional trace.
        /// </summary>
        public static JObject Error(string id, string code, string message, JObject trace = null)
        {
            return new JObject
            {
                ["id"] = id,
                ["status"] = "error",
                ["data"] = null,
                ["error"] = new JObject
                {
                    ["code"] = code,
                    ["message"] = message
                },
                ["trace"] = trace ?? new JObject { ["consoleDelta"] = new JArray() },
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }
    }

    /// <summary>
    /// Standard error code constants used across the bridge protocol.
    /// </summary>
    public static class ErrorCodes
    {
        public const string NOT_FOUND = "NOT_FOUND";
        public const string INVALID_TYPE = "INVALID_TYPE";
        public const string INVALID_PARAMS = "INVALID_PARAMS";
        public const string AMBIGUOUS_PROPERTY = "AMBIGUOUS_PROPERTY";
        public const string COMPILATION_ERROR = "COMPILATION_ERROR";
        public const string TIMEOUT = "TIMEOUT";
        public const string PLAY_MODE_REQUIRED = "PLAY_MODE_REQUIRED";
        public const string EDIT_MODE_REQUIRED = "EDIT_MODE_REQUIRED";
        public const string LOCATOR_UNRESOLVED = "LOCATOR_UNRESOLVED";
        public const string CONNECTION_LOST = "CONNECTION_LOST";
        public const string PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH";
        public const string HANDSHAKE_REQUIRED = "HANDSHAKE_REQUIRED";
        public const string INPUT_BACKEND_UNAVAILABLE = "INPUT_BACKEND_UNAVAILABLE";
        public const string INPUT_SYSTEM_NOT_INSTALLED = "INPUT_SYSTEM_NOT_INSTALLED";
        public const string INPUT_CAPABILITY_BLOCKED = "INPUT_CAPABILITY_BLOCKED";
        public const string FOCUS_REQUIRED = "FOCUS_REQUIRED";
        public const string INVALID_KEY = "INVALID_KEY";
        public const string INPUT_SESSION_REQUIRED = "INPUT_SESSION_REQUIRED";
        public const string INPUT_SESSION_EXPIRED = "INPUT_SESSION_EXPIRED";
        public const string LEGACY_INPUT_UNSUPPORTED = "LEGACY_INPUT_UNSUPPORTED";
    }

    /// <summary>
    /// Exception type that carries an error code for wire protocol error responses.
    /// </summary>
    public class BridgeException : Exception
    {
        public string Code { get; private set; }

        public BridgeException(string code, string message) : base(message)
        {
            Code = code;
        }

        public BridgeException(string code, string message, Exception innerException)
            : base(message, innerException)
        {
            Code = code;
        }
    }
}
