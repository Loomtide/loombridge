/**
 * Bridge-surfaced discovery of the Loomtide verification core (the extraction-shooter dogfood
 * core-hardening Epic 0; findings RCL-P01 / RCL-P04).
 *
 * The dogfood project reached the bridge (Unity tools) but NEVER the core: the
 * deterministic `.loomtide/` plan→build→verify→doneness spine has no front door
 * in a consuming project, so a build ran with zero gates and self-graded
 * captures. These two MCP tools make the core visible from the bridge surface
 * itself:
 *
 *  - `loomtide_status` (read-only) — reports whether an acceptance contract
 *    exists for a project root and, if not, instructs running `loomtide plan`.
 *    It can NEVER mistake a hand-created `.loomtide/captures/` for a pass.
 *  - `loomtide_project_init` (safe scaffold) — idempotently creates the
 *    `.loomtide/` directory tree. It does NOT author a contract or fabricate any
 *    verified state (that is `loomtide plan`'s job); it only gives the project a
 *    home for state and points the agent at the next step.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";

import { designStatus } from "./loomtide/design.js";
import { isProjectDone, runDoneness } from "./loomtide/doneness.js";
import { runVerify } from "./loomtide/verify.js";
import { ensureScaffold, loomtidePaths, readState } from "./loomtide/state.js";
import { inspectContractPresence } from "./loomtide/contract-presence.js";
import {
  buildMobileAuditReport,
  renderMobileAuditReportText,
  stableStringify,
  validateAuditPayloadKind,
  DEFAULT_THRESHOLDS,
  type AuditPayload,
  type MobileAuditReport,
  type MobileAuditThresholds,
  type Severity,
} from "./loomtide/mobile-audit-report.js";

export const LOOMTIDE_STATUS_TOOL_NAME = "loomtide_status";
export const LOOMTIDE_PROJECT_INIT_TOOL_NAME = "loomtide_project_init";
export const LOOMTIDE_VERIFY_TOOL_NAME = "loomtide_verify";
export const LOOMTIDE_DONENESS_TOOL_NAME = "loomtide_doneness";
export const LOOMTIDE_MOBILE_AUDIT_TOOL_NAME = "loomtide_mobile_audit";

export const LOOMTIDE_STATUS_TOOL = {
  name: LOOMTIDE_STATUS_TOOL_NAME,
  description:
    "Report the Loomtide verification state of a project: whether an acceptance contract exists, " +
    "the current phase/verdict, and whether captures are present without a contract (captures are NOT a verification). " +
    "Read-only — never writes. If no contract exists, it tells you to run `loomtide plan`.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description:
          "Project root that owns (or should own) `.loomtide/`. Default: the MCP server working directory.",
      },
    },
    required: [],
  },
};

export const LOOMTIDE_PROJECT_INIT_TOOL = {
  name: LOOMTIDE_PROJECT_INIT_TOOL_NAME,
  description:
    "Safely scaffold the `.loomtide/` state directory tree for a project (idempotent; never overwrites or " +
    "fabricates a contract). After this, run `loomtide plan` to author the acceptance contract — init alone " +
    "does NOT make a project verified.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description: "Project root to scaffold `.loomtide/` under. Default: the MCP server working directory.",
      },
    },
    required: [],
  },
};

export interface LoomtideStatusPayload {
  root: string;
  /** Whether `.loomtide/` exists at all. */
  loomtideDirExists: boolean;
  /** Acceptance contract path, relative to `root`. */
  contractPath: string;
  contractExists: boolean;
  /** Capture dir names present under `.loomtide/` (e.g. `["captures"]`). */
  capturePresentDirs: string[];
  /** True when captures exist but NO contract does — the false-green shape. */
  capturesWithoutContract: boolean;
  /** STATE.md lifecycle phase, or null when no state has been written. */
  phase: string | null;
  /** Design Target readiness, or null when none. */
  designTargetStatus: string | null;
  /** Last Tier-1 verdict status, or null. */
  lastVerdictStatus: string | null;
  /**
   * True ONLY when the SAME gate `loomtide doneness` enforces certifies this
   * project right now (`isProjectDone`): a contract that PARSES as valid, a
   * runId-bound fresh-green verdict, every required capture present, and
   * hero-shot/asset fidelity. NEVER inferred from STATE.phase or bare file
   * existence — a hand-edited marker or an empty `{}` contract cannot set it.
   */
  verifiedGreen: boolean;
  /** Human-readable one-liner, always honest about unverified/ungraded state. */
  summary: string;
  /** The single next command to run. */
  nextStep: string;
}

