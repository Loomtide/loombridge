import assert from "node:assert/strict";
import test from "node:test";

import {
  type ProbeExec,
  defaultProbe,
  detectCodex,
  detectGenerationBackends,
  generationBackendsDoctorDetail,
} from "../../../../capabilities/setup/generation-backends.js";

/**
 * Every case drives an INJECTED probe, so both branches are covered on any machine. A test that
 * asked the real PATH would assert "codex is available" on the author's laptop and "codex is
 * absent" in CI, which is a test of the runner rather than of the code.
 */
const probeReturning = (result: ReturnType<ProbeExec>): ProbeExec => () => result;

test("codex detected: status 0 with a version line", () => {
  const status = detectCodex(probeReturning({ status: 0, stdout: "codex-cli 0.145.0\n" }));
  assert.equal(status.available, true);
  assert.equal(status.version, "codex-cli 0.145.0");
  assert.match(status.detail, /available/);
});

test("codex ABSENT: the probe returns null (ENOENT) and that is a normal answer, not a throw", () => {
  const status = detectCodex(probeReturning(null));
  assert.equal(status.available, false);
  assert.equal(status.version, undefined);
  // The wording has to make clear nothing is broken: this is an optional accelerator.
  assert.match(status.detail, /not found/);
  assert.match(status.detail, /optional/);
});

test("codex present but FAILING (non-zero exit) counts as unavailable", () => {
  // A broken install that answers is worse than one that does not: offering it sends the user to
  // a backend that cannot run. Exit status is the only signal available here, so it gates.
  const status = detectCodex(probeReturning({ status: 1, stdout: "some error" }));
  assert.equal(status.available, false);
});

test("codex available with unreadable version output still counts as available", () => {
  // PRESENCE gates the offer, not the version. Empty stdout must not demote a working binary.
  const status = detectCodex(probeReturning({ status: 0, stdout: "   \n" }));
  assert.equal(status.available, true);
  assert.equal(status.version, undefined);
  assert.equal(status.detail, "codex: available");
});

test("this agent is ALWAYS available and listed first, so the backend count is never zero", () => {
  const withoutCodex = detectGenerationBackends(probeReturning(null));
  assert.equal(withoutCodex[0]!.id, "claude");
  assert.equal(withoutCodex[0]!.available, true);
  assert.equal(
    withoutCodex.filter((b) => b.available).length,
    1,
    "a machine with no codex still has one way to produce a hero shot",
  );
});

test("LITMUS: detection REPORTS every backend and never selects one", () => {
  // The invariant from HeroShotAuthoring.md §3. Claude and codex produce visibly different art
  // and the hero shot is the artifact the whole build is graded against, so a silent pick is a
  // surprise on the worst possible artifact. Assert the API cannot express a choice: both
  // backends come back, in a stable order, with no "selected"/"default"/"preferred" field.
  const both = detectGenerationBackends(probeReturning({ status: 0, stdout: "codex-cli 0.145.0\n" }));
  assert.deepEqual(both.map((b) => b.id), ["claude", "codex"]);
  assert.equal(both.every((b) => b.available), true);
  for (const backend of both) {
    assert.deepEqual(
      Object.keys(backend).filter((k) => /select|default|prefer|chosen/i.test(k)),
      [],
      `a backend must not carry a selection field (got ${Object.keys(backend).join(", ")})`,
    );
  }
});

test("the doctor detail names the available backends and the total", () => {
  const detail = generationBackendsDoctorDetail(
    detectGenerationBackends(probeReturning({ status: 0, stdout: "codex-cli 0.145.0\n" })),
  );
  assert.match(detail, /2 of 2/);
  assert.match(detail, /codex-cli 0\.145\.0/);

  const alone = generationBackendsDoctorDetail(detectGenerationBackends(probeReturning(null)));
  assert.match(alone, /1 of 2/);
});

test("defaultProbe returns null for a binary that does not exist (no throw)", () => {
  // Exercises the REAL spawn path, which the injected cases deliberately bypass. If ENOENT ever
  // threw instead of returning an error result, `doctor` would crash on a machine without codex,
  // which is most machines.
  const probe = defaultProbe(5000);
  assert.equal(probe("loombridge-no-such-binary-xyz", ["--version"]), null);
});
