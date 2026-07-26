/**
 * Phase 1 — background-coverage DISCOVERY helper (advisory suggest data).
 *
 * `discoverBackgroundCandidates(send, contract)` walks a live scene over a FAKE bridge
 * `send` and returns a `BackgroundCandidates` recommendation: the chosen orthographic
 * gameplay camera, the recommended coverage layers (full-width bands or ≥98% single-layer),
 * the excluded decorative sprites (with reasons), and per-device union coverage of the
 * recommended set. It is ADVISORY + read-only — an odd scene yields an empty recommendation
 * plus warnings, never a throw.
 *
 * Fixture is CountTheFruits-shaped: an orthographic Main Camera (orthoSize 5, origin), four
 * full-width background bands (Sky/HillFar/HillNear/Ground), and five decorative sprites
 * (Sun + three clouds). Device set = base 16:9 + wide 20:9 (widest aspect ≈ 2.22 → halfW ≈ 11.1).
 *
 * Style mirrors minigame-background-coverage.test.ts (node:test + node:assert/strict).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { discoverBackgroundCandidates } from "../capabilities/minigame/minigame-background-discover.js";
import { assertValidMinigameContract } from "../capabilities/minigame/profiles/validator.js";
import type { BridgeResponse } from "../shared/types.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";

// orthoSize 5: at 16:9 (1.778) halfW ≈ 8.89; at 20:9 (2.222) halfW ≈ 11.11.
const ASPECT_16x9 = 16 / 9;

/** A contract over a base (16:9) + wide (20:9) device bracket; no checks need to be enabled. */
function discoverContract(): MinigameContract {
  return assertValidMinigameContract({
    schemaVersion: "1",
    id: "count-the-fruits",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/CountTheFruits.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    devices: [
      { id: "base-16x9", label: "16:9", width: 1280, height: 720 },
      { id: "wide-20x9", label: "Tall Android (20:9)", width: 2400, height: 1080 },
    ],
    requiredInFrame: [{ id: "tile", locator: "CountTheFruits:/Canvas/Tile" }],
    states: [
      { id: "start", kind: "start", requiredInFrame: ["tile"] },
      { id: "win", kind: "success_reward" },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 90 },
    interactionFlow: { happyPath: ["start", "win"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame"] },
  });
}

// ── fake bridge ──────────────────────────────────────────────────────────────────────

type Components = string[];
interface SpriteSpec { min: { x: number; y: number }; max: { x: number; y: number }; }
interface FakeScene {
  /** Hierarchy nodes keyed by path → { name, components, children paths }. */
  cameras: { path: string; name: string; orthographic: boolean; orthoSize: number; pos: { x: number; y: number } }[];
  sprites: { path: string; name: string; spec: SpriteSpec }[];
}

const ok = (data: Record<string, unknown>): BridgeResponse => ({ id: "t", status: "success", data, timestamp: 0 });
const err = (message: string): BridgeResponse => ({ id: "t", status: "error", data: null, error: { code: "ERR", message }, timestamp: 0 });

/** Build a fake `send` that answers get_hierarchy / get_bounds / get_properties from a scene. */
function fakeSend(scene: FakeScene, opts: { boundsError?: Set<string> } = {}) {
  const sceneName = "CountTheFruits";
  // Flat hierarchy: every object is a root with the given path (path already starts with '/').
  const rootObjects = [
    ...scene.cameras.map((c) => ({
      name: c.name,
      locator: { scene: sceneName, path: c.path },
      components: ["Transform", "Camera"] as Components,
    })),
    ...scene.sprites.map((s) => ({
      name: s.name,
      locator: { scene: sceneName, path: s.path },
      components: ["Transform", "SpriteRenderer"] as Components,
    })),
  ];

  return async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    if (command === "scene.get_hierarchy") {
      return ok({ scenes: [{ name: sceneName, rootObjects }] });
    }
    const locator = params.locator as { scene?: string; path?: string } | undefined;
    const path = locator?.path ?? "";
    if (command === "scene.get_bounds") {
      if (opts.boundsError?.has(path)) return err(`bounds unavailable for ${path}`);
      const cam = scene.cameras.find((c) => c.path === path);
      if (cam) return ok({ transform: { position: { x: cam.pos.x, y: cam.pos.y } }, renderers: [] });
      const spr = scene.sprites.find((s) => s.path === path);
      if (spr) return ok({ transform: { position: { x: 0, y: 0 } }, renderers: [{ min: spr.spec.min, max: spr.spec.max }] });
      return err(`no object at ${path}`);
    }
    if (command === "component.get_properties") {
      const cam = scene.cameras.find((c) => c.path === path);
      if (cam) {
        return ok({
          properties: [
            { displayName: "Orthographic", serializedPath: "m_Orthographic", currentValue: cam.orthographic },
            { displayName: "Size", serializedPath: "m_OrthographicSize", currentValue: cam.orthoSize },
          ],
        });
      }
      return err(`no Camera at ${path}`);
    }
    return err(`unexpected command ${command}`);
  };
}

/** Four FULL-WIDTH bands (x∈[-12,12] ≥ widest halfW 11.1) that together cover y∈[-5,5]. */
function fullWidthBands(): FakeScene["sprites"] {
  return [
    { path: "/Background/Sky", name: "Sky", spec: { min: { x: -12, y: 1.0 }, max: { x: 12, y: 5 } } },
    { path: "/Background/HillFar", name: "HillFar", spec: { min: { x: -12, y: -0.5 }, max: { x: 12, y: 1.5 } } },
    { path: "/Background/HillNear", name: "HillNear", spec: { min: { x: -12, y: -2 }, max: { x: 12, y: 0 } } },
    { path: "/Background/Ground", name: "Ground", spec: { min: { x: -12, y: -5 }, max: { x: 12, y: -1.5 } } },
  ];
}

/** Five decorative sprites: small, mid-frame, never full-width. */
function decorativeSprites(): FakeScene["sprites"] {
  return [
    { path: "/Background/Sun", name: "Sun", spec: { min: { x: 5, y: 2.5 }, max: { x: 7, y: 4.5 } } },
    { path: "/Background/Cloud1", name: "Cloud1", spec: { min: { x: -8, y: 2 }, max: { x: -5, y: 3 } } },
    { path: "/Background/Cloud2", name: "Cloud2", spec: { min: { x: -2, y: 3 }, max: { x: 1, y: 4 } } },
    { path: "/Background/Cloud3", name: "Cloud3", spec: { min: { x: 3, y: 1 }, max: { x: 6, y: 2 } } },
  ];
}

function mainCamera() {
  return { path: "/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, pos: { x: 0, y: 0 } };
}

// ── the happy path: 4 bands recommended, 5 decoratives excluded, full coverage ─────────

test("discover: the 4 full-width bands are recommended; the 5 decorative sprites are excluded with reasons", async () => {
  const scene: FakeScene = {
    cameras: [mainCamera()],
    sprites: [...fullWidthBands(), ...decorativeSprites(), { path: "/Background/Extra", name: "Extra", spec: { min: { x: -1, y: -1 }, max: { x: 1, y: 1 } } }],
  };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());

  // The chosen camera is the orthographic Main Camera.
  assert.ok(result.camera, "a gameplay camera was chosen");
  assert.equal(result.camera!.name, "Main Camera");
  assert.equal(result.camera!.orthographic, true);
  assert.equal(result.cameras.length, 1);

  // The 4 bands are recommended (full-width), in scene order.
  const recNames = result.recommended.map((r) => r.name);
  assert.deepEqual(recNames, ["Sky", "HillFar", "HillNear", "Ground"], `recommended bands; got ${recNames.join(",")}`);
  for (const r of result.recommended) assert.equal(r.fullWidthBand, true, `${r.name} is a full-width band`);

  // The 5 small sprites (Sun + 3 clouds + Extra) are excluded with a decorative reason.
  const exNames = result.excluded.map((e) => e.name).sort();
  assert.deepEqual(exNames, ["Cloud1", "Cloud2", "Cloud3", "Extra", "Sun"], `excluded decoratives; got ${exNames.join(",")}`);
  for (const e of result.excluded) assert.match(e.reason, /decorative: covers \d+% of the frame, not a full-width band/);

  // coverageByDevice has one entry per resolved device, each a numeric fraction; both fully covered.
  assert.equal(result.coverageByDevice.length, 2, "one coverage entry per device");
  for (const d of result.coverageByDevice) {
    assert.equal(typeof d.fraction, "number");
    assert.ok(Number.isFinite(d.fraction));
  }
  const base = result.coverageByDevice.find((d) => d.deviceId === "base-16x9")!;
  const wide = result.coverageByDevice.find((d) => d.deviceId === "wide-20x9")!;
  assert.equal(base.fraction, 1.0, "16:9 fully covered");
  assert.equal(wide.fraction, 1.0, "20:9 fully covered (bands are wide enough)");
  assert.deepEqual(base.gapEdges, []);
  assert.deepEqual(wide.gapEdges, []);
  assert.equal(result.warnings.length, 0, `no warnings; got ${result.warnings.join(" | ")}`);
});

// ── union rescue is scored at the WIDEST aspect, not the base ────────────────────────────

test("discover: a base-covered-but-wide-gap set is NOT all-recommended by the union rescue (rescue scores the WIDEST aspect)", async () => {
  // All four bands x∈[-9.6,9.6]: at 16:9 halfW ≈ 8.89 (the base union covers the frame) but at
  // 20:9 halfW ≈ 11.11 the union leaves a left/right gap. None is full-width at the widest aspect.
  // The rescue grades the WIDEST aspect (to stay consistent with the gate, which grades EVERY
  // device aspect), so a set that only covers the base must NOT be all-recommended — otherwise the
  // suggestion would recommend a set the gate then FAILS at the wide aspect.
  const bands: FakeScene["sprites"] = [
    { path: "/Background/Sky", name: "Sky", spec: { min: { x: -9.6, y: 1.0 }, max: { x: 9.6, y: 5 } } },
    { path: "/Background/HillFar", name: "HillFar", spec: { min: { x: -9.6, y: -0.5 }, max: { x: 9.6, y: 1.5 } } },
    { path: "/Background/HillNear", name: "HillNear", spec: { min: { x: -9.6, y: -2 }, max: { x: 9.6, y: 0 } } },
    { path: "/Background/Ground", name: "Ground", spec: { min: { x: -9.6, y: -5 }, max: { x: 9.6, y: -1.5 } } },
  ];
  const scene: FakeScene = { cameras: [mainCamera()], sprites: bands };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());

  // The rescue does NOT fire (the union gaps at the widest aspect) → nothing recommended, all excluded.
  assert.equal(result.recommended.length, 0, "the union rescue must NOT recommend a base-only-covered set");
  assert.equal(result.excluded.length, 4, "all four bands are excluded as decorative (no full-width band)");
  assert.ok(
    result.warnings.some((w) => /no background layer qualified as a coverage band/i.test(w)),
    `warns that nothing qualified; got ${result.warnings.join(" | ")}`,
  );
});

