import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeResponse } from "../types.js";
import { resilientSend, type ReconnectableClient } from "../loomtide/replay/index.js";

const CONN = new Error("CONNECTION_LOST: code=1006");
const ok = (): BridgeResponse => ({ id: "x", status: "success", data: { ok: true }, timestamp: 0 });

/** A fake client whose send() outcome is decided by the call index (1-based). */
function fakeClient(perCall: (n: number) => Promise<BridgeResponse>) {
  let calls = 0;
  const client: ReconnectableClient = {
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: async () => perCall(++calls),
  };
  return { client, count: () => calls };
}

test("resilientSend: idempotent op reconnects and retries once on connection loss", async () => {
  const { client, count } = fakeClient((n) => (n === 1 ? Promise.reject(CONN) : Promise.resolve(ok())));
  const send = resilientSend(client);

  const result = await send("ui.get_screen_rects", {});
  assert.equal(result.status, "success");
  assert.equal(count(), 2, "should retry exactly once");
});

test("resilientSend: non-idempotent click is NOT re-sent on connection loss (no phantom double-tap)", async () => {
  const { client, count } = fakeClient(() => Promise.reject(CONN));
  const send = resilientSend(client);

  await assert.rejects(() => send("ui.dispatch_pointer", { action: "click" }), /CONNECTION_LOST/);
  assert.equal(count(), 1, "dispatch must run at most once");
});

test("resilientSend: a non-connection error rethrows immediately (no retry)", async () => {
  const { client, count } = fakeClient(() => Promise.reject(new Error("NOT_FOUND: locator")));
  const send = resilientSend(client);

  await assert.rejects(() => send("ui.get_screen_rects", {}), /NOT_FOUND/);
  assert.equal(count(), 1);
});
