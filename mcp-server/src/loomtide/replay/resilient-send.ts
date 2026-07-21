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

import type { BridgeResponse } from "../../types.js";
import type { BridgeSend } from "./unity-driver.js";

/** Ops whose side effect may already have happened when the socket dropped. */
export const NON_IDEMPOTENT_OPS: ReadonlySet<string> = new Set(["ui.dispatch_pointer"]);

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
