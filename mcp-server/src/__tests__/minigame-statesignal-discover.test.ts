/**
 * Phase-2 — `scan` auto-detects a game's `stateSignal` (a phase/state enum on a manager
 * component) so a multi-screen/gesture game phase-aligns with zero hand-editing. The heuristic
 * is PURE (`scoreStateSignalProperty`/`pickStateSignal`) and exhaustively unit-tested; the bridge
 * walk (`flattenProbeTargets`/`candidatesFromProperties`/`discoverStateSignalCandidate`) is tested
 * with a mocked `send` — no Unity.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  candidatesFromProperties,
  discoverStateSignalCandidate,
  flattenProbeTargets,
  pickStateSignal,
  scoreStateSignalProperty,
  type StateSignalCandidate,
} from "../loombridge/minigame-statesignal-discover.js";
import type { BridgeResponse } from "../types.js";

const PHASES = ["Mix", "Cook", "Decorate", "Serve"];

test("scoreStateSignalProperty: a phase enum on a manager scores highest; component name is a bonus", () => {
  const manager = scoreStateSignalProperty("ChefGameManager", "phase", "Phase", PHASES);
  const plain = scoreStateSignalProperty("Flow", "phase", "Phase", PHASES);
  assert.ok(manager !== null && plain !== null);
  assert.ok(manager! > plain!, "manager component outscores a plain one for the same phase enum");
});

test("scoreStateSignalProperty: accepts the phase/state family; rejects unrelated enums", () => {
  assert.ok(scoreStateSignalProperty("GameController", "state", "State", PHASES)! >= 4);
  assert.ok(scoreStateSignalProperty("GameDirector", "gameState", "Game State", PHASES)! >= 4);
  assert.ok(scoreStateSignalProperty("LevelManager", "currentPhase", "Current Phase", PHASES)! >= 4);
  // Unrelated enums on UI/render components are never a game phase.
  assert.equal(scoreStateSignalProperty("Image", "type", "Type", ["Simple", "Sliced", "Tiled"]), null);
  assert.equal(scoreStateSignalProperty("Canvas", "renderMode", "Render Mode", ["ScreenSpaceOverlay", "WorldSpace"]), null);
  assert.equal(scoreStateSignalProperty("Light", "shadows", "Shadows", ["None", "Soft", "Hard"]), null);
});

test("scoreStateSignalProperty: the weak family (mode/step/stage) only qualifies on a manager-ish component", () => {
  // `mode` alone on a random component is too weak — would risk a false signal.
  assert.equal(scoreStateSignalProperty("ColorPicker", "mode", "Mode", ["RGB", "HSV", "Hex"]), null);
  // `mode`/`stage` on a manager/controller is viable (with >=3 values; see the dedicated weak-family test).
  assert.ok((scoreStateSignalProperty("GameManager", "mode", "Mode", ["Easy", "Mid", "Hard"]) ?? 0) >= 5);
  assert.ok((scoreStateSignalProperty("RoundController", "stage", "Stage", ["One", "Two", "Three"]) ?? 0) >= 4);
});

test("scoreStateSignalProperty: rejects degenerate enums (single value) and private serialized fields", () => {
  assert.equal(scoreStateSignalProperty("GameManager", "phase", "Phase", ["Only"]), null, "needs >=2 phases");
  assert.equal(scoreStateSignalProperty("GameManager", "phase", "Phase", []), null);
  assert.equal(scoreStateSignalProperty("GameManager", "_phase", "Phase", PHASES), null, "underscore = private, not public-reflection readable");
});

test("scoreStateSignalProperty: rejects a non-identifier (nested/array) serialized path the recorder can't reflect", () => {
  assert.equal(scoreStateSignalProperty("GameManager", "group.phase", "Phase", PHASES), null);
  assert.equal(scoreStateSignalProperty("GameManager", "phases.Array.data[0]", "Phase", PHASES), null);
});

test("scoreStateSignalProperty: the weak family needs >=3 values (a binary mode toggle is not a phase machine)", () => {
  assert.equal(scoreStateSignalProperty("GameManager", "mode", "Mode", ["Easy", "Hard"]), null, "2-value mode = a toggle, not phases");
  assert.ok((scoreStateSignalProperty("GameManager", "mode", "Mode", ["Easy", "Mid", "Hard"]) ?? 0) >= 5);
  // A clear phase/state name is unaffected by the >=3 rule (2 phases still fine).
  assert.ok((scoreStateSignalProperty("GameManager", "phase", "Phase", ["A", "B"]) ?? 0) >= 6);
});

test("pickStateSignal: deterministic — highest score, then more phases, then shorter/lexicographic locator", () => {
  const cands: StateSignalCandidate[] = [
    { locator: "/A/Long/Path/Manager", component: "GameManager", property: "phase", enumValues: PHASES, score: 9 },
    { locator: "/B", component: "Flow", property: "phase", enumValues: PHASES, score: 5 },
    { locator: "/A/Manager", component: "GameManager", property: "phase", enumValues: PHASES, score: 9 },
  ];
  // Two score-9 candidates tie on phases → shorter locator wins.
  assert.equal(pickStateSignal(cands)?.locator, "/A/Manager");
  assert.equal(pickStateSignal([]), undefined);
});

test("flattenProbeTargets: walks scenes+children, skips built-in components, dedups, ignores ':' locators", () => {
  const hierarchy = {
    scenes: [
      {
        name: "StarChef",
        rootObjects: [
          {
            locator: { path: "/Canvas" },
            components: ["RectTransform", "Canvas", "ChefGameManager"],
            children: [
              { locator: { path: "/Canvas/MixPanel" }, components: ["RectTransform", "Image"] },
              { locator: { path: "/Canvas/Audio" }, components: ["AudioSource", "AudioRouter"] },
              { locator: { path: "bad:locator" }, components: ["WeirdScript"] },
            ],
          },
          { locator: { path: "/Canvas" }, components: ["ChefGameManager"] }, // duplicate (path,component)
        ],
      },
    ],
  };
  const targets = flattenProbeTargets(hierarchy);
  // Only non-builtin custom scripts, deduped, no ':' locator.
  assert.deepEqual(targets, [
    { locator: "/Canvas", component: "ChefGameManager" },
    { locator: "/Canvas/Audio", component: "AudioRouter" },
  ]);
  assert.deepEqual(flattenProbeTargets({}), []);
  assert.deepEqual(flattenProbeTargets(null), []);
});

test("candidatesFromProperties: keeps only viable enum-phase props from a describe response", () => {
  const target = { locator: "/Canvas/ChefGameManager", component: "ChefGameManager" };
  const props = [
    { serializedPath: "phase", displayName: "Phase", type: "enum", enumValues: PHASES },
    { serializedPath: "score", displayName: "Score", type: "int", currentValue: 0 },
    { serializedPath: "difficulty", displayName: "Difficulty", type: "enum", enumValues: ["Easy", "Hard"] }, // not phase-family
  ];
  const cands = candidatesFromProperties(target, props);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].property, "phase");
  assert.equal(cands[0].component, "ChefGameManager");
  assert.deepEqual(candidatesFromProperties(target, "not-an-array"), []);
});

test("candidatesFromProperties: rejects a phase enum the bridge marks publicField:false ([SerializeField] private)", () => {
  const target = { locator: "/Canvas/GM", component: "GameManager" };
  // Same clean name `phase`, but the bridge reports it is NOT a public field → the recorder can't
  // read it by public reflection, so we must NOT emit a confident-but-silently-broken signal.
  const privateField = [{ serializedPath: "phase", displayName: "Phase", type: "enum", enumValues: PHASES, publicField: false }];
  assert.deepEqual(candidatesFromProperties(target, privateField), []);
  // publicField:true (or absent, older bridge) is accepted.
  const publicField = [{ serializedPath: "phase", displayName: "Phase", type: "enum", enumValues: PHASES, publicField: true }];
  assert.equal(candidatesFromProperties(target, publicField).length, 1);
  const olderBridge = [{ serializedPath: "phase", displayName: "Phase", type: "enum", enumValues: PHASES }];
  assert.equal(candidatesFromProperties(target, olderBridge).length, 1);
});

/** Build a mocked BridgeSend from a hierarchy + a per-(path,type) describe map. */
function mockSend(
  hierarchy: unknown,
  describe: Record<string, { properties: unknown }>,
): (cmd: string, params: Record<string, unknown>) => Promise<BridgeResponse> {
  const ok = (data: unknown): BridgeResponse => ({ status: "ok", data } as unknown as BridgeResponse);
  return async (cmd, params) => {
    if (cmd === "scene.get_hierarchy") return ok(hierarchy);
    if (cmd === "component.describe") {
      const path = (params.locator as { path?: string })?.path ?? "";
      const key = `${path}::${params.type_name as string}`;
      return ok(describe[key] ?? { properties: [] });
    }
    return ok({});
  };
}

