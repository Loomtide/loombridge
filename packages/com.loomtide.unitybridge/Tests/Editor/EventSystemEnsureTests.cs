using NUnit.Framework;
using UnityBridge.Core;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;

namespace UnityBridge.Tests
{
    /// <summary>
    /// EditMode tests for EventSystemEnsure (RCL-T14): ui.create_canvas must leave the scene with a
    /// working EventSystem so uGUI buttons/touch controls receive input.
    /// </summary>
    [TestFixture]
    public class EventSystemEnsureTests
    {
        [SetUp]
        public void SetUp()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        [TearDown]
        public void TearDown()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        [Test]
        public void Ensure_EmptyScene_CreatesEventSystemWithInputModule()
        {
            Assert.IsNull(Object.FindFirstObjectByType<EventSystem>(), "precondition: no EventSystem");

            EventSystemEnsure.Result result = EventSystemEnsure.Ensure();

            Assert.IsTrue(result.created, "An EventSystem should have been created in an empty scene");
            Assert.IsNotNull(result.eventSystem, "result carries the EventSystem");

            EventSystem es = Object.FindFirstObjectByType<EventSystem>();
            Assert.IsNotNull(es, "an EventSystem now exists in the scene");

            // A UI input module is present so the EventSystem can actually process pointer events.
            BaseInputModule module = es.GetComponent<BaseInputModule>();
            Assert.IsNotNull(module, "the EventSystem has a UI input module");
            Assert.AreEqual(module.GetType().Name, result.moduleType);
        }

        [Test]
        public void Ensure_ExistingEventSystem_IsReusedNotDuplicated()
        {
            var go = new GameObject("EventSystem");
            go.AddComponent<EventSystem>();
            go.AddComponent<StandaloneInputModule>();

            EventSystemEnsure.Result result = EventSystemEnsure.Ensure();

            Assert.IsFalse(result.created, "an existing EventSystem must be reused, not duplicated");
            Assert.IsFalse(result.addedModule, "an existing module must not be replaced");

            EventSystem[] all = Object.FindObjectsByType<EventSystem>(FindObjectsSortMode.None);
            Assert.AreEqual(1, all.Length, "exactly one EventSystem in the scene");
        }

        [Test]
        public void Ensure_ExistingEventSystemWithoutModule_AddsModule()
        {
            var go = new GameObject("EventSystem");
            go.AddComponent<EventSystem>();
            // deliberately no input module

            EventSystemEnsure.Result result = EventSystemEnsure.Ensure();

            Assert.IsFalse(result.created, "the existing EventSystem GameObject is reused");
            Assert.IsTrue(result.addedModule, "a missing input module is added");
            Assert.IsNotNull(go.GetComponent<BaseInputModule>(), "a UI input module is now present");
        }
    }
}
