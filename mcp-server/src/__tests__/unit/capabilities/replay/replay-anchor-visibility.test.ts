/**
 * Anchor visibility through UnityDriver's `wait-for-visible` dispatch: the uGUI
 * hit-target pattern (an element whose OWN Image is alpha-0/disabled with the
 * visible art on child objects; live case: KidsAdventure's hub tiles). The bridge
 * reports `descendantVisible` for exactly the two own-graphic failure reasons;
 * the anchor accepts it as visible. Every other failure stays a refusal, and a
 * transparent element WITHOUT visible child art stays a refusal (the LITMUS: the
 * relaxation must never become a silent skip for genuinely invisible controls).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { UnityDriver, type BridgeSend } from "../../../../capabilities/replay/unity-driver.js";
import type { Action } from "../../../../capabilities/replay/types.js";

/** A send stub that answers ui.get_screen_rects with the given object entry. */
function sendForEntry(entry: Record<string, unknown> | undefined): BridgeSend {
  return async (command) => {
    if (command !== "ui.get_screen_rects") {
      throw new Error(`unexpected op in this test: ${command}`);
    }
    return {
      status: "success",
      data: { objects: entry ? [entry] : [] },
    } as Awaited<ReturnType<BridgeSend>>;
  };
}

const WAIT: Action = {
  do: "wait-for-visible",
  locator: { scene: "KidsAdventure", path: "/Canvas/Tiles/Tile_KidsChef" },
  timeoutMs: 1,
};

function driver(entry: Record<string, unknown> | undefined): UnityDriver {
  // pollIntervalMs high + timeoutMs 1 → exactly one poll, so refusal cases don't spin.
  return new UnityDriver(sendForEntry(entry), { pollIntervalMs: 1000 });
}

test("wait-for-visible: an alpha-0 hit-target with VISIBLE child art is anchor-visible", async () => {
  const res = await driver({
    isVisible: false,
    visibilityReason: "graphic-transparent",
    descendantVisible: true,
  }).dispatch(WAIT);
  assert.equal(res.ok, true);
});

test("wait-for-visible: a disabled-own-graphic hit-target with visible child art is anchor-visible", async () => {
  const res = await driver({
    isVisible: false,
    visibilityReason: "graphic-disabled",
    descendantVisible: true,
  }).dispatch(WAIT);
  assert.equal(res.ok, true);
});

test("wait-for-visible LITMUS: transparent WITHOUT visible child art still refuses with the reason", async () => {
  const res = await driver({
    isVisible: false,
    visibilityReason: "graphic-transparent",
    descendantVisible: false,
  }).dispatch(WAIT);
  assert.equal(res.ok, false);
  assert.match((res as { detail?: string }).detail ?? "", /graphic-transparent/);
});

test("wait-for-visible LITMUS: descendantVisible never rescues a NON-own-graphic failure", async () => {
  // A hostile/buggy payload claiming visible descendants on an inactive element must not pass:
  // the relaxation is scoped to the two own-graphic reasons only.
  for (const reason of ["inactive", "canvas-disabled", "off-screen", "canvasgroup-alpha-zero"]) {
    const res = await driver({
      isVisible: false,
      visibilityReason: reason,
      descendantVisible: true,
    }).dispatch(WAIT);
    assert.equal(res.ok, false, `reason '${reason}' must stay a refusal`);
  }
});

test("wait-for-visible: a genuinely visible element still passes (no regression)", async () => {
  const res = await driver({ isVisible: true, visibilityReason: null }).dispatch(WAIT);
  assert.equal(res.ok, true);
});

test("wait-for-visible: an absent object still refuses as not-found", async () => {
  const res = await driver(undefined).dispatch(WAIT);
  assert.equal(res.ok, false);
  assert.match((res as { detail?: string }).detail ?? "", /not-found/);
});
