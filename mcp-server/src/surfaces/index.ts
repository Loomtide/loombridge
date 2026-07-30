#!/usr/bin/env node
/**
 * Loombridge MCP Server — stdio transport entry point.
 *
 * Bridges Claude Code (via MCP stdio) to the Unity Editor plugin (via WebSocket).
 * Exposes all Unity ops as MCP tools and records traces.
 *
 * Architecture:
 *   Claude Code (MCP stdio client)
 *       <-> stdio
 *   index.ts (this MCP Server)
 *       <-> OpRegistry (op definitions -> MCP tools)
 *       <-> TraceRecorder (JSONL + artifact storage)
 *       <-> UnityClient (WebSocket + handshake + reconnect)
 *           <-> Unity Editor Plugin (BridgeServer.cs)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  UnityClient,
  UnityConnectionError,
  formatConnectionDiagnostics,
  isRouteMismatchError,
} from "../bridge/unity-client.js";
import { TraceRecorder, type TraceEntry } from "../bridge/trace-recorder.js";
import { OpRegistry, normalizeBatchOperations } from "./op-registry.js";
import type { BridgeResponse } from "../shared/types.js";
import {
  BridgePreflight,
  formatPreflightBlockedMessage,
  type BridgePreflightResult,
} from "../bridge/preflight/bridge-preflight.js";
import { shouldRunDeterministicPreflight } from "../bridge/preflight/prerequisite-checks.js";
import {
  buildEditorListPayload,
  EDITOR_LIST_TOOL,
  EDITOR_LIST_TOOL_NAME,
  EDITOR_USE_TOOL,
  EDITOR_USE_TOOL_NAME,
} from "./editor-tools.js";
import {
  LOOMBRIDGE_PROJECT_INIT_TOOL,
  LOOMBRIDGE_PROJECT_INIT_TOOL_NAME,
  LOOMBRIDGE_STATUS_TOOL,
  LOOMBRIDGE_STATUS_TOOL_NAME,
  LOOMBRIDGE_VERIFY_TOOL,
  LOOMBRIDGE_VERIFY_TOOL_NAME,
  LOOMBRIDGE_DONENESS_TOOL,
  LOOMBRIDGE_DONENESS_TOOL_NAME,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME,
  buildLoombridgeStatusPayload,
  runLoombridgeProjectInit,
  runLoombridgeVerifyTool,
  runLoombridgeDonenessTool,
  buildAndWriteMobileAuditReport,
  extractMobileAuditThresholds,
} from "./loombridge-bridge-tools.js";
import {
  EditorRegistry,
  EditorRoutingError,
  type EditorRoute,
} from "../bridge/editor-registry.js";
import { resolveMcpStartupProjectBinding } from "../bridge/startup-binding.js";
import { collectSiblingServers, formatDoctorLines } from "../shared/diagnostics.js";
import { InputSessionKeepalive } from "../bridge/input-keepalive.js";
import { resolveBuildStamp } from "../shared/build-stamp.js";
import { resolveTraceDirectory } from "../bridge/trace-directory.js";
import { validateOpArguments } from "../shared/arg-validation.js";

// ─────────────────────────────────────────────
// Response Formatting (exported for testing)
// ─────────────────────────────────────────────

/**
 * ToolResult is a simplified view of CallToolResult for testing purposes.
 * At runtime the MCP SDK validates the full shape.
 */
interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized || "unknown error";
}

export function formatConnectionErrorMessage(error: unknown): string {
  if (error instanceof UnityConnectionError) {
    return formatConnectionDiagnostics(error.diagnostics);
  }
  return sanitizeErrorMessage(error);
}

/**
 * Max time to wait for the bridge to become usable again after `editor.play`
 * triggers a domain reload (socket reconnect + Play Mode reached + compile done).
 */
const PLAY_SETTLE_TIMEOUT_MS = 60000;