function summarize(p: {
  loomtideDirExists: boolean;
  contractExists: boolean;
  capturesWithoutContract: boolean;
  capturePresentDirs: string[];
  phase: string | null;
  lastVerdictStatus: string | null;
  verifiedGreen: boolean;
}): { summary: string; nextStep: string } {
  if (!p.contractExists) {
    if (p.capturesWithoutContract) {
      return {
        summary:
          `Captures present under ${p.capturePresentDirs.map((d) => `.loomtide/${d}/`).join(", ")} but there is NO acceptance contract — ` +
          "NOTHING has been verified. Captures are not a verification. Run `loomtide plan` to author a contract.",
        nextStep: "loomtide plan",
      };
    }
    return {
      summary: p.loomtideDirExists
        ? "No acceptance contract (.loomtide/ACCEPTANCE.json) yet — nothing has been verified. Run `loomtide plan`."
        : "This project is not set up for Loomtide verification (no .loomtide/). Run `loomtide plan` (or `loomtide_project_init`).",
      nextStep: "loomtide plan",
    };
  }
  // Only claim green when the doneness gate actually certifies — NEVER from phase.
  if (p.verifiedGreen) {
    return {
      summary: "Acceptance contract present and a fresh, runId-bound verify is green — `loomtide doneness` certifies this build.",
      nextStep: "loomtide doneness",
    };
  }
  return {
    summary:
      `Acceptance contract present (phase=${p.phase ?? "unknown"}, lastVerdict=${p.lastVerdictStatus ?? "none"}); not certified green yet. ` +
      "Build + verify against it.",
    nextStep: "loomtide build",
  };
}

/** Build the read-only status payload for a project root. No mutation. */
export async function buildLoomtideStatusPayload(root: string): Promise<LoomtideStatusPayload> {
  const paths = loomtidePaths(root);
  const presence = await inspectContractPresence(paths);
  const [state, design, verifiedGreen] = await Promise.all([
    readState(paths),
    designStatus(paths),
    // The single source of truth for "done" — the same gate `loomtide doneness`
    // enforces (runId-bound fresh-green verdict + fidelity), NOT STATE.phase.
    isProjectDone(paths),
  ]);
  const phase = state?.phase ?? null;
  const lastVerdictStatus = state?.lastVerdict?.status ?? null;
  const { summary, nextStep } = summarize({
    loomtideDirExists: presence.loomtideDirExists,
    contractExists: presence.contractExists,
    capturesWithoutContract: presence.capturesWithoutContract,
    capturePresentDirs: presence.capturePresentDirs,
    phase,
    lastVerdictStatus,
    verifiedGreen,
  });
  return {
    root,
    loomtideDirExists: presence.loomtideDirExists,
    contractPath: path.relative(root, paths.acceptance),
    contractExists: presence.contractExists,
    capturePresentDirs: presence.capturePresentDirs,
    capturesWithoutContract: presence.capturesWithoutContract,
    phase,
    designTargetStatus: design.status,
    lastVerdictStatus,
    verifiedGreen,
    summary,
    nextStep,
  };
}

export interface LoomtideProjectInitPayload extends LoomtideStatusPayload {
  /** True when `.loomtide/` did not exist before this call. */
  created: boolean;
}

/**
 * Idempotently scaffold `.loomtide/` for a project, then return the (still
 * honest) status. NON-destructive: it only `mkdir -p`s the state dirs and never
 * writes a contract, STATE.md, or any "verified" claim.
 */
export async function runLoomtideProjectInit(root: string): Promise<LoomtideProjectInitPayload> {
  const paths = loomtidePaths(root);
  const before = await inspectContractPresence(paths);
  await ensureScaffold(paths);
  const status = await buildLoomtideStatusPayload(root);
  return { ...status, created: !before.loomtideDirExists };
}

