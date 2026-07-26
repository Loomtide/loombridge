import assert from "node:assert/strict";
import test from "node:test";

import { manageInputKeepalive } from "../surfaces/index.js";
import { InputSessionKeepalive, type KeepaliveScheduler } from "../bridge/input-keepalive.js";
import type { UnityClient } from "../bridge/unity-client.js";
import type { BridgeResponse } from "../shared/types.js";

// Intervals never auto-fire; we only care about registration bookkeeping here.
const inertScheduler: KeepaliveScheduler = {
  setInterval: () => ({}),
  clearInterval: () => {},
};

// manageInputKeepalive only registers a heartbeat; it never calls the client during start.
const fakeClient = {} as unknown as UnityClient;

function beginMsg(sessionId: string, created: boolean): BridgeResponse {
  return { status: "success", data: { sessionId, active: true, created } } as unknown as BridgeResponse;
}

test("manageInputKeepalive starts keepalive only for a session this server CREATED", () => {
  const ka = new InputSessionKeepalive(10_000, inertScheduler);

  // We created it (created:true) → own it → heartbeat.
  manageInputKeepalive("input.begin_session", beginMsg("s-own", true), fakeClient, ka);
  assert.equal(ka.has("s-own"), true, "created:true -> keepalive started");

  // Two-client regression: a second server that INHERITED an already-active session gets
  // created:false and must NOT start a heartbeat (else it preserves an abandoned held key).
  manageInputKeepalive("input.begin_session", beginMsg("s-inherited", false), fakeClient, ka);
  assert.equal(ka.has("s-inherited"), false, "created:false (inherited) -> no keepalive");

  assert.equal(ka.activeCount, 1, "only the owned session is heartbeated");
});

test("manageInputKeepalive stops the heartbeat on end_session", () => {
  const ka = new InputSessionKeepalive(10_000, inertScheduler);
  manageInputKeepalive("input.begin_session", beginMsg("s1", true), fakeClient, ka);
  assert.equal(ka.has("s1"), true);

  const endMsg = { status: "success", data: { sessionId: "s1" } } as unknown as BridgeResponse;
  manageInputKeepalive("input.end_session", endMsg, fakeClient, ka);
  assert.equal(ka.has("s1"), false, "end_session stops keepalive");
});

test("manageInputKeepalive ignores responses without a sessionId", () => {
  const ka = new InputSessionKeepalive(10_000, inertScheduler);
  const noSid = { status: "success", data: { created: true } } as unknown as BridgeResponse;
  manageInputKeepalive("input.begin_session", noSid, fakeClient, ka);
  assert.equal(ka.activeCount, 0);
});
