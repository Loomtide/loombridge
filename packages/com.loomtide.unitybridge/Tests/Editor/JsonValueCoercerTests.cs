using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class JsonValueCoercerTests
    {
        [Test]
        public void Rehydrate_NullInput_ReturnsNull()
        {
            Assert.IsNull(JsonValueCoercer.Rehydrate(null));
        }

        [Test]
        public void Rehydrate_PlainString_ReturnsUnchanged()
        {
            JToken input = JValue.CreateString("Assets/Foo.png");
            JToken result = JsonValueCoercer.Rehydrate(input);
            Assert.AreSame(input, result);
        }

        [Test]
        public void Rehydrate_EmptyString_ReturnsUnchanged()
        {
            JToken input = JValue.CreateString("");
            JToken result = JsonValueCoercer.Rehydrate(input);
            Assert.AreSame(input, result);
        }

        [Test]
        public void Rehydrate_StringifiedNull_ReturnsJsonNull()
        {
            JToken input = JValue.CreateString("null");
            JToken result = JsonValueCoercer.Rehydrate(input);
            Assert.AreEqual(JTokenType.Null, result.Type);
        }

        [Test]
        public void Rehydrate_StringifiedBoolean_ReturnsBoolToken()
        {
            JToken result = JsonValueCoercer.Rehydrate(JValue.CreateString("true"));
            Assert.AreEqual(JTokenType.Boolean, result.Type);
            Assert.IsTrue(result.Value<bool>());
        }

        [Test]
        public void Rehydrate_StringifiedInteger_ReturnsIntegerToken()
        {
            JToken result = JsonValueCoercer.Rehydrate(JValue.CreateString("4"));
            Assert.AreEqual(JTokenType.Integer, result.Type);
            Assert.AreEqual(4, result.Value<int>());
        }

        [Test]
        public void Rehydrate_StringifiedFloat_ReturnsFloatToken()
        {
            JToken result = JsonValueCoercer.Rehydrate(JValue.CreateString("2.5"));
            Assert.AreEqual(JTokenType.Float, result.Type);
            Assert.AreEqual(2.5, result.Value<double>(), 0.0001);
        }

        [Test]
        public void Rehydrate_StringifiedObject_ReturnsObjectToken()
        {
            JToken result = JsonValueCoercer.Rehydrate(
                JValue.CreateString("{\"locator\": {\"path\": \"/Canvas/ScoreText\"}}"));
            Assert.AreEqual(JTokenType.Object, result.Type);
            JObject obj = (JObject)result;
            Assert.AreEqual("/Canvas/ScoreText", obj["locator"]["path"].Value<string>());
        }

        [Test]
        public void Rehydrate_NonStringInput_ReturnsUnchanged()
        {
            JToken input = new JObject { ["path"] = "/Player" };
            JToken result = JsonValueCoercer.Rehydrate(input);
            Assert.AreSame(input, result);
        }

        [Test]
        public void Rehydrate_MalformedJson_ReturnsOriginalString()
        {
            JToken input = JValue.CreateString("{not valid json");
            JToken result = JsonValueCoercer.Rehydrate(input);
            Assert.AreEqual(JTokenType.String, result.Type);
            Assert.AreEqual("{not valid json", result.Value<string>());
        }
    }
}
