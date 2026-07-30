using UnityBridge.Core;
using UnityBridge.Core.Input;
using UnityBridge.Handlers;
using UnityEditor;
using UnityEngine;

namespace UnityBridge
{
    /// <summary>
    /// Entry point for the Unity Bridge plugin.
    /// Initializes the server, registers handlers, and manages lifecycle hooks.
    /// </summary>
    [InitializeOnLoad]
    public static class UnityBridgeBootstrap
    {
        private static BridgeServer _server;
        private static OpExecutor _executor;
        private static InputService _inputService;

        static UnityBridgeBootstrap()
        {
            // The bridge must run ONLY in the main editor process. [InitializeOnLoad]
            // also fires in Unity's out-of-process AssetImportWorker (-adb2 -batchMode)
            // instances; if each starts a BridgeServer they grab the low ports
            // (8200, 8201, ...) and accept WS connections they never service, pushing
            // the real editor onto a higher port and hanging port-scanning clients.
            if (IsSecondaryProcess())
            {
                Debug.Log("[Loombridge] Skipping bridge startup in secondary/import-worker process");
                return;
            }

            try
            {
                Debug.Log("[Loombridge] Bootstrap initializing");

                // PIN RECOVERY BEFORE ANYTHING ELSE. A replay.settle_and_capture that never
                // reached its cleanup (an editor that stopped ticking, a killed process) leaves
                // Time.captureDeltaTime pinned, and that is a NATIVE global no reload resets:
                // the editor renders as fast as it can until someone notices. This runs on the
                // first load after the leak and logs exactly one line, so the recovery is
                // visible without adding noise to every clean boot.
                if (ReplayCapturePin.RestoreLeakedPin())
                {
                    Debug.Log(
                        "[Loombridge] Restored a leaked capture pin from an interrupted replay.settle_and_capture "
                        + "(Time.captureDeltaTime and Application.runInBackground are back to their pre-settle values)");
                }
                Debug.Log(
                    "[Loombridge] Transport compatibility target: Unity 6000.x LTS (primary), 2022.3 LTS (compatibility)");

                _server = new BridgeServer();
                _executor = new OpExecutor();
                _inputService = new InputService(new IInputBackend[]
                {
                    new InputSystemBackend(),
                    new EditorEventInputBackend()
                });

                // Register core handlers
                Handshake.Register(_server);

                // Register category handlers
                _executor.RegisterCategory("scene", new SceneHandler());
                _executor.RegisterCategory("editor", new EditorHandler());
                _executor.RegisterCategory("component", new ComponentHandler());
                _executor.RegisterCategory("code", new CodeHandler());
                _executor.RegisterCategory("animator", new AnimatorHandler());
                _executor.RegisterCategory("ui", new UIHandler());
                _executor.RegisterCategory("asset", new AssetHandler());
                _executor.RegisterCategory("input", new InputHandler(_inputService));
                _executor.RegisterCategory("runtime", new RuntimeHandler());
                _executor.RegisterCategory("package", new PackageHandler());
                _executor.RegisterCategory("capture", new CaptureHandler());
                _executor.RegisterCategory("replay", new ReplayHandler());
                _executor.RegisterCategory("observe", new ObserveHandler());
                _executor.RegisterCategory("ops", new OpsHandler(_executor));

                // Register OpExecutor as default handler for category.op commands
                _server.RegisterDefaultHandler(_executor.AsDefaultHandler());

                // Start the server
                _server.Start();
                Debug.Log(
                    $"[Loombridge] Bootstrap ready (transport: {_server.ActiveTransportMode}, activePort: {_server.ActivePort})");
                Debug.Log(
                    $"[Loombridge] Network intent: loopback only via ws://localhost:{_server.ActivePort}, "
                    + $"ws://127.0.0.1:{_server.ActivePort}, ws://[::1]:{_server.ActivePort}");

                // Lifecycle hooks
                AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
                EditorApplication.quitting += OnQuitting;
                EditorApplication.update += OnUpdate;
            }
            catch (System.Exception ex)
            {
                Debug.LogError($"[Loombridge] Bootstrap initialization failed: {ex.Message}\n{ex.StackTrace}");
            }
        }

        /// <summary>
        /// Provides access to the server instance for handler registration.
        /// </summary>
        public static BridgeServer Server => _server;

        /// <summary>
        /// Provides access to the OpExecutor for category handler registration.
        /// </summary>
        public static OpExecutor Executor => _executor;

        /// <summary>
        /// The single registered InputService instance (the same one wired into the
        /// InputHandler). Exposed so the RuntimeHandler can drive declared keys through
        /// the existing input session/backend pipeline INSIDE a sampling loop
        /// (runtime.capture_input_motion) — closing the latency gap between a separate
        /// key_down and a measure call. Reflection-safe: InputService talks to the
        /// optional InputSystem only through InputSystemBackend, so this introduces no
        /// hard InputSystem reference in the Editor assembly.
        /// </summary>
        public static InputService InputService => _inputService;

        /// <summary>
        /// True when running in a non-main Unity process (e.g. an AssetImportWorker /
        /// AssetDatabase v2 worker), which must NOT host a bridge server.
        /// </summary>
        private static bool IsSecondaryProcess()
        {
            try
            {
                if (AssetDatabase.IsAssetImportWorkerProcess())
                {
                    return true;
                }
            }
            catch
            {
                // API unavailable/not-ready in this context — fall through to the arg check.
            }

            foreach (string arg in System.Environment.GetCommandLineArgs())
            {
                if (!string.IsNullOrEmpty(arg)
                    && arg.IndexOf("AssetImportWorker", System.StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }

        private static void OnBeforeAssemblyReload()
        {
            Debug.Log("[Loombridge] Assembly reload detected — stopping server");
            _server?.Stop();
        }

        private static void OnQuitting()
        {
            _server?.Stop();
        }

        private static void OnUpdate()
        {
            _server?.ProcessMainThreadQueue();
        }
    }
}