test("discover: bands full-width at the WIDEST aspect ARE all-recommended by the union rescue", async () => {
  // Bands x∈[-11.5,11.5] (≥ widest halfW 11.11) but each is a thin horizontal strip — no SINGLE
  // band covers ≥98% on its own, yet none even needs the rescue because each is a full-width band.
  // To exercise the RESCUE specifically, use bands that are individually NOT full-width-flagged but
  // whose UNION covers the widest frame: split each band slightly inside the right edge so no single
  // one spans the full width, but together they tile across the whole frame.
  const bands: FakeScene["sprites"] = [
    // Left half-strips and right half-strips that overlap in the middle: each spans only half the
    // width (not a full-width band), but the union spans x∈[-11.5,11.5] AND y∈[-5,5].
    { path: "/Background/TopLeft", name: "TopLeft", spec: { min: { x: -11.5, y: 0 }, max: { x: 0.5, y: 5 } } },
    { path: "/Background/TopRight", name: "TopRight", spec: { min: { x: -0.5, y: 0 }, max: { x: 11.5, y: 5 } } },
    { path: "/Background/BotLeft", name: "BotLeft", spec: { min: { x: -11.5, y: -5 }, max: { x: 0.5, y: 0 } } },
    { path: "/Background/BotRight", name: "BotRight", spec: { min: { x: -0.5, y: -5 }, max: { x: 11.5, y: 0 } } },
  ];
  const scene: FakeScene = { cameras: [mainCamera()], sprites: bands };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());

  // No single strip is a full-width band, but the UNION covers the widest aspect → rescue recommends all.
  for (const s of result.recommended) assert.equal(s.fullWidthBand, false, `${s.name} is not a full-width band`);
  assert.equal(result.recommended.length, 4, "the union rescue recommends all four strips (union covers the widest frame)");
  assert.equal(result.excluded.length, 0);
  const wide = result.coverageByDevice.find((d) => d.deviceId === "wide-20x9")!;
  assert.equal(wide.fraction, 1.0, "20:9 fully covered by the union");
});

