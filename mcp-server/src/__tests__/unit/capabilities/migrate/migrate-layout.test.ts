/**
 * `loombridge migrate-layout`: the ArtifactStorage S2 move.
 *
 * WHAT THIS FILE IS DEFENDING. The migration relocates the ONE artifact in the system a
 * human cannot regenerate: a recorded demonstration exists because somebody sat down and
 * played the game, and the approved frames exist because somebody looked at them and said
 * yes. Every test here corresponds to a way that could go wrong, and every one of them is
 * a way it DID go wrong in review before the code was written this way.
 *
 * The centrepiece is `M1`: the tombstone is proved by running the REAL discovery
 * classification over the LEGACY directories, which is what an older CLI does, rather than
 * by a test asserting its own model of what an older CLI would say.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flatReplayLayout, loombridgePaths, readState, writeState } from "../../../../domain/state.js";
import {
  MIGRATE_VERB,
  isTombstoneFile,
  legacyLayoutRefusal,
  legacyPaths,
  remapLegacyRelPath,
  scanLegacyLayout,
} from "../../../../capabilities/migrate/legacy-layout.js";
import {
  rewriteProjectGitignore,
  runMigrateLayout,
  verifyCopy,
} from "../../../../capabilities/migrate/migrate-layout.js";
import { discoverTraceAssets } from "../../../../capabilities/verification/unified/discovery.js";
import { notRunFor, notRunTier } from "../../../../capabilities/verification/unified/report.js";
import { TRACE_BASELINE_MANIFEST } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { PKG_ROOT } from "../../../_support/paths.js";
import { readSlicePlan, writeSlicePlan, type SlicePlan } from "../../../../capabilities/verification/slices.js";

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function tmpProject(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
}

async function initRepo(root: string): Promise<void> {
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "guard@example.com");
  git(root, "config", "user.name", "guard");
}

const APPROVED_AT = "2026-08-11T08:11:07.819Z";

/**
 * A project in the PRE-S2 layout, built by writing the legacy paths directly.
 *
 * Deliberately NOT built by calling the current `trace approve`: that verb writes the NEW
 * layout, so a fixture that used it would be testing the migration against a project shape
 * no consumer has. The legacy shape is the input, so the legacy shape is what is planted.
 */
