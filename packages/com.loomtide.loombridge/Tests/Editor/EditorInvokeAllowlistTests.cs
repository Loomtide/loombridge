using System.IO;
using NUnit.Framework;
using UnityBridge.Core;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode coverage for the RCL-T06 project-configurable allowlist that gates the
    /// two bridge code-execution surfaces (capture.invoke_static + editor.execute_menu_item).
    /// </summary>
    [TestFixture]
    public class EditorInvokeAllowlistTests
    {
        private string _tempRoot;

        [SetUp]
        public void SetUp()
        {
            _tempRoot = Path.Combine(Path.GetTempPath(), "loombridge-allowlist-" + Path.GetRandomFileName());
            Directory.CreateDirectory(_tempRoot);
        }

        [TearDown]
        public void TearDown()
        {
            if (_tempRoot != null && Directory.Exists(_tempRoot))
                Directory.Delete(_tempRoot, true);
        }

        private void WriteConfig(string json)
        {
            string dir = Path.Combine(_tempRoot, ".loombridge");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "editor-allowlist.json"), json);
        }

        [Test]
        public void NoConfig_AllowsBuiltInStaticMethod_AndNoMenuItems()
        {
            var allowlist = EditorInvokeAllowlist.LoadFrom(_tempRoot);

            Assert.IsTrue(allowlist.IsStaticMethodAllowed("GroundTiling.WriteTileCaptures"),
                "built-in capture entry point must always be allowed");
            Assert.IsFalse(allowlist.IsStaticMethodAllowed("Anything.Else"),
                "an unlisted static method must be refused");
            Assert.IsFalse(allowlist.IsMenuItemAllowed("Tools/Anything"),
                "menu items have no built-in default — all refused until opted in");
        }

        [Test]
        public void ProjectConfig_UnionsStaticMethodsAndMenuItems()
        {
            WriteConfig(@"{
                ""staticMethods"": [""MyGameBlockout.WriteLayout""],
                ""menuItems"": [""Tools/MyGame/Generate Blockout""]
            }");

            var allowlist = EditorInvokeAllowlist.LoadFrom(_tempRoot);

            Assert.IsTrue(allowlist.IsStaticMethodAllowed("GroundTiling.WriteTileCaptures"),
                "built-in default must remain after a project config is added (union, not replace)");
            Assert.IsTrue(allowlist.IsStaticMethodAllowed("MyGameBlockout.WriteLayout"));
            Assert.IsTrue(allowlist.IsMenuItemAllowed("Tools/MyGame/Generate Blockout"));
            Assert.IsFalse(allowlist.IsStaticMethodAllowed("Evil.RunArbitraryCode"),
                "anything still off the union must be refused");
            Assert.IsFalse(allowlist.IsMenuItemAllowed("File/Build Settings..."));
        }

        [Test]
        public void MalformedConfig_IgnoredAndDefaultsStillApply()
        {
            WriteConfig("{ this is not valid json ");

            var allowlist = EditorInvokeAllowlist.LoadFrom(_tempRoot);

            Assert.IsTrue(allowlist.IsStaticMethodAllowed("GroundTiling.WriteTileCaptures"),
                "a malformed config must never widen OR break the built-in default");
            Assert.IsFalse(allowlist.IsMenuItemAllowed("Tools/Anything"));
        }
    }
}
