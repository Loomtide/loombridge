import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/__tests__ -> mcp-server is two up; repo root is three up.
const CLI = path.resolve(__dirname, "../surfaces/cli.js");
const MCP_SERVER = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PACK_SCRIPT = path.resolve(REPO_ROOT, "scripts/loombridge-pack-bridge.sh");
const BUILD_SURFACE = path.resolve(REPO_ROOT, "scripts/build-agent-surface.mjs");
const SCRUB_LIB = path.resolve(REPO_ROOT, "scripts/agent-surface-lib.mjs");
const INSTALL_LOCALLY = path.resolve(REPO_ROOT, "scripts/loombridge-install-locally.sh");
const PAYLOAD_DIR = path.join(MCP_SERVER, "agent-surface");
const PKG_ID = "com.loomtide.loombridge";
const HINT = "agent commands + skills available (optional)";

let tempRoot = "";
let tarball = "";

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, LOOMBRIDGE_BRIDGE_TARBALL: tarball, LOOMBRIDGE_AGENT_SURFACE_DIR: PAYLOAD_DIR, ...env },
  });
}

async function makeProject(name: string): Promise<string> {
  const project = path.join(tempRoot, name);
  await fsp.mkdir(path.join(project, "Assets"), { recursive: true });
  await fsp.mkdir(path.join(project, "Packages"), { recursive: true });
  await fsp.mkdir(path.join(project, "ProjectSettings"), { recursive: true });
  await fsp.writeFile(path.join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n");
  await fsp.writeFile(
    path.join(project, "Packages", "manifest.json"),
    `${JSON.stringify({ dependencies: {} }, null, 2)}\n`,
  );
  return project;
}

function readMeta(project: string) {
  return JSON.parse(readFileSync(path.join(project, "ProjectSettings", "LoombridgeInstall.json"), "utf8"));
}

/** Recursive {relPath -> sha256} of all files under dir, minus excluded rel paths. */
function treeSha(root: string, excludes: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(excludes);
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      if (skip.has(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function managedFileCount(project: string): number {
  let n = 0;
  for (const base of [".claude", ".codex"]) {
    const walk = (dir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else n += 1;
      }
    };
    walk(path.join(project, base));
  }
  return n;
}

describe("loombridge install-agent (optional agent surface)", { timeout: 90000 }, () => {
  before(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-installagent-"));
    // A real bridge tarball, so install-bridge (needed for update/doctor) works.
    const outDir = path.join(tempRoot, "packed");
    execFileSync("bash", [PACK_SCRIPT, "--out-dir", outDir], { stdio: "ignore" });
    const tgz = (await fsp.readdir(outDir)).find((f) => f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz"));
    assert.ok(tgz, "pack script must produce a tarball");
    tarball = path.join(outDir, tgz!);
    // Build the scrubbed payload the install verb ships/installs.
    execFileSync("node", [BUILD_SURFACE], { stdio: "ignore" });
  });

  after(async () => {
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  // --- payload scrub invariants (the guarantees the old bash rewrite() enforced) ---

  test("payload build scrubs every dev-repo reference", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else files.push(abs);
      }
    };
    walk(PAYLOAD_DIR);
    assert.ok(files.length >= 40, `expected the full consumer payload, saw ${files.length} files`);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rel = path.relative(PAYLOAD_DIR, f);
      assert.doesNotMatch(text, /\/Users\/|\/home\//, `absolute dev/home path leaked into ${rel}`);
      assert.doesNotMatch(text, /node mcp-server\/dist\/cli\.js/, `unscrubbed dev CLI invocation in ${rel}`);
      assert.doesNotMatch(text, /\.\.\/\.\.\/\.planning\//, `../../.planning ref leaked into ${rel}`);
      assert.doesNotMatch(text, /\.planning\//, `internal .planning path leaked into ${rel}`);
      assert.doesNotMatch(text, /prepare-project-assets\.sh/, `raw prepare-project-assets.sh in ${rel}`);
      assert.doesNotMatch(text, /unity-projects\//, `dev unity-projects path leaked into ${rel}`);
      // #6: the GENERAL guard — NO internal mcp-server/(src|dist)/ path may survive in any
      // payload file (this is the backstop that catches a leak no specific rule covers, e.g.
      // bare tuning-runner.js and the genre-packs source refs).
      assert.doesNotMatch(text, /mcp-server\/(?:src|dist)\//, `internal mcp-server/(src|dist)/ path leaked into ${rel}`);
      for (const line of text.split("\n")) {
        assert.notEqual(line.trim(), "npm run build", `un-stripped 'npm run build' line in ${rel}`);
      }
    }
  });

  // --- install / remove round-trip ---

  test("install → remove round-trip: no managed files left, block=declined, rest byte-identical", async () => {
    const project = await makeProject("roundtrip");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    // Snapshot everything EXCEPT the record (which legitimately gains agentSurface).
    const recordRel = path.join("ProjectSettings", "LoombridgeInstall.json");
    const before = treeSha(project, [recordRel]);
    assert.equal(managedFileCount(project), 0, "no surface before install-agent");

    const inst = cli(["install-agent", "--project", project]);
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(managedFileCount(project) > 0, "surface installed");
    assert.equal(readMeta(project).agentSurface.state, "enabled");

    const rm = cli(["install-agent", "--project", project, "--remove"]);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(managedFileCount(project), 0, "all managed files removed");
    const meta = readMeta(project);
    assert.equal(meta.agentSurface.state, "declined");
    assert.deepEqual(meta.agentSurface.files, []);
    // Bridge wiring + everything else is byte-identical to pre-install-agent.
    assert.deepEqual(treeSha(project, [recordRel]), before);
  });

  test("--remove prunes the now-empty surface directories, not just the files", async () => {
    const project = await makeProject("prune-empty-dirs");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);

    // treeSha only hashes files, so an empty-dir leak passes the round-trip check above.
    // The project had no .claude/.codex before install-agent; a clean remove leaves none.
    for (const dir of [".claude", ".codex"]) {
      assert.equal(existsSync(path.join(project, dir)), false, `${dir}/ should be pruned, not left empty`);
    }
  });

  test("--dry-run writes nothing", async () => {
    const project = await makeProject("dryrun");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["install-agent", "--project", project, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(managedFileCount(project), 0, "no files on dry-run");
    assert.equal(readMeta(project).agentSurface, undefined, "no agentSurface block on dry-run");
  });

  test("exit 2 on missing --project and on a non-Unity dir", async () => {
    assert.equal(cli(["install-agent"]).status, 2);
    assert.equal(cli(["install-agent", "--project", tempRoot]).status, 2);
  });

  // --- managed markers + hand-edit respect ---

  test("every installed command + skill .md carries the managed marker after its frontmatter", async () => {
    const project = await makeProject("markers");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const cmd = readFileSync(path.join(project, ".claude/commands/loombridge/plan.md"), "utf8");
    assert.match(cmd, /^---\n[\s\S]*?\n---\n<!--\s*loombridge:agent-surface v1\b/, "marker sits just after frontmatter");
    const skill = readFileSync(path.join(project, ".claude/skills/unity-2d-game/SKILL.md"), "utf8");
    assert.match(skill, /<!--\s*loombridge:agent-surface v1\b/);
    // Codex skills are installed as real files too.
    assert.match(
      readFileSync(path.join(project, ".codex/skills/unity-2d-game/SKILL.md"), "utf8"),
      /<!--\s*loombridge:agent-surface v1\b/,
    );
  });

  test("installs a scoped LF-pinning .gitattributes in each managed root (managed + removed like the rest)", async () => {
    const project = await makeProject("gitattributes");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    for (const rel of [".claude/.gitattributes", ".codex/.gitattributes"]) {
      const body = readFileSync(path.join(project, rel), "utf8");
      assert.match(body, /\* text eol=lf/, `${rel} pins LF`);
      // Tracked in the ledger with a POSIX key so it refreshes/removes with everything else.
      const ledger = readMeta(project).agentSurface.files.map((f: { path: string }) => f.path);
      assert.ok(ledger.includes(rel), `${rel} is in the ledger`);
    }
    // --remove cleans them too (they are Loombridge's, not the user's).
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);
    await assert.rejects(fsp.access(path.join(project, ".claude/.gitattributes")));
    await assert.rejects(fsp.access(path.join(project, ".codex/.gitattributes")));
  });

  test("a hand-edited managed file (marker removed) SURVIVES --remove, with a warning naming it", async () => {
    const project = await makeProject("handedit-remove");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const rel = ".claude/skills/unity-2d-game/SKILL.md";
    const mine = "# my own notes — marker deleted\n";
    await fsp.writeFile(path.join(project, rel), mine, "utf8");

    const rm = cli(["install-agent", "--project", project, "--remove"]);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(readFileSync(path.join(project, rel), "utf8"), mine, "hand-edited file must survive --remove");
    assert.match(rm.stdout, /hand-edited file\(s\) LEFT/);
    assert.match(rm.stdout, new RegExp(rel.replace(/[.]/g, "\\.")), "warning names the surviving file");
    // The record still flips to declined even though one file was preserved.
    assert.equal(readMeta(project).agentSurface.state, "declined");
  });

  test("a hand-edited managed file SURVIVES an enabled refresh, with a warning naming it", async () => {
    const project = await makeProject("handedit-refresh");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const rel = ".claude/commands/loombridge/build.md";
    const mine = "# hand-edited command — do not touch\n";
    await fsp.writeFile(path.join(project, rel), mine, "utf8");

    // Re-running install-agent from "enabled" is a refresh.
    const refresh = cli(["install-agent", "--project", project]);
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.equal(readFileSync(path.join(project, rel), "utf8"), mine, "refresh must not clobber a hand-edited file");
    assert.match(refresh.stdout, /hand-edited file\(s\) left untouched/);
    assert.match(refresh.stdout, new RegExp(rel.replace(/[.]/g, "\\.")));
    // The skipped file drops out of the ledger (it is the user's now).
    const ledgerPaths = readMeta(project).agentSurface.files.map((f: { path: string }) => f.path);
    assert.ok(!ledgerPaths.includes(rel), "hand-edited file removed from the ledger");
  });

  // --- decline → re-enable ---

  test("decline → re-enable round-trip works", async () => {
    const project = await makeProject("re-enable");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);
    assert.equal(readMeta(project).agentSurface.state, "declined");
    // Re-run install-agent from "declined" → back to enabled with files restored.
    const re = cli(["install-agent", "--project", project]);
    assert.equal(re.status, 0, re.stderr);
    assert.equal(readMeta(project).agentSurface.state, "enabled");
    assert.ok(managedFileCount(project) > 0, "surface restored on re-enable");
  });

  // --- install-bridge / update hooks ---

  test("install-bridge prints the hint exactly when UNSET, and is silent once decided", async () => {
    const project = await makeProject("bridge-hint");
    const first = cli(["install-bridge", "--project", project]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes(HINT), "UNSET → one hint line");

    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0); // declined
    const declined = cli(["install-bridge", "--project", project]);
    assert.equal(declined.status, 0);
    assert.ok(!declined.stdout.includes(HINT), "declined → silent");
  });

  test("update: UNSET installs nothing + prints the hint", async () => {
    const project = await makeProject("update-unset");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(HINT), "UNSET → hint on update");
    assert.equal(managedFileCount(project), 0, "update installs no surface when UNSET");
  });

  test("update: enabled REFRESHES the surface (restores a deleted managed file)", async () => {
    const project = await makeProject("update-enabled");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const rel = ".claude/skills/parallax-2d/SKILL.md";
    await fsp.rm(path.join(project, rel));
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Refreshing the Loombridge agent surface/);
    await fsp.access(path.join(project, rel)); // restored
    assert.equal(readMeta(project).agentSurface.state, "enabled");
  });

  test("update: declined is SILENT (no hint, no surface)", async () => {
    const project = await makeProject("update-declined");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(HINT), "declined → no hint on update");
    assert.equal(managedFileCount(project), 0, "declined → update installs nothing");
  });

  // --- doctor rows (all exit 0) ---

  test("doctor: UNSET → info row, exit 0", async () => {
    const project = await makeProject("doctor-unset");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Agent surface \(optional\).*not installed/s);
  });

  test("doctor: enabled + current cliVersion → pass row, exit 0", async () => {
    const project = await makeProject("doctor-enabled");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ Agent surface \(optional\): enabled/);
  });

  test("doctor: enabled + stale cliVersion → warn row (advisory) with refresh cmd, exit 0", async () => {
    const project = await makeProject("doctor-stale");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const metaPath = path.join(project, "ProjectSettings", "LoombridgeInstall.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.agentSurface.cliVersion = "0.0.1"; // simulate an older install
    await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "a stale optional surface is a warning, not a failure");
    assert.match(r.stdout, /⚠ Agent surface \(optional\).*stale/s);
    assert.match(r.stdout, /loombridge install-agent --project/);
  });

  test("doctor: declined → info row, exit 0", async () => {
    const project = await makeProject("doctor-declined");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Agent surface \(optional\): agent surface declined \(by choice\)/);
  });

  // --- review-finding regressions (cases the happy path missed) ---

  /** Copy the payload minus one file, to simulate a dropped/renamed command or skill. */
  async function trimmedPayload(name: string, dropRel: string): Promise<string> {
    const dir = path.join(tempRoot, name);
    await fsp.cp(PAYLOAD_DIR, dir, { recursive: true });
    await fsp.rm(path.join(dir, ...dropRel.split("/")));
    return dir;
  }

  function writeRawMeta(project: string, meta: Record<string, unknown>): Promise<void> {
    return fsp.writeFile(
      path.join(project, "ProjectSettings", "LoombridgeInstall.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  }

  test("#1 refresh PRUNES an orphan (dropped from the payload): deleted from disk AND ledger", async () => {
    const project = await makeProject("orphan-prune");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const relClaude = ".claude/skills/parallax-2d/references/verification.md";
    const relCodex = ".codex/skills/parallax-2d/references/verification.md";
    await fsp.access(path.join(project, relClaude));
    await fsp.access(path.join(project, relCodex));

    const trimmed = await trimmedPayload("payload-drop-verif", "skills/parallax-2d/references/verification.md");
    const r = cli(["install-agent", "--project", project], { LOOMBRIDGE_AGENT_SURFACE_DIR: trimmed });
    assert.equal(r.status, 0, r.stderr);
    // The surface can SHRINK: both orphan copies gone from disk...
    await assert.rejects(fsp.access(path.join(project, relClaude)), "orphaned .claude copy deleted");
    await assert.rejects(fsp.access(path.join(project, relCodex)), "orphaned .codex copy deleted");
    // ...and out of the ledger (so a later re-add starts clean, not frozen on stale content).
    const ledgerPaths = readMeta(project).agentSurface.files.map((f: { path: string }) => f.path);
    assert.ok(!ledgerPaths.includes(relClaude) && !ledgerPaths.includes(relCodex), "orphan removed from ledger");
    assert.match(r.stdout, /no longer shipped removed/);
  });

  test("#1 refresh KEEPS a hand-edited orphan (with a warning), still drops it from the ledger", async () => {
    const project = await makeProject("orphan-handedit");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const rel = ".claude/skills/parallax-2d/references/verification.md";
    const mine = "# my own orphan notes\n";
    await fsp.writeFile(path.join(project, rel), mine, "utf8");

    const trimmed = await trimmedPayload("payload-drop-verif2", "skills/parallax-2d/references/verification.md");
    const r = cli(["install-agent", "--project", project], { LOOMBRIDGE_AGENT_SURFACE_DIR: trimmed });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(project, rel), "utf8"), mine, "hand-edited orphan survives");
    assert.match(r.stdout, /no-longer-shipped file\(s\) LEFT/);
    const ledgerPaths = readMeta(project).agentSurface.files.map((f: { path: string }) => f.path);
    assert.ok(!ledgerPaths.includes(rel), "hand-edited orphan dropped from ledger (it is the user's now)");
  });

  test("#2 doctor NEVER crashes/fails on a malformed enabled block (files absent)", async () => {
    const project = await makeProject("doctor-malformed");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const meta = readMeta(project);
    meta.agentSurface = { state: "enabled", cliVersion: "0.2.0" }; // NO files array — corrupt
    await writeRawMeta(project, meta);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "an optional-surface record must never fail doctor");
    assert.doesNotMatch(r.stderr, /TypeError/, "must not throw");
    assert.match(r.stdout, /⚠ Agent surface \(optional\).*malformed/s);
  });

  test("#3 ledger keys are ALWAYS POSIX, and refresh+remove round-trip on POSIX keys", async () => {
    const project = await makeProject("posix-keys");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    for (const f of readMeta(project).agentSurface.files as { path: string }[]) {
      assert.ok(f.path.includes("/"), `ledger key must be POSIX ("/"): ${f.path}`);
      assert.ok(!f.path.includes("\\"), `ledger key must not contain a backslash: ${f.path}`);
    }
    // A POSIX-keyed ledger must round-trip (not mis-flag everything as hand-edited).
    const refresh = cli(["install-agent", "--project", project]);
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.doesNotMatch(refresh.stdout, /hand-edited file\(s\) left untouched/, "POSIX ledger recognized as managed");
    assert.equal(cli(["install-agent", "--project", project, "--remove"]).status, 0);
    assert.equal(managedFileCount(project), 0, "POSIX-keyed ledger removes cleanly");
  });

  test("#3 installTargets normalizes a Windows-style (backslash) payload rel to POSIX keys", async () => {
    const mod = await import("../capabilities/setup/install-agent.js");
    const skill = mod._internals.installTargets("skills\\parallax-2d\\SKILL.md");
    assert.deepEqual(skill, [".claude/skills/parallax-2d/SKILL.md", ".codex/skills/parallax-2d/SKILL.md"]);
    const cmd = mod._internals.installTargets("commands\\loombridge\\plan.md");
    assert.deepEqual(cmd, [".claude/commands/loombridge/plan.md"]);
  });

  test("#4 a mid-loop write failure persists a partial ledger that --remove can clean", async () => {
    const project = await makeProject("atomic");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    // Pre-create a target path as a DIRECTORY → writing that file fails (EISDIR) mid-loop,
    // AFTER earlier command files were already written.
    await fsp.mkdir(path.join(project, ".claude/commands/loombridge/verify.md"), { recursive: true });
    const r = cli(["install-agent", "--project", project]);
    assert.equal(r.status, 1, "a filesystem failure is exit 1");
    const surface = readMeta(project).agentSurface;
    assert.equal(surface.state, "enabled");
    assert.ok(Array.isArray(surface.files) && surface.files.length > 0, "partial ledger persisted for recovery");
    // Files written before the failure must be reachable by --remove (no strand).
    await fsp.access(path.join(project, ".claude/commands/loombridge/ask.md"));
    const rm = cli(["install-agent", "--project", project, "--remove"]);
    assert.equal(rm.status, 0, rm.stderr);
    await assert.rejects(fsp.access(path.join(project, ".claude/commands/loombridge/ask.md")), "partial install cleaned");
  });

  test("#5 a corrupt ledger (files:null) self-heals: --remove exits 0 and sets declined; refresh does not throw", async () => {
    const project = await makeProject("corrupt-ledger");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const meta = readMeta(project);
    meta.agentSurface.files = null; // corrupt
    await writeRawMeta(project, meta);
    // refresh must not throw on a corrupt ledger
    const refresh = cli(["install-agent", "--project", project]);
    assert.equal(refresh.status, 0, refresh.stderr);
    // reset to the corrupt state and prove --remove self-heals to declined
    const meta2 = readMeta(project);
    meta2.agentSurface = { state: "enabled", cliVersion: "0.2.0", files: null };
    await writeRawMeta(project, meta2);
    const rm = cli(["install-agent", "--project", project, "--remove"]);
    assert.equal(rm.status, 0, "corrupt ledger must not make --remove throw");
    assert.equal(readMeta(project).agentSurface.state, "declined");
  });

  test("#7 install-agent before install-bridge → doctor shows NO green Bridge row", async () => {
    const project = await makeProject("agent-before-bridge");
    // NO install-bridge; install-agent writes a record with ONLY the agentSurface block.
    assert.equal(cli(["install-agent", "--project", project]).status, 0);
    const meta = readMeta(project);
    assert.equal(meta.installMode, undefined, "no bridge fields in the record");
    assert.equal(meta.agentSurface.state, "enabled");
    const r = cli(["doctor", "--project", project]);
    assert.doesNotMatch(r.stdout, /✓ Bridge install/, "must NOT print a passing Bridge row for a bridge-less record");
    assert.match(r.stdout, /bridge not installed by Loombridge/);
    // The optional surface state is still surfaced (enabled), never a green bridge row.
    assert.match(r.stdout, /Agent surface \(optional\): enabled/);
  });

  // --- anti-drift: one scrubber, one skill list ---

  test("anti-drift: both install paths import the SAME scrubber module", async () => {
    const buildSrc = readFileSync(BUILD_SURFACE, "utf8");
    const installLocallySrc = readFileSync(INSTALL_LOCALLY, "utf8");
    assert.match(buildSrc, /agent-surface-lib\.mjs/, "build-agent-surface must import the shared scrubber");
    assert.match(installLocallySrc, /agent-surface-lib\.mjs/, "loombridge-install-locally must shell out to the shared scrubber");
    // The bash script must no longer carry its own sed pipeline or skill list.
    assert.doesNotMatch(installLocallySrc, /sed\s+\\?\n?\s*-e/, "the bash sed scrubber must be gone (one scrubber)");
    assert.doesNotMatch(
      installLocallySrc,
      /CONSUMER_SKILLS=\(asset-layer/,
      "the duplicated bash skill list must be gone (one list)",
    );

    const mod = await import(pathToFileURL(SCRUB_LIB).href);
    assert.ok(Array.isArray(mod.CONSUMER_SKILLS) && mod.CONSUMER_SKILLS.length >= 6, "shared consumer-skill list");
    // The shared scrubber enforces the invariants both paths rely on. This fixture's literal
    // ".planning/" reference is intentional and documented as a leak-gate exception in
    // scripts/oss/export-allowlist.json — it feeds the scrubber's own internal-roadmap rule
    // and asserts the rule actually strips it.
    const scrubbed = mod.scrubContent(
      "run node mcp-server/dist/cli.js verify\ncd /Users/x/Loombridge/mcp-server\nnpm run build\nsee ../../.planning/STATE.md\n",
    );
    assert.doesNotMatch(scrubbed, /node mcp-server\/dist\/cli\.js/);
    assert.doesNotMatch(scrubbed, /\/Users\//);
    assert.doesNotMatch(scrubbed, /\.\.\/\.\.\/\.planning/);
    assert.ok(!scrubbed.split("\n").some((l: string) => l.trim() === "npm run build"), "npm run build stripped");
  });
});
