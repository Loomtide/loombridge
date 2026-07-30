/**
 * DECLARED PATHS NOTHING WALKS, at the CONTRACT level (H1/L108).
 *
 * The repo's recurring failure is a path declared in one place that no test walks. L108
 * is that failure lifted to the acceptance contract: `manifest.elements` required a goal
 * object and an `SfxPlayer`, `audio.cues` required six clips, and the `manifest` gate was
 * in no slice's gate list, so a 9/9 approved project had never graded its own contract.
 *
 * The fix has two halves, and this file guards the half that rots silently: EVERY gate
 * the verifier can run must DECLARE which contract sections it walks. A gate added
 * without a declaration would contribute nothing to coverage, so the coverage refusal
 * would quietly get weaker with every new gate.
 *
 * The guard carries its own LITMUS: it re-runs its predicate over the supported set PLUS
 * a phantom id and asserts that it fails, which proves the check can fail at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SECTIONS,
  SUPPORTED_GATE_IDS,
  contractCoverageRefusals,
  contractSectionsForGate,
  contractSectionsForGates,
  requiredContentSections,
  sliceEvidenceFiles,
} from "../../../capabilities/verification/run-gates.js";

/** The predicate under test: which gate ids DECLARE no section list at all? */
function undeclared(gateIds: Iterable<string>): string[] {
  return [...gateIds].filter((gate) => contractSectionsForGate(gate) === undefined);
}

test("every supported gate declares the contract sections it walks", () => {
  assert.deepEqual(undeclared(SUPPORTED_GATE_IDS), []);
});

test("LITMUS: the guard FAILS for a gate that is registered but undeclared", () => {
  // Simulates adding a gate to the runner without answering "what does it walk?".
  // Without this, the assertion above would keep passing on an empty declaration set.
  assert.deepEqual(undeclared([...SUPPORTED_GATE_IDS, "phantom-gate"]), ["phantom-gate"]);
});

test("every declared section is in the CLOSED contract vocabulary", () => {
  for (const gate of SUPPORTED_GATE_IDS) {
    for (const section of contractSectionsForGate(gate) ?? []) {
      assert.ok(
        (CONTRACT_SECTIONS as readonly string[]).includes(section),
        `${gate} declares unknown section ${section}`,
      );
    }
  }
});

test("every section in the vocabulary is REACHABLE from a contract, so none is dead", () => {
  // A section nothing can declare would be a coverage rule that never fires; a section
  // no gate walks would be a refusal with no fix. Both are checked here.
  const declarable = new Set(
    requiredContentSections({
      fonts: { global: { family: "F" } },
      palette: { entries: [{ hex: "#fff", roles: ["x"] }] },
      hud: { elements: [{ id: "score", role: "score", anchor: "top-left" }] },
      framing: { aspect: { w: 16, h: 9 } },
      physics: { fixedTimestep: 0.0166 },
      feel: { runSpeed: { target: 8, unit: "u/s" } },
      juice: { parallax: { layers: [] } },
      audio: { cues: [{ id: "jump", clip: "Assets/Audio/jump.wav" }] },
      manifest: { elements: [{ name: "Player", type: "GameObject" }] },
      win: { rule: "all-fruit" },
      props: { purposes: { Rock: "decor" } },
      placement: { maxFloatU: 0.1 },
      platformer: { tileSize: 1 },
      reachability: { maxGapU: 4 },
      render: { minDistinctColors: 8 },
    }).map((s) => s.section),
  );
  const walked = new Set(contractSectionsForGates(SUPPORTED_GATE_IDS));
  for (const section of CONTRACT_SECTIONS) {
    assert.ok(declarable.has(section), `no contract shape declares required content for \`${section}\``);
    assert.ok(walked.has(section), `no supported gate walks \`${section}\`, so its refusal has no fix`);
  }
});

test("an EMPTY or absent section declares nothing (a refusal must have a real requirement behind it)", () => {
  const sections = requiredContentSections({
    fonts: {},
    palette: { entries: [] },
    hud: { elements: [] },
    juice: {},
    audio: { cues: [] },
    manifest: { elements: [] },
    props: {},
  }).map((s) => s.section);
  assert.deepEqual(sections, []);
});

test("the coverage refusal names the section, what it declares, and the gates that would cover it", () => {
  const contract = { manifest: { elements: [{ name: "Goal", type: "GameObject" }] } };
  const refusals = contractCoverageRefusals({ acceptance: contract, gates: ["console-clean", "feel"] });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!, /`manifest`/);
  assert.match(refusals[0]!, /1 required scene element/);
  assert.match(refusals[0]!, /gates that would: manifest/);

  // …and the SAME contract with a covering gate produces nothing.
  assert.deepEqual(contractCoverageRefusals({ acceptance: contract, gates: ["manifest"] }), []);
});

test("`audio.cues` is covered only by the SFX gates: an audio contract with them off is uncovered", () => {
  // The other half of L108: TideRunner declared six audio cues, the SFX gates were not
  // enabled, and nothing said so.
  const contract = { audio: { cues: [{ id: "jump", clip: "Assets/Audio/jump.wav" }] } };
  assert.equal(contractCoverageRefusals({ acceptance: contract, gates: ["manifest", "feel"] }).length, 1);
  assert.deepEqual(contractCoverageRefusals({ acceptance: contract, gates: ["sfx-presence"] }), []);
});

test("sliceEvidenceFiles adds the staged asset manifest ONLY when its gate is selected", () => {
  assert.equal(sliceEvidenceFiles(["manifest"]).includes("asset-manifest.json"), false);
  assert.equal(sliceEvidenceFiles(["asset-source-fidelity"]).includes("asset-manifest.json"), true);
});