// ─────────────────────────────────────────────────────────────────────────────
// T4a — the deterministic WORKFLOW verbs as first-class MCP tools (the front
// door). GRL-C20/C21: agents adopt what is IN the visible tool list when it maps
// to a moment of need. The bridge (Unity tools) was always in-list; the
// verification core was not, so a real build ran with zero gates. These wrappers
// put `verify` / `doneness` / the mobile audit ON the surface where adoption is
// proven to happen — descriptions LEAD with the trigger situation.
//
// MOAT: these are zero-judgment pass-throughs. They call the SAME code paths the
// `loomtide` CLI calls (`runVerify`/`runDoneness`, the mobile-audit report
// builder), never re-deciding a verdict. A refusal / red verdict is ALWAYS the
// headline; the full gate output is surfaced VERBATIM (no summary can hide a
// refusal), and a large report is returned as a file path + summary, never the
// blob. `plan`/`build` are deliberately OUT of scope (interactive/mutating).
// ─────────────────────────────────────────────────────────────────────────────

export const LOOMTIDE_VERIFY_TOOL = {
  name: LOOMTIDE_VERIFY_TOOL_NAME,
  description:
    "Run BEFORE claiming a build is done, or to self-check a game against its acceptance contract: the Tier-1 " +
    "DETERMINISTIC verify gate against `.loomtide/ACCEPTANCE.json`. Grades the captured evidence and writes the " +
    "build verdict. If NO contract exists it REFUSES (a hand-created `.loomtide/captures/` is NOT a verification) " +
    "and points you at `loomtide plan` — it can never green a project that was never planned. The refusal or a red " +
    "verdict is ALWAYS the headline; a harness fault (capture/editor gap) surfaces in its own tier, never as a fake " +
    "pass. Returns the exit code, the VERBATIM gate output, and the verdict report file path (not the blob).",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description:
          "Project root that owns `.loomtide/`. Default: the MCP server working directory.",
      },
    },
    required: [],
  },
};

export const LOOMTIDE_DONENESS_TOOL = {
  name: LOOMTIDE_DONENESS_TOOL_NAME,
  description:
    "Run BEFORE handing off or shipping, to answer 'is this ACTUALLY done?': the §3a supervisor freshness gate / " +
    "slice roll-up over `.loomtide/`. Certifies done ONLY for a fresh, runId-bound green verdict with every declared " +
    "capture present and (for a design-targeted build) a faithful frozen hero shot. If no contract/roadmap exists it " +
    "REFUSES and points at `loomtide plan`. A NOT-done result and its reasons are ALWAYS the headline — this gate " +
    "cannot be talked into 'done'. Returns the exit code, the VERBATIM roll-up, and the verdict report file path.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description:
          "Project root that owns `.loomtide/`. Default: the MCP server working directory.",
      },
    },
    required: [],
  },
};

export const LOOMTIDE_MOBILE_AUDIT_TOOL = {
  name: LOOMTIDE_MOBILE_AUDIT_TOOL_NAME,
  description:
    "Run BEFORE shipping to mobile, or WHEN frame rate on device is in question: a static mobile-optimization WEIGHT " +
    "audit of the currently-loaded Unity scenes. Drives `editor.audit_mobile_assets`, then flags oversized textures, " +
    "DecompressOnLoad long clips, high triangle_load instanced meshes (a modest mesh instanced dozens of times can " +
    "dominate the frame), and the real-time shadow budget — measure before you optimize. Requires a routable editor. Returns " +
    "the summary + TOP offenders + report file path, ALWAYS stamped hardware_unvalidated (theory-sound until a real " +
    "device build proves frame rate/memory/post-processing cost). Never a pass/fail — a human decides what to optimize.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description:
          "Project root that owns `.loomtide/` (the report is written under `.loomtide/reports/`). Default: the MCP server working directory.",
      },
      project: {
        type: "string",
        description:
          "Which routed Unity editor to audit (project path or name). Default: the active/auto-bound editor.",
      },
      max_entries: {
        type: "integer",
        minimum: 1,
        description: "Max entries returned per category by the underlying audit op (textures/audio/meshes). Default 50.",
      },
      texture_cap: { type: "number", minimum: 0, description: "Texture max-dimension cap in px (default 2048)." },
      audio_long_seconds: { type: "number", minimum: 0, description: "DecompressOnLoad clip length flagged beyond this (default 5)." },
      triangle_load_cap: { type: "number", minimum: 0, description: "Mesh triangle_load (tris × instances) flagged beyond this (default 500000)." },
      shadow_distance_cap: { type: "number", minimum: 0, description: "Real-time shadow distance flagged beyond this (default 50)." },
    },
    required: [],
  },
};

