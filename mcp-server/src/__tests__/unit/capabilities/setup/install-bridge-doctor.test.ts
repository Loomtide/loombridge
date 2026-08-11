import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { ROUTING_DOC_VERSION } from "../../../../capabilities/setup/routing-doc.js";
import { CLI_DIST, REPO_ROOT as SUPPORT_REPO_ROOT } from "../../../_support/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/__tests__ -> mcp-server is two up; repo root is three up.
const CLI = CLI_DIST;
const REPO_ROOT = SUPPORT_REPO_ROOT;
const PACK_SCRIPT = path.resolve(REPO_ROOT, "scripts/loombridge-pack-bridge.sh");
const PKG_ID = "com.loomtide.loombridge";

let tempRoot = "";
let tarball = ""; // a freshly packed bridge tarball used as the "bundled" one

/** Run the CLI with the bundled tarball pinned via env, capture status + output. */
function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, LOOMBRIDGE_BRIDGE_TARBALL: tarball, ...env },
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
    `${JSON.stringify({ dependencies: { "com.unity.inputsystem": "1.11.2" } }, null, 2)}\n`,
  );
  return project;
}

function readMeta(project: string) {
  return JSON.parse(readFileSync(path.join(project, "ProjectSettings", "LoombridgeInstall.json"), "utf8"));
}