// ── camera disambiguation ──────────────────────────────────────────────────────────────

test("discover: zero orthographic cameras → no camera, empty recommended, a clear warning", async () => {
  const scene: FakeScene = {
    cameras: [{ path: "/Main Camera", name: "Main Camera", orthographic: false, orthoSize: 5, pos: { x: 0, y: 0 } }],
    sprites: fullWidthBands(),
  };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());
  assert.equal(result.camera, undefined, "no orthographic camera chosen");
  assert.equal(result.cameras.length, 0, "no orthographic cameras recorded");
  assert.equal(result.recommended.length, 0, "nothing scored without a camera");
  assert.equal(result.coverageByDevice.length, 0);
  assert.ok(result.warnings.some((w) => /no orthographic camera/i.test(w)), `warns about no ortho camera; got ${result.warnings.join(" | ")}`);
});

test("discover: two orthographic cameras (neither 'Main Camera') → camera undefined, both in cameras[], a warning", async () => {
  const scene: FakeScene = {
    cameras: [
      { path: "/CameraA", name: "CameraA", orthographic: true, orthoSize: 5, pos: { x: 0, y: 0 } },
      { path: "/CameraB", name: "CameraB", orthographic: true, orthoSize: 5, pos: { x: 0, y: 0 } },
    ],
    sprites: fullWidthBands(),
  };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());
  assert.equal(result.camera, undefined, "ambiguous → no single camera chosen");
  assert.equal(result.cameras.length, 2, "both orthographic cameras surfaced for disambiguation");
  assert.equal(result.recommended.length, 0, "no scoring without a chosen camera");
  assert.ok(result.warnings.some((w) => /2 orthographic cameras/i.test(w) && /--background-camera/.test(w)), `warns to disambiguate; got ${result.warnings.join(" | ")}`);
});

