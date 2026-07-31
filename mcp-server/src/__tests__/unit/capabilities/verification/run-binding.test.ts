/**
 * runBindingRefusals, tested DIRECTLY (E6 F2). Stage 4 exercised it only through
 * full verify runs on CLI-written evidence, so the agent-assembled branch had no
 * coverage at all: which is how a leftover placement.json from the previous day
 * graded to a certifying pass under --strict, live. Wrong-run evidence refuses
 * regardless of writer; ABSENT runId on agent-assembled evidence stays a note
 * (no producer exists to stamp one for those gates).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runBindingRefusals, type EvidenceLedger } from "../../../../capabilities/verification/evidence-ledger.js";

function ledgerWith(files: EvidenceLedger["files"]): EvidenceLedger {
  return { files } as EvidenceLedger;
}

const cli = (over: Record<string, unknown> = {}) => ({
  file: "feel.json",
  sha256: "aa".repeat(32),
  evidenceOrigin: "produced" as const,
  writer: "loombridge-capture",
  runId: "run-minted",
  editorSessionId: "session-1",
  ...over,
});

const assembled = (over: Record<string, unknown> = {}) => ({
  file: "placement.json",
  sha256: "bb".repeat(32),
  evidenceOrigin: "agent-assembled" as const,
  writer: null,
  runId: null,
  editorSessionId: null,
  ...over,
});

test("positive control: matching runs and one session bind clean", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([cli(), assembled({ runId: "run-minted" })] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.deepEqual(result.refusals, []);
});

test("E6 F2: agent-assembled evidence claiming a DIFFERENT run refuses, not notes", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([assembled({ runId: "run-yesterday" })] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.equal(result.refusals.length, 1, JSON.stringify(result));
  assert.match(result.refusals[0]!, /agent-assembled and claims run `run-yesterday`/);
  assert.match(result.refusals[0]!, /re-assemble it under the minted run/);
});

test("agent-assembled with ABSENT runId stays a warn note (no producer exists to stamp one)", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([assembled()] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0]!, /self-authored/);
});

test("CLI-written evidence from another run refuses (stage-4 rule, now pinned directly)", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([cli({ runId: "run-other" })] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.equal(result.refusals.length, 1);
  assert.match(result.refusals[0]!, /produced under run `run-other`/);
});

test("two editor sessions in one slice refuse (L106, pinned directly)", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([
      cli({ editorSessionId: "session-1" }),
      cli({ file: "console.json", editorSessionId: "session-2" }),
    ] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.ok(result.refusals.some((r: string) => r.includes("DIFFERENT editor sessions")), JSON.stringify(result.refusals));
});
