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
 *
 *     THAT PROBE ALONE IS NOT ENOUGH, and the measurement is in BREAK 4 below: an injected
 *     `--flat` left this file green at `pass 4, fail 0` while the two spellings resolved to
 *     different replay layouts, because the probe argv is refused in the PARSE LOOP, before a
 *     layout is resolved. Two more guards close it: a probe that runs the approve handler to
 *     completion (where `--flat` / `--root` / `--id` all change the output), and a read of the
 *     dispatcher's own forwarding, which is the only thing that can cover `record` (its first
 *     act is connecting to a live editor, so it has no editor-free handler probe).
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
import {
  approvableAlternatives,
  approveRefusalLines,
} from "../../../capabilities/replay/approvable-alternatives.js";
import { feelPaths } from "../../../capabilities/feel/feel-workspace.js";
import {
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
} from "../../../capabilities/feel/snapshot-manifest.js";
import { setDesignTarget } from "../../../capabilities/verification/design.js";
import { loombridgePaths, standardReplayLayout } from "../../../domain/state.js";
import { CLI_SRC } from "../../_support/paths.js";

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

test("the alias agrees with the namespaced spelling PAST the parser, where an injected flag would show", async () => {
  // THE PROBE ABOVE IS NOT ENOUGH, and that is a measured fact rather than a worry. Injecting
  // `run(["approve", "--flat", ...rest])` into the shipped dispatcher left the whole file
  // GREEN (`pass 4, fail 0`) while the two spellings resolved to DIFFERENT replay layouts:
  // `--set 0.02` is refused in the parse loop, which happens before a layout is resolved, so
  // an argument that only changes what the HANDLER does is invisible to it.
  //
  // This probe runs the handler to completion instead. Bare `approve` on an empty project
  // walks the layout resolution, the report search and the alternatives detection, and prints
  // the directory it looked in, so `--flat` (a different layout), `--root` (a different
  // project) and `--id` (a different resolution path entirely) each change the output.
  const root = await tmpRoot();
  try {
    const canonical = await capture(["approve", "--root", root]);
    const namespaced = await capture(["trace", "approve", "--root", root]);

    assert.equal(canonical.code, namespaced.code, "same exit as the namespaced spelling");
    assert.equal(canonical.err, namespaced.err, "same stderr, byte for byte, all the way through the handler");
    assert.equal(canonical.out, namespaced.out, "same stdout, byte for byte");
    assert.match(canonical.err, /no replay run in \.loombridge\/run\/replays\/reports\//, "the standard layout");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the dispatcher forwards the promoted verbs as EXACTLY `[verb, ...rest]`, nothing else", async () => {
  // THE OTHER HALF, and the only one that can cover `record`. `record` connects to a running
  // editor as its first act, so there is no editor-free probe that reaches its handler, and a
  // parse-time probe cannot see an argument that changes only what the handler does. So the
  // forwarding itself is read from the source: any injected token changes the captured text,
  // for either verb, whether or not a behavioural probe exists for it.
  //
  // The regex captures every `return run([…])` in the dispatcher, so a THIRD promoted verb
  // added later fails this until it is declared here on purpose.
  const src = await fs.readFile(CLI_SRC, "utf-8");
  const forwards = [...src.matchAll(/return run\(\[([^\]]*)\]\)/g)].map((m) => m[1]!.trim()).sort();
  assert.deepEqual(
    forwards,
    ['"approve", ...rest', '"record", ...rest'],
    "a promoted verb forwards its own subcommand token and the operator's argv, and nothing in between",
  );
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

test("the alternatives detector names an artifact only when the ARTIFACT is there, not a directory", async () => {
  // `nonEmptyDir` made a lone `.DS_Store` (or a candidate dir a failed capture created and
  // never filled) advertise `loombridge feel snapshot approve` for a candidate that does not
  // exist, which the module's own docstring forbids: the operator runs the command this text
  // handed them and gets a second refusal. Detection now asks for the two files
  // `feel snapshot approve` itself refuses without.
  const root = await tmpRoot();
  const workspace = await tmpRoot();
  try {
    const candidateDir = feelPaths(workspace).snapshotCandidateDir;
    await fs.mkdir(candidateDir, { recursive: true });
    await fs.writeFile(path.join(candidateDir, ".DS_Store"), "junk");

    const junk = await approvableAlternatives(root, { workspace });
    assert.deepEqual(junk.found, [], "a non-empty directory is not a staged candidate");
    assert.ok(junk.checked.includes("a staged feel-snapshot candidate"), "…and the look really happened");

    // The real thing: both files `feel snapshot approve` reads.
    await fs.writeFile(path.join(candidateDir, SNAPSHOT_MEASUREMENTS_FILE), "{}");
    await fs.writeFile(path.join(candidateDir, SNAPSHOT_CONTRACT_FILE), "{}");
    const staged = await approvableAlternatives(root, { workspace });
    assert.deepEqual(
      staged.found.map((a) => a.command),
      ["loombridge feel snapshot approve"],
      "a candidate that really is approvable IS offered",
    );

    // HALF a candidate is not a candidate: `approve` refuses a candidate missing its frozen
    // contract, so offering it would hand the operator a command that cannot work.
    await fs.rm(path.join(candidateDir, SNAPSHOT_CONTRACT_FILE));
    assert.deepEqual((await approvableAlternatives(root, { workspace })).found, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a detector that could NOT look is reported as unchecked, never counted as `checked`", async () => {
  // The refusal used to print `(checked: the Design Target hero shot, a staged feel-snapshot
  // candidate)` from a hard-coded string while both detectors swallowed their errors, so a
  // detector that THREW was reported as one that looked and found nothing. "We looked and
  // there is nothing else" and "we could not look" are different answers, and only one of
  // them is safe to act on.
  const root = await tmpRoot();
  try {
    // A design directory that cannot be read as one: `designStatus` throws on it.
    const paths = loombridgePaths(root);
    await fs.mkdir(path.dirname(paths.design), { recursive: true });
    await fs.writeFile(paths.design, "not a directory");

    const result = await approvableAlternatives(root, { workspace: await tmpRoot() });
    assert.ok(
      !result.checked.includes("the Design Target hero shot"),
      `a detector that threw must not be claimed as checked: ${JSON.stringify(result)}`,
    );
    assert.deepEqual(result.unchecked.map((u) => u.what), ["the Design Target hero shot"]);

    const lines = approveRefusalLines({ tag: "[t]", reportsDir: "r", alternatives: result }).join("\n");
    assert.match(lines, /NOT checked: the Design Target hero shot \(/, "the gap is stated, with its reason");
    assert.doesNotMatch(
      lines,
      /\(checked: [^)]*Design Target/,
      "…and never claimed as a check that ran",
    );
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
 *
 * BREAK 4: INJECT AN ARGUMENT into the approve alias, the break the parse-time probes could
 * not see. `surfaces/cli.ts`:
 *     -      return run(["approve", ...rest]);
 *     +      return run(["approve", "--flat", ...rest]);
 *   Against the guards as they stood BEFORE this pair was added, the whole file was GREEN:
 *     ℹ pass 4
 *     ℹ fail 0
 *   …while the two spellings resolved to DIFFERENT replay layouts. OBSERVED VERBATIM now:
 *     ✖ the alias agrees with the namespaced spelling PAST the parser, where an injected flag would show
 *       AssertionError [ERR_ASSERTION]: same stderr, byte for byte, all the way through the handler
 *       + actual - expected
 *
 *       + '[loombridge trace] nothing to approve: no replay run in reports/.\n' +
 *       - '[loombridge trace] nothing to approve: no replay run in .loombridge/run/replays/reports/.\n' +
 *     ✖ the dispatcher forwards the promoted verbs as EXACTLY `[verb, ...rest]`, nothing else
 *       AssertionError [ERR_ASSERTION]: a promoted verb forwards its own subcommand token and the
 *       operator's argv, and nothing in between
 *       + actual - expected
 *
 *         [
 *       +   '"approve", "--flat", ...rest',
 *       -   '"approve", ...rest',
 *           '"record", ...rest'
 *         ]
 *
 * BREAK 5: the same injection on `record`, which has no editor-free handler probe, so the
 * SOURCE guard is the only thing that can see it. `surfaces/cli.ts`:
 *     -      return run(["record", ...rest]);
 *     +      return run(["record", "--flat", ...rest]);
 *   OBSERVED VERBATIM (one failure, and it is the source guard):
 *     ✖ the dispatcher forwards the promoted verbs as EXACTLY `[verb, ...rest]`, nothing else
 *       + actual - expected
 *
 *         [
 *           '"approve", ...rest',
 *       +   '"record", "--flat", ...rest'
 *       -   '"record", ...rest'
 *         ]
 *
 * BREAK 6: detect the feel candidate by directory again, the `nonEmptyDir` shape.
 * `approvable-alternatives.ts`:
 *     -      if (await hasAll(candidateDir, [SNAPSHOT_MEASUREMENTS_FILE, SNAPSHOT_CONTRACT_FILE])) {
 *     +      if ((await fs.readdir(candidateDir).catch(() => [])).length > 0) {
 *   OBSERVED VERBATIM:
 *     ✖ the alternatives detector names an artifact only when the ARTIFACT is there, not a directory
 *       AssertionError [ERR_ASSERTION]: a non-empty directory is not a staged candidate
 *       + actual - expected
 *
 *       + [
 *       +   {
 *       +     command: 'loombridge feel snapshot approve',
 *       +     what: 'a staged tuning-snapshot candidate (the measured-behavior lockfile)',
 *       +     where: '/var/folders/…/T/loombridge-human-acts-8RHB9a/feel/snapshots/candidate'
 *       +   }
 *   (the directory held one `.DS_Store`.)
 *
 * BREAK 7: swallow the failed detector and hard-code the claim again.
 * `approvable-alternatives.ts`: drop `checked.push(DESIGN_TARGET_DETECTOR)` and the
 * `unchecked.push` in its catch, and restore the literal
 * `"(checked: the Design Target hero shot, a staged feel-snapshot candidate)"`.
 *   OBSERVED VERBATIM:
 *     ✖ a detector that could NOT look is reported as unchecked, never counted as `checked`
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *       + actual - expected
 *
 *       + []
 *       - [
 *       -   'the Design Target hero shot'
 *       - ]
 */