test("discoverStateSignalCandidate: finds the manager phase enum end-to-end (mocked bridge)", async () => {
  const hierarchy = {
    scenes: [
      {
        name: "StarChef",
        rootObjects: [
          {
            locator: { path: "/Canvas" },
            components: ["RectTransform", "Canvas"],
            children: [
              { locator: { path: "/Canvas/ChefGameManager" }, components: ["ChefGameManager"] },
              { locator: { path: "/Canvas/MixPanel" }, components: ["Image"] },
            ],
          },
        ],
      },
    ],
  };
  const describe = {
    "/Canvas/ChefGameManager::ChefGameManager": {
      properties: [
        { serializedPath: "phase", displayName: "Phase", type: "enum", enumValues: PHASES },
        { serializedPath: "score", displayName: "Score", type: "int" },
      ],
    },
  };
  const got = await discoverStateSignalCandidate(mockSend(hierarchy, describe));
  assert.deepEqual(
    got && { locator: got.locator, component: got.component, property: got.property },
    { locator: "/Canvas/ChefGameManager", component: "ChefGameManager", property: "phase" },
  );
});

test("discoverStateSignalCandidate: returns undefined when no phase enum exists, or the bridge errors", async () => {
  // No phase enum anywhere → undefined (the G6 note then nudges a manual declaration).
  const hierarchy = {
    scenes: [{ name: "S", rootObjects: [{ locator: { path: "/GM" }, components: ["ScoreKeeper"] }] }],
  };
  const describe = { "/GM::ScoreKeeper": { properties: [{ serializedPath: "score", type: "int" }] } };
  assert.equal(await discoverStateSignalCandidate(mockSend(hierarchy, describe)), undefined);

  // A bridge error on get_hierarchy → undefined, never throws (scan still emits its draft).
  const erroring = async () => ({ status: "error", error: { message: "no scene" } }) as unknown as BridgeResponse;
  assert.equal(await discoverStateSignalCandidate(erroring), undefined);
});

