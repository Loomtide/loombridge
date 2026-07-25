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

import { UnityClient } from "../../unity-client.js";
import { replay } from "./engine.js";
import { resilientSend } from "./resilient-send.js";
import { endLiveSession } from "./session.js";
import { UnityDriver } from "./unity-driver.js";
import type { ReplayRunArtifact, ReplayTrace } from "./types.js";

export interface RunLiveReplayOptions {
  /** Directory the bridge screenshots are written to (under an allowed root). */
  captureDir: string;
  /** Inject a client (tests); defaults to a fresh auto-discovering `UnityClient`. */
  client?: UnityClient;
  /**
   * The Unity project this replay belongs to. REQUIRED for correctness whenever more than
   * one editor is running: an unpinned client resolves through the shared
   * `endpoint-discovery-latest.json`, which every editor overwrites on its heartbeat, so
   * the same command would replay against whichever editor published last. Observed live:
   * identical invocations alternating between PASS and BLOCKED (reset-unavailable) as the
   * pointer flapped between two projects.
   */
  projectPathCanonical?: string;
}

/** Replay a trace against the running editor and return the stamped artifact. */
export async function runLiveReplay(
  trace: ReplayTrace,
  options: RunLiveReplayOptions,
): Promise<ReplayRunArtifact> {
  const client =
    options.client
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
    const driver = new UnityDriver(send, { captureDir: options.captureDir });
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
