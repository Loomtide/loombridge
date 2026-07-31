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

// ── E15: which session field can refuse, and which can only note ─────────────
//
// `editorSessionId` is a bridge SERVER-GENERATION id, re-minted by every domain reload
// (so by every play-mode entry). The E6 sessions proved one editor sitting hands out two
// of them across a slice's CLI + agent evidence, which made the old check refuse honest
// runs. `observation.recorderEditorSessionId` is read inside the running editor and is
// the field that can still prove two sittings.

test("E15: two different editorSessionIds alone are a NOTE naming the limitation, not a refusal", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([
      cli({ editorSessionId: "session-1" }),
      cli({ file: "console.json", editorSessionId: "session-2" }),
    ] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.deepEqual(result.refusals, [], "a bridge restart is not proof of two sittings");
  assert.ok(
    result.notes.some((n: string) => /different `editorSessionId`s/.test(n) && /SERVER GENERATION/.test(n)),
    JSON.stringify(result.notes),
  );
});

test("E15: differing editorSessionIds with AGREEING recorder ids say so, and still do not refuse", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([
      cli({ editorSessionId: "session-1", recorderEditorSessionId: "sitting-A" }),
      cli({ file: "playability.json", editorSessionId: "session-2", recorderEditorSessionId: "sitting-A" }),
    ] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.deepEqual(result.refusals, []);
  assert.ok(
    result.notes.some((n: string) => /agrees on recorder sitting `sitting-A`/.test(n)),
    JSON.stringify(result.notes),
  );
});

test("E15 LITMUS: a genuinely DIFFERENT sitting, proven by differing recorder ids, still REFUSES", () => {
  // The same two files as the note case above, with only the strong binder changed.
  const result = runBindingRefusals({
    ledger: ledgerWith([
      cli({ editorSessionId: "session-1", recorderEditorSessionId: "sitting-A" }),
      cli({ file: "playability.json", editorSessionId: "session-2", recorderEditorSessionId: "sitting-B" }),
    ] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.ok(
    result.refusals.some((r: string) => /RECORDED IN 2 DIFFERENT editor sittings/.test(r)),
    JSON.stringify(result.refusals),
  );
});

test("E15: differing recorder ids refuse even when the weak editorSessionIds agree", () => {
  // The reverse smuggle: one cached connection id over two real sittings.
  const result = runBindingRefusals({
    ledger: ledgerWith([
      cli({ editorSessionId: "session-1", recorderEditorSessionId: "sitting-A" }),
      cli({ file: "playability.json", editorSessionId: "session-1", recorderEditorSessionId: "sitting-B" }),
    ] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.ok(
    result.refusals.some((r: string) => /RECORDED IN 2 DIFFERENT editor sittings/.test(r)),
    JSON.stringify(result.refusals),
  );
});

test("L106 unchanged: a CLI-written file with NO editorSessionId at all still refuses (absent is not a skip)", () => {
  const result = runBindingRefusals({
    ledger: ledgerWith([cli({ editorSessionId: null })] as EvidenceLedger["files"]),
    mintedRunId: "run-minted",
    label: "slice demo",
  });
  assert.ok(
    result.refusals.some((r: string) => /carries no `editorSessionId`/.test(r)),
    JSON.stringify(result.refusals),
  );
});
