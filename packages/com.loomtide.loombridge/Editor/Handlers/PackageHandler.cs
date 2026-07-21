using System;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles Unity Package Manager (UPM) operations: list installed packages,
    /// add/remove a dependency, and search the registry. Lets an agent self-provision
    /// packages a build needs (e.g. Input System, Cinemachine, TextMeshPro) instead of
    /// failing on a missing dependency.
    ///
    /// Every op is async: UnityEditor.PackageManager.Client returns a Request that
    /// completes over several editor ticks, so each op polls request.IsCompleted via
    /// WaitEngine (which ticks on EditorApplication.update). A failed Request surfaces as
    /// a BridgeException thrown from the result factory, which WaitEngine routes to onError.
    /// </summary>
    public class PackageHandler : IOpHandler
    {
        // Network round-trips (add/remove/search) can take a while; list is local-ish.
        private const long DefaultMutateTimeoutMs = 120000;
        private const long DefaultListTimeoutMs = 60000;

        public bool IsAsync(string opName)
        {
            return opName == "add" || opName == "list" || opName == "remove" || opName == "search";
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            // All package ops are async (UPM Client is request/poll based).
            throw new BridgeException(ErrorCodes.NOT_FOUND,
                $"Package op '{opName}' is async; it is not dispatched synchronously.");
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            switch (opName)
            {
                case "add":
                    HandleAdd(parameters, respond, onError);
                    return;
                case "list":
                    HandleList(parameters, respond, onError);
                    return;
                case "remove":
                    HandleRemove(parameters, respond, onError);
                    return;
                case "search":
                    HandleSearch(parameters, respond, onError);
                    return;
                default:
                    onError(new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown package op: '{opName}'"));
                    return;
            }
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private void HandleAdd(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            string packageId = parameters?.Value<string>("packageId");
            if (string.IsNullOrEmpty(packageId))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'packageId' (e.g. 'com.unity.cinemachine', 'com.unity.inputsystem@1.7.0', or a git URL)."));
                return;
            }

            AddRequest request = Client.Add(packageId);
            Poll(
                "package.add", parameters, request,
                () => new JObject
                {
                    ["status"] = request.Status.ToString(),
                    ["package"] = request.Result != null ? DescribePackage(request.Result) : null
                },
                () => $"package.add for '{packageId}' did not complete in time.",
                respond, onError, DefaultMutateTimeoutMs);
        }

        private void HandleList(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            bool offlineMode = parameters?.Value<bool?>("offlineMode") ?? false;

            ListRequest request = Client.List(offlineMode, includeIndirectDependencies: true);
            Poll(
                "package.list", parameters, request,
                () =>
                {
                    var packages = new JArray();
                    if (request.Result != null)
                    {
                        foreach (PackageInfo p in request.Result)
                            packages.Add(DescribePackage(p));
                    }
                    return new JObject
                    {
                        ["status"] = request.Status.ToString(),
                        ["count"] = packages.Count,
                        ["packages"] = packages
                    };
                },
                () => "package.list did not complete in time.",
                respond, onError, DefaultListTimeoutMs);
        }

        private void HandleRemove(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            string packageName = parameters?.Value<string>("packageName");
            if (string.IsNullOrEmpty(packageName))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'packageName' (e.g. 'com.unity.cinemachine')."));
                return;
            }

            RemoveRequest request = Client.Remove(packageName);
            Poll(
                "package.remove", parameters, request,
                () => new JObject
                {
                    ["status"] = request.Status.ToString(),
                    ["removed"] = request.PackageIdOrName
                },
                () => $"package.remove for '{packageName}' did not complete in time.",
                respond, onError, DefaultMutateTimeoutMs);
        }

        private void HandleSearch(JObject parameters, Action<JObject> respond, Action<BridgeException> onError)
        {
            string query = parameters?.Value<string>("packageId") ?? parameters?.Value<string>("query");
            if (string.IsNullOrEmpty(query))
            {
                onError(new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'packageId' (the package name/id to search the registry for, e.g. 'com.unity.cinemachine')."));
                return;
            }

            SearchRequest request = Client.Search(query);
            Poll(
                "package.search", parameters, request,
                () =>
                {
                    var packages = new JArray();
                    if (request.Result != null)
                    {
                        foreach (PackageInfo p in request.Result)
                            packages.Add(DescribePackage(p));
                    }
                    return new JObject
                    {
                        ["status"] = request.Status.ToString(),
                        ["count"] = packages.Count,
                        ["packages"] = packages
                    };
                },
                () => $"package.search for '{query}' did not complete in time.",
                respond, onError, DefaultMutateTimeoutMs);
        }

        // ─────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────

        /// <summary>
        /// Polls a UPM Request to completion via WaitEngine. On Failure the result factory
        /// throws a BridgeException (routed to onError by WaitEngine); on Success it returns
        /// the op-specific result payload. An optional 'timeoutMs' param overrides the default.
        /// </summary>
        private void Poll(string command, JObject parameters, Request request,
            Func<JObject> buildSuccess, Func<string> timeoutMessageFactory,
            Action<JObject> respond, Action<BridgeException> onError, long defaultTimeoutMs)
        {
            long timeoutMs = parameters?.Value<long?>("timeoutMs") ?? defaultTimeoutMs;
            var condition = new JObject { ["timeoutMs"] = timeoutMs };

            WaitEngine.WaitFor(
                condition,
                () => request.IsCompleted,
                () =>
                {
                    if (request.Status == StatusCode.Failure)
                    {
                        string msg = request.Error != null ? request.Error.message : "unknown Package Manager error";
                        throw new BridgeException(ErrorCodes.NOT_FOUND, $"{command} failed: {msg}");
                    }
                    return buildSuccess();
                },
                timeoutMessageFactory,
                respond,
                onError);
        }

        private static JObject DescribePackage(PackageInfo p)
        {
            return new JObject
            {
                ["name"] = p.name,
                ["displayName"] = p.displayName,
                ["version"] = p.version,
                ["source"] = p.source.ToString(),
                ["packageId"] = p.packageId,
                ["resolvedPath"] = p.resolvedPath
            };
        }
    }
}
