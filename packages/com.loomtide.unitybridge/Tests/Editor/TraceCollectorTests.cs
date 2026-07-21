using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class TraceCollectorTests
    {
        [SetUp]
        public void SetUp()
        {
            TraceCollector.ClearLogs();
        }

        [Test]
        public void GetRecentLogs_NoLogs_ReturnsEmptyArray()
        {
            JArray logs = TraceCollector.GetRecentLogs(10);
            Assert.AreEqual(0, logs.Count);
        }

        [Test]
        public void GetRecentLogs_AfterLog_CapturesMessage()
        {
            Debug.Log("test message");
            JArray logs = TraceCollector.GetRecentLogs(10);

            Assert.IsTrue(logs.Count > 0);
            // Find our message (other logs may be present)
            bool found = false;
            foreach (JObject entry in logs)
            {
                if (entry.Value<string>("message") == "test message")
                {
                    Assert.AreEqual("log", entry.Value<string>("type"));
                    found = true;
                    break;
                }
            }
            Assert.IsTrue(found, "Expected to find 'test message' in logs");
        }

        [Test]
        public void GetRecentLogs_ErrorType_CapturedCorrectly()
        {
            Debug.LogError("error message");
            JArray logs = TraceCollector.GetRecentLogs(10);

            bool found = false;
            foreach (JObject entry in logs)
            {
                if (entry.Value<string>("message") == "error message")
                {
                    Assert.AreEqual("error", entry.Value<string>("type"));
                    found = true;
                    break;
                }
            }
            Assert.IsTrue(found, "Expected to find 'error message' in logs");
        }

        [Test]
        public void GetRecentLogs_WarningType_CapturedCorrectly()
        {
            Debug.LogWarning("warning message");
            JArray logs = TraceCollector.GetRecentLogs(10);

            bool found = false;
            foreach (JObject entry in logs)
            {
                if (entry.Value<string>("message") == "warning message")
                {
                    Assert.AreEqual("warning", entry.Value<string>("type"));
                    found = true;
                    break;
                }
            }
            Assert.IsTrue(found, "Expected to find 'warning message' in logs");
        }

        [Test]
        public void ClearLogs_EmptiesBuffer()
        {
            Debug.Log("before clear");
            TraceCollector.ClearLogs();
            JArray logs = TraceCollector.GetRecentLogs(10);
            Assert.AreEqual(0, logs.Count);
        }

        [Test]
        public void BeginEndOp_NoLogsDuringOp_ReturnsEmptyDelta()
        {
            var scope = TraceCollector.BeginOp("test.op");
            JObject trace = TraceCollector.EndOp(scope);

            Assert.IsNotNull(trace["consoleDelta"]);
            Assert.AreEqual(0, ((JArray)trace["consoleDelta"]).Count);
        }

        [Test]
        public void BeginEndOp_CapturesLogsDuringScope()
        {
            var scope = TraceCollector.BeginOp("test.op");
            Debug.Log("during op");
            JObject trace = TraceCollector.EndOp(scope);

            JArray delta = (JArray)trace["consoleDelta"];
            Assert.IsTrue(delta.Count > 0);

            bool found = false;
            foreach (JObject entry in delta)
            {
                if (entry.Value<string>("message") == "during op")
                {
                    found = true;
                    break;
                }
            }
            Assert.IsTrue(found, "Expected 'during op' in trace consoleDelta");
        }

        [Test]
        public void OverlappingScopes_IndependentTraces()
        {
            // Simulate two concurrent ops
            var scope1 = TraceCollector.BeginOp("op1");
            Debug.Log("op1-only");

            var scope2 = TraceCollector.BeginOp("op2");
            Debug.Log("both-ops");

            // End scope1 — should have "op1-only" and "both-ops"
            JObject trace1 = TraceCollector.EndOp(scope1);
            JArray delta1 = (JArray)trace1["consoleDelta"];

            // End scope2 — should only have "both-ops"
            JObject trace2 = TraceCollector.EndOp(scope2);
            JArray delta2 = (JArray)trace2["consoleDelta"];

            // scope1 started earlier, should capture more
            Assert.IsTrue(delta1.Count >= delta2.Count,
                $"scope1 delta ({delta1.Count}) should be >= scope2 delta ({delta2.Count})");

            // Verify scope2 has the shared message
            bool scope2HasBoth = false;
            foreach (JObject entry in delta2)
            {
                if (entry.Value<string>("message") == "both-ops")
                {
                    scope2HasBoth = true;
                    break;
                }
            }
            Assert.IsTrue(scope2HasBoth, "scope2 should contain 'both-ops'");
        }

        [Test]
        public void AttachArtifact_NullTrace_NoOp()
        {
            // Should not throw
            TraceCollector.AttachArtifact(null, new JObject { ["kind"] = "screenshot" });
        }

        [Test]
        public void AttachArtifact_NullArtifact_NoOp()
        {
            var trace = new JObject { ["consoleDelta"] = new JArray() };
            TraceCollector.AttachArtifact(trace, null);
            Assert.IsNull(trace["artifacts"]);
        }

        [Test]
        public void AttachArtifact_AddsToArtifactsArray()
        {
            var trace = new JObject { ["consoleDelta"] = new JArray() };
            var artifact = new JObject { ["kind"] = "screenshot", ["path"] = "/tmp/test.jpg" };

            TraceCollector.AttachArtifact(trace, artifact);

            Assert.IsNotNull(trace["artifacts"]);
            var artifacts = (JArray)trace["artifacts"];
            Assert.AreEqual(1, artifacts.Count);
            Assert.AreEqual("screenshot", artifacts[0].Value<string>("kind"));
        }

        [Test]
        public void AttachArtifact_MultipleArtifacts_Appends()
        {
            var trace = new JObject { ["consoleDelta"] = new JArray() };
            TraceCollector.AttachArtifact(trace, new JObject { ["kind"] = "a" });
            TraceCollector.AttachArtifact(trace, new JObject { ["kind"] = "b" });

            var artifacts = (JArray)trace["artifacts"];
            Assert.AreEqual(2, artifacts.Count);
        }

        [Test]
        public void GetRecentLogs_LimitRespected()
        {
            for (int i = 0; i < 10; i++)
                Debug.Log($"msg-{i}");

            JArray logs = TraceCollector.GetRecentLogs(3);
            Assert.LessOrEqual(logs.Count, 3);
        }
    }
}
