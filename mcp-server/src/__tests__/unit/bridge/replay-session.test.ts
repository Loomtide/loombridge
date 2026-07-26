import assert from "node:assert/strict";
import test from "node:test";

import type { UnityClient } from "../../../bridge/unity-client.js";
import type { BridgeResponse } from "../../../shared/types.js";
import { endLiveSession } from "../../../capabilities/replay/session.js";

function okSend(calls: string[]) {
  return async (command: string): Promise<BridgeResponse> => {
    calls.push(command);
    return { id: "x", status: "success", data: {}, timestamp: 0 };
  };
}

test("endLiveSession: stops, waits for the editor to settle, then disconnects", async () => {
  const calls: string[] = [];
  let disconnected = false;
  const client = { disconnect: async () => { disconnected = true; } } as unknown as UnityClient;

  await endLiveSession(okSend(calls), client);

  assert.deepEqual(calls, ["editor.stop", "editor.wait_for"]);
  assert.equal(disconnected, true);
});

test("endLiveSession: a wait_for params include playMode stopped + compile/import idle", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const send = async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    seen.push({ command, ...params });
    return { id: "x", status: "success", data: {}, timestamp: 0 };
  };
  await endLiveSession(send, { disconnect: async () => {} } as unknown as UnityClient);

  const wait = seen.find((s) => s.command === "editor.wait_for")!;
  assert.equal(wait.playMode, "stopped");
  assert.equal(wait.compiling, false);
  assert.equal(wait.updating, false);
});

test("endLiveSession: still disconnects when a send throws (best-effort cleanup)", async () => {
  let disconnected = false;
  const send = async (): Promise<BridgeResponse> => {
    throw new Error("CONNECTION_LOST: code=1006");
  };
  const client = { disconnect: async () => { disconnected = true; } } as unknown as UnityClient;

  await endLiveSession(send, client);
  assert.equal(disconnected, true);
});

test("endLiveSession: a throwing disconnect does not propagate (never masks the run result)", async () => {
  const client = {
    disconnect: async () => {
      throw new Error("disconnect boom");
    },
  } as unknown as UnityClient;
  await assert.doesNotReject(() => endLiveSession(okSend([]), client));
});

test("endLiveSession: a bridge-error (timeout) wait_for is ignored, still disconnects", async () => {
  let disconnected = false;
  const send = async (command: string): Promise<BridgeResponse> =>
    command === "editor.wait_for"
      ? { id: "x", status: "error", data: null, error: { code: "TIMEOUT", message: "never settled" }, timestamp: 0 }
      : { id: "x", status: "success", data: {}, timestamp: 0 };
  const client = { disconnect: async () => { disconnected = true; } } as unknown as UnityClient;

  await endLiveSession(send, client);
  assert.equal(disconnected, true);
});
