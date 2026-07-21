using System;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;

namespace UnityBridge.Tests
{
    /// <summary>
    /// Tests for PackageHandler that do NOT contact the live Unity Package Manager
    /// registry: async-op routing and synchronous parameter validation. Param validation
    /// in the handler calls onError immediately (before any Client.* request is issued),
    /// so the error is observable synchronously without polling WaitEngine. A real
    /// add/list round-trip is intentionally not exercised here (network + domain reload
    /// make it unsuitable for a fast, deterministic EditMode test).
    /// </summary>
    [TestFixture]
    public class PackageHandlerTests
    {
        private PackageHandler _handler;

        [SetUp]
        public void SetUp()
        {
            _handler = new PackageHandler();
        }

        /// <summary>Invokes an async op and returns the BridgeException if onError fires synchronously, else null.</summary>
        private BridgeException CaptureSyncError(string opName, JObject parameters)
        {
            BridgeException captured = null;
            bool responded = false;
            _handler.HandleOpAsync(opName, parameters,
                _ => responded = true,
                err => captured = err);
            Assert.IsFalse(responded, "Did not expect a successful response for an invalid-params case.");
            return captured;
        }

        [Test]
        public void IsAsync_TrueForAllPackageOps()
        {
            Assert.IsTrue(_handler.IsAsync("add"));
            Assert.IsTrue(_handler.IsAsync("list"));
            Assert.IsTrue(_handler.IsAsync("remove"));
            Assert.IsTrue(_handler.IsAsync("search"));
            Assert.IsFalse(_handler.IsAsync("nonsense"));
        }

        [Test]
        public void HandleOp_Sync_ThrowsBecauseOpsAreAsync()
        {
            var ex = Assert.Throws<BridgeException>(
                () => _handler.HandleOp("list", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void Add_MissingPackageId_InvalidParams()
        {
            BridgeException ex = CaptureSyncError("add", new JObject());
            Assert.IsNotNull(ex);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Remove_MissingPackageName_InvalidParams()
        {
            BridgeException ex = CaptureSyncError("remove", new JObject());
            Assert.IsNotNull(ex);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void Search_MissingQuery_InvalidParams()
        {
            BridgeException ex = CaptureSyncError("search", new JObject());
            Assert.IsNotNull(ex);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void HandleOpAsync_UnknownOp_NotFound()
        {
            BridgeException ex = CaptureSyncError("bogus", new JObject());
            Assert.IsNotNull(ex);
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }
    }
}
