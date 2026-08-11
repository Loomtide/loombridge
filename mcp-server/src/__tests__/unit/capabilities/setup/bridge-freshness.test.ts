/**
 * The bundled-bridge freshness guard.
 *
 * THE FAILURE THIS CLOSES: the CLI's bundled tarball (`mcp-server/bridge/*.tgz`) is
 * regenerated only by `npm prepack`. A symlinked global install never packs, so a tarball
 * from an old prepack outlives every later commit, and `loombridge update` happily
 * delivered a bridge with none of the last months' handlers while `doctor` reported
 * healthy end to end. The `.tgz.sha256` sidecar hashes the tarball itself, so it can only
 * detect tampering, never staleness: the "declared path nothing walks" class, at the
 * delivery layer.
 *
 * Everything here walks the REAL code path: the real pack script via bash, the real CLI
 * via spawn, the real digest module. A test that recomputed the check inline would prove
 * only that the test agrees with itself.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

import {
  bundledBridgeFreshness,
  judgeBridgeFreshness,
  locateBridgeTarball,
  resolveBridgeSourcePackageDir,
} from "../../../../capabilities/setup/bridge-install-common.js";
import {
  BRIDGE_DIGEST_ENTRY_NAME,
  computeBridgeSourceDigest,
} from "../../../../shared/bridge-source-digest.js";
import { extractTarball, readTarballFile } from "../../../../capabilities/setup/tarball.js";
import { CLI_DIST, PKG_ROOT, REPO_ROOT } from "../../../_support/paths.js";

const PACK_SCRIPT = path.resolve(REPO_ROOT, "scripts/loombridge-pack-bridge.sh");
const PKG_ID = "com.loomtide.loombridge";
const REAL_SRC = path.join(REPO_ROOT, "packages", PKG_ID);

let tempRoot = "";
/** A tarball packed from the REAL sources: fresh by construction. */
let freshTgz = "";

function packInto(outDir: string, extraArgs: string[] = []): string {
  execFileSync("bash", [PACK_SCRIPT, "--out-dir", outDir, ...extraArgs], { stdio: "ignore" });
  const tgz = readdirSync(outDir).find((f) => f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz"));
  assert.ok(tgz, `pack script must produce a tarball in ${outDir}`);
  return path.join(outDir, tgz!);
}

/**
 * Rebuild a tarball with its embedded digest record replaced (or removed).
 *
 * This is how the `stale`, `undigested` and `unknown-digest-version` fixtures are staged:
 * the CONSUMER path is byte-identical to the real one (the same tarball reader, the same
 * record), and a tarball whose embedded digest does not match the sources IS stale by
 * definition. Repacking the whole 2.5MB source tree per fixture would prove nothing extra.
 */
function retarWithRecord(sourceTgz: string, workDir: string, record: string | null): string {
  const stage = path.join(workDir, "stage");
  extractTarball(sourceTgz, stage);
  const recordPath = path.join(stage, "package", BRIDGE_DIGEST_ENTRY_NAME);
  if (record === null) rmSync(recordPath, { force: true });
  else writeFileSync(recordPath, record);
  const out = path.join(workDir, path.basename(sourceTgz));
  execFileSync("bash", ["-c", `cd "${stage}" && tar -czf "${out}" package`], { stdio: "ignore" });
  return out;
}

/** Run the CLI, capturing status + output. `env` entries override; `undefined` unsets. */
function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return spawnSync("node", [CLI_DIST, ...args], { encoding: "utf-8", env: merged });
}

