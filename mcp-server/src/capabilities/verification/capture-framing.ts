/**
 * Raw framing-evidence capture writer.
 *
 * Backend-only: drives the live Unity bridge and writes `screen-rects.json` +
 * `console.json` for the framing / console-clean gates straight from raw op
 * output — so the agent never HAND-AUTHORS these capture files (the provenance
 * hole the framing slice exposed: a hand-typed screen-rects.json can claim any
 * camera, and a curated console.json can hide errors).
 *
 * It enriches the `scene.get_screen_rects` camera block with the live
 * `PixelPerfectCamera` settings (via `component.get_properties`) so the framing
 * gate's camera check can verify the pixel grid / upscaleRT, and stamps a
 * `_provenance` block recording the exact ops that produced the file. The CLI
 * surface is `loombridge capture` (see loombridge/capture.ts); this module composes
 * existing bridge ops and defines no command UX.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { UnityClient } from "../../bridge/unity-client.js";
import type { BridgeResponse } from "../../shared/types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
} from "../../bridge/unity-client-resolver.js";

export interface CaptureFramingArgs {
  /** Objects to project into screen space, e.g. ["/Player", "/Level/Flag"]. */
  locators: string[];
  /** Output dir for screen-rects.json + console.json (the slice's verify dir). */
  outDir: string;
  /** Camera GameObject path whose PixelPerfectCamera we read (default "/Main Camera"). */
  cameraPath?: string;
  /** Optional boundsMode for screen rects ("opaque" | "renderer" | "collider"). */
  boundsMode?: string;
  /**
   * The minted `currentBuild.runId`. REQUIRED and stamped unconditionally (H11):
   * see the `capture` door refusal; never a conditional spread.
   */
  runId: string;
  /** Console log count to pull (default 200). */
  consoleCount?: number;
  /** Optional multi-editor routing target. Falls back to LOOMBRIDGE_UNITY_PROJECT. */
  project?: string;
}

export interface CaptureFramingResult {
  screenRectsPath: string;
  consolePath: string;
  pixelPerfectCaptured: boolean;
  objectCount: number;
  logCount: number;
}

