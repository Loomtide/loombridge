import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { REPO_ROOT as SUPPORT_REPO_ROOT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/__tests__ -> repo root is three levels up (dist -> mcp-server -> repo).
const REPO_ROOT = SUPPORT_REPO_ROOT;
const EMBED_SCRIPT = resolve(REPO_ROOT, "scripts/loombridge-embed-bridge.sh");

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("loombridge-embed-bridge (P2.1 — codifies the #62 Tests/ strip)", { timeout: 30000 }, () => {
  let tempDir = "";

  before(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-embed-bridge-"));
  });

  after(async () => {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test("embeds the bridge into Packages/ WITHOUT Tests/ (the CS0246 break)", async () => {
    const project = path.join(tempDir, "consumer");
    await fsp.mkdir(path.join(project, "Packages"), { recursive: true });

    const result = spawnSync("bash", [EMBED_SCRIPT, "--project", project], { encoding: "utf-8" });
    assert.equal(result.status, 0, `embed failed: ${result.stderr}\n${result.stdout}`);

    const dest = path.join(project, "Packages", "com.loomtide.loombridge");
    // The validated fix: Editor + Runtime ship, Tests/ does NOT.
    assert.ok(await exists(path.join(dest, "package.json")), "package.json must ship");
    assert.ok(await exists(path.join(dest, "Editor")), "Editor/ must ship");
    assert.ok(await exists(path.join(dest, "Runtime")), "Runtime/ must ship");
    assert.equal(await exists(path.join(dest, "Tests")), false, "Tests/ must NOT ship (CS0246)");
    assert.equal(await exists(path.join(dest, "Tests.meta")), false, "Tests.meta must NOT ship");

    // No NUnit/test asmdef anywhere in the embedded package.
    const grep = spawnSync("grep", ["-rl", "nunit.framework", dest], { encoding: "utf-8" });
    assert.equal(grep.stdout.trim(), "", "no nunit reference should survive the embed");
  });

  test("is idempotent — re-embedding over an existing copy still yields a Tests-free package", async () => {
    const project = path.join(tempDir, "consumer-2");
    await fsp.mkdir(path.join(project, "Packages"), { recursive: true });

    for (let i = 0; i < 2; i += 1) {
      const r = spawnSync("bash", [EMBED_SCRIPT, "--project", project], { encoding: "utf-8" });
      assert.equal(r.status, 0, `embed pass ${i} failed: ${r.stderr}`);
    }
    const dest = path.join(project, "Packages", "com.loomtide.loombridge");
    assert.ok(await exists(path.join(dest, "Editor")));
    assert.equal(await exists(path.join(dest, "Tests")), false);
  });

  test("warns when the project manifest still has a file: reference to the package", async () => {
    const project = path.join(tempDir, "consumer-manifest");
    await fsp.mkdir(path.join(project, "Packages"), { recursive: true });
    await fsp.writeFile(
      path.join(project, "Packages", "manifest.json"),
      JSON.stringify(
        { dependencies: { "com.loomtide.loombridge": "file:../../../packages/com.loomtide.loombridge" } },
        null,
        2,
      ),
      "utf-8",
    );

    const r = spawnSync("bash", [EMBED_SCRIPT, "--project", project], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /still references/, "should warn about the redundant manifest dependency");
  });

  test("fails clearly without --project", () => {
    const r = spawnSync("bash", [EMBED_SCRIPT], { encoding: "utf-8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--project .* is required/);
  });
});
