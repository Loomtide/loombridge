import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateAcceptanceContract } from "../verification/validator.js";
import type { AcceptanceContract } from "../verification/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const acceptancePath = path.join(
  repoRoot,
  "mcp-server/src/verification/switchyard-courier.acceptance.json",
);
// Relocated from .planning (internal) into the test-fixture tree for the OSS export.
const briefPath = path.join(repoRoot, "mcp-server/src/__tests__/fixtures/design-briefs/switchyard-courier-design-brief.md");

async function loadAcceptance(): Promise<AcceptanceContract> {
  return JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as AcceptanceContract;
}

test("switchyard-courier.acceptance.json validates against the schema", async () => {
  const contract = await loadAcceptance();
  const result = validateAcceptanceContract(contract);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("switchyard-courier contract stays non-platformer", async () => {
  const text = await fs.readFile(acceptancePath, "utf-8");
  const forbidden = [/fruit/i, /flag/i, /trampoline/i, /one-way/i, /jumpApex/i, /coyote/i];
  const hits = forbidden.filter((pattern) => pattern.test(text)).map(String);
  assert.deepEqual(hits, [], `non-platformer proof contract leaked platformer terms: ${hits.join(", ")}`);
});

test("switchyard-courier contract declares top-down delivery entities", async () => {
  const contract = await loadAcceptance();
  assert.equal(contract.game, "switchyard-courier");
  assert.equal(contract.win.rule, "deliver-3-batteries");

  const manifest = contract.manifest.elements.map((entry) => entry.nameRegex ?? entry.name ?? "");
  assert.ok(manifest.some((entry) => /battery/.test(entry)), "manifest should require batteries");
  assert.ok(manifest.some((entry) => /terminal/.test(entry)), "manifest should require terminals");
  assert.ok(manifest.some((entry) => /security|hazard|electric/.test(entry)), "manifest should require hazards");

  assert.ok(contract.feel.extra?.accelTo90, "top-down acceleration target should be declared");
  assert.ok(contract.feel.extra?.decelToStop, "top-down deceleration target should be declared");
});

test("switchyard-courier contract skips platformer-shaped gates explicitly", async () => {
  const contract = await loadAcceptance();
  assert.equal(contract.verification?.gates?.["coverage"], "not_applicable");
  assert.equal(contract.verification?.gates?.["parallax-motion"], "not_applicable");
  assert.equal(contract.verification?.gates?.["reachability"], "not_applicable");
  assert.equal(contract.verification?.gates?.["platform-tiles"], "not_applicable");
  assert.equal(contract.verification?.gates?.["tile-render"], "not_applicable");
  assert.equal(contract.verification?.gates?.["playability"], "required");
  assert.equal(contract.verification?.gates?.["feel"], "required");
});

test("switchyard-courier contract explicitly rejects Tiderunner HUD font leakage", async () => {
  const contract = await loadAcceptance();
  const forbidden = contract.fonts.forbidden?.map((font) => font.family) ?? [];
  assert.ok(
    forbidden.includes("Press Start 2P"),
    "Switchyard proof should fail if a builder copies Tiderunner's exact HUD font",
  );
});

test("switchyard brief requires tool-neutral handoff evidence", async () => {
  const brief = await fs.readFile(briefPath, "utf-8");
  assert.match(brief, /handoff evidence/i);
  assert.match(brief, /chosen movement\/camera values/i);
  assert.match(brief, /spawn, pickup, delivery, damage\/dodge, and win/i);
  assert.doesNotMatch(brief, /mcp-server\/dist\/verification\/run-gates\.js/);
  assert.doesNotMatch(brief, /switchyard-courier\.acceptance\.json/);
  assert.doesNotMatch(brief, /Loombridge proof|acceptance contract|contract-defined|asset registry/i);
});