export interface PlayModeSettleDeps {
  /** Wait for an in-flight reconnect to settle; resolves false on timeout. */
  waitForReconnect(timeoutMs: number): Promise<boolean>;
  /**
   * Issue `editor.wait_for { playMode: "playing", compiling: false }` with the given
   * timeout budget. Pure observation (idempotent) — safe to re-issue after a reconnect.
   */
  waitForPlaying(timeoutMs: number): Promise<BridgeResponse>;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface PlayModeSettleResult {
  settled: boolean;
  error?: string;
}

/**
 * Commands whose whole purpose is to survive a domain reload — they are pure observations
 * (idempotent) that an agent issues precisely to wait the reload window out. During that window
 * the bridge listener is briefly down, so a fresh preflight `connect()` hits a transient
 * connection block. Without the retry below that would surface as PREFLIGHT_BLOCKED — the wait
 * failing *because of* the very reload it exists to wait through (RCL-T03).
 *
 * NOTE: `editor.stop` is deliberately NOT listed. Only commands in the deterministic-preflight
 * trigger set (`SCENARIO_PREFLIGHT_EXACT_COMMANDS` + `runtime.`/`input.` prefixes) ever reach
 * `runReloadAwarePreflight`, and `editor.stop` is not one of them — so listing it here would be
 * dead config that claims coverage the pipeline never delivers. Surviving a reload around
 * `editor.stop` is DEFERRED: it would require first adding `editor.stop` to the deterministic-
 * preflight trigger set and validating the implications (it is not a pure read), which is out of
 * scope for this fix.
 */
const RELOAD_WINDOW_COMMANDS = new Set<string>([
  "editor.wait_for",
  "editor.play",
]);

const RELOAD_PREFLIGHT_POLL_INTERVAL_MS = 250;

/**
 * Hard cap on how long reload-survival polling may run, regardless of the op's (much larger)
 * timeout. A genuinely-dead bridge (user quit Unity, not a reload) presents IDENTICALLY to a
 * reload — same `ECONNREFUSED_NO_LISTENER`, same `hasEverConnected` — so without this cap a dead
 * bridge would be polled for the full 10–30s op timeout before failing. A real domain reload
 * reconnects well under 4s; capping here fails a truly-dead bridge in ~4s instead of stalling.
 */
const RELOAD_POLL_BUDGET_MS = 4000;

/**
 * Connection-blocker signatures that, while `hasEverConnected`, are treated as a bridge bouncing
 * through a reload (and so are polled through, BOUNDED by RELOAD_POLL_BUDGET_MS). A reload can
 * present not only as "no listener" but also as a connect that times out or a handshake that
 * stalls while the main thread is frozen reloading, or a momentarily-unavailable loopback address.
 * All are the same transient PREFLIGHT_CONNECTION_BLOCKED class; anything else (protocol mismatch,
 * missing capability, a non-connection prerequisite) is a real condition we must NOT poll through.
 */
const RELOAD_SURVIVABLE_CONNECTION_SIGNATURES = new Set<string>([
  "ECONNREFUSED_NO_LISTENER",
  "TIMEOUT_CONNECT",
  "HANDSHAKE_FAILURE",
  "EADDRNOTAVAIL_LOOPBACK",
]);

export function isReloadWindowCommand(command: string): boolean {
  return RELOAD_WINDOW_COMMANDS.has(command);
}

/**
 * Async measurement/capture ops that drive Play Mode and so can catch an in-flight domain reload
 * mid-run: the bridge main thread freezes, the response never arrives, and the send fails — usually
 * as a bare `Timeout`, sometimes as `CONNECTION_LOST` when the socket also drops (RCL-T03 async
 * follow-up: two measure_motion calls died `[CONNECTION_ERROR] Timeout (30000ms)` on a reload
 * window). These ops are SAFE to re-run (a re-measure just measures again — no non-idempotent side
 * effect), so on a reload-shaped failure we wait the bridge back and retry once, bounded.
 */
export function isReloadSurvivableSendCommand(command: string): boolean {
  return command === "runtime.measure_motion" || command.startsWith("runtime.capture_");
}

/**
 * Hard cap on how long the SEND-path reload retry waits for the bridge to come back before retrying
 * the measurement/capture op. A real domain reload reconnects well under this; a genuinely-dead
 * bridge fails in ~this budget instead of stalling. (The legacy CONNECTION_LOST retry keeps its own
 * 60s reconnect wait unchanged.)
 */
const RELOAD_SEND_RECONNECT_BUDGET_MS = 15000;

/**
 * Decide whether a failed op send should be retried as a domain-reload survival. ANY op retries on
 * CONNECTION_LOST (the bridge socket dropped — re-send is the existing behavior). A reload-survivable
 * async measurement/capture op ALSO retries on a reload-shaped failure that presents as a bare
 * Timeout / "Not connected" / connection-refused, because for those idempotent ops a timeout almost
 * always means the bridge froze through a reload rather than the work legitimately overrunning. A
 * non-survivable op never retries on a bare timeout (re-sending it could double a non-idempotent op).
 */
export function shouldRetryReloadDrop(command: string, errorMessage: string): boolean {
  if (errorMessage.includes("CONNECTION_LOST")) {
    return true;
  }
  if (
    isReloadSurvivableSendCommand(command) &&
    /timeout|not connected|econnrefused|connection refused|no listener/i.test(errorMessage)
  ) {
    return true;
  }
  return false;
}

/**
 * True when EVERY blocker in a preflight result is a transient connection block whose signature is
 * in RELOAD_SURVIVABLE_CONNECTION_SIGNATURES — the shape of a bridge bouncing through a reload. A
 * single non-survivable blocker (protocol mismatch, missing category, a different connection class)
 * makes the whole result non-survivable so we surface it immediately.
 */
function isReloadSurvivableBlock(result: BridgePreflightResult): boolean {
  return (
    result.blockers.length > 0 &&
    result.blockers.every(
      (blocker) =>
        blocker.code === "PREFLIGHT_CONNECTION_BLOCKED" &&
        RELOAD_SURVIVABLE_CONNECTION_SIGNATURES.has(blocker.signature),
    )
  );
}

export interface ReloadAwarePreflightDeps {
  /** Run a single preflight pass (re-attempts connect each call). */
  runPreflight(): Promise<BridgePreflightResult>;
  /** Whether the bridge client has EVER completed a handshake (distinguishes reload-bounce from never-up). */
  hasEverConnected(): boolean;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
  /** Sleep injection for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval; defaults to RELOAD_PREFLIGHT_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Override the reload-survival poll budget (defaults to RELOAD_POLL_BUDGET_MS). */
  pollBudgetMs?: number;
}

/**
 * Reload-aware preflight: for a reload-window command, keep re-running preflight while it is
 * blocked SOLELY by a transient survivable connection error AND the client has connected at least
 * once before (so we know the bridge is real and merely bouncing through a reload). The loop is
 * BOUNDED by `min(timeoutMs, pollBudgetMs)` — so a genuinely-dead bridge (never reconnects) fails
 * in ~RELOAD_POLL_BUDGET_MS rather than stalling for the full op timeout. A never-connected bridge
 * returns the blocked result on the first pass (no poll at all). Non-reload commands return the
 * first preflight result unchanged.
 */
export async function runReloadAwarePreflight(
  command: string,
  timeoutMs: number,
  deps: ReloadAwarePreflightDeps,
): Promise<BridgePreflightResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? RELOAD_PREFLIGHT_POLL_INTERVAL_MS;
  const pollBudgetMs = deps.pollBudgetMs ?? RELOAD_POLL_BUDGET_MS;
  // Bound polling by the SHORTER of the op timeout and the reload-survival budget, so a dead
  // bridge can't be polled for the full (10–30s) op timeout.
  const budgetMs = Math.min(Math.max(0, timeoutMs), pollBudgetMs);
  const deadline = now() + budgetMs;

  let result = await deps.runPreflight();
  if (!isReloadWindowCommand(command)) {
    return result;
  }

  while (
    result.status === "blocked" &&
    isReloadSurvivableBlock(result) &&
    deps.hasEverConnected()
  ) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      // Bounded timeout: return the last blocked result rather than hanging forever.
      return result;
    }
    await sleep(Math.min(pollIntervalMs, remaining));
    result = await deps.runPreflight();
  }
  return result;
}

/**
 * Block until the bridge is usable again after `editor.play` enters Play Mode and
 * (by default) triggers a domain reload: wait for the reconnect, then for Play Mode
 * to be reached with compilation idle. `editor.wait_for` is a pure observation, so a
 * `CONNECTION_LOST` mid-wait (the reload firing) is recoverable — reconnect and
 * re-issue it. We never resend `editor.play` itself, so a non-idempotent op can never
 * be double-executed here. Bounded by `settleTimeoutMs`.
 */
export async function settlePlayMode(
  deps: PlayModeSettleDeps,
  settleTimeoutMs: number,
): Promise<PlayModeSettleResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + settleTimeoutMs;
  let lastError: string | null = null;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        settled: false,
        error: lastError ?? `Play Mode did not settle within ${settleTimeoutMs}ms`,
      };
    }
    await deps.waitForReconnect(remaining);
    try {
      const settleMsg = await deps.waitForPlaying(Math.max(0, deadline - now()));
      if (settleMsg.status === "error") {
        return {
          settled: false,
          error: sanitizeErrorMessage(
            (settleMsg.error as { message?: string } | undefined)?.message ?? "wait_for failed",
          ),
        };
      }
      return { settled: true };
    } catch (err) {
      const message = sanitizeErrorMessage(err);
      // A reload firing mid-wait drops the socket; reconnect and re-issue the
      // idempotent wait. Anything else (incl. a final "Not connected") is terminal.
      if (message.includes("CONNECTION_LOST")) {
        lastError = message;
        continue;
      }
      return { settled: false, error: message };
    }
  }
}

/**
 * GRL-B01: compose the `editor.play` settle-failure message. When a compile error was actually
 * detected (compileError present), attribute it — a PRE-EXISTING compile error (in any assembly,
 * incl. an EditMode test asmdef) silently blocks Play, the bridge never enters Play Mode, so the
 * settle just times out. The old message misattributed this as a domain-reload drop. When no
 * compile error is found, keep the original generic message (never guess one that wasn't there).
 */
export function buildPlaySettleFailureMessage(
  settleError: string,
  compileError?: unknown,
): string {
  if (compileError && typeof compileError === "object") {
    return (
      "editor.play could not enter Play Mode: a compile error is blocking script compilation " +
      "(fix it, then retry editor.play). " +
      JSON.stringify({ compile_error: compileError })
    );
  }
  return `editor.play entered Play Mode but the bridge did not settle: ${settleError}`;
}

