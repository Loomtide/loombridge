/**
 * Refuse-on-missing-contract + bridge-surfaced discovery (dogfood core-hardening
 * Epic 0; RCL-P04 / RCL-P01). The gate verbs must REFUSE when there is no
 * acceptance contract — a hand-created `.loombridge/captures/` is not a
 * verification — and the core must be discoverable from the bridge.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectContractPresence,
  noContractRefusal,
} from "../../../../domain/contract-presence.js";
import { runVerify, run as runVerifyCli } from "../../../../capabilities/verification/verify.js";
import { runDoneness } from "../../../../capabilities/verification/doneness.js";
import { runPlan } from "../../../../capabilities/verification/plan.js";
import { computeStatusModel, renderDetailedStatus } from "../../../../capabilities/verification/status-model.js";
import { designStatus, setDesignTarget } from "../../../../capabilities/verification/design.js";
import { fileExists, loombridgePaths, readState, writeState } from "../../../../domain/state.js";
import { projectWorkspace, sanitizeWorkspaceId } from "../../../../domain/workspace-paths.js";
import { readSlicePlan } from "../../../../capabilities/verification/slices.js";
import {
  buildLoombridgeStatusPayload,
  runLoombridgeProjectInit,
  runLoombridgeVerifyTool,
  runLoombridgeDonenessTool,
  buildAndWriteMobileAuditReport,
  extractMobileAuditThresholds,
  LOOMBRIDGE_VERIFY_TOOL,
  LOOMBRIDGE_VERIFY_TOOL_NAME,
  LOOMBRIDGE_DONENESS_TOOL,
  LOOMBRIDGE_DONENESS_TOOL_NAME,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME,
} from "../../../../surfaces/loombridge-bridge-tools.js";
import { LOOMBRIDGE_CORE_TOOLS } from "../../../../surfaces/index.js";
import {
  buildMobileAuditReport,
  stableStringify,
  DEFAULT_THRESHOLDS,
  type AuditPayload,
} from "../../../../capabilities/mobile/mobile-audit-report.js";
import { OpRegistry } from "../../../../surfaces/op-registry.js";
import {
  unifiedVerifyReportPath,
  writeUnifiedVerifyReport,
} from "../../../../capabilities/verification/unified/report.js";
import { writeApprovedAssetManifestForDesign } from "../../../helpers/asset-manifest-fixture.js";
import { plantTestResults } from "../../../_support/test-results-fixture.js";

/** Capture console.error/log around a verb call (mirrors the CLI's own output surface). */
async function captureVerb(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.join(" "));
  const oe = console.error, ol = console.log, ow = console.warn;
  console.error = push; console.log = push; console.warn = push;
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    console.error = oe; console.log = ol; console.warn = ow;
  }
}

/** A representative stamped audit payload with one high-severity offender per category. */
function sampleAuditPayload(): AuditPayload {
  return {
    payload_kind: "mobile_asset_audit",
    payload_version: 1,
    max_entries: 50,
    loaded_scene_count: 1,
    loaded_scenes: ["Assets/Scenes/Arena.unity"],
    textures: {
      total_count: 2, truncated: false, entries: [
        { path: "Assets/Tex/wall_4k.png", name: "wall_4k", width: 4096, height: 4096, format: "RGBA32", compression: "Uncompressed", estimated_bytes: 67108864 },
        { path: "Assets/Tex/icon.png", name: "icon", width: 256, height: 256, format: "DXT5", compression: "Compressed", estimated_bytes: 87381 },
      ],
    },
    audio: {
      total_count: 1, truncated: false, entries: [
        { path: "Assets/Audio/music_loop.wav", name: "music_loop", length_seconds: 92.5, channels: 2, frequency: 44100, load_type: "DecompressOnLoad", compression_format: "PCM", file_bytes: 16321500 },
      ],
    },
    meshes: {
      total_count: 1, truncated: false, unreadable_count: 0, entries: [
        { path: "Assets/Mesh/twall.fbx", name: "TWall", vertex_count: 18000, triangle_count: 30700, instance_count: 57, triangle_load: 1749900 },
      ],
    },
    quality_settings: { level_name: "High", shadow_distance: 150 },
    render_pipeline_settings: null,
    build_scenes: [],
  };
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-contract-presence-"));
}

/** Build a full approved roadmap so `.loombridge/SLICES.json` exists (mirrors the status test helper). */
async function scaffoldApprovedRoadmap(root: string): Promise<void> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const image = path.join(root, "src-hero.png");
  await fs.writeFile(image, "hero", "utf-8");
  await setDesignTarget({ root, imagePath: image, mode: "generated", kind: "rendered-unity-frame", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false });
}

