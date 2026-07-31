/**
 * `loombridge reopen <sliceId>`: the sanctioned way to send a settled slice back to
 * `stale` (ledger backlog item 3; the E6 runbook gap where staleness was a hand edit to
 * SLICES.json).
 *
 * The verb is driven through `loombridgeCli` rather than its `run` export, because HALF
 * the deliverable is that it is a TOP-LEVEL verb routed before any engine resolution: a
 * test that called the module directly would pass with the switch case missing.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../../../../surfaces/cli.js";
import { ensureScaffold, loombridgePaths } from "../../../../domain/state.js";
import {
  readSlicePlan,
  writeSlicePlan,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";
// Depth-independent: never count `..` to find a root (CLAUDE.md).
import { PKG_ROOT } from "../../../_support/paths.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-reopen-"));
}

/** Run the CLI verb, capturing stdout and stderr separately. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void outLines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  try {
    const code = await loombridgeCli(["node", "cli.js", ...argv]);
    return { code, out: outLines.join("\n"), err: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/**
 * THE TIDERUNNER-SHAPED DAG: the shipped 9-slice platformer roadmap, the exact graph the
 * dogfood run walked (framing -> ground-tiling -> player-feel -> {collectibles, hazards,
 * hud} -> …). Read from the source tree so the fixture cannot drift from the template.
 */
async function tiderunnerShapedPlan(): Promise<SlicePlan> {
  const raw = await fs.readFile(
    path.join(PKG_ROOT, "src/capabilities/genre/genre-packs/platformer-2d/slices.json"),
    "utf-8",
  );
  const plan = JSON.parse(raw) as SlicePlan;
  for (const slice of plan.slices) {
    slice.state = "approved";
    slice.proof = {
      runId: `run-${slice.id}-1`,
      startedAt: "2026-07-30T00:00:00.000Z",
      verdictPath: `.loombridge/reports/slices/${slice.id}.verdict.json`,
      captureManifest: [`${slice.id}/console.json`],
      checkpointId: slice.id,
      approvedAt: "2026-07-30T01:00:00.000Z",
      approvalNote: "hero shot matched",
      signoffSha256: "b".repeat(64),
    };
  }
  return plan;
}

async function seed(root: string, plan: SlicePlan): Promise<void> {
  const paths = loombridgePaths(root);
  await ensureScaffold(paths);
  await writeSlicePlan(paths, plan);
}

