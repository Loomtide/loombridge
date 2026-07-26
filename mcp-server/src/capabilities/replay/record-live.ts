/**
 * Replay Verification — live recorder wiring (Phase B, promote-a-run).
 *
 * `recordLive(meta, demonstrate, opts)` connects to the running editor, resets to
 * the scene, runs the caller's `demonstrate` callback (which drives the flow via
 * the `RecordingSession`), and returns the recorded `ReplayTrace`. Mirrors
 * `run-live` so the live-bridge wiring lives in exactly one place; the caller
 * persists the trace (e.g. to `.loombridge/replays/traces/<id>.trace.json`).
 */

import { UnityClient } from "../../bridge/unity-client.js";
import { RecordingSession, type RecordingMeta } from "./record.js";
import { resilientSend } from "./resilient-send.js";
import { endLiveSession } from "./session.js";
import type { ReplayTrace } from "./types.js";
import { UnityDriver } from "./unity-driver.js";

export interface RecordLiveOptions {
  /** Where capture PNGs go during the demonstration (under an allowed root). */
  captureDir: string;
  client?: UnityClient;
  /**
   * Unity project to pin. Without it the client follows the shared
   * endpoint-discovery-latest.json pointer, which every running editor overwrites on its
   * heartbeat — so with two editors open the verb can drive the wrong project.
   */
  projectPathCanonical?: string;
}

export async function recordLive(
  meta: RecordingMeta,
  demonstrate: (session: RecordingSession) => Promise<void>,
  options: RecordLiveOptions,
): Promise<ReplayTrace> {
  const client =
    options.client
    ?? new UnityClient(
      options.projectPathCanonical
        ? { targetIdentity: { projectPathCanonical: options.projectPathCanonical } }
        : {},
    );
  await client.connect();
  const send = resilientSend(client);
  try {
    const driver = new UnityDriver(send, { captureDir: options.captureDir });
    // A recording always produces a `ui-events` (action) trace; gate the backend
    // the same way replay does rather than assume it.
    const capability = await driver.capabilityCheck("ui-events");
    if (!capability.supported) {
      throw new Error(`record: input backend unsupported (${capability.reason ?? "unsupported"})`);
    }
    const reset = await driver.reset({ scene: meta.scene, reset: "scene-load" });
    if (!reset.ok) {
      throw new Error(`record: reset failed (${reset.reason ?? "reset-unavailable"})`);
    }
    const session = new RecordingSession(driver, meta);
    await demonstrate(session);
    return session.build();
  } finally {
    await endLiveSession(send, client);
  }
}
