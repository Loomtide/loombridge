import assert from "node:assert/strict";
import test from "node:test";

import {
  distinctEditorProjects,
  resolveSingleEditorTarget,
} from "../capabilities/minigame/minigame-scene-endpoint.js";
import type { UnityEndpointDiscoveryRecord } from "../shared/types.js";

/** A minimal live, routable discovery record for a project (one IPC endpoint, distinct pid). */
function record(
  projectPathCanonical: string,
  opts: { projectName?: string; processId?: number; publishedAtUnixMs?: number } = {},
): UnityEndpointDiscoveryRecord {
  return {
    schemaVersion: "1",
    sessionId: `s-${projectPathCanonical}-${opts.processId ?? 1}`,
    projectPathCanonical,
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    processId: opts.processId ?? 1,
    publishedAtUnixMs: opts.publishedAtUnixMs ?? 1000,
    expiresAtUnixMs: 9_999_999_999_999,
    transportModeDefault: "auto",
    endpoints: [
      { transport: "ipc", kind: "unix_domain_socket", path: `/tmp/${opts.processId ?? 1}.sock`, supportsHandshake: true, supportsPing: true },
    ],
  };
}

const KIDS = "/Users/x/LoombridgeGames/GameHub";
const SHOOTER = "/Users/x/Loombridge/unity-projects/shooter-combat-dogfood";

test("resolveSingleEditorTarget: exactly one editor → that's the target", () => {
  const r = resolveSingleEditorTarget([record(KIDS, { projectName: "GameHub" })]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.target.projectPathCanonical, KIDS);
  assert.equal(r.ok && r.target.projectName, "GameHub");
});

test("resolveSingleEditorTarget: zero editors → refuse (none), never guess", () => {
  const r = resolveSingleEditorTarget([]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "none");
  assert.match((!r.ok && r.message) || "", /no running Unity editor/i);
});

test("resolveSingleEditorTarget: two distinct projects → ambiguous, both listed", () => {
  // The exact live scenario: a GameHub recording must not silently scan against the shooter.
  const r = resolveSingleEditorTarget([
    record(KIDS, { projectName: "GameHub", processId: 1 }),
    record(SHOOTER, { projectName: "shooter-combat-dogfood", processId: 2 }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "ambiguous");
  assert.equal(!r.ok && r.projects.length, 2);
  assert.match((!r.ok && r.message) || "", /GameHub/);
  assert.match((!r.ok && r.message) || "", /shooter-combat-dogfood/);
  assert.match((!r.ok && r.message) || "", /LOOMBRIDGE_TARGET_PROJECT_PATH/);
});

test("resolveSingleEditorTarget: two editors of the SAME project → not ambiguous (same scenes)", () => {
  const r = resolveSingleEditorTarget([
    record(KIDS, { processId: 1, publishedAtUnixMs: 1000 }),
    record(KIDS, { processId: 2, publishedAtUnixMs: 2000 }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.target.projectPathCanonical, KIDS);
});

test("resolveSingleEditorTarget: an explicit pin is honoured when its editor is live", () => {
  const r = resolveSingleEditorTarget(
    [record(KIDS, { projectName: "GameHub" }), record(SHOOTER)],
    SHOOTER,
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.target.projectPathCanonical, SHOOTER);
});

test("resolveSingleEditorTarget: a pin with NO live editor → refuse (none), never pin blind", () => {
  const r = resolveSingleEditorTarget([record(KIDS)], "/Users/x/SomeOtherProject");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "none");
  assert.match((!r.ok && r.message) || "", /pinned project/i);
});

test("resolveSingleEditorTarget: a pin is honoured even when only its editor is open (single)", () => {
  const r = resolveSingleEditorTarget([record(KIDS)], KIDS);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.target.projectPathCanonical, KIDS);
});

test("distinctEditorProjects: a record without a canonical project path is dropped (unroutable)", () => {
  const noPath: UnityEndpointDiscoveryRecord = { ...record(KIDS), projectPathCanonical: undefined };
  assert.deepEqual(distinctEditorProjects([noPath]), []);
});

test("resolveSingleEditorTarget: case-insensitive pin match (macOS/Windows path folding)", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, () => {
  const r = resolveSingleEditorTarget([record(KIDS)], KIDS.toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.target.projectPathCanonical, KIDS);
});
