/**
 * Raw tile-evidence capture writer (platformer ground-tiling slice).
 *
 * Backend-only: invokes the locked `GroundTiling.WriteTileCaptures(outDir)` via
 * the allowlisted `capture.invoke_static` bridge op so `platform-tiles.json` and
 * `tile-render.json` are produced from RAW in-editor sprite sampling — never
 * hand-authored — then stamps a `_provenance` block onto each, and writes a
 * provenanced `console.json`. The CLI surface is `loomtide capture --slice
 * <ground-tiling>` (see loomtide/capture.ts); this module composes bridge ops
 * and defines no command UX.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { UnityClient } from "../unity-client.js";
import type { BridgeResponse } from "../types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
} from "./unity-client-resolver.js";

export const TILE_CAPTURE_FILES = ["platform-tiles.json", "tile-render.json"] as const;
export type TileCaptureFile = (typeof TILE_CAPTURE_FILES)[number];

export interface CaptureTilesArgs {
  /** Output dir for platform-tiles.json + tile-render.json + console.json (the slice verify dir). */
  outDir: string;
  /** Component declaring the static capture method (default "GroundTiling"). */
  component?: string;
  /** Static method to invoke (default "WriteTileCaptures"). */
  method?: string;
  /** Optional currentBuild runId, stamped into provenance. */
  runId?: string;
  /** Console log count to pull (default 200). */
  consoleCount?: number;
  /** Optional multi-editor routing target. Falls back to LOOMTIDE_UNITY_PROJECT. */
  project?: string;
}

export interface CaptureTilesResult {
  outDir: string;
  wrote: string[];
  provenancedFiles: string[];
  consolePath: string;
  logCount: number;
  playMode: boolean;
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

/**
 * Stamp a `_provenance` block onto a raw gate capture WITHOUT altering its
 * content. Exported + pure so the "we never fabricate capture content" rule is
 * unit-tested: the gate-shaped keys (e.g. `platforms`) pass through untouched.
 */
export function stampProvenance(raw: unknown, provenance: Record<string, unknown>): Record<string, unknown> {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };
  return { ...base, _provenance: provenance };
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function clearExpectedTileOutputs(outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all(
    TILE_CAPTURE_FILES.map(async (file) => {
      await fs.rm(path.join(outDir, file), { force: true });
    }),
  );
}

export async function stampExpectedTileCaptures(
  outDir: string,
  wrote: readonly string[],
  provenance: Record<string, unknown>,
): Promise<string[]> {
  const gateFiles = wrote.filter((f): f is TileCaptureFile =>
    (TILE_CAPTURE_FILES as readonly string[]).includes(f),
  );
  const provenancedFiles: string[] = [];
  for (const file of gateFiles) {
    const filePath = path.join(outDir, file);
    const raw = await readJsonIfExists(filePath);
    if (raw === undefined) continue;
    await writeJson(filePath, stampProvenance(raw, provenance));
    provenancedFiles.push(file);
  }
  return provenancedFiles;
}

/**
 * Capture tile evidence into outDir by invoking the allowlisted static capture
 * method through the bridge, then stamping provenance and writing console.json.
 */
export async function captureTileEvidence(args: CaptureTilesArgs): Promise<CaptureTilesResult> {
  const component = args.component ?? "GroundTiling";
  const method = args.method ?? "WriteTileCaptures";
  const consoleCount = args.consoleCount ?? 200;
  const capturedAt = new Date().toISOString();
  const consolePath = path.join(args.outDir, "console.json");

  const resolvedClient = createUnityClientForCli({ project: args.project });
  const client = resolvedClient.client;
  let invokeResult: { wrote?: string[]; outDir?: string; playMode?: boolean } = {};
  let consoleLogs: unknown = { logs: [] };
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = buildUnityRoutingMetadata(resolvedClient);

  try {
    await client.connect();
    await clearExpectedTileOutputs(args.outDir);
    await send(client, "editor.clear_console", {}, 10000);
    invokeResult = (await send(
      client,
      "capture.invoke_static",
      { component, method, outDir: args.outDir },
      30000,
    )) as { wrote?: string[]; outDir?: string; playMode?: boolean };
    consoleLogs = await send(client, "editor.console_logs", { count: consoleCount }, 10000);
    unityRouting = buildUnityRoutingMetadata(resolvedClient);
  } finally {
    await resolvedClient.disconnect();
  }

  const playMode = invokeResult.playMode === true;
  const editorMode = playMode ? "play-mode" : "edit-mode";
  const captureProvenance = {
    writer: "loomtide capture (ground-tiling)",
    capturedAt,
    component,
    method,
    outDir: invokeResult.outDir ?? args.outDir,
    ...(args.runId ? { runId: args.runId } : {}),
    editorMode,
    unityRouting,
    consoleCleared: true,
    source: `${component}.${method} via capture.invoke_static`,
  };

  // Stamp provenance onto each gate JSON the static method wrote (without
  // altering its content). Only the two known gate files; ignore anything else.
  const provenancedFiles = await stampExpectedTileCaptures(args.outDir, invokeResult.wrote ?? [], captureProvenance);

  const logsArray = Array.isArray((consoleLogs as { logs?: unknown }).logs)
    ? (consoleLogs as { logs: unknown[] }).logs
    : Array.isArray(consoleLogs)
      ? (consoleLogs as unknown[])
      : [];
  await writeJson(consolePath, {
    logs: logsArray,
    _provenance: {
      writer: "loomtide capture (ground-tiling)",
      capturedAt,
      ...(args.runId ? { runId: args.runId } : {}),
      editorMode,
      unityRouting,
      consoleCleared: true,
      source: "unity_editor_console_logs",
    },
  });

  return {
    outDir: invokeResult.outDir ?? args.outDir,
    wrote: invokeResult.wrote ?? [],
    provenancedFiles,
    consolePath,
    logCount: logsArray.length,
    playMode,
  };
}