async function makeProject(name: string): Promise<string> {
  const project = path.join(tempRoot, name);
  await fsp.mkdir(path.join(project, "Assets"), { recursive: true });
  await fsp.mkdir(path.join(project, "Packages"), { recursive: true });
  await fsp.mkdir(path.join(project, "ProjectSettings"), { recursive: true });
  await fsp.writeFile(path.join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n");
  await fsp.writeFile(path.join(project, "Packages", "manifest.json"), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
  return project;
}

/** A minimal UPM tree the pack script accepts (its sanity checks are strict). */
async function makeFixtureSource(dir: string, version = "1.2.3"): Promise<string> {
  await fsp.mkdir(path.join(dir, "Editor"), { recursive: true });
  await fsp.mkdir(path.join(dir, "Runtime"), { recursive: true });
  await fsp.mkdir(path.join(dir, "Tests", "Editor"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: PKG_ID, version, displayName: "fixture" }, null, 2)}\n`,
  );
  await fsp.writeFile(path.join(dir, "Editor", "Thing.cs"), "// editor\n");
  await fsp.writeFile(path.join(dir, "Runtime", "Thing.cs"), "// runtime\n");
  await fsp.writeFile(
    path.join(dir, "Tests", "Editor", `${PKG_ID}.tests.asmdef`),
    `${JSON.stringify({ name: `${PKG_ID}.tests`, defineConstraints: ["UNITY_INCLUDE_TESTS"] }, null, 2)}\n`,
  );
  return dir;
}

describe("bundled-bridge freshness", { timeout: 120000 }, () => {
  before(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-freshness-"));
    freshTgz = packInto(path.join(tempRoot, "packed-fresh"));
  });

  after(async () => {
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  // --- the digest itself ---------------------------------------------------

  test("digest: the same tree twice yields the same digest", async () => {
    const dir = await makeFixtureSource(path.join(tempRoot, "digest-stable"));
    assert.equal(computeBridgeSourceDigest(dir), computeBridgeSourceDigest(dir));
  });

  test("digest: one changed byte changes the digest", async () => {
    const dir = await makeFixtureSource(path.join(tempRoot, "digest-byte"));
    const before1 = computeBridgeSourceDigest(dir);
    await fsp.writeFile(path.join(dir, "Editor", "Thing.cs"), "// editoR\n");
    assert.notEqual(computeBridgeSourceDigest(dir), before1);
  });

  test("digest: adding, removing and renaming a file each change the digest", async () => {
    const dir = await makeFixtureSource(path.join(tempRoot, "digest-set"));
    const base = computeBridgeSourceDigest(dir);

    await fsp.writeFile(path.join(dir, "Editor", "New.cs"), "// new\n");
    const added = computeBridgeSourceDigest(dir);
    assert.notEqual(added, base, "an added file must change the digest");

    // Rename with IDENTICAL bytes: paths participate in the manifest, so this must move.
    await fsp.rename(path.join(dir, "Editor", "New.cs"), path.join(dir, "Editor", "Renamed.cs"));
    assert.notEqual(computeBridgeSourceDigest(dir), added, "a rename must change the digest");

    await fsp.rm(path.join(dir, "Editor", "Renamed.cs"));
    assert.equal(computeBridgeSourceDigest(dir), base, "removing it again must restore the digest");
  });

  test("digest: pruned cruft is excluded, so Finder and git cannot fake staleness", async () => {
    const dir = await makeFixtureSource(path.join(tempRoot, "digest-cruft"));
    const base = computeBridgeSourceDigest(dir);
    await fsp.writeFile(path.join(dir, ".DS_Store"), "junk");
    await fsp.writeFile(path.join(dir, "Editor", ".DS_Store"), "junk");
    await fsp.writeFile(path.join(dir, "Runtime", ".gitkeep"), "");
    await fsp.mkdir(path.join(dir, ".git"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.equal(
      computeBridgeSourceDigest(dir),
      base,
      "the digest must exclude exactly what the pack script's find-prune removes",
    );
  });

  test("digest: a stray digest record in the tree cannot poison the digest", async () => {
    const dir = await makeFixtureSource(path.join(tempRoot, "digest-selfref"));
    const base = computeBridgeSourceDigest(dir);
    await fsp.writeFile(path.join(dir, BRIDGE_DIGEST_ENTRY_NAME), '{"digest":"v1:deadbeef"}\n');
    assert.equal(computeBridgeSourceDigest(dir), base, "the record must never cover itself");
  });

  // --- producer / consumer agreement (the two-implementations trap) --------

  test("pack script embeds EXACTLY what the digest module computes", async () => {
    const src = await makeFixtureSource(path.join(tempRoot, "fixture-src"));
    const tgz = packInto(path.join(tempRoot, "fixture-out"), ["--package", src]);

    const raw = readTarballFile(tgz, `package/${BRIDGE_DIGEST_ENTRY_NAME}`);
    assert.ok(raw, "the packed tarball must carry the embedded digest record");
    const record = JSON.parse(raw!.toString("utf8"));
    assert.equal(
      record.digest,
      computeBridgeSourceDigest(src),
      "bash and TypeScript must not be able to disagree: the script shells to the SAME module",
    );
    assert.match(record.digest, /^v1:[0-9a-f]{64}$/);
    assert.ok(record.cliVersion, "provenance: which CLI build packed it");
    assert.ok(record.commit, "provenance: from which commit");
  });

  test("pack script digests the UNSTAMPED sources, so --version overrides stay fresh", async () => {
    const src = await makeFixtureSource(path.join(tempRoot, "fixture-src-ver"));
    const plain = packInto(path.join(tempRoot, "fixture-out-plain"), ["--package", src]);
    const stamped = packInto(path.join(tempRoot, "fixture-out-999"), ["--package", src, "--version", "0.9.9"]);
    const read = (t: string) => JSON.parse(readTarballFile(t, `package/${BRIDGE_DIGEST_ENTRY_NAME}`)!.toString("utf8")).digest;
    assert.equal(read(plain), read(stamped), "a version override must not move the source digest");
    assert.equal(read(stamped), computeBridgeSourceDigest(src));
  });

  test("pack output holds exactly the tarball and its sha sidecar, with no orphans", async () => {
    const src = await makeFixtureSource(path.join(tempRoot, "purge-src"));
    const out = path.join(tempRoot, "purge-out");
    await fsp.mkdir(out, { recursive: true });
    // Fallout from earlier versions AND from the abandoned sidecar iteration.
    await fsp.writeFile(path.join(out, `${PKG_ID}-0.0.1.tgz`), "old");
    await fsp.writeFile(path.join(out, `${PKG_ID}-0.0.1.tgz.sha256`), "old");
    await fsp.writeFile(path.join(out, `${PKG_ID}-0.0.1.source-digest`), "v1:orphan");
    await fsp.writeFile(path.join(out, "unrelated.txt"), "not ours");

    packInto(out, ["--package", src]);
    assert.deepEqual(
      readdirSync(out).sort(),
      [`${PKG_ID}-1.2.3.tgz`, `${PKG_ID}-1.2.3.tgz.sha256`, "unrelated.txt"].sort(),
      "the out dir must carry the tarball + sha sidecar only; no orphaned digest sidecar of any version",
    );
  });

  test("the source package tree never contains a digest record", () => {
    // One accidental commit of this file poisons every later digest comparison, because
    // the producer would embed a record computed over a tree containing a stale record.
    assert.equal(
      existsSync(path.join(REAL_SRC, BRIDGE_DIGEST_ENTRY_NAME)),
      false,
      `${BRIDGE_DIGEST_ENTRY_NAME} must exist only INSIDE packed tarballs, never in the source tree`,
    );
  });

  test("pack script REFUSES when the digest builder is missing", async () => {
    // Staged by pointing a copy of the script at a repo root with no built dist.
    const fakeRepo = path.join(tempRoot, "fake-repo");
    await fsp.mkdir(path.join(fakeRepo, "scripts"), { recursive: true });
    await makeFixtureSource(path.join(fakeRepo, "packages", PKG_ID));
    await fsp.copyFile(PACK_SCRIPT, path.join(fakeRepo, "scripts", path.basename(PACK_SCRIPT)));
    const r = spawnSync("bash", [path.join(fakeRepo, "scripts", path.basename(PACK_SCRIPT)), "--out-dir", path.join(fakeRepo, "out")], {
      encoding: "utf-8",
    });
    assert.equal(r.status, 1, "packing an undigestable tarball is never the right move");
    assert.match(r.stderr, /REFUSING to pack without the source digest/);
    assert.equal(existsSync(path.join(fakeRepo, "out")), false, "nothing is written on refusal");
  });

  // --- the five freshness states ------------------------------------------

  test("freshness: a tarball packed from the real sources is FRESH", () => {
    const f = bundledBridgeFreshness(freshTgz);
    assert.equal(f.state, "fresh", JSON.stringify(f));
    assert.equal(f.embedded, f.local);
    assert.equal(f.sourceDir, REAL_SRC);
  });

  test("freshness: a digest that does not match the sources is STALE", () => {
    const dir = path.join(tempRoot, "state-stale");
    const tgz = retarWithRecord(freshTgz, dir, `${JSON.stringify({ digest: `v1:${"0".repeat(64)}`, cliVersion: "0.0.1", commit: "abc" }, null, 2)}\n`);
    const f = bundledBridgeFreshness(tgz);
    assert.equal(f.state, "stale");
    assert.equal(judgeBridgeFreshness(f, tgz).disposition, "reject");
  });

  test("freshness: a tarball with no digest record is UNDIGESTED, and fails even with no sources", () => {
    const dir = path.join(tempRoot, "state-undigested");
    const tgz = retarWithRecord(freshTgz, dir, null);
    assert.equal(bundledBridgeFreshness(tgz).state, "undigested");
    // Evaluated BEFORE the layout branch: absence is a failure in EVERY layout, otherwise a
    // pre-pipeline tarball would launder itself as "unverifiable" wherever sources are absent.
    const noSources = bundledBridgeFreshness(tgz, null);
    assert.equal(noSources.state, "undigested");
    assert.equal(judgeBridgeFreshness(noSources, tgz).disposition, "reject");
  });

  test("freshness: an unknown digest format is its OWN state, never read as stale or fresh", () => {
    const dir = path.join(tempRoot, "state-unknown");
    const tgz = retarWithRecord(freshTgz, dir, `${JSON.stringify({ digest: "v9:whatever" }, null, 2)}\n`);
    const f = bundledBridgeFreshness(tgz);
    assert.equal(f.state, "unknown-digest-version");
    assert.equal(judgeBridgeFreshness(f, tgz).disposition, "reject");

    const malformed = retarWithRecord(freshTgz, path.join(tempRoot, "state-malformed"), "not json at all\n");
    assert.equal(bundledBridgeFreshness(malformed).state, "unknown-digest-version");

    const noField = retarWithRecord(freshTgz, path.join(tempRoot, "state-nofield"), '{"cliVersion":"0.1.0"}\n');
    assert.equal(bundledBridgeFreshness(noField).state, "unknown-digest-version");
  });

  test("freshness: a valid digest with no local sources is UNVERIFIABLE (an info row, not a refusal)", () => {
    const f = bundledBridgeFreshness(freshTgz, null);
    assert.equal(f.state, "unverifiable");
    const judged = judgeBridgeFreshness(f, freshTgz);
    assert.equal(judged.disposition, "info");
    assert.match(judged.detail, /packed by cli/, "the npm layout can still say which build packed it");
  });

  test("freshness: an unreadable source tree THROWS rather than skipping the check", () => {
    // A check that cannot run must become a failure at the caller, never a silent pass.
    assert.throws(() => bundledBridgeFreshness(freshTgz, path.join(REAL_SRC, "package.json")));
  });

  test("freshness: a corrupt archive THROWS", async () => {
    const bogus = path.join(tempRoot, `${PKG_ID}-9.9.9.tgz`);
    await fsp.writeFile(bogus, "not a gzip stream");
    assert.throws(() => bundledBridgeFreshness(bogus));
  });

  test("the dev repo and the frozen runtime are BOTH verifiable layouts", () => {
    // The frozen runtime vendors packages/ next to mcp-server/, so the same resolution rule
    // covers it: a mismatch there is a real defect (re-vendored source, stale tarball), and
    // classifying it "unverifiable" would silently exempt the machine most likely to drift.
    assert.equal(resolveBridgeSourcePackageDir(), REAL_SRC);
    assert.equal(path.resolve(PKG_ROOT, "..", "packages", PKG_ID), REAL_SRC);
  });

  // --- origin classification (A11 scope line) ------------------------------

  test("tarball origin: --tarball is explicit, the env var is ambient, the bundle is neither", () => {
    const saved = process.env.LOOMBRIDGE_BRIDGE_TARBALL;
    try {
      process.env.LOOMBRIDGE_BRIDGE_TARBALL = freshTgz;
      assert.equal(locateBridgeTarball()?.origin, "env");
      assert.equal(locateBridgeTarball(freshTgz)?.origin, "explicit");
      delete process.env.LOOMBRIDGE_BRIDGE_TARBALL;
      const bundled = locateBridgeTarball();
      if (bundled) assert.equal(bundled.origin, "bundled");
    } finally {
      if (saved === undefined) delete process.env.LOOMBRIDGE_BRIDGE_TARBALL;
      else process.env.LOOMBRIDGE_BRIDGE_TARBALL = saved;
    }
  });

  // --- the doors -----------------------------------------------------------

  test("doctor: a stale bundle is a FAILED row naming the consequence and an absolute fix", async () => {
    const tgz = retarWithRecord(freshTgz, path.join(tempRoot, "door-doctor-stale"), `${JSON.stringify({ digest: `v1:${"1".repeat(64)}` })}\n`);
    const r = cli(["doctor", "--ci"], { LOOMBRIDGE_BRIDGE_TARBALL: tgz });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const row = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === "bridge.freshness");
    assert.ok(row, "the freshness row must always be present");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /the editor would run code this CLI no longer has/);
    assert.match(row.remediation, /loombridge-pack-bridge\.sh --out-dir/);
  });

  test("doctor: an undigested bundle is a FAILED row", async () => {
    const tgz = retarWithRecord(freshTgz, path.join(tempRoot, "door-doctor-undigested"), null);
    const r = cli(["doctor", "--ci"], { LOOMBRIDGE_BRIDGE_TARBALL: tgz });
    assert.equal(r.status, 1);
    const row = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === "bridge.freshness");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /carries no source digest/);
  });

  test("doctor: a freshness evaluation that THROWS is its own failed row, not an omitted one", async () => {
    // A2's shape: the check cannot run (the archive is unreadable), and the report must say
    // so. The old `if (value && ...)` idiom would have produced a green report with a
    // silently missing row.
    const bogus = path.join(tempRoot, `${PKG_ID}-8.8.8.tgz`);
    await fsp.writeFile(bogus, "definitely not gzip");
    const r = cli(["doctor", "--ci"], { LOOMBRIDGE_BRIDGE_TARBALL: bogus });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const row = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === "bridge.freshness");
    assert.ok(row, "an evaluation failure must never remove the row");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /could not be evaluated/);
  });

  test("doctor: a fresh bundle passes with the digest prefix shown", () => {
    const r = cli(["doctor"], { LOOMBRIDGE_BRIDGE_TARBALL: freshTgz });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ Bundled bridge freshness: matches the packaged sources \(v1:[0-9a-f]{12}/);
  });

  test("doctor: every remediation that names an absolute path names one that exists", async () => {
    // A remediation pointing at a file this CLI invented sends the reader hunting for it.
    const project = await makeProject("remediation-paths");
    assert.equal(cli(["install-bridge", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: freshTgz }).status, 0);
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-remediation"), `${JSON.stringify({ digest: `v1:${"2".repeat(64)}` })}\n`);

    for (const tgz of [freshTgz, stale]) {
      const r = cli(["doctor", "--project", project, "--ci"], { LOOMBRIDGE_BRIDGE_TARBALL: tgz });
      const report = JSON.parse(r.stdout) as { checks: Array<{ id: string; remediation?: string }> };
      const missing: string[] = [];
      for (const c of report.checks) {
        for (const token of (c.remediation ?? "").split(/\s+/)) {
          if (!token.startsWith("/") || token.length < 2) continue;
          if (!existsSync(token)) missing.push(`${c.id}: ${token}`);
        }
      }
      assert.deepEqual(missing, [], `doctor named path(s) that do not exist:\n  ${missing.join("\n  ")}`);
    }
  });

  test("doctor: same version, DIFFERENT bytes turns the project red (the post-mortem state)", async () => {
    // Bundle regenerated, project still holding the tarball from the previous pack, both
    // 0.1.0. Before this row, doctor compared versions only and called that healthy.
    const project = await makeProject("content-drift");
    const older = retarWithRecord(freshTgz, path.join(tempRoot, "drift-installed"), `${JSON.stringify({ digest: `v1:${"3".repeat(64)}` })}\n`);
    assert.equal(
      cli(["install-bridge", "--project", project, "--tarball", older], { LOOMBRIDGE_BRIDGE_TARBALL: older }).status,
      0,
      "an explicit --tarball warns and proceeds, which is how the project ends up holding it",
    );

    const r = cli(["doctor", "--project", project, "--ci"], { LOOMBRIDGE_BRIDGE_TARBALL: freshTgz });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const checks = JSON.parse(r.stdout).checks as Array<{ id: string; status: string; detail: string; remediation?: string }>;
    const drift = checks.find((c) => c.id === "bridge.content-drift");
    assert.ok(drift, "the content-drift row must always be present");
    assert.equal(drift!.status, "fail");
    assert.match(drift!.detail, /SAME version .* but DIFFERENT bytes/);
    assert.match(drift!.remediation ?? "", /loombridge update --project/);
    // The version row still says "up to date": that is exactly why bytes must be compared.
    assert.equal(checks.find((c) => c.id === "bridge.drift")?.status, "pass");
    assert.equal(checks.find((c) => c.id === "tarball.integrity")?.status, "pass");
  });

  test("install-bridge: an AMBIENT stale tarball is refused (exit 2), writing nothing", async () => {
    const project = await makeProject("install-refuse");
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-install"), `${JSON.stringify({ digest: `v1:${"4".repeat(64)}` })}\n`);
    const r = cli(["install-bridge", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: stale });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /REFUSING to deliver this bridge tarball/);
    assert.match(r.stderr, /the editor would run code this CLI no longer has/);
    await assert.rejects(fsp.access(path.join(project, "ProjectSettings", "LoombridgeInstall.json")));
    await assert.rejects(fsp.access(path.join(project, "Packages", "tarballs")));
  });

  test("install-bridge: --allow-stale-bridge proceeds, loudly", async () => {
    const project = await makeProject("install-allow-stale");
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-install-allow"), `${JSON.stringify({ digest: `v1:${"5".repeat(64)}` })}\n`);
    const r = cli(["install-bridge", "--project", project, "--allow-stale-bridge"], { LOOMBRIDGE_BRIDGE_TARBALL: stale });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /STALE BRIDGE/);
    assert.match(r.stderr, /--allow-stale-bridge was passed/);
    await fsp.access(path.join(project, "ProjectSettings", "LoombridgeInstall.json"));
  });

  test("install-bridge: an EXPLICIT --tarball warns and proceeds", async () => {
    const project = await makeProject("install-explicit");
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-install-explicit"), `${JSON.stringify({ digest: `v1:${"6".repeat(64)}` })}\n`);
    const r = cli(["install-bridge", "--project", project, "--tarball", stale], { LOOMBRIDGE_BRIDGE_TARBALL: undefined });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /you named this tarball explicitly with --tarball/);
    await fsp.access(path.join(project, "ProjectSettings", "LoombridgeInstall.json"));
  });

  test("update FLAGSHIP: fresh sources, stale bundle, exit 2 before any write", async () => {
    // The live 2026-07-30 failure, staged end to end: the project holds a good install, the
    // CLI's bundle no longer matches its own sources, and `update` used to swap it in and
    // then report healthy.
    const project = await makeProject("update-flagship");
    assert.equal(cli(["install-bridge", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: freshTgz }).status, 0);

    const metaPath = path.join(project, "ProjectSettings", "LoombridgeInstall.json");
    const projectTgz = path.join(project, "Packages", JSON.parse(readFileSync(metaPath, "utf8")).tarball);
    const metaBefore = readFileSync(metaPath);
    const tgzBefore = readFileSync(projectTgz);

    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-update"), `${JSON.stringify({ digest: `v1:${"7".repeat(64)}` })}\n`);
    const r = cli(["update", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: stale });

    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /REFUSING to deliver this bridge tarball/);
    assert.deepEqual(readFileSync(metaPath), metaBefore, "LoombridgeInstall.json must be byte-untouched");
    assert.deepEqual(readFileSync(projectTgz), tgzBefore, "the project's tarball must be byte-untouched");
    // The gate sits ABOVE the agent-surface reconcile and the backup step, so neither ran.
    await assert.rejects(
      fsp.access(path.join(project, ".loombridge", "run", "backups")),
      ".loombridge/backups must not exist: the refusal happens before the backup",
    );
    assert.doesNotMatch(r.stdout, /already up to date/);
    // ABOVE reconcileAgentSurfaceForUpdate: that step writes files for an enabled surface,
    // and its UNSET hint is the observable proof of whether it ran at all.
    assert.doesNotMatch(
      r.stdout,
      /agent commands \+ skills available/,
      "the agent-surface reconcile must not have run: the gate sits above it",
    );
  });

  test("update: a project ALREADY holding the stale bridge hears 'stale', not 'already up to date'", async () => {
    const project = await makeProject("update-already-stale");
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-update-current"), `${JSON.stringify({ digest: `v1:${"8".repeat(64)}` })}\n`);
    // Install it via the explicit-argument door (warn + proceed), then update with the same
    // ambient bundle: the alreadyCurrent short-circuit would otherwise print "up to date".
    assert.equal(cli(["install-bridge", "--project", project, "--tarball", stale]).status, 0);
    const r = cli(["update", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: stale });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /already up to date/);
  });

  test("update: --allow-stale-bridge proceeds through the gate", async () => {
    const project = await makeProject("update-allow-stale");
    assert.equal(cli(["install-bridge", "--project", project], { LOOMBRIDGE_BRIDGE_TARBALL: freshTgz }).status, 0);
    const stale = retarWithRecord(freshTgz, path.join(tempRoot, "door-update-allow"), `${JSON.stringify({ digest: `v1:${"9".repeat(64)}` })}\n`);
    const r = cli(["update", "--project", project, "--allow-stale-bridge"], { LOOMBRIDGE_BRIDGE_TARBALL: stale });
    assert.match(r.stderr, /STALE BRIDGE/);
    assert.notEqual(r.status, 2, "the override must clear the gate");
  });

  // --- "every door consumes it" -------------------------------------------

  /** Calling one of these is what "consuming the grade" means, mechanically. */
  const CONSUMES_FRESHNESS = /\b(gateBridgeFreshness|bundledBridgeFreshness)\s*\(|\.freshness\b/;

  test("every non-test caller of the tarball resolver also consumes the freshness", () => {
    // The compiler already forces callers through `{ path, freshness }`, but nothing stops
    // a future door reading `.path` and ignoring the grade. "Defined but not wired" is a
    // real finding, so the wiring is walked here.
    const srcDir = path.join(PKG_ROOT, "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(p);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = readFileSync(p, "utf8");
        const callsResolver = /\b(resolveBundledTarball|locateBridgeTarball)\s*\(/.test(text);
        if (!callsResolver) continue;
        if (path.basename(p) === "bridge-install-common.ts") continue; // the definition site
        // Code tokens, not the word: a comment mentioning freshness must not satisfy this.
        if (!CONSUMES_FRESHNESS.test(text)) offenders.push(path.relative(PKG_ROOT, p));
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], `these resolve a bridge tarball without consuming its freshness:\n  ${offenders.join("\n  ")}`);
  });

  test("LITMUS: the door guard fires on a caller that ignores the freshness", () => {
    // The same predicate, against a file that resolves and never mentions the grade.
    const sample = "const t = resolveBundledTarball(); // freshness is somebody else's problem\ninstall(t.path);";
    assert.equal(/\b(resolveBundledTarball|locateBridgeTarball)\s*\(/.test(sample), true);
    assert.equal(CONSUMES_FRESHNESS.test(sample), false, "a mere mention of the word must not satisfy the guard");
  });
});
