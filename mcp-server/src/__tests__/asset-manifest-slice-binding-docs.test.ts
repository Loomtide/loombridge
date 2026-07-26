import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SLICE_ASSET_BINDINGS } from "../capabilities/assets/asset-manifest.js";
import { REPO_ROOT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

test("build command documents every manifest slice asset binding and forbids registry fallback", () => {
  const build = read("commands/loombridge/build.md");

  assert.match(build, /ASSET_MANIFEST\.json/);
  assert.match(build, /sliceBindings/);
  assert.match(build, /resolvedPaths/);
  assert.match(build, /do not substitute a registry asset/i);
  for (const binding of DEFAULT_SLICE_ASSET_BINDINGS) {
    assert.match(build, new RegExp(`\\\`${binding.sliceId}\\\``), `${binding.sliceId} should be documented`);
    for (const assetId of binding.assetIds) {
      assert.match(build, new RegExp(`\\\`${assetId}\\\``), `${assetId} should be documented in build.md`);
    }
  }
});

test("slice skills document their manifest asset ids", () => {
  const level = read(".skills/platformer-level-design/SKILL.md");
  const parallax = read(".skills/parallax-2d/SKILL.md");
  const polish = read(".skills/game-polish-2d/SKILL.md");

  for (const doc of [level, parallax, polish]) {
    assert.match(doc, /ASSET_MANIFEST\.json/);
    assert.match(doc, /sliceBindings/);
    assert.match(doc, /resolvedPaths/);
    assert.match(doc, /never search the\s+registry|do not search the registry/i);
  }

  for (const assetId of ["platform_tiles", "one_way_platform", "collectible", "hazard"]) {
    assert.match(level, new RegExp(`\\\`${assetId}\\\``));
  }
  for (const assetId of ["parallax_background", "foreground_prop"]) {
    assert.match(parallax, new RegExp(`\\\`${assetId}\\\``));
  }
  for (const assetId of ["player_character", "hud_style", "button_style", "vfx_particle"]) {
    assert.match(polish, new RegExp(`\\\`${assetId}\\\``));
  }
});
