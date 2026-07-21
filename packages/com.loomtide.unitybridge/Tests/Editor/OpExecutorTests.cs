using System;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class OpExecutorTests
    {
        private OpExecutor _executor;
        private JObject _lastResponse;

        private void Respond(JObject response)
        {
            _lastResponse = response;
        }

        private static BridgeRequestContext Context(string id, string command, JObject parameters = null)
        {
            return new BridgeRequestContext(id, command, parameters ?? new JObject(), "test-session");
        }

        [SetUp]
        public void SetUp()
        {
            _executor = new OpExecutor();
            _lastResponse = null;
        }

        [Test]
        public void Execute_InvalidCommandFormat_ReturnsError()
        {
            _executor.Execute(Context("req-1", "noCategory"), Respond);

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("error", _lastResponse.Value<string>("status"));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, _lastResponse["error"].Value<string>("code"));
        }

        [Test]
        public void Execute_UnknownCategory_ReturnsError()
        {
            _executor.Execute(Context("req-1", "unknown.op"), Respond);

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("error", _lastResponse.Value<string>("status"));
            StringAssert.Contains("unknown", _lastResponse["error"].Value<string>("message"));
        }

        [Test]
        public void Execute_SyncOp_DispatchesToHandler()
        {
            var handler = new MockOpHandler(syncResult: new JObject { ["created"] = true });
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context("req-1", "test.create"), Respond);

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("success", _lastResponse.Value<string>("status"));
            Assert.AreEqual(true, _lastResponse["data"].Value<bool>("created"));
            Assert.AreEqual("create", handler.LastOpName);
        }

        [Test]
        public void Execute_SyncOp_IncludesTrace()
        {
            var handler = new MockOpHandler(syncResult: new JObject());
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context("req-1", "test.op"), Respond);

            Assert.IsNotNull(_lastResponse["trace"]);
            Assert.IsNotNull(_lastResponse["trace"]["consoleDelta"]);
        }

        [Test]
        public void Execute_AsyncOp_DispatchesAsynchronously()
        {
            var handler = new MockOpHandler(isAsync: true);
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context("req-1", "test.async_op"), Respond);

            // Handler captures the respond callback — simulate async completion
            Assert.IsNull(_lastResponse); // Not yet responded
            handler.CompleteAsync(new JObject { ["done"] = true });

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("success", _lastResponse.Value<string>("status"));
            Assert.AreEqual(true, _lastResponse["data"].Value<bool>("done"));
        }

        [Test]
        public void Execute_HandlerThrowsBridgeException_ReturnsTypedError()
        {
            var handler = new MockOpHandler(
                throwOnSync: new BridgeException(ErrorCodes.NOT_FOUND, "Object missing"));
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context("req-1", "test.find"), Respond);

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("error", _lastResponse.Value<string>("status"));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, _lastResponse["error"].Value<string>("code"));
            Assert.AreEqual("Object missing", _lastResponse["error"].Value<string>("message"));
        }

        [Test]
        public void Execute_HandlerThrowsGenericException_ReturnsInternalError()
        {
            var handler = new MockOpHandler(
                throwOnSync: new InvalidOperationException("Something broke"));
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context("req-1", "test.broken"), Respond);

            Assert.IsNotNull(_lastResponse);
            Assert.AreEqual("error", _lastResponse.Value<string>("status"));
            Assert.AreEqual("INTERNAL_ERROR", _lastResponse["error"].Value<string>("code"));
        }

        [Test]
        public void Execute_MissingRequestId_DefaultsToUnknown()
        {
            var handler = new MockOpHandler(syncResult: new JObject());
            _executor.RegisterCategory("test", handler);

            _executor.Execute(Context(null, "test.op"), Respond);

            Assert.AreEqual("unknown", _lastResponse.Value<string>("id"));
        }

        [Test]
        public void RegisterCategory_OverwritesPrevious()
        {
            var handler1 = new MockOpHandler(syncResult: new JObject { ["v"] = 1 });
            var handler2 = new MockOpHandler(syncResult: new JObject { ["v"] = 2 });

            _executor.RegisterCategory("test", handler1);
            _executor.RegisterCategory("test", handler2);

            _executor.Execute(Context("req-1", "test.op"), Respond);

            Assert.AreEqual(2, _lastResponse["data"].Value<int>("v"));
        }

        // ─────────────────────────────────────────────
        // Mock Handler
        // ─────────────────────────────────────────────

        private class MockOpHandler : IOpHandler
        {
            private readonly JObject _syncResult;
            private readonly bool _isAsync;
            private readonly Exception _throwOnSync;

            private Action<JObject> _asyncRespond;
            private Action<BridgeException> _asyncError;

            public string LastOpName { get; private set; }

            public MockOpHandler(JObject syncResult = null, bool isAsync = false, Exception throwOnSync = null)
            {
                _syncResult = syncResult;
                _isAsync = isAsync;
                _throwOnSync = throwOnSync;
            }

            public bool IsAsync(string opName) => _isAsync;

            public JObject HandleOp(string opName, JObject parameters)
            {
                LastOpName = opName;
                if (_throwOnSync != null) throw _throwOnSync;
                return _syncResult ?? new JObject();
            }

            public void HandleOpAsync(string opName, JObject parameters,
                Action<JObject> respond, Action<BridgeException> onError)
            {
                LastOpName = opName;
                _asyncRespond = respond;
                _asyncError = onError;
            }

            public void CompleteAsync(JObject result) => _asyncRespond?.Invoke(result);
            public void FailAsync(BridgeException error) => _asyncError?.Invoke(error);
        }
    }
}
