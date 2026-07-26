import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { promoteGenreContract } from "../capabilities/genre/genre-contract/promote.js";
import { validateGenreContract } from "../capabilities/genre/genre-contract/validator.js";
import { assertValidSlicePlan } from "../capabilities/verification/slices.js";
import { validateAcceptanceContract } from "../capabilities/verification/validator.js";
import type { GenreContract } from "../capabilities/genre/genre-contract/types.js";

const shooterContractPath = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-contract",
  "examples",
  "2d-shooter.contract.json",
);
const promotedBundlePath = path.join(
  process.cwd(),
  "..",
  "demo-bundles",
  "generic-build-follow-on",
  "2d-shooter-promoted-vertical",
);

async function loadShooterContract(): Promise<GenreContract> {
  return JSON.parse(await fs.readFile(shooterContractPath, "utf-8")) as GenreContract;
}

async function readBundleJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(promotedBundlePath, fileName), "utf-8")) as T;
}

test("promoteGenreContract: promotes the 2d-shooter contract into valid acceptance and slices", async () => {
  const contract = await loadShooterContract();
  const contractValidation = validateGenreContract(contract);
  assert.equal(contractValidation.valid, true, JSON.stringify(contractValidation.issues, null, 2));

  const { acceptance, slices, report } = promoteGenreContract(contract);

  const acceptanceValidation = validateAcceptanceContract(acceptance);
  assert.equal(acceptanceValidation.valid, true, JSON.stringify(acceptanceValidation.issues, null, 2));
  assert.doesNotThrow(() => assertValidSlicePlan(slices));

  assert.equal(acceptance.game, "2d-shooter");
  assert.equal("platformer" in acceptance, false, "promoted shooter acceptance must not emit legacy platformer tuning");
  assert.equal(acceptance.verification?.gates?.["platform-tiles"], "not_applicable");
  assert.equal(acceptance.feel.extra?.fireIntervalMs, undefined, "plain targetBand rows are report-only, not enforced");
  assert.ok(acceptance.manifest.elements.some((element) => element.primitive === "enemy"));

  assert.equal(slices.genre, "2d-shooter");
  assert.deepEqual(
    slices.slices.map((slice) => slice.id),
    contract.sliceDag.coreVertical.map((slice) => slice.id),
  );
  assert.equal(slices.slices.find((slice) => slice.id === "weapon")?.skill, "genre-2d-shooter-weapon");
  assert.match(slices.slices.find((slice) => slice.id === "weapon")?.feelIntent ?? "", /spawn-aware-capture/);

  assert.deepEqual(report.deferredSlices, ["weapon-roster", "progression"]);
  assert.deepEqual(report.explicitGaps["weapon"], ["spawn-aware-capture"]);
  assert.ok(report.measurability.some((row) => row.target === "fireIntervalMs" && row.targetBand?.min === 90));
  assert.ok(report.measurability.some((row) => row.target === "aiming-feel" && row.tag === "judgment-only"));
});

test("promoteGenreContract: frozen promoted shooter bundle matches the compiler output", async () => {
  const contract = await loadShooterContract();
  const promoted = promoteGenreContract(contract);
  const acceptance = await readBundleJson<unknown>("acceptance.json");
  const slices = await readBundleJson<unknown>("slices.json");
  const report = await readBundleJson<unknown>("promotion-report.json");

  assert.deepEqual(acceptance, promoted.acceptance);
  assert.deepEqual(slices, promoted.slices);
  assert.deepEqual(report, promoted.report);
  assert.equal("platformer" in (acceptance as unknown as Record<string, unknown>), false);
  assert.deepEqual(promoted.report.explicitGaps["weapon"], ["spawn-aware-capture"]);
  assert.deepEqual(promoted.report.explicitGaps["enemy"], ["ttk-live-capture"]);
});

