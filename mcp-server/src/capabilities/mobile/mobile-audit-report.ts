/**
 * Mobile-optimization audit report (the late-polish dogfood learnings §9 "Mobile
 * Optimization Should Start With An Audit"; backlog High #5). Pure, deterministic
 * translation of the `editor.audit_mobile_assets` bridge payload into ADVISORY
 * findings — sizes and heuristics only.
 *
 * HARD RULE (§9, verbatim): a mobile-optimization pass is "theory-sound until a real
 * device build proves frame rate, memory, and post-processing cost". There is NO code
 * path in this module that emits device-proven: every report is stamped
 * `hardwareUnvalidated: true` with that rule attached. Device proof requires future
 * device evidence that this offline report cannot have.
 *
 * NO PASS/FAIL. This report never judges done/not-done — it lists weight and flags
 * offenders against tunable heuristics so a human can decide what to optimize BEFORE
 * touching anything (the §9 incident: a 30.7k-tri wall instanced 57× was the real cost,
 * not the textures that took the blame — measure first).
 *
 * DETERMINISM: byte-identical for identical input under the same build. `producedBy`
 * embeds the producing build's version/commit (provenance) and so varies across builds;
 * everything else is a pure function of the input payload + thresholds.
 */

import { resolveBuildStamp, formatBuildStamp } from "../../shared/build-stamp.js";

/** The §9 hardware-unvalidated rule, verbatim — attached to every report, always. */
export const HARDWARE_UNVALIDATED_RULE =
  "theory-sound until a real device build proves frame rate, memory, and post-processing cost";

/** Tunable heuristic thresholds (each doc-motivated; all overridable from the CLI). */
export interface MobileAuditThresholds {
  /** Texture max-dimension cap; a texture larger than this is flagged unless justified (§9: cap by what the camera resolves, keep 2048 only for fullscreen/ground). */
  textureCap: number;
  /** A DecompressOnLoad clip longer than this (seconds) is flagged (§9: compress long loops in memory, do not decompress music/ambience/enemy loops to raw PCM at load). */
  audioLongSeconds: number;
  /** A shared mesh whose triangle_load (tris × instances) exceeds this is flagged (§9: optimize high-frequency instanced meshes before isolated props — the 57× wall). */
  triangleLoadCap: number;
  /** Real-time shadow distance beyond this is flagged as a per-frame mobile cost (§9: URP shadow settings are part of the weight audit). */
  shadowDistanceCap: number;
}

export const DEFAULT_THRESHOLDS: MobileAuditThresholds = {
  textureCap: 2048,
  audioLongSeconds: 5,
  triangleLoadCap: 500_000,
  shadowDistanceCap: 50,
};

export type Severity = "high" | "advisory";

export interface Finding {
  /** Stable finding id (e.g. `texture-oversize`). */
  id: string;
  severity: Severity;
  category: "texture" | "audio" | "mesh" | "shadow";
  /** The asset path / setting the finding is about. */
  subject: string;
  /** What was measured (numbers only). */
  detail: string;
  /** The §9 rationale, quoted, that motivates the flag. */
  rationale: string;
}

// ─── Input payload shape (editor.audit_mobile_assets) — permissive parsing ───

interface TextureEntry {
  path: string; name: string; width: number; height: number;
  format: string | null; compression: string | null; estimated_bytes: number;
}
interface AudioEntry {
  path: string; name: string; length_seconds: number; channels: number; frequency: number;
  load_type: string | null; compression_format: string | null; file_bytes: number | null;
}
interface MeshEntry {
  path: string; name: string; vertex_count: number;
  triangle_count: number | null; instance_count: number; triangle_load: number | null;
  /** Present when triangle_count is null: WHY the count is missing (a visible blind spot). */
  reason?: string;
}
interface Category<T> { entries: T[]; total_count: number; truncated: boolean; }
interface MeshCategory extends Category<MeshEntry> {
  /** Entries whose triangle count could not be obtained (null triangle_count + reason). */
  unreadable_count?: number;
}

/** The discriminator the bridge op stamps into every audit payload. */
export const AUDIT_PAYLOAD_KIND = "mobile_asset_audit";
export const AUDIT_PAYLOAD_VERSION = 1;