/**
 * Resolve the wire timeout for an op call. A caller-supplied numeric `timeoutMs`
 * argument takes precedence over the op's `defaultTimeoutMs`, so async ops that
 * expose a `timeoutMs` parameter (package.add, runtime.wait_for_condition, …) are
 * honored end-to-end instead of being silently capped at the op default. Falls back
 * to 10000ms when neither is usable. Non-finite / non-positive requests are ignored
 * (a 0 or negative timeout would make every call fail immediately).
 */
export function resolveOpTimeoutMs(
  op: { defaultTimeoutMs?: number },
  params: Record<string, unknown>,
): number {
  const requested = params.timeoutMs;
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  return op.defaultTimeoutMs ?? 10000;
}

// ─────────────────────────────────────────────
// Contextual failure hints (Tranche 4a / GRL-C22)
// ─────────────────────────────────────────────

/**
 * A rare, advisory, at-the-moment-of-need pointer to the ONE tool that resolves the
 * failure shape the agent is currently staring at. It rides the response payload the
 * agent is already reading — GRL-C22: an agent hand-grepped Editor.log at the exact
 * reload-wiped-console failure `unity_editor_get_project_diagnostics` solves, WITH the
 * tool in its list. A tool merely existing isn't enough; the pointer has to land on the
 * failure the agent is looking at.
 *
 * HONESTY CONTRACT (enforced by the detectors + attachment below):
 *  - Emitted ONLY on an affirmatively-detected condition — never speculative. An ABSENT
 *    field is never treated as a positive detection.
 *  - Advisory prose ONLY. NEVER alters the error `code`, the `isError` flag, the verdict,
 *    or any gate-consumed field. It is attached as a SEPARATE trailing content entry so the
 *    primary payload (content[0]: the JSON data, or the `[CODE] message` error text) stays
 *    byte-identical — additive-only for every existing consumer.
 *  - At most ONE hint per response (each detector yields a single hint; the call sites use a
 *    `??` chain so exactly one can win).
 */
export interface ContextualHint {
  /** The MCP tool name to reach for (e.g. "unity_editor_get_project_diagnostics"). */
  tool: string;
  /** One sentence: the condition that was actually detected. */
  when: string;
  /** One sentence: what that tool gives you here. */
  why: string;
}

/**
 * Attach a contextual hint to a tool result as a SEPARATE trailing content entry, leaving
 * every existing content entry (and `isError`) byte-identical. No hint → the result is
 * returned unchanged, so the default behavior is exactly as before.
 */
function withHint(result: ToolResult, hint?: ContextualHint): ToolResult {
  if (!hint) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: JSON.stringify({ hint }) }],
  };
}

/**
 * Commands whose completion triggers a domain reload / recompile. A CONNECTION_LOST drop
 * immediately after one of these is the reload firing (recoverable by waiting it out), not a
 * dead editor. Kept deliberately narrow (the ops the registry documents as reload-triggering)
 * so the hint stays rare and credible.
 */
const DOMAIN_RELOAD_TRIGGERING_COMMANDS = new Set<string>([
  "package.add",
  "package.remove",
  "code.create_script",
  "code.modify_script",
  "code.attach_script",
  "editor.refresh_assets",
]);

export function isDomainReloadTriggeringCommand(command: string): boolean {
  return DOMAIN_RELOAD_TRIGGERING_COMMANDS.has(command);
}

/**
 * Site a — `editor.play` settle-failure whose interrogated state carried a compile-error
 * attribution. Fires ONLY when a compile error was affirmatively detected (the P3
 * `compile_error` block is present); an absent block yields no hint.
 */
export function buildPlaySettleCompileHint(compileError: unknown): ContextualHint | undefined {
  if (!compileError || typeof compileError !== "object") return undefined;
  return {
    tool: "unity_editor_get_project_diagnostics",
    when: "editor.play could not enter Play Mode because a compile error is blocking script compilation.",
    why: "It returns the authoritative per-assembly compiler errors (file/line/message) so you fix the real blocker instead of hand-grepping a reload-wiped console or Editor.log.",
  };
}

/**
 * Site b — `editor.wait_for` returned success but its attributed `compileResult` FAILED
 * (succeeded:false or errorCount>0). Fires ONLY on an affirmatively-failed compileResult;
 * an ABSENT compileResult (no compile happened in the wait window) is not a failure and
 * yields no hint, and a succeeded compileResult yields no hint.
 */
export function buildWaitForCompileFailureHint(
  command: string,
  data: unknown,
): ContextualHint | undefined {
  if (command !== "editor.wait_for") return undefined;
  const compileResult = (data as { compileResult?: unknown } | null)?.compileResult;
  if (!compileResult || typeof compileResult !== "object") return undefined;
  const cr = compileResult as { succeeded?: unknown; errorCount?: unknown };
  const failed =
    cr.succeeded === false || (typeof cr.errorCount === "number" && cr.errorCount > 0);
  if (!failed) return undefined;
  return {
    tool: "unity_editor_get_project_diagnostics",
    when: "editor.wait_for reported a compilation that finished with errors (compileResult.succeeded=false).",
    why: "It surfaces the full CURRENT project diagnostics across all assemblies (reload-survivable), not just this wait's compile delta, so you read the errors directly instead of scraping Editor.log.",
  };
}

/** True when a console entry's severity (type/level/severity) is an error/assert/exception. */
function isErrorSeverityConsoleEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return [e.type, e.level, e.severity].some(
    (v) => typeof v === "string" && /^(error|assert|exception)$/i.test(v),
  );
}

/**
 * Site c — a successful `editor.console_logs` response whose returned entries include ≥1
 * error-severity entry. Fires ONLY when such an entry is affirmatively present; a
 * warnings/logs-only or empty result yields no hint.
 */
export function buildConsoleErrorHint(command: string, data: unknown): ContextualHint | undefined {
  if (command !== "editor.console_logs") return undefined;
  const logs = (data as { logs?: unknown } | null)?.logs;
  if (!Array.isArray(logs)) return undefined;
  if (!logs.some(isErrorSeverityConsoleEntry)) return undefined;
  return {
    tool: "unity_editor_get_project_diagnostics",
    when: "the returned console logs include at least one error-severity entry.",
    why: "It gives the structured, deduped compiler/runtime diagnostics that survive a domain reload wiping the console, so you don't hand-grep Editor.log.",
  };
}

/**
 * Site d — a CONNECTION_LOST drop that FOLLOWED a domain-reload-triggering op. Codifies the
 * CLAUDE.md gotcha into the payload the agent actually sees: the drop is the reload firing,
 * so chain `editor.wait_for { compiling: false }` rather than treating the editor as dead.
 * Fires ONLY when the failed command triggers a reload AND the error is affirmatively
 * CONNECTION_LOST — a plain timeout or an unrelated op yields no hint.
 */