test("discoverStateSignalCandidate: one component.describe throwing mid-walk doesn't abort discovery", async () => {
  const hierarchy = {
    scenes: [
      {
        name: "S",
        rootObjects: [
          { locator: { path: "/Flaky" }, components: ["FlakyScript"] },
          { locator: { path: "/GM" }, components: ["GameManager"] },
        ],
      },
    ],
  };
  const send = async (cmd: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    if (cmd === "scene.get_hierarchy") return { status: "ok", data: hierarchy } as unknown as BridgeResponse;
    const path = (params.locator as { path?: string })?.path;
    if (path === "/Flaky") throw new Error("describe blew up");
    return { status: "ok", data: { properties: [{ serializedPath: "phase", type: "enum", enumValues: PHASES, publicField: true }] } } as unknown as BridgeResponse;
  };
  const got = await discoverStateSignalCandidate(send);
  assert.equal(got?.locator, "/GM"); // the flaky probe is skipped; the real manager is still found
});

test("discoverStateSignalCandidate: two managers → deterministically picks the higher-scoring one", async () => {
  const hierarchy = {
    scenes: [
      {
        name: "S",
        rootObjects: [
          { locator: { path: "/Flow" }, components: ["LevelFlow"] }, // phase enum, weaker component
          { locator: { path: "/GM" }, components: ["GameManager"] }, // phase enum, manager → higher
        ],
      },
    ],
  };
  const enumProp = { serializedPath: "phase", type: "enum", enumValues: PHASES, publicField: true };
  const describe: Record<string, { properties: unknown }> = {
    "/Flow::LevelFlow": { properties: [enumProp] },
    "/GM::GameManager": { properties: [enumProp] },
  };
  const got = await discoverStateSignalCandidate(mockSend(hierarchy, describe));
  assert.equal(got?.component, "GameManager");
});

test("discoverStateSignalCandidate: maxProbes cap is respected and never throws", async () => {
  const roots = Array.from({ length: 5 }, (_, i) => ({ locator: { path: `/C${i}` }, components: [`Custom${i}`] }));
  const hierarchy = { scenes: [{ name: "S", rootObjects: roots }] };
  // The only phase enum lives on the LAST component, beyond a maxProbes of 2 → not found, no throw.
  const describe: Record<string, { properties: unknown }> = {
    "/C4::Custom4": { properties: [{ serializedPath: "phase", type: "enum", enumValues: PHASES, publicField: true }] },
  };
  assert.equal(await discoverStateSignalCandidate(mockSend(hierarchy, describe), 2), undefined);
  // With a cap that reaches it, it's found.
  assert.equal((await discoverStateSignalCandidate(mockSend(hierarchy, describe), 10))?.locator, "/C4");
});
