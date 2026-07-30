/**
 * `deriveEvidenceOrigin`: who wrote an evidence file, RE-DERIVED from the file.
 *
 * The property under test is the `deriveEvidenceClassesFromUntrusted` discipline: the
 * answer comes from the data, an absent marker is STATED rather than omitted, and no
 * self-declared field can change the outcome (there is no field to declare).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveEvidenceOrigin,
  isCliWritten,
  renderOriginCounts,
} from "../../../domain/evidence-origin.js";

test("no `_provenance` block at all is agent-assembled, and SAYS why", () => {
  const facts = deriveEvidenceOrigin({ runSpeed: 8 });
  assert.equal(facts.origin, "agent-assembled");
  assert.equal(facts.writer, null);
  assert.equal(facts.runId, null);
  assert.match(facts.note, /no `_provenance` block/);
});

test("a non-object (or unparseable) file is agent-assembled, never a throw", () => {
  for (const input of [null, undefined, 42, "text", [1, 2]]) {
    const facts = deriveEvidenceOrigin(input);
    assert.equal(facts.origin, "agent-assembled", `${JSON.stringify(input)}`);
  }
});

test("the four shipped producer writer labels are ALL recognised, not just the feel/playability one", () => {
  // The producers do not agree on one string: `capture-feel`/`capture-playability`
  // write `loombridge-capture`, while framing/console/tiles write
  // `loombridge capture (framing)` and friends. A derivation that matched only the
  // first spelling would silently report three of five producers as agent-assembled.
  for (const writer of [
    "loombridge-capture",
    "loombridge capture (framing)",
    "loombridge capture (console)",
    "loombridge capture (ground-tiling)",
  ]) {
    const facts = deriveEvidenceOrigin({ _provenance: { writer, runId: "run-1" } });
    assert.equal(facts.origin, "produced", writer);
    assert.equal(facts.writer, writer);
    assert.equal(facts.runId, "run-1");
  }
});

test("a FOREIGN writer label is agent-assembled: the label is a report field, never a credential", () => {
  const facts = deriveEvidenceOrigin({ _provenance: { writer: "my-script", runId: "run-1" } });
  assert.equal(facts.origin, "agent-assembled");
  assert.equal(facts.writer, "my-script");
  assert.match(facts.note, /not a Loombridge capture producer/);
});

test("OBSERVED is keyed on the RECORDING, not on the recipe name", () => {
  const observed = deriveEvidenceOrigin({
    _provenance: { writer: "loombridge-capture", recipe: "playability", observation: { buffers: {} } },
  });
  assert.equal(observed.origin, "observed");
  // Same writer, same recipe string, no recording: PRODUCED, because the recording is
  // the thing that makes an observation an observation.
  const renamed = deriveEvidenceOrigin({ _provenance: { writer: "loombridge-capture", recipe: "playability" } });
  assert.equal(renamed.origin, "produced");
});

test("editorSessionId is read from the routing block when the producer stamps it there", () => {
  const facts = deriveEvidenceOrigin({
    _provenance: { writer: "loombridge capture (framing)", unityRouting: { editorSessionId: "sess-9" } },
  });
  assert.equal(facts.editorSessionId, "sess-9");
});

test("isCliWritten covers produced AND observed, and nothing else", () => {
  assert.equal(isCliWritten("produced"), true);
  assert.equal(isCliWritten("observed"), true);
  assert.equal(isCliWritten("agent-assembled"), false);
});

test("the summary always prints all three buckets, so a zero is visible", () => {
  assert.equal(
    renderOriginCounts(["produced", "produced", "observed"]),
    "produced 2, observed 1, agent-assembled 0",
  );
  assert.equal(renderOriginCounts([]), "produced 0, observed 0, agent-assembled 0");
});
