/**
 * The `probeEditor` doubles for the unified `verify` orchestrator.
 *
 * LiveByDefault made `verify` drive a running editor by default, and gave the orchestrator a
 * PREFLIGHT: before the first section runs, a live run asks whether an editor is reachable
 * and REFUSES (tier 2) when it is not. That is the right behaviour for an operator and a
 * hard stop for a test, which has no editor and never wants one: without a double, every
 * live-path test in the suite would exit 2 on the probe and prove nothing about the section
 * it was written for.
 *
 * Two doubles, spelled as deps fragments so a call site spreads one in beside its own
 * `runFlowTrace`/`runFeel` doubles:
 *
 *  - `REACHABLE_EDITOR` says an editor answered, which is the precondition every existing
 *    live-path test always implicitly had.
 *  - `UNREACHABLE_EDITOR` says none did, which is the new refusal's own subject.
 *
 * They are DOUBLES OF THE SEAM, not of the decision: the orchestrator still decides whether
 * to probe at all, and still owns the refusal text. A test that wanted to skip the probe by
 * injecting something would be testing a different code path than the one that ships.
 */

/** An editor answered the handshake. */
export const REACHABLE_EDITOR = {
  async probeEditor(): Promise<{ reachable: boolean; detail: string }> {
    return { reachable: true, detail: "handshake ok (test double)" };
  },
};

/** No editor answered. `detail` is the transport's own first line, as the real probe returns it. */
export function unreachableEditor(detail = "connect ECONNREFUSED 127.0.0.1:8790"): {
  probeEditor(): Promise<{ reachable: boolean; detail: string }>;
} {
  return {
    async probeEditor() {
      return { reachable: false, detail };
    },
  };
}
