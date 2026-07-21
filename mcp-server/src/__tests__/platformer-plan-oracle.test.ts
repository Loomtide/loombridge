import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runPlan } from "../loomtide/plan.js";
import { loomtidePaths } from "../loomtide/state.js";

/**
 * Platformer REGRESSION ORACLE (slice-2 of genre-pack decoupling). Freezes the deterministic platformer
 * plan output end-to-end: a real `runPlan --genre platformer-2d` must seed BYTE-for-BYTE the committed
 * golden acceptance contract. Because plan now resolves its template + bindings entirely through the
 * genre registry (after the relocation + dispatch slice), this is the safety net that any future
 * genre-registry refactor leaves platformer behavior unchanged — a drift in template resolution,
 * relocation, or the seeding transform fails here loudly.
 *
 * The ONLY normalized field is `game` (seeded from the random temp-dir basename). To intentionally
 * change platformer planning, regenerate the golden:
 *   node -e 'see header of platformer-2d.planned-acceptance.json generation in this test'
 * and review the diff — that review surfacing is the point.
 */

const GOLDEN_GAME = "GOLDEN_GAME";
const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "__tests__",
  "fixtures",
  "golden",
  "platformer-2d.planned-acceptance.json",
);

async function seededPlatformerAcceptance(): Promise<unknown> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-oracle-"));
  try {
    const code = await runPlan({
      root,
      genre: "platformer-2d",
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 0, "runPlan --genre platformer-2d must succeed");
    const contract = JSON.parse(await fs.readFile(loomtidePaths(root).acceptance, "utf-8"));
    // `game` is the only run-varying field (random temp basename) — normalize it for a stable snapshot.
    contract.game = GOLDEN_GAME;
    return contract;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("ORACLE: platformer plan seeds the frozen golden acceptance contract (byte-stable)", async () => {
  const actual = await seededPlatformerAcceptance();
  const golden = JSON.parse(await fs.readFile(GOLDEN_PATH, "utf-8"));
  assert.deepEqual(
    actual,
    golden,
    "platformer plan output drifted from the golden — if intentional, regenerate the golden fixture and review the diff",
  );
});
