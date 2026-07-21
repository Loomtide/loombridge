using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the RCL-T06 generalised capture.invoke_static allowlist: a
    /// non-allowlisted method is refused; an allowlisted project static method actually runs
    /// and writes under .loombridge/verify/.
    /// </summary>
    [TestFixture]
    public class CaptureHandlerTests
    {
        /// <summary>A vetted project-style capture entry point used by the happy-path test.</summary>
        internal static class Probe
        {
            internal const string SentinelFile = "t06-capture-probe.txt";

            public static void WriteProbe(string outDir)
            {
                File.WriteAllText(Path.Combine(outDir, SentinelFile), "ok");
            }
        }

        private CaptureHandler _handler;
        private string _outDir;

        [SetUp]
        public void SetUp()
        {
            _handler = new CaptureHandler();
            string root = EditorInvokeAllowlist.ResolveProjectRoot();
            _outDir = Path.Combine(root, ".loombridge", "verify", "t06-probe-" + Path.GetRandomFileName());
        }

        [TearDown]
        public void TearDown()
        {
            EditorInvokeAllowlist.OverrideForTests = null;
            if (_outDir != null && Directory.Exists(_outDir))
                Directory.Delete(_outDir, true);
        }

        [Test]
        public void InvokeStatic_NotOnAllowlist_Refuses()
        {
            var ex = Assert.Throws<BridgeException>(() => _handler.HandleOp("invoke_static", new JObject
            {
                ["component"] = "Nonexistent",
                ["method"] = "RunArbitraryCode",
                ["outDir"] = _outDir,
            }));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
            StringAssert.Contains("not on the allowlist", ex.Message);
        }

        [Test]
        public void InvokeStatic_AllowlistedProjectMethod_Invokes()
        {
            EditorInvokeAllowlist.OverrideForTests = EditorInvokeAllowlist.ForTests(
                new[] { "Probe.WriteProbe" }, null);

            JObject result = _handler.HandleOp("invoke_static", new JObject
            {
                ["component"] = "Probe",
                ["method"] = "WriteProbe",
                ["outDir"] = _outDir,
            });

            Assert.IsNotNull(result);
            Assert.IsTrue(File.Exists(Path.Combine(_outDir, Probe.SentinelFile)),
                "an allowlisted static method must actually run and write its output");
        }
    }
}