export function buildReloadReconnectHint(
  command: string,
  errorMessage: string,
): ContextualHint | undefined {
  if (!isDomainReloadTriggeringCommand(command)) return undefined;
  if (!/CONNECTION_LOST/i.test(errorMessage)) return undefined;
  return {
    tool: "unity_editor_wait_for",
    when: "the bridge connection dropped (CONNECTION_LOST) right after an op that triggers a domain reload / recompile.",
    why: "Chain unity_editor_wait_for { compiling: false } to wait the reload out before the next op — the drop is the reload firing, not a dead editor.",
  };
}

/**
 * Format a successful Unity response as an MCP tool result.
 * Screenshots return image content; everything else returns JSON text.
 * An optional contextual hint is appended as a separate trailing content entry.
 */
/**
 * The ops whose successful payload is a PICTURE, returned as MCP image content rather than
 * JSON text. Named as a set so a new capture op cannot be added without deciding this: the
 * default text path would stringify a full-size base64 PNG into the transcript.
 */
const IMAGE_RESULT_COMMANDS: ReadonlySet<string> = new Set([
  "editor.screenshot",
  "replay.settle_and_capture",
]);

export function formatToolResult(
  command: string,
  data: unknown,
  hint?: ContextualHint,
): ToolResult {
  const record = data as Record<string, unknown> | null;

  // Screenshot handling: return base64 image if present.
  //
  // `replay.settle_and_capture` rides the SAME branch, and must: it is a capture op whose
  // payload is a full-size base64 PNG, and falling through to the JSON default would dump
  // megabytes of base64 into the agent's context as text (unreadable, and expensive) instead
  // of an image it can actually look at.
  if (
    IMAGE_RESULT_COMMANDS.has(command) &&
    record &&
    typeof record.image_base64 === "string"
  ) {
    const format = record.format as string;
    const mimeType = format === "png" ? "image/png" : "image/jpeg";
    const content: ToolResult["content"] = [
      {
        type: "image",
        data: record.image_base64 as string,
        mimeType,
      },
    ];
    // When the capture was annotated (annotateBounds), also return the numeric
    // bounds so the agent gets both the picture and the measurements in one call.
    if (Array.isArray(record.annotations) && record.annotations.length > 0) {
      content.push({
        type: "text",
        text: JSON.stringify({ annotations: record.annotations }),
      });
    }
    // The aligned settle's EVIDENCE (framesElapsed, settledMs, realtimeDeadlineHit,
    // fixedDeltaTime) travels beside the picture: it is the proof the frame was taken where
    // it claims, and an image-only result would silently drop it.
    if (command === "replay.settle_and_capture") {
      const { image_base64: _image, ...evidence } = record;
      content.push({ type: "text", text: JSON.stringify(evidence) });
    }
    return withHint({ content }, hint);
  }

  // Default: return data as JSON text
  return withHint(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    },
    hint,
  );
}

export interface ScreenshotOutputMetadata {
  path: string;
  width: number | null;
  height: number | null;
  format: string;
  sizeBytes: number;
  sha256: string;
  annotations?: unknown[];
}

export function resolveSafeScreenshotOutputPath(
  requestedPath: string,
  cwd: string = process.cwd(),
): string {
  if (requestedPath.trim() === "") {
    throw new Error("outputPath must be a non-empty path");
  }
  if (requestedPath.includes("\0")) {
    throw new Error("outputPath must not contain null bytes");
  }

  const resolvedCwd = path.resolve(cwd);
  const targetPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedCwd, requestedPath);

  // Containment is enforced against the concrete artifact roots only. We do NOT
  // whitelist the project cwd itself: doing so would let `.loombridge/../<path>` or
  // `captures/../<path>` escape the artifact dirs and overwrite arbitrary files
  // under the project root (the target only has to land somewhere below cwd).
  // The `.loombridge` and `captures` roots already admit every legitimate relative
  // path, and `..` escapes are correctly rejected by the path.relative check.
  const allowedRoots = [
    path.resolve(resolvedCwd, ".loombridge"),
    path.resolve(resolvedCwd, "captures"),
    path.join(os.homedir(), "loombridge-runs"),
    path.resolve("/tmp"),
    path.resolve(os.tmpdir()),
  ];

  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, targetPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!isAllowed) {
    throw new Error(
      "outputPath must stay under .loombridge/, captures/, ~/loombridge-runs, or /tmp",
    );
  }

  return targetPath;
}

export async function writeScreenshotOutputPath(
  data: unknown,
  requestedPath: string,
  cwd: string = process.cwd(),
): Promise<ScreenshotOutputMetadata> {
  const record = data as Record<string, unknown> | null;
  if (!record || typeof record.image_base64 !== "string") {
    throw new Error("editor.screenshot did not return image_base64");
  }

  const outputPath = resolveSafeScreenshotOutputPath(requestedPath, cwd);
  const bytes = Buffer.from(record.image_base64, "base64");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);

  const metadata: ScreenshotOutputMetadata = {
    path: outputPath,
    width: typeof record.width === "number" ? record.width : null,
    height: typeof record.height === "number" ? record.height : null,
    format: typeof record.format === "string" ? record.format : "unknown",
    sizeBytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  if (Array.isArray(record.annotations)) {
    metadata.annotations = record.annotations;
  }
  return metadata;
}

/**
 * Format an error as an MCP tool result with isError: true.
 */
export function formatErrorResult(
  message: string,
  code?: string,
  hint?: ContextualHint,
): ToolResult {
  const text = code ? `[${code}] ${message}` : message;
  return withHint(
    {
      isError: true,
      content: [{ type: "text", text }],
    },
    hint,
  );
}

export function stripRoutingParams(params: Record<string, unknown>): {
  unityParams: Record<string, unknown>;
  project: unknown;
  outputPath: unknown;
} {
  const { project, outputPath, ...unityParams } = params;
  return { unityParams, project, outputPath };
}

export function formatEditorRoutingError(
  error: EditorRoutingError,
  activeProjectPathCanonical: string | null = null,
): string {
  return `${error.message} ${JSON.stringify(buildEditorListPayload(error.peers, activeProjectPathCanonical))}`;
}

// ─────────────────────────────────────────────
// Server Bootstrap
// ─────────────────────────────────────────────

/**
 * The non-op ("core") MCP tools served alongside the Unity op registry: editor
 * routing + the deterministic Loombridge workflow front door (status/init/verify/
 * doneness/mobile-audit). Exported so a test can guard that the workflow verbs
 * stay ON the surface (GRL-C20/C21: agents adopt what is in the visible list).
 * These are MCP-layer tools, NOT bridge ops — they do not affect the op count.
 */
export const LOOMBRIDGE_CORE_TOOLS = [
  EDITOR_LIST_TOOL,
  EDITOR_USE_TOOL,
  LOOMBRIDGE_STATUS_TOOL,
  LOOMBRIDGE_PROJECT_INIT_TOOL,
  LOOMBRIDGE_VERIFY_TOOL,
  LOOMBRIDGE_DONENESS_TOOL,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL,
];

const SERVER_NAME = "loombridge";
// Read from package.json rather than hand-maintained: a literal here silently went
// stale at 0.2.0 while the package shipped 0.3.0, so every MCP client saw the wrong
// version. resolveBuildStamp() resolves package.json relative to its OWN compiled
// location (dist/capabilities/), so it is correct regardless of this module's depth.
const SERVER_VERSION = resolveBuildStamp().version;

