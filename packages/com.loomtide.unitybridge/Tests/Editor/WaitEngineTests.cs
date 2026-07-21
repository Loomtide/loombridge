using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityBridge.Core;

namespace UnityBridge.Tests
{
    /// <summary>
    /// RLH-W2 item #1: offline coverage for the play-mode compile-deferral hint. The live
    /// PollAllWaits path needs a running editor update loop + real Play Mode, so the attachment
    /// LOGIC is factored into the pure <see cref="WaitEngine.BuildCompileDeferredHint"/>, which
    /// these tests pin exhaustively. The end-to-end "edit a script during Play Mode → wait_for
    /// { compiling:false } → hint appears" behavior is live-smoke-deferred.
    /// </summary>
    [TestFixture]
    public class WaitEngineTests
    {
        private static JObject Cond(params (string key, JToken val)[] entries)
        {
            var o = new JObject();
            foreach (var (key, val) in entries)
                o[key] = val;
            return o;
        }

        [Test]
        public void CompileDeferredHint_FiresForWaitCompilingFalse_InPlayMode_NoCompile()
        {
            JObject hint = WaitEngine.BuildCompileDeferredHint(
                Cond(("compiling", false)), isPlaying: true, compileAttributed: false);

            Assert.IsNotNull(hint, "the deferral hint must fire for { compiling:false } in Play Mode with no compile");
            Assert.IsTrue(hint.Value<bool>("compileDeferred"), "compileDeferred must be true");
            string message = hint.Value<string>("compileDeferredMessage");
            StringAssert.Contains("Play Mode", message,
                "the message must explain the Play-Mode deferral");
            // D1: the trigger cannot distinguish an edited-during-play wait from an innocent
            // play-mode settle wait (that shape is the NORMAL outcome of every explicit
            // play-mode settle), so the message must be CONDITIONAL — state what this wait
            // cannot prove, and tell the no-edit caller to ignore it.
            StringAssert.Contains("CANNOT confirm", message,
                "the message must state only what the wait cannot prove");
            StringAssert.Contains("if you edited scripts", message,
                "the message must be conditional on the caller having edited scripts");
            StringAssert.Contains("ignore this hint", message,
                "the message must tell the no-edit caller to ignore it");
            // D1: never prescribe tearing down Play Mode unconditionally — an agent mid-capture
            // following an 'editor.stop' instruction literally would destroy its own session.
            StringAssert.DoesNotContain("editor.stop", message,
                "the message must not unconditionally prescribe stopping Play Mode");
        }

        [Test]
        public void CompileDeferredHint_SuppressedWhenNotPlaying()
        {
            // Edit Mode: a { compiling:false } wait with no compile is the normal healthy case.
            JObject hint = WaitEngine.BuildCompileDeferredHint(
                Cond(("compiling", false)), isPlaying: false, compileAttributed: false);
            Assert.IsNull(hint, "no hint outside Play Mode — compilation is not deferred there");
        }

        [Test]
        public void CompileDeferredHint_SuppressedWhenACompileWasAttributed()
        {
            // A compilation actually ran and was attributed to this wait → nothing was deferred.
            JObject hint = WaitEngine.BuildCompileDeferredHint(
                Cond(("compiling", false)), isPlaying: true, compileAttributed: true);
            Assert.IsNull(hint, "no hint when a compile was attributed to the wait");
        }

        [Test]
        public void CompileDeferredHint_SuppressedForWaitCompilingTrue()
        {
            // Waiting for compilation to START is not the "did my edit land?" intent.
            JObject hint = WaitEngine.BuildCompileDeferredHint(
                Cond(("compiling", true)), isPlaying: true, compileAttributed: false);
            Assert.IsNull(hint, "no hint for the { compiling:true } intent");
        }

        [Test]
        public void CompileDeferredHint_SuppressedWhenNoCompilingClause()
        {
            // A pure frame/delay/playMode wait has no compile expectation to be misled about.
            JObject hint = WaitEngine.BuildCompileDeferredHint(
                Cond(("frames", 8)), isPlaying: true, compileAttributed: false);
            Assert.IsNull(hint, "no hint when the wait never asked about compiling");
        }

        [Test]
        public void CompileDeferredHint_NullConditionIsSafe()
        {
            Assert.IsNull(WaitEngine.BuildCompileDeferredHint(null, isPlaying: true, compileAttributed: false));
        }
    }
}