test("discover: two orthographic cameras where exactly one is 'Main Camera' → that one is chosen", async () => {
  const scene: FakeScene = {
    cameras: [
      { path: "/UICamera", name: "UICamera", orthographic: true, orthoSize: 5, pos: { x: 0, y: 0 } },
      { path: "/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, pos: { x: 0, y: 0 } },
    ],
    sprites: fullWidthBands(),
  };
  const result = await discoverBackgroundCandidates(fakeSend(scene), discoverContract());
  assert.ok(result.camera, "the Main Camera is chosen among two orthographic cameras");
  assert.equal(result.camera!.name, "Main Camera");
  assert.equal(result.cameras.length, 2, "both ortho cameras still reported");
  assert.equal(result.recommended.length, 4, "scoring proceeds with the chosen camera");
});

// ── robustness: odd scenes never throw ─────────────────────────────────────────────────

test("discover: a failed scene.get_hierarchy returns a well-formed empty result + warning (no throw)", async () => {
  const send = async (command: string): Promise<BridgeResponse> =>
    command === "scene.get_hierarchy" ? err("hierarchy unavailable") : err("unused");
  const result = await discoverBackgroundCandidates(send, discoverContract());
  assert.equal(result.camera, undefined);
  assert.deepEqual(result.recommended, []);
  assert.deepEqual(result.coverageByDevice, []);
  assert.ok(result.warnings.some((w) => /hierarchy/i.test(w)), `warns about the hierarchy; got ${result.warnings.join(" | ")}`);
});

test("discover: an unreadable sprite's bounds is skipped, not thrown (the rest still recommend)", async () => {
  const scene: FakeScene = { cameras: [mainCamera()], sprites: fullWidthBands() };
  // HillFar's bounds error out — it is silently dropped; the other 3 bands still recommend.
  const result = await discoverBackgroundCandidates(
    fakeSend(scene, { boundsError: new Set(["/Background/HillFar"]) }),
    discoverContract(),
  );
  const recNames = result.recommended.map((r) => r.name);
  assert.ok(!recNames.includes("HillFar"), "the unreadable sprite is dropped");
  assert.deepEqual(recNames, ["Sky", "HillNear", "Ground"], `the readable bands still recommend; got ${recNames.join(",")}`);
  // Coverage now has a vertical gap where HillFar was (y∈(0,1.0)), but the call did not throw.
  assert.equal(result.coverageByDevice.length, 2);
});

test("discover: a send that REJECTS on scene.get_bounds resolves (never rejects) with a well-formed result", async () => {
  // A transport REJECTION (bridge connection-lost at the end of a long capture) on a per-node read
  // must be caught and the node skipped — discovery is documented as never-throwing.
  const scene: FakeScene = { cameras: [mainCamera()], sprites: fullWidthBands() };
  const inner = fakeSend(scene);
  const send = async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    if (command === "scene.get_bounds") throw new Error("CONNECTION_LOST: bridge socket closed");
    return inner(command, params);
  };
  // Must RESOLVE (not reject) with a well-formed shape. Every bounds read rejected → no usable
  // camera/layer geometry, so an empty recommendation, but a valid object and no throw.
  const result = await discoverBackgroundCandidates(send, discoverContract());
  assert.ok(result, "resolves to a result object");
  assert.deepEqual(result.recommended, [], "no layers usable when every bounds read rejects");
  assert.equal(result.camera, undefined, "no camera position readable when bounds rejects");
  assert.ok(Array.isArray(result.warnings), "well-formed warnings array");
});