// Exported so the `loombridge` CLI dispatcher (cli.ts) can boot the server via the
// `mcp` subcommand. The main-module guard below still auto-runs it when the file
// is the entry point (e.g. the `node dist/index.js` form in every .mcp.json).
export async function main(): Promise<void> {
  const opRegistry = new OpRegistry();

  // Infer the session's Unity project once at boot so untargeted calls auto-bind without a
  // manual loombridge_editor_use: env (LOOMBRIDGE_UNITY_PROJECT) or cwd (nearest Unity project
  // root above the working directory). Both bind fail-closed. Routing logs go to stderr only
  // — stdout is the MCP channel.
  const startupBinding = resolveMcpStartupProjectBinding({
    env: process.env,
    cwd: process.cwd(),
  });

  // Traces belong to the bound project's .loombridge/, NOT to a CWD-relative ./trace.
  // The old default wrote wherever the MCP client happened to launch the server —
  // normally the user's project root — so trace JSONL and screenshot artifacts piled
  // up unbounded outside the documented state directory (73 MB observed in one
  // consumer project) and every consumer had to discover it and add their own
  // .gitignore rule. Resolved AFTER the binding so we know which project we serve.
  const traceRecorder = new TraceRecorder(resolveTraceDirectory(startupBinding, process.env));
  if (startupBinding.kind === "strict") {
    console.error(
      `[loombridge] Auto-binding to Unity project (LOOMBRIDGE_UNITY_PROJECT): ${startupBinding.target}`,
    );
  } else if (startupBinding.kind === "cwd") {
    console.error(
      `[loombridge] Auto-binding to Unity project (cwd, inferred from working directory): ${startupBinding.target}`,
    );
  }

  const editorRegistry = new EditorRegistry({
    startupBinding,
    onClientCreated: (client, projectPathCanonical) => {
      attachUnityClientEvents(client, traceRecorder, projectPathCanonical);
    },
  });

  // Heartbeats input sessions this server owns so they survive agent think-time gaps; dies
  // with the process (orphan safety), so an abandoned held-key session is still released.
  const inputKeepalive = new InputSessionKeepalive();

  // Create MCP Server
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── tools/list handler ───

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...opRegistry.toMCPTools(), ...LOOMBRIDGE_CORE_TOOLS],
    };
  });

  // ─── tools/call handler ───

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;

    if (toolName === EDITOR_LIST_TOOL_NAME) {
      // List is side-effect-free: peek the startup binding for display without committing
      // it. The effective-active path may come from the binding peek even when no active
      // pin is set yet; the first real routed op is what actually commits the binding.
      const records = editorRegistry.listRecords();
      const display = editorRegistry.describeListDisplayState(records);
      return formatToolResult(
        EDITOR_LIST_TOOL_NAME,
        buildEditorListPayload(
          records,
          display.effectiveActiveProjectPathCanonical,
          display.startupBinding,
        ),
      ) as CallToolResult;
    }

    if (toolName === EDITOR_USE_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const route = editorRegistry.useEditor(params.project);
        return formatToolResult(EDITOR_USE_TOOL_NAME, {
          activeProjectPathCanonical: route.projectPathCanonical,
          project: route.record
            ? buildEditorListPayload([route.record], route.projectPathCanonical).peers[0]
            : null,
        }) as CallToolResult;
      } catch (err) {
        if (err instanceof EditorRoutingError) {
          return formatErrorResult(
            formatEditorRoutingError(err, editorRegistry.activeProjectPathCanonical),
            err.code,
          ) as CallToolResult;
        }
        throw err;
      }
    }

    // Core-discovery tools (RCL-P01/P04): read/scaffold the local `.loombridge/`
    // verification state — never routed to Unity. `root` defaults to the server's
    // working directory (the consuming project).
    if (toolName === LOOMBRIDGE_STATUS_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      const root = typeof params.root === "string" && params.root.trim() ? path.resolve(params.root) : process.cwd();
      try {
        return formatToolResult(LOOMBRIDGE_STATUS_TOOL_NAME, await buildLoombridgeStatusPayload(root)) as CallToolResult;
      } catch (err) {
        return formatErrorResult(err instanceof Error ? err.message : String(err)) as CallToolResult;
      }
    }

    if (toolName === LOOMBRIDGE_PROJECT_INIT_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      const root = typeof params.root === "string" && params.root.trim() ? path.resolve(params.root) : process.cwd();
      try {
        return formatToolResult(LOOMBRIDGE_PROJECT_INIT_TOOL_NAME, await runLoombridgeProjectInit(root)) as CallToolResult;
      } catch (err) {
        return formatErrorResult(err instanceof Error ? err.message : String(err)) as CallToolResult;
      }
    }

    // Deterministic WORKFLOW front door (T4a). `verify` / `doneness` route to the
    // SAME code paths the `loombridge` CLI calls (never a re-decided verdict) and
    // surface the gate output VERBATIM; they never touch Unity. `root` defaults to
    // the server's working directory (the consuming project).
    if (toolName === LOOMBRIDGE_VERIFY_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      const root = typeof params.root === "string" && params.root.trim() ? path.resolve(params.root) : process.cwd();
      try {
        return formatToolResult(LOOMBRIDGE_VERIFY_TOOL_NAME, await runLoombridgeVerifyTool(root)) as CallToolResult;
      } catch (err) {
        return formatErrorResult(err instanceof Error ? err.message : String(err)) as CallToolResult;
      }
    }

    if (toolName === LOOMBRIDGE_DONENESS_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      const root = typeof params.root === "string" && params.root.trim() ? path.resolve(params.root) : process.cwd();
      try {
        return formatToolResult(LOOMBRIDGE_DONENESS_TOOL_NAME, await runLoombridgeDonenessTool(root)) as CallToolResult;
      } catch (err) {
        return formatErrorResult(err instanceof Error ? err.message : String(err)) as CallToolResult;
      }
    }

    // Mobile audit (T4a) DRIVES the `editor.audit_mobile_assets` bridge op — it
    // needs a routable editor. With the bridge absent it degrades to the SAME
    // routing/connection error every op gives (NOT_ROUTABLE etc.), then feeds the
    // payload through the CLI's report builder (byte-identical report) and returns
    // a summary + top offenders + the report path — never the full report inline.
    if (toolName === LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME) {
      const params = (request.params.arguments ?? {}) as Record<string, unknown>;
      const root = typeof params.root === "string" && params.root.trim() ? path.resolve(params.root) : process.cwd();
      const thresholds = extractMobileAuditThresholds(params);
      const auditParams: Record<string, unknown> =
        typeof params.max_entries === "number" ? { max_entries: params.max_entries } : {};

      let route: EditorRoute;
      try {
        route = editorRegistry.selectEditor(params.project);
      } catch (err) {
        if (err instanceof EditorRoutingError) {
          return formatErrorResult(
            formatEditorRoutingError(err, editorRegistry.activeProjectPathCanonical),
            err.code,
          ) as CallToolResult;
        }
        throw err;
      }

      const unityClient = route.client;
      if (!unityClient.isConnected) {
        try {
          await unityClient.connect();
        } catch (connectErr) {
          const routeMismatch = isRouteMismatchError(connectErr);
          const publicMessage = routeMismatch
            ? `Routed editor turned out to be a different Unity project than '${route.projectPathCanonical ?? "the selected target"}'. `
              + "Run loombridge_editor_list and re-select with loombridge_editor_use (or pass an explicit project)."
            : `Unity not connected: ${formatConnectionErrorMessage(connectErr)}`;
          return formatErrorResult(publicMessage, routeMismatch ? "ROUTE_MISMATCH" : "CONNECTION_ERROR") as CallToolResult;
        }
      }

      const auditTimeoutMs = opRegistry.getByToolName("unity_editor_audit_mobile_assets")?.defaultTimeoutMs ?? 90000;
      let msg: BridgeResponse;
      try {
        msg = await editorRegistry.runExclusive(route, () =>
          unityClient.send("editor.audit_mobile_assets", auditParams, auditTimeoutMs),
        );
      } catch (err) {
        return formatErrorResult(sanitizeErrorMessage(err)) as CallToolResult;
      }
      if (msg.status === "error") {
        return formatErrorResult(
          msg.error?.message ?? "editor.audit_mobile_assets failed",
          msg.error?.code,
        ) as CallToolResult;
      }

      const built = await buildAndWriteMobileAuditReport({ root, auditData: msg.data, thresholds });
      if (!built.ok) {
        return formatErrorResult(built.error) as CallToolResult;
      }
      return formatToolResult(LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME, built.payload) as CallToolResult;
    }

    const op = opRegistry.getByToolName(toolName);

    if (!op) {
      // RCL-T07: suggest near-matches in the same category instead of a bare "Unknown tool",
      // so a typo/probe self-corrects rather than triggering another wrong-op error.
      const suggestions = opRegistry.suggestToolNames(toolName);
      const hint = suggestions.length
        ? ` Did you mean: ${suggestions.join(", ")}? Call unity_ops_list to discover all ops.`
        : " Call unity_ops_list to discover all ops.";
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${toolName}.${hint}`,
      );
    }

    // RCL-T07: ops.list / ops.describe are server-side discovery ops — answer from the op
    // registry without routing to Unity (no editor required to enumerate the catalog).
    if (op.command === "ops.list" || op.command === "ops.describe") {
      const discoveryArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
      const payload =
        op.command === "ops.list"
          ? opRegistry.buildListing(str(discoveryArgs.category))
          : opRegistry.buildDescribe({
              command: str(discoveryArgs.command),
              toolName: str(discoveryArgs.toolName),
              category: str(discoveryArgs.category),
            });
      return formatToolResult(op.command, payload as unknown as Record<string, unknown>) as CallToolResult;
    }

    const params = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { unityParams, project, outputPath } = stripRoutingParams(params);

    // Reject provably-wrong arguments HERE rather than letting Unity throw. Forwarding a
    // schema-invalid value produced an opaque INTERNAL_ERROR (a C# cast exception) that
    // read like a bridge defect instead of a correctable caller mistake.
    const argProblems = validateOpArguments(unityParams, op.inputSchema);
    if (argProblems.length > 0) {
      return formatErrorResult(
        `${toolName}: ${argProblems.join("; ")}. Call unity_ops_describe with toolName="${toolName}" for the expected shape.`,
        "INVALID_ARGUMENT",
      ) as CallToolResult;
    }

    const startTime = Date.now();

    // RCL-T11: ops.batch accepts `operations` as a native array OR a JSON-encoded string (clients
    // that stringify a large nested array arg). Coerce + field-validate here so a structurally-bad
    // payload fails with a precise message instead of an opaque "could not be parsed as JSON", and
    // so the bridge always receives a clean array.
    if (op.command === "ops.batch") {
      try {
        unityParams.operations = normalizeBatchOperations(unityParams.operations);
      } catch (normErr) {
        const message = normErr instanceof Error ? normErr.message : String(normErr);
        const durationMs = Date.now() - startTime;
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: params,
          error: { code: "INVALID_PARAMS", message },
          durationMs,
        }).catch(() => {});
        return formatErrorResult(message, "INVALID_PARAMS") as CallToolResult;
      }
    }

    const timeoutMs = resolveOpTimeoutMs(op, unityParams);
    let route: EditorRoute;
    try {
      route = editorRegistry.selectEditor(project);
    } catch (err) {
      if (err instanceof EditorRoutingError) {
        const durationMs = Date.now() - startTime;
        const message = formatEditorRoutingError(err, editorRegistry.activeProjectPathCanonical);
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: params,
          error: { code: err.code, message },
          durationMs,
        }).catch(() => {});
        return formatErrorResult(message, err.code) as CallToolResult;
      }
      throw err;
    }

    const unityClient = route.client;

    if (shouldRunDeterministicPreflight(op.command)) {
      const bridgePreflight = new BridgePreflight(unityClient);
      // Reload-window ops (editor.wait_for/play/stop) exist to survive a domain reload, during
      // which the bridge listener briefly drops (ECONNREFUSED_NO_LISTENER). Poll preflight through
      // that transient window — bounded by this op's timeout — instead of failing PREFLIGHT_BLOCKED.
      const preflight = await runReloadAwarePreflight(op.command, timeoutMs, {
        runPreflight: () => bridgePreflight.run(op.command),
        hasEverConnected: () => unityClient.hasEverConnected,
      });
      if (preflight.status === "blocked") {
        const preflightMessage = formatPreflightBlockedMessage(preflight);
        const durationMs = Date.now() - startTime;
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: unityParams,
          projectPathCanonical: route.projectPathCanonical ?? undefined,
          projectName: route.record?.projectName,
          editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
          processId: route.record?.processId,
          error: {
            code: "PREFLIGHT_BLOCKED",
            message: preflightMessage,
            preflight,
          },
          durationMs,
        });
        return formatErrorResult(preflightMessage, "PREFLIGHT_BLOCKED") as CallToolResult;
      }
    }

    // Retry connection if not connected (e.g. server started before Unity)
    if (!unityClient.isConnected) {
      try {
        await unityClient.connect();
      } catch (connectErr) {
        const routeMismatch = isRouteMismatchError(connectErr);
        const publicMessage = routeMismatch
          ? `Routed editor turned out to be a different Unity project than '${route.projectPathCanonical ?? "the selected target"}'. `
            + "Run loombridge_editor_list and re-select with loombridge_editor_use (or pass an explicit project)."
          : `Unity not connected: ${formatConnectionErrorMessage(connectErr)}`;
        const code = routeMismatch ? "ROUTE_MISMATCH" : "CONNECTION_ERROR";
        const durationMs = Date.now() - startTime;
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: unityParams,
          projectPathCanonical: route.projectPathCanonical ?? undefined,
          projectName: route.record?.projectName,
          editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
          processId: route.record?.processId,
          error: { code, message: publicMessage },
          durationMs,
        });
        return formatErrorResult(publicMessage, code) as CallToolResult;
      }
    }

    let msg: BridgeResponse;
    try {
      msg = await editorRegistry.runExclusive(route, () =>
        unityClient.send(op.command, unityParams, timeoutMs)
      );
    } catch (err) {
      const errorMessage = sanitizeErrorMessage(err);

      // Retry once on a domain-reload-shaped drop. Always on CONNECTION_LOST (socket dropped — the
      // existing behavior). ADDITIONALLY, an idempotent async measurement/capture op retries when a
      // bare Timeout / connection-refused likely means the bridge froze through a reload mid-run
      // (RCL-T03 async follow-up: two measure_motion calls died on a 30s timeout catching a reload).
      // The reconnect wait is bounded tighter for the timeout case so a genuinely-overrunning op
      // doesn't stall the full 60s reconnect window.
      // Site d: a CONNECTION_LOST drop after a domain-reload-triggering op is the reload
      // firing — advise chaining editor.wait_for { compiling: false }. Gated on the ORIGINAL
      // drop signature (the reload signal), so a retry that later fails a different way still
      // carries the reload advice. Self-gates to nothing for non-reload ops / non-CONNECTION_LOST.
      const reloadReconnectHint = buildReloadReconnectHint(op.command, errorMessage);
      if (shouldRetryReloadDrop(op.command, errorMessage)) {
        const isConnectionLost = errorMessage.includes("CONNECTION_LOST");
        // A bare timeout while the socket is STILL connected is a genuine overrun, not a reload — re-
        // sending would double-run an in-flight async measurement/capture op. Only retry the bare-timeout
        // case when the socket actually dropped; CONNECTION_LOST already means the socket dropped.
        const reconnectBudgetMs = isConnectionLost ? 60000 : RELOAD_SEND_RECONNECT_BUDGET_MS;
        const reconnected =
          (isConnectionLost || !unityClient.isConnected) &&
          (await unityClient.waitForReconnect(reconnectBudgetMs));
        if (reconnected) {
          try {
            msg = await editorRegistry.runExclusive(route, () =>
              unityClient.send(op.command, unityParams, timeoutMs)
            );
          } catch (retryErr) {
            const retryMessage = sanitizeErrorMessage(retryErr);
            const durationMs = Date.now() - startTime;
            traceRecorder.record({
              timestamp: startTime,
              sessionId: traceRecorder.sessionId,
              type: "error",
              op: op.command,
              input: unityParams,
              projectPathCanonical: route.projectPathCanonical ?? undefined,
              projectName: route.record?.projectName,
              editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
              processId: route.record?.processId,
              error: { message: retryMessage },
              durationMs,
            });
            return formatErrorResult(
              retryMessage,
              "CONNECTION_ERROR",
              reloadReconnectHint,
            ) as CallToolResult;
          }
        } else {
          const durationMs = Date.now() - startTime;
          traceRecorder.record({
            timestamp: startTime,
            sessionId: traceRecorder.sessionId,
            type: "error",
            op: op.command,
            input: unityParams,
            projectPathCanonical: route.projectPathCanonical ?? undefined,
            projectName: route.record?.projectName,
            editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
            processId: route.record?.processId,
            error: { message: errorMessage },
            durationMs,
          });
          return formatErrorResult(
            errorMessage,
            "CONNECTION_ERROR",
            reloadReconnectHint,
          ) as CallToolResult;
        }
      } else {
        const durationMs = Date.now() - startTime;
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: unityParams,
          projectPathCanonical: route.projectPathCanonical ?? undefined,
          projectName: route.record?.projectName,
          editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
          processId: route.record?.processId,
          error: { message: errorMessage },
          durationMs,
        });
        return formatErrorResult(
          errorMessage,
          "CONNECTION_ERROR",
          reloadReconnectHint,
        ) as CallToolResult;
      }
    }

    // Entering Play Mode (by default) triggers a domain reload that tears the bridge
    // down and brings it back on a new port. The editor.play response is sent before
    // the reload fires, so `msg` is the play result — but the bridge is then briefly
    // unusable. Don't return until it's usable again so a naive
    // editor.play -> input.begin_session sequence can't race the reload.
    if (op.command === "editor.play" && msg.status !== "error") {
      const settle = await settlePlayMode(
        {
          waitForReconnect: (ms) => unityClient.waitForReconnect(ms),
          waitForPlaying: (ms) =>
            editorRegistry.runExclusive(route, () =>
              unityClient.send("editor.wait_for", { playMode: "playing", compiling: false }, ms)
            ),
        },
        PLAY_SETTLE_TIMEOUT_MS,
      );
      if (!settle.settled) {
        // GRL-B01: before reporting a generic settle failure, interrogate compile state — a
        // pre-existing compile error blocks Play while the bridge stays connected (no reload), so
        // get_state is reachable and carries a compile_error block when one is actually present.
        // Any fetch failure (a genuine reload drop) or absent compile_error keeps the old message.
        let compileError: unknown = undefined;
        try {
          const stateMsg = await editorRegistry.runExclusive(route, () =>
            unityClient.send("editor.get_state", {}, 5000)
          );
          if (stateMsg.status === "success") {
            const ce = (stateMsg.data as Record<string, unknown> | undefined)?.compile_error;
            if (ce && typeof ce === "object") compileError = ce;
          }
        } catch {
          // Bridge genuinely unusable — fall through to the generic settle message.
        }
        const message = buildPlaySettleFailureMessage(settle.error ?? "", compileError);
        const durationMs = Date.now() - startTime;
        traceRecorder.record({
          timestamp: startTime,
          sessionId: traceRecorder.sessionId,
          type: "error",
          op: op.command,
          input: unityParams,
          projectPathCanonical: route.projectPathCanonical ?? undefined,
          projectName: route.record?.projectName,
          editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
          processId: route.record?.processId,
          error: { message },
          durationMs,
        }).catch(() => {});
        // Site a: a compile error was affirmatively detected as the settle blocker — point at
        // the diagnostics tool that returns the authoritative per-assembly errors.
        return formatErrorResult(
          message,
          "CONNECTION_ERROR",
          buildPlaySettleCompileHint(compileError),
        ) as CallToolResult;
      }
    }

    const durationMs = Date.now() - startTime;

    let responseData = msg.data as unknown;
    if (msg.status === "success" && op.command === "editor.screenshot" && outputPath !== undefined) {
      if (typeof outputPath !== "string") {
        return formatErrorResult("outputPath must be a string", "INVALID_OUTPUT_PATH") as CallToolResult;
      }
      try {
        responseData = await writeScreenshotOutputPath(msg.data, outputPath);
      } catch (err) {
        return formatErrorResult((err as Error).message, "INVALID_OUTPUT_PATH") as CallToolResult;
      }
    }

    // Build trace entry
    const traceEntry: TraceEntry = {
      timestamp: startTime,
      sessionId: traceRecorder.sessionId,
      type: "op",
      op: op.command,
      input: unityParams,
      output: responseData as Record<string, unknown> | undefined,
      error: msg.status === "error" ? (msg.error as Record<string, unknown>) : undefined,
      durationMs,
      projectPathCanonical: route.projectPathCanonical ?? undefined,
      projectName: route.record?.projectName,
      editorSessionId: unityClient.handshake?.sessionId ?? route.record?.sessionId,
      processId: route.record?.processId,
      consoleDelta: msg.trace?.consoleDelta,
      artifacts: [],
    };

    // Ingest Unity artifacts if present
    if (msg.trace?.artifacts && msg.trace.artifacts.length > 0) {
      const ingested = await traceRecorder.ingestArtifacts(msg.trace.artifacts);
      traceEntry.artifacts = ingested;
    }

    // Record trace (async, don't block response)
    traceRecorder.record(traceEntry).catch((err) => {
      console.error(`[loombridge] Failed to record trace: ${(err as Error).message}`);
    });

    // Manage the input-session heartbeat for sessions this server owns. Starting on
    // begin_session / stopping on end_session keeps the bridge session alive across agent
    // think-time gaps while the server lives, and releases it when the server exits.
    if (msg.status === "success") {
      manageInputKeepalive(op.command, msg, unityClient, inputKeepalive);
    }

    // Format response
    if (msg.status === "error") {
      return formatErrorResult(
        msg.error?.message ?? "Unknown Unity error",
        msg.error?.code,
      ) as CallToolResult;
    }

    // Sites b & c: a successful response can still carry an affirmatively-detected failure
    // shape (a FAILED editor.wait_for compileResult, or error-severity console_logs entries).
    // At most one hint fires — the two shapes are on distinct commands, and `??` picks the first.
    const successHint =
      buildWaitForCompileFailureHint(op.command, responseData) ??
      buildConsoleErrorHint(op.command, responseData);
    return formatToolResult(op.command, responseData, successHint) as CallToolResult;
  });

  // ─── Graceful shutdown ───

  // Exit when the controlling MCP client goes away. Clients usually close our stdin
  // (EOF) rather than sending a signal, so stdin end/close MUST trigger teardown —
  // otherwise the live heartbeat timers + stdio read stream keep this process alive as
  // an orphan that churns the Unity bridge (observed: servers outliving their agent by
  // hours). Idempotent so overlapping triggers (e.g. stdin close racing SIGTERM, or the
  // transport's own onclose) tear down exactly once.
  let shuttingDown = false;
  const shutdown = async (cause: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[loombridge] Shutting down (${cause})...`);
    try {
      inputKeepalive.stopAll();
      await editorRegistry.disconnectAll();
      await server.close();
    } catch (err) {
      console.error(
        `[loombridge] Shutdown cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // The controlling client closing the pipe is the common, signal-less exit path.
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));
  // Belt-and-suspenders: the stdio transport also surfaces the pipe closing.
  server.onclose = () => void shutdown("transport closed");

  // ─── Start ───

  // Connections are lazy so the first tool call routes through the selected editor
  // instead of warming an unpinned legacy socket before discovery has settled.

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[loombridge] MCP server started (${SERVER_NAME} v${SERVER_VERSION})`);
  console.error(`[loombridge] Trace output: ${traceRecorder.traceDirectory}`);

  // ─── Startup diagnostics ───
  // One-line environment health snapshot so a dirty machine (orphaned sibling servers,
  // multiple editors, unexpected binding) is visible at boot instead of after the fact.
  // Best-effort: never block or fail startup on it.
  try {
    const records = editorRegistry.listRecords();
    const display = editorRegistry.describeListDisplayState(records);
    const binding =
      startupBinding.kind === "none" ? "none" : `${startupBinding.kind}:${startupBinding.target}`;
    const lines = formatDoctorLines({
      servers: await collectSiblingServers(process.pid),
      editorNames: records.map(
        (r) => r.projectName ?? r.projectPathCanonical ?? "unknown",
      ),
      binding,
      activeRoute: display.effectiveActiveProjectPathCanonical ?? null,
    });
    for (const line of lines) console.error(line);
  } catch (err) {
    console.error(
      `[loombridge] doctor diagnostics skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Start/stop the input-session heartbeat in response to begin_session / end_session,
 * using the routed client + the sessionId the bridge reported. Only called on success.
 * Exported for tests. Keepalive starts ONLY when this server CREATED the session
 * (begin_session → created:true). A second server/agent that inherits an already-active
 * session gets created:false and must NOT heartbeat it, so the session's held keys are
 * still released when the original owner dies (keepalive tied to owning-server liveness).
 */
export function manageInputKeepalive(
  command: string,
  msg: BridgeResponse,
  unityClient: UnityClient,
  keepalive: InputSessionKeepalive,
): void {
  const data = msg.data as { sessionId?: unknown; created?: unknown } | undefined;
  const sessionId = data?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return;

  if (command === "input.begin_session") {
    if (data?.created === true) {
      keepalive.start(sessionId, () => pingInputSession(unityClient, sessionId));
    }
  } else if (command === "input.end_session") {
    keepalive.stop(sessionId);
  }
}

/**
 * One heartbeat ping. Resolves true to keep pinging, false to stop. A `refreshed:false`
 * from the bridge means the session is no longer ours/active (stop); a transient send
 * failure resolves true so a reconnect blip doesn't permanently stop the heartbeat.
 */
async function pingInputSession(unityClient: UnityClient, sessionId: string): Promise<boolean> {
  try {
    const resp = await unityClient.send("input.keepalive", { sessionId }, 5000);
    if (resp.status === "success") {
      return (resp.data as { refreshed?: unknown } | undefined)?.refreshed === true;
    }
    return true;
  } catch {
    return true;
  }
}

function attachUnityClientEvents(
  unityClient: UnityClient,
  traceRecorder: TraceRecorder,
  projectPathCanonical: string | null,
): void {
  unityClient.events.onConnected = (handshake) => {
    // The per-op `editorSessionId` is authoritative in multi-editor traces.
    // Keep the JSONL filename stable instead of making it last-connection-wins.
    if (traceRecorder.sessionId === "unknown") {
      traceRecorder.setSessionId(handshake.sessionId);
    }
    traceRecorder.record({
      timestamp: Date.now(),
      sessionId: handshake.sessionId,
      type: "connect",
      projectPathCanonical: handshake.projectPathCanonical ?? projectPathCanonical ?? undefined,
      projectName: handshake.projectName,
      editorSessionId: handshake.sessionId,
      processId: handshake.processId,
    }).catch(() => {});
    console.error(
      `[loombridge] Connected to Unity (session: ${handshake.sessionId}, port: ${handshake.port}, `
      + `project: ${handshake.projectPathCanonical ?? projectPathCanonical ?? "unknown"})`,
    );
  };

  unityClient.events.onDisconnected = (reason) => {
    traceRecorder.record({
      timestamp: Date.now(),
      sessionId: traceRecorder.sessionId,
      type: "disconnect",
      projectPathCanonical: unityClient.handshake?.projectPathCanonical ?? projectPathCanonical ?? undefined,
      projectName: unityClient.handshake?.projectName,
      editorSessionId: unityClient.handshake?.sessionId,
      processId: unityClient.handshake?.processId,
      error: { reason },
    }).catch(() => {});
    console.error(`[loombridge] Disconnected from Unity: ${reason}`);
  };

  unityClient.events.onReconnecting = (attempt) => {
    console.error(
      `[loombridge] Reconnecting to Unity`
      + `${projectPathCanonical ? ` (${projectPathCanonical})` : ""} (attempt ${attempt + 1})...`,
    );
  };

  unityClient.events.onProbe = (message) => {
    console.error(`[loombridge] ${message}`);
  };
}

// Only run main if this is the entry point (not imported for testing)
const isMainModule = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");
if (isMainModule) {
  main().catch((err) => {
    console.error("[loombridge] Fatal error:", err);
    process.exit(1);
  });
}
