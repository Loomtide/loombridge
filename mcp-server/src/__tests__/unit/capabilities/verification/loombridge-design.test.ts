import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approveDesignTarget,
  DEFAULT_DESIGN_TARGET_KIND,
  designPaths,
  designStatus,
  exitCodeForDesignReadiness,
  resolveDesignTargetKind,
  run as designCli,
  setDesignTarget,
} from "../../../../capabilities/verification/design.js";
import { runPlan } from "../../../../capabilities/verification/plan.js";
import { runVerify } from "../../../../capabilities/verification/verify.js";
import { loombridgePaths, readState } from "../../../../domain/state.js";
import { writeApprovedAssetManifestForDesign } from "../../../helpers/asset-manifest-fixture.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-design-"));
}

/** A throwaway "image" file (the freeze copies + hashes bytes; not a real PNG). */
async function fakeImage(dir: string, bytes = "hero-pixels-v1"): Promise<string> {
  const p = path.join(dir, "src-hero.png");
  await fs.writeFile(p, bytes, "utf-8");
  return p;
}

// ── readiness gate (the §3c gate) ────────────────────────────────────────────

test("exitCodeForDesignReadiness gates on approved AND frozen-matching", () => {
  // Ready iff status === approved AND frozenMatches === true.
  assert.equal(exitCodeForDesignReadiness({ status: "approved", frozenMatches: true }), 0);
  assert.equal(
    exitCodeForDesignReadiness({ status: "approved", frozenMatches: false }),
    1,
    "a tampered approved hero shot must NOT pass the gate (frozen = golden)",
  );
  assert.equal(exitCodeForDesignReadiness({ status: "draft", frozenMatches: true }), 1);
  assert.equal(exitCodeForDesignReadiness({ status: "missing", frozenMatches: false }), 1);
});

test("designStatus reports missing on a fresh project", async () => {
  const root = await tmpRoot();
  const report = await designStatus(loombridgePaths(root));
  assert.equal(report.status, "missing");
  assert.equal(report.hasPng, false);
});

// ── set / approve / freeze ───────────────────────────────────────────────────

test("set ingests a hero shot as draft; approve freezes + flips state", async () => {
  const root = await tmpRoot();
  const img = await fakeImage(root);

  const meta = await setDesignTarget({ root, imagePath: img, mode: "generated" });
  assert.equal(meta.status, "draft");
  assert.equal(meta.approvedAt, null);

  const paths = loombridgePaths(root);
  assert.ok((await fs.stat(path.join(paths.design, "hero-shot.png"))).isFile());
  assert.equal((await readState(paths))?.designTarget, "draft");

  let report = await designStatus(paths);
  assert.equal(report.status, "draft");
  assert.equal(report.frozenMatches, true, "freshly-set bytes match their recorded hash");

  const approved = await approveDesignTarget({ root, note: "looks right" });
  assert.equal(approved.status, "approved");
  assert.ok(approved.approvedAt, "approvedAt is set");
  assert.equal((await readState(paths))?.designTarget, "approved");

  report = await designStatus(paths);
  assert.equal(report.status, "approved");
  assert.equal(exitCodeForDesignReadiness(report), 0);
});

test("frozen-integrity: editing the hero shot after approval is detected", async () => {
  const root = await tmpRoot();
  const img = await fakeImage(root);
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });

  const paths = loombridgePaths(root);
  // Tamper with the frozen PNG after approval.
  await fs.writeFile(path.join(paths.design, "hero-shot.png"), "hero-pixels-v2-EDITED", "utf-8");

  const report = await designStatus(paths);
  assert.equal(report.status, "approved", "status is unchanged...");
  assert.equal(report.frozenMatches, false, "...but the bytes no longer match the freeze");
});

test("reference-game mode requires a game name", async () => {
  const root = await tmpRoot();
  const img = await fakeImage(root);
  await assert.rejects(
    () => setDesignTarget({ root, imagePath: img, mode: "reference-game" }),
    /reference-game/,
  );
  const meta = await setDesignTarget({
    root,
    imagePath: img,
    mode: "reference-game",
    referenceGame: "Celeste",
    approve: true,
  });
  assert.equal(meta.referenceGame, "Celeste");
});

// ── the 3D design-target split: kind (composition-reference vs rendered) ──────

test("resolveDesignTargetKind defaults to rendered-unity-frame (final-by-default)", () => {
  assert.equal(DEFAULT_DESIGN_TARGET_KIND, "rendered-unity-frame");
  assert.equal(resolveDesignTargetKind(undefined), "rendered-unity-frame", "absent (pre-split file) ⇒ final");
  assert.equal(resolveDesignTargetKind(null), "rendered-unity-frame");
  assert.equal(resolveDesignTargetKind("rendered-unity-frame"), "rendered-unity-frame");
  assert.equal(resolveDesignTargetKind("composition-reference"), "composition-reference");
  // A bogus/hand-edited value is never silently honoured as composition-reference;
  // it falls back to the final default (only an explicit composition-reference is special).
  assert.equal(resolveDesignTargetKind("garbage" as never), "rendered-unity-frame");
});

test("set defaults a target to rendered-unity-frame; designStatus reports the kind", async () => {
  const root = await tmpRoot();
  const meta = await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  assert.equal(meta.kind, "rendered-unity-frame", "no --kind ⇒ final hero shot");

  const report = await designStatus(loombridgePaths(root));
  assert.equal(report.kind, "rendered-unity-frame");
});