describe("loombridge install-bridge + doctor (Phase 2)", { timeout: 60000 }, () => {
  before(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-installbridge-"));
    const outDir = path.join(tempRoot, "packed");
    execFileSync("bash", [PACK_SCRIPT, "--out-dir", outDir], { stdio: "ignore" });
    const tgz = (await fsp.readdir(outDir)).find((f) => f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz"));
    assert.ok(tgz, "pack script must produce a tarball");
    tarball = path.join(outDir, tgz!);
  });

  after(async () => {
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  // --- install-bridge ---

  test("tarball install: adds file: dep (preserving existing deps) + writes metadata", async () => {
    const project = await makeProject("install-tarball");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);

    const manifest = JSON.parse(readFileSync(path.join(project, "Packages", "manifest.json"), "utf8"));
    assert.equal(manifest.dependencies["com.unity.inputsystem"], "1.11.2", "existing dep preserved");
    assert.match(manifest.dependencies[PKG_ID], /^file:tarballs\/com\.loomtide\.loombridge-.*\.tgz$/);

    const meta = readMeta(project);
    assert.equal(meta.installMode, "tarball-dependency");
    assert.equal(meta.packageId, PKG_ID);
    assert.equal(meta.bridgeProtocol, 1, "protocol stamped from REQUIRED_PROTOCOL_VERSION");
    assert.ok(meta.tarballSha256 && meta.tarballSha256.length === 64, "sha256 recorded");

    // the recorded sha must match the dropped file (integrity contract doctor checks).
    // Hash the bytes here rather than shelling out to `shasum`, which does not exist on Windows.
    const droppedSha = createHash("sha256")
      .update(readFileSync(path.join(project, "Packages", meta.tarball)))
      .digest("hex");
    assert.equal(meta.tarballSha256, droppedSha);
  });

  test("--dry-run writes nothing", async () => {
    const project = await makeProject("install-dryrun");
    const r = cli(["install-bridge", "--project", project, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(readFileSync(path.join(project, "Packages", "manifest.json"), "utf8"));
    assert.equal(manifest.dependencies[PKG_ID], undefined, "no dep written on dry-run");
    await assert.rejects(fsp.access(path.join(project, "ProjectSettings", "LoombridgeInstall.json")));
  });

  test("tarball install removes a stale embedded copy (double-declare guard)", async () => {
    const project = await makeProject("install-stale-embed");
    await fsp.mkdir(path.join(project, "Packages", PKG_ID, "Editor"), { recursive: true });
    await fsp.writeFile(path.join(project, "Packages", PKG_ID, "Editor", "Old.cs"), "// stale\n");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    await assert.rejects(fsp.access(path.join(project, "Packages", PKG_ID)), "stale embedded copy removed");
    assert.match(r.stdout, /removing stale embedded copy/);
  });

  test("--embedded fallback copies the package Tests-free + records embedded-package", async () => {
    const project = await makeProject("install-embedded");
    const r = cli(["install-bridge", "--project", project, "--embedded"]);
    assert.equal(r.status, 0, r.stderr);
    const dest = path.join(project, "Packages", PKG_ID);
    await fsp.access(path.join(dest, "Editor"));
    await assert.rejects(fsp.access(path.join(dest, "Tests")), "Tests/ must not ship embedded");
    assert.equal(readMeta(project).installMode, "embedded-package");
  });

  test("exit 2 on missing --project; exit 1 on a bad --tarball", async () => {
    const noProject = cli(["install-bridge"]);
    assert.equal(noProject.status, 2);
    const nonUnity = cli(["install-bridge", "--project", tempRoot]);
    assert.equal(nonUnity.status, 2, "non-Unity dir is a usage error");
    // A VALID project but an unresolvable tarball is a runtime failure (exit 1).
    const validProject = await makeProject("install-badtgz");
    const badTgz = spawnSync("node", [CLI, "install-bridge", "--project", validProject, "--tarball", "/nope/x.tgz"], {
      encoding: "utf-8",
    });
    assert.equal(badTgz.status, 1, "missing tarball is a runtime failure");
  });

  // --- routing front door (LOOMBRIDGE.md) ---

  const ROUTING = "LOOMBRIDGE.md";
  const routingPath = (project: string) => path.join(project, ROUTING);

  test("install writes LOOMBRIDGE.md (marker + suggested line) and records it in metadata", async () => {
    const project = await makeProject("routing-fresh");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    const doc = readFileSync(routingPath(project), "utf8");
    assert.match(doc, new RegExp(`<!--\\s*loombridge:routing-doc v${ROUTING_DOC_VERSION}\\b`), "carries our version marker");
    assert.match(doc, /Read LOOMBRIDGE\.md before Unity work/, "echoes the suggested CLAUDE.md/AGENTS.md line");
    // install prints the copy-paste line for the user (we never edit their CLAUDE.md).
    assert.match(r.stdout, /Read LOOMBRIDGE\.md before Unity work/);
    const meta = readMeta(project);
    assert.deepEqual(meta.routingDoc, { relpath: ROUTING, version: ROUTING_DOC_VERSION, action: "written" });
  });

  test("re-running install at the same version is a byte-identical no-op", async () => {
    const project = await makeProject("routing-rerun");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const first = readFileSync(routingPath(project), "utf8");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(routingPath(project), "utf8"), first, "same-version re-run must not rewrite the file");
    assert.equal(readMeta(project).routingDoc.action, "unchanged");
  });

  test("an OLDER-marker LOOMBRIDGE.md is updated in place", async () => {
    const project = await makeProject("routing-older");
    // A prior CLI wrote a v0 doc; our install must bump it to the current version.
    await fsp.writeFile(routingPath(project), "<!-- loombridge:routing-doc v0 -->\n# old routing\n", "utf8");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    const doc = readFileSync(routingPath(project), "utf8");
    assert.match(doc, new RegExp(`<!--\\s*loombridge:routing-doc v${ROUTING_DOC_VERSION}\\b`), "bumped to current version");
    assert.doesNotMatch(doc, /# old routing/, "stale body replaced");
    assert.equal(readMeta(project).routingDoc.action, "updated");
  });

  test("a USER-authored LOOMBRIDGE.md (no marker) is REFUSED, untouched — install still succeeds", async () => {
    const project = await makeProject("routing-userfile");
    const mine = "# My hand-written LOOMBRIDGE notes\nDo not touch this.\n";
    await fsp.writeFile(routingPath(project), mine, "utf8");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(routingPath(project), "utf8"), mine, "user content must never be clobbered");
    assert.match(r.stdout, /WITHOUT the Loombridge marker — leaving it untouched/);
    // Everything else still installs (manifest dep + metadata written).
    const manifest = JSON.parse(readFileSync(path.join(project, "Packages", "manifest.json"), "utf8"));
    assert.match(manifest.dependencies[PKG_ID], /^file:tarballs\//);
    assert.equal(readMeta(project).routingDoc.action, "refused-user-authored");
  });

  test("a user file merely QUOTING the marker mid-body is user-authored → refused (anchored marker)", async () => {
    const project = await makeProject("routing-quoted-marker");
    const mine = "# Notes\n\nLoombridge's file starts with `<!-- loombridge:routing-doc v1 -->` apparently.\n";
    await fsp.writeFile(routingPath(project), mine, "utf8");
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(routingPath(project), "utf8"), mine, "quoting the marker must not make the file ours");
    assert.equal(readMeta(project).routingDoc.action, "refused-user-authored");
  });

  test("LOOMBRIDGE.md is a DIRECTORY → routing degrades to write-failed; install still succeeds", async () => {
    const project = await makeProject("routing-eisdir");
    await fsp.mkdir(routingPath(project)); // readFileSync will throw EISDIR
    const r = cli(["install-bridge", "--project", project]);
    assert.equal(r.status, 0, "an unwritable routing doc must not abort the bridge install");
    assert.match(r.stdout, /could not write LOOMBRIDGE\.md/);
    // Bridge wiring + metadata still landed, with the failure recorded as an audit trail.
    const manifest = JSON.parse(readFileSync(path.join(project, "Packages", "manifest.json"), "utf8"));
    assert.match(manifest.dependencies[PKG_ID], /^file:tarballs\//);
    const rec = readMeta(project).routingDoc;
    assert.equal(rec.action, "write-failed");
    assert.ok(rec.error && rec.error.length > 0, "errno message recorded");
  });

  test("routing write IO failure (read-only project root) → write-failed; install still succeeds", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("running as root — chmod cannot produce EACCES");
      return;
    }
    if (process.platform === "win32") {
      // chmod 0o555 on a directory does not deny writes on Windows, so the read-only
      // premise cannot be staged; the EACCES path stays covered on POSIX.
      t.skip("chmod read-only is a no-op on Windows directories");
      return;
    }
    const project = await makeProject("routing-eacces");
    // Root dir read-only: LOOMBRIDGE.md (root-level) write fails, but Packages/ and
    // ProjectSettings/ (existing subdirs) stay writable, so the bridge wiring lands.
    await fsp.chmod(project, 0o555);
    try {
      const r = cli(["install-bridge", "--project", project]);
      assert.equal(r.status, 0, `install must degrade gracefully: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /could not write LOOMBRIDGE\.md/);
      const rec = readMeta(project).routingDoc;
      assert.equal(rec.action, "write-failed");
      assert.ok(rec.error && rec.error.length > 0, "errno message recorded");
      await assert.rejects(fsp.access(routingPath(project)), "no routing doc written");
    } finally {
      await fsp.chmod(project, 0o755); // restore so the suite's cleanup rm can proceed
    }
  });

  test("--embedded install also writes the routing front door", async () => {
    const project = await makeProject("routing-embedded");
    assert.equal(cli(["install-bridge", "--project", project, "--embedded"]).status, 0);
    assert.match(readFileSync(routingPath(project), "utf8"), new RegExp(`loombridge:routing-doc v${ROUTING_DOC_VERSION}`));
  });

  test("--dry-run writes no LOOMBRIDGE.md", async () => {
    const project = await makeProject("routing-dryrun");
    assert.equal(cli(["install-bridge", "--project", project, "--dry-run"]).status, 0);
    await assert.rejects(fsp.access(routingPath(project)), "no routing doc on dry-run");
  });

  test("doctor: routing front door present + current → pass row", async () => {
    const project = await makeProject("routing-doctor-ok");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Agent routing \\(LOOMBRIDGE\\.md\\): v${ROUTING_DOC_VERSION}`));
  });

  test("doctor: absent routing → warn (not a fail) with the install remediation", async () => {
    const project = await makeProject("routing-doctor-absent");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    await fsp.rm(routingPath(project));
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "a missing routing doc is a warning, not a failure");
    assert.match(r.stdout, /⚠ Agent routing.*missing LOOMBRIDGE\.md/s);
    assert.match(r.stdout, /loombridge install-bridge --project/);
  });

  test("doctor: stale routing marker → warn with version detail", async () => {
    const project = await makeProject("routing-doctor-stale");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    await fsp.writeFile(routingPath(project), "<!-- loombridge:routing-doc v0 -->\n# stale\n", "utf8");
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "stale routing is a warning, not a failure");
    assert.match(r.stdout, new RegExp(`⚠ Agent routing.*stale \\(v0; CLI ships v${ROUTING_DOC_VERSION}\\)`, "s"));
  });

  test("doctor: user-authored routing (no marker) → info, no nag", async () => {
    const project = await makeProject("routing-doctor-userfile");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    await fsp.writeFile(routingPath(project), "# mine\n", "utf8");
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Agent routing.*present without the Loombridge marker/s);
  });

  test("doctor: unreadable LOOMBRIDGE.md (a directory) → warn, never a crash", async () => {
    const project = await makeProject("routing-doctor-unreadable");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    await fsp.rm(routingPath(project));
    await fsp.mkdir(routingPath(project)); // readFileSync throws EISDIR inside doctor
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "unreadable routing is a warning, not a failure");
    assert.match(r.stdout, /⚠ Agent routing.*cannot be read as a file/s);
  });

  // --- MCP registration (.mcp.json) ---
  //
  // `setup`'s closing health check re-derived the bridge, the tarball, the routing doc, and
  // the agent surface from disk, and said NOTHING about the one step setup had just
  // performed: the MCP registration. The `mcpRegistration` ledger entry was believed rather
  // than checked, against this repo's own rule that integrity is recomputed at read. Every
  // row below is graded from `.mcp.json` ON DISK.

  const mcpPath = (project: string) => path.join(project, ".mcp.json");

  /** A wired project: bridge + MCP, exactly what `loombridge setup` leaves behind. */
  async function wiredProject(name: string): Promise<string> {
    const project = await makeProject(name);
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    assert.equal(cli(["install-mcp", "--project", project]).status, 0);
    return project;
  }

  test("doctor: registered by install-mcp → pass row", async () => {
    const project = await wiredProject("mcp-doctor-ok");
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ MCP registration \(\.mcp\.json\): "loombridge": \{"args":\["mcp"\],"command":"loombridge"\}/);
  });

  test("doctor: no .mcp.json → warn (not a fail) with the install-mcp remediation", async () => {
    // WARN, not FAIL: an agent cannot drive Unity without it, but a developer using only the
    // deterministic CLI never needs it, and doctor's exit code says whether the install is
    // BROKEN. Same grade as a missing routing doc.
    const project = await makeProject("mcp-doctor-absent");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "a missing registration is a warning, not a failure");
    assert.match(r.stdout, /⚠ MCP registration.*no \.mcp\.json/s);
    assert.match(r.stdout, /loombridge install-mcp --project/);
  });

  test("doctor: a .mcp.json with other servers but no loombridge entry → warn", async () => {
    const project = await makeProject("mcp-doctor-nokey");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    await fsp.writeFile(mcpPath(project), `${JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }, null, 2)}\n`);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /⚠ MCP registration.*no "loombridge" server/s);
    assert.match(r.stdout, /loombridge install-mcp --project/);
  });

  test("doctor: a hand-edited entry is reported as the DEVELOPER'S, not as broken", async () => {
    // Matches install-agent's stance toward a managed file whose bytes changed: it is theirs,
    // it is left alone, and doctor does not nag about it.
    const project = await wiredProject("mcp-doctor-handedit");
    await fsp.writeFile(
      mcpPath(project),
      `${JSON.stringify({ mcpServers: { loombridge: { command: "loombridge", args: ["mcp", "--verbose"] } } }, null, 2)}\n`,
    );
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, "a hand edit is not a broken install");
    assert.match(r.stdout, /MCP registration.*left as authored/s);
    assert.doesNotMatch(r.stdout, /⚠ MCP registration/, "and it is not nagged at either");
  });

  test("doctor: an entry LOOMBRIDGE shipped but no longer writes → warn with the upgrade", async () => {
    // The old `templates/create-loombridge-game/.mcp.json` shape. install-mcp will upgrade it
    // in place, so doctor must say so rather than call it the developer's.
    const project = await wiredProject("mcp-doctor-superseded");
    await fsp.writeFile(
      mcpPath(project),
      `${JSON.stringify({ mcpServers: { loombridge: { type: "stdio", command: "loombridge-mcp", args: [] } } }, null, 2)}\n`,
    );
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /⚠ MCP registration.*this CLI writes/s);
    assert.match(r.stdout, /loombridge install-mcp --project/);
  });

  test("doctor: malformed .mcp.json → FAIL, never a silent pass", async () => {
    // install-mcp refuses to rewrite a file it could not parse, so the developer has to fix it
    // by hand, which they will only do if doctor says so. A check that cannot run must be loud.
    const project = await wiredProject("mcp-doctor-malformed");
    await fsp.writeFile(mcpPath(project), '{ "mcpServers": { "loombridge": }  // junk\n');
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 1, "an unreadable config is a failure, not a missing row");
    assert.match(r.stdout, /✗ MCP registration.*not valid JSON/s);
  });

  test("doctor --ci carries the MCP row in the JSON report", async () => {
    const project = await wiredProject("mcp-doctor-ci");
    const r = cli(["doctor", "--project", project, "--ci"]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout) as { checks: { id: string; status: string }[] };
    const row = report.checks.find((c) => c.id === "mcp.registration");
    assert.ok(row, "the --ci report is what pipelines read; a row missing there is a row that does not exist");
    assert.equal(row!.status, "pass");
  });

  test("doctor: the MCP row survives a project with NO bridge install", async () => {
    // The registration does not depend on the bridge, and a row that vanishes when a
    // neighbouring check fails reads exactly like a row that passed.
    const project = await makeProject("mcp-doctor-nobridge");
    assert.equal(cli(["install-mcp", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project, "--ci"]);
    assert.equal(r.status, 1, "the missing bridge still fails the run");
    const report = JSON.parse(r.stdout) as { checks: { id: string; status: string }[] };
    assert.equal(report.checks.find((c) => c.id === "mcp.registration")?.status, "pass");
  });

  // --- doctor ---

  test("doctor: healthy after install → exit 0", async () => {
    const project = await makeProject("doctor-healthy");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /healthy/);
    assert.doesNotMatch(r.stdout, /✗/);
  });

  test("doctor: no install → fail with the install-bridge remediation", async () => {
    const project = await makeProject("doctor-noinstall");
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bridge not installed by Loombridge/);
    assert.match(r.stdout, /loombridge install-bridge --project/);
  });

  test("doctor: tampered tarball → integrity fail", async () => {
    const project = await makeProject("doctor-tampered");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const meta = readMeta(project);
    await fsp.appendFile(path.join(project, "Packages", meta.tarball), "corrupt");
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /sha256 mismatch/);
  });

  test("doctor: protocol mismatch in metadata → fail", async () => {
    const project = await makeProject("doctor-protocol");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const metaPath = path.join(project, "ProjectSettings", "LoombridgeInstall.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.bridgeProtocol = 999; // future/incompatible
    await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const r = cli(["doctor", "--project", project]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Protocol compatibility.*installed=999/s);
  });

  test("doctor: newer bundled bridge than installed → drift warning (not a fail)", async () => {
    const project = await makeProject("doctor-drift");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    // Pin a NEWER bundled tarball for the doctor run only.
    const newerDir = path.join(tempRoot, "packed-newer");
    execFileSync("bash", [PACK_SCRIPT, "--out-dir", newerDir, "--version", "0.9.9"], { stdio: "ignore" });
    const newer = path.join(newerDir, `${PKG_ID}-0.9.9.tgz`);
    const r = cli(["doctor", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: newer });
    assert.equal(r.status, 0, "drift is a warning, not a failure");
    assert.match(r.stdout, /Update available/);
  });

  test("doctor --ci emits JSON with a healthy flag", async () => {
    const project = await makeProject("doctor-ci");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["doctor", "--project", project, "--ci"]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.healthy, true);
    assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  });

  // --- update ---

  /** Pack an older-versioned tarball and install it, returning that project. */
  async function installOlder(name: string, version: string): Promise<string> {
    const project = await makeProject(name);
    const dir = path.join(tempRoot, `packed-${version}`);
    execFileSync("bash", [PACK_SCRIPT, "--out-dir", dir, "--version", version], { stdio: "ignore" });
    const old = path.join(dir, `${PKG_ID}-${version}.tgz`);
    assert.equal(cli(["install-bridge", "--project", project, "--tarball", old], { LOOMBRIDGE_BRIDGE_TARBALL: old }).status, 0);
    return project;
  }

  test("update: no install → exit 2 (precondition)", async () => {
    const project = await makeProject("update-noinstall");
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /never installed|install-bridge/);
  });

  test("update: already current → exit 0 + doctor healthy, no backup written", async () => {
    const project = await makeProject("update-current");
    assert.equal(cli(["install-bridge", "--project", project]).status, 0);
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already up to date/);
    await assert.rejects(fsp.access(path.join(project, ".loombridge", "run", "backups", "LoombridgeInstall.json.bak")));
  });

  test("update: older install → swaps version, backs up under .loombridge/, prunes old tarball", async () => {
    const project = await installOlder("update-older", "0.0.9");
    assert.equal(readMeta(project).bridgeVersion, "0.0.9");
    const r = cli(["update", "--project", project]); // bundled = the before() tarball
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(readMeta(project).bridgeVersion, "0.0.9", "bridge version bumped");
    // The backup lands in the never-committed .loombridge/ surface — NOT in
    // ProjectSettings/, where a stray .bak dirties every consumer's git status.
    await fsp.access(path.join(project, ".loombridge", "run", "backups", "LoombridgeInstall.json.bak"));
    await assert.rejects(
      fsp.access(path.join(project, "ProjectSettings", "LoombridgeInstall.json.bak")),
      "no .bak fallout in ProjectSettings/",
    );
    await assert.rejects(
      fsp.access(path.join(project, "Packages", "tarballs", `${PKG_ID}-0.0.9.tgz`)),
      "old tarball pruned",
    );
  });

  test("update: heals a legacy ProjectSettings/*.bak left by an older CLI", async () => {
    const project = await installOlder("update-legacy-bak", "0.0.7");
    const legacy = path.join(project, "ProjectSettings", "LoombridgeInstall.json.bak");
    await fsp.writeFile(legacy, "{}", "utf-8"); // simulate the old CLI's fallout
    const r = cli(["update", "--project", project]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed legacy/);
    await assert.rejects(fsp.access(legacy), "legacy .bak removed");
  });

  test("update: embedded refuses without --force-bridge, proceeds with it", async () => {
    const project = await makeProject("update-embedded");
    assert.equal(cli(["install-bridge", "--project", project, "--embedded"]).status, 0);
    const refused = cli(["update", "--project", project]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to overwrite an --embedded/);
    assert.equal(cli(["update", "--project", project, "--force-bridge"]).status, 0);
  });

  test("update --dry-run: no mutation, skips doctor", async () => {
    const project = await installOlder("update-dry", "0.0.8");
    const r = cli(["update", "--project", project, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readMeta(project).bridgeVersion, "0.0.8", "version unchanged on dry-run");
    await assert.rejects(fsp.access(path.join(project, ".loombridge", "run", "backups", "LoombridgeInstall.json.bak")));
    assert.match(r.stdout, /skipped doctor/);
  });
});
