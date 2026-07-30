import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeResponse } from "../../../shared/types.js";
import {
  NON_IDEMPOTENT_OPS,
  resilientSend,
  type ReconnectableClient,
} from "../../../capabilities/replay/index.js";

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

// S4: every op that DELIVERS INPUT or ADVANCES GAME TIME is non-idempotent, one test per
// op so a set that quietly loses an entry fails by name. A retry after a lost response is a
// phantom second press (input ops) or a second settle whose frame sits at twice the trace's
// settle while the report labels it with one (the aligned capture).
for (const command of [
  "replay.settle_and_capture",
  "input.pointer_tap",
  "input.key_tap",
  "input.key_down",
  "input.key_up",
] as const) {
  test(`resilientSend: ${command} is NOT re-sent on connection loss`, async () => {
    const { client, count } = fakeClient(() => Promise.reject(CONN));
    const send = resilientSend(client);

    await assert.rejects(() => send(command, {}), /CONNECTION_LOST/);
    assert.equal(count(), 1, `${command} must run at most once`);
  });
}

test("NON_IDEMPOTENT_OPS: the set is exactly the six side-effecting replay ops", () => {
  assert.deepEqual(
    [...NON_IDEMPOTENT_OPS].sort(),
    [
      "input.key_down",
      "input.key_tap",
      "input.key_up",
      "input.pointer_tap",
      "replay.settle_and_capture",
      "ui.dispatch_pointer",
    ],
  );
});

test("resilientSend: a non-connection error rethrows immediately (no retry)", async () => {
  const { client, count } = fakeClient(() => Promise.reject(new Error("NOT_FOUND: locator")));
  const send = resilientSend(client);

  await assert.rejects(() => send("ui.get_screen_rects", {}), /NOT_FOUND/);
  assert.equal(count(), 1);
});
