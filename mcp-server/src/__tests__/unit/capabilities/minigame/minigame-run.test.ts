/**
 * `loombridge minigame run` — the one-command pipeline runner. The orchestration core
 * (`driveRun`) is IO-injected, so the progression, the two human stop gates (NOT READY /
 * READY→baseline), the error-stop, and the no-progress backstop are exercised here with a
 * FAKE workspace + fake step runner — no disk, no subprocesses. `stepArgv` is pinned against
 * the resolver's intent so the executable argv never drifts from `minigame next`'s display.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { driveRun, runRun, stepArgv, type RunDeps } from "../../../../capabilities/minigame/minigame-run.js";
import type { WorkspaceFacts } from "../../../../capabilities/minigame/minigame-next.js";

/** A fully-defaulted facts object; override per test to place the workspace in the flow. */
function facts(over: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    id: "g",
    scene: "Assets/Scenes/G.unity",
    workspace: "/ws/g",
    traceRecorded: false,
    capturesPresent: false,
    contractFinalized: false,
    verify: null,
    baselineApproved: false,
    backgroundRecommended: false,
    backgroundCandidatesStale: false,
    ...over,
  };
}

/**
 * A fake workspace that advances through the pipeline as steps "run": each executed step flips
 * the fact that unblocks the next one, exactly as the real disk would. `verifyTo` decides the
 * verdict the verify step writes.
 */
function fakeDeps(opts: { verifyTo: "NOT READY" | "READY"; failAt?: string } = { verifyTo: "READY" }): {
  deps: RunDeps;
  ran: Array<{ at: string; argv: string[] }>;
  logs: string[];
} {
  const ran: Array<{ at: string; argv: string[] }> = [];
  const logs: string[] = [];
  const state = facts();
  const deps: RunDeps = {
    inspect: async () => state,
    runStep: async (at, argv) => {
      ran.push({ at, argv });
      if (opts.failAt === at) return 3; // simulate a hard step failure
      if (at === "record") state.traceRecorded = true;
      else if (at === "capture") state.capturesPresent = true;
      else if (at === "finalize") state.contractFinalized = true;
      else if (at === "verify") state.verify = { status: opts.verifyTo, stale: false };
      return at === "verify" && opts.verifyTo === "NOT READY" ? 1 : 0; // --strict exits 1 on NOT READY
    },
    log: (l) => logs.push(l),
  };
  return { deps, ran, logs };
}

test("driveRun: full happy path → record→capture→finalize→verify, then STOP at the baseline gate (exit 0)", async () => {
  const { deps, ran, logs } = fakeDeps({ verifyTo: "READY" });
  const code = await driveRun(deps);
  assert.equal(code, 0);
  assert.deepEqual(ran.map((r) => r.at), ["record", "capture", "finalize", "verify"]);
  // Stops at the verdict — it does NOT auto-run baseline approve (human sign-off).
  assert.ok(logs.some((l) => /Ready to ship.*approve the baseline/i.test(l)), logs.join("\n"));
  assert.ok(!ran.some((r) => r.at === "baseline"));
});

test("runRun (Phase 0): a non-asset-path --record-scene is rejected (exit 2) before any IO", async () => {
  assert.equal(await runRun(["--id", "g", "--record-scene", "NotAScene"]), 2);
  assert.equal(await runRun(["--id", "g", "--record-scene", "../escape.unity"]), 2);
});

test("driveRun (Phase 0): opts.recordScene threads to the record step ONLY (capture/verify unaffected)", async () => {
  const { deps, ran } = fakeDeps({ verifyTo: "READY" });
  await driveRun(deps, { recordScene: "Assets/Scenes/Home.unity" });
  const record = ran.find((r) => r.at === "record")!;
  assert.equal(record.argv[record.argv.indexOf("--scene") + 1], "Assets/Scenes/Home.unity");
  // capture/verify carry no scene arg → recordScene can't leak into them.
  assert.ok(!ran.find((r) => r.at === "capture")!.argv.includes("Assets/Scenes/Home.unity"));
});

test("driveRun: NOT READY → runs through verify, then STOPS at fix (exit 1), never reaching baseline", async () => {
  const { deps, ran, logs } = fakeDeps({ verifyTo: "NOT READY" });
  const code = await driveRun(deps);
  assert.equal(code, 1);
  assert.deepEqual(ran.map((r) => r.at), ["record", "capture", "finalize", "verify"]);
  assert.ok(logs.some((l) => /not ready/i.test(l)), logs.join("\n"));
});

test("driveRun: a hard step failure (non-verify) stops immediately with that exit code", async () => {
  const { deps, ran, logs } = fakeDeps({ verifyTo: "READY", failAt: "capture" });
  const code = await driveRun(deps);
  assert.equal(code, 3);
  // record then the failing capture — never reaches finalize/verify.
  assert.deepEqual(ran.map((r) => r.at), ["record", "capture"]);
  assert.ok(logs.some((l) => /'capture' exited 3/.test(l)), logs.join("\n"));
});