// ─── verify / doneness — verbatim, zero-judgment pass-throughs ────────────────

/**
 * The verbs print to `console.error`/`console.log` (they ARE the CLI code path —
 * 80+ bare console sites across verify/doneness and the gate/roll-up printers
 * they call, so threading a logger parameter through the certified verbs is not
 * a minimal refactor). Instead each MCP call gets its OWN log sink, scoped by
 * `AsyncLocalStorage` to the verb's async context:
 *
 *  - a line printed WITHIN the running verb lands in that call's collector
 *    (the verbatim gate output the response surfaces);
 *  - a line printed by anything ELSE in the process (a concurrent unity_* op's
 *    server logs, trace-recorder errors, disconnect notices) has no store in
 *    its context and passes through to the REAL console — never captured into
 *    a verify response, never swallowed from stderr.
 *
 * The console methods are patched only while at least one capture is in flight
 * (reference-counted), delegating to whatever the methods were at acquisition,
 * so the CLI path — which never enters a capture context — stays byte-identical.
 */
const verbLogSink = new AsyncLocalStorage<string[]>();

type ConsoleMethod = "error" | "log" | "warn";
const PATCHED_METHODS: ConsoleMethod[] = ["error", "log", "warn"];
let patchDepth = 0;
let savedConsole: Record<ConsoleMethod, (...a: unknown[]) => void> | null = null;

function acquireConsolePatch(): void {
  if (patchDepth++ > 0) return;
  savedConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  for (const method of PATCHED_METHODS) {
    console[method] = (...a: unknown[]) => {
      const sink = verbLogSink.getStore();
      if (sink) sink.push(a.join(" "));
      else savedConsole?.[method](...a);
    };
  }
}

function releaseConsolePatch(): void {
  if (--patchDepth > 0 || !savedConsole) return;
  console.error = savedConsole.error;
  console.log = savedConsole.log;
  console.warn = savedConsole.warn;
  savedConsole = null;
}

async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string[] }> {
  const output: string[] = [];
  acquireConsolePatch();
  try {
    const result = await verbLogSink.run(output, fn);
    return { result, output };
  } finally {
    releaseConsolePatch();
  }
}

/** Select the CLI's own status/refusal line as the headline — a verbatim line, never a new verdict. */
function pickHeadline(output: string[], fallback: string): string {
  const refusal = output.find((l) => /REFUSED|NOT done|NOT green|not verified|not complete|\bfatal:/i.test(l));
  if (refusal) return refusal.trim();
  const status = output.find((l) => /\bstatus=|\bOK —|PASS\b/i.test(l));
  if (status) return status.trim();
  const first = output.find((l) => l.trim().length > 0);
  return (first ?? fallback).trim();
}

/**
 * Run a verb with the CLI's OWN fatal-tier mapping (MED-2): the `loomtide` CLI
 * wraps `runVerify`/`runDoneness` in a catch that prints
 * `[loomtide <verb>] fatal: <message>` and exits 1 (a RED). The MCP wrapper must
 * agree tier-for-tier with the CLI on the same broken input (e.g. a present but
 * malformed ACCEPTANCE.json throws from the contract parse) — a throw maps to a
 * STRUCTURED red payload with the fatal line in the verbatim output, never an
 * unstructured generic tool error.
 */