test("discover: the bridge returning properties/renderers as a non-array object does not throw", async () => {
  // A malformed bridge reply (`properties`/`renderers` a non-array, non-undefined value) must be
  // guarded before the `for...of` in parseCameraProps/unionRenderers — otherwise it throws.
  const sceneName = "CountTheFruits";
  const send = async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    if (command === "scene.get_hierarchy") {
      return ok({
        scenes: [
          {
            name: sceneName,
            rootObjects: [
              { name: "Main Camera", locator: { scene: sceneName, path: "/Main Camera" }, components: ["Transform", "Camera"] },
              { name: "Sky", locator: { scene: sceneName, path: "/Background/Sky" }, components: ["Transform", "SpriteRenderer"] },
            ],
          },
        ],
      });
    }
    if (command === "scene.get_bounds") {
      // `renderers` is an OBJECT, not an array — must not crash unionRenderers.
      return ok({ transform: { position: { x: 0, y: 0 } }, renderers: { bogus: true } });
    }
    if (command === "component.get_properties") {
      // `properties` is an OBJECT, not an array — must not crash parseCameraProps.
      return ok({ properties: { bogus: true } });
    }
    return err(`unexpected ${command}`);
  };
  const result = await discoverBackgroundCandidates(send, discoverContract());
  assert.ok(result, "resolves without throwing on a non-array properties/renderers reply");
  // The camera has no parseable orthographic flag (properties wasn't an array) → no chosen camera.
  assert.equal(result.camera, undefined);
  assert.deepEqual(result.recommended, []);
});
