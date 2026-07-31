using System;
using Newtonsoft.Json.Linq;
using UnityBridge.Core;

namespace UnityBridge.Handlers
{
    /// <summary>
    /// THE OP JOURNAL READ OPS (evidence-trust wave, stage B1).
    ///
    ///   journal.stats   counters only: the journal's instance id, the current sequence
    ///                   number, totals, drops, capacity. Cheap enough to call at the
    ///                   open of an observation window, which is exactly its job: the
    ///                   caller records the id and the sequence, and a drain that comes
    ///                   back with a DIFFERENT instance id is a reset (domain reload),
    ///                   not a clean window.
    ///   journal.window  the entries themselves, oldest first, selected by sequence
    ///                   range or by elapsed time.
    ///
    /// Both are reads and both are idempotent: calling either twice returns the same
    /// slice (plus the two entries the two calls themselves appended, because the
    /// journal records EVERY dispatched op including its own reads: a journal with a
    /// blind spot for its own traffic is a journal with a blind spot).
    ///
    /// Neither op judges anything. The refusals live in the CLI, which re-derives them
    /// from these records.
    /// </summary>
    public class JournalHandler : IOpHandler
    {
        public bool IsAsync(string opName)
        {
            return false;
        }

        public JObject HandleOp(string opName, JObject parameters)
        {
            switch (opName)
            {
                case "stats":
                    return WithSession(OpJournal.Stats());
                case "window":
                    return WithSession(HandleWindow(parameters));
                default:
                    throw new BridgeException(ErrorCodes.NOT_FOUND, $"Unknown journal op: '{opName}'");
            }
        }

        public void HandleOpAsync(string opName, JObject parameters,
            Action<JObject> respond, Action<BridgeException> onError)
        {
            onError(new BridgeException(ErrorCodes.NOT_FOUND, $"Journal op '{opName}' is not async."));
        }

        private static JObject HandleWindow(JObject parameters)
        {
            long? fromSeq = parameters?.Value<long?>("fromSeq");
            long? toSeq = parameters?.Value<long?>("toSeq");
            double? fromTMs = parameters?.Value<double?>("fromTMs");

            // Two selectors would be two declarations of one range: refuse rather than
            // pick a winner, so a caller can never believe it asked for something else.
            if (fromSeq.HasValue && fromTMs.HasValue)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "journal.window takes EITHER a sequence selector (fromSeq/toSeq) OR a time selector (fromTMs), never both.");
            if (toSeq.HasValue && !fromSeq.HasValue)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    "journal.window: 'toSeq' is only meaningful with 'fromSeq'.");
            if (fromSeq.HasValue && fromSeq.Value < 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "journal.window: 'fromSeq' must be >= 0.");
            if (toSeq.HasValue && fromSeq.HasValue && toSeq.Value < fromSeq.Value)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS,
                    $"journal.window: 'toSeq' ({toSeq.Value}) is before 'fromSeq' ({fromSeq.Value}).");
            if (fromTMs.HasValue && fromTMs.Value < 0)
                throw new BridgeException(ErrorCodes.INVALID_PARAMS, "journal.window: 'fromTMs' must be >= 0.");

            return OpJournal.Window(fromSeq, toSeq, fromTMs);
        }

        /// <summary>
        /// Stamps the editor session the journal belongs to (ledger L106 co-temporality):
        /// a journalInstanceId proves "same journal", the editorSessionId proves "same
        /// editor", and evidence needs both.
        /// </summary>
        private static JObject WithSession(JObject payload)
        {
            payload["editorSessionId"] = UnityBridgeBootstrap.Server != null
                ? UnityBridgeBootstrap.Server.SessionId
                : null;
            return payload;
        }
    }
}
