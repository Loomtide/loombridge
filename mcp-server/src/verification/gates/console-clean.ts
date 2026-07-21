/**
 * Console-clean gate.
 *
 * WHY: a 37/37-green clean-room build still shipped a real visual defect that
 * the EDITOR ITSELF flagged at runtime but nobody read — at an odd game-view
 * resolution Unity logged "Rendering at an odd-numbered resolution … Pixel
 * Perfect Camera may not work properly". That warning IS the visual-defect
 * signal (the pixel-perfect upscale tears at an odd resolution). This gate reads
 * the captured console and turns those runtime log signals into a deterministic
 * verdict so they can never be ignored again.
 *
 * INPUT — the `unity_editor_console_logs` op output, saved to `console.json`:
 *
 *   { logs: [ { type, message, stackTrace?, timestamp? }, ... ] }
 *
 * A bare array (`[ ... ]`) is tolerated too. Each entry's SEVERITY is read from
 * `type` (preferred — TraceCollector normalizes Unity's Error/Exception/Assert
 * to "error", Warning to "warning", everything else to "log") with `level` as a
 * fallback field name; its TEXT from `message` (preferred) or `condition`.
 *
 * CHECKS:
 *  - ERRORS — any entry whose severity is error/exception → FAIL
 *    (`console-clean.errors`). Errors/exceptions are never acceptable in a
 *    verified build.
 *  - RENDERING — any WARNING whose text matches the pixel-perfect / odd-resolution
 *    family (`/pixel ?perfect|odd-numbered resolution|may not work properly/i`)
 *    → FAIL (`console-clean.rendering`). This is the real visual-defect signal.
 *  - INFRA — a WARNING matching the NARROW, documented bridge-infrastructure
 *    allowlist (today: only the "IPC transport unavailable; fallback to tcp"
 *    Unix-domain-socket warning the bridge logs on startup on some runtimes) →
 *    surfaced as an informational PASS (`console-clean.infra`), never a fail —
 *    even under `--strict`. This is the ONLY way the IPC warning is excused; the
 *    capture path must NOT hide it by blanket-clearing the console (that would
 *    also drop real Awake/Start/play-enter errors). The allowlist is intentionally
 *    narrow so it can't mask genuine gameplay warnings.
 *  - WARNINGS — any OTHER warning → WARN (`console-clean.warnings`). Surfaced but
 *    not build-breaking (a benign warning shouldn't fail a build).
 *  - CLEAN — no errors, no rendering warnings, no infra/other warnings → PASS
 *    (`console-clean.clean`).
 *  - Missing/uncapturable input → a single WARN (degrade, don't crash).
 *
 * Mirrors the doc-comment + GateCheck style of `placement.ts` / `coverage.ts`.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** One captured console entry (TraceCollector shape + tolerated aliases). */
export interface ConsoleLogEntry {
  /** Normalized severity: "error" | "warning" | "log" (TraceCollector). */
  type?: string;
  /** Alias for severity some callers use. */
  level?: string;
  /** Log text (TraceCollector). */
  message?: string;
  /** Alias for the log text some callers use. */
  condition?: string;
  stackTrace?: string;
  timestamp?: number;
}

/** The `unity_editor_console_logs` op output. A bare array is tolerated too. */
export interface ConsoleLogsResult {
  logs?: ConsoleLogEntry[];
}

export const GATE_NAME = "console-clean";

/** A pixel-perfect / odd-resolution rendering warning → a real visual artifact. */
const RENDERING_WARNING_RE = /pixel ?perfect|odd-numbered resolution|may not work properly/i;

/**
 * NARROW, documented allowlist of known-benign bridge-INFRASTRUCTURE warnings
 * (not gameplay). Today this is ONLY the Unix-domain-socket / IPC transport
 * fallback the bridge logs on startup on runtimes without AF_UNIX — it has no
 * gameplay effect (the bridge falls back to TCP and works). Requires both the
 * IPC-unavailable and fallback-to-TCP phrases so a generic gameplay/network
 * warning containing only "fallback to tcp" is not excused. This is the ONLY
 * sanctioned way to excuse the IPC warning — the capture path must still record
 * it (never clear it).
 */
const INFRA_WARNING_RE =
  /IPC transport unavailable[\s\S]*fallback to tcp|fallback to tcp[\s\S]*IPC transport unavailable/i;

/** Severity classification of one entry. */
type Severity = "error" | "warning" | "other";

