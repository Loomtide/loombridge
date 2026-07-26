/**
 * Disk-truth SFX enforcement at whole-game doneness (SFX dogfood #7 / review D1).
 *
 * The bypass this closes: author `verification.sfx.enabled:true` → never produce
 * captures → flip `enabled:false` → re-verify → doneness green with zero residue.
 * Mirrors readDeclaredArtMode / readRequiredEvidenceClasses: doneness reads
 * `verification.sfx` from the ON-DISK contract; when disk says enabled:true, the
 * bound verdict must carry reports for ALL FOUR sfx gates (union refusal when absent).
 * A malformed sfx section is a fail-closed `{ unreadable }` sentinel → explicit refusal.
 *
 * Residual by-design opt-out (documented, tested): DISABLING in the disk contract
 * itself is spec-editing, not laundering — the gate closes verdict-vs-disk divergence.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readDeclaredSfxVerification,
  sfxGateRefusals,
  wholeGameDonenessReasons,
  type VerdictLike,
} from "../capabilities/verification/doneness.js";
import { SFX_GATE_NAMES } from "../capabilities/verification/run-gates.js";
import { runPlan } from "../capabilities/verification/plan.js";
import { runVerify } from "../capabilities/verification/verify.js";
import { loombridgePaths } from "../domain/state.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-sfx-doneness-"));
}

// ── readDeclaredSfxVerification (disk-truth read) ────────────────────────────

test("readDeclaredSfxVerification: ENOENT ⇒ enabled:false (missing contract is other layers' refusal)", async () => {
  const read = await readDeclaredSfxVerification(path.join(os.tmpdir(), "sfx-doneness-nonexistent", "ACCEPTANCE.json"));
  assert.deepEqual(read, { enabled: false });
});

test("readDeclaredSfxVerification: valid contract without sfx / with enabled:false ⇒ enabled:false", async () => {
  const root = await tmpRoot();
  try {
    const p = path.join(root, "ACCEPTANCE.json");
    await fs.writeFile(p, JSON.stringify({ verification: { gates: {} } }), "utf-8");
    assert.deepEqual(await readDeclaredSfxVerification(p), { enabled: false });
    await fs.writeFile(p, JSON.stringify({ verification: { sfx: { enabled: false } } }), "utf-8");
    assert.deepEqual(await readDeclaredSfxVerification(p), { enabled: false });
    await fs.writeFile(p, JSON.stringify({ verification: { sfx: { enabled: true } } }), "utf-8");
    assert.deepEqual(await readDeclaredSfxVerification(p), { enabled: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readDeclaredSfxVerification: unparseable contract / malformed sfx section ⇒ fail-closed sentinel", async () => {
  const root = await tmpRoot();
  try {
    const p = path.join(root, "ACCEPTANCE.json");
    await fs.writeFile(p, "{ truncated", "utf-8");
    let read = await readDeclaredSfxVerification(p);
    assert.ok("unreadable" in read && /does not parse/.test(read.unreadable));
    // sfx present but not an object
    await fs.writeFile(p, JSON.stringify({ verification: { sfx: "yes" } }), "utf-8");
    read = await readDeclaredSfxVerification(p);
    assert.ok("unreadable" in read && /must be an object/.test(read.unreadable));
    // enabled present but not a boolean — a hand-edit must not disarm the gate
    await fs.writeFile(p, JSON.stringify({ verification: { sfx: { enabled: "false" } } }), "utf-8");
    read = await readDeclaredSfxVerification(p);
    assert.ok("unreadable" in read && /`enabled` must be a boolean/.test(read.unreadable));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── sfxGateRefusals (pure union refusals) ────────────────────────────────────

/** A verdict whose gates block carries all four SFX gate reports (any status). */
const gradedVerdict: VerdictLike = {
  status: "warn",
  gates: {
    "sfx-presence": "warn",
    "sfx-runtime": "warn",
    inputToSfxLatency: "warn",
    "sfx-fatigue": "warn",
    "console-clean": "pass",
  },
  checks: [],
};

test("sfxGateRefusals: not enabled on disk ⇒ no refusals (backward compat + by-design opt-out)", () => {
  assert.deepEqual(sfxGateRefusals({ enabled: false }, null), []);
  assert.deepEqual(sfxGateRefusals({ enabled: false }, { status: "pass" }), []);
});

