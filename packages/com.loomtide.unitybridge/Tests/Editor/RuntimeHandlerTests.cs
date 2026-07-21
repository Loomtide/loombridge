using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class RuntimeHandlerTests
    {
        private RuntimeHandler _handler;
        private GameObject _testGo;

        [SetUp]
        public void SetUp()
        {
            _handler = new RuntimeHandler();
            _testGo = new GameObject("RuntimeHandlerTestObject");
            _testGo.transform.position = new Vector3(1f, 2f, 3f);
            var body = _testGo.AddComponent<Rigidbody2D>();
            body.gravityScale = 4f;
        }

        [TearDown]
        public void TearDown()
        {
            if (_testGo != null)
                Object.DestroyImmediate(_testGo);
        }

        [Test]
        public void GetSnapshot_MissingLocator_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("get_snapshot", new JObject()));

            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void GetSnapshot_ComponentFilter_ReturnsOnlyRequestedType()
        {
            JObject result = _handler.HandleOp("get_snapshot", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["components"] = new JArray("Rigidbody2D")
            });

            JArray components = result.Value<JArray>("components");
            Assert.IsNotNull(components);
            Assert.AreEqual(1, components.Count);
            Assert.AreEqual("Rigidbody2D", components[0].Value<string>("type_name"));
        }

        [Test]
        public void AssertCondition_ObjectPathComparator_Passes()
        {
            JObject result = _handler.HandleOp("assert_condition", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["property_path"] = "transform.position.y",
                ["operator"] = "greater_than",
                ["expected"] = 1.5
            });

            Assert.AreEqual(true, result.Value<bool>("passed"));
            Assert.AreEqual("greater_than", result.Value<string>("operator"));
            Assert.AreEqual("pass", result.Value<string>("classification"));
            Assert.AreEqual(true, result.Value<bool>("deterministic"));
            Assert.AreEqual(string.Empty, result.Value<string>("failure_code"));
        }

        [Test]
        public void AssertCondition_ComponentProperty_Passes()
        {
            JObject result = _handler.HandleOp("assert_condition", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["component"] = "Rigidbody2D",
                ["property_path"] = "gravityScale",
                ["operator"] = "equals",
                ["expected"] = 4.0
            });

            Assert.AreEqual(true, result.Value<bool>("passed"));
            Assert.AreEqual("m_GravityScale", result.Value<string>("resolved_path"));
        }

        [Test]
        public void AssertCondition_FailedComparison_ReturnsDeterministicFailShape()
        {
            JObject result = _handler.HandleOp("assert_condition", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["property_path"] = "activeSelf",
                ["operator"] = "equals",
                ["expected"] = false
            });

            Assert.AreEqual(false, result.Value<bool>("passed"));
            Assert.AreEqual("fail", result.Value<string>("classification"));
            Assert.AreEqual("ASSERTION_FAILED", result.Value<string>("failure_code"));
            StringAssert.Contains("deterministic fail", result.Value<string>("message"));
        }

        [Test]
        public void AssertCondition_InvalidOperator_ThrowsInvalidParams()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("assert_condition", new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(_testGo),
                    ["property_path"] = "activeSelf",
                    ["operator"] = "not_a_real_operator",
                    ["expected"] = true
                }));

            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        [Test]
        public void WaitForCondition_ImmediatePass_Responds()
        {
            JObject response = null;
            BridgeException error = null;

            _handler.HandleOpAsync("wait_for_condition", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["property_path"] = "activeSelf",
                ["operator"] = "equals",
                ["expected"] = true
            },
            result => response = result,
            ex => error = ex);

            Assert.IsNull(error);
            Assert.IsNotNull(response);
            Assert.AreEqual(true, response.Value<bool>("passed"));
            Assert.AreEqual(0, response.Value<long>("waited_ms"));
            Assert.AreEqual("pass", response.Value<string>("classification"));
            Assert.AreEqual(true, response.Value<bool>("deterministic"));
        }

        [Test]
        public void WaitForCondition_ZeroTimeout_ReturnsTimeoutError()
        {
            JObject response = null;
            BridgeException error = null;

            _handler.HandleOpAsync("wait_for_condition", new JObject
            {
                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                ["property_path"] = "activeSelf",
                ["operator"] = "equals",
                ["expected"] = false,
                ["timeoutMs"] = 0
            },
            result => response = result,
            ex => error = ex);

            Assert.IsNull(response);
            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.TIMEOUT, error.Code);
            StringAssert.Contains("deterministic timeout", error.Message);
        }

        // ─────────────────────────────────────────────
        // Probe (validation is reachable only outside Play Mode for the play-mode gate;
        // the multi-driver call shape is accepted by the handler the same as single-driver)
        // ─────────────────────────────────────────────

        [Test]
        public void Probe_OutsidePlayMode_SingleDriver_ReturnsPlayModeError()
        {
            BridgeException error = null;
            _handler.HandleOpAsync("probe", new JObject
            {
                ["measure"] = LocatorResolver.BuildLocator(_testGo),
                ["driver"] = new JObject
                {
                    ["locator"] = LocatorResolver.BuildLocator(_testGo),
                    ["type_name"] = "Rigidbody2D",
                    ["property_path"] = "gravityScale"
                },
                ["phases"] = new JArray
                {
                    new JObject { ["value"] = 1.0, ["durationMs"] = 100 }
                }
            },
            _ => { },
            ex => error = ex);

            Assert.IsNotNull(error, "probe outside Play Mode should error");
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("Play Mode", error.Message);
        }

        [Test]
        public void Probe_OutsidePlayMode_MultiDriverPhases_ReturnsPlayModeError()
        {
            // The multi-driver phases[].drivers shape (no top-level driver) is accepted by
            // the handler; outside Play Mode it still fails at the play-mode gate, proving
            // the new call shape is recognized rather than rejected as malformed.
            BridgeException error = null;
            _handler.HandleOpAsync("probe", new JObject
            {
                ["measure"] = LocatorResolver.BuildLocator(_testGo),
                ["phases"] = new JArray
                {
                    new JObject
                    {
                        ["durationMs"] = 100,
                        ["drivers"] = new JArray
                        {
                            new JObject
                            {
                                ["locator"] = LocatorResolver.BuildLocator(_testGo),
                                ["type_name"] = "Rigidbody2D",
                                ["property_path"] = "gravityScale",
                                ["value"] = 2.0
                            }
                        }
                    }
                }
            },
            _ => { },
            ex => error = ex);

            Assert.IsNotNull(error);
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, error.Code);
            StringAssert.Contains("Play Mode", error.Message);
        }
    }
}
