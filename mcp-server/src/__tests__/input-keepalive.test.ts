import assert from "node:assert/strict";
import test from "node:test";

import { InputSessionKeepalive, type KeepaliveScheduler } from "../input-keepalive.js";

/** A scheduler whose intervals fire only when the test calls fireAll(). */
class FakeScheduler implements KeepaliveScheduler {
  private nextId = 0;
  readonly fns = new Map<number, () => void>();
  setInterval(fn: () => void): unknown {
    const id = ++this.nextId;
    this.fns.set(id, fn);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fireAll(): void {
    for (const fn of [...this.fns.values()]) fn();
  }
}

/** Let queued microtasks/promise callbacks settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("start registers one heartbeat and is idempotent per session", () => {
  const sched = new FakeScheduler();
  const ka = new InputSessionKeepalive(10_000, sched);
  ka.start("s1", async () => true);
  ka.start("s1", async () => true); // duplicate ignored
  assert.equal(ka.activeCount, 1);
  assert.equal(ka.has("s1"), true);
  ka.start("", async () => true); // empty id ignored
  assert.equal(ka.activeCount, 1);
});

test("each tick pings; a true result keeps the heartbeat running", async () => {
  const sched = new FakeScheduler();
  const ka = new InputSessionKeepalive(10_000, sched);
  let pings = 0;
  ka.start("s1", async () => {
    pings++;
    return true;
  });
  sched.fireAll();
  await settle();
  sched.fireAll();
  await settle();
  assert.equal(pings, 2);
  assert.equal(ka.activeCount, 1, "stays active while ping returns true");
});

test("a false ping (session gone) stops that heartbeat", async () => {
  const sched = new FakeScheduler();
  const ka = new InputSessionKeepalive(10_000, sched);
  let alive = true;
  ka.start("s1", async () => alive);

  sched.fireAll();
  await settle();
  assert.equal(ka.activeCount, 1, "still alive after a true ping");

  alive = false;
  sched.fireAll();
  await settle();
  assert.equal(ka.activeCount, 0, "stopped after the bridge reports the session is gone");
  assert.equal(ka.has("s1"), false);
});

test("a throwing ping does not kill the heartbeat", async () => {
  const sched = new FakeScheduler();
  const ka = new InputSessionKeepalive(10_000, sched);
  ka.start("s1", async () => {
    throw new Error("transient");
  });
  sched.fireAll();
  await settle();
  assert.equal(ka.activeCount, 1, "transient throw is swallowed; heartbeat continues");
});

test("stop and stopAll clear timers", () => {
  const sched = new FakeScheduler();
  const ka = new InputSessionKeepalive(10_000, sched);
  ka.start("s1", async () => true);
  ka.start("s2", async () => true);
  assert.equal(ka.activeCount, 2);

  ka.stop("s1");
  assert.equal(ka.activeCount, 1);
  assert.equal(ka.has("s1"), false);
  assert.equal(sched.fns.size, 1, "underlying interval cleared");

  ka.stopAll();
  assert.equal(ka.activeCount, 0);
  assert.equal(sched.fns.size, 0, "all intervals cleared");
});