async function runVerbWithFatalTier(verb: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loomtide ${verb}] fatal: ${message}`);
    return 1;
  }
}

export interface LoomtideVerifyToolPayload {
  root: string;
  /** The verb's enforcement exit code (0 pass/warn · 1 fail · 2 refusal/harness-fault). This is the authoritative verdict. */
  exitCode: number;
  /** True when verify short-circuited as a contract refusal (exit 2 + a REFUSED line). */
  refused: boolean;
  /** The refusal or verdict line, verbatim from the gate. */
  headline: string;
  /** The full gate output, verbatim (stderr + stdout lines) — no summarization. */
  output: string[];
  /** Tier-1 verdict `status` read from disk, or null when no verdict was written (e.g. a refusal). */
  verdictStatus: string | null;
  /** Verdict report path relative to `root`. */
  verdictPath: string;
  verdictExists: boolean;
}

/** `loomtide verify` as an MCP tool — the SAME `runVerify` the CLI calls, output surfaced verbatim. */
export async function runLoomtideVerifyTool(root: string): Promise<LoomtideVerifyToolPayload> {
  const paths = loomtidePaths(root);
  const { result: exitCode, output } = await withCapturedConsole(() =>
    runVerbWithFatalTier("verify", () =>
      runVerify({
        root,
        inputsDir: paths.verifyInputs,
        acceptancePath: paths.acceptance,
        outputPath: paths.verdict,
        strict: false,
      }),
    ),
  );
  let verdictStatus: string | null = null;
  let verdictExists = false;
  try {
    const raw = JSON.parse(await fs.readFile(paths.verdict, "utf-8")) as { status?: unknown };
    verdictExists = true;
    verdictStatus = typeof raw.status === "string" ? raw.status : null;
  } catch {
    /* no verdict on disk (a refusal writes none) */
  }
  const refused = exitCode === 2 && output.some((l) => /REFUSED/.test(l));
  return {
    root,
    exitCode,
    refused,
    headline: pickHeadline(output, refused ? "verify REFUSED" : `verify exit ${exitCode}`),
    output,
    verdictStatus,
    verdictPath: path.relative(root, paths.verdict),
    verdictExists,
  };
}

export interface LoomtideDonenessToolPayload {
  root: string;
  /** 0 = done (fresh + green) · 1 = not done / refused. This is the authoritative answer. */
  exitCode: number;
  /** True only for a certified fresh-green build. */
  done: boolean;
  /** True when doneness short-circuited as a never-planned contract refusal. */
  refused: boolean;
  /** The NOT-done / refusal / OK line, verbatim. */
  headline: string;
  /** The full roll-up output, verbatim — no summarization. */
  output: string[];
  /** The verdict the gate reads, relative to `root`. */
  verdictPath: string;
}

/** `loomtide doneness` as an MCP tool — the SAME `runDoneness` the CLI calls, output surfaced verbatim. */
export async function runLoomtideDonenessTool(root: string): Promise<LoomtideDonenessToolPayload> {
  const paths = loomtidePaths(root);
  const { result: exitCode, output } = await withCapturedConsole(() =>
    runVerbWithFatalTier("doneness", () => runDoneness({ root })),
  );
  const refused = output.some((l) => /No acceptance contract found/.test(l));
  return {
    root,
    exitCode,
    done: exitCode === 0,
    refused,
    headline: pickHeadline(output, exitCode === 0 ? "done" : "NOT done"),
    output,
    verdictPath: path.relative(root, paths.verdict),
  };
}

// ─── mobile audit — drive the bridge op, then the CLI's report builder ────────

/** Pull the (optional) threshold overrides from an MCP tool-call arg bag. */
export function extractMobileAuditThresholds(params: Record<string, unknown>): Partial<MobileAuditThresholds> {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const out: Partial<MobileAuditThresholds> = {};
  const tc = num(params.texture_cap); if (tc !== undefined) out.textureCap = tc;
  const al = num(params.audio_long_seconds); if (al !== undefined) out.audioLongSeconds = al;
  const tl = num(params.triangle_load_cap); if (tl !== undefined) out.triangleLoadCap = tl;
  const sd = num(params.shadow_distance_cap); if (sd !== undefined) out.shadowDistanceCap = sd;
  return out;
}

export interface LoomtideMobileAuditToolPayload {
  root: string;
  /** ALWAYS true — no code path emits a device-proven mobile verdict. */
  hardwareUnvalidated: true;
  hardwareUnvalidatedRule: string;
  /** One-line, honest summary — never a pass/fail. */
  summary: string;
  scope: { loadedSceneCount: number; loadedScenes: string[] };
  totals: MobileAuditReport["totals"];
  findingCount: number;
  highSeverityCount: number;
  /** The heaviest offenders only (top 5) — the full findings live in the report file, never inline. */
  topOffenders: Array<{ id: string; severity: Severity; subject: string; detail: string }>;
  /** How many findings are shown inline (`topOffenders.length`) vs `findingCount` total. */
  offendersShown: number;
  /** Self-describing truncation note, e.g. "showing 5 of 12 finding(s); full list in <reportPath>". */
  offendersNote: string;
  thresholds: MobileAuditThresholds;
  /** Deterministic report JSON path, relative to `root`. */
  reportPath: string;
  /** Human-readable markdown report path, relative to `root`. */
  reportTextPath: string;
}

/**
 * Translate an `editor.audit_mobile_assets` payload into the advisory report
 * (the SAME builder `loomtide mobile-audit` uses), write it under
 * `.loomtide/reports/`, and return a summary + top offenders + the path. The full
 * report is NEVER returned inline (output-size discipline). Refuses (`ok:false`)
 * when the bridge returned something that is not a stamped audit payload.
 */
export async function buildAndWriteMobileAuditReport(opts: {
  root: string;
  auditData: unknown;
  thresholds?: Partial<MobileAuditThresholds>;
}): Promise<{ ok: true; payload: LoomtideMobileAuditToolPayload } | { ok: false; error: string }> {
  const kindCheck = validateAuditPayloadKind(opts.auditData);
  if (!kindCheck.ok) return { ok: false, error: kindCheck.error };

  const thresholds: MobileAuditThresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const report = buildMobileAuditReport(opts.auditData as AuditPayload, thresholds);
  const text = renderMobileAuditReportText(report);

  const paths = loomtidePaths(opts.root);
  await fs.mkdir(paths.reports, { recursive: true });
  const jsonPath = path.join(paths.reports, "mobile-audit.json");
  const textPath = path.join(paths.reports, "mobile-audit.md");
  await fs.writeFile(jsonPath, stableStringify(report), "utf8");
  await fs.writeFile(textPath, text, "utf8");

  const highSeverityCount = report.findings.filter((f) => f.severity === "high").length;
  const topOffenders = report.findings.slice(0, 5).map((f) => ({
    id: f.id,
    severity: f.severity,
    subject: f.subject,
    detail: f.detail,
  }));
  const reportPathRel = path.relative(opts.root, jsonPath);
  const offendersNote =
    report.findings.length === 0
      ? "0 findings; the full report (totals + scope) is in the report file"
      : `showing ${topOffenders.length} of ${report.findings.length} finding(s); full list in ${reportPathRel}`;
  const summary =
    report.findings.length === 0
      ? `No entries exceeded the tuned heuristics (${report.totals.meshes.count} meshes / ${report.totals.textures.count} textures / ${report.totals.audio.count} audio across ${report.scope.loadedSceneCount} loaded scene(s)). HARDWARE-UNVALIDATED — not a device-proven pass.`
      : `${report.findings.length} advisory finding(s), ${highSeverityCount} high-severity. HARDWARE-UNVALIDATED — ${report.hardwareUnvalidatedRule}. Not a pass/fail; a human decides what to optimize.`;

  return {
    ok: true,
    payload: {
      root: opts.root,
      hardwareUnvalidated: true,
      hardwareUnvalidatedRule: report.hardwareUnvalidatedRule,
      summary,
      scope: { loadedSceneCount: report.scope.loadedSceneCount, loadedScenes: report.scope.loadedScenes },
      totals: report.totals,
      findingCount: report.findings.length,
      highSeverityCount,
      topOffenders,
      offendersShown: topOffenders.length,
      offendersNote,
      thresholds,
      reportPath: reportPathRel,
      reportTextPath: path.relative(opts.root, textPath),
    },
  };
}