async function plantLegacyProject(
  root: string,
  opts: { id?: string; frames?: number; approvalCount?: number } = {},
): Promise<{ id: string; traceSha: string; frameShas: Record<string, string> }> {
  const id = opts.id ?? "kids-adventure";
  const frames = opts.frames ?? 3;
  const legacy = legacyPaths(root);
  await fs.mkdir(legacy.replayTraces, { recursive: true });
  await fs.mkdir(path.join(legacy.replayBaselines, id), { recursive: true });
  await fs.mkdir(legacy.replayReports, { recursive: true });

  const traceBody = `${JSON.stringify({ traceId: id, segments: [] }, null, 2)}\n`;
  await fs.writeFile(path.join(legacy.replayTraces, `${id}.trace.json`), traceBody, "utf-8");

  const frameShas: Record<string, string> = {};
  const pngs: { captureId: string; sha256: string }[] = [];
  for (let i = 1; i <= frames; i += 1) {
    const captureId = `step-${i}`;
    const bytes = Buffer.from(`png-bytes-${id}-${i}`);
    await fs.writeFile(path.join(legacy.replayBaselines, id, `${captureId}.png`), bytes);
    frameShas[captureId] = sha(bytes);
    pngs.push({ captureId, sha256: sha(bytes) });
  }

  await fs.writeFile(
    path.join(legacy.replayBaselines, id, TRACE_BASELINE_MANIFEST),
    `${JSON.stringify(
      {
        kind: "trace-baseline",
        schemaVersion: "1",
        traceId: id,
        traceSha256: sha(traceBody),
        approvedAt: APPROVED_AT,
        sourceReportSha256: sha("report"),
        pngs,
        approvalCount: opts.approvalCount ?? 1,
        replaySpeed: 2,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  // Run output beside the anchors, so the split has something to split.
  await fs.writeFile(path.join(legacy.replayReports, `${id}.report.json`), "{}\n", "utf-8");
  await fs.writeFile(path.join(legacy.replays, "fleet.report.json"), "{}\n", "utf-8");
  await fs.mkdir(legacy.reports, { recursive: true });
  await fs.writeFile(path.join(legacy.reports, "verify.json"), "{}\n", "utf-8");

  return { id, traceSha: sha(traceBody), frameShas };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* M1. THE TOMBSTONE, PROVED AGAINST THE REAL DISCOVERY CODE                  */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * The whole argument, as one assertion pair.
 *
 * REPRODUCED BEFORE THE CODE WAS WRITTEN: an older CLI against a migrated project prints
 *
 *     [loombridge verify] REFUSED: no verification assets found under <root>…
 *     [loombridge verify] the cheapest universal anchor is a recorded demonstration, so ask
 *                        your human to play the game once: 1. loombridge trace record …
 *
 * because `discoverTraces` returns `[]` for a directory that is not there. The anchor is
 * not `broken`, it is ABSENT, so the tier-2 machinery never fires and the human is told to
 * destroy the irreplaceable artifact.
 *
 * `discoverTraceAssets` is the REAL production classifier, handed the LEGACY layout. That
 * is exactly the code path an old binary runs, and running it is the only honest way to
 * make a claim about a binary this repo no longer contains.
 */
test("M1: an OLD CLI on a MIGRATED project reads BROKEN (tier 2), not absent", async () => {
  const root = await tmpProject("migrate-tombstone-");
  try {
    await initRepo(root);
    const { id } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const legacyLayout = flatLegacyLayout(root);

    // BEFORE: the old code path sees a real, approved anchor at the legacy path.
    const before = await discoverTraceAssets(root, legacyLayout);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.runnable, "live", "the fixture must be a genuinely approved anchor first");
    assert.equal(before[0]!.approvedAt, APPROVED_AT);

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    // AFTER: the SAME old code path, over the SAME legacy directories, now refuses.
    const rows = await discoverTraceAssets(root, legacyLayout);
    assert.equal(rows.length, 1, "the row must still EXIST: an absent row is the on-ramp");
    const row = rows[0]!;
    assert.equal(row.id, id);
    assert.equal(row.notRunClass, "broken", "absent would print the on-ramp; broken refuses");
    assert.equal(row.runnable, "no");
    // The REAL tier mapping, not this file's model of it.
    assert.equal(notRunTier(notRunFor(row).why), 2);

    // …and it says something an operator can act on, in a binary that has never heard of
    // this migration. The manifest's failure text is the only channel available.
    assert.match(row.broken ?? "", /MIGRATED/);
    assert.match(row.broken ?? "", /anchors/);

    // THE COUNTERFACTUAL, which is what makes the above mean anything: with the legacy
    // paths simply EMPTIED (the migration a reasonable person would have written), the old
    // code path reports NO rows, and no rows is the on-ramp.
    await fs.rm(legacy.replays, { recursive: true, force: true });
    assert.deepEqual(
      await discoverTraceAssets(root, legacyLayout),
      [],
      "without the tombstone an old CLI sees no anchor at all, which is exactly the defect",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** The pre-S2 standard layout, reconstructed for the old-CLI simulation above. */
function flatLegacyLayout(root: string): {
  replays: string;
  replayTraces: string;
  replayReports: string;
  replayBaselines: string;
} {
  const legacy = legacyPaths(root);
  return {
    replays: legacy.replays,
    replayTraces: legacy.replayTraces,
    replayReports: legacy.replayReports,
    replayBaselines: legacy.replayBaselines,
  };
}

test("M1: the NEW CLI reads the tombstone as the migration marker, never as work to redo", async () => {
  const root = await tmpProject("migrate-marker-");
  try {
    await initRepo(root);
    await plantLegacyProject(root);
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    const scan = await scanLegacyLayout(root);
    assert.equal(scan.state, "tombstoned");
    assert.deepEqual(legacyLayoutRefusal(scan, "[t]"), [], "a migrated project must not refuse");

    // Idempotent: a second run is a no-op that still exits 0.
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);
    assert.equal((await scanLegacyLayout(root)).state, "tombstoned");

    // And the anchors are where the new CLI looks, with the approval untouched.
    const paths = loombridgePaths(root);
    const rows = await discoverTraceAssets(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.runnable, "live");
    assert.equal(rows[0]!.approvedAt, APPROVED_AT);
    assert.ok(rows[0]!.paths.asset!.startsWith(paths.anchors));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* M6. THE REFUSAL PREDICATE IS FILE CONTENT, NEVER DIRECTORY EXISTENCE       */
/* ══════════════════════════════════════════════════════════════════════════ */

test("M6: a re-created EMPTY legacy directory is not a refusal (no permanent exit-2 loop)", async () => {
  const root = await tmpProject("migrate-empty-dir-");
  try {
    await initRepo(root);
    await plantLegacyProject(root);
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    // THE FAILURE THIS PINS. An MCP session used to create `.loombridge/replays/traces/`
    // simply by connecting, because the op recorder wrote there. Had the predicate been
    // "the legacy directory exists", every agent session after a CORRECT migration would
    // have re-armed a permanent exit-2 refusal that no amount of re-migrating could clear.
    const legacy = legacyPaths(root);
    await fs.rm(legacy.replays, { recursive: true, force: true });
    await fs.mkdir(legacy.replayTraces, { recursive: true });
    await fs.mkdir(legacy.replayBaselines, { recursive: true });

    const scan = await scanLegacyLayout(root);
    assert.equal(scan.state, "none");
    assert.deepEqual(legacyLayoutRefusal(scan, "[t]"), []);

    // …and a stray op-trace JSONL in there is not a demonstration either.
    await fs.writeFile(path.join(legacy.replayTraces, "trace-abc123.jsonl"), "{}\n", "utf-8");
    assert.equal((await scanLegacyLayout(root)).state, "none");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M6: a REAL demonstration at a legacy path refuses, and names it", async () => {
  const root = await tmpProject("migrate-refusal-");
  try {
    const { id } = await plantLegacyProject(root);
    const scan = await scanLegacyLayout(root);
    assert.equal(scan.state, "unmigrated");
    assert.deepEqual(scan.unmigratedTraceIds, [id]);
    assert.deepEqual(scan.unmigratedBaselineIds, [id]);

    const lines = legacyLayoutRefusal(scan, "[t]").join("\n");
    assert.match(lines, /REFUSED/);
    assert.match(lines, new RegExp(`replays/traces/${id}\\.trace\\.json`));
    assert.match(lines, new RegExp(`replays/baselines/${id}/`));
    assert.ok(lines.includes(MIGRATE_VERB), "the refusal must name the verb that fixes it");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M6: an UNSTAMPED legacy baseline is not a refusal (it was never an anchor)", async () => {
  const root = await tmpProject("migrate-unstamped-");
  try {
    const legacy = legacyPaths(root);
    await fs.mkdir(path.join(legacy.replayBaselines, "old"), { recursive: true });
    await fs.writeFile(path.join(legacy.replayBaselines, "old", "a.png"), Buffer.from("x"));
    // No manifest at all: a LEGACY baseline, which never executed and never contributed a
    // pass. Refusing every door over one is a refusal with nothing behind it.
    assert.equal((await scanLegacyLayout(root)).state, "none");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* M3. RE-STAMPING THE PATHS THAT ARE NOT SHA-BOUND                           */
/* ══════════════════════════════════════════════════════════════════════════ */

test("M3: remapLegacyRelPath moves every non-derived recorded path, and only those", () => {
  const cases: [string, string][] = [
    [".loombridge/reports/build-verdict.json", ".loombridge/run/reports/build-verdict.json"],
    [".loombridge/reports/verify.json", ".loombridge/run/reports/verify.json"],
    [".loombridge/reports/slices/framing.verdict.json", ".loombridge/run/reports/slices/framing.verdict.json"],
    // THE SIGN-OFF, which loses the run tier and gains the anchor tier.
    [".loombridge/reports/slices/framing/signoff.png", ".loombridge/anchors/signoffs/framing/signoff.png"],
    [".loombridge/replays/traces/demo.trace.json", ".loombridge/anchors/traces/demo.trace.json"],
    [".loombridge/replays/baselines/demo/step-1.png", ".loombridge/anchors/baselines/demo/step-1.png"],
    [".loombridge/replays/reports/demo.report.json", ".loombridge/run/replays/reports/demo.report.json"],
    [".loombridge/replays/fleet.report.json", ".loombridge/run/replays/fleet.report.json"],
    [".loombridge/backups/x.json", ".loombridge/run/backups/x.json"],
    [".loombridge/captures/start.png", ".loombridge/run/captures/start.png"],
    [".loombridge/art/geometry.json", ".loombridge/run/art/geometry.json"],
    [".loombridge/handoff/report.json", ".loombridge/run/handoff/report.json"],
    // UNCHANGED, and each for a stated reason.
    [".loombridge/verify/framing/x.json", ".loombridge/verify/framing/x.json"], // C# allowlist
    [".loombridge/tests/test-results.xml", ".loombridge/tests/test-results.xml"], // committed evidence
    [".loombridge/registry/pack.json", ".loombridge/registry/pack.json"], // project input
    [".loombridge/ACCEPTANCE.json", ".loombridge/ACCEPTANCE.json"],
    ["Assets/Scenes/Game.unity", "Assets/Scenes/Game.unity"],
  ];
  for (const [from, to] of cases) {
    assert.equal(remapLegacyRelPath(from), to, `remap ${from}`);
    // IDEMPOTENT. The migration is resumable, so a stamp may be rewritten twice; a rule
    // that matched its own output would produce `.loombridge/run/run/reports/…`.
    assert.equal(remapLegacyRelPath(to), to, `remap is idempotent for ${to}`);
  }
});

test("M3: the per-slice VERDICT is not dragged into anchors/ by the sign-off rule", () => {
  // Both live under `reports/slices/`, and only one of them is an approval. Getting this
  // wrong would file run output as ground truth, where `git clean` cannot reach it and a
  // reviewer would read a regenerable verdict as a human sign-off.
  assert.equal(
    remapLegacyRelPath(".loombridge/reports/slices/a.verdict.json"),
    ".loombridge/run/reports/slices/a.verdict.json",
  );
  assert.equal(
    remapLegacyRelPath(".loombridge/reports/slices/a.diagnostic.json"),
    ".loombridge/run/reports/slices/a.diagnostic.json",
  );
  assert.equal(
    remapLegacyRelPath(".loombridge/reports/slices/a/signoff.png"),
    ".loombridge/anchors/signoffs/a/signoff.png",
  );
  // THE BARE DIRECTORY, which is the shape the evidence ledger records. It must fall
  // through to the generic reports rule, not into anchors/: `.loombridge/reports/slices` is
  // where the per-slice VERDICTS live, and those are run output.
  assert.equal(remapLegacyRelPath(".loombridge/reports/slices"), ".loombridge/run/reports/slices");
  assert.equal(remapLegacyRelPath(".loombridge/captures"), ".loombridge/run/captures");
  assert.equal(remapLegacyRelPath(".loombridge/replays"), ".loombridge/run/replays");
  assert.equal(remapLegacyRelPath(".loombridge/replays/traces"), ".loombridge/anchors/traces");
});

test("M3: the migration re-stamps SLICES.json, STATE.md, and the evidence ledger", async () => {
  const root = await tmpProject("migrate-restamp-");
  try {
    await initRepo(root);
    await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);

    // A human sign-off artifact at the legacy path, with a sha the migration must re-derive
    // from the RELOCATED bytes rather than carry forward.
    const signoffBytes = Buffer.from("the frame a human signed off");
    await fs.mkdir(path.join(legacy.sliceReports, "framing"), { recursive: true });
    await fs.writeFile(path.join(legacy.sliceReports, "framing", "signoff.png"), signoffBytes);
    await fs.writeFile(
      path.join(legacy.sliceReports, "framing.verdict.json"),
      `${JSON.stringify({ status: "pass", evidence: { schemaVersion: "1", inputsDir: ".loombridge/captures", runId: null, files: [], missing: [] } }, null, 2)}\n`,
      "utf-8",
    );

    const plan: SlicePlan = {
      schemaVersion: "1",
      genre: "platformer-2d",
      slices: [
        {
          id: "framing",
          title: "Framing",
          dependsOn: [],
          feelIntent: "x",
          acceptance: { gates: ["framing"] },
          state: "approved",
          proof: {
            runId: "run-1",
            startedAt: "t",
            verdictPath: ".loombridge/reports/slices/framing.verdict.json",
            captureManifest: [],
            checkpointId: "cp",
            approvedAt: "t",
            signoffArtifact: ".loombridge/reports/slices/framing/signoff.png",
            // DELIBERATELY WRONG, so "the sha was re-derived" is distinguishable from
            // "the sha happened to already match".
            signoffSha256: "0".repeat(64),
          },
        },
      ],
    };
    await writeSlicePlan(paths, plan);
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "verified-green",
      lastVerdict: { status: "pass", at: "t", verdictPath: ".loombridge/reports/build-verdict.json" },
      updatedAt: "t",
    });

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    const after = (await readSlicePlan(paths))!;
    const proof = after.slices[0]!.proof!;
    assert.equal(proof.verdictPath, ".loombridge/run/reports/slices/framing.verdict.json");
    assert.equal(proof.signoffArtifact, ".loombridge/anchors/signoffs/framing/signoff.png");
    assert.equal(proof.signoffSha256, sha(signoffBytes), "the sha must be RE-DERIVED from the moved bytes");

    const state = await readState(paths);
    assert.equal(state!.lastVerdict!.verdictPath, ".loombridge/run/reports/build-verdict.json");

    const verdict = JSON.parse(
      await fs.readFile(path.join(paths.reports, "slices", "framing.verdict.json"), "utf-8"),
    ) as { evidence: { inputsDir: string } };
    assert.equal(verdict.evidence.inputsDir, ".loombridge/run/captures");

    // The sign-off really is on disk at its new home, byte-identical.
    assert.deepEqual(
      await fs.readFile(path.join(paths.signoffs, "framing", "signoff.png")),
      signoffBytes,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* M5. THE ANCHORS ARE LEFT TRACKED, AND THE PROJECT .gitignore IS FIXED      */
/* ══════════════════════════════════════════════════════════════════════════ */

test("M5: outside a git work tree the migration REFUSES and moves nothing", async () => {
  const root = await tmpProject("migrate-nogit-");
  try {
    const { id } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);

    // The reason this is a preflight and not a post-hoc warning: `git clean -fd` SKIPS
    // ignored files, so the anchors under the (ignored) `replays/` were accidentally
    // protected. Landing them untracked AND un-ignored is strictly less protection than
    // they had, and finding that out after the sources are gone is finding out too late.
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 2);
    await fs.access(path.join(legacy.replayTraces, `${id}.trace.json`));
    assert.equal(await isTombstoneFile(path.join(legacy.replayTraces, `${id}.trace.json`)), false);
    assert.equal((await scanLegacyLayout(root)).state, "unmigrated", "nothing may have moved");

    // …and the operator can accept it explicitly.
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: true }), 0);
    assert.equal((await scanLegacyLayout(root)).state, "tombstoned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M5: the migration STAGES the moved anchors, so `git clean -fd` cannot eat them", async () => {
  const root = await tmpProject("migrate-track-");
  try {
    await initRepo(root);
    const { id } = await plantLegacyProject(root);
    const paths = loombridgePaths(root);

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    const staged = git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
    assert.ok(
      staged.includes(`.loombridge/anchors/traces/${id}.trace.json`),
      `the demonstration must be staged; git staged ${JSON.stringify(staged)}`,
    );
    assert.ok(staged.some((f) => f.startsWith(`.loombridge/anchors/baselines/${id}/`)));
    assert.ok(staged.includes(".loombridge/run/.gitignore"));

    // THE MEASURED FAILURE. Before staging, `git clean -fd` deleted the migrated anchors
    // with no git object behind them. With them staged, git refuses to clean them.
    git(root, "clean", "-fd");
    await fs.access(path.join(paths.replayTraces, `${id}.trace.json`));
    await fs.access(path.join(paths.replayBaselines, id, TRACE_BASELINE_MANIFEST));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M5: rewriteProjectGitignore drops the anchor-hiding rule and adds the run rule", () => {
  const before = [
    "[Ll]ibrary/",
    ".loombridge/reports/",
    ".loombridge/replays/",
    ".loombridge/captures/",
    "",
  ].join("\n");
  const { body, changes } = rewriteProjectGitignore(before);

  assert.equal(body.includes(".loombridge/replays/"), false, "the rule that hid the anchors must go");
  assert.ok(body.includes(".loombridge/run/*"));
  assert.ok(changes.some((c) => c.includes("removed '.loombridge/replays/'")));
  assert.ok(changes.some((c) => c.includes("added '.loombridge/run/*'")));

  // THE TRAILING STAR IS LOAD-BEARING, and this is the assertion that stops a later
  // "tidy-up" turning it into the directory form. Git cannot re-include a file inside an
  // EXCLUDED DIRECTORY, so `.loombridge/run/` would also hide `.loombridge/run/.gitignore`
  // and the marker would never reach a clone. Measured with real `git check-ignore` in
  // `__tests__/unit/repo/write-paths.test.ts`.
  assert.equal(body.includes("\n.loombridge/run/\n"), false);

  // Idempotent: re-running the migration must not stack a second copy of the rule.
  const twice = rewriteProjectGitignore(body);
  assert.deepEqual(twice.changes, []);
  assert.equal(twice.body, body);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* M7. TWO TREES NAMED `reports` ARE NESTED, NEVER MERGED                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test("M7: `reports/` and `replays/reports/` land in DIFFERENT directories", async () => {
  const root = await tmpProject("migrate-nest-");
  try {
    await initRepo(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);
    const { id } = await plantLegacyProject(root);
    // A NAME COLLISION, which is what makes the merge irreversible: the same filename in
    // both trees. Merged into one directory, one of these silently wins and no rename can
    // separate them again.
    await fs.writeFile(path.join(legacy.reports, "collide.json"), '{"from":"reports"}\n', "utf-8");
    await fs.writeFile(path.join(legacy.replayReports, "collide.json"), '{"from":"replays"}\n', "utf-8");

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    assert.equal(
      await fs.readFile(path.join(paths.reports, "collide.json"), "utf-8"),
      '{"from":"reports"}\n',
    );
    assert.equal(
      await fs.readFile(path.join(paths.replayReports, "collide.json"), "utf-8"),
      '{"from":"replays"}\n',
    );
    await fs.access(path.join(paths.replayReports, `${id}.report.json`));
    await fs.access(path.join(paths.replays, "fleet.report.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* M8. INTERRUPTION, RESUMPTION, AND CONCURRENCY                              */
/* ══════════════════════════════════════════════════════════════════════════ */

test("M8: interrupted between verify and release, a second run finishes it (never re-migrates)", async () => {
  const root = await tmpProject("migrate-resume-");
  try {
    await initRepo(root);
    const { id, frameShas } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);

    // THE EXACT INTERRUPTION POINT: the copy verified, the source has not been released.
    // Both copies exist. A second run must read the survivor as neither un-migrated work
    // (which would re-copy over a destination somebody may have since re-approved) nor as
    // finished (which would leave the legacy path un-tombstoned and an old CLI blind).
    await fs.mkdir(paths.replayTraces, { recursive: true });
    await fs.cp(
      path.join(legacy.replayTraces, `${id}.trace.json`),
      path.join(paths.replayTraces, `${id}.trace.json`),
    );
    await fs.cp(path.join(legacy.replayBaselines, id), path.join(paths.replayBaselines, id), {
      recursive: true,
    });

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    // Finished: the legacy path is tombstoned, the destination is intact and unduplicated.
    assert.equal((await scanLegacyLayout(root)).state, "tombstoned");
    for (const [captureId, expected] of Object.entries(frameShas)) {
      assert.equal(sha(await fs.readFile(path.join(paths.replayBaselines, id, `${captureId}.png`))), expected);
    }
    const rows = await discoverTraceAssets(root);
    assert.equal(rows[0]!.runnable, "live");
    assert.equal(rows[0]!.approvedAt, APPROVED_AT, "an interrupted run must not disturb the approval");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M8: a HALF-migrated pair is finished as one unit, never left as trace-without-baseline", async () => {
  const root = await tmpProject("migrate-halfpair-");
  try {
    await initRepo(root);
    const { id } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);

    // Simulate a SIGINT after the trace moved and before the baselines did. This is the
    // shape that matters most: a migrated trace with a legacy baseline reads as "recorded,
    // not approved", whose printed next action is `trace approve`, which freezes NEW frames
    // over the ones a human already approved.
    await fs.mkdir(paths.replayTraces, { recursive: true });
    await fs.rename(
      path.join(legacy.replayTraces, `${id}.trace.json`),
      path.join(paths.replayTraces, `${id}.trace.json`),
    );

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    const rows = await discoverTraceAssets(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.runnable, "live", "the pair must be whole again");
    assert.equal(rows[0]!.approvedAt, APPROVED_AT);
    assert.equal((await scanLegacyLayout(root)).state, "tombstoned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M9: a half-migrated project says 'your baseline is at the OLD path', never 'approve a new one'", async () => {
  const root = await tmpProject("migrate-halfmsg-");
  try {
    const { id } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);
    // Trace migrated, baseline not: exactly the state a partial move leaves behind.
    await fs.mkdir(paths.replayTraces, { recursive: true });
    await fs.rename(
      path.join(legacy.replayTraces, `${id}.trace.json`),
      path.join(paths.replayTraces, `${id}.trace.json`),
    );

    const rows = await discoverTraceAssets(root);
    assert.equal(rows.length, 1);
    const reason = rows[0]!.reason ?? "";
    assert.match(reason, /OLD path/);
    assert.ok(reason.includes(MIGRATE_VERB));
    assert.equal(
      /recorded, not approved/.test(reason),
      false,
      "the default sentence's next action is `trace approve`, which would overwrite the human's frames",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M8: two concurrent runs, the second REFUSES rather than racing the first", async () => {
  const root = await tmpProject("migrate-lock-");
  try {
    await initRepo(root);
    await plantLegacyProject(root);
    const paths = loombridgePaths(root);

    // A live lock held by THIS process: `pidAlive(process.pid)` is true, so it is not
    // stale by either rule.
    await fs.mkdir(paths.run, { recursive: true });
    await fs.writeFile(
      path.join(paths.run, "migrate-layout.lock"),
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }),
      "utf-8",
    );
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 2);
    assert.equal((await scanLegacyLayout(root)).state, "unmigrated", "the refused run must move nothing");

    // A STALE lock (dead pid) is taken over rather than blocking forever: an operator who
    // Ctrl-C'd must not have to wait out a timeout to recover.
    await fs.writeFile(
      path.join(paths.run, "migrate-layout.lock"),
      JSON.stringify({ pid: 0x7fffffff, host: os.hostname(), startedAt: new Date().toISOString() }),
      "utf-8",
    );
    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);
    assert.equal((await scanLegacyLayout(root)).state, "tombstoned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M8: a copy that does not verify releases NOTHING", async () => {
  const root = await tmpProject("migrate-badcopy-");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });
    await fs.writeFile(path.join(src, "a.png"), Buffer.from("original"));
    await fs.writeFile(path.join(dst, "a.png"), Buffer.from("TRUNCATED"));

    const failures = await verifyCopy(src, dst);
    assert.equal(failures.length, 1, `expected a sha refusal, got ${JSON.stringify(failures)}`);
    assert.match(failures[0]!, /sha256 mismatch/);

    // NON-VACUITY: an identical copy verifies, or "refuses on mismatch" would be true of a
    // predicate that refuses everything.
    await fs.writeFile(path.join(dst, "a.png"), Buffer.from("original"));
    assert.deepEqual(await verifyCopy(src, dst), []);

    // …and a MISSING destination file is a refusal too, not a silent skip. A size or count
    // comparison would pass on a truncated copy, which is the whole reason this is a sha.
    await fs.writeFile(path.join(src, "b.png"), Buffer.from("second"));
    assert.match((await verifyCopy(src, dst))[0]!, /missing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("M8: the migration never calls fs.rename, so EXDEV is not a fallback path", async () => {
  // A cross-device move (a project on an external volume, a bind-mounted CI workspace)
  // makes `fs.rename` throw EXDEV. A `try rename / catch copy` shape means the copy branch
  // only ever runs on someone ELSE'S machine, which is the worst possible place for the
  // code that decides whether an irreplaceable file survives. This module has no rename at
  // all: copy → verify → unlink is the only path, so EXDEV is an ordinary case by
  // construction rather than a branch nobody exercises.
  const source = await fs.readFile(
    path.join(PKG_ROOT, "src", "capabilities", "migrate", "migrate-layout.ts"),
    "utf-8",
  );
  assert.equal(/\brename\s*\(/.test(source), false, "migrate-layout.ts must contain no rename call");
  // NON-VACUITY for the scan itself: it must fire on the shape it claims to reject.
  assert.equal(/\brename\s*\(/.test("await fs.rename(a, b);"), true);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* THE DRY RUN AND THE OP TRACES                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

test("--dry-run leaves the project byte-identical", async () => {
  const root = await tmpProject("migrate-dry-");
  try {
    await initRepo(root);
    await plantLegacyProject(root);
    const before = await snapshot(path.join(root, ".loombridge"));
    assert.equal(await runMigrateLayout({ root, dryRun: true, noGit: false }), 0);
    assert.deepEqual(await snapshot(path.join(root, ".loombridge")), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP op traces are separated from the demonstrations they used to share a directory with", async () => {
  const root = await tmpProject("migrate-optrace-");
  try {
    await initRepo(root);
    const { id } = await plantLegacyProject(root);
    const legacy = legacyPaths(root);
    const paths = loombridgePaths(root);
    // What a real consumer project has: the server's session JSONL and its artifacts,
    // written into the SAME directory as the human demonstration.
    await fs.writeFile(path.join(legacy.replayTraces, "trace-sess1.jsonl"), '{"op":1}\n', "utf-8");
    await fs.mkdir(path.join(legacy.replayTraces, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(legacy.replayTraces, "artifacts", "shot.png"), Buffer.from("png"));

    assert.equal(await runMigrateLayout({ root, dryRun: false, noGit: false }), 0);

    // The demonstration is an anchor; the session log is run output. Different tiers now,
    // not just different filenames.
    await fs.access(path.join(paths.replayTraces, `${id}.trace.json`));
    await fs.access(path.join(paths.opTraces, "trace-sess1.jsonl"));
    await fs.access(path.join(paths.opTraces, "artifacts", "shot.png"));
    assert.equal(
      await exists(path.join(paths.replayTraces, "trace-sess1.jsonl")),
      false,
      "an op log must never land in the anchors directory",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the flat mini-game workspace layout is untouched by all of this", () => {
  // `--flat` is the `~/.loombridge/projects/<id>/` shape, which never had a
  // `.loombridge/replays/` and is not what this migration moves. Pinned so a later
  // "consistency" pass does not drag it into the tier split and strand every mini-game
  // workspace on disk.
  const flat = flatReplayLayout("/ws");
  assert.equal(flat.replays, "/ws");
  assert.equal(flat.replayTraces, path.join("/ws", "traces"));
  assert.equal(flat.replayReports, path.join("/ws", "reports"));
  assert.equal(flat.replayBaselines, path.join("/ws", "baseline"));
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `<relpath> <sha256>` for every file under `dir`, sorted. */
async function snapshot(dir: string, base = dir, acc: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) await snapshot(abs, base, acc);
    else acc.push(`${path.relative(base, abs)} ${sha(await fs.readFile(abs))}`);
  }
  return acc.sort();
}