test("reopen: unknown slice is REFUSED (exit 2) and names the known ids", async () => {
  const root = await tmpRoot();
  try {
    await seed(root, await tiderunnerShapedPlan());
    const { code, err } = await capture(["reopen", "no-such-slice", "--root", root]);
    assert.equal(code, 2);
    assert.match(err, /unknown slice "no-such-slice"/);
    assert.match(err, /Known ids: framing, ground-tiling/);
    // Nothing was written: a refusal must not half-apply.
    const after = (await readSlicePlan(loombridgePaths(root)))!;
    assert.ok(after.slices.every((s) => s.state === "approved"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen: a slice that is already stale or still pending STATES that there is nothing to do", async () => {
  // "Nothing happened" and "it worked" must not print the same, and neither may be
  // silent: this is the case where an operator would otherwise assume a reopen landed.
  for (const state of ["stale", "pending"] as const) {
    const root = await tmpRoot();
    try {
      const plan = await tiderunnerShapedPlan();
      plan.slices[0]!.state = state;
      await seed(root, plan);
      const before = await fs.readFile(loombridgePaths(root).slices, "utf-8");

      const { code, err } = await capture(["reopen", "framing", "--root", root]);
      assert.equal(code, 0, "nothing to do is not an error");
      assert.match(err, new RegExp(`nothing to reopen: framing is ${state}`));
      assert.equal(
        await fs.readFile(loombridgePaths(root).slices, "utf-8"),
        before,
        "SLICES.json must be byte-identical when there was nothing to do",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("reopen: no SLICES.json is a refusal (exit 2), not a silent no-op", async () => {
  const root = await tmpRoot();
  try {
    await ensureScaffold(loombridgePaths(root));
    const { code, err } = await capture(["reopen", "framing", "--root", root]);
    assert.equal(code, 2);
    assert.match(err, /no .*SLICES\.json/);
    assert.match(err, /loombridge plan/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen: usage: a missing or extra slice id is a usage refusal (exit 2)", async () => {
  const root = await tmpRoot();
  try {
    await seed(root, await tiderunnerShapedPlan());
    assert.equal((await capture(["reopen", "--root", root])).code, 2);
    assert.equal((await capture(["reopen", "framing", "hazards", "--root", root])).code, 2);
    assert.equal((await capture(["reopen", "framing", "--nope", "--root", root])).code, 2);
    // …and --help is a plain success that prints to stdout.
    const help = await capture(["reopen", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: loombridge reopen <sliceId>/);
    assert.match(help.out, /CLEARS its approval artifacts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen: the CASCADE on the TideRunner-shaped DAG: every touched slice, prior state, chain", async () => {
  const root = await tmpRoot();
  try {
    const plan = await tiderunnerShapedPlan();
    plan.slices.find((s) => s.id === "hazards")!.state = "built"; // mid-flight when the reopen lands
    await seed(root, plan);

    const { code, err } = await capture(["reopen", "ground-tiling", "--root", root]);
    assert.equal(code, 0);

    // Everything downstream of ground-tiling, and NOTHING upstream of it.
    const expectedStale = [
      "ground-tiling",
      "player-feel",
      "collectibles",
      "hazards",
      "hud",
      "juice",
      "end-state",
    ];
    const after = (await readSlicePlan(loombridgePaths(root)))!;
    const byId = new Map(after.slices.map((s) => [s.id, s]));
    for (const id of expectedStale) assert.equal(byId.get(id)!.state, "stale", `${id} must be stale`);
    assert.equal(byId.get("framing")!.state, "approved", "an upstream slice is untouched");
    assert.equal(byId.get("parallax")!.state, "approved", "a sibling branch is untouched");

    // EVERY touched slice is printed with the state it held before.
    for (const id of expectedStale) {
      assert.match(err, new RegExp(`${id}: (approved|built) -> stale`), `${id} must be reported`);
    }
    // A `built` slice loses in-flight work, and the report says so rather than leaving it
    // to be discovered at the next verify.
    assert.match(err, /hazards: built -> stale \(cascade\).*IN-FLIGHT WORK LOST/);
    // The re-verify chain is in DAG order: dependencies before dependents.
    assert.match(
      err,
      /re-verify chain \(dependencies first\): ground-tiling -> player-feel -> collectibles -> hazards -> hud -> juice -> end-state/,
    );
    assert.match(err, /recorded history\{action:reopen, cascade:\[player-feel, collectibles, hazards, hud, juice, end-state\]\}/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen: CLEARS the approval artifacts on every slice it staled", async () => {
  // The re-approval shortcut this closes: a slice can read `stale` while still carrying
  // `checkpointId` + `approvedAt` + the sign-off pair, which are exactly what the approval
  // seam and `isSliceDone` read to conclude it was already signed off.
  const root = await tmpRoot();
  try {
    await seed(root, await tiderunnerShapedPlan());
    const { code } = await capture(["reopen", "player-feel", "--root", root]);
    assert.equal(code, 0);

    const after = (await readSlicePlan(loombridgePaths(root)))!;
    for (const slice of after.slices.filter((s) => s.state === "stale")) {
      const proof = slice.proof!;
      assert.equal(proof.checkpointId, undefined, `${slice.id}.checkpointId`);
      assert.equal(proof.approvedAt, undefined, `${slice.id}.approvedAt`);
      assert.equal(proof.approvalNote, undefined, `${slice.id}.approvalNote`);
      assert.equal(proof.signoffSha256, undefined, `${slice.id}.signoffSha256`);
      // The build identity survives: a reopen withdraws an approval, it does not
      // pretend the previous build never happened.
      assert.equal(proof.runId, `run-${slice.id}-1`);
    }
    // Untouched slices keep theirs.
    const framing = after.slices.find((s) => s.id === "framing")!;
    assert.equal(framing.proof?.checkpointId, "framing");
    assert.equal(framing.proof?.approvedAt, "2026-07-30T01:00:00.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reopen: the written SLICES.json validates, and history survives a read/write round trip", async () => {
  const root = await tmpRoot();
  try {
    await seed(root, await tiderunnerShapedPlan());
    assert.equal((await capture(["reopen", "framing", "--root", root])).code, 0);
    // readSlicePlan re-validates on the way in: a history entry the validator refused
    // would make this throw rather than return.
    const after = (await readSlicePlan(loombridgePaths(root)))!;
    const framing = after.slices.find((s) => s.id === "framing")!;
    assert.equal(framing.history?.length, 1);
    assert.equal(framing.history![0]!.action, "reopen");
    assert.ok(framing.history![0]!.at.length > 0);
    assert.deepEqual(framing.history![0]!.cascade, [
      "ground-tiling",
      "player-feel",
      "parallax",
      "collectibles",
      "hazards",
      "hud",
      "juice",
      "end-state",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