export interface AuditPayload {
  payload_kind?: string;
  payload_version?: number;
  max_entries?: number;
  loaded_scene_count?: number;
  loaded_scenes?: string[];
  textures?: Category<TextureEntry>;
  audio?: Category<AudioEntry>;
  meshes?: MeshCategory;
  quality_settings?: {
    level_name?: string | null; shadow_distance?: number; shadow_resolution?: string;
    shadow_cascades?: number; msaa?: number; vsync_count?: number; pixel_light_count?: number;
  };
  render_pipeline_settings?: {
    asset_type?: string; shadow_distance?: number; msaa_sample_count?: number;
    render_scale?: number; supports_hdr?: boolean;
    main_light_shadow_resolution?: number; shadow_cascade_count?: number;
  } | null;
  build_scenes?: { path: string; enabled: boolean }[];
}

export interface MobileAuditReport {
  schemaVersion: "1";
  /** ALWAYS true — see HARDWARE_UNVALIDATED_RULE. No code path sets it false. */
  hardwareUnvalidated: true;
  hardwareUnvalidatedRule: string;
  producedBy: string;
  thresholds: MobileAuditThresholds;
  scope: {
    loadedSceneCount: number;
    loadedScenes: string[];
    note: string;
  };
  totals: {
    textures: { count: number; truncated: boolean; estimatedBytes: number };
    audio: { count: number; truncated: boolean; fileBytes: number };
    meshes: { count: number; truncated: boolean; maxTriangleLoad: number; unreadableCount: number };
  };
  findings: Finding[];
}

const SCOPE_NOTE =
  "Weight measured only from components in the currently-loaded scenes (the gameplay working set); " +
  "disk assets no loaded scene references are not walked. Category entries are the bridge op's " +
  "top-N (max_entries), so a finding reflects what was returned, not necessarily every asset.";

/**
 * Refuse anything that is not a stamped `editor.audit_mobile_assets` payload. Without
 * this gate, pointing --input at the wrong JSON file (e.g. build-verdict.json) would
 * render "No entries exceeded the tuned heuristics" — a wrong file reading as a clean
 * audit. The error NAMES what was found instead so the mistake is diagnosable.
 */
export function validateAuditPayloadKind(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj["payload_kind"];
  if (kind === undefined) {
    const keys = Object.keys(obj).slice(0, 8).join(", ");
    return {
      ok: false,
      error:
        `not an editor.audit_mobile_assets payload: no \`payload_kind\` field ` +
        `(top-level keys found: ${keys || "(none)"}). Save the bridge op's JSON response and --input that file.`,
    };
  }
  if (kind !== AUDIT_PAYLOAD_KIND) {
    return {
      ok: false,
      error: `not an editor.audit_mobile_assets payload: payload_kind is ${JSON.stringify(kind)}, expected "${AUDIT_PAYLOAD_KIND}".`,
    };
  }
  const version = obj["payload_version"];
  if (version !== undefined && version !== AUDIT_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: `unsupported payload_version ${JSON.stringify(version)} (this build reads version ${AUDIT_PAYLOAD_VERSION}).`,
    };
  }
  return { ok: true };
}

