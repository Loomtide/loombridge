/**
 * Raw console-evidence capture writer (console-clean gate, no framing/tiles).
 *
 * Backend-only: drives the live Unity bridge and writes a `console.json` for the
 * `console-clean` gate straight from raw op output — so the agent never
 * HAND-AUTHORS it (a curated console.json can hide runtime errors).
 *
 * Some slices (e.g. `parallax`) require `console-clean` but have NO `framing`
 * rects to project and NO `GroundTiling` tiles to write — `loomtide capture`
 * otherwise had no recipe for them and refused.
 *
 * This module captures BOTH the play-enter STARTUP logs and the STEADY-state
 * soak logs, and writes them ALL to console.json (phase-tagged). It does NOT
 * clear the console after Play Mode starts — doing so would also drop real
 * one-time `Awake`/`Start`/play-enter errors and silently green a broken build.
 * The benign "IPC transport unavailable; fallback to tcp" infra warning is
 * excused by a NARROW allowlist IN THE console-clean GATE (`INFRA_WARNING_RE`),
 * not by hiding it here. Recipe: a single pre-play `clear_console` (baseline:
 * the editor is a persistent session, so this drops stale EDIT-mode logs from
 * before this capture — it runs BEFORE play, so it can't hide any play log),
 * enter Play Mode, settle, snapshot the startup logs, soak, snapshot the full
 * cumulative logs, then partition into startup/steady phases. Mirrors the
 * play→capture half of `captureFramingEvidence`, minus the screen-rects/camera.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { UnityClient } from "../unity-client.js";
import type { BridgeResponse } from "../types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
} from "./unity-client-resolver.js";

export interface CaptureConsoleArgs {
  /** Output dir for console.json (the slice's verify dir). */
  outDir: string;
  /** Optional currentBuild runId, stamped into provenance for freshness tracing. */
  runId?: string;
  /** Console log count to pull (default 200). */
  consoleCount?: number;
  /** Frames to wait after play-enter before snapshotting startup logs (default 30). */
  settleFrames?: number;
  /** Frames of steady-state gameplay to soak after the startup snapshot (default 30). */
  soakFrames?: number;
  /** Optional multi-editor routing target. Falls back to LOOMTIDE_UNITY_PROJECT. */
  project?: string;
}

export interface CaptureConsoleResult {
  consolePath: string;
  logCount: number;
  startupCount: number;
  steadyCount: number;
}

/** One captured console entry (TraceCollector shape). */
export interface ConsoleEntry {
  type?: string;
  level?: string;
  message?: string;
  condition?: string;
  stackTrace?: string;
  timestamp?: number;
}

export interface PhasedConsole {
  /** Every captured entry, phase-tagged, in capture order — nothing dropped. */
  logs: (ConsoleEntry & { phase: "startup" | "steady" })[];
  /** The play-enter logs (Awake/Start/first frames). */
  startupLogs: ConsoleEntry[];
  /** The steady-state soak logs. */
  steadyLogs: ConsoleEntry[];
}

/** Pull the `.logs` array out of an `editor.console_logs` result (bare array tolerated). */
export function logsArrayOf(consoleLogs: unknown): ConsoleEntry[] {
  if (Array.isArray((consoleLogs as { logs?: unknown })?.logs)) {
    return (consoleLogs as { logs: ConsoleEntry[] }).logs;
  }
  return Array.isArray(consoleLogs) ? (consoleLogs as ConsoleEntry[]) : [];
}

/**
 * Partition the two cumulative snapshots into startup/steady phases WITHOUT
 * dropping anything. The console is append-only between the two captures (no
 * clear in between), so the full snapshot is `startup ++ steady`; the steady
 * tail is everything after the first `startupCount` entries. The full snapshot
 * is authoritative for completeness — every startup entry (including any
 * play-enter error) is preserved in `logs`. Pure + exported for unit tests.
 */
export function partitionConsolePhases(
  startupSnapshot: ConsoleEntry[],
  fullSnapshot: ConsoleEntry[],
): PhasedConsole {
  // Clamp the boundary in case a count cap truncated the full snapshot below the
  // startup snapshot length — never slice past the end (which would invent or
  // drop entries). The full snapshot is the authoritative complete list.
  const boundary = Math.min(startupSnapshot.length, fullSnapshot.length);
  const startupLogs = fullSnapshot.slice(0, boundary);
  const steadyLogs = fullSnapshot.slice(boundary);
  return {
    logs: [
      ...startupLogs.map((e) => ({ ...e, phase: "startup" as const })),
      ...steadyLogs.map((e) => ({ ...e, phase: "steady" as const })),
    ],
    startupLogs,
    steadyLogs,
  };
}

