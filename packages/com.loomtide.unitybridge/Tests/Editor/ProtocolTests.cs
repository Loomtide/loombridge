using System;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Core.Input;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class BridgeRequestParseTests
    {
        [Test]
        public void Parse_ValidRequest_ExtractsAllFields()
        {
            string json = @"{""id"":""req-1"",""command"":""scene.create_object"",""params"":{""name"":""Cube""}}";
            BridgeRequest request = BridgeRequest.Parse(json);

            Assert.AreEqual("req-1", request.Id);
            Assert.AreEqual("scene.create_object", request.Command);
            Assert.AreEqual("Cube", request.Params.Value<string>("name"));
        }

        [Test]
        public void Parse_MissingId_ThrowsBridgeException()
        {
            string json = @"{""command"":""scene.create_object"",""params"":{}}";
            var ex = Assert.Throws<BridgeException>(() => BridgeRequest.Parse(json));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("id", ex.Message);
        }

        [Test]
        public void Parse_EmptyId_ThrowsBridgeException()
        {
            string json = @"{""id"":"""",""command"":""scene.create_object"",""params"":{}}";
            var ex = Assert.Throws<BridgeException>(() => BridgeRequest.Parse(json));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Parse_MissingCommand_ThrowsBridgeException()
        {
            string json = @"{""id"":""req-1"",""params"":{}}";
            var ex = Assert.Throws<BridgeException>(() => BridgeRequest.Parse(json));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("command", ex.Message);
        }

        [Test]
        public void Parse_MissingParams_DefaultsToEmptyJObject()
        {
            string json = @"{""id"":""req-1"",""command"":""bridge.ping""}";
            BridgeRequest request = BridgeRequest.Parse(json);

            Assert.IsNotNull(request.Params);
            Assert.AreEqual(0, request.Params.Count);
        }

        [Test]
        public void Parse_InvalidJson_ThrowsException()
        {
            Assert.Throws<Newtonsoft.Json.JsonReaderException>(
                () => BridgeRequest.Parse("not json"));
        }

        [Test]
        public void RequestContext_UsesRequestMetadataWithoutMutatingParams()
        {
            var parameters = new JObject { ["name"] = "Cube" };
            var context = new BridgeRequestContext("req-ctx", "scene.create_object", parameters, "session-1");

            Assert.AreEqual("req-ctx", context.RequestId);
            Assert.AreEqual("scene.create_object", context.Command);
            Assert.AreEqual("session-1", context.SessionId);
            Assert.AreEqual("Cube", context.Parameters.Value<string>("name"));
            Assert.IsNull(context.Parameters["_requestId"]);
        }
    }

    [TestFixture]
    public class BridgeResponseTests
    {
        [Test]
        public void Success_ContainsRequiredFields()
        {
            var data = new JObject { ["value"] = 42 };
            JObject response = BridgeResponse.Success("req-1", data);

            Assert.AreEqual("req-1", response.Value<string>("id"));
            Assert.AreEqual("success", response.Value<string>("status"));
            Assert.AreEqual(42, response["data"].Value<int>("value"));
            Assert.IsNotNull(response["trace"]);
            Assert.IsNotNull(response["timestamp"]);
        }

        [Test]
        public void Success_WithTrace_IncludesTrace()
        {
            var data = new JObject();
            var trace = new JObject { ["consoleDelta"] = new JArray { "log line" } };
            JObject response = BridgeResponse.Success("req-1", data, trace);

            Assert.AreEqual(1, ((JArray)response["trace"]["consoleDelta"]).Count);
        }

        [Test]
        public void Error_ContainsErrorCodeAndMessage()
        {
            JObject response = BridgeResponse.Error("req-1", "NOT_FOUND", "Object not found");

            Assert.AreEqual("req-1", response.Value<string>("id"));
            Assert.AreEqual("error", response.Value<string>("status"));
            Assert.AreEqual("NOT_FOUND", response["error"].Value<string>("code"));
            Assert.AreEqual("Object not found", response["error"].Value<string>("message"));
            Assert.IsTrue(response["data"].Type == JTokenType.Null);
        }

        [Test]
        public void ErrorCodes_HandshakeRequired_IsStable()
        {
            Assert.AreEqual("HANDSHAKE_REQUIRED", ErrorCodes.HANDSHAKE_REQUIRED);
        }

        [Test]
        public void ErrorCodes_InputCodes_AreStable()
        {
            Assert.AreEqual("INPUT_BACKEND_UNAVAILABLE", ErrorCodes.INPUT_BACKEND_UNAVAILABLE);
            Assert.AreEqual("INPUT_SYSTEM_NOT_INSTALLED", ErrorCodes.INPUT_SYSTEM_NOT_INSTALLED);
            Assert.AreEqual("INPUT_CAPABILITY_BLOCKED", ErrorCodes.INPUT_CAPABILITY_BLOCKED);
            Assert.AreEqual("FOCUS_REQUIRED", ErrorCodes.FOCUS_REQUIRED);
            Assert.AreEqual("INVALID_KEY", ErrorCodes.INVALID_KEY);
            Assert.AreEqual("INPUT_SESSION_REQUIRED", ErrorCodes.INPUT_SESSION_REQUIRED);
            Assert.AreEqual("LEGACY_INPUT_UNSUPPORTED", ErrorCodes.LEGACY_INPUT_UNSUPPORTED);
        }

        [Test]
        public void InputService_GetCapabilities_ReturnsDeterministicShape()
        {
            var service = new InputService(new IInputBackend[]
            {
                new StubBackend("InputSystem", true, true, "Input System package must be installed"),
                new StubBackend("EditorEvent", true, true, "No runtime-spawn tracking in v0.6.0")
            });

            JObject result = service.GetCapabilities();

            Assert.AreEqual(true, result["backend"].Value<bool>("available"));
            Assert.AreEqual("InputSystem", result["backend"].Value<string>("selected"));
            Assert.AreEqual(true, result["focus"].Value<bool>("required"));
            Assert.IsNotNull(result["focus"]["gameViewFocused"]);
            Assert.AreEqual(true, result.Value<bool>("requiresPlayMode"));
            Assert.AreEqual(true, result["session"].Value<bool>("required"));
            Assert.AreEqual(false, result["session"].Value<bool>("active"));
            Assert.GreaterOrEqual(((JArray)result["backend"]["fallbackOrder"]).Count, 2);
            Assert.GreaterOrEqual(((JArray)result["backend"]["backends"]).Count, 2);
            Assert.GreaterOrEqual(((JArray)result["limitations"]).Count, 2);
        }

        private sealed class StubBackend : IInputBackend
        {
            private readonly string _name;
            private readonly bool _available;
            private readonly bool _requiresFocus;
            private readonly string _limitation;

            public StubBackend(string name, bool available, bool requiresFocus, string limitation)
            {
                _name = name;
                _available = available;
                _requiresFocus = requiresFocus;
                _limitation = limitation;
            }

            public string Name => _name;
            public bool IsAvailable => _available;
            public bool RequiresGameViewFocus => _requiresFocus;
            public bool CanInjectGameplayKeys => _available;
            public bool HasHeldKeys => false;

            public JArray GetLimitations()
            {
                return new JArray(_limitation);
            }

            public void BeginSession(string sessionId) { }
            public void EndSession() { }
            public void KeyDown(UnityEngine.KeyCode keyCode) { }
            public void KeyUp(UnityEngine.KeyCode keyCode) { }
            public void KeyTap(UnityEngine.KeyCode keyCode) { }
            public void ClickUi(JObject parameters) { }
        }
    }
}