/** Sum a numeric field over entries, treating null/undefined as 0. */
function sumField(entries: readonly unknown[] | undefined, field: string): number {
  if (!entries) return 0;
  let total = 0;
  for (const e of entries) {
    const v = (e as Record<string, unknown>)[field];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

function maxField(entries: readonly unknown[] | undefined, field: string): number {
  if (!entries) return 0;
  let m = 0;
  for (const e of entries) {
    const v = (e as Record<string, unknown>)[field];
    if (typeof v === "number" && Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/**
 * Build the deterministic advisory report from an audit payload. Findings are sorted
 * high-severity-first, then by subject path/name, for a stable ordering.
 */
export function buildMobileAuditReport(
  payload: AuditPayload,
  thresholds: MobileAuditThresholds = DEFAULT_THRESHOLDS,
  moduleUrl?: string,
): MobileAuditReport {
  const findings: Finding[] = [];

  // ── Textures: cap by what the camera can resolve, not source-asset prestige ──
  for (const t of payload.textures?.entries ?? []) {
    const maxDim = Math.max(t.width ?? 0, t.height ?? 0);
    if (maxDim > thresholds.textureCap) {
      findings.push({
        id: "texture-oversize",
        severity: "high",
        category: "texture",
        subject: t.path,
        detail: `${t.width}×${t.height} (max ${maxDim}px > cap ${thresholds.textureCap}px), ~${t.estimated_bytes} bytes, format ${t.format ?? "?"}/${t.compression ?? "?"}`,
        rationale:
          "Cap textures by what the gameplay camera can resolve, not by source-asset prestige. Keep 2048 only for " +
          "fullscreen/ground-scale surfaces when needed. Texture role is not determinable from measured data — " +
          "confirm this texture's role against your project's own caps before acting.",
      });
    } else if (maxDim === thresholds.textureCap && thresholds.textureCap >= 2048) {
      findings.push({
        id: "texture-at-cap-review",
        severity: "advisory",
        category: "texture",
        subject: t.path,
        detail: `${t.width}×${t.height} (at cap ${thresholds.textureCap}px), ~${t.estimated_bytes} bytes`,
        rationale:
          "Keep 2048 only for fullscreen/ground-scale surfaces when needed — justify a 2048 texture against what the gameplay camera resolves.",
      });
    }
  }

  // ── Audio: do not decompress long loops to raw PCM at load ──
  for (const a of payload.audio?.entries ?? []) {
    if (a.load_type === "DecompressOnLoad" && (a.length_seconds ?? 0) > thresholds.audioLongSeconds) {
      findings.push({
        id: "audio-decompress-long-clip",
        severity: "high",
        category: "audio",
        subject: a.path,
        detail: `${a.length_seconds.toFixed(2)}s, ${a.channels}ch, load_type=DecompressOnLoad, ${a.compression_format ?? "?"}, ${a.file_bytes ?? "?"} file bytes`,
        rationale:
          "Compress long loops in memory; do not decompress music/ambience/enemy loops to raw PCM at load.",
      });
    }
  }

  // ── Meshes: optimize high-frequency instanced meshes before isolated props ──
  for (const m of payload.meshes?.entries ?? []) {
    if (typeof m.triangle_load === "number" && m.triangle_load > thresholds.triangleLoadCap) {
      findings.push({
        id: "mesh-triangle-load",
        severity: "high",
        category: "mesh",
        subject: m.path,
        detail: `${m.triangle_count ?? "?"} tris × ${m.instance_count} instances = ${m.triangle_load} triangle_load (> cap ${thresholds.triangleLoadCap})`,
        rationale:
          "Optimize high-frequency instanced meshes before isolated props — a modest mesh instanced many times can dominate the frame (the 30.7k-tri wall instanced 57× was the real cost).",
      });
    }
  }

  // ── Meshes: a triangle-count blind spot must be VISIBLE, never silent ──
  // An entry the op could not count (null triangle_count + reason) can never trip the
  // triangle_load heuristic, so the audit may be missing offenders — say so loudly.
  const unreadable = payload.meshes?.unreadable_count ?? 0;
  if (unreadable > 0) {
    findings.push({
      id: "mesh-triangle-count-missing",
      severity: "high",
      category: "mesh",
      subject: "meshes.unreadable_count",
      detail: `${unreadable} mesh(es) could not be counted (triangle_count null; see each entry's reason) — the audit may be missing offenders`,
      rationale:
        "Optimize high-frequency instanced meshes before isolated props — a mesh the audit cannot weigh is an invisible candidate offender, not a cheap one. Resolve the count (or measure the mesh another way) before trusting the mesh findings.",
    });
  }

  // ── Shadows: real-time shadow distance is a per-frame mobile cost ──
  // URP asset shadow distance overrides the quality-level value when present.
  const urpShadow = payload.render_pipeline_settings?.shadow_distance;
  const qualityShadow = payload.quality_settings?.shadow_distance;
  const shadowDistance = typeof urpShadow === "number" ? urpShadow
    : typeof qualityShadow === "number" ? qualityShadow : undefined;
  if (typeof shadowDistance === "number" && shadowDistance > thresholds.shadowDistanceCap) {
    const src = typeof urpShadow === "number" ? "URP asset" : "quality level";
    findings.push({
      id: "shadow-distance-budget",
      severity: "advisory",
      category: "shadow",
      subject: `${src} shadow_distance`,
      detail: `${shadowDistance} (> budget ${thresholds.shadowDistanceCap})`,
      rationale:
        "Real-time shadow distance is a per-frame cost on mobile — cap it to what gameplay needs. URP shadow settings are part of the mobile weight audit.",
    });
  }

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const producedBy = formatBuildStamp(resolveBuildStamp(moduleUrl));

  return {
    schemaVersion: "1",
    hardwareUnvalidated: true,
    hardwareUnvalidatedRule: HARDWARE_UNVALIDATED_RULE,
    producedBy,
    thresholds,
    scope: {
      loadedSceneCount: payload.loaded_scene_count ?? 0,
      loadedScenes: payload.loaded_scenes ?? [],
      note: SCOPE_NOTE,
    },
    totals: {
      textures: {
        count: payload.textures?.total_count ?? 0,
        truncated: payload.textures?.truncated ?? false,
        estimatedBytes: sumField(payload.textures?.entries, "estimated_bytes"),
      },
      audio: {
        count: payload.audio?.total_count ?? 0,
        truncated: payload.audio?.truncated ?? false,
        fileBytes: sumField(payload.audio?.entries, "file_bytes"),
      },
      meshes: {
        count: payload.meshes?.total_count ?? 0,
        truncated: payload.meshes?.truncated ?? false,
        maxTriangleLoad: maxField(payload.meshes?.entries, "triangle_load"),
        unreadableCount: unreadable,
      },
    },
    findings,
  };
}

/** Deterministic JSON: keys sorted at every level, byte-identical for identical input. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Human-readable markdown. States sizes + findings; makes no pass/fail judgment. */
export function renderMobileAuditReportText(report: MobileAuditReport): string {
  const lines: string[] = [];
  lines.push("# Mobile Optimization Audit");
  lines.push("");
  // The hardware-unvalidated stamp rides at the top of EVERY report — always.
  lines.push(`⚠ HARDWARE-UNVALIDATED: ${report.hardwareUnvalidatedRule}.`);
  lines.push("This report states weight + advisory findings only — it makes no pass/fail or done judgment.");
  lines.push("");
  lines.push(`Produced by: ${report.producedBy}`);
  lines.push(
    `Scope: ${report.scope.loadedSceneCount} loaded scene(s)` +
      (report.scope.loadedScenes.length ? ` [${report.scope.loadedScenes.join(", ")}]` : ""),
  );
  lines.push(`  ${report.scope.note}`);
  lines.push("");

  lines.push("## Weight Totals");
  const t = report.totals;
  lines.push(
    `- Textures: ${t.textures.count}${t.textures.truncated ? " (truncated)" : ""}, ~${t.textures.estimatedBytes} estimated bytes (shown entries)`,
  );
  lines.push(
    `- Audio: ${t.audio.count}${t.audio.truncated ? " (truncated)" : ""}, ~${t.audio.fileBytes} file bytes (shown entries)`,
  );
  lines.push(
    `- Meshes: ${t.meshes.count}${t.meshes.truncated ? " (truncated)" : ""}, max triangle_load ${t.meshes.maxTriangleLoad} (shown entries)` +
      (t.meshes.unreadableCount > 0 ? `, ${t.meshes.unreadableCount} uncounted` : ""),
  );
  lines.push("");

  lines.push("## Thresholds");
  lines.push(
    `- texture cap ${report.thresholds.textureCap}px · long-clip ${report.thresholds.audioLongSeconds}s · ` +
      `triangle_load cap ${report.thresholds.triangleLoadCap} · shadow distance budget ${report.thresholds.shadowDistanceCap}`,
  );
  lines.push("");

  lines.push(`## Findings (${report.findings.length})`);
  if (report.findings.length === 0) {
    lines.push("No entries exceeded the tuned heuristics. (This is not a device-proven pass — see the hardware-unvalidated stamp.)");
  } else {
    for (const f of report.findings) {
      lines.push(`- [${f.severity}] ${f.id} — ${f.subject}`);
      lines.push(`    ${f.detail}`);
      lines.push(`    §9: ${f.rationale}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
