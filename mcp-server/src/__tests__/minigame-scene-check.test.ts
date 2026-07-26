/**
 * Scene-agnostic `check` driver (Phase 1 front door). The MOAT-critical logic: record → build → write →
 * pipeline, with can't-verify scenes DOMINATING the exit code — a partial verification is never a full
 * green. IO-injected, fake deps.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runSceneAgnosticCheck, EXIT, type SceneAgnosticCheckDeps } from "../capabilities/minigame/minigame-scene-check.js";
import type { BuildContractResult } from "../capabilities/minigame/minigame-scene-build.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";

const trace = { start: { scene: "Assets/Scenes/Home.unity", reset: "scene-load" as const }, segments: [] };
const contract = { id: "g" } as unknown as MinigameContract;
const okBuild = (cantVerify: { sceneName: string; reason: string }[] = []): BuildContractResult => ({ ok: true, contract, cantVerify, multiScene: true });

function deps(over: Partial<SceneAgnosticCheckDeps> = {}): { deps: SceneAgnosticCheckDeps; calls: string[]; logs: string[] } {
  const calls: string[] = [];
  const logs: string[] = [];
  const d: SceneAgnosticCheckDeps = {
    record: async () => { calls.push("record"); return trace; },
    build: async () => { calls.push("build"); return okBuild(); },
    writeContract: async () => { calls.push("write"); },
    runPipeline: async () => { calls.push("pipeline"); return EXIT.READY; },
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps: d, calls, logs };
}

test("check: happy path — record → build → write → pipeline, returns the pipeline verdict (READY)", async () => {
  const { deps: d, calls } = deps();
  assert.equal(await runSceneAgnosticCheck(d), EXIT.READY);
  assert.deepEqual(calls, ["record", "build", "write", "pipeline"]);
});

test("check: a NOT-READY pipeline verdict is returned as-is (exit 1)", async () => {
  const { deps: d } = deps({ runPipeline: async () => EXIT.NOT_READY });
  assert.equal(await runSceneAgnosticCheck(d), EXIT.NOT_READY);
});

test("check: a recording failure is can't-verify (exit 2), never reaches build/pipeline", async () => {
  const { deps: d, calls } = deps({ record: async () => ({ error: "observation died" }) });
  assert.equal(await runSceneAgnosticCheck(d), EXIT.CANT_VERIFY);
  assert.deepEqual(calls, [], "no build/write/pipeline after a failed record");
});

test("check: a build refusal (collision / nothing verifiable) is exit 2, never writes or runs the pipeline", async () => {
  const { deps: d, calls, logs } = deps({
    build: async () => ({ ok: false, error: "can't verify: two scenes share a capture namespace", cantVerify: [{ sceneName: "A", reason: "shares slug" }] }),
  });
  assert.equal(await runSceneAgnosticCheck(d), EXIT.CANT_VERIFY);
  assert.ok(!calls.includes("write") && !calls.includes("pipeline"), "no write/pipeline on a build refusal");
  assert.ok(logs.some((l) => /A: shares slug/.test(l)), "the can't-verify scene is named");
});

test("check: can't-verify scenes DOMINATE a green pipeline — a partial build is exit 2, not READY (the MOAT)", async () => {
  const { deps: d, calls, logs } = deps({
    build: async () => okBuild([{ sceneName: "Stir", reason: "no sampled phase signal" }]),
    runPipeline: async () => EXIT.READY, // the gradeable scenes pass…
  });
  // …but a scene couldn't be graded, so the build as a whole is can't-verify.
  assert.equal(await runSceneAgnosticCheck(d), EXIT.CANT_VERIFY);
  assert.ok(calls.includes("write"), "the contract is still written");
  // The pipeline STILL runs (grades the verifiable scenes) — proven by the verdict log echoing its exit code.
  assert.ok(logs.some((l) => /reported exit 0/.test(l)), "the verifiable scenes were graded by the pipeline");
  assert.ok(logs.some((l) => /Can't verify this build/.test(l)));
  assert.ok(logs.some((l) => /Stir.*no sampled phase signal/.test(l)));
});

test("check: can't-verify scenes dominate even a NOT-READY pipeline (still exit 2, the worst-but-honest verdict)", async () => {
  const { deps: d } = deps({
    build: async () => okBuild([{ sceneName: "Stir", reason: "x" }]),
    runPipeline: async () => EXIT.NOT_READY,
  });
  // can't-verify (2) is the honest verdict: we can't claim NOT-READY for the whole build when part was ungradeable.
  assert.equal(await runSceneAgnosticCheck(d), EXIT.CANT_VERIFY);
});

test("check: no can't-verify scenes ⇒ the pipeline verdict passes through unchanged", async () => {
  for (const code of [EXIT.READY, EXIT.NOT_READY]) {
    const { deps: d } = deps({ build: async () => okBuild([]), runPipeline: async () => code });
    assert.equal(await runSceneAgnosticCheck(d), code);
  }
});
