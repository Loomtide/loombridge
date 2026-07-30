/**
 * Replay Verification — live replay runner (Phase A, slice A4/product surface).
 *
 * The composition layer that ties the pure engine to a real bridge: connect a
 * `UnityClient`, drive the trace through `UnityDriver` over a reconnect-resilient
 * send, stamp run timestamps, and best-effort return the editor to edit mode.
 * Both the standalone `replay-cli` and the `loombridge trace replay` verb use this
 * so the live wiring lives in exactly one place.
 *
 * This is the only file in the replay module coupled to the concrete
 * `UnityClient`; the engine/driver/parser stay transport-agnostic and are not
 * re-exported through `index.ts` alongside this.
 */

import { UnityClient } from "../../bridge/unity-client.js";
import { replay } from "./engine.js";
import { resilientSend, type ReconnectableClient } from "./resilient-send.js";
import { endLiveSession, type LiveSessionClient } from "./session.js";
import { UnityDriver } from "./unity-driver.js";
import type { ReplayRunArtifact, ReplayTrace } from "./types.js";

/**
 * Everything a live replay asks of its transport: reconnect-aware sending plus a
 * disconnect. Stated structurally so the composition above it (trace verb → this runner →
 * the real `UnityDriver` → a scripted bridge) can be driven end to end without a Unity
 * editor. `UnityClient` satisfies it; nothing else in production implements it.
 */
export interface ReplayLiveClient extends ReconnectableClient, LiveSessionClient {}

export interface RunLiveReplayOptions {
  /** Directory the bridge screenshots are written to (under an allowed root). */
  captureDir: string;
  /** Inject a client (tests); defaults to a fresh auto-discovering `UnityClient`. */
  client?: UnityClient;
  /**
   * Inject the client FACTORY (the `feel` snapshot-verify precedent). The seam exists so a
   * test can walk this whole composition against a scripted bridge: without it, the only
   * thing that could prove the aligned fps reaches the driver was reading the code, and a
   * deleted pass-through below would leave every replay silently wall-clock while the
   * report kept stamping `alignedCaptureFps` (a false aligned stamp on unaligned frames).
   * Ignored when `client` is given.
   */
  clientFactory?: () => ReplayLiveClient;
  /**
   * The Unity project this replay belongs to. REQUIRED for correctness whenever more than
   * one editor is running: an unpinned client resolves through the shared
   * `endpoint-discovery-latest.json`, which every editor overwrites on its heartbeat, so
   * the same command would replay against whichever editor published last. Observed live:
   * identical invocations alternating between PASS and BLOCKED (reset-unavailable) as the
   * pointer flapped between two projects.
   */
  projectPathCanonical?: string;
  /**
   * Aligned-capture fps for this run, or absent for the legacy wall-clock settle. Passed
   * straight through to the driver: the ENGINE stays mode-blind, and the driver is the only
   * layer that knows a settle can be a bridge-side tick loop instead of a sleep here.
   */
  alignedCaptureFps?: number;
}

/** Replay a trace against the running editor and return the stamped artifact. */
export async function runLiveReplay(
  trace: ReplayTrace,
  options: RunLiveReplayOptions,
): Promise<ReplayRunArtifact> {
  const client: ReplayLiveClient =
    options.client
    ?? options.clientFactory?.()
    ?? new UnityClient(
      options.projectPathCanonical
        ? { targetIdentity: { projectPathCanonical: options.projectPathCanonical } }
        : {},
    );
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  await client.connect();
  const send = resilientSend(client);
  try {
    const driver = new UnityDriver(send, {
      captureDir: options.captureDir,
      ...(options.alignedCaptureFps !== undefined
        ? { alignedCaptureFps: options.alignedCaptureFps }
        : {}),
    });
    const report = await replay(trace, driver);
    return {
      ...report,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };
  } finally {
    // Leave the editor in edit mode AND wait for the bridge to settle before
    // disconnecting, so a subsequent run can reconnect (see session.ts).
    await endLiveSession(send, client);
  }
}
