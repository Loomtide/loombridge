using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Interface for category-level operation handlers.
    /// Each handler owns a category (e.g., "scene", "editor") and dispatches ops within it.
    /// </summary>
    public interface IOpHandler
    {
        /// <summary>
        /// Handles a synchronous operation. Return the result data JObject.
        /// Return null if the op is async (should not happen if IsAsync returns false).
        /// </summary>
        JObject HandleOp(string opName, JObject parameters);

        /// <summary>
        /// Handles an asynchronous operation. Call respond with the result data,
        /// or call onError with a BridgeException on failure.
        /// </summary>
        void HandleOpAsync(string opName, JObject parameters, Action<JObject> respond, Action<BridgeException> onError);

        /// <summary>
        /// Returns true if the given op should be dispatched asynchronously.
        /// </summary>
        bool IsAsync(string opName);
    }

    /// <summary>
    /// Central command router. Parses "category.opName" commands,
    /// looks up the registered IOpHandler for the category, and dispatches.
    /// </summary>
    public class OpExecutor
    {
        private const string LogPrefix = "[UnityBridge]";

        private readonly Dictionary<string, IOpHandler> _handlers =
            new Dictionary<string, IOpHandler>();

        /// <summary>
        /// Registers a handler for the given category (e.g., "scene", "editor").
        /// </summary>
        public void RegisterCategory(string category, IOpHandler handler)
        {
            _handlers[category] = handler;
            Debug.Log($"{LogPrefix} Registered handler for category '{category}'");
        }

        /// <summary>
        /// Executes a command by parsing it into category.opName,
        /// looking up the handler, and dispatching sync or async.
        /// The respond callback receives the final wire-protocol JObject response.
        /// </summary>
        public void Execute(BridgeRequestContext request, Action<JObject> respond)
        {
            string id = request?.RequestId ?? "unknown";
            string command = request?.Command ?? string.Empty;
            JObject parameters = request?.Parameters ?? new JObject();
            TraceCollector.TraceScope scope = default;

            try
            {
                // Parse command: split on first '.' → category + opName
                int dotIndex = command.IndexOf('.');
                if (dotIndex < 0)
                {
                    respond(BridgeResponse.Error(id, ErrorCodes.INVALID_PARAMS,
                        $"Invalid command format: '{command}'. Expected 'category.opName'."));
                    return;
                }

                string category = command.Substring(0, dotIndex);
                string opName = command.Substring(dotIndex + 1);

                // Look up handler
                if (!_handlers.TryGetValue(category, out IOpHandler handler))
                {
                    respond(BridgeResponse.Error(id, ErrorCodes.INVALID_PARAMS,
                        $"Unknown category: '{category}'. Available: [{string.Join(", ", _handlers.Keys)}]"));
                    return;
                }

                if (handler.IsAsync(opName))
                {
                    // Async dispatch — scope is captured in closures
                    scope = TraceCollector.BeginOp(command);
                    var capturedScope = scope;

                    handler.HandleOpAsync(opName, parameters,
                        (resultData) =>
                        {
                            JObject trace = TraceCollector.EndOp(capturedScope);
                            respond(BridgeResponse.Success(id, resultData, trace));
                        },
                        (error) =>
                        {
                            JObject trace = TraceCollector.EndOp(capturedScope);
                            JObject screenshot = TraceCollector.CaptureErrorScreenshot(command);
                            TraceCollector.AttachArtifact(trace, screenshot);
                            respond(BridgeResponse.Error(id, error.Code, error.Message, trace));
                        });
                }
                else
                {
                    // Sync dispatch
                    scope = TraceCollector.BeginOp(command);
                    JObject resultData = handler.HandleOp(opName, parameters);
                    JObject trace = TraceCollector.EndOp(scope);
                    respond(BridgeResponse.Success(id, resultData, trace));
                }
            }
            catch (BridgeException bex)
            {
                JObject trace = TraceCollector.EndOp(scope);
                JObject screenshot = TraceCollector.CaptureErrorScreenshot(command);
                TraceCollector.AttachArtifact(trace, screenshot);
                respond(BridgeResponse.Error(id, bex.Code, bex.Message, trace));
            }
            catch (Exception ex)
            {
                JObject trace = TraceCollector.EndOp(scope);
                JObject screenshot = TraceCollector.CaptureErrorScreenshot(command);
                TraceCollector.AttachArtifact(trace, screenshot);
                Debug.LogError($"{LogPrefix} Op execution error: {ex.Message}\n{ex.StackTrace}");
                respond(BridgeResponse.Error(id, "INTERNAL_ERROR", ex.Message, trace));
            }
        }

        /// <summary>
        /// Executes a single "category.op" command inline on the current (main) thread and
        /// returns its result data. Used by ops.batch. Throws BridgeException on failure.
        /// </summary>
        public JObject ExecuteCommandInline(string command, JObject parameters)
        {
            if (string.IsNullOrEmpty(command))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "Batch op missing 'command'.");
            int dotIndex = command.IndexOf('.');
            if (dotIndex < 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Invalid command format: '{command}'. Expected 'category.opName'.");
            string category = command.Substring(0, dotIndex);
            string opName = command.Substring(dotIndex + 1);
            if (!_handlers.TryGetValue(category, out IOpHandler handler))
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"Unknown category: '{category}'.");
            parameters = parameters ?? new JObject();

            if (handler.IsAsync(opName))
            {
                JObject captured = null;
                BridgeException capturedErr = null;
                bool done = false;
                handler.HandleOpAsync(opName, parameters,
                    r => { captured = r; done = true; },
                    e => { capturedErr = e; done = true; });
                if (!done)
                    throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                        $"Op '{command}' completes asynchronously across editor ticks and cannot run inside ops.batch. Run it as a standalone op.");
                if (capturedErr != null) throw capturedErr;
                return captured;
            }
            return handler.HandleOp(opName, parameters);
        }

        /// <summary>
        /// Creates a default handler function suitable for BridgeServer.RegisterDefaultHandler.
        /// </summary>
        public Func<BridgeRequestContext, Action<JObject>, bool> AsDefaultHandler()
        {
            return (request, respond) =>
            {
                Execute(request, respond);

                // Always return true — we handle the response via callback
                return true;
            };
        }
    }
}