test("promoteGenreContract: only gateBand becomes an enforceable feel target", async () => {
  const contract = await loadShooterContract();
  const row = contract.measurabilityMap.find((entry) => entry.target === "fireIntervalMs");
  assert.ok(row);
  row.gateBand = { min: 100, max: 120, unit: "ms" };

  const { acceptance, report } = promoteGenreContract(contract);
  assert.equal(acceptance.feel.extra?.fireIntervalMs.target, 110);
  assert.deepEqual(acceptance.feel.extra?.fireIntervalMs.band, { abs: 10 });
  assert.ok(report.measurability.some((entry) => entry.target === "fireIntervalMs" && entry.gateBand?.max === 120));
});

test("promoteGenreContract: refuses invalid contracts before emitting artifacts", async () => {
  const contract = await loadShooterContract();
  contract.measurabilityMap[0] = {
    ...contract.measurabilityMap[0]!,
    calculator: "not-implemented",
  };
  assert.throws(() => promoteGenreContract(contract), /MEASURABLE_NOW_UNIMPLEMENTED/);
});

test("promoteGenreContract: refuses gated slices that depend on dropped gap-only slices", async () => {
  const contract = await loadShooterContract();
  contract.sliceDag.coreVertical.splice(1, 0, {
    id: "oracle-only",
    title: "Human-only oracle check",
    dependsOn: ["arena"],
    confidence: "experimental",
    gaps: ["human-oracle-only"],
  });
  contract.sliceDag.coreVertical.find((slice) => slice.id === "controller")!.dependsOn = ["oracle-only"];

  assert.throws(() => promoteGenreContract(contract), /depends on gap-only slice/);
});

test("promoteGenreContract: records deferred/gap-only slices without laundering them into SLICES", async () => {
  const contract = await loadShooterContract();
  contract.sliceDag.coreVertical.push({
    id: "oracle-only",
    title: "Human-only oracle check",
    dependsOn: ["end-state"],
    confidence: "experimental",
    gaps: ["human-oracle-only"],
  });

  const { slices, report } = promoteGenreContract(contract);
  assert.equal(slices.slices.some((slice) => slice.id === "oracle-only"), false);
  assert.deepEqual(report.explicitGaps["oracle-only"], ["human-oracle-only"]);
});

/* ============================================ §6 requiredEvidenceClasses propagation (RCL / T2 stitch) */

test("promoteGenreContract: absent requiredEvidenceClasses → generated acceptance carries none (byte-identical)", async () => {
  const contract = await loadShooterContract();
  assert.equal("requiredEvidenceClasses" in contract, false);
  const { acceptance } = promoteGenreContract(contract);
  // The verification section still exists (platformer gates N/A) but has NO requiredEvidenceClasses key.
  assert.ok(acceptance.verification);
  assert.equal("requiredEvidenceClasses" in acceptance.verification!, false);
  assert.equal(acceptance.verification!.requiredEvidenceClasses, undefined);
});

test("promoteGenreContract: declared requiredEvidenceClasses propagates VERBATIM, mutating nothing else", async () => {
  const contract = await loadShooterContract();
  const baseAcceptance = promoteGenreContract(contract).acceptance;

  const declared = ["console_clean", "scene_validation", "play_trace"];
  const withEvidence = promoteGenreContract({ ...contract, requiredEvidenceClasses: declared }).acceptance;

  // (1) the classes appear verbatim, same order.
  assert.deepEqual(withEvidence.verification?.requiredEvidenceClasses, declared);

  // (2) byte-identical rest: injecting ONLY that field into the base acceptance reproduces the whole
  //     generated acceptance — propagation adds exactly the one field and changes nothing else.
  const expected = structuredClone(baseAcceptance);
  expected.verification = { ...expected.verification!, requiredEvidenceClasses: declared };
  assert.deepEqual(withEvidence, expected);

  // (3) the propagated acceptance is still a valid acceptance contract (doneness can enforce it).
  const validation = validateAcceptanceContract(withEvidence);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
});

test("promoteGenreContract: a malformed requiredEvidenceClasses is refused before any artifact is emitted", async () => {
  const contract = await loadShooterContract();
  assert.throws(
    () => promoteGenreContract({ ...contract, requiredEvidenceClasses: ["__not_a_class__"] }),
    /REQUIRED_EVIDENCE_CLASS/,
  );
});