test("set --kind composition-reference is recorded; approve preserves the kind (no silent promotion)", async () => {
  const root = await tmpRoot();
  const img = await fakeImage(root, "composition-pixels");

  // Draft a composition-reference.
  const draft = await setDesignTarget({ root, imagePath: img, mode: "generated", kind: "composition-reference" });
  assert.equal(draft.status, "draft");
  assert.equal(draft.kind, "composition-reference");

  // Approving it (to unlock scene assembly) must NOT promote it to a final frame.
  const approved = await approveDesignTarget({ root });
  assert.equal(approved.status, "approved");
  assert.equal(
    approved.kind,
    "composition-reference",
    "approve freezes the bytes but keeps the kind — a composition-reference stays a composition-reference",
  );
  assert.equal((await designStatus(loombridgePaths(root))).kind, "composition-reference");
});

test("a pre-split design-target.json (no `kind` field) reads as rendered-unity-frame (backward compat)", async () => {
  const root = await tmpRoot();
  // Write a legacy metadata file by hand — exactly the shape committed before the split.
  const paths = loombridgePaths(root);
  const dp = designPaths(paths);
  await fs.mkdir(paths.design, { recursive: true });
  await fs.writeFile(dp.heroPng, "legacy-hero-pixels", "utf-8");
  const legacy = {
    schemaVersion: "1",
    status: "approved",
    mode: "provided",
    referenceGame: null,
    heroShot: "hero-shot.png",
    heroShotHtml: null,
    pngSha256: "0".repeat(64), // intentionally wrong → frozenMatches:false, but kind still resolves
    note: null,
    approvedAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
  await fs.writeFile(dp.meta, JSON.stringify(legacy), "utf-8");

  const report = await designStatus(paths);
  assert.equal(report.kind, "rendered-unity-frame", "absent kind on disk ⇒ final, so legacy 2D targets are unchanged");
});

test("design CLI rejects an invalid --kind value", async () => {
  const root = await tmpRoot();
  const code = await designCli(["set", "--root", root, "--image", await fakeImage(root), "--kind", "bogus"]);
  assert.equal(code, 2, "an unknown --kind is a usage error, not a silent default");
});

test("design status surfaces the kind and the composition-reference next-step guidance", async () => {
  const root = await tmpRoot();
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", kind: "composition-reference", approve: true });

  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    assert.equal(await designCli(["status", "--root", root]), 0);
  } finally {
    console.error = originalError;
  }
  const out = lines.join("\n");
  assert.ok(/kind=composition-reference/.test(out), out);
  // The status line must tell the agent what to do next (capture + freeze a rendered frame).
  assert.ok(/rendered-unity-frame/.test(out), out);
});

// ── plan gate integration ────────────────────────────────────────────────────

test("plan hard-gates on Design Target by default (no flag needed)", async () => {
  const root = await tmpRoot();

  // No target yet -> default gate fails. The user / slash command did not pass
  // any flag — the common path should "just work" without remembering one.
  const blocked = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false });
  assert.equal(blocked, 1, "plan is not ready without an approved Design Target (default)");

  // The escape hatch lets early scaffolding through (with a loud warning).
  const escape = await runPlan({
    root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true,
  });
  assert.equal(escape, 0, "--allow-missing-design-target bypasses the gate");

  // Establish + approve a target, then the default flow advances to the asset gate.
  const img = await fakeImage(root);
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
  const needsAssets = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false });
  assert.equal(needsAssets, 1, "plan now requires an approved Asset Manifest after Design Target approval");

  await writeApprovedAssetManifestForDesign(root);
  const ready = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false });
  assert.equal(ready, 0, "plan is ready once Design Target and Asset Manifest are approved");

  // The approval survives a re-plan (state preserved).
  assert.equal((await readState(loombridgePaths(root)))?.designTarget, "approved");
});

test("plan refuses a tampered approved target by default (frozen = golden)", async () => {
  const root = await tmpRoot();
  const img = await fakeImage(root);
  await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
  await writeApprovedAssetManifestForDesign(root);
  const paths = loombridgePaths(root);

  // Sanity: default gate is green right after approval (no flag).
  assert.equal(
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }),
    0,
  );

  // Tamper with the frozen hero shot — status still says approved, but the bytes
  // no longer match the freeze. The default gate must REFUSE.
  await fs.writeFile(path.join(paths.design, "hero-shot.png"), "TAMPERED-BYTES", "utf-8");
  assert.equal(
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false }),
    1,
    "a tampered approved hero shot must block plan by default",
  );
});

test("verify embeds the frozen Design Target reference in the verdict (advisory)", async () => {
  const root = await tmpRoot();
  // Scaffold .loombridge/ without an approved target — the test is about verify,
  // not the plan gate, so use the escape hatch to get past plan.
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);
  const verifyArgs = {
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  };

  // No target yet -> the verdict records it as missing, Tier-1 unaffected.
  await runVerify(verifyArgs);
  let verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.designTarget.status, "missing");
  assert.equal(verdict.designTarget.heroShot, null);

  // Approve a target -> the verdict references the frozen hero shot.
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", approve: true });
  await runVerify(verifyArgs);
  verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.designTarget.status, "approved");
  assert.equal(verdict.designTarget.frozenMatches, true);
  assert.match(verdict.designTarget.heroShot, /hero-shot\.png$/);
  assert.ok(verdict.designTarget.pngSha256, "verdict records the frozen hash");
});
