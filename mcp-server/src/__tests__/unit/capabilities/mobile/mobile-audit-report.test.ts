/**
 * Mobile-audit report (dogfood learnings §9 / backlog High #5): heuristics fire on synthetic
 * editor.audit_mobile_assets payloads, hand-computed triangle_load ordering, truncation
 * surfacing, and the ALWAYS-present hardware-unvalidated stamp (there is no device-proven
 * code path). Findings are advisory — the report never emits a pass/fail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMobileAuditReport,
  renderMobileAuditReportText,
  stableStringify,
  validateAuditPayloadKind,
  HARDWARE_UNVALIDATED_RULE,
  AUDIT_PAYLOAD_KIND,
  DEFAULT_THRESHOLDS,
  type AuditPayload,
} from "../../../../capabilities/mobile/mobile-audit-report.js";

// A representative payload: one oversize texture, one at-cap texture, one long
// DecompressOnLoad clip, the §9 wall (30.7k tris × 57 instances) plus a light prop,
// and a high shadow distance.
function samplePayload(): AuditPayload {
  return {
    payload_kind: "mobile_asset_audit",
    payload_version: 1,
    max_entries: 50,
    loaded_scene_count: 1,
    loaded_scenes: ["Assets/Scenes/Arena.unity"],
    textures: {
      total_count: 3,
      truncated: false,
      entries: [
        { path: "Assets/Tex/wall_4k.png", name: "wall_4k", width: 4096, height: 4096, format: "RGBA32", compression: "Uncompressed", estimated_bytes: 67108864 },
        { path: "Assets/Tex/ground_2k.png", name: "ground_2k", width: 2048, height: 2048, format: "DXT5", compression: "Compressed", estimated_bytes: 5592405 },
        { path: "Assets/Tex/icon.png", name: "icon", width: 256, height: 256, format: "DXT5", compression: "Compressed", estimated_bytes: 87381 },
      ],
    },
    audio: {
      total_count: 2,
      truncated: false,
      entries: [
        { path: "Assets/Audio/music_loop.wav", name: "music_loop", length_seconds: 92.5, channels: 2, frequency: 44100, load_type: "DecompressOnLoad", compression_format: "PCM", file_bytes: 16321500 },
        { path: "Assets/Audio/blip.wav", name: "blip", length_seconds: 0.3, channels: 1, frequency: 44100, load_type: "DecompressOnLoad", compression_format: "PCM", file_bytes: 26460 },
      ],
    },
    meshes: {
      total_count: 2,
      truncated: false,
      unreadable_count: 0,
      entries: [
        // The §9 wall: 30_700 tris × 57 = 1_749_900 triangle_load.
        { path: "Assets/Mesh/twall.fbx", name: "TWall", vertex_count: 18000, triangle_count: 30700, instance_count: 57, triangle_load: 1749900 },
        { path: "Assets/Mesh/crate.fbx", name: "Crate", vertex_count: 24, triangle_count: 12, instance_count: 3, triangle_load: 36 },
      ],
    },
    quality_settings: {
      level_name: "High",
      shadow_distance: 150,
      shadow_resolution: "High",
      shadow_cascades: 4,
      msaa: 4,
      vsync_count: 1,
      pixel_light_count: 4,
    },
    render_pipeline_settings: null,
    build_scenes: [{ path: "Assets/Scenes/Arena.unity", enabled: true }],
  };
}

test("mobile-audit: hardware-unvalidated stamp is ALWAYS present (verbatim §9 rule)", () => {
  const report = buildMobileAuditReport(samplePayload());
  assert.equal(report.hardwareUnvalidated, true);
  assert.equal(report.hardwareUnvalidatedRule, HARDWARE_UNVALIDATED_RULE);
  assert.match(report.hardwareUnvalidatedRule, /theory-sound until a real device build proves frame rate, memory, and post-processing cost/);
});

test("mobile-audit: hardware-unvalidated stamp is present even with an EMPTY payload (no device-proven path)", () => {
  const report = buildMobileAuditReport({});
  assert.equal(report.hardwareUnvalidated, true);
  assert.equal(report.hardwareUnvalidatedRule, HARDWARE_UNVALIDATED_RULE);
  assert.equal(report.findings.length, 0, "empty payload yields no findings");
});

test("mobile-audit: texture heuristic flags >cap oversize and at-cap review, ignores small", () => {
  const report = buildMobileAuditReport(samplePayload());
  const tex = report.findings.filter((f) => f.category === "texture");
  const oversize = tex.find((f) => f.id === "texture-oversize");
  const atCap = tex.find((f) => f.id === "texture-at-cap-review");
  assert.ok(oversize, "4096 texture flagged as oversize (high)");
  assert.equal(oversize!.severity, "high");
  assert.equal(oversize!.subject, "Assets/Tex/wall_4k.png");
  assert.ok(atCap, "2048 texture flagged for review (advisory)");
  assert.equal(atCap!.severity, "advisory");
  // The 256px icon must NOT produce a finding.
  assert.ok(!tex.some((f) => f.subject === "Assets/Tex/icon.png"), "256px icon is not flagged");
});

test("mobile-audit: audio heuristic flags long DecompressOnLoad, ignores short", () => {
  const report = buildMobileAuditReport(samplePayload());
  const audio = report.findings.filter((f) => f.category === "audio");
  assert.equal(audio.length, 1, "only the 92.5s music loop is flagged");
  assert.equal(audio[0].id, "audio-decompress-long-clip");
  assert.equal(audio[0].subject, "Assets/Audio/music_loop.wav");
  assert.equal(audio[0].severity, "high");
  assert.match(audio[0].rationale, /do not decompress music\/ambience\/enemy loops to raw PCM at load/);
});

test("mobile-audit: audio heuristic does NOT flag a Compressed (non-DecompressOnLoad) long clip", () => {
  const payload = samplePayload();
  payload.audio!.entries[0].load_type = "CompressedInMemory";
  const report = buildMobileAuditReport(payload);
  assert.equal(report.findings.filter((f) => f.category === "audio").length, 0);
});

test("mobile-audit: mesh triangle_load flags the 57× wall, not the light prop", () => {
  const report = buildMobileAuditReport(samplePayload());
  const mesh = report.findings.filter((f) => f.category === "mesh");
  assert.equal(mesh.length, 1, "only the wall exceeds the triangle_load cap");
  assert.equal(mesh[0].id, "mesh-triangle-load");
  assert.equal(mesh[0].subject, "Assets/Mesh/twall.fbx");
  // Hand-computed: 30_700 × 57 = 1_749_900, reflected in the detail line.
  assert.match(mesh[0].detail, /30700 tris × 57 instances = 1749900 triangle_load/);
});

test("mobile-audit: totals maxTriangleLoad equals the hand-computed wall load", () => {
  const report = buildMobileAuditReport(samplePayload());
  assert.equal(report.totals.meshes.maxTriangleLoad, 1749900);
  assert.equal(report.totals.meshes.count, 2);
  // Texture estimated-bytes total = 67108864 + 5592405 + 87381.
  assert.equal(report.totals.textures.estimatedBytes, 67108864 + 5592405 + 87381);
});

test("mobile-audit: shadow-distance heuristic prefers the URP asset value over quality level", () => {
  const payload = samplePayload();
  // Quality level 150 → flagged.
  let report = buildMobileAuditReport(payload);
  const q = report.findings.find((f) => f.category === "shadow");
  assert.ok(q, "quality-level 150 shadow distance flagged");
  assert.match(q!.subject, /quality level shadow_distance/);

  // With a URP asset present, its (small) shadow distance overrides → no finding.
  payload.render_pipeline_settings = { asset_type: "UniversalRenderPipelineAsset", shadow_distance: 20 };
  report = buildMobileAuditReport(payload);
  assert.ok(!report.findings.some((f) => f.category === "shadow"), "URP asset 20 overrides quality 150 → under budget");

  // A large URP shadow distance is flagged and labelled 'URP asset'.
  payload.render_pipeline_settings = { asset_type: "UniversalRenderPipelineAsset", shadow_distance: 200 };
  report = buildMobileAuditReport(payload);
  const u = report.findings.find((f) => f.category === "shadow");
  assert.ok(u, "URP asset 200 shadow distance flagged");
  assert.match(u!.subject, /URP asset shadow_distance/);
});

test("mobile-audit: findings sort high-severity-first then by subject (deterministic)", () => {
  const report = buildMobileAuditReport(samplePayload());
  // All 'high' findings precede all 'advisory' findings.
  let seenAdvisory = false;
  for (const f of report.findings) {
    if (f.severity === "advisory") seenAdvisory = true;
    else assert.ok(!seenAdvisory, "no 'high' finding may appear after an 'advisory' one");
  }
});

test("mobile-audit: custom thresholds change what fires", () => {
  // Raise the texture cap above 4096 → the oversize texture no longer fires,
  // and 2048 is no longer at-cap.
  const report = buildMobileAuditReport(samplePayload(), { ...DEFAULT_THRESHOLDS, textureCap: 8192 });
  assert.ok(!report.findings.some((f) => f.category === "texture"), "no texture findings when cap is 8192");
});

test("mobile-audit: truncation flag is surfaced in totals and text", () => {
  const payload = samplePayload();
  payload.meshes!.truncated = true;
  payload.meshes!.total_count = 999;
  const report = buildMobileAuditReport(payload);
  assert.equal(report.totals.meshes.truncated, true);
  assert.equal(report.totals.meshes.count, 999);
  const text = renderMobileAuditReportText(report);
  assert.match(text, /Meshes: 999 \(truncated\)/);
});

test("mobile-audit: rendered text carries the hardware-unvalidated banner and no pass/fail", () => {
  const text = renderMobileAuditReportText(buildMobileAuditReport(samplePayload()));
  assert.match(text, /HARDWARE-UNVALIDATED/);
  assert.match(text, /theory-sound until a real device build proves frame rate, memory, and post-processing cost/);
  assert.match(text, /makes no pass\/fail or done judgment/);
});

test("mobile-audit: empty-payload text says not device-proven, never 'pass'", () => {
  const text = renderMobileAuditReportText(buildMobileAuditReport({}));
  assert.match(text, /No entries exceeded the tuned heuristics/);
  assert.match(text, /not a device-proven pass/);
});

test("mobile-audit: validator accepts a stamped payload", () => {
  assert.deepEqual(validateAuditPayloadKind(samplePayload()), { ok: true });
  assert.equal(AUDIT_PAYLOAD_KIND, "mobile_asset_audit");
});

test("mobile-audit: validator REFUSES a payload without payload_kind, naming its keys", () => {
  // The D1 incident shape: pointing --input at build-verdict.json must refuse, not
  // render a clean "no findings" audit.
  const verdictish = { status: "green", producedAt: "2026-07-01T00:00:00Z", reviewFindings: [] };
  const result = validateAuditPayloadKind(verdictish);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no `payload_kind` field/);
    assert.match(result.error, /status, producedAt, reviewFindings/, "names what WAS found");
  }
});

test("mobile-audit: validator REFUSES a wrong payload_kind, naming what was found", () => {
  const result = validateAuditPayloadKind({ payload_kind: "build_verdict" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /payload_kind is "build_verdict"/);
    assert.match(result.error, /expected "mobile_asset_audit"/);
  }
});

test("mobile-audit: validator REFUSES an unsupported payload_version and non-objects", () => {
  const badVersion = validateAuditPayloadKind({ payload_kind: "mobile_asset_audit", payload_version: 2 });
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.match(badVersion.error, /unsupported payload_version 2/);
  assert.equal(validateAuditPayloadKind(null).ok, false);
  assert.equal(validateAuditPayloadKind([1, 2]).ok, false);
  assert.equal(validateAuditPayloadKind("x").ok, false);
});

test("mobile-audit: unreadable_count > 0 surfaces a HIGH blind-spot finding", () => {
  const payload = samplePayload();
  payload.meshes!.unreadable_count = 2;
  payload.meshes!.entries.push({
    path: "Assets/Mesh/mystery.fbx", name: "Mystery", vertex_count: 5000,
    triangle_count: null, instance_count: 40, triangle_load: null, reason: "triangle count unavailable: boom",
  });
  const report = buildMobileAuditReport(payload);
  const f = report.findings.find((x) => x.id === "mesh-triangle-count-missing");
  assert.ok(f, "blind-spot finding present");
  assert.equal(f!.severity, "high");
  assert.match(f!.detail, /2 mesh\(es\) could not be counted/);
  assert.match(f!.detail, /the audit may be missing offenders/);
  assert.equal(report.totals.meshes.unreadableCount, 2);
  const text = renderMobileAuditReportText(report);
  assert.match(text, /2 uncounted/, "totals line surfaces the uncounted tally");
});

test("mobile-audit: unreadable_count 0 (or absent) yields NO blind-spot finding", () => {
  const zero = buildMobileAuditReport(samplePayload());
  assert.ok(!zero.findings.some((f) => f.id === "mesh-triangle-count-missing"));
  assert.equal(zero.totals.meshes.unreadableCount, 0);
  const absent = samplePayload();
  delete absent.meshes!.unreadable_count;
  assert.ok(!buildMobileAuditReport(absent).findings.some((f) => f.id === "mesh-triangle-count-missing"));
});

test("mobile-audit: oversize-texture rationale states role is not determinable (D4)", () => {
  const report = buildMobileAuditReport(samplePayload());
  const f = report.findings.find((x) => x.id === "texture-oversize");
  assert.ok(f);
  assert.match(f!.rationale, /Texture role is not determinable from measured data/);
  assert.match(f!.rationale, /Docs\/Assets\/GeneratedArtWorkflow\.md/);
});

test("mobile-audit: stableStringify is deterministic and key-sorted", () => {
  const report = buildMobileAuditReport(samplePayload());
  const a = stableStringify(report);
  const b = stableStringify(buildMobileAuditReport(samplePayload()));
  assert.equal(a, b, "identical input yields byte-identical output under the same build");
  // Keys sorted: 'findings' precedes 'hardwareUnvalidated' precedes 'producedBy' at top level.
  const idxFindings = a.indexOf('"findings"');
  const idxHw = a.indexOf('"hardwareUnvalidated"');
  const idxProduced = a.indexOf('"producedBy"');
  assert.ok(idxFindings < idxHw && idxHw < idxProduced, "top-level keys are sorted");
});