test("sfxGateRefusals: enabled + verdict graded all four gates ⇒ no refusals (graded-not-green: warns count)", () => {
  assert.deepEqual(sfxGateRefusals({ enabled: true }, gradedVerdict), []);
});

test("sfxGateRefusals: enabled + NO verdict / no gates block ⇒ one refusal (re-verify)", () => {
  for (const v of [null, { status: "pass" }, { status: "pass", gates: undefined } as VerdictLike]) {
    const reasons = sfxGateRefusals({ enabled: true }, v);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /graded no SFX gates/);
  }
});

test("sfxGateRefusals: enabled + a verdict MISSING any sfx gate ⇒ a union refusal per missing gate", () => {
  const partial: VerdictLike = {
    status: "pass",
    gates: { "sfx-presence": "pass", "console-clean": "pass" },
    checks: [],
  };
  const reasons = sfxGateRefusals({ enabled: true }, partial);
  assert.equal(reasons.length, SFX_GATE_NAMES.length - 1, "one refusal per ungraded sfx gate");
  for (const gate of SFX_GATE_NAMES) {
    if (gate === "sfx-presence") continue;
    assert.ok(reasons.some((r) => r.includes(`\`${gate}\``)), `refusal names ${gate}`);
  }
});

test("sfxGateRefusals: unreadable sentinel ⇒ explicit fail-closed refusal", () => {
  const reasons = sfxGateRefusals({ unreadable: "x" }, gradedVerdict);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /must not disarm a declared SFX gate/);
});

// ── end-to-end: the D1 bypass is closed at wholeGameDonenessReasons ──────────

test("doneness REFUSES when disk declares sfx but the verdict predates it; re-verify (graded) clears the refusal", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");

    // 1. Verify WITHOUT sfx declared → verdict has no sfx gates.
    await runVerify({ root, inputsDir: paths.verifyInputs, acceptancePath: paths.acceptance, outputPath: paths.verdict, strict: false });

    // 2. NOW declare sfx on disk (the divergence: verdict predates the declaration).
    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as Record<string, unknown>;
    const verification = (contract.verification as Record<string, unknown> | undefined) ?? {};
    verification.sfx = { enabled: true };
    contract.verification = verification;
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");

    let out = await wholeGameDonenessReasons(paths);
    for (const gate of SFX_GATE_NAMES) {
      assert.ok(
        out.reasons.some((r) => r.includes(`carries no \`${gate}\` gate report`)),
        `expected the SFX divergence refusal for ${gate}, got: ${JSON.stringify(out.reasons)}`,
      );
    }

    // 3. Re-verify WITH sfx declared → the four gates are graded (blocked warns —
    //    no cue map staged) → the SFX refusal clears (graded-not-green).
    await runVerify({ root, inputsDir: paths.verifyInputs, acceptancePath: paths.acceptance, outputPath: paths.verdict, strict: false });
    const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8")) as VerdictLike;
    for (const gate of SFX_GATE_NAMES) {
      assert.equal(typeof verdict.gates?.[gate], "string", `verdict grades ${gate}`);
    }
    out = await wholeGameDonenessReasons(paths);
    assert.equal(
      out.reasons.some((r) => /SFX gate|SFX gates|SFX-dogfood/.test(r)),
      false,
      `re-verified verdict grades the sfx gates ⇒ no SFX refusal, got: ${JSON.stringify(out.reasons)}`,
    );

    // 4. Residual by-design opt-out: disabling on DISK removes the gate (spec-editing,
    //    not laundering) — even against the pre-sfx verdict.
    verification.sfx = { enabled: false };
    contract.verification = verification;
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    out = await wholeGameDonenessReasons(paths);
    assert.equal(out.reasons.some((r) => /SFX-dogfood #7\/D1/.test(r)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness: a MALFORMED sfx section refuses fail-closed (cannot disarm by corrupting the section)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as Record<string, unknown>;
    const verification = (contract.verification as Record<string, unknown> | undefined) ?? {};
    verification.sfx = { enabled: "yes" }; // hand-corrupted after declaring the gate
    contract.verification = verification;
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");

    const out = await wholeGameDonenessReasons(paths);
    assert.ok(
      out.reasons.some((r) => /must not disarm a declared SFX gate/.test(r)),
      `expected the fail-closed sfx refusal, got: ${JSON.stringify(out.reasons)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
