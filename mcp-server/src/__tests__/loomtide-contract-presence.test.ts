/**
 * Refuse-on-missing-contract + bridge-surfaced discovery (dogfood core-hardening
 * Epic 0; RCL-P04 / RCL-P01). The gate verbs must REFUSE when there is no
 * acceptance contract — a hand-created `.loomtide/captures/` is not a
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
} from "../loomtide/contract-presence.js";
import { runVerify, run as runVerifyCli } from "../loomtide/verify.js";
import { runDoneness } from "../loomtide/doneness.js";
import { runPlan } from "../loomtide/plan.js";
import { computeStatusModel, renderDetailedStatus } from "../loomtide/status-model.js";
import { designStatus, setDesignTarget } from "../loomtide/design.js";
import { loomtidePaths, readState, writeState } from "../loomtide/state.js";
import { readSlicePlan } from "../loomtide/slices.js";
import {
  buildLoomtideStatusPayload,
  runLoomtideProjectInit,
  runLoomtideVerifyTool,
  runLoomtideDonenessTool,
  buildAndWriteMobileAuditReport,
  extractMobileAuditThresholds,
  LOOMTIDE_VERIFY_TOOL,
  LOOMTIDE_VERIFY_TOOL_NAME,
  LOOMTIDE_DONENESS_TOOL,
  LOOMTIDE_DONENESS_TOOL_NAME,
  LOOMTIDE_MOBILE_AUDIT_TOOL,
  LOOMTIDE_MOBILE_AUDIT_TOOL_NAME,
} from "../loomtide-bridge-tools.js";
import { LOOMTIDE_CORE_TOOLS } from "../index.js";
import {
  buildMobileAuditReport,
  stableStringify,
  DEFAULT_THRESHOLDS,
  type AuditPayload,
} from "../loomtide/mobile-audit-report.js";
import { OpRegistry } from "../op-registry.js";
import { writeApprovedAssetManifestForDesign } from "./helpers/asset-manifest-fixture.js";

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
  return fs.mkdtemp(path.join(os.tmpdir(), "loomtide-contract-presence-"));
}

/** Build a full approved roadmap so `.loomtide/SLICES.json` exists (mirrors the status test helper). */
async function scaffoldApprovedRoadmap(root: string): Promise<void> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const image = path.join(root, "src-hero.png");
  await fs.writeFile(image, "hero", "utf-8");
  await setDesignTarget({ root, imagePath: image, mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false });
}

/** Hand-create a `.loomtide/captures/` dir with a file but NO contract — RCL-P04. */
async function fakeCaptures(root: string): Promise<void> {
  const dir = path.join(root, ".loomtide", "captures");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "frame-0.json"), "{}\n", "utf-8");
}

function verifyArgs(root: string) {
  const paths = loomtidePaths(root);
  return {
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  };
}

