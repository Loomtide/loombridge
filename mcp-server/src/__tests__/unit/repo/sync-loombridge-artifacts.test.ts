import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT as SUPPORT_REPO_ROOT } from "../../_support/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/__tests__ -> repo root is three up.
const REPO_ROOT = SUPPORT_REPO_ROOT;
const GEN_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "sync-loombridge-artifacts.mjs")).href;

interface Artifact {
  relPath: string;
  content: string;
  executable: boolean;
}
interface Generator {
  plannedArtifacts(): Artifact[];
  staleWrappers(scriptsDir: string, expectedNames: string[]): string[];
  SHIM_SPEC: Record<string, unknown>;
  resolveStartingParamsForDoc(profile: unknown): Record<string, number | undefined>;
}

async function loadGenerator(): Promise<Generator> {
  return (await import(GEN_URL)) as unknown as Generator;
}

test("generator plans a wrapper per command and no project-local config.toml", async () => {
  const { plannedArtifacts } = await loadGenerator();
  const artifacts = plannedArtifacts();

  const wrappers = artifacts.filter((a) => a.relPath.startsWith(`scripts${path.sep}loombridge-`));
  const toml = artifacts.find((a) => a.relPath.endsWith(path.join(".codex", "config.toml")));
  assert.ok(wrappers.length >= 4, "a wrapper per command (plan/build/verify/e2e at least)");
  assert.equal(toml, undefined, "Codex rejects project-local profiles, so no .codex/config.toml is generated");
  assert.ok(wrappers.every((w) => w.executable), "wrappers are marked executable");
});

test("generated wrappers satisfy the shim-parity invariants (same md, codex exec --ephemeral, build threads $*)", async () => {
  const { plannedArtifacts } = await loadGenerator();
  for (const art of plannedArtifacts()) {
    if (!art.relPath.startsWith(`scripts${path.sep}loombridge-`)) continue;
    const name = path.basename(art.relPath).replace(/^loombridge-/, "");
    assert.match(art.content, new RegExp(`commands/loombridge/${name}\\.md`), `${name}: references its .md`);
    assert.match(art.content, /exec --ephemeral/, `${name}: codex exec --ephemeral (§3b fresh process)`);
    assert.match(art.content, /--ask-for-approval/, `${name}: carries approval policy without project-local profiles`);
    assert.match(art.content, /--sandbox/, `${name}: carries sandbox policy without project-local profiles`);
    assert.match(art.content, /codex "\$\{CODEX_ARGS\[@\]\}"/, `${name}: invokes codex with the args`);
    if (name === "build") {
      assert.match(art.content, /INTENT="\$\{\*:-\}"/, "build threads ALL positional args");
    }
  }
});

test("staleWrappers flags an orphaned generated wrapper but not the .sh helpers or current commands", async () => {
  const { staleWrappers } = await loadGenerator();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-stale-"));
  try {
    // Current command wrappers + a stale one + the hand-written .sh helpers.
    for (const f of [
      "loombridge-plan",
      "loombridge-build",
      "loombridge-oldcommand", // removed from plugin.json → stale
      "loombridge-embed-bridge.sh", // helper, not generated → keep
      "loombridge-install-locally.sh",
      "loombridge-checkpoint.sh",
    ]) {
      await fs.writeFile(path.join(dir, f), "x", "utf-8");
    }
    const stale = staleWrappers(dir, ["plan", "build", "verify", "e2e"]);
    assert.deepEqual(stale, ["loombridge-oldcommand"], "only the orphaned extensionless wrapper is stale");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ANTI-DRIFT: committed shim artifacts match the generator (run the generator + commit if this fails)", async () => {
  const { plannedArtifacts } = await loadGenerator();
  for (const art of plannedArtifacts()) {
    const onDisk = await fs.readFile(path.join(REPO_ROOT, art.relPath), "utf-8");
    assert.equal(
      onDisk,
      art.content,
      `${art.relPath} has drifted from the generator — run \`node scripts/sync-loombridge-artifacts.mjs\` and commit.`,
    );
  }
});

test("NO DUAL SOURCE: the generator's doc resolver matches resolveStartingParams for every shipped profile", async () => {
  // The generator copies the solve formula (no build step) — pin that copy against
  // the tested resolver so editing one without the other can never silently ship a
  // doc table that disagrees with the real build-side resolver (review finding #2).
  const { resolveStartingParamsForDoc } = await loadGenerator();
  const { resolveStartingParams } = await import("../../../capabilities/genre/genre-packs/platformer-2d/solve-params.js");
  const { loadProfile, SHIPPED_PROFILE_IDS } = await import("../../../capabilities/genre/genre-packs/platformer-2d/profiles.js");
  for (const id of SHIPPED_PROFILE_IDS) {
    const profile = await loadProfile(id);
    assert.deepEqual(
      resolveStartingParamsForDoc(profile),
      resolveStartingParams(profile),
      `generator doc-resolver diverged from resolveStartingParams for '${id}' — the two formula copies must stay identical.`,
    );
  }
});
