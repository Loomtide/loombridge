using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// WebSocket server for the Unity Bridge protocol.
    /// Manages client connections, handshake enforcement, command routing,
    /// and main-thread dispatch via EditorApplication.update.
    /// </summary>
    public class BridgeServer
    {
        private const string LogPrefix = "[UnityBridge]";
        private const int BasePort = 8200;
        private const int MaxPort = 8210;
        private const string PortEditorPrefKey = "UnityBridge.Port";
        private const string TransportModeEditorPrefKey = "UnityBridge.TransportMode";
        private const string TransportModeEnvVar = "LOOMTIDE_UNITY_TRANSPORT_MODE";
        private const string DiscoveryDirEnvVar = "LOOMTIDE_ENDPOINT_DISCOVERY_DIR";
        private const string DiscoveryLatestFileName = "endpoint-discovery-latest.json";
        private const int DiscoveryRefreshIntervalMs = 10000;
        private const int DiscoveryTtlMs = 60000;
        private const int MaxCommandsPerFrame = 10;

        // ─────────────────────────────────────────────
        // Server State
        // ─────────────────────────────────────────────

        private readonly List<ITransportListener> _activeListeners = new List<ITransportListener>();
        private readonly object _listenersLock = new object();
        private CancellationTokenSource _cts;
        private bool _isRunning;
        private string _discoveryDirectoryPath;
        private string _sessionDiscoveryFilePath;
        private string _latestDiscoveryFilePath;
        private long _lastDiscoveryPublishUnixMs;
        private long _lastDiscoverySweepUnixMs;

        private readonly ConcurrentQueue<Action> _mainThreadQueue = new ConcurrentQueue<Action>();
        private readonly List<BridgeSocketConnection> _connectedSockets = new List<BridgeSocketConnection>();
        private readonly object _socketsLock = new object();

        // Per-socket send serialization (prevents overlapping SendAsync calls)
        private readonly Dictionary<BridgeSocketConnection, SemaphoreSlim> _sendLocks =
            new Dictionary<BridgeSocketConnection, SemaphoreSlim>();
        private readonly object _sendLocksLock = new object();

        // Handshake tracking per socket
        private readonly HashSet<BridgeSocketConnection> _handshakeCompleted = new HashSet<BridgeSocketConnection>();
        private readonly object _handshakeLock = new object();

        /// <summary>Current session ID (new GUID per Start()).</summary>
        public string SessionId { get; private set; }

        /// <summary>The port the server is currently listening on.</summary>
        public int ActivePort { get; private set; }

        /// <summary>The transport mode selected for the current run.</summary>
        public string ActiveTransportMode { get; private set; } = "auto";

        private enum BridgeTransportMode
        {
            Auto,
            Ipc,
            Tcp
        }

        // ─────────────────────────────────────────────
        // Handler Registration
        // ─────────────────────────────────────────────

        // Sync handlers: command → handler(id, params) → JObject response
        private readonly Dictionary<string, Func<string, JObject, JObject>> _syncHandlers =
            new Dictionary<string, Func<string, JObject, JObject>>();

        // Async handlers: command → handler(id, params, respond) → bool (true=async, false=sync)
        private readonly Dictionary<string, Func<string, JObject, Action<JObject>, bool>> _asyncHandlers =
            new Dictionary<string, Func<string, JObject, Action<JObject>, bool>>();

        // Default handler (catch-all for OpExecutor routing)
        private Func<BridgeRequestContext, Action<JObject>, bool> _defaultHandler;

        /// <summary>
        /// Registers a synchronous handler for an exact command match.
        /// </summary>
        public void RegisterHandler(string command, Func<string, JObject, JObject> handler)
        {
            _syncHandlers[command] = handler;
        }

        /// <summary>
        /// Registers an async-capable handler for an exact command match.
        /// The handler returns true if it will respond asynchronously via the callback,
        /// or false if it responded synchronously (callback was already invoked).
        /// </summary>
        public void RegisterHandler(string command, Func<string, JObject, Action<JObject>, bool> handler)
        {
            _asyncHandlers[command] = handler;
        }

        /// <summary>
        /// Registers the default (catch-all) handler, typically the OpExecutor.
        /// Called when no exact handler match is found.
        /// </summary>
        public void RegisterDefaultHandler(Func<BridgeRequestContext, Action<JObject>, bool> handler)
        {
            _defaultHandler = handler;
        }

        // ─────────────────────────────────────────────
        // Lifecycle
        // ─────────────────────────────────────────────

        /// <summary>
        /// Starts the bridge listener(s) using deterministic transport selection.
        /// </summary>
        public void Start()
        {
            if (_isRunning)
                return;

            SessionId = Guid.NewGuid().ToString();
            _cts = new CancellationTokenSource();
            ActivePort = 0;

            BridgeTransportMode requestedMode = ResolveTransportMode();
            ActiveTransportMode = requestedMode.ToString().ToLowerInvariant();
            Debug.Log(
                $"{LogPrefix} Starting server (sessionId: {SessionId}) with transport mode '{ActiveTransportMode}'");
            InitializeDiscoveryPaths();

            bool started = false;
            switch (requestedMode)
            {
                case BridgeTransportMode.Auto:
                    Debug.Log($"{LogPrefix} Transport attempt order: ipc -> tcp (auto mode)");
                    bool ipcStarted = TryStartIpcTransport(out string ipcReason);
                    if (!ipcStarted)
                    {
                        Debug.LogWarning(
                            $"{LogPrefix} IPC transport unavailable in auto mode; fallback to tcp. "
                            + $"reason: {ipcReason}");
                    }
                    bool tcpStarted = TryStartTcpTransport();
                    started = ipcStarted || tcpStarted;
                    if (ipcStarted && tcpStarted)
                    {
                        Debug.Log($"{LogPrefix} Auto mode active endpoints: ipc primary, tcp fallback");
                    }
                    if (!started)
                    {
                        Debug.LogError(
                            $"{LogPrefix} Auto mode failed after attempting transports ipc -> tcp. "
                            + $"fallback exhausted; ipc reason: {ipcReason}");
                    }
                    break;

                case BridgeTransportMode.Ipc:
                    started = TryStartIpcTransport(out string requiredIpcReason);
                    if (!started)
                    {
                        Debug.LogError(
                            $"{LogPrefix} Transport mode 'ipc' requested, but IPC listener could not start. "
                            + $"reason: {requiredIpcReason}");
                    }
                    break;

                case BridgeTransportMode.Tcp:
                    Debug.Log($"{LogPrefix} Transport mode 'tcp' selected; IPC bypassed by configuration");
                    started = TryStartTcpTransport();
                    break;
            }

            if (!started)
            {
                StopListeners();
                CleanupDiscoveryArtifacts();
                try { _cts?.Dispose(); } catch { }
                _cts = null;
                return;
            }

            _isRunning = true;
            PublishEndpointDiscovery(force: true);
            Debug.Log($"{LogPrefix} Active transport endpoints: {DescribeActiveEndpoints()}");
        }

        private BridgeTransportMode ResolveTransportMode()
        {
            string rawMode = null;

            try
            {
                rawMode = Environment.GetEnvironmentVariable(TransportModeEnvVar);
            }
            catch { }

            if (string.IsNullOrWhiteSpace(rawMode))
            {
                rawMode = EditorPrefs.GetString(TransportModeEditorPrefKey, "auto");
            }

            if (TryParseTransportMode(rawMode, out BridgeTransportMode mode))
            {
                return mode;
            }

            Debug.LogWarning(
                $"{LogPrefix} Invalid transport mode '{rawMode}'. Falling back to 'auto'.");
            return BridgeTransportMode.Auto;
        }

        private static bool TryParseTransportMode(string rawMode, out BridgeTransportMode mode)
        {
            mode = BridgeTransportMode.Auto;
            string normalized = (rawMode ?? "auto").Trim().ToLowerInvariant();
            switch (normalized)
            {
                case "auto":
                    mode = BridgeTransportMode.Auto;
                    return true;
                case "ipc":
                    mode = BridgeTransportMode.Ipc;
                    return true;
                case "tcp":
                    mode = BridgeTransportMode.Tcp;
                    return true;
                default:
                    return false;
            }
        }

        private bool TryStartIpcTransport(out string reason)
        {
            reason = string.Empty;

            ITransportListener listener;
            if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                string pipeName = $"loomtide-bridge-{SessionId}".ToLowerInvariant();
                string pipePath = $@"\\.\pipe\{pipeName}";
                Debug.Log($"{LogPrefix} Attempting IPC startup via named pipe: {pipePath}");
                listener = new NamedPipeTransportListener(pipeName, pipePath);
            }
            else
            {
                if (!TryCreateUnixSocketPath(out string socketPath, out reason))
                {
                    return false;
                }

                Debug.Log($"{LogPrefix} Attempting IPC startup via Unix domain socket: {socketPath}");
                listener = new UnixSocketTransportListener(socketPath);
            }

            try
            {
                listener.Start();
                RegisterStartedListener(listener);
                Debug.Log(
                    $"{LogPrefix} Selected transport: ipc ({listener.EndpointKind}) on {listener.EndpointDescription}");
                return true;
            }
            catch (Exception ex)
            {
                try { listener.Stop(); } catch { }
                try { listener.Dispose(); } catch { }
                reason = ex.Message;
                return false;
            }
        }

        private bool TryStartTcpTransport()
        {
            int savedPort = EditorPrefs.GetInt(PortEditorPrefKey, BasePort);
            int startPort = (savedPort >= BasePort && savedPort <= MaxPort) ? savedPort : BasePort;
            Debug.Log(
                $"{LogPrefix} TCP transport port scan {BasePort}-{MaxPort}, preferred {startPort}");
            Debug.Log(
                $"{LogPrefix} Loopback endpoints for clients: ws://localhost:<port>, ws://127.0.0.1:<port>, ws://[::1]:<port>");

            for (int attempt = 0; attempt <= MaxPort - BasePort; attempt++)
            {
                int port = BasePort + ((startPort - BasePort + attempt) % (MaxPort - BasePort + 1));
                TcpTransportListener transportListener = null;
                try
                {
                    transportListener = new TcpTransportListener(CreateListener(port), port);
                    transportListener.Start();
                    ActivePort = port;
                    EditorPrefs.SetInt(PortEditorPrefKey, port);
                    RegisterStartedListener(transportListener);

                    Debug.Log(
                        $"{LogPrefix} Selected transport: tcp on ws://localhost:{port} "
                        + $"(sessionId: {SessionId}); aliases ws://127.0.0.1:{port}, ws://[::1]:{port}");
                    return true;
                }
                catch (SocketException ex)
                {
                    transportListener?.Stop();
                    transportListener?.Dispose();
                    Debug.LogWarning(
                        $"{LogPrefix} TCP port attempt {port} failed ({ex.SocketErrorCode}): {ex.Message}");
                }
                catch (Exception ex)
                {
                    transportListener?.Stop();
                    transportListener?.Dispose();
                    Debug.LogWarning(
                        $"{LogPrefix} TCP port attempt {port} failed (unexpected): {ex.Message}");
                }
            }

            Debug.LogError(
                $"{LogPrefix} Failed to start tcp transport after scanning ports {BasePort}-{MaxPort}. "
                + $"Preferred port was {startPort}; all attempts failed.");
            return false;
        }

        private void RegisterStartedListener(ITransportListener listener)
        {
            lock (_listenersLock)
            {
                _activeListeners.Add(listener);
            }

            Task.Run(() => AcceptConnectionsAsync(listener, _cts.Token));
            PublishEndpointDiscovery(force: true);
        }

        private void InitializeDiscoveryPaths()
        {
            string overrideDir = null;
            try
            {
                overrideDir = Environment.GetEnvironmentVariable(DiscoveryDirEnvVar);
            }
            catch { }

            _discoveryDirectoryPath = string.IsNullOrWhiteSpace(overrideDir)
                ? Path.Combine(ResolveDiscoveryTempBase(), "loomtide", "unitybridge")
                : overrideDir;

            Directory.CreateDirectory(_discoveryDirectoryPath);
            _sessionDiscoveryFilePath = Path.Combine(
                _discoveryDirectoryPath, $"endpoint-discovery-{SessionId}.json");
            _latestDiscoveryFilePath = Path.Combine(_discoveryDirectoryPath, DiscoveryLatestFileName);
            _lastDiscoveryPublishUnixMs = 0;
            _lastDiscoverySweepUnixMs = 0;

            // Clear any backlog of stale discovery files left by crashed / prior sessions
            // (graceful Stop() deletes a session's own file, but a crash leaves it to
            // accumulate until TTL-expiry). Best-effort; never throws into startup.
            SweepExpiredDiscoveryFiles();
        }

        /// <summary>
        /// Best-effort cleanup of stale endpoint-discovery files left behind by crashed or
        /// prior sessions (each domain reload writes a new file; graceful Stop deletes its
        /// own, but crashes do not). Readers already ignore expired files, so this is pure
        /// disk-litter cleanup. Only deletes files expired for at least one full TTL — the
        /// safety margin so a paused-but-live editor's about-to-renew file is never removed.
        /// Wrapped end-to-end so it can NEVER throw into startup or publish.
        /// </summary>
        private void SweepExpiredDiscoveryFiles()
        {
            if (string.IsNullOrEmpty(_discoveryDirectoryPath))
            {
                return;
            }

            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long deleteBefore = now - DiscoveryTtlMs;
                int swept = 0;

                string[] files = Directory.GetFiles(
                    _discoveryDirectoryPath, "endpoint-discovery-*.json");
                foreach (string file in files)
                {
                    // Never touch the bridge's own current files.
                    if (string.Equals(file, _latestDiscoveryFilePath, StringComparison.Ordinal)
                        || string.Equals(file, _sessionDiscoveryFilePath, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    long expiresAt;
                    try
                    {
                        var parsed = JObject.Parse(File.ReadAllText(file));
                        var token = parsed["expiresAtUnixMs"];
                        if (token == null || token.Type != JTokenType.Integer)
                        {
                            // Missing/non-numeric field — could be mid-write; leave it.
                            continue;
                        }
                        expiresAt = token.Value<long>();
                    }
                    catch
                    {
                        // Unparseable (e.g. mid-write) — leave it for a later sweep.
                        continue;
                    }

                    // Only delete files expired for at least one full TTL.
                    if (expiresAt < deleteBefore)
                    {
                        try
                        {
                            File.Delete(file);
                            swept++;
                        }
                        catch
                        {
                            // Another process may hold/own it — ignore and move on.
                        }
                    }
                }

                if (swept > 0)
                {
                    Debug.Log($"{LogPrefix} Swept {swept} stale discovery file(s).");
                }
            }
            catch
            {
                // Directory gone, permissions, etc. — sweeping is best-effort, never fatal.
            }
        }

        /// <summary>
        /// Base temp dir for discovery files. On macOS the MCP server and the Editor can
        /// carry different $TMPDIR values (e.g. a coding agent sets a custom TMPDIR while a
        /// GUI-launched Editor uses launchd's per-user dir), which would split them into two
        /// directories and break multi-editor discovery. Both sides resolve the stable,
        /// env-independent DARWIN_USER_TEMP_DIR so they always agree; everything else falls
        /// back to Path.GetTempPath(). LOOMTIDE_ENDPOINT_DISCOVERY_DIR overrides this entirely.
        /// </summary>
        private static string ResolveDiscoveryTempBase()
        {
            if (Application.platform == RuntimePlatform.OSXEditor)
            {
                try
                {
                    var psi = new System.Diagnostics.ProcessStartInfo("/usr/bin/getconf", "DARWIN_USER_TEMP_DIR")
                    {
                        RedirectStandardOutput = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    };
                    using (var proc = System.Diagnostics.Process.Start(psi))
                    {
                        string output = proc.StandardOutput.ReadToEnd().Trim();
                        proc.WaitForExit(2000);
                        if (!string.IsNullOrWhiteSpace(output))
                        {
                            return output;
                        }
                    }
                }
                catch
                {
                    // getconf unavailable — fall through to the runtime default.
                }
            }

            return Path.GetTempPath();
        }

        private bool TryCreateUnixSocketPath(out string socketPath, out string reason)
        {
            socketPath = string.Empty;
            reason = string.Empty;

            if (Application.platform != RuntimePlatform.OSXEditor
                && Application.platform != RuntimePlatform.LinuxEditor)
            {
                reason = $"platform {Application.platform} does not use Unix domain socket transport";
                return false;
            }

            if (!UnixSocketTransportListener.IsSupported())
            {
                reason = "Unix domain socket API is unavailable on this runtime";
                return false;
            }

            string runtimeDir = Path.Combine(_discoveryDirectoryPath, "runtime");
            Directory.CreateDirectory(runtimeDir);
            socketPath = Path.Combine(runtimeDir, $"bridge-{SessionId}.sock");
            return true;
        }

        private void PublishEndpointDiscovery(bool force = false)
        {
            if (string.IsNullOrEmpty(_sessionDiscoveryFilePath)
                || string.IsNullOrEmpty(_latestDiscoveryFilePath)
                || string.IsNullOrEmpty(SessionId))
            {
                return;
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!force && now - _lastDiscoveryPublishUnixMs < DiscoveryRefreshIntervalMs)
            {
                return;
            }

            var payload = new JObject
            {
                ["schemaVersion"] = "1",
                ["sessionId"] = SessionId,
                ["publishedAtUnixMs"] = now,
                ["expiresAtUnixMs"] = now + DiscoveryTtlMs,
                ["transportModeDefault"] = ActiveTransportMode,
                ["endpoints"] = BuildDiscoveryEndpoints()
            };
            payload.Merge(ProjectIdentity.ToJson());

            string json = payload.ToString(Newtonsoft.Json.Formatting.None);
            try
            {
                Directory.CreateDirectory(_discoveryDirectoryPath);
                WriteDiscoveryFileAtomic(_sessionDiscoveryFilePath, json);
                WriteDiscoveryFileAtomic(_latestDiscoveryFilePath, json);
                _lastDiscoveryPublishUnixMs = now;
                if (force)
                {
                    Debug.Log(
                        $"{LogPrefix} Published endpoint discovery (sessionId: {SessionId}, "
                        + $"expiresAtUnixMs: {now + DiscoveryTtlMs})");
                }

                // Throttled stale-file sweep: keep a long-running session's dir bounded
                // without scanning on every 10s publish. SweepExpiredDiscoveryFiles is
                // fully wrapped, so this can never throw out of a successful publish.
                if (now - _lastDiscoverySweepUnixMs >= 60000)
                {
                    SweepExpiredDiscoveryFiles();
                    _lastDiscoverySweepUnixMs = now;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"{LogPrefix} Failed to write endpoint discovery: {ex.Message}");
            }
        }

        private static void WriteDiscoveryFileAtomic(string targetPath, string contents)
        {
            string directory = Path.GetDirectoryName(targetPath);
            if (string.IsNullOrEmpty(directory))
            {
                File.WriteAllText(targetPath, contents);
                return;
            }

            Directory.CreateDirectory(directory);
            string tempPath = Path.Combine(
                directory,
                $".{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.tmp");

            try
            {
                File.WriteAllText(tempPath, contents);
                if (File.Exists(targetPath))
                {
                    try
                    {
                        File.Replace(tempPath, targetPath, null);
                        return;
                    }
                    catch
                    {
                        // File.Replace is not uniformly available/reliable across Unity runtimes.
                    }

                    try
                    {
                        File.Delete(targetPath);
                    }
                    catch
                    {
                        // A transient reader lock can make delete fail on Windows; fallback below.
                    }
                }

                try
                {
                    File.Move(tempPath, targetPath);
                    return;
                }
                catch
                {
                    File.WriteAllText(targetPath, contents);
                }
            }
            finally
            {
                try
                {
                    if (File.Exists(tempPath))
                    {
                        File.Delete(tempPath);
                    }
                }
                catch { }
            }
        }

        private JArray BuildDiscoveryEndpoints()
        {
            var endpoints = new JArray();
            lock (_listenersLock)
            {
                foreach (var listener in _activeListeners)
                {
                    if (!listener.IsRunning)
                    {
                        continue;
                    }

                    var endpoint = new JObject
                    {
                        ["transport"] = listener.TransportName,
                        ["kind"] = listener.EndpointKind,
                        ["supportsHandshake"] = true,
                        ["supportsPing"] = true
                    };

                    if (!string.IsNullOrEmpty(listener.EndpointHost))
                    {
                        endpoint["host"] = listener.EndpointHost;
                    }
                    if (listener.EndpointPort.HasValue)
                    {
                        endpoint["port"] = listener.EndpointPort.Value;
                    }
                    if (!string.IsNullOrEmpty(listener.EndpointPath))
                    {
                        endpoint["path"] = listener.EndpointPath;
                    }

                    endpoints.Add(endpoint);
                }
            }

            return endpoints;
        }

        private string DescribeActiveEndpoints()
        {
            lock (_listenersLock)
            {
                if (_activeListeners.Count == 0)
                {
                    return "none";
                }

                var segments = new List<string>();
                foreach (var listener in _activeListeners)
                {
                    if (!listener.IsRunning)
                    {
                        continue;
                    }
                    segments.Add($"{listener.TransportName}/{listener.EndpointKind}:{listener.EndpointDescription}");
                }

                return segments.Count == 0 ? "none" : string.Join(", ", segments.ToArray());
            }
        }

        private void CleanupDiscoveryArtifacts()
        {
            try
            {
                if (!string.IsNullOrEmpty(_sessionDiscoveryFilePath) && File.Exists(_sessionDiscoveryFilePath))
                {
                    File.Delete(_sessionDiscoveryFilePath);
                }

                if (!string.IsNullOrEmpty(_latestDiscoveryFilePath) && File.Exists(_latestDiscoveryFilePath))
                {
                    string latestRaw = File.ReadAllText(_latestDiscoveryFilePath);
                    if (latestRaw.IndexOf(SessionId ?? string.Empty, StringComparison.Ordinal) >= 0)
                    {
                        File.Delete(_latestDiscoveryFilePath);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"{LogPrefix} Failed to clean endpoint discovery artifacts: {ex.Message}");
            }
            finally
            {
                _sessionDiscoveryFilePath = null;
                _latestDiscoveryFilePath = null;
                _lastDiscoveryPublishUnixMs = 0;
            }
        }

        /// <summary>
        /// Stops the WebSocket server and cleans up all connections.
        /// </summary>
        public void Stop()
        {
            if (!_isRunning)
            {
                StopListeners();
                CleanupDiscoveryArtifacts();
                try { _cts?.Dispose(); } catch { }
                _cts = null;
                ActivePort = 0;
                return;
            }

            _isRunning = false;
            Debug.Log($"{LogPrefix} Stopping server (sessionId: {SessionId})");

            // Cancel all background tasks
            try { _cts?.Cancel(); } catch { }

            // Close all connected sockets
            lock (_socketsLock)
            {
                foreach (var ws in _connectedSockets)
                {
                    try
                    {
                        ws.CloseAsync().Wait(TimeSpan.FromSeconds(1));
                    }
                    catch { }

                    try { ws.Dispose(); } catch { }
                }
                _connectedSockets.Clear();
            }

            lock (_handshakeLock)
            {
                _handshakeCompleted.Clear();
            }

            lock (_sendLocksLock)
            {
                foreach (var sem in _sendLocks.Values)
                    try { sem.Dispose(); } catch { }
                _sendLocks.Clear();
            }

            StopListeners();
            CleanupDiscoveryArtifacts();

            try { _cts?.Dispose(); } catch { }
            _cts = null;
            ActivePort = 0;
        }

        private void StopListeners()
        {
            lock (_listenersLock)
            {
                foreach (var listener in _activeListeners)
                {
                    try { listener.Stop(); } catch { }
                    try { listener.Dispose(); } catch { }
                }
                _activeListeners.Clear();
            }
        }

        /// <summary>
        /// Processes queued main-thread actions. Call from EditorApplication.update.
        /// </summary>
        public void ProcessMainThreadQueue()
        {
            int processed = 0;
            while (processed < MaxCommandsPerFrame && _mainThreadQueue.TryDequeue(out Action action))
            {
                try
                {
                    action?.Invoke();
                }
                catch (Exception ex)
                {
                    Debug.LogError($"{LogPrefix} Error processing command: {ex.Message}\n{ex.StackTrace}");
                }
                processed++;
            }

            if (_isRunning)
            {
                PublishEndpointDiscovery();
            }
        }

        // ─────────────────────────────────────────────
        // Connection Handling
        // ─────────────────────────────────────────────

        private static TcpListener CreateListener(int port)
        {
            try
            {
                // Prefer dual-mode IPv6 socket so both ::1 and 127.0.0.1 can connect.
                var listener = new TcpListener(IPAddress.IPv6Loopback, port);
                listener.Server.DualMode = true;
                return listener;
            }
            catch (SocketException)
            {
                return new TcpListener(IPAddress.Loopback, port);
            }
            catch (NotSupportedException)
            {
                return new TcpListener(IPAddress.Loopback, port);
            }
        }

        private static Type ResolveUnixDomainSocketEndPointType()
        {
            Type endpointType = Type.GetType(
                "System.Net.Sockets.UnixDomainSocketEndPoint, System.Net.Sockets",
                throwOnError: false);
            if (endpointType != null)
            {
                return endpointType;
            }

            return typeof(Socket).Assembly.GetType(
                "System.Net.Sockets.UnixDomainSocketEndPoint",
                throwOnError: false);
        }

        private async Task AcceptConnectionsAsync(ITransportListener transportListener, CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && transportListener.IsRunning)
            {
                try
                {
                    BridgeSocketConnection ws;
                    try
                    {
                        ws = await transportListener.AcceptConnectionAsync(ct);
                    }
                    catch (Exception ex)
                    {
                        if (!ct.IsCancellationRequested)
                            EnqueueLog($"Accept error ({transportListener.TransportName}): {ex.Message}");
                        continue;
                    }

                    if (ws == null)
                    {
                        continue;
                    }

                    lock (_socketsLock)
                    {
                        _connectedSockets.Add(ws);
                    }

                    lock (_sendLocksLock)
                    {
                        _sendLocks[ws] = new SemaphoreSlim(1, 1);
                    }

                    EnqueueLog(
                        $"Client connected via {transportListener.TransportName}/{transportListener.EndpointKind} "
                        + $"(total: {_connectedSockets.Count})");

                    _ = Task.Run(() => HandleClientAsync(ws, transportListener, ct), ct);
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (SocketException)
                {
                    if (!ct.IsCancellationRequested)
                        EnqueueLog($"Accept error: {transportListener.TransportName} socket closed");
                    break;
                }
                catch (Exception ex)
                {
                    if (!ct.IsCancellationRequested)
                        EnqueueLog($"Accept error: {ex.Message}");
                }
            }
        }

        private async Task HandleClientAsync(
            BridgeSocketConnection ws,
            ITransportListener transportListener,
            CancellationToken ct)
        {
            try
            {
                while (ws.IsOpen && !ct.IsCancellationRequested)
                {
                    string messageJson = await ws.ReceiveTextMessageAsync(ct);
                    if (messageJson == null)
                        break;

                    // Capture for closure
                    string capturedMessage = messageJson;
                    BridgeSocketConnection capturedWs = ws;

                    _mainThreadQueue.Enqueue(() => ProcessCommand(capturedWs, capturedMessage));
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (Exception ex)
            {
                EnqueueLog($"Client handler error: {ex.Message}");
            }
            finally
            {
                int remaining;

                lock (_socketsLock)
                {
                    _connectedSockets.Remove(ws);
                    remaining = _connectedSockets.Count;
                }
                lock (_handshakeLock)
                {
                    _handshakeCompleted.Remove(ws);
                }
                lock (_sendLocksLock)
                {
                    if (_sendLocks.TryGetValue(ws, out var sem))
                    {
                        sem.Dispose();
                        _sendLocks.Remove(ws);
                    }
                }

                try { await ws.CloseAsync(); } catch { }
                try { ws.Dispose(); } catch { }

                EnqueueLog(
                    $"Client disconnected from {transportListener.TransportName}/{transportListener.EndpointKind} "
                    + $"(remaining: {remaining})");
            }
        }

        // ─────────────────────────────────────────────
        // Command Processing
        // ─────────────────────────────────────────────

        private void ProcessCommand(BridgeSocketConnection ws, string messageJson)
        {
            BridgeRequest request;
            string id = "unknown";

            try
            {
                request = BridgeRequest.Parse(messageJson);
                id = request.Id;
            }
            catch (BridgeException bex)
            {
                Debug.LogError($"{LogPrefix} Invalid request: {bex.Message}");
                SendResponse(ws, BridgeResponse.Error("unknown", bex.Code, bex.Message));
                return;
            }
            catch (Exception ex)
            {
                Debug.LogError($"{LogPrefix} Failed to parse request: {ex.Message}");
                SendResponse(ws, BridgeResponse.Error("unknown", "PARSE_ERROR",
                    $"Invalid JSON: {ex.Message}"));
                return;
            }

            string command = request.Command;
            JObject parameters = request.Params;

            Debug.Log($"{LogPrefix} Command received: {command} (id: {id})");

            // Handshake enforcement
            bool hasHandshake;
            lock (_handshakeLock)
            {
                hasHandshake = _handshakeCompleted.Contains(ws);
            }

            if (!hasHandshake && command != "bridge.initialize")
            {
                Debug.LogWarning(
                    $"{LogPrefix} Handshake required — rejecting command '{command}' "
                    + $"(sessionId: {SessionId}, port: {ActivePort})");
                SendResponse(ws, BridgeResponse.Error(id, ErrorCodes.HANDSHAKE_REQUIRED,
                    "You must send 'bridge.initialize' before any other command."));
                return;
            }

            // Route: built-in ping
            if (command == "bridge.ping")
            {
                HandlePing(ws, id);
                return;
            }

            // Route: exact sync handler match
            if (_syncHandlers.TryGetValue(command, out var syncHandler))
            {
                try
                {
                    JObject result = syncHandler(id, parameters);

                    // Sync handler for bridge.initialize marks handshake complete
                    if (command == "bridge.initialize")
                    {
                        lock (_handshakeLock)
                        {
                            _handshakeCompleted.Add(ws);
                        }
                    }

                    SendResponse(ws, result);
                }
                catch (BridgeException bex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, bex.Code, bex.Message));
                }
                catch (Exception ex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, "INTERNAL_ERROR", ex.Message));
                }
                return;
            }

            // Route: exact async handler match
            if (_asyncHandlers.TryGetValue(command, out var asyncHandler))
            {
                try
                {
                    Action<JObject> respond = (response) => SendResponse(ws, response);
                    asyncHandler(id, parameters, respond);
                }
                catch (BridgeException bex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, bex.Code, bex.Message));
                }
                catch (Exception ex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, "INTERNAL_ERROR", ex.Message));
                }
                return;
            }

            // Route: default handler (OpExecutor)
            if (_defaultHandler != null)
            {
                try
                {
                    var context = new BridgeRequestContext(id, command, parameters, SessionId);
                    Action<JObject> respond = (response) => SendResponse(ws, response);
                    _defaultHandler(context, respond);
                }
                catch (BridgeException bex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, bex.Code, bex.Message));
                }
                catch (Exception ex)
                {
                    SendResponse(ws, BridgeResponse.Error(id, "INTERNAL_ERROR", ex.Message));
                }
                return;
            }

            // No handler found
            SendResponse(ws, BridgeResponse.Error(id, ErrorCodes.NOT_FOUND,
                $"Unknown command: {command}"));
        }

        // ─────────────────────────────────────────────
        // Built-in Handlers
        // ─────────────────────────────────────────────

        private void HandlePing(BridgeSocketConnection ws, string id)
        {
            var data = new JObject
            {
                ["pong"] = true,
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["sessionId"] = SessionId
            };
            SendResponse(ws, BridgeResponse.Success(id, data));
        }

        // ─────────────────────────────────────────────
        // Response Sending
        // ─────────────────────────────────────────────

        private void SendResponse(BridgeSocketConnection ws, JObject response)
        {
            if (!ws.IsOpen)
            {
                Debug.LogWarning($"{LogPrefix} Cannot send response — socket not open (id: {response.Value<string>("id")})");
                return;
            }

            string json = response.ToString(Newtonsoft.Json.Formatting.None);

            SemaphoreSlim sendLock;
            lock (_sendLocksLock)
            {
                if (!_sendLocks.TryGetValue(ws, out sendLock))
                    return; // Socket already cleaned up
            }

            // Serialize sends per socket via SemaphoreSlim
            Task.Run(async () =>
            {
                try
                {
                    await sendLock.WaitAsync();
                    try
                    {
                        if (ws.IsOpen)
                        {
                            await ws.SendTextAsync(json, CancellationToken.None);
                        }
                    }
                    finally
                    {
                        sendLock.Release();
                    }
                }
                catch (ObjectDisposedException) { }
                catch (Exception ex)
                {
                    _mainThreadQueue.Enqueue(() =>
                        Debug.LogWarning($"{LogPrefix} Send failed: {ex.Message}"));
                }
            });
        }

        // ─────────────────────────────────────────────
        // Utility
        // ─────────────────────────────────────────────

        private void EnqueueLog(string message)
        {
            _mainThreadQueue.Enqueue(() => Debug.Log($"{LogPrefix} {message}"));
        }

        // ─────────────────────────────────────────────
        // Listener Abstraction
        // ─────────────────────────────────────────────

        private interface ITransportListener : IDisposable
        {
            string TransportName { get; }
            string EndpointKind { get; }
            string EndpointDescription { get; }
            string EndpointHost { get; }
            int? EndpointPort { get; }
            string EndpointPath { get; }
            bool IsRunning { get; }
            void Start();
            Task<BridgeSocketConnection> AcceptConnectionAsync(CancellationToken ct);
            void Stop();
        }

        private sealed class TcpTransportListener : ITransportListener
        {
            private readonly TcpListener _listener;
            private readonly int _port;
            private bool _isRunning;

            public TcpTransportListener(TcpListener listener, int port)
            {
                _listener = listener;
                _port = port;
            }

            public string TransportName => "tcp";
            public string EndpointKind => "websocket";
            public string EndpointDescription => $"ws://localhost:{_port}";
            public string EndpointHost => "localhost";
            public int? EndpointPort => _port;
            public string EndpointPath => null;
            public bool IsRunning => _isRunning;

            public void Start()
            {
                _listener.Start();
                _isRunning = true;
            }

            public async Task<BridgeSocketConnection> AcceptConnectionAsync(CancellationToken ct)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync();
                client.NoDelay = true;
                return await BridgeSocketConnection.AcceptAsync(client, ct);
            }

            public void Stop()
            {
                _isRunning = false;
                try { _listener.Stop(); } catch { }
            }

            public void Dispose()
            {
                Stop();
            }
        }

        private sealed class UnixSocketTransportListener : ITransportListener
        {
            private readonly string _socketPath;
            private Socket _listener;
            private bool _isRunning;

            public UnixSocketTransportListener(string socketPath)
            {
                _socketPath = socketPath;
            }

            public string TransportName => "ipc";
            public string EndpointKind => "unix_domain_socket";
            public string EndpointDescription => _socketPath;
            public string EndpointHost => null;
            public int? EndpointPort => null;
            public string EndpointPath => _socketPath;
            public bool IsRunning => _isRunning;

            public static bool IsSupported()
            {
                return ResolveUnixDomainSocketEndPointType() != null;
            }

            public void Start()
            {
                Type endpointType = ResolveUnixDomainSocketEndPointType();
                if (endpointType == null)
                {
                    throw new PlatformNotSupportedException("Unix domain socket endpoint type is unavailable");
                }

                if (File.Exists(_socketPath))
                {
                    File.Delete(_socketPath);
                }

                _listener = new Socket((AddressFamily)1, SocketType.Stream, ProtocolType.Unspecified);
                EndPoint endpoint = (EndPoint)Activator.CreateInstance(endpointType, _socketPath);
                _listener.Bind(endpoint);
                _listener.Listen(16);
                _isRunning = true;
            }

            public async Task<BridgeSocketConnection> AcceptConnectionAsync(CancellationToken ct)
            {
                if (!_isRunning || _listener == null)
                {
                    return null;
                }

                Socket acceptedSocket = await Task<Socket>.Factory.FromAsync(
                    _listener.BeginAccept,
                    _listener.EndAccept,
                    null);
                var stream = new NetworkStream(acceptedSocket, true);
                return await BridgeSocketConnection.AcceptAsync(stream, () =>
                {
                    try { stream.Dispose(); } catch { }
                }, ct);
            }

            public void Stop()
            {
                _isRunning = false;
                try { _listener?.Close(); } catch { }
                _listener = null;

                try
                {
                    if (File.Exists(_socketPath))
                    {
                        File.Delete(_socketPath);
                    }
                }
                catch { }
            }

            public void Dispose()
            {
                Stop();
            }
        }

        private sealed class NamedPipeTransportListener : ITransportListener
        {
            private readonly string _pipeName;
            private readonly string _pipePath;
            private readonly object _pendingPipeLock = new object();
            private NamedPipeServerStream _pendingPipe;
            private bool _isRunning;

            public NamedPipeTransportListener(string pipeName, string pipePath)
            {
                _pipeName = pipeName;
                _pipePath = pipePath;
            }

            public string TransportName => "ipc";
            public string EndpointKind => "named_pipe";
            public string EndpointDescription => _pipePath;
            public string EndpointHost => null;
            public int? EndpointPort => null;
            public string EndpointPath => _pipePath;
            public bool IsRunning => _isRunning;

            public void Start()
            {
                _isRunning = true;
            }

            public async Task<BridgeSocketConnection> AcceptConnectionAsync(CancellationToken ct)
            {
                if (!_isRunning)
                {
                    return null;
                }

                NamedPipeServerStream server = CreateServer();
                lock (_pendingPipeLock)
                {
                    if (!_isRunning)
                    {
                        server.Dispose();
                        return null;
                    }
                    _pendingPipe = server;
                }

                try
                {
                    await WaitForConnectionAsync(server, ct);
                    if (!_isRunning || !server.IsConnected)
                    {
                        server.Dispose();
                        return null;
                    }

                    return await BridgeSocketConnection.AcceptAsync(server, () =>
                    {
                        try { server.Dispose(); } catch { }
                    }, ct);
                }
                catch (ObjectDisposedException)
                {
                    if (ct.IsCancellationRequested || !_isRunning)
                    {
                        return null;
                    }
                    throw;
                }
                finally
                {
                    lock (_pendingPipeLock)
                    {
                        if (_pendingPipe == server)
                        {
                            _pendingPipe = null;
                        }
                    }
                }
            }

            public void Stop()
            {
                _isRunning = false;
                lock (_pendingPipeLock)
                {
                    try { _pendingPipe?.Dispose(); } catch { }
                    _pendingPipe = null;
                }
            }

            public void Dispose()
            {
                Stop();
            }

            private NamedPipeServerStream CreateServer()
            {
                return new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);
            }

            private static async Task WaitForConnectionAsync(NamedPipeServerStream server, CancellationToken ct)
            {
                CancellationTokenRegistration registration = default;
                if (ct.CanBeCanceled)
                {
                    registration = ct.Register(() =>
                    {
                        try { server.Dispose(); } catch { }
                    });
                }

                try
                {
                    await Task.Factory.FromAsync(
                        server.BeginWaitForConnection,
                        server.EndWaitForConnection,
                        null);
                }
                finally
                {
                    registration.Dispose();
                }
            }
        }

        // ─────────────────────────────────────────────
        // Managed WebSocket Connection
        // ─────────────────────────────────────────────

        private sealed class BridgeSocketConnection : IDisposable
        {
            private const int MaxHttpHeaderBytes = 16 * 1024;
            private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

            private readonly Stream _stream;
            private readonly Action _disposeTransport;
            private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);

            private volatile bool _isOpen;
            private bool _disposed;

            private BridgeSocketConnection(Stream stream, Action disposeTransport)
            {
                _stream = stream;
                _disposeTransport = disposeTransport;
                _isOpen = true;
            }

            public bool IsOpen => _isOpen && !_disposed;

            public static async Task<BridgeSocketConnection> AcceptAsync(TcpClient client, CancellationToken ct)
            {
                Stream stream = client.GetStream();
                return await AcceptAsync(stream, () =>
                {
                    try { client.Close(); } catch { }
                }, ct);
            }

            public static async Task<BridgeSocketConnection> AcceptAsync(
                Stream stream,
                Action disposeTransport,
                CancellationToken ct)
            {
                string requestHeaders = await ReadHttpHeadersAsync(stream, ct);
                if (string.IsNullOrEmpty(requestHeaders))
                {
                    await WriteHttpErrorAsync(stream, "400 Bad Request", ct);
                    try { disposeTransport?.Invoke(); } catch { }
                    return null;
                }

                if (!TryParseWebSocketRequest(requestHeaders, out string secWebSocketKey))
                {
                    await WriteHttpErrorAsync(stream, "400 Bad Request", ct);
                    try { disposeTransport?.Invoke(); } catch { }
                    return null;
                }

                string acceptKey = ComputeAcceptKey(secWebSocketKey);
                string response =
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    $"Sec-WebSocket-Accept: {acceptKey}\r\n" +
                    "\r\n";

                byte[] responseBytes = Encoding.ASCII.GetBytes(response);
                await stream.WriteAsync(responseBytes, 0, responseBytes.Length, ct);
                await stream.FlushAsync(ct);

                return new BridgeSocketConnection(stream, disposeTransport);
            }

            public async Task<string> ReceiveTextMessageAsync(CancellationToken ct)
            {
                List<byte> fragmentedPayload = null;

                while (IsOpen && !ct.IsCancellationRequested)
                {
                    byte[] header;
                    try
                    {
                        header = await ReadExactlyAsync(2, ct);
                    }
                    catch (EndOfStreamException)
                    {
                        _isOpen = false;
                        return null;
                    }

                    bool fin = (header[0] & 0x80) != 0;
                    int opcode = header[0] & 0x0F;
                    bool masked = (header[1] & 0x80) != 0;
                    ulong payloadLength = (ulong)(header[1] & 0x7F);

                    if (payloadLength == 126)
                    {
                        byte[] ext = await ReadExactlyAsync(2, ct);
                        if (BitConverter.IsLittleEndian)
                            Array.Reverse(ext);
                        payloadLength = BitConverter.ToUInt16(ext, 0);
                    }
                    else if (payloadLength == 127)
                    {
                        byte[] ext = await ReadExactlyAsync(8, ct);
                        if (BitConverter.IsLittleEndian)
                            Array.Reverse(ext);
                        payloadLength = BitConverter.ToUInt64(ext, 0);
                    }

                    if (payloadLength > int.MaxValue)
                    {
                        await CloseAsync();
                        return null;
                    }

                    byte[] maskKey = masked ? await ReadExactlyAsync(4, ct) : null;
                    byte[] payload = payloadLength > 0
                        ? await ReadExactlyAsync((int)payloadLength, ct)
                        : Array.Empty<byte>();

                    if (masked && payload.Length > 0)
                    {
                        for (int i = 0; i < payload.Length; i++)
                        {
                            payload[i] ^= maskKey[i % 4];
                        }
                    }

                    // Close frame
                    if (opcode == 0x8)
                    {
                        await SendControlFrameAsync(0x8, Array.Empty<byte>(), CancellationToken.None);
                        _isOpen = false;
                        return null;
                    }

                    // Ping frame
                    if (opcode == 0x9)
                    {
                        await SendControlFrameAsync(0xA, payload, CancellationToken.None);
                        continue;
                    }

                    // Pong frame
                    if (opcode == 0xA)
                    {
                        continue;
                    }

                    // Ignore unsupported/binary opcodes
                    if (opcode != 0x1 && opcode != 0x0)
                    {
                        continue;
                    }

                    // Text frame
                    if (opcode == 0x1)
                    {
                        if (fin)
                            return Encoding.UTF8.GetString(payload);

                        fragmentedPayload = new List<byte>(payload);
                        continue;
                    }

                    // Continuation frame
                    if (fragmentedPayload == null)
                    {
                        continue;
                    }

                    fragmentedPayload.AddRange(payload);
                    if (fin)
                    {
                        string message = Encoding.UTF8.GetString(fragmentedPayload.ToArray());
                        fragmentedPayload = null;
                        return message;
                    }
                }

                return null;
            }

            public async Task SendTextAsync(string message, CancellationToken ct)
            {
                if (!IsOpen)
                    return;

                byte[] payload = Encoding.UTF8.GetBytes(message ?? string.Empty);
                await SendFrameAsync(0x1, payload, ct);
            }

            public async Task CloseAsync()
            {
                if (!_isOpen)
                    return;

                _isOpen = false;

                try
                {
                    await SendControlFrameAsync(0x8, Array.Empty<byte>(), CancellationToken.None);
                }
                catch { }
            }

            public void Dispose()
            {
                if (_disposed)
                    return;

                _isOpen = false;
                _disposed = true;

                try { _stream?.Close(); } catch { }
                try { _disposeTransport?.Invoke(); } catch { }
                try { _writeLock.Dispose(); } catch { }
            }

            private async Task SendControlFrameAsync(byte opcode, byte[] payload, CancellationToken ct)
            {
                if (payload == null || payload.Length > 125)
                    payload = Array.Empty<byte>();

                await SendFrameAsync(opcode, payload, ct);
            }

            private async Task SendFrameAsync(byte opcode, byte[] payload, CancellationToken ct)
            {
                if (!IsOpen)
                    return;

                payload = payload ?? Array.Empty<byte>();
                int payloadLength = payload.Length;

                byte[] header;
                if (payloadLength <= 125)
                {
                    header = new byte[2];
                    header[1] = (byte)payloadLength;
                }
                else if (payloadLength <= ushort.MaxValue)
                {
                    header = new byte[4];
                    header[1] = 126;
                    header[2] = (byte)((payloadLength >> 8) & 0xFF);
                    header[3] = (byte)(payloadLength & 0xFF);
                }
                else
                {
                    header = new byte[10];
                    header[1] = 127;
                    ulong len = (ulong)payloadLength;
                    for (int i = 0; i < 8; i++)
                    {
                        header[9 - i] = (byte)(len & 0xFF);
                        len >>= 8;
                    }
                }

                header[0] = (byte)(0x80 | (opcode & 0x0F));

                await _writeLock.WaitAsync(ct);
                try
                {
                    await _stream.WriteAsync(header, 0, header.Length, ct);
                    if (payloadLength > 0)
                        await _stream.WriteAsync(payload, 0, payloadLength, ct);
                    await _stream.FlushAsync(ct);
                }
                finally
                {
                    _writeLock.Release();
                }
            }

            private async Task<byte[]> ReadExactlyAsync(int byteCount, CancellationToken ct)
            {
                byte[] buffer = new byte[byteCount];
                int offset = 0;

                while (offset < byteCount)
                {
                    int read = await _stream.ReadAsync(buffer, offset, byteCount - offset, ct);
                    if (read <= 0)
                        throw new EndOfStreamException("Socket closed while reading");

                    offset += read;
                }

                return buffer;
            }

            private static async Task<string> ReadHttpHeadersAsync(Stream stream, CancellationToken ct)
            {
                var data = new List<byte>(1024);
                var one = new byte[1];

                while (data.Count < MaxHttpHeaderBytes)
                {
                    int read = await stream.ReadAsync(one, 0, 1, ct);
                    if (read <= 0)
                        return null;

                    data.Add(one[0]);

                    int c = data.Count;
                    if (c >= 4 && data[c - 4] == '\r' && data[c - 3] == '\n' && data[c - 2] == '\r' && data[c - 1] == '\n')
                    {
                        return Encoding.ASCII.GetString(data.ToArray());
                    }
                }

                return null;
            }

            private static bool TryParseWebSocketRequest(string rawHeaders, out string secWebSocketKey)
            {
                secWebSocketKey = null;

                string[] lines = rawHeaders.Split(new[] { "\r\n" }, StringSplitOptions.None);
                if (lines.Length == 0)
                    return false;

                string requestLine = lines[0];
                if (!requestLine.StartsWith("GET ", StringComparison.OrdinalIgnoreCase))
                    return false;

                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    string line = lines[i];
                    if (string.IsNullOrEmpty(line))
                        break;

                    int colon = line.IndexOf(':');
                    if (colon <= 0)
                        continue;

                    string name = line.Substring(0, colon).Trim();
                    string value = line.Substring(colon + 1).Trim();
                    headers[name] = value;
                }

                if (!headers.TryGetValue("Upgrade", out string upgrade) ||
                    !upgrade.Equals("websocket", StringComparison.OrdinalIgnoreCase))
                    return false;

                if (!headers.TryGetValue("Connection", out string connection) ||
                    connection.IndexOf("upgrade", StringComparison.OrdinalIgnoreCase) < 0)
                    return false;

                if (!headers.TryGetValue("Sec-WebSocket-Key", out secWebSocketKey) ||
                    string.IsNullOrEmpty(secWebSocketKey))
                    return false;

                if (headers.TryGetValue("Sec-WebSocket-Version", out string version) && version != "13")
                    return false;

                return true;
            }

            private static string ComputeAcceptKey(string secWebSocketKey)
            {
                string combined = secWebSocketKey.Trim() + WebSocketGuid;
                byte[] combinedBytes = Encoding.ASCII.GetBytes(combined);

                using (SHA1 sha1 = SHA1.Create())
                {
                    byte[] hash = sha1.ComputeHash(combinedBytes);
                    return Convert.ToBase64String(hash);
                }
            }

            private static async Task WriteHttpErrorAsync(Stream stream, string statusLine, CancellationToken ct)
            {
                string response =
                    $"HTTP/1.1 {statusLine}\r\n" +
                    "Connection: close\r\n" +
                    "Content-Length: 0\r\n" +
                    "\r\n";

                byte[] bytes = Encoding.ASCII.GetBytes(response);
                await stream.WriteAsync(bytes, 0, bytes.Length, ct);
                await stream.FlushAsync(ct);
            }
        }
    }
}