function severityOf(entry: ConsoleLogEntry): Severity {
  const raw = (entry.type ?? entry.level ?? "").toLowerCase();
  if (raw === "error" || raw === "exception" || raw === "assert") return "error";
  if (raw === "warning" || raw === "warn") return "warning";
  return "other";
}

function textOf(entry: ConsoleLogEntry): string {
  return entry.message ?? entry.condition ?? "";
}

/** Compact, single-line preview of a log entry for a report message. */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

export function evaluateConsoleClean(
  input: ConsoleLogsResult | ConsoleLogEntry[],
  _acceptance: AcceptanceContract,
): GateReport {
  // Tolerate a bare array OR a { logs } wrapper.
  const logs: ConsoleLogEntry[] = Array.isArray(input) ? input : input?.logs ?? [];

  if (!Array.isArray(logs)) {
    return makeGateReport(GATE_NAME, [
      {
        id: "console-clean.input",
        expected: "an array of console log entries",
        actual: "(uncapturable)",
        status: "warn",
        detail:
          "Console logs could not be read (no `logs` array). Capture unity_editor_console_logs output to console.json. Gate not evaluated.",
      },
    ]);
  }

  const checks: GateCheck[] = [];

  const errors = logs.filter((e) => severityOf(e) === "error");
  const warnings = logs.filter((e) => severityOf(e) === "warning");
  const renderingWarnings = warnings.filter((e) => RENDERING_WARNING_RE.test(textOf(e)));
  // Infra-allowlisted warnings are excused (never fail), but only when they are
  // NOT also a rendering warning — a real rendering warning is never excused.
  const infraWarnings = warnings.filter(
    (e) => !RENDERING_WARNING_RE.test(textOf(e)) && INFRA_WARNING_RE.test(textOf(e)),
  );
  const benignWarnings = warnings.filter(
    (e) => !RENDERING_WARNING_RE.test(textOf(e)) && !INFRA_WARNING_RE.test(textOf(e)),
  );

  // ---- ERRORS → FAIL ----
  if (errors.length > 0) {
    checks.push({
      id: "console-clean.errors",
      expected: "no Error/Exception entries in the console",
      actual: `${errors.length} error/exception entr${errors.length === 1 ? "y" : "ies"}`,
      status: "fail",
      detail: `Console has ${errors.length} error/exception entr${errors.length === 1 ? "y" : "ies"} — a verified build must have a clean console. First: "${preview(textOf(errors[0]))}".`,
    });
  }

  // ---- RENDERING WARNING (PixelPerfect / odd resolution) → FAIL ----
  if (renderingWarnings.length > 0) {
    checks.push({
      id: "console-clean.rendering",
      expected: "no PixelPerfect/odd-resolution rendering warning",
      actual: `${renderingWarnings.length} rendering warning(s)`,
      status: "fail",
      detail: `PixelPerfect/odd-resolution rendering warning → visual artifact. Unity flagged: "${preview(textOf(renderingWarnings[0]))}". The pixel-perfect upscale tears at an odd-numbered game-view resolution; set an even reference resolution / scale.`,
    });
  }

  // ---- INFRA-ALLOWLISTED WARNINGS → informational PASS (never fail, even strict) ----
  if (infraWarnings.length > 0) {
    checks.push({
      id: "console-clean.infra",
      expected: "no gameplay warnings (known bridge-infra warnings allowlisted)",
      actual: `${infraWarnings.length} allowlisted infra warning(s)`,
      status: "pass",
      detail: `${infraWarnings.length} known-benign bridge-infrastructure warning(s) allowlisted (recorded, not hidden). First: "${preview(textOf(infraWarnings[0]))}". These have no gameplay effect; genuine gameplay warnings are not allowlisted.`,
    });
  }

  // ---- OTHER WARNINGS → WARN ----
  if (benignWarnings.length > 0) {
    checks.push({
      id: "console-clean.warnings",
      expected: "no warning entries in the console",
      actual: `${benignWarnings.length} warning(s)`,
      status: "warn",
      detail: `Console has ${benignWarnings.length} non-rendering warning(s) — surfaced, not build-breaking. First: "${preview(textOf(benignWarnings[0]))}".`,
    });
  }

  // ---- CLEAN → PASS ----
  if (checks.length === 0) {
    checks.push({
      id: "console-clean.clean",
      expected: "a clean console (no errors, no warnings)",
      actual: `${logs.length} log entr${logs.length === 1 ? "y" : "ies"}, none error/warning`,
      status: "pass",
      detail: `Console is clean: no errors/exceptions and no warnings across ${logs.length} captured log entr${logs.length === 1 ? "y" : "ies"}.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
