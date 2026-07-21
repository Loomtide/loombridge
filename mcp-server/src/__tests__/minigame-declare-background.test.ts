/**
 * `loomtide minigame declare-background` — the report→contract loop closer.
 *
 * Guarantees under test:
 *   - merge + segment-safe minimal-fold (a container swallows its declared children; two unrelated
 *     elements stay two entries — the verb never invents a broader container than given);
 *   - the MOAT: a path that would exempt a bound control is REFUSED (declared background is gate-
 *     skipped silently, so declaring a control as background would silence it);
 *   - idempotent (re-declaring writes nothing);
 *   - the IO shell writes a VALID contract and leaves it untouched on refusal.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeDeclaration, runDeclareBackground } from "../loomtide/minigame-declare-background.js";

// ── pure core: computeDeclaration ──────────────────────────────────────────────

test("computeDeclaration: adds new paths, sorted; reports them as added; marks changed", () => {
  const out = computeDeclaration([], ["/Canvas/Sun", "/Canvas/Background"], []);
  assert.deepEqual(out.finalBackground, ["/Canvas/Background", "/Canvas/Sun"]);
  assert.deepEqual(out.added, ["/Canvas/Background", "/Canvas/Sun"]);
  assert.equal(out.changed, true);
  assert.deepEqual(out.refused, []);
});

test("computeDeclaration: minimal-fold — a container swallows its declared children", () => {
  const out = computeDeclaration([], ["/Canvas/Background", "/Canvas/Background/Cloud1", "/Canvas/Background/Cloud2"], []);
  assert.deepEqual(out.finalBackground, ["/Canvas/Background"], "the children fold under the container");
});

test("computeDeclaration: a trailing-* glob folds its bracketed siblings, but unrelated elements stay separate", () => {
  const out = computeDeclaration([], ["/Canvas/Sparkle*", "/Canvas/Sparkle[0]", "/Canvas/Sparkle[3]", "/Canvas/Sun"], []);
  assert.deepEqual(out.finalBackground.sort(), ["/Canvas/Sparkle*", "/Canvas/Sun"], "the glob folds the sparkles; Sun is unrelated");
});

test("computeDeclaration: NEVER widens — two sibling elements stay two entries, not their parent", () => {
  const out = computeDeclaration([], ["/Canvas/Deco/A", "/Canvas/Deco/B"], []);
  assert.deepEqual(out.finalBackground, ["/Canvas/Deco/A", "/Canvas/Deco/B"], "no invented /Canvas/Deco container");
});

test("computeDeclaration: refuses a path that would exempt a protected control; excludes it from the write", () => {
  const out = computeDeclaration([], ["/Canvas/Background", "/Canvas/HomeButton"], ["/Canvas/HomeButton"]);
  assert.deepEqual(out.refused, ["/Canvas/HomeButton"], "the bound control is refused");
  assert.deepEqual(out.finalBackground, ["/Canvas/Background"], "only the decoration is accepted");
});

test("computeDeclaration: refuses a CONTAINER that covers a protected control (can't declare-away a control via its parent)", () => {
  const out = computeDeclaration([], ["/Canvas/HUD"], ["/Canvas/HUD/HomeButton"]);
  assert.deepEqual(out.refused, ["/Canvas/HUD"]);
  assert.deepEqual(out.finalBackground, [], "nothing accepted — the container would have silenced the control");
});

test("computeDeclaration: idempotent — declaring what an existing entry already covers is a no-op", () => {
  const out = computeDeclaration(["/Canvas/Background"], ["/Canvas/Background/Cloud1"], []);
  assert.equal(out.changed, false, "the container already covers the child");
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.finalBackground, ["/Canvas/Background"]);
});

// ── IO shell: runDeclareBackground (temp copy of a real, valid contract) ─────────

// Compiled test lives in dist/__tests__; walk up to the repo root, then into src/ (same pattern as
// minigame-finalize.test.ts) so the fixture resolves whether run from dist or src.
const FIXTURE = path.resolve(
  import.meta.dirname,
  "../../..",
  "mcp-server/src/__tests__/fixtures/minigame-offscreen-negative/contract.minigame.json",
);
let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

async function tempContract(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "declare-bg-"));
  const dest = path.join(tmpDir, "game.minigame.json");
  await fs.copyFile(FIXTURE, dest);
  return dest;
}

test("runDeclareBackground: writes a valid contract, then a re-run is a no-op", async () => {
  const contract = await tempContract();
  const code1 = await runDeclareBackground(["--contract", contract, "--yes", "/Background/Sky"]);
  assert.equal(code1, 0, "first declare succeeds");
  const written = JSON.parse(await fs.readFile(contract, "utf-8")) as { safeAreaBackground?: string[] };
  assert.deepEqual(written.safeAreaBackground, ["/Background/Sky"], "the path is written");

  const code2 = await runDeclareBackground(["--contract", contract, "--yes", "/Background/Sky"]);
  assert.equal(code2, 0, "re-declaring the same path exits 0 (no-op)");
});

test("runDeclareBackground: prints the EXACT copy-pasteable verify command (contract + captures + output + --strict)", async () => {
  const contract = await tempContract();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    await runDeclareBackground(["--contract", contract, "--yes", "/Background/Sky"]);
  } finally {
    console.log = orig;
  }
  const out = logs.join("\n");
  // The next step must be a runnable command (contract/captures/output resolved next to the contract),
  // not a bare `loomtide verify --minigame` the dev has to fill in.
  assert.match(
    out,
    /loomtide verify --minigame --contract \S*game\.minigame\.json --captures \S*\/captures --output \S*\/reports\/minigame-verification\.json --strict/,
    "the exact verify command is printed for copy-paste",
  );
});

test("runDeclareBackground: ALSO persists the declaration to the workspace overrides sidecar (survives a record-first re-check)", async () => {
  const contract = await tempContract();
  const code = await runDeclareBackground(["--contract", contract, "--yes", "/Background/Sky", "/Canvas/Sparkle*"]);
  assert.equal(code, 0);
  // overrides.json sits next to the contract and carries the declared decoration, so the next
  // `minigame check` (which regenerates the contract) re-applies it instead of re-flagging it.
  const sidecar = JSON.parse(await fs.readFile(path.join(path.dirname(contract), "overrides.json"), "utf-8")) as { safeAreaBackground?: string[] };
  assert.deepEqual(sidecar.safeAreaBackground, ["/Background/Sky", "/Canvas/Sparkle*"]);
});

test("runDeclareBackground: REFUSES to declare a bound control, leaving the contract untouched (exit 1)", async () => {
  const contract = await tempContract();
  const before = await fs.readFile(contract, "utf-8");
  // TargetButton is requiredInFrame (Offscreen:/HUD/TargetButton) → declaring it as background is refused.
  const code = await runDeclareBackground(["--contract", contract, "--yes", "/HUD/TargetButton"]);
  assert.equal(code, 1, "declaring a bound control is refused");
  assert.equal(await fs.readFile(contract, "utf-8"), before, "the contract is unchanged");
});

test("runDeclareBackground: a missing contract exits 2", async () => {
  const code = await runDeclareBackground(["--contract", "/nope/does-not-exist.minigame.json", "--yes", "/Background/Sky"]);
  assert.equal(code, 2);
});
