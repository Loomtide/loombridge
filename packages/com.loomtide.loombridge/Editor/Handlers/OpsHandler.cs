using System;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;
using UnityEditor;
using UnityEngine;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// Handles meta operations that re-dispatch existing bridge ops.
    /// "ops.batch" runs a list of existing ops sequentially on the Unity main
    /// thread in one round-trip, wrapped in a single Undo group, collapsing many
    /// round-trips (create N objects + set N transforms + add M components) into one.
    /// No new capability surface — it just re-dispatches existing handlers inline.
    /// </summary>
    public class OpsHandler : IOpHandler
    {
        private readonly OpExecutor _executor;

        public OpsHandler(OpExecutor executor)
        {
            _executor = executor;
        }

        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "batch":
                    return HandleBatch(parameters);
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND,
                        $"Unknown ops op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            // No async ops in OpsHandler.
            onError(new BridgeException(ErrorCodes.NOT_FOUND,
                $"Ops op '{opName}' is not async."));
        }

        // ─────────────────────────────────────────────
        // Op Implementations
        // ─────────────────────────────────────────────

        private JObject HandleBatch(JObject parameters)
        {
            var operations = parameters?["operations"] as JArray;
            if (operations == null)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "Missing required parameter: 'operations' (array).");

            bool stopOnError = parameters.Value<bool?>("stopOnError") ?? true;
            string undoGroupName = parameters.Value<string>("undoGroupName") ?? "Loombridge Batch";

            // Wrap the whole batch in a single, named undo group so the entire run
            // collapses to one Ctrl+Z step.
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName(undoGroupName);
            int undoGroup = Undo.GetCurrentGroup();

            var results = new JArray();
            int okCount = 0;
            int failCount = 0;

            try
            {
                for (int i = 0; i < operations.Count; i++)
                {
                    var entry = new JObject();
                    JObject opObject = operations[i] as JObject;
                    string command = opObject?.Value<string>("command");
                    JObject opParams = opObject?["params"] as JObject;

                    entry["index"] = i;
                    entry["command"] = command;

                    if (string.IsNullOrEmpty(command))
                    {
                        entry["ok"] = false;
                        entry["error"] = new JObject
                        {
                            ["code"] = ErrorCodes.INVALID_PARAMS,
                            ["message"] = $"Batch operation at index {i} is missing a 'command' string."
                        };
                        failCount++;
                        results.Add(entry);
                        if (stopOnError) break;
                        continue;
                    }

                    try
                    {
                        JObject data = _executor.ExecuteCommandInline(command, opParams);
                        entry["ok"] = true;
                        entry["data"] = data;
                        okCount++;
                    }
                    catch (BridgeException bex)
                    {
                        entry["ok"] = false;
                        entry["error"] = new JObject
                        {
                            ["code"] = bex.Code,
                            ["message"] = bex.Message
                        };
                        failCount++;
                        results.Add(entry);
                        if (stopOnError) break;
                        continue;
                    }

                    results.Add(entry);
                }
            }
            finally
            {
                // Even on an unexpected exception, collapse the undo group so we
                // never leave the editor with a dangling, un-named group.
                Undo.CollapseUndoOperations(undoGroup);
            }

            return new JObject
            {
                ["results"] = results,
                ["okCount"] = okCount,
                ["failCount"] = failCount,
                ["total"] = operations.Count,
                ["stoppedEarly"] = stopOnError && failCount > 0
            };
        }
    }
}
