using System;
using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Tests
{
    [TestFixture]
    public class CodeHandlerTests
    {
        private CodeHandler _handler;
        private const string TestScriptDir = "Assets/Editor/UnityBridge/Tests/TestOutput";
        private string _testScriptPath;
        private string _testClassName;

        [SetUp]
        public void SetUp()
        {
            _handler = new CodeHandler();
            EnsureTestDirectoryExists();

            string uniqueId = Guid.NewGuid().ToString("N");
            _testClassName = $"TestScript_{uniqueId}";
            _testScriptPath = $"{TestScriptDir}/{_testClassName}.cs";
        }

        [TearDown]
        public void TearDown()
        {
            DeleteScriptAtPath(_testScriptPath);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        }

        // ─────────────────────────────────────────────
        // code.create_script
        // ─────────────────────────────────────────────

        [Test]
        public void CreateScript_CreatesFile()
        {
            string content = BuildMonoBehaviourScript(_testClassName);
            var parameters = new JObject
            {
                ["path"] = _testScriptPath,
                ["content"] = content
            };

            JObject result = _handler.HandleOp("create_script", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual(_testScriptPath, result.Value<string>("path"));

            string fullPath = Path.Combine(Application.dataPath, "..", _testScriptPath);
            Assert.IsTrue(File.Exists(fullPath), "Script file should exist on disk");
        }

        // ─────────────────────────────────────────────
        // code.read_script
        // ─────────────────────────────────────────────

        [Test]
        public void ReadScript_ReturnsContent()
        {
            string originalContent = BuildMonoBehaviourScript(_testClassName);
            _handler.HandleOp("create_script", new JObject
            {
                ["path"] = _testScriptPath,
                ["content"] = originalContent
            });

            var parameters = new JObject
            {
                ["path"] = _testScriptPath
            };

            JObject result = _handler.HandleOp("read_script", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual(_testScriptPath, result.Value<string>("path"));
            Assert.AreEqual(originalContent, result.Value<string>("content"));
        }

        // ─────────────────────────────────────────────
        // code.modify_script
        // ─────────────────────────────────────────────

        [Test]
        public void ModifyScript_UpdatesContent()
        {
            string initialContent = BuildMonoBehaviourScript(_testClassName, "void Awake() { }");
            _handler.HandleOp("create_script", new JObject
            {
                ["path"] = _testScriptPath,
                ["content"] = initialContent
            });

            string newContent = BuildMonoBehaviourScript(_testClassName, "void Start() { }");
            var parameters = new JObject
            {
                ["path"] = _testScriptPath,
                ["content"] = newContent
            };

            JObject result = _handler.HandleOp("modify_script", parameters);

            Assert.IsNotNull(result);
            Assert.AreEqual(_testScriptPath, result.Value<string>("path"));

            string fullPath = Path.Combine(Application.dataPath, "..", _testScriptPath);
            string readBack = File.ReadAllText(fullPath);
            Assert.AreEqual(newContent, readBack);
        }

        // ─────────────────────────────────────────────
        // Security: Path Validation
        // ─────────────────────────────────────────────

        [Test]
        public void CreateScript_OutsideAssets_Throws()
        {
            var parameters = new JObject
            {
                ["path"] = "../outside_project/Evil.cs",
                ["content"] = "// malicious"
            };

            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("create_script", parameters));
            Assert.AreEqual(ErrorCodes.INVALID_PARAMS, ex.Code);
        }

        // ─────────────────────────────────────────────
        // Error Cases
        // ─────────────────────────────────────────────

        [Test]
        public void UnknownOp_ThrowsNotFound()
        {
            var ex = Assert.Throws<BridgeException>(() =>
                _handler.HandleOp("totally_unknown", new JObject()));
            Assert.AreEqual(ErrorCodes.NOT_FOUND, ex.Code);
        }

        [Test]
        public void IsAsync_AlwaysFalse()
        {
            Assert.IsFalse(_handler.IsAsync("create_script"));
            Assert.IsFalse(_handler.IsAsync("read_script"));
        }

        private static void EnsureTestDirectoryExists()
        {
            string fullDir = Path.Combine(Application.dataPath, "..", TestScriptDir);
            if (!Directory.Exists(fullDir))
                Directory.CreateDirectory(fullDir);

            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        }

        private static void DeleteScriptAtPath(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath))
                return;

            if (AssetDatabase.DeleteAsset(assetPath))
                return;

            string fullPath = Path.Combine(Application.dataPath, "..", assetPath);
            if (File.Exists(fullPath))
                File.Delete(fullPath);

            string metaPath = fullPath + ".meta";
            if (File.Exists(metaPath))
                File.Delete(metaPath);
        }

        private static string BuildMonoBehaviourScript(string className, string bodyLine = null)
        {
            string body = string.IsNullOrEmpty(bodyLine) ? string.Empty : $"    {bodyLine}\n";
            return $"using UnityEngine;\npublic class {className} : MonoBehaviour\n{{\n{body}}}\n";
        }
    }
}