test("driveRun: verify's non-zero (NOT READY under --strict) is a verdict, not a stop — it re-inspects", async () => {
  // Distinct from a hard failure: verify returns 1 but the loop continues to read the verdict.
  const { deps, ran } = fakeDeps({ verifyTo: "NOT READY" });
  const code = await driveRun(deps);
  assert.equal(code, 1);
  assert.ok(ran.some((r) => r.at === "verify"), "verify still ran");
});

test("driveRun: resumes mid-flow — an already-captured+finalized workspace goes straight to verify", async () => {
  const state = facts({ traceRecorded: true, capturesPresent: true, contractFinalized: true });
  const ran: string[] = [];
  const code = await driveRun({
    inspect: async () => state,
    runStep: async (at) => {
      ran.push(at);
      if (at === "verify") state.verify = { status: "READY", stale: false };
      return 0;
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, ["verify"], "skips the already-done steps");
});

test("driveRun: a workspace that can't be read → exit 2", async () => {
  const code = await driveRun({
    inspect: async () => ({ error: "no <id>.minigame.json found" }),
    runStep: async () => 0,
    log: () => {},
  });
  assert.equal(code, 2);
});

test("driveRun: no-progress backstop — a step that doesn't advance the workspace stops (no infinite loop)", async () => {
  // capture "succeeds" but never sets capturesPresent → the resolver keeps returning capture.
  const state = facts({ traceRecorded: true });
  const code = await driveRun({
    inspect: async () => state,
    runStep: async () => 0, // never advances state
    log: () => {},
  });
  assert.equal(code, 1);
});

test("stepArgv: each executable step's argv matches the resolver's intent (absolute paths)", () => {
  const f = facts({ workspace: "/ws/g", id: "g", scene: "Assets/Scenes/G.unity" });
  assert.deepEqual(stepArgv("record", f), [
    "trace", "record", "--observe", "--flat", "--id", "g-happy-path", "--scene", "Assets/Scenes/G.unity", "--root", "/ws/g",
  ]);
  assert.deepEqual(stepArgv("capture", f), [
    "minigame", "capture", "--contract", "/ws/g/g.minigame.json", "--trace-root", "/ws/g", "--captures", "/ws/g/captures",
  ]);
  assert.deepEqual(stepArgv("finalize", f), [
    "minigame", "finalize", "--contract", "/ws/g/g.minigame.json", "--captures", "/ws/g/captures", "--trace-root", "/ws/g",
  ]);
  assert.deepEqual(stepArgv("verify", f), [
    "verify", "--minigame", "--contract", "/ws/g/g.minigame.json", "--captures", "/ws/g/captures",
    "--output", "/ws/g/reports/minigame-verification.json", "--strict", "--quiet-next",
  ]);
});

test("stepArgv (Phase 0): --record-scene resets the RECORD to a different scene than the scanned contract scene", () => {
  const f = facts({ workspace: "/ws/g", id: "g", scene: "Assets/Scenes/StarChef.unity" });
  // Default: record resets to the contract scene.
  assert.deepEqual(stepArgv("record", f).slice(0, 9), ["trace", "record", "--observe", "--flat", "--id", "g-happy-path", "--scene", "Assets/Scenes/StarChef.unity", "--root"]);
  // With recordScene: record resets to HOME, but the contract/capture scene is untouched (still StarChef).
  const rec = stepArgv("record", f, { recordScene: "Assets/Scenes/Home.unity" });
  assert.equal(rec[rec.indexOf("--scene") + 1], "Assets/Scenes/Home.unity");
  assert.deepEqual(stepArgv("capture", f, { recordScene: "Assets/Scenes/Home.unity" }), [
    "minigame", "capture", "--contract", "/ws/g/g.minigame.json", "--trace-root", "/ws/g", "--captures", "/ws/g/captures",
  ]); // recordScene affects ONLY the record step
});

test("stepArgv: the record step threads --state-signal when the contract declares/auto-detected one", () => {
  // Without a stateSignal → no flag (covered above). With one → the chained record phase-aligns the
  // gestures exactly like the `minigame next` record command does.
  const withSig = facts({ workspace: "/ws/g", id: "g", scene: "Assets/Scenes/G.unity", stateSignal: { locator: "/Canvas/GM", component: "GM", property: "phase" } });
  assert.deepEqual(stepArgv("record", withSig), [
    "trace", "record", "--observe", "--flat", "--id", "g-happy-path", "--scene", "Assets/Scenes/G.unity", "--root", "/ws/g",
    "--state-signal", "/Canvas/GM:GM:phase",
  ]);
  // component absent → empty middle field (path::property), still a valid 3-part flag.
  const noComp = facts({ workspace: "/ws/g", id: "g", scene: "Assets/Scenes/G.unity", stateSignal: { locator: "/Canvas/GM", property: "phase" } });
  assert.ok(stepArgv("record", noComp).join(" ").endsWith("--state-signal /Canvas/GM::phase"));
});

test("stepArgv: finalize folds in --background auto only when capture recommended a binding", () => {
  const f = facts({ backgroundRecommended: true });
  assert.ok(stepArgv("finalize", f).join(" ").endsWith("--background auto"), "background binding folded into finalize");
  assert.ok(!stepArgv("finalize", facts({ backgroundRecommended: false })).includes("--background"));
});
