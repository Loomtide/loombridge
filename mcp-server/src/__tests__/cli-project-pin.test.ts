import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCliProjectPin } from "../loombridge/cli-project-pin.js";

function makeUnityProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-project-"));
  fs.mkdirSync(path.join(dir, "Assets"));
  return dir;
}

function makeWorkspace(): string {
  // The flat mini-game layout: a --root that is NOT the game (no Assets/, no
  // ProjectSettings/, no Packages/manifest.json).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-workspace-"));
  fs.mkdirSync(path.join(dir, "traces"));
  return dir;
}

test("pin: an explicit project wins, even over a valid root", () => {
  const project = makeUnityProject();
  const root = makeUnityProject();
  assert.equal(resolveCliProjectPin({ project, root }), path.resolve(project));
});

test("pin: a root that is a Unity project is used", () => {
  const root = makeUnityProject();
  assert.equal(resolveCliProjectPin({ root }), path.resolve(root));
});

test("pin: a workspace root is NOT pinned", () => {
  // Pinning the mini-game workspace would match no editor at all, which is worse than
  // staying unpinned — so this must fall through rather than invent a target.
  assert.equal(resolveCliProjectPin({ root: makeWorkspace() }), undefined);
});

test("pin: absent inputs and a non-existent root stay unpinned", () => {
  assert.equal(resolveCliProjectPin({}), undefined);
  assert.equal(resolveCliProjectPin({ root: "" }), undefined);
  assert.equal(resolveCliProjectPin({ root: "   " }), undefined);
  assert.equal(resolveCliProjectPin({ root: "/definitely/not/here-xyz" }), undefined);
});

test("pin: an explicit project is honoured even if it does not exist yet", () => {
  // The caller asked for a specific editor by name; failing to match is the routing
  // layer's job to report, not something to silently downgrade to "whichever published last".
  assert.equal(resolveCliProjectPin({ project: "/some/project" }), path.resolve("/some/project"));
});

test("pin: results are absolute", () => {
  const root = makeUnityProject();
  const pinned = resolveCliProjectPin({ root });
  assert.ok(pinned && path.isAbsolute(pinned));
});