interface PropertyDescriptor {
  serializedPath?: string;
  displayName?: string;
  currentValue?: unknown;
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

/**
 * Send a bridge op, surviving the domain-reload that `editor.play` triggers
 * (which abruptly closes the websocket → CONNECTION_LOST). Mirrors the
 * capture-runner's reconnect-and-retry so the play-mode capture is reliable.
 */
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

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Map a `component.get_properties` result to serializedPath -> currentValue. */
function propMap(getPropsResult: unknown): Map<string, unknown> {
  const props = (getPropsResult as { properties?: PropertyDescriptor[] } | undefined)?.properties;
  const map = new Map<string, unknown>();
  if (Array.isArray(props)) {
    for (const p of props) {
      if (typeof p.serializedPath === "string") map.set(p.serializedPath, p.currentValue);
    }
  }
  return map;
}

/**
 * Pull the framing-relevant PixelPerfectCamera fields out of a
 * `component.get_properties` result (`{ properties: [{serializedPath, currentValue}] }`).
 */
export function extractPixelPerfect(getPropsResult: unknown): {
  assetsPPU?: number;
  refResolutionX?: number;
  refResolutionY?: number;
  upscaleRT?: boolean;
  pixelSnapping?: boolean;
} | null {
  const props = (getPropsResult as { properties?: PropertyDescriptor[] } | undefined)?.properties;
  if (!Array.isArray(props)) return null;
  const byPath = new Map<string, unknown>();
  for (const p of props) {
    if (typeof p.serializedPath === "string") byPath.set(p.serializedPath, p.currentValue);
  }
  return {
    assetsPPU: asNum(byPath.get("m_AssetsPPU")),
    refResolutionX: asNum(byPath.get("m_RefResolutionX")),
    refResolutionY: asNum(byPath.get("m_RefResolutionY")),
    upscaleRT: asBool(byPath.get("m_UpscaleRT")),
    pixelSnapping: asBool(byPath.get("m_PixelSnapping")),
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Capture framing evidence into outDir. Enters Play Mode (the framing gate
 * requires play-mode rects so a clipped HUD label is caught), captures, and
 * restores Edit Mode in a finally block.
 */
export async function captureFramingEvidence(args: CaptureFramingArgs): Promise<CaptureFramingResult> {
  const cameraPath = args.cameraPath ?? "/Main Camera";
  const consoleCount = args.consoleCount ?? 200;
  const screenRectsPath = path.join(args.outDir, "screen-rects.json");
  const consolePath = path.join(args.outDir, "console.json");
  const capturedAt = new Date().toISOString();

  const resolvedClient = createUnityClientForCli({ project: args.project });
  const client = resolvedClient.client;
  let screenRects: Record<string, unknown> = { objects: [] };
  let pixelPerfect: ReturnType<typeof extractPixelPerfect> = null;
  let authoredOrthographicSize: number | undefined;
  let fieldOfView: number | undefined;
  let consoleLogs: unknown = { logs: [] };
  // Snapshot routing identity while the handshake is still live; disconnect() clears it.
  let unityRouting = buildUnityRoutingMetadata(resolvedClient);

  const screenRectParams: Record<string, unknown> = { locators: args.locators.map((p) => ({ path: p })) };
  if (args.boundsMode) screenRectParams.boundsMode = args.boundsMode;

  try {
    await client.connect();
    await send(client, "editor.clear_console", {}, 10000);

    // Read the AUTHORED camera config in EDIT mode, BEFORE play — PixelPerfectCamera
    // overscans the live orthographicSize at runtime when the Game view isn't 16:9,
    // so the deterministic authored half-height is only legible pre-play.
    try {
      const camProps = await send(
        client,
        "component.get_properties",
        { locator: { path: cameraPath }, type_name: "Camera" },
        15000,
      );
      const cam = propMap(camProps);
      authoredOrthographicSize = asNum(cam.get("orthographic size"));
      // Vertical FOV for the PERSPECTIVE framing branch (visible ground-extent
      // gate). Harmless on an ortho rig (that branch ignores it).
      fieldOfView = asNum(cam.get("field of view"));
    } catch {
      authoredOrthographicSize = undefined;
      fieldOfView = undefined;
    }
    try {
      const ppResult = await send(
        client,
        "component.get_properties",
        { locator: { path: cameraPath }, type_name: "PixelPerfectCamera" },
        15000,
      );
      pixelPerfect = extractPixelPerfect(ppResult);
    } catch {
      // No PixelPerfectCamera on the camera (or get_properties failed): leave the
      // pixelPerfect block off so the framing gate degrades that check to WARN.
      pixelPerfect = null;
    }

    await send(client, "editor.play", {}, 30000);
    await send(client, "editor.wait_for", { playMode: "playing", frames: 2, timeoutMs: 30000 }, 35000);

    screenRects = (await send(client, "scene.get_screen_rects", screenRectParams, 30000)) as Record<string, unknown>;

    consoleLogs = await send(client, "editor.console_logs", { count: consoleCount }, 10000);
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

  // Merge the authored orthographicSize (edit-mode) + live PixelPerfectCamera
  // settings into the camera block the gate reads. The live `orthographicSize`
  // from screen_rects stays (informational, overscans); the authored value is
  // what the gate enforces.
  const cameraBlock = (screenRects.camera ?? {}) as Record<string, unknown>;
  const enrichedCamera = {
    ...cameraBlock,
    ...(typeof authoredOrthographicSize === "number" ? { authoredOrthographicSize } : {}),
    ...(typeof fieldOfView === "number" ? { fieldOfView } : {}),
    ...(pixelPerfect ? { pixelPerfect } : {}),
  };

  const provenance = {
    writer: "loombridge capture (framing)",
    capturedAt,
    capturedInPlayMode: true,
    unityRouting,
    runId: args.runId,
    sources: [
      { op: "unity_component_get_properties", type_name: "Camera", locator: cameraPath, captured: "edit-mode (authored orthographicSize + fieldOfView)" },
      { op: "unity_component_get_properties", type_name: "PixelPerfectCamera", locator: cameraPath, captured: "edit-mode" },
      { op: "unity_scene_get_screen_rects", params: screenRectParams, captured: "play-mode" },
      { op: "unity_editor_console_logs", count: consoleCount, captured: "play-mode" },
    ],
  };

  const screenRectsOut = { ...screenRects, camera: enrichedCamera, _provenance: provenance };
  const logsArray = Array.isArray((consoleLogs as { logs?: unknown }).logs)
    ? (consoleLogs as { logs: unknown[] }).logs
    : Array.isArray(consoleLogs)
      ? (consoleLogs as unknown[])
      : [];
  const consoleOut = { logs: logsArray, _provenance: provenance };

  await writeJson(screenRectsPath, screenRectsOut);
  await writeJson(consolePath, consoleOut);

  return {
    screenRectsPath,
    consolePath,
    pixelPerfectCaptured: pixelPerfect !== null,
    objectCount: Array.isArray(screenRects.objects) ? (screenRects.objects as unknown[]).length : 0,
    logCount: logsArray.length,
  };
}
