/**
 * No shipped surface may INSTRUCT a user to run a command that is guaranteed to exit 2.
 *
 * `loombridge plan` now REFUSES to guess the genre. That is correct: a guessed genre seeds that
 * genre's whole contract and still claims `graded`, but it made bare `loombridge plan` an exit-2
 * usage error in exactly the state several shipped surfaces recommended it in:
 *
 *  - the consumer template's two READMEs, whose quickstart block was `loombridge plan`;
 *  - `loombridge_status`'s `nextStep`, returned for the NO-CONTRACT state, which is precisely the
 *    state with no STATE.genre to fall back on;
 *  - the `verify-2d-game` skill's "if none exists, run `loombridge plan` first".
 *
 * SCOPE, and why it is not repo-wide. Plenty of other refusals point at `loombridge plan` (verify's
 * "no SLICES.json", build's "nothing to build toward", reopen's). Those all fire on a project that
 * ALREADY has a genre in STATE.md, where a bare re-plan is the right answer and needs no flag. The
 * surfaces below are the ones that fire when there is no contract and no state at all, so they are
 * the ones where the recommendation cannot work. The list is explicit for that reason, and each
 * entry is resolved from disk so a moved file fails here rather than silently dropping out.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";
import { buildLoombridgeStatusPayload } from "../../../surfaces/loombridge-bridge-tools.js";
import { run as runPlanCli } from "../../../capabilities/verification/plan.js";

/** The consumer-facing prose that fires in the no-contract state. */
const SURFACES = [
  "templates/create-loombridge-game/README.md",
  "templates/create-loombridge-game/.loombridge/README.md",
  ".skills/verify-2d-game/SKILL.md",
];

/**
 * Every place a document INSTRUCTS the reader to run `loombridge plan` with no argument: a bare
 * command line inside a fenced block, or a "run `loombridge plan`" imperative in prose.
 *
 * Descriptive prose ("`loombridge plan` populates it") is deliberately NOT flagged: it is a
 * statement about the verb, not a command to type. Shared with the litmus so the extractor cannot be
 * tuned into finding nothing.
 */
export function barePlanInstructions(text: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const command = raw.replace(/#.*$/, "").trim();
      if (/^loombridge plan$/.test(command)) found.push(raw.trim());
      continue;
    }
    for (const m of raw.matchAll(/\b[Rr]un `loombridge plan`/g)) found.push(m[0]);
  }
  return found;
}

test("no shipped consumer surface tells a user to run bare `loombridge plan`", () => {
  const offenders: string[] = [];
  for (const rel of SURFACES) {
    const file = path.join(REPO_ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing: this guard is walking a path that moved`);
    for (const hit of barePlanInstructions(fs.readFileSync(file, "utf-8"))) {
      offenders.push(`${rel}: ${hit}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these surfaces instruct a command that exits 2 (plan refuses to guess the genre):\n${offenders.join("\n")}`,
  );
});

test("`loombridge_status.nextStep` on a project with no contract is a command that can actually run", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-nextstep-"));
  try {
    await fsp.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.0f1\n",
      "utf-8",
    );

    // THE BINDING that makes the assertion below mean something: prove bare `plan` really does
    // refuse here, rather than trusting the premise.
    const orig = console.error;
    console.error = () => {};
    let bareCode: number;
    try {
      bareCode = await runPlanCli(["--root", root]);
    } finally {
      console.error = orig;
    }
    assert.equal(bareCode, 2, "premise: bare `plan` must refuse in the no-contract state");

    const payload = await buildLoombridgeStatusPayload(root);
    assert.equal(payload.contractExists, false, "fixture must be in the no-contract state");
    assert.notEqual(payload.nextStep, "loombridge plan", "nextStep must not be the command that just exited 2");
    assert.match(payload.nextStep, /--genre/, "nextStep must supply the argument `plan` refuses to guess");
    assert.match(payload.summary, /genre init/, "the summary must name the route for a genre with no pack");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("LITMUS: the extractor finds both instruction shapes and ignores descriptive prose", () => {
  // A doc guard that extracts nothing passes forever. Prove each shape it is written for, and prove
  // the two shapes it must NOT flag.
  const fenced = ["```bash", "loombridge plan          # scaffolds it", "```"].join("\n");
  assert.deepEqual(barePlanInstructions(fenced), ["loombridge plan          # scaffolds it"]);
  assert.deepEqual(barePlanInstructions("If none exists, run `loombridge plan` first."), ["run `loombridge plan`"]);

  assert.deepEqual(
    barePlanInstructions(["```bash", "loombridge plan --genre platformer-2d", "```"].join("\n")),
    [],
    "a command that supplies the genre is fine",
  );
  assert.deepEqual(
    barePlanInstructions("the skeleton `loombridge plan` populates"),
    [],
    "descriptive prose is a statement about the verb, not an instruction",
  );
});
