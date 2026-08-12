/**
 * THE TWO HUMAN ACTS, PROMOTED TO TOP-LEVEL VERBS.
 *
 * The ratchet loop has exactly two moments that require a person: a human DEMONSTRATES, and
 * a human APPROVES. Everything between them is machinery. `loombridge record` and
 * `loombridge approve` are those two acts; `trace replay`, `trace replay-all`,
 * `trace tolerance`, `trace mask` and `trace report` stay namespaced because they are typed
 * twice a year, not daily.
 *
 * WHAT HAS TO HOLD, and is checked here rather than documented:
 *
 *  1. The promoted verb reaches the SAME HANDLER as the namespaced spelling, with the argv
 *     forwarded intact. A dispatcher that dropped the subcommand token would still "work"
 *     for `--help` and silently mean something else for every real invocation, so the
 *     assertions use argv that only the RECORD (or APPROVE) parse path can produce.
 *  2. Bare `approve` RESOLVES to the replay baseline, and when there is no run to promote it
 *     REFUSES and names the other approvable artifacts it can see. Promotion is what makes
 *     the verb ambiguous (there are four approve surfaces); refusing at exactly that moment
 *     is the whole price, and it is paid as a visible choice rather than a guess. An
 *     approval nobody consented to is the artifact this product exists to refuse.
 *  3. No interactive prompt, ever: this verb runs in CI and in non-interactive agent
 *     sessions, and a prompt would hang both. The refusal path is asserted to complete.
 *
 * NOTHING HERE TOUCHES A LIVE EDITOR. Every argv either fails in the argument parser or
 * refuses on an empty directory, both of which happen strictly before any bridge call.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../../../surfaces/cli.js";
import { setDesignTarget } from "../../../capabilities/verification/design.js";
import { standardReplayLayout } from "../../../domain/state.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-human-acts-"));
}

/** Run the CLI, capturing stdout and stderr separately. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const outLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loombridgeCli(["node", "cli.js", ...argv]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

test("`loombridge record` reaches the SAME handler as `trace record`, argv intact", async () => {
  // `--scene` is validated ONLY when the subcommand is `record` (`if (sub === "record")` in
  // the trace parser), and the refusal names the path that was rejected. That makes this argv
  // a probe for the wiring rather than for the parser: a dispatcher that forwarded `rest`
  // WITHOUT the `record` token would land on `trace --scene …`, whose first token is not a
  // known subcommand at all.
  const canonical = await capture(["record", "--scene", "not-a-scene"]);
  const namespaced = await capture(["trace", "record", "--scene", "not-a-scene"]);

  assert.equal(canonical.code, namespaced.code, "same exit as the namespaced spelling");
  assert.equal(canonical.err, namespaced.err, "same stderr, byte for byte");
  assert.equal(canonical.out, namespaced.out, "same stdout, byte for byte");
  assert.match(canonical.err, /--scene 'not-a-scene' must be an Assets\/\*\*\.unity path/);

  // THE CONTROL, without which the assertions above would pass for a dispatcher that dropped
  // the token: the same flags with NO subcommand are a different answer entirely.
  const dropped = await capture(["trace", "--scene", "not-a-scene"]);
  assert.match(dropped.err, /unknown subcommand "--scene"/);
  assert.notEqual(dropped.err, canonical.err, "the `record` token is what makes the two agree");
});

test("`loombridge approve` reaches the SAME handler as `trace approve`, argv intact", async () => {
  // `--set` is refused on `approve` BY NAME ("approve NEVER takes a tolerance…"), and the
  // refusal quotes the subcommand it saw. So this argv proves the `approve` token arrived,
  // not merely that some parser ran.
  const canonical = await capture(["approve", "--set", "0.02"]);
  const namespaced = await capture(["trace", "approve", "--set", "0.02"]);

  assert.equal(canonical.code, namespaced.code, "same exit as the namespaced spelling");
  assert.equal(canonical.err, namespaced.err, "same stderr, byte for byte");
  assert.match(canonical.err, /\(got "approve"\)/, "the handler saw the approve subcommand");

  const dropped = await capture(["trace", "--set", "0.02"]);
  assert.match(dropped.err, /unknown subcommand "--set"/);
  assert.notEqual(dropped.err, canonical.err, "the `approve` token is what makes the two agree");
});

test("bare `approve` with NO replay run REFUSES (exit 2) and names the loop that produces one", async () => {
  const root = await tmpRoot();
  try {
    const { code, err } = await capture(["approve", "--root", root]);
    assert.equal(code, 2, err);
    assert.match(err, /nothing to approve/);
    // The loop, in order, as the two human acts plus the machinery between them.
    assert.match(err, /loombridge record/);
    assert.match(err, /loombridge verify --live/);
    assert.match(err, /loombridge approve/);
    // With nothing else on disk it says so, rather than staying silent about having looked.
    assert.match(err, /No other approvable artifact is visible here/);
    // The fourth approve surface can never be discovered from a project root, and the
    // refusal says that instead of pretending to have checked.
    assert.match(err, /minigame baseline approve/);
    // NOTHING WAS FROZEN. A refusal that wrote a baseline would be the exact failure this
    // product exists to refuse.
    await assert.rejects(fs.access(standardReplayLayout(root).replayBaselines));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bare `approve` NAMES the other approvable artifacts it can actually see", async () => {
  const root = await tmpRoot();
  try {
    // A Design Target that exists and is still a DRAFT: a real, approvable artifact that
    // bare `approve` deliberately does not resolve to.
    const png = path.join(root, "hero.png");
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await setDesignTarget({ root, imagePath: png, mode: "provided" });

    const { code, err } = await capture(["approve", "--root", root]);
    assert.equal(code, 2, err);
    assert.match(err, /loombridge target approve/, "the visible alternative is named as a runnable command");
    assert.match(err, /still a draft/, "…and what it would freeze is stated");
    assert.doesNotMatch(
      err,
      /No other approvable artifact is visible here/,
      "it must not claim to have found nothing while listing something",
    );
    // AND IT STILL REFUSES. Naming an alternative is not choosing one: guessing between the
    // four approve surfaces is the one answer worse than refusing.
    await assert.rejects(fs.access(standardReplayLayout(root).replayBaselines));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, performed on the REAL source, rebuilt and re-run each time, then restored.
 *
 * BREAK 1 — remove the refusal entirely. `capabilities/replay/trace.ts`,
 * `resolveApproveTargetId`:
 *     -  if (recent === null) {
 *     -    for (const line of approveRefusalLines({ … })) console.error(line);
 *     -    return null;
 *     -  }
 *     +  if (recent === null) return "";
 *   OBSERVED VERBATIM:
 *     ✖ bare `approve` with NO replay run REFUSES (exit 2) and names the loop that produces one
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] no report at
 *       .loombridge/run/replays/reports/.report.json — run 'trace replay --id ' first.
 *
 *       1 !== 2
 *     ✖ bare `approve` NAMES the other approvable artifacts it can actually see
 *       AssertionError [ERR_ASSERTION]: [loombridge trace] no report at
 *       .loombridge/run/replays/reports/.report.json — run 'trace replay --id ' first.
 *
 *       1 !== 2
 *
 * BREAK 2 — keep the refusal, drop the alternatives. `approvable-alternatives.ts`:
 *     -    if (design.status !== "missing" && !(design.status === "approved" && design.frozenMatches)) {
 *     +    if (false) {
 *   OBSERVED VERBATIM:
 *     ✖ bare `approve` NAMES the other approvable artifacts it can actually see
 *       AssertionError [ERR_ASSERTION]: the visible alternative is named as a runnable command
 *       … expected: /loombridge target approve/  operator: 'match'
 *   (the no-replay-run test stayed GREEN, which is the point of having both: the refusal and
 *   the naming are two separate promises and each fails on its own.)
 *
 * BREAK 3 — forward the argv without the subcommand token. `surfaces/cli.ts`:
 *     -      return run(["record", ...rest]);
 *     +      return run(rest);
 *   OBSERVED VERBATIM:
 *     ✖ `loombridge record` reaches the SAME handler as `trace record`, argv intact
 *       AssertionError [ERR_ASSERTION]: same stderr, byte for byte
 *       + actual - expected
 *       + '[loombridge trace] unknown subcommand "--scene".'
 *       - "[loombridge trace] --scene 'not-a-scene' must be an Assets/**.unity path."
 */
