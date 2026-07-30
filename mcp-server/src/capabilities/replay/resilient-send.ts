/**
 * Replay Verification — resilient bridge send (Phase A, slice A4).
 *
 * Entering Play Mode triggers a Unity domain reload that drops the WebSocket
 * (`CONNECTION_LOST: code=1006`), losing the in-flight op's response. This wraps
 * `send` to reconnect and retry once on a connection loss — EXCEPT for
 * non-idempotent ops (a click may have actuated before the socket dropped), where
 * re-sending would be a phantom double-dispatch. For those, the lost response is
 * surfaced as an error (a harness failure) rather than silently re-executed.
 *
 * Extracted from the CLI so it is unit-testable against a fake client without
 * importing the CLI's top-level `main()`.
 */

import type { BridgeResponse } from "../../shared/types.js";
import type { BridgeSend } from "./unity-driver.js";

/**
 * Ops whose side effect may already have happened when the socket dropped.
 *
 * Every INPUT op belongs here, not just the uGUI dispatch: a simulated pointer tap, a key
 * tap, and the two key EDGES are all delivered to the game the moment the handler runs, so
 * a retry after a lost response is a phantom SECOND press. For `input.key_down` /
 * `input.key_up` the damage is worse than a double tap, because the edges are what the
 * recorder replays: a re-sent `key_down` re-arms a hold the game already saw, and a re-sent
 * `key_up` releases a key a later segment is still holding. A replay that quietly
 * double-taps is not a replay of the demonstration.
 *
 * `input.pointer_tap_world` is the SAME op as `input.pointer_tap` one projection earlier: it
 * converts a world point through a camera and then dispatches exactly that tap. Listing the
 * screen-space form and not the world-space one would have left the identical phantom second
 * press reachable through the other door, which is how a set like this rots: the rule is
 * "every side-effecting input op the replay driver can send", not "the ops we happened to
 * enumerate".
 *
 * `replay.settle_and_capture` is here for a different reason: it is not merely
 * side-effecting, it ADVANCES GAME TIME. Re-sending it after a lost response would settle a
 * second time, so the returned frame would sit 2x the settle past the action while the
 * report labels it with the trace's single settle. That is exactly the phase skew the
 * aligned settle exists to remove, arriving through the retry path instead.
 */
export const NON_IDEMPOTENT_OPS: ReadonlySet<string> = new Set([
  "ui.dispatch_pointer",
  "replay.settle_and_capture",
  "input.pointer_tap",
  "input.pointer_tap_world",
  "input.key_tap",
  "input.key_down",
  "input.key_up",
]);

/** The subset of `UnityClient` that `resilientSend` needs. */
export interface ReconnectableClient {
  readonly isConnected: boolean;
  waitForReconnect(timeoutMs?: number): Promise<boolean>;
  connect(): Promise<unknown>;
  send(
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<BridgeResponse>;
}

export function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost/i.test(
    message,
  );
}

export async function ensureConnected(client: ReconnectableClient): Promise<void> {
  if (client.isConnected) return;
  if (await client.waitForReconnect(15000)) return;
  await client.connect();
}

export function resilientSend(client: ReconnectableClient): BridgeSend {
  return async (command, params, timeoutMs) => {
    await ensureConnected(client);
    try {
      return await client.send(command, params, timeoutMs);
    } catch (error) {
      if (!isConnectionLoss(error) || NON_IDEMPOTENT_OPS.has(command)) throw error;
      await ensureConnected(client);
      return await client.send(command, params, timeoutMs);
    }
  };
}