async function statusModel(root: string) {
  const paths = loomtidePaths(root);
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
    const presence = await inspectContractPresence(loomtidePaths(root));
    assert.equal(presence.loomtideDirExists, true);
    assert.equal(presence.contractExists, false);
    assert.deepEqual(presence.capturePresentDirs, ["captures"]);
    assert.equal(presence.capturesWithoutContract, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("noContractRefusal names plan + the captures-are-not-a-verification trap", () => {
  const msg = noContractRefusal("/p/.loomtide/ACCEPTANCE.json", ["captures"]);
  assert.match(msg, /No acceptance contract found at \/p\/\.loomtide\/ACCEPTANCE\.json/);
  assert.match(msg, /loomtide plan/);
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
    assert.ok(lines.some((l) => /REFUSED/.test(l) && /loomtide plan/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /NOT a verification/.test(l)), lines.join("\n"));
    // No verdict file may be written by a refused verify.
    await assert.rejects(fs.stat(loomtidePaths(root).verdict));
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
    assert.ok(lines.some((l) => /NOT done/.test(l) && /loomtide plan/.test(l)), lines.join("\n"));
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
    // With a contract present but no captured inputs, verify proceeds to grade
    // (it FAILs the gates) — the point is it does NOT short-circuit as a contract refusal.
    const code = await runVerify(verifyArgs(root));
    console.error = original;
    assert.notEqual(code, 2, "a present contract must not be treated as missing");
    // A real verdict file IS written when the contract is present (refusal writes none).
    await fs.stat(loomtidePaths(root).verdict);
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

test("loomtide_status payload: no contract → run plan, never verifiedGreen on captures", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await buildLoomtideStatusPayload(root);
    assert.equal(payload.contractExists, false);
    assert.equal(payload.capturesWithoutContract, true);
    assert.equal(payload.verifiedGreen, false);
    assert.equal(payload.nextStep, "loomtide plan");
    assert.match(payload.summary, /NO acceptance contract|not a verification/i);
    assert.equal(payload.contractPath, path.join(".loomtide", "ACCEPTANCE.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loomtide_status payload: a planned project reports contract present", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const payload = await buildLoomtideStatusPayload(root);
    assert.equal(payload.contractExists, true);
    assert.notEqual(payload.nextStep, "loomtide plan");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loomtide_project_init scaffolds .loomtide/ idempotently without fabricating a contract", async () => {
  const root = await tmpRoot();
  try {
    const first = await runLoomtideProjectInit(root);
    assert.equal(first.created, true);
    assert.equal(first.loomtideDirExists, true);
    // Init must NOT invent a contract or a verified state.
    assert.equal(first.contractExists, false);
    assert.equal(first.verifiedGreen, false);
    assert.equal(first.nextStep, "loomtide plan");
    await fs.stat(path.join(root, ".loomtide"));

    const second = await runLoomtideProjectInit(root);
    assert.equal(second.created, false, "init is idempotent");
    assert.equal(second.contractExists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loomtide_project_init is non-destructive: it never rewrites an existing contract", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const acceptance = loomtidePaths(root).acceptance;
    const before = await fs.readFile(acceptance, "utf-8");
    const result = await runLoomtideProjectInit(root);
    assert.equal(result.created, false, "init on an existing .loomtide/ does not 'create' it");
    assert.equal(result.contractExists, true);
    const after = await fs.readFile(acceptance, "utf-8");
    assert.equal(after, before, "existing ACCEPTANCE.json bytes must be untouched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── (MED fix) verifiedGreen is bound to the doneness gate, not a forgeable marker ─

test("loomtide_status verifiedGreen is TRUE for a real runId-bound fresh-green verdict", async () => {
  const root = await tmpRoot();
  try {
    // A single plan (design phase) gives us a VALID ACCEPTANCE.json but no
    // SLICES.json, so the whole-game freshness path (the forgeable-phase one) runs.
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loomtidePaths(root);

    const runId = "run-green-1";
    const startedAt = "2026-05-28T00:00:00.000Z";
    const producedAt = "2026-05-28T01:00:00.000Z";
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "verified-green",
      currentBuild: { runId, startedAt, captureManifest: [] },
      lastVerdict: { status: "pass", at: producedAt, verdictPath: ".loomtide/reports/build-verdict.json" },
      updatedAt: producedAt,
    });
    await fs.mkdir(paths.reports, { recursive: true });
    await fs.writeFile(paths.verdict, JSON.stringify({ status: "pass", runId, producedAt }), "utf-8");

    const payload = await buildLoomtideStatusPayload(root);
    assert.equal(payload.verifiedGreen, true, "a fresh runId-bound green verdict must read as verifiedGreen");
    assert.equal(payload.nextStep, "loomtide doneness");
    assert.match(payload.summary, /fresh, runId-bound verify is green/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loomtide_status verifiedGreen is FALSE for a forged STATE.phase + empty {} contract", async () => {
  const root = await tmpRoot();
  try {
    const paths = loomtidePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    // Bare-existence contract (passes a naive file check, fails a parse-valid check).
    await fs.writeFile(paths.acceptance, "{}", "utf-8");
    // Hand-edited "verified-green" marker with NO currentBuild and NO verdict.
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "verified-green",
      lastVerdict: { status: "pass", at: "2026-05-28T01:00:00.000Z", verdictPath: ".loomtide/reports/build-verdict.json" },
      updatedAt: "2026-05-28T01:00:00.000Z",
    });

    const payload = await buildLoomtideStatusPayload(root);
    assert.equal(payload.contractExists, true, "the (empty) file does exist");
    assert.equal(payload.phase, "verified-green");
    // ...but the doneness gate refuses it, so the bridge must NOT report green.
    assert.equal(payload.verifiedGreen, false, "a forged phase + empty contract must never read as verifiedGreen");
    assert.notEqual(payload.nextStep, "loomtide doneness");
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
    const paths = loomtidePaths(root);
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
  const names = new Set(LOOMTIDE_CORE_TOOLS.map((t) => t.name));
  assert.ok(names.has(LOOMTIDE_VERIFY_TOOL_NAME), "loomtide_verify must be served");
  assert.ok(names.has(LOOMTIDE_DONENESS_TOOL_NAME), "loomtide_doneness must be served");
  assert.ok(names.has(LOOMTIDE_MOBILE_AUDIT_TOOL_NAME), "loomtide_mobile_audit must be served");
});

test("workflow verb tools are MCP-layer tools, NOT bridge ops (op count is untouched)", () => {
  const opToolNames = new Set(new OpRegistry().toMCPTools().map((t) => t.name));
  for (const n of [LOOMTIDE_VERIFY_TOOL_NAME, LOOMTIDE_DONENESS_TOOL_NAME, LOOMTIDE_MOBILE_AUDIT_TOOL_NAME]) {
    assert.ok(!opToolNames.has(n), `${n} must not be a bridge op`);
  }
});

test("each workflow verb tool description LEADS with the moment-of-need trigger", () => {
  // The description is the discoverability surface — it must open with WHEN to reach for it.
  assert.match(LOOMTIDE_VERIFY_TOOL.description, /^Run BEFORE claiming a build is done/);
  assert.match(LOOMTIDE_DONENESS_TOOL.description, /^Run BEFORE handing off or shipping/);
  assert.match(LOOMTIDE_MOBILE_AUDIT_TOOL.description, /^Run BEFORE shipping to mobile/);
});

// ── loomtide_verify wrapper: verbatim, refusal-is-the-headline, no fake pass ───

test("runLoomtideVerifyTool REFUSES (exit 2) with a verbatim headline when no contract exists", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await runLoomtideVerifyTool(root);
    assert.equal(payload.exitCode, 2, "missing contract must exit 2 (refusal)");
    assert.equal(payload.refused, true);
    assert.match(payload.headline, /REFUSED/);
    assert.match(payload.headline, /loomtide plan/);
    // The full gate output is surfaced verbatim — nothing hides the refusal.
    assert.ok(payload.output.some((l) => /NOT a verification/.test(l)), payload.output.join("\n"));
    // A refused verify writes NO verdict (never a fake pass).
    assert.equal(payload.verdictExists, false);
    assert.equal(payload.verdictStatus, null);
    await assert.rejects(fs.stat(loomtidePaths(root).verdict));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runLoomtideVerifyTool surfaces the CLI output byte-for-byte (no summarization)", async () => {
  const rootA = await tmpRoot();
  const rootB = await tmpRoot();
  try {
    await fakeCaptures(rootA);
    await fakeCaptures(rootB);
    // Direct CLI code path (captured the way the CLI prints) vs the MCP wrapper.
    const direct = await captureVerb(() => runVerify(verifyArgs(rootA)));
    const wrapped = await runLoomtideVerifyTool(rootB);
    // Normalize the only difference (the temp root path) so we compare the message text.
    const norm = (l: string) => l.replace(rootA, "ROOT").replace(rootB, "ROOT");
    assert.deepEqual(wrapped.output.map(norm), direct.lines.map(norm), "wrapper must surface the CLI lines verbatim");
    assert.equal(wrapped.exitCode, direct.code);
  } finally {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  }
});

test("runLoomtideVerifyTool does NOT refuse once a contract exists (writes a real verdict)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const payload = await runLoomtideVerifyTool(root);
    assert.notEqual(payload.exitCode, 2, "a present contract must not read as a missing-contract refusal");
    assert.equal(payload.refused, false);
    // A present contract writes a verdict (a refusal writes none).
    assert.equal(payload.verdictExists, true);
    assert.ok(payload.verdictStatus, "verdict status must be surfaced from disk");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── loomtide_doneness wrapper: refusal-is-the-headline, cannot be talked into done ─

test("runLoomtideDonenessTool is NOT done (exit 1) + refuses verbatim when no contract exists", async () => {
  const root = await tmpRoot();
  try {
    await fakeCaptures(root);
    const payload = await runLoomtideDonenessTool(root);
    assert.equal(payload.exitCode, 1, "no contract is NOT done");
    assert.equal(payload.done, false);
    assert.equal(payload.refused, true);
    assert.match(payload.headline, /NOT done/);
    assert.ok(payload.output.some((l) => /loomtide plan/.test(l)), payload.output.join("\n"));
    assert.ok(payload.output.some((l) => /NOT a verification/.test(l)), payload.output.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── loomtide_mobile_audit builder: report-to-file + summary, no blob inline ────

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

    // The report file is written under .loomtide/reports/ and is byte-identical to the CLI builder.
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
    const inFlight = runLoomtideVerifyTool(root);
    console.error("[loomtide] CONCURRENT-SERVER-LOG (trace write failed)");
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

test("runLoomtideVerifyTool maps a malformed-but-present ACCEPTANCE.json to a structured RED (fatal tier), matching the CLI", async () => {
  const rootMcp = await tmpRoot();
  const rootCli = await tmpRoot();
  try {
    // Present but unparseable contract: runVerify throws from the contract read.
    for (const root of [rootMcp, rootCli]) {
      const paths = loomtidePaths(root);
      await fs.mkdir(paths.dir, { recursive: true });
      await fs.writeFile(paths.acceptance, "{ this is not json", "utf-8");
    }

    // MCP wrapper: STRUCTURED red — exit 1, fatal headline, no verdict, not a refusal.
    const payload = await runLoomtideVerifyTool(rootMcp);
    assert.equal(payload.exitCode, 1, "a thrown verb is the fail tier (CLI parity), not a generic error");
    assert.equal(payload.refused, false, "a fatal is a RED, not the missing-contract refusal");
    assert.match(payload.headline, /\[loomtide verify\] fatal:/);
    assert.equal(payload.verdictExists, false);
    assert.equal(payload.verdictStatus, null);

    // The same file through the CLI path produces the matching tier + message.
    const cli = await captureVerb(() => runVerifyCli(["--root", rootCli]));
    assert.equal(cli.code, payload.exitCode, "MCP and CLI must agree on the tier for the same broken contract");
    const cliFatal = cli.lines.find((l) => /\[loomtide verify\] fatal:/.test(l));
    assert.ok(cliFatal, cli.lines.join("\n"));
    assert.equal(payload.headline.replace(rootMcp, "ROOT"), cliFatal.replace(rootCli, "ROOT"));
  } finally {
    await fs.rm(rootMcp, { recursive: true, force: true });
    await fs.rm(rootCli, { recursive: true, force: true });
  }
});

test("runLoomtideDonenessTool maps a thrown verb (malformed SLICES.json) to the CLI's fatal tier", async () => {
  const root = await tmpRoot();
  try {
    const paths = loomtidePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(path.join(paths.dir, "SLICES.json"), "{ broken", "utf-8");

    const payload = await runLoomtideDonenessTool(root);
    assert.equal(payload.exitCode, 1, "a thrown doneness is NOT done (CLI parity)");
    assert.equal(payload.done, false);
    assert.match(payload.headline, /\[loomtide doneness\] fatal:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