function responseData(response: BridgeResponse, command: string): unknown {
  if (response.status === "error") {
    throw new Error(`${command} failed: ${response.error?.message ?? "unknown bridge error"}`);
  }
  return response.data;
}

function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost|code=1006/i.test(message);
}

async function ensureConnected(client: UnityClient): Promise<void> {
  if (client.isConnected) return;
  if (await client.waitForReconnect(15000)) return;
  await client.connect();
}

/** Send a bridge op, surviving the domain-reload that `editor.play` triggers. */
async function send(
  client: UnityClient,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<unknown> {
  await ensureConnected(client);
  try {
    return responseData(await client.send(command, params, timeoutMs), command);
  } catch (error) {
    if (!isConnectionLoss(error)) throw error;
    await ensureConnected(client);
    return responseData(await client.send(command, params, timeoutMs), command);
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Capture console evidence into outDir. Enters Play Mode, snapshots the
 * play-enter STARTUP logs after a settle, soaks a steady gameplay window,
 * snapshots the full cumulative logs, partitions them into startup/steady
 * phases (NOTHING dropped — startup errors are preserved), writes console.json,
 * and restores Edit Mode in a finally block. The benign IPC-fallback infra
 * warning is excused by the console-clean gate's allowlist, never hidden here.
 */
export async function captureConsoleEvidence(args: CaptureConsoleArgs): Promise<CaptureConsoleResult> {
  const consoleCount = args.consoleCount ?? 200;
  const settleFrames = args.settleFrames ?? 30;
  const soakFrames = args.soakFrames ?? 30;
  const consolePath = path.join(args.outDir, "console.json");
  const capturedAt = new Date().toISOString();

  const resolvedClient = createUnityClientForCli({ project: args.project });
  const client = resolvedClient.client;
  let startupSnapshot: ConsoleEntry[] = [];
  let fullSnapshot: ConsoleEntry[] = [];
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = buildUnityRoutingMetadata(resolvedClient);

  try {
    await client.connect();
    // Pre-play baseline: the editor is a persistent session, so clear the stale
    // EDIT-mode logs accumulated before this capture. This runs BEFORE play, so
    // it cannot hide any play-mode log (startup or steady).
    await send(client, "editor.clear_console", {}, 10000);

    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);
    // Let the play-enter bootstrap settle so Awake/Start/first-frame logs have
    // fired, then SNAPSHOT them (do NOT clear — that would drop real startup
    // errors). These become the "startup" phase.
    await send(client, "editor.wait_for", { playMode: "playing", frames: settleFrames, timeoutMs: 35000 }, 40000);
    startupSnapshot = logsArrayOf(await send(client, "editor.console_logs", { count: consoleCount }, 10000));
    // Soak a window of steady gameplay, then snapshot the FULL cumulative log
    // (startup ++ steady). The tail past the startup count is the "steady" phase.
    await send(client, "editor.wait_for", { playMode: "playing", frames: soakFrames, timeoutMs: 35000 }, 40000);
    fullSnapshot = logsArrayOf(await send(client, "editor.console_logs", { count: consoleCount }, 10000));
    unityRouting = buildUnityRoutingMetadata(resolvedClient);
  } finally {
    try {
      await send(client, "editor.stop", {}, 30000);
      await send(client, "editor.wait_for", { playMode: "stopped", timeoutMs: 30000 }, 35000);
    } catch {
      // best-effort restore
    }
    await resolvedClient.disconnect();
  }

  const phased = partitionConsolePhases(startupSnapshot, fullSnapshot);

  const provenance = {
    writer: "loomtide capture (console)",
    capturedAt,
    capturedInPlayMode: true,
    note:
      "Startup logs are captured (not cleared) so play-enter Awake/Start errors are graded by console-clean. " +
      "The benign IPC-fallback infra warning is excused by the gate's narrow allowlist, not hidden here.",
    unityRouting,
    ...(args.runId ? { runId: args.runId } : {}),
    sources: [
      { op: "unity_editor_clear_console", captured: "pre-play (edit-mode baseline only)" },
      { op: "unity_editor_play", captured: "enter play" },
      { op: "unity_editor_console_logs", count: consoleCount, captured: `play-mode startup snapshot (after ${settleFrames}-frame settle)` },
      { op: "unity_editor_console_logs", count: consoleCount, captured: `play-mode full snapshot (after ${soakFrames}-frame steady soak)` },
    ],
  };

  const consoleOut = {
    logs: phased.logs,
    startupLogs: phased.startupLogs,
    steadyLogs: phased.steadyLogs,
    _provenance: provenance,
  };

  await writeJson(consolePath, consoleOut);

  return {
    consolePath,
    logCount: phased.logs.length,
    startupCount: phased.startupLogs.length,
    steadyCount: phased.steadyLogs.length,
  };
}
