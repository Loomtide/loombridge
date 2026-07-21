/**
 * Persistent verification-config overrides (`minigame-overrides`) — the sidecar that survives a
 * record-first `check` regeneration so a declared `safeAreaBackground` (etc.) isn't wiped every run.
 * The merge (`applyContractOverrides`) is pure; the sidecar IO is exercised with a temp dir.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyContractOverrides,
  loadOverrides,
  mergeIntoOverrides,
  overridesPath,
} from "../loomtide/minigame-overrides.js";
import { validateMinigameContract } from "../loomtide/minigame-profiles/validator.js";
import type { MinigameContract } from "../loomtide/minigame-profiles/types.js";

function validContract(over: Partial<MinigameContract> = {}): MinigameContract {
  return {
    schemaVersion: "1",
    id: "g",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/G.unity"],
    ageBand: "5-7",
    visualProfile: "phone-landscape",
    states: [
      { id: "active", kind: "active", scene: "G", requiredInFrame: ["playButton"], description: "active screen." },
      { id: "success_reward", kind: "success_reward", scene: "G", requiredInFrame: ["playButton"], description: "success_reward screen." },
    ],
    requiredInFrame: [{ id: "playButton", locator: "G:/Canvas/Play", description: "Inferred." }],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["active", "success_reward"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame"] },
    ...over,
  } as MinigameContract;
}

test("validContract fixture is actually valid (guards the other tests)", () => {
  assert.equal(validateMinigameContract(validContract()).valid, true);
});

test("applyContractOverrides: null/absent overrides → contract untouched", () => {
  const c = validContract();
  const { contract, dropped } = applyContractOverrides(c, null);
  assert.equal(contract, c);
  assert.deepEqual(dropped, []);
});

test("applyContractOverrides: safeAreaBackground UNIONS with the contract's and minimal-folds (child under parent dropped)", () => {
  const c = validContract({ safeAreaBackground: ["/Canvas/Existing"] });
  const { contract, dropped } = applyContractOverrides(c, { safeAreaBackground: ["/Canvas/Sky", "/Canvas/Sky/Cloud1", "/Canvas/Sparkle*"] });
  assert.deepEqual(dropped, []);
  // /Canvas/Sky/Cloud1 is folded away (covered by /Canvas/Sky); existing + new are unioned + sorted.
  assert.deepEqual(contract.safeAreaBackground, ["/Canvas/Existing", "/Canvas/Sky", "/Canvas/Sparkle*"]);
});

test("applyContractOverrides: safeAreaExempt unions (ids/paths, no fold)", () => {
  const { contract } = applyContractOverrides(validContract(), { safeAreaExempt: ["b", "a", "a"] });
  assert.deepEqual(contract.safeAreaExempt, ["a", "b"]);
});

test("applyContractOverrides: uiSafeAreas.insets is set (merged into the existing safe-areas)", () => {
  const { contract, dropped } = applyContractOverrides(validContract(), { uiSafeAreas: { insets: { top: 0.05, bottom: 0.05 } } });
  assert.deepEqual(dropped, []);
  assert.deepEqual(contract.uiSafeAreas, { maxOverflowFraction: 0, insets: { top: 0.05, bottom: 0.05 } });
});

test("applyContractOverrides: an invalid override field is DROPPED (named) while the rest still apply", () => {
  // insets.top must be in [0,1); 1.5 is invalid → that field drops, safeAreaBackground still applies.
  const { contract, applied, dropped } = applyContractOverrides(validContract(), {
    safeAreaBackground: ["/Canvas/Sky"],
    uiSafeAreas: { insets: { top: 1.5 } },
  });
  assert.deepEqual(dropped, ["uiSafeAreas"]);
  assert.deepEqual(applied, ["safeAreaBackground"]);
  assert.deepEqual(contract.safeAreaBackground, ["/Canvas/Sky"]);
  assert.equal(contract.uiSafeAreas.insets, undefined, "the bad insets override was not applied");
  assert.equal(validateMinigameContract(contract).valid, true, "result is always valid");
});

test("applyContractOverrides: an already-invalid base contract is returned untouched (overrides skipped, never misattributed)", () => {
  const bad = validContract({ uiSafeAreas: { maxOverflowFraction: 9 } }); // out of [0,1] → invalid base
  assert.equal(validateMinigameContract(bad).valid, false);
  const { contract, dropped } = applyContractOverrides(bad, { safeAreaBackground: ["/Canvas/Sky"] });
  assert.equal(contract, bad);
  assert.deepEqual(dropped, []);
});

test("loadOverrides: absent / malformed sidecar → null (a missing sidecar is the normal case, never an error)", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-ov-"));
  try {
    assert.equal(await loadOverrides(ws), null);
    await fs.writeFile(overridesPath(ws), "{ not json", "utf-8");
    assert.equal(await loadOverrides(ws), null);
    await fs.writeFile(overridesPath(ws), "[1,2,3]", "utf-8"); // valid JSON but not an object
    assert.equal(await loadOverrides(ws), null);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("mergeIntoOverrides: accumulates safeAreaBackground across calls (declarations build up, deduped + folded)", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-ov-"));
  try {
    await mergeIntoOverrides(ws, { safeAreaBackground: ["/Canvas/Sky"] });
    await mergeIntoOverrides(ws, { safeAreaBackground: ["/Canvas/Sparkle*", "/Canvas/Sky"] });
    const ov = await loadOverrides(ws);
    assert.deepEqual(ov?.safeAreaBackground, ["/Canvas/Sky", "/Canvas/Sparkle*"]);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("persistence guarantee: declare → sidecar → a fresh (regenerated) contract re-applies the SAME safeAreaBackground", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-ov-"));
  try {
    // The dev declares decoration (what declare-background persists).
    await mergeIntoOverrides(ws, { safeAreaBackground: ["/Canvas/Background", "/Canvas/Sparkle*"] });
    // A later `check` rebuilds a FRESH contract (no safeAreaBackground) and re-applies the sidecar.
    const fresh = validContract();
    assert.equal(fresh.safeAreaBackground, undefined);
    const { contract } = applyContractOverrides(fresh, await loadOverrides(ws));
    assert.deepEqual(contract.safeAreaBackground, ["/Canvas/Background", "/Canvas/Sparkle*"]);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