/** Hand-create a `.loombridge/captures/` dir with a file but NO contract — RCL-P04. */
async function fakeCaptures(root: string): Promise<void> {
  const dir = path.join(root, ".loombridge", "captures");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "frame-0.json"), "{}\n", "utf-8");
}

function verifyArgs(root: string) {
  const paths = loombridgePaths(root);
  return {
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  };
}

async function statusModel(root: string) {
  const paths = loombridgePaths(root);
  return computeStatusModel({
    paths,
    state: await readState(paths),
    plan: await readSlicePlan(paths),
    design: await designStatus(paths),
  });
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test("inspectContractPresence flags captures-without-contract", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const presence = await inspectContractPresence(loombridgePaths(root));
    assert.equal(presence.loombridgeDirExists, true);
    assert.equal(presence.contractExists, false);
    assert.deepEqual(presence.capturePresentDirs, ["captures"]);
    assert.equal(presence.capturesWithoutContract, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("noContractRefusal names plan + the captures-are-not-a-verification trap", () => {
  const msg = noContractRefusal("/p/.loombridge/ACCEPTANCE.json", ["captures"]);
  assert.match(msg, /No acceptance contract found at \/p\/\.loombridge\/ACCEPTANCE\.json/);
  assert.match(msg, /loombridge plan/);
  assert.match(msg, /NOT a verification/);
});

// ── (a) verify + doneness refuse + non-zero exit on a missing contract ────────

test("verify REFUSES with exit 2 when no contract exists (captures present)", async () => {
  const root = await tmpRoot();
  const lines: string[] = [];
  const original = console.error;
  try {
    await fakeCaptures(root);
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    const code = await runVerify(verifyArgs(root));
    console.error = original;
    assert.equal(code, 2, "missing contract must exit non-zero (refusal)");
    assert.ok(lines.some((l) => /REFUSED/.test(l) && /loombridge plan/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /NOT a verification/.test(l)), lines.join("\n"));
    // No verdict file may be written by a refused verify.
    await assert.rejects(fs.stat(loombridgePaths(root).verdict));
  } finally {
    console.error = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness REFUSES with exit 1 when no contract exists (captures present)", async () => {
  const root = await tmpRoot();
  const lines: string[] = [];
  const original = console.error;
  try {
    await fakeCaptures(root);
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    const code = await runDoneness({ root });
    console.error = original;
    assert.equal(code, 1, "doneness without a contract is NOT done");
    assert.ok(lines.some((l) => /NOT done/.test(l) && /loombridge plan/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /NOT a verification/.test(l)), lines.join("\n"));
  } finally {
    console.error = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (c) status honesty: captures present, NO contract, NOT verified ───────────

test("status model reports captures-without-contract honestly", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const model = await statusModel(root);
    assert.equal(model.hasRoadmap, false);
    assert.equal(model.contractExists, false);
    assert.equal(model.capturesWithoutContract, true);
    assert.deepEqual(model.capturePresentDirs, ["captures"]);
    assert.ok(
      model.warnings.some((w) => /NO acceptance contract/.test(w) && /NOT a verification/.test(w)),
      model.warnings.join("\n"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("renderDetailedStatus prints the captures/NO contract/NOT verified line", async () => {
  const root = await tmpRoot();
  const lines: string[] = [];
  const original = console.error;
  try {
    await fakeCaptures(root);
    const model = await statusModel(root);
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    renderDetailedStatus(model);
    console.error = original;
    assert.ok(
      lines.some((l) => /NO contract/.test(l) && /NOT verified/.test(l)),
      lines.join("\n"),
    );
  } finally {
    console.error = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (a/d) existing present-contract behavior is unchanged ─────────────────────

test("verify does NOT refuse once a contract exists (guard is backward-compatible)", async () => {
  const root = await tmpRoot();
  const original = console.error;
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    console.error = () => {};
    // Stage ONE real capture so the run actually grades a gate. Without it the engine's
    // nothing-graded refusal also exits 2, and this assertion could no longer tell a
    // missing-contract refusal apart from an ungraded run. The two are different
    // defects and this test is about the first.
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    // With a contract present, verify proceeds to grade. The point is it does NOT
    // short-circuit as a contract refusal.
    const code = await runVerify(verifyArgs(root));
    console.error = original;
    assert.notEqual(code, 2, "a present contract must not be treated as missing");
    // A real verdict file IS written when the contract is present (refusal writes none).
    await fs.stat(loombridgePaths(root).verdict);
  } finally {
    console.error = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status model sets contractExists once a contract is planned", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const model = await statusModel(root);
    assert.equal(model.contractExists, true);
    assert.equal(model.capturesWithoutContract, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (d) the bridge MCP tools return the expected shape ────────────────────────

test("loombridge_status payload: no contract → run plan, never verifiedGreen on captures", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await buildLoombridgeStatusPayload(root);
    assert.equal(payload.contractExists, false);
    assert.equal(payload.capturesWithoutContract, true);
    assert.equal(payload.verifiedGreen, false);
    // `plan` REFUSES to guess the genre, so the no-contract nextStep must supply it: a nextStep
    // that exits 2 in the one state it fires in trains an agent to stop trusting nextStep.
    assert.match(payload.nextStep, /^loombridge plan --genre /);
    assert.match(payload.summary, /NO acceptance contract|not a verification/i);
    assert.equal(payload.contractPath, path.join(".loombridge", "ACCEPTANCE.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loombridge_status payload: a planned project reports contract present", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const payload = await buildLoombridgeStatusPayload(root);
    assert.equal(payload.contractExists, true);
    assert.notEqual(payload.nextStep, "loombridge plan");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loombridge_project_init scaffolds .loombridge/ idempotently without fabricating a contract", async () => {
  const root = await tmpRoot();
  try {
    const first = await runLoombridgeProjectInit(root);
    assert.equal(first.created, true);
    assert.equal(first.loombridgeDirExists, true);
    // Init must NOT invent a contract or a verified state.
    assert.equal(first.contractExists, false);
    assert.equal(first.verifiedGreen, false);
    assert.match(first.nextStep, /^loombridge plan --genre /);
    await fs.stat(path.join(root, ".loombridge"));

    const second = await runLoombridgeProjectInit(root);
    assert.equal(second.created, false, "init is idempotent");
    assert.equal(second.contractExists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loombridge_project_init is non-destructive: it never rewrites an existing contract", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const acceptance = loombridgePaths(root).acceptance;
    const before = await fs.readFile(acceptance, "utf-8");
    const result = await runLoombridgeProjectInit(root);
    assert.equal(result.created, false, "init on an existing .loombridge/ does not 'create' it");
    assert.equal(result.contractExists, true);
    const after = await fs.readFile(acceptance, "utf-8");
    assert.equal(after, before, "existing ACCEPTANCE.json bytes must be untouched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (MED fix) verifiedGreen is bound to the doneness gate, not a forgeable marker ─

test("loombridge_status verifiedGreen is TRUE for a real runId-bound fresh-green verdict", async () => {
  const root = await tmpRoot();
  try {
    // A single plan (design phase) gives us a VALID ACCEPTANCE.json but no
    // SLICES.json, so the whole-game freshness path (the forgeable-phase one) runs.
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);

    const runId = "run-green-1";
    const startedAt = "2026-05-28T00:00:00.000Z";
    const producedAt = "2026-05-28T01:00:00.000Z";
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "verified-green",
      currentBuild: { runId, startedAt, captureManifest: [] },
      lastVerdict: { status: "pass", at: producedAt, verdictPath: ".loombridge/reports/build-verdict.json" },
      updatedAt: producedAt,
    });
    await fs.mkdir(paths.reports, { recursive: true });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");

    const payload = await buildLoombridgeStatusPayload(root);
    assert.equal(payload.verifiedGreen, true, "a fresh runId-bound green verdict must read as verifiedGreen");
    assert.equal(payload.nextStep, "loombridge doneness");
    assert.match(payload.summary, /fresh, runId-bound verify is green/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loombridge_status verifiedGreen is FALSE for a forged STATE.phase + empty {} contract", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    // Bare-existence contract (passes a naive file check, fails a parse-valid check).
    await fs.writeFile(paths.acceptance, "{}", "utf-8");
    // Hand-edited "verified-green" marker with NO currentBuild and NO verdict.
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "verified-green",
      lastVerdict: { status: "pass", at: "2026-05-28T01:00:00.000Z", verdictPath: ".loombridge/reports/build-verdict.json" },
      updatedAt: "2026-05-28T01:00:00.000Z",
    });

    const payload = await buildLoombridgeStatusPayload(root);
    assert.equal(payload.contractExists, true, "the (empty) file does exist");
    assert.equal(payload.phase, "verified-green");
    // ...but the doneness gate refuses it, so the bridge must NOT report green.
    assert.equal(payload.verifiedGreen, false, "a forged phase + empty contract must never read as verifiedGreen");
    assert.notEqual(payload.nextStep, "loombridge doneness");
    assert.doesNotMatch(payload.summary, /verify is green/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (LOW #3) the new contract-refusal branch must NOT over-fire ───────────────

test("doneness with SLICES.json + STATE but NO contract goes to the slice roll-up (not the contract refusal)", async () => {
  const root = await tmpRoot();
  const lines: string[] = [];
  const original = console.error;
  try {
    // A full roadmap has SLICES.json + STATE.md; delete only ACCEPTANCE.json.
    await scaffoldApprovedRoadmap(root);
    const paths = loombridgePaths(root);
    await fs.rm(paths.acceptance);

    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    const code = await runDoneness({ root });
    console.error = original;

    // Not done (slices unbuilt) — but via the slice roll-up, NOT the new
    // contract-missing refusal (which must only fire for a never-planned project).
    assert.equal(code, 1);
    assert.ok(lines.some((l) => /Slice roll-up/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /No acceptance contract found/.test(l)), lines.join("\n"));
  } finally {
    console.error = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (T4a) the workflow verbs are first-class MCP tools (the front door) ────────

test("workflow verb tools are registered in the served MCP tool list (GRL-C20/C21)", () => {
  const names = new Set(LOOMBRIDGE_CORE_TOOLS.map((t) => t.name));
  assert.ok(names.has(LOOMBRIDGE_VERIFY_TOOL_NAME), "loombridge_verify must be served");
  assert.ok(names.has(LOOMBRIDGE_DONENESS_TOOL_NAME), "loombridge_doneness must be served");
  assert.ok(names.has(LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME), "loombridge_mobile_audit must be served");
});

test("workflow verb tools are MCP-layer tools, NOT bridge ops (op count is untouched)", () => {
  const opToolNames = new Set(new OpRegistry().toMCPTools().map((t) => t.name));
  for (const n of [LOOMBRIDGE_VERIFY_TOOL_NAME, LOOMBRIDGE_DONENESS_TOOL_NAME, LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME]) {
    assert.ok(!opToolNames.has(n), `${n} must not be a bridge op`);
  }
});

test("each workflow verb tool description LEADS with the moment-of-need trigger", () => {
  // The description is the discoverability surface — it must open with WHEN to reach for it.
  assert.match(LOOMBRIDGE_VERIFY_TOOL.description, /^Run BEFORE claiming a build is done/);
  assert.match(LOOMBRIDGE_DONENESS_TOOL.description, /^Run BEFORE handing off or shipping/);
  assert.match(LOOMBRIDGE_MOBILE_AUDIT_TOOL.description, /^Run BEFORE shipping to mobile/);
});

// ── loombridge_verify wrapper: verbatim, refusal-is-the-headline, no fake pass ───

test("runLoombridgeVerifyTool REFUSES (exit 2) with a verbatim headline when there is nothing to verify", async () => {
  // UPDATED FOR S2c + F7. The tool now runs the UNIFIED door, so a project with no
  // verification assets at all gets the on-ramp refusal rather than the contract engine's
  // missing-contract refusal. F7 is what keeps this test's point intact: the on-ramp names
  // `loombridge plan` (door one) when there is no ACCEPTANCE.json, so an agent that arrives
  // here while BUILDING is still routed to the verb that fixes it.
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await runLoombridgeVerifyTool(root);
    assert.equal(payload.exitCode, 2, "nothing to check must exit 2 (refusal)");
    assert.equal(payload.refused, true);
    assert.match(payload.headline, /REFUSED/);
    const text = payload.output.join("\n");
    // F7: the door-one pointer, printed because there is no acceptance contract on disk.
    assert.match(text, /loombridge plan is the other door/);
    assert.match(text, /no ACCEPTANCE\.json/);
    // …and the door-two on-ramp is still the primary answer for an EXISTING game.
    assert.match(text, /loombridge trace record --id <name>/);
    // A refused run writes NO verdict and NO unified report (never a fake pass).
    assert.equal(payload.verdictExists, false);
    assert.equal(payload.verdictStatus, null);
    assert.equal(payload.unifiedStatus, null, "the on-ramp refuses BEFORE writing a report");
    assert.equal(payload.unifiedExit, null);
    assert.equal(payload.unanchoredSections, null);
    await assert.rejects(fs.stat(loombridgePaths(root).verdict));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runLoombridgeVerifyTool surfaces the CLI output byte-for-byte (no summarization)", async () => {
  // UPDATED FOR S2c. The parity target moved with the tool: it used to call `runVerify`
  // directly, so the comparison was against the engine; it now runs the same unified door as
  // bare `loombridge verify --root .`, so THAT is what it must match line for line. The
  // property under test is unchanged: the wrapper summarizes nothing.
  const rootA = await tmpRoot();
  const rootB = await tmpRoot();
  try {
    await fakeCaptures(rootA);
    await fakeCaptures(rootB);
    const direct = await captureVerb(() => runVerifyCli(["--root", rootA]));
    const wrapped = await runLoombridgeVerifyTool(rootB);
    // Normalize the differences that are PATHS rather than message text: the temp root, and
    // the WORKSPACE derived from it. The absent-family lines name the workspace directory
    // they searched, and that directory's name is the root's basename put through
    // `sanitizeWorkspaceId`, so it is derived with the same two functions the door uses
    // rather than assembled by hand here.
    const workspaceOf = (root: string): string => {
      const id = sanitizeWorkspaceId(path.basename(root));
      assert.ok(id, `a temp root must derive a workspace id: ${root}`);
      return projectWorkspace(id);
    };
    const norm = (l: string) =>
      l
        .replaceAll(workspaceOf(rootA), "WORKSPACE")
        .replaceAll(workspaceOf(rootB), "WORKSPACE")
        .replace(rootA, "ROOT")
        .replace(rootB, "ROOT");
    assert.deepEqual(wrapped.output.map(norm), direct.lines.map(norm), "wrapper must surface the CLI lines verbatim");
    assert.equal(wrapped.exitCode, direct.code);
  } finally {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  }
});

test("runLoombridgeVerifyTool with a contract grades it through the unified door, and says what it did NOT anchor", async () => {
  // UPDATED FOR S2c + F5. The old pin ("a present contract is not a refusal, exitCode != 2")
  // no longer holds and SHOULD not: this fixture's only asset is a contract with no approved
  // design target, so the unified door's FXH rule makes it `partial` at exit 2: nothing
  // human-approved was compared. The thing this test protects is that a present contract is
  // GRADED (a verdict this run produced, surfaced from the run's own binding), and that the
  // payload says out loud why that is not a pass.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    // One real capture, so the contract section really grades rather than refusing as
    // nothing-graded (which would blur what this test pins).
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    const payload = await runLoombridgeVerifyTool(root);

    assert.ok(payload.output.some((l) => /contract '.*': will run \(offline\)/.test(l)), payload.output.join("\n"));
    // F5: the verdict is quoted because THIS run wrote it (the section's report binding).
    assert.equal(payload.verdictExists, true);
    assert.ok(payload.verdictStatus, "the verdict status must be surfaced from the run that produced it");
    // The unified fields are the honest headline: green gates, no frozen anchor compared.
    assert.equal(payload.unifiedStatus, "partial");
    assert.equal(payload.unifiedExit, 2);
    assert.deepEqual(payload.unanchoredSections, ["contract"]);
    assert.equal(payload.exitCode, 2);
    assert.equal(payload.refused, true, "F4: `refused` is the report's non-zero exit, not a stderr regex");
    assert.equal(payload.reportPath, path.relative(root, path.join(paths.reports, "verify.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── M-H1: the payload is bound to THIS run's report, never to whatever is on disk ──

/** A green-looking unified report someone (or an earlier run) left on disk. */
async function plantStaleGreenReport(root: string): Promise<string> {
  const paths = loombridgePaths(root);
  const file = unifiedVerifyReportPath(paths.reports);
  await fs.mkdir(paths.reports, { recursive: true });
  await writeUnifiedVerifyReport(file, {
    kind: "unified-verify",
    schemaVersion: "1",
    producedAt: "2026-01-01T00:00:00.000Z",
    root,
    runId: null,
    live: false,
    plan: [],
    notRun: [],
    absentFamilies: [],
    only: null,
    deselected: [],
    sections: { contract: { status: "pass", exit: 0, anchored: true } },
    anchoredSections: ["contract"],
    unanchoredSections: [],
    status: "pass",
    exit: 0,
    notes: [],
  });
  return file;
}

test("M-H1: the on-ramp does NOT report a stale green left by an earlier run", async () => {
  // THE ATTACK, and it needs no attacker. The tool read verify.json after the run and trusted
  // whatever was there, so any run that wrote NO report handed the agent the previous run's
  // verdict as if it were this one's. The zero-asset on-ramp is the everyday version: it
  // refuses BEFORE writing anything, so a green file from last week survived it intact and the
  // payload reported `unifiedStatus: "pass"`, `unifiedExit: 0`, `refused: false` for a run that
  // exited 2 having checked nothing.
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const file = await plantStaleGreenReport(root);
    const before = await fs.readFile(file, "utf-8");

    const payload = await runLoombridgeVerifyTool(root);
    assert.equal(payload.exitCode, 2, "nothing to check is still a refusal");
    assert.equal(payload.unifiedStatus, null, "this run wrote no report, so it has no status to report");
    assert.equal(payload.unifiedExit, null);
    assert.equal(payload.unanchoredSections, null);
    assert.equal(payload.notRun, null);
    assert.equal(payload.deselected, null);
    assert.equal(payload.refused, true, "with no report of its own, `refused` falls back to the process tier");
    assert.equal(await fs.readFile(file, "utf-8"), before, "the stale file is untouched (the tool never wrote one)");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M-H1: a BLOCKED write does not let an earlier green stand in for this run", async (t) => {
  // The second trigger, and the one that survives a project WITH assets: the run really grades,
  // really tries to write, and the write fails (read-only report, full disk, EACCES). The
  // orchestrator throws, the tool maps it to tier 2, and the file still on disk is the
  // PREVIOUS run's green. Only the before/after fingerprint can tell those apart.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // Mode bits do not constrain root, so the fixture cannot produce the fault. The on-ramp
    // test above exercises the same fingerprint gate without needing them.
    t.skip("running as root: chmod cannot block the write");
    return;
  }
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    const file = await plantStaleGreenReport(root);
    const before = await fs.readFile(file, "utf-8");
    await fs.chmod(file, 0o444);

    const payload = await runLoombridgeVerifyTool(root);
    assert.equal(payload.exitCode, 2, "a failed write is a HARNESS fault, never a game verdict");
    assert.ok(
      payload.output.some((l) => /\[loombridge verify\] fatal:/.test(l)),
      payload.output.join("\n"),
    );
    assert.equal(payload.unifiedStatus, null, "the green on disk is not this run's answer");
    assert.equal(payload.unifiedExit, null);
    assert.equal(payload.refused, true);
    assert.equal(await fs.readFile(file, "utf-8"), before, "…and the write really was blocked");
  } finally {
    await fs.chmod(unifiedVerifyReportPath(loombridgePaths(root).reports), 0o644).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("V4/V5: `refused` and the verdict binding come from THIS run's report, not from disk", async () => {
  // Two survivors of the vacuity pass, in one fixture because they need the same one: a real
  // RED run (tier 1) whose output contains NO refusal line at all.
  //
  //  V4: `refused` must be the REPORT's non-zero exit. The defusal is a reintroduced stderr
  //      regex (`/REFUSED/`), which this run's output would not match, so a found game defect
  //      would report `refused: false`.
  //  V5: `verdictStatus`/`verdictExists` must come from the contract section having a report
  //      binding stamped THIS run. The defusal is a plain disk read of build-verdict.json,
  //      which here would quote a verdict from a run that is not this one.
  const root = await tmpRoot();
  try {
    await plantTestResults(root); // the committed fixture is a genuine red: 1 real failure
    // A stale verdict from some earlier run, sitting exactly where a disk read would find it.
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.reports, { recursive: true });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId: "run-earlier" }), "utf-8");

    const payload = await runLoombridgeVerifyTool(root);
    const text = payload.output.join("\n");
    assert.equal(payload.exitCode, 1, "a failing suite is a GAME DEFECT (tier 1)");
    assert.equal(payload.unifiedExit, 1);
    assert.equal(payload.unifiedStatus, "fail");
    assert.ok(!/REFUSED/.test(text), `this run prints no refusal line:\n${text}`);
    assert.equal(payload.refused, true, "V4: a non-zero report exit is `refused`, whatever the log says");

    assert.equal(payload.verdictExists, false, "V5: the contract section never ran, so no verdict is this run's");
    assert.equal(payload.verdictStatus, null, "V5: the stale `pass` on disk must not be quoted");

    // M-M5: the headline is the run's own terminal verdict line, not the plan header (which
    // contains the word "pass" in `pass --live for live assets` and used to win the scan).
    assert.match(payload.headline, /status=fail exit=1/);
    assert.ok(!/plan for /.test(payload.headline), `the plan header is not a verdict: ${payload.headline}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M-M7: the payload carries notRun/deselected as ROWS, not only as prose", async () => {
  // The skipped-anchor case: a recorded-but-unapproved trace beside a contract that grades.
  // `unanchoredSections` covers EXECUTED sections only, so it names `contract` and says
  // NOTHING about the trace; without a structured `notRun` the one fact that decides
  // pass-vs-partial existed only in the verbatim log, for an agent to regex out of prose.
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    // An approved-but-unstamped trace baseline: discovered, never runnable, always a row.
    await fs.mkdir(path.join(paths.replayTraces), { recursive: true });
    await fs.writeFile(
      path.join(paths.replayTraces, "happy-path.trace.json"),
      JSON.stringify({ id: "happy-path", schemaVersion: "1", steps: [] }),
      "utf-8",
    );

    const payload = await runLoombridgeVerifyTool(root);
    assert.deepEqual(payload.deselected, [], "the tool never scopes, and says so rather than omitting the field");
    assert.deepEqual(
      payload.notRun,
      [
        {
          kind: "trace",
          id: "happy-path",
          why: "non-anchor",
          reason:
            "recorded, not approved: run `loombridge trace replay --id happy-path` then `loombridge trace approve --id happy-path`",
        },
      ],
      "the skipped anchor is a ROW with its class, not a sentence in the log",
    );
    // …and it is NOT in `unanchoredSections`, which is the distinction M-M7 asked the field
    // doc to make: that array is about sections that EXECUTED.
    assert.deepEqual(payload.unanchoredSections, ["contract"]);
    // Every row the report carries reaches the payload, trimmed but never summarized away.
    const report = JSON.parse(
      await fs.readFile(unifiedVerifyReportPath(paths.reports), "utf-8"),
    ) as { notRun: { kind: string; id: string }[] };
    assert.deepEqual(
      payload.notRun!.map((r) => `${r.kind}:${r.id}`),
      report.notRun.map((r) => `${r.kind}:${r.id}`),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── loombridge_doneness wrapper: refusal-is-the-headline, cannot be talked into done ─

test("runLoombridgeDonenessTool is NOT done (exit 1) + refuses verbatim when no contract exists", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await runLoombridgeDonenessTool(root);
    assert.equal(payload.exitCode, 1, "no contract is NOT done");
    assert.equal(payload.done, false);
    assert.equal(payload.refused, true);
    assert.match(payload.headline, /NOT done/);
    assert.ok(payload.output.some((l) => /loombridge plan/.test(l)), payload.output.join("\n"));
    assert.ok(payload.output.some((l) => /NOT a verification/.test(l)), payload.output.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── loombridge_mobile_audit builder: report-to-file + summary, no blob inline ────

test("buildAndWriteMobileAuditReport REFUSES a payload that is not a stamped audit", async () => {
  const root = await tmpRoot();
  try {
    const result = await buildAndWriteMobileAuditReport({ root, auditData: { status: "pass", runId: "x" } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not an editor\.audit_mobile_assets payload/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildAndWriteMobileAuditReport returns a summary + top offenders + path, and the report is byte-identical to the CLI builder", async () => {
  const root = await tmpRoot();
  try {
    const audit = sampleAuditPayload();
    const result = await buildAndWriteMobileAuditReport({ root, auditData: audit });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const p = result.payload;

    // Always hardware-unvalidated; never a device-proven verdict.
    assert.equal(p.hardwareUnvalidated, true);
    assert.match(p.summary, /HARDWARE-UNVALIDATED/);
    assert.doesNotMatch(p.summary, /\bdone\b|device-proven|\bverified\b/i);

    // Output-size discipline: top offenders only (≤ 5), NO full findings blob, NO raw markdown.
    assert.ok(p.topOffenders.length <= 5);
    assert.ok(p.findingCount >= p.topOffenders.length);
    // The truncation is SELF-describing in the payload, not comment-described.
    assert.equal(p.offendersShown, p.topOffenders.length);
    assert.match(p.offendersNote, new RegExp(`showing ${p.offendersShown} of ${p.findingCount} finding\\(s\\)`));
    assert.ok(p.offendersNote.includes(p.reportPath), "the note must point at the full report file");
    assert.ok(!("findings" in (p as unknown as Record<string, unknown>)), "the full findings array must not be inline");
    assert.ok(!Object.values(p).some((v) => typeof v === "string" && v.includes("# Mobile Optimization Audit")), "no raw markdown blob inline");

    // The report file is written under .loombridge/reports/ and is byte-identical to the CLI builder.
    const jsonPath = path.join(root, p.reportPath);
    const written = await fs.readFile(jsonPath, "utf8");
    assert.equal(written, stableStringify(buildMobileAuditReport(audit, DEFAULT_THRESHOLDS)));
    await fs.stat(path.join(root, p.reportTextPath)); // markdown companion exists
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extractMobileAuditThresholds pulls only valid non-negative overrides", () => {
  const t = extractMobileAuditThresholds({ texture_cap: 1024, audio_long_seconds: -3, triangle_load_cap: 200000, shadow_distance_cap: "nope" });
  assert.equal(t.textureCap, 1024);
  assert.equal(t.triangleLoadCap, 200000);
  assert.equal(t.audioLongSeconds, undefined, "a negative value is rejected");
  assert.equal(t.shadowDistanceCap, undefined, "a non-number is rejected");
});

// ── (MED-1) per-call log sink: concurrent server logs never contaminate a verb ──

test("concurrent console output is NOT captured into a running verify's output and still reaches the real console", async () => {
  const root = await tmpRoot();
  const reached: string[] = [];
  const origError = console.error;
  // Stand-in for the REAL console during this test: anything not owned by the
  // verb's capture context must land here (pass-through), never be swallowed.
  console.error = (...a: unknown[]) => void reached.push(a.join(" "));
  try {
    await fakeCaptures(root);
    // Start the verify (its sync prefix installs the per-call patch), then emit a
    // concurrent server-style log from OUTSIDE the verb's async context while the
    // verb is still in flight — exactly the trace-recorder/disconnect shape.
    const inFlight = runLoombridgeVerifyTool(root);
    console.error("[loombridge] CONCURRENT-SERVER-LOG (trace write failed)");
    const payload = await inFlight;

    // The verb's verbatim output contains ONLY the gate's own lines...
    assert.ok(
      !payload.output.some((l) => l.includes("CONCURRENT-SERVER-LOG")),
      `concurrent log leaked into the verb output:\n${payload.output.join("\n")}`,
    );
    assert.ok(payload.output.some((l) => /REFUSED/.test(l)), "the gate's own lines are still captured");
    // ...and the concurrent log reached the real console (not swallowed)...
    assert.ok(reached.some((l) => l.includes("CONCURRENT-SERVER-LOG")), reached.join("\n"));
    // ...while none of the gate's lines escaped to the real console.
    assert.ok(!reached.some((l) => /REFUSED/.test(l)), reached.join("\n"));
  } finally {
    console.error = origError;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (MED-2) a thrown verb maps to the CLI's fatal tier, never a generic error ──

test("runLoombridgeVerifyTool maps a malformed-but-present ACCEPTANCE.json to a BROKEN row (tier 2), matching the bare CLI door", async () => {
  // UPDATED FOR S2c + F6 (a DELIBERATE tier change on the MCP path). The tool used to call
  // `runVerify` directly, where a malformed contract throws and the wrapper mapped it to the
  // CLI engine's fatal tier (1). It now runs the unified door, where the contract is ONE
  // asset among several: an unreadable one is a BROKEN row at the harness tier, so a project
  // with a good trace baseline still gets that trace checked. The parity target moves with
  // it, from the `--inputs` engine argv to bare `--root`, and the tier moves from 1 to 2.
  //
  // The invariant that did NOT change: a harness fault is never a game defect, and a fatal
  // out of the orchestrator maps to 2 in the tool exactly as it does in the CLI router.
  const rootMcp = await tmpRoot();
  const rootCli = await tmpRoot();
  try {
    for (const root of [rootMcp, rootCli]) {
      const paths = loombridgePaths(root);
      await fs.mkdir(paths.dir, { recursive: true });
      await fs.writeFile(paths.acceptance, "{ this is not json", "utf-8");
    }

    const payload = await runLoombridgeVerifyTool(rootMcp);
    assert.equal(payload.exitCode, 2, "a broken asset is the harness tier, never a game verdict");
    assert.equal(payload.refused, true, "F4: the report's own non-zero exit is the refusal");
    assert.match(payload.output.join("\n"), /contract '.*': BROKEN, will not run: .*is malformed/);
    assert.ok(
      !payload.output.some((l) => /\[loombridge verify\] fatal:/.test(l)),
      "the plan must survive one malformed asset rather than aborting as a fatal",
    );
    // Nothing executed, so nothing was graded and no verdict may be quoted.
    assert.equal(payload.verdictExists, false);
    assert.equal(payload.verdictStatus, null);
    assert.equal(payload.unifiedStatus, "nothing-checked");
    assert.equal(payload.unifiedExit, 2);

    // The same file through the bare CLI door: same tier, same story.
    const cli = await captureVerb(() => runVerifyCli(["--root", rootCli]));
    assert.equal(cli.code, payload.exitCode, "MCP and CLI must agree on the tier for the same broken contract");
    assert.match(cli.lines.join("\n"), /contract '.*': BROKEN, will not run: .*is malformed/);
  } finally {
    await fs.rm(rootMcp, { recursive: true, force: true });
    await fs.rm(rootCli, { recursive: true, force: true });
  }
});

test("BARE argv is orchestrator territory: a malformed ACCEPTANCE.json is a BROKEN asset row (tier 2), not a fatal", async () => {
  // A DECLARED tier change (RFC UnifiedVerify amendment A2). `verify --root X` is now the
  // unified front door, where the contract is ONE asset among several: a project with a
  // good trace baseline must still get that trace checked, so one unreadable file is a
  // broken ROW (harness tier 2), never a fatal that abandons the plan. The fatal tier is
  // unchanged on the engine path (`--inputs`) and for the MCP tool, pinned above.
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.acceptance, "{ this is not json", "utf-8");

    const cli = await captureVerb(() => runVerifyCli(["--root", root]));
    assert.equal(cli.code, 2, "a broken asset is the harness tier, never a game verdict");
    const text = cli.lines.join("\n");
    assert.match(text, /contract '.*': BROKEN, will not run: .*is malformed/);
    assert.ok(
      !/\[loombridge verify\] fatal:/.test(text),
      `the plan must survive one malformed asset:\n${text}`,
    );
    assert.equal(await fileExists(paths.verdict), false, "a broken row is tiered WITHOUT running the engine");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runLoombridgeDonenessTool maps a thrown verb (malformed SLICES.json) to the CLI's fatal tier", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(path.join(paths.dir, "SLICES.json"), "{ broken", "utf-8");

    const payload = await runLoombridgeDonenessTool(root);
    assert.equal(payload.exitCode, 1, "a thrown doneness is NOT done (CLI parity)");
    assert.equal(payload.done, false);
    assert.match(payload.headline, /\[loombridge doneness\] fatal:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
