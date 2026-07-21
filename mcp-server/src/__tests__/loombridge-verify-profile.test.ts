import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { exitCodeForLiveProfileCapture, run as runVerifyCli } from "../loombridge/verify.js";
import {
  buildProfileReport,
  evaluateProfile,
  runVerifyProfile,
} from "../loombridge/genre-packs/platformer-2d/verify-profile.js";
import { parseMeasurements } from "../loombridge/genre-packs/platformer-2d/measurements.js";
import { loadProfile } from "../loombridge/genre-packs/platformer-2d/profiles.js";
import { SHORT_HOP_CANONICAL_TAP_TICKS } from "../loombridge/genre-packs/platformer-2d/measure-recipe.js";

/**
 * A canonical-tap shortHopApex provenance source. shortHopApex is stimulus-sensitive
 * (F5): a profile that bands it now REFUSES a reading with no recorded stimulus, so
 * an all-metrics-in-band fixture must carry the canonical 6-tick tap to read as a
 * correctly-measured hop. (`source` here is structural-only; these fixtures exercise
 * band/engine/status logic, not source ownership.)
 */
function canonicalShortHopProvenance() {
  return {
    sources: [
      {
        source: "runtime.probe",
        sampleCount: 30,
        captureFps: 120,
        measuredAt: "2026-06-13T00:00:00.000Z",
        projectFixedTimestepBeforeMeasurement: 0.016667,
        measurementFixedTimestep: 0.016667,
        measuredMetrics: ["shortHopApex"],
        stimulus: { metric: "shortHopApex", tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS, phases: "[jump 6t][jumpCut]" },
      },
    ],
  };
}

/**
 * F3 mechanism evidence satisfying precision's manifest (requires airDash +
 * variableJump). A small run with a clear dash spike past run speed, and a tap/hold
 * apex pair where the tap is cut well below the hold. Lets a band-focused fixture
 * stay GREEN now that precision claims mechanisms (a band-only precision run is
 * `incomplete` — the required mechanisms refuse without evidence).
 */
function precisionMechanismEvidence() {
  const dashRun: { tMs: number; x: number; y: number }[] = [];
  let x = 0;
  let prevT = 0;
  for (let t = 0; t <= 800; t += 50) {
    const dt = (t - prevT) / 1000;
    x += (t > 300 && t <= 400 ? 45 : 9) * dt; // dash burst 300–400ms
    dashRun.push({ tMs: t, x, y: 0 });
    prevT = t;
  }
  const apexArc = (apex: number): { tMs: number; x: number; y: number }[] => {
    const out: { tMs: number; x: number; y: number }[] = [];
    for (let t = 0; t <= 560; t += 20) out.push({ tMs: t, x: 0, y: apex * (1 - ((t - 280) / 280) ** 2) });
    return out;
  };
  return {
    airDash: { runTrajectory: dashRun, steadyRunSpeed: 9 },
    variableJump: { tapTrajectory: apexArc(1.1), holdTrajectory: apexArc(3.0), tapHoldMs: 50, fullHoldMs: 300 },
  };
}

/**
 * Wrap an all-at-target metrics map with the canonical shortHop stimulus AND
 * precision's required-mechanism evidence so it grades as a (green) pass.
 */
function allAtTargetDoc(allAtTarget: Record<string, number>) {
  return {
    metrics: allAtTarget,
    provenance: canonicalShortHopProvenance(),
    mechanismEvidence: precisionMechanismEvidence(),
  };
}

async function tmpRoot(unity = true): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-vp-"));
  if (unity) {
    await fs.mkdir(path.join(dir, "ProjectSettings"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.0f1\n",
      "utf-8",
    );
  }
  return dir;
}

function workspaceReportPath(workspace: string): string {
  return path.join(workspace, "feel", "reports", "feel-profile.json");
}

async function readReport(workspace: string): Promise<any> {
  const raw = await fs.readFile(workspaceReportPath(workspace), "utf-8");
  return JSON.parse(raw);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── standalone entry (no plan/build) ─────────────────────────────────────────

test("profile mode runs standalone with no ACCEPTANCE.json/SLICES.json", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const code = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace]);
  assert.equal(code, 0); // incomplete (no measurements), not strict
  const report = await readReport(workspace);
  assert.equal(report.kind, "feel-profile");
  assert.equal(report.profile.id, "precision");
  assert.equal(report.engine.engine, "unity");
  assert.equal(report.status, "incomplete");
  assert.ok(report.summary.notMeasured > 0);
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
});

test("profile report carries a producedBy build stamp (F5 #14 — audit provenance)", async () => {
  // The report must record which loombridge build graded it; absence is impossible
  // (build-stamp resolves "unknown"/"dev" with a reason rather than omitting fields).
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace]);
  const report = await readReport(workspace);
  assert.equal(report.producedBy.tool, "loombridge");
  assert.ok(report.producedBy.version.length > 0);
  assert.ok(report.producedBy.commit.length > 0);
  assert.ok(["stamped", "dev", "unknown"].includes(report.producedBy.stampStatus));
  // refusal discipline: a non-stamped build must explain WHY, never silently.
  if (report.producedBy.stampStatus !== "stamped") {
    assert.ok((report.producedBy.note ?? "").length > 0);
  }
});

test("non-mutation: profile mode writes report siblings, never contract/slices/state", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const reportPath = workspaceReportPath(workspace);
  await runVerifyProfile({ root, profile: "classic", strict: false, outputPath: reportPath });
  const dot = path.join(root, ".loombridge");
  assert.ok(await exists(reportPath));
  assert.ok(await exists(reportPath.replace(/\.json$/, ".html")));
  assert.ok(await exists(reportPath.replace(/\.json$/, ".md")));
  // None of the contract/state artifacts may be created by a verify-first run.
  assert.equal(await exists(path.join(dot, "ACCEPTANCE.json")), false);
  assert.equal(await exists(path.join(dot, "SLICES.json")), false);
  assert.equal(await exists(path.join(dot, "STATE.md")), false);
  assert.equal(await exists(path.join(dot, "reports", "build-verdict.json")), false);
  assert.equal(await exists(path.join(dot, "reports", "feel-profile.json")), false);
});

test("unknown --profile exits 2 and lists the shipped ids", async () => {
  const root = await tmpRoot();
  const code = await runVerifyCli(["--profile", "floaty", "--root", root]);
  assert.equal(code, 2);
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
});

test("--profile is mutually exclusive with --slice and --stage", async () => {
  const root = await tmpRoot();
  assert.equal(await runVerifyCli(["--profile", "precision", "--slice", "x", "--root", root]), 2);
  assert.equal(await runVerifyCli(["--profile", "precision", "--stage", "level", "--root", root]), 2);
});

// ── grading against bands ────────────────────────────────────────────────────

test("evaluateProfile: in-band passes, out-of-band fails, absent is not_measured", async () => {
  const precision = await loadProfile("precision"); // jumpApex 3u ±12% -> [2.64, 3.36]
  const { metrics, status, summary } = evaluateProfile(precision, {
    metrics: { jumpApex: 3.0, runSpeed: 100 }, // jumpApex in-band, runSpeed wildly out
  });
  const byId = Object.fromEntries(metrics.map((m) => [m.id, m]));
  assert.equal(byId.jumpApex.status, "pass");
  assert.equal(byId.runSpeed.status, "fail");
  assert.equal(byId.coyoteTime.status, "not_measured");
  assert.equal(byId.coyoteTime.measured, null);
  assert.equal(status, "fail"); // any fail wins
  assert.ok(summary.fail >= 1 && summary.pass >= 1 && summary.notMeasured >= 1);
});

test("status rule: all measured in-band -> pass; measured+unmeasured (no fail) -> incomplete", async () => {
  const precision = await loadProfile("precision");
  // Measure every metric exactly at target -> all pass -> overall pass.
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const all = evaluateProfile(precision, { metrics: allAtTarget });
  assert.equal(all.status, "pass");
  assert.equal(all.summary.notMeasured, 0);

  // Measure just one -> the rest unmeasured, none failing -> incomplete.
  const one = evaluateProfile(precision, { metrics: { jumpApex: 3.0 } });
  assert.equal(one.status, "incomplete");
});

test("fail status returns exit 1; incomplete returns 1 only under --strict", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const mPath = path.join(root, "m.json");

  // out-of-band -> fail -> exit 1 even without --strict
  await fs.writeFile(mPath, JSON.stringify({ metrics: { jumpApex: 9 } }), "utf-8");
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--measurements", mPath]), 1);

  // no measurements -> incomplete -> exit 0, but 1 under --strict
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace]), 0);
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--strict"]), 1);
});

test("live capture profile verdict maps incomplete evidence to exit 2, never shell-success", async () => {
  const root = await tmpRoot();
  const reportPath = path.join(root, "feel-profile.json");
  await fs.writeFile(reportPath, JSON.stringify({ status: "incomplete" }), "utf-8");
  assert.equal(await exitCodeForLiveProfileCapture({ reportPath, verifierCode: 0 }), 2);
  assert.equal(await exitCodeForLiveProfileCapture({ reportPath, verifierCode: 1 }), 2);

  await fs.writeFile(reportPath, JSON.stringify({ status: "fail" }), "utf-8");
  assert.equal(await exitCodeForLiveProfileCapture({ reportPath, verifierCode: 1 }), 1);
});

test("live capture orchestration failure exits 2 because it is harness/setup incomplete", async () => {
  const root = await tmpRoot();
  const contractPath = path.join(root, "capture-contract.json");
  await fs.writeFile(
    contractPath,
    JSON.stringify({
      schemaVersion: "1",
      subjects: [{ id: "game", locator: { path: "/" } }],
      interactions: [{ id: "legacy", kind: "unsupported", reason: "fixture" }],
      metrics: [{ metric: "runSpeed", interactionId: "legacy", derivation: "trajectory" }],
    }),
    "utf-8",
  );

  const code = await runVerifyCli([
    "--profile",
    "precision",
    "--root",
    root,
    "--capture-contract",
    contractPath,
    "--capture-only",
    "--project",
    "definitely-not-a-discovered-unity-editor",
  ]);
  assert.equal(code, 2);
});

test("--capture-contract and --measurements are mutually exclusive in profile mode", async () => {
  const root = await tmpRoot();
  assert.equal(
    await runVerifyCli([
      "--profile",
      "precision",
      "--root",
      root,
      "--capture-contract",
      path.join(root, "capture-contract.json"),
      "--measurements",
      path.join(root, "measurements.json"),
    ]),
    2,
  );
});

// ── measurements shapes ──────────────────────────────────────────────────────

test("parseMeasurements accepts nested {metrics} and flat feel.json shapes", () => {
  const nested = parseMeasurements({
    metrics: { runSpeed: 9.1 },
    provenance: { sources: [] },
    captureCoverage: [{ metric: "runSpeed", status: "measured" }],
  });
  assert.equal(nested.metrics.runSpeed, 9.1);
  assert.ok(nested.provenance);
  assert.equal(nested.captureCoverage?.[0].status, "measured");

  const flat = parseMeasurements({ runSpeed: 9.1, jumpApex: 3.0, provenance: { sources: [] } });
  assert.equal(flat.metrics.runSpeed, 9.1);
  assert.equal(flat.metrics.jumpApex, 3.0);
  // `provenance` is an object, not a number, so it is not picked up as a metric.
  assert.equal((flat.metrics as any).provenance, undefined);
});

test("unknown metric ids in measurements are ignored, not crashed", async () => {
  const precision = await loadProfile("precision");
  const { metrics } = evaluateProfile(precision, {
    metrics: { jumpApex: 3.0, totallyMadeUpMetric: 42 },
  });
  // Only profile metrics are graded; the bogus id never appears.
  assert.ok(!metrics.some((m) => m.id === "totallyMadeUpMetric"));
});

test("parseMeasurements throws on non-object input", () => {
  assert.throws(() => parseMeasurements(42 as unknown));
  assert.throws(() => parseMeasurements([1, 2] as unknown));
});

test("parseMeasurements throws when a present `metrics` key is not an object", () => {
  assert.throws(() => parseMeasurements({ metrics: 5 }), /metrics must be an object/);
});

test("a numeric `provenance` in the flat shape is NOT ingested as a metric", () => {
  const m = parseMeasurements({ runSpeed: 9, provenance: 3 });
  assert.equal(m.metrics.runSpeed, 9);
  assert.equal((m.metrics as any).provenance, undefined);
});

test("profile report carries generic capture coverage separately from metric grading", async () => {
  const root = await tmpRoot();
  const mPath = path.join(root, "measurements.json");
  await fs.writeFile(
    mPath,
    JSON.stringify({
      metrics: { jumpApex: 3.0 },
      captureCoverage: [
        { metric: "jumpApex", status: "measured", interactionId: "jump", source: "runtime.capture_pointer_motion" },
        { metric: "runSpeed", status: "unsupported", reason: "legacy Input.GetKey without UI" },
      ],
    }),
    "utf-8",
  );
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: mPath,
    strict: false,
  });
  assert.equal(report.captureCoverage.length, 2);
  assert.equal(report.captureCoverage[1].status, "unsupported");
  assert.equal(report.status, "incomplete", "coverage does not fake complete measured profile evidence");
});

test("coverage refusing a banded metric prevents an otherwise all-in-band pass", async () => {
  const root = await tmpRoot();
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(root, "measurements.json");
  await fs.writeFile(
    mPath,
    JSON.stringify({
      ...allAtTargetDoc(allAtTarget),
      captureCoverage: [
        { metric: "runSpeed", status: "unsupported", reason: "legacy Input.GetKey without UI" },
      ],
    }),
    "utf-8",
  );

  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: mPath,
    strict: false,
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.metrics.find((m) => m.id === "runSpeed")?.status, "not_measured");
  assert.equal(report.captureCoverage[0].status, "unsupported");
});

test("--setup-capture previews by default and writes a generic capture contract with --apply", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const out = path.join(workspace, "feel", "capture-contract.json");
  const dryRunCode = await runVerifyCli([
    "--profile", "precision",
    "--root", root,
    "--workspace", workspace,
    "--setup-capture",
    "--player", "/Player",
    "--scene", "Scene_1",
    "--jump-button", "/Controls/Jump",
    "--joystick", "/Controls/Stick",
  ]);
  assert.equal(dryRunCode, 0);
  assert.equal(await exists(out), false);

  const code = await runVerifyCli([
    "--profile", "precision",
    "--root", root,
    "--workspace", workspace,
    "--setup-capture",
    "--apply",
    "--player", "/Player",
    "--scene", "Scene_1",
    "--jump-button", "/Controls/Jump",
    "--joystick", "/Controls/Stick",
  ]);
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(out, "utf-8"));
  assert.equal(contract.schemaVersion, "1");
  assert.equal(contract.interactions.find((i: any) => i.id === "jump-tap").kind, "ugui-tap");
  assert.equal(contract.interactions.find((i: any) => i.id === "run-joystick").kind, "ugui-hold-drag");
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
  assert.equal(await exists(path.join(root, ".loombridge", "feel", "capture-contract.json")), false);
});

test("--setup-capture --id defaults to ~/.loombridge/projects/<id>/feel/capture-contract.json", async () => {
  const root = await tmpRoot();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-vp-home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await runVerifyCli([
      "--profile", "precision",
      "--root", root,
      "--id", "external-game",
      "--setup-capture",
      "--apply",
      "--player", "/Player",
      "--jump-key", "Space",
    ]);
    assert.equal(code, 0);
    assert.ok(await exists(path.join(home, ".loombridge", "projects", "external-game", "feel", "capture-contract.json")));
    assert.equal(await exists(path.join(root, ".loombridge", "feel", "capture-contract.json")), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("profile report defaults to the external workspace feel/reports layout", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ext`; // external workspace (a sibling, never inside the project)
  const code = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace]);
  assert.equal(code, 0);
  assert.ok(await exists(workspaceReportPath(workspace)));
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
});

// ── shared external-workspace standardization (matches the mini-game flow) ────

test("profile mode REFUSES a --workspace inside the project (keep the repo clean)", async () => {
  const root = await tmpRoot();
  const inside = path.join(root, "feel-out"); // inside the project — must be refused
  const code = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", inside]);
  assert.equal(code, 2);
  assert.equal(await exists(path.join(inside, "feel", "reports", "feel-profile.json")), false);
});

test("profile mode REFUSES an underivable workspace id instead of silently inventing one", async () => {
  // A project folder whose basename can't kebab into a valid id (starts with a digit).
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-vp-"));
  const root = path.join(parent, "123");
  await fs.mkdir(root, { recursive: true });
  const code = await runVerifyCli(["--profile", "precision", "--root", root]);
  assert.equal(code, 2); // asks for --id; never falls back to ~/.loombridge/projects/project
});

test("profile mode accepts the same id shape as the mini-game flow", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`;
  // `my--game` is a valid mini-game contract id; the feel flow must accept it too
  // (one shared WORKSPACE_ID_PATTERN — no cross-flow divergence). --workspace wins
  // over --id for the location, so this asserts the id passes validation.
  const ok = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--id", "my--game"]);
  assert.equal(ok, 0);
  // A truly invalid id (leading digit) is still refused.
  const bad = await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--id", "1bad"]);
  assert.equal(bad, 2);
});

test("--setup-capture writes keyboard dash recipe when --dash-key is declared", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const out = path.join(workspace, "feel", "capture-contract.json");
  const code = await runVerifyCli([
    "--profile", "precision",
    "--root", root,
    "--workspace", workspace,
    "--setup-capture",
    "--apply",
    "--player", "/Player",
    "--move-right-key", "D",
    "--dash-key", "LeftShift",
  ]);
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(out, "utf-8"));
  const dash = contract.interactions.find((i: any) => i.id === "dash-key");
  assert.equal(dash.kind, "keyboard");
  assert.deepEqual(dash.phases[2].keys, ["D", "LeftShift"]);
  const metric = contract.metrics.find((m: any) => m.metric === "dashDistance");
  assert.equal(metric.interactionId, "dash-key");
  assert.equal(metric.derivation, "phase-delta");
  assert.equal(metric.phaseIndex, 2);
  assert.deepEqual(metric.requiredKeys, ["D", "LeftShift"]);
});

test("--setup-capture includes reviewed semantic probe JSON for coyote-time", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`;
  const out = path.join(workspace, "feel", "capture-contract.json");
  const probePath = path.join(root, "coyote-probe.json");
  await fs.writeFile(probePath, JSON.stringify({
    id: "coyote-semantic",
    kind: "semantic-probe",
    metric: "coyoteTime",
    measure: { path: "/Player" },
    anchors: [
      { id: "leave", kind: "ground-lost", phaseIndex: 0 },
      { id: "jump", kind: "jump-input", phaseIndex: 1 },
    ],
    trials: [
      {
        delayMs: 80,
        phases: [
          { durationMs: 80, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: false }] },
          { durationMs: 400, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: true }] },
        ],
      },
      {
        delayMs: 140,
        phases: [
          { durationMs: 140, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: false }] },
          { durationMs: 400, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: true }] },
        ],
      },
    ],
    jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "jump", minRise: 0.05 },
  }), "utf-8");

  const code = await runVerifyCli([
    "--profile", "precision",
    "--root", root,
    "--workspace", workspace,
    "--setup-capture",
    "--apply",
    "--player", "/Player",
    "--jump-key", "Space",
    "--coyote-probe", probePath,
  ]);

  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(out, "utf-8"));
  assert.equal(contract.interactions.find((i: any) => i.id === "coyote-semantic").kind, "semantic-probe");
  const coyote = contract.metrics.find((m: any) => m.metric === "coyoteTime");
  assert.equal(coyote.derivation, "bisection");
  assert.equal(coyote.interactionId, "coyote-semantic");
  assert.equal(contract.metrics.find((m: any) => m.metric === "jumpBuffer").derivation, "unsupported");
});

// ── anti-false-green: empty-metrics profile is refused (API boundary) ─────────

test("evaluateProfile REFUSES a metric-less profile (no green from nothing)", () => {
  const empty = { schemaVersion: "1", id: "x", title: "X", summary: "x", metrics: {} } as any;
  assert.throws(() => evaluateProfile(empty, { metrics: {} }), /no metrics/);
});

// ── engine-null never reports a clean pass ───────────────────────────────────

test("non-Unity root never reports a green pass, even with all metrics in band", async () => {
  const root = await tmpRoot(false); // no ProjectVersion.txt
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(root, "m.json");
  await fs.writeFile(mPath, JSON.stringify(allAtTargetDoc(allAtTarget)), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  // metrics all pass, but engine is undetected -> downgraded to incomplete, not pass.
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.notMeasured, 0);
  assert.equal(report.status, "incomplete");
});

// ── parsing footguns ─────────────────────────────────────────────────────────

test("an unknown verify argument is a usage error (exit 2), not a silent success", async () => {
  const root = await tmpRoot();
  assert.equal(await runVerifyCli(["--profile", "precision", "--bogus", "--root", root]), 2);
  // value-flag that swallows the next flag leaves an unknown positional -> exit 2
  assert.equal(
    await runVerifyCli(["--profile", "precision", "--measurements", "--root", root]),
    2,
  );
});

test("a malformed --measurements file exits 1 (fatal), not 0", async () => {
  const root = await tmpRoot();
  const workspace = `${root}-ws`; // external workspace (a sibling, never inside the project)
  const mPath = path.join(root, "bad.json");
  await fs.writeFile(mPath, "{ not json", "utf-8");
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--workspace", workspace, "--measurements", mPath]), 1);
});

test("a DETECTED non-Unity engine (godot) never reports a green pass, even all-in-band", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-vp-godot-"));
  await fs.writeFile(path.join(dir, "project.godot"), "[application]\n", "utf-8");
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(dir, "m.json");
  await fs.writeFile(mPath, JSON.stringify(allAtTargetDoc(allAtTarget)), "utf-8");
  const report = await buildProfileReport({ root: dir, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.engine.engine, "godot");
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.notMeasured, 0); // every metric measured + in band
  assert.equal(report.status, "incomplete"); // but downgraded — S5 is a Unity wedge, never green off-Unity
});

test("a Unity root with the same all-in-band measurements DOES pass (sanity)", async () => {
  const root = await tmpRoot(true);
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(root, "m.json");
  await fs.writeFile(mPath, JSON.stringify(allAtTargetDoc(allAtTarget)), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.status, "pass");
});

test("profile mode REFUSES contract-scoped flags (--inputs/--acceptance/--vlm) with exit 2", async () => {
  const root = await tmpRoot();
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--inputs", "x"]), 2);
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--acceptance", "x"]), 2);
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--vlm", "x"]), 2);
  // none of the refused invocations wrote a report
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "feel-profile.json")), false);
});

test("profile mode honors an explicit --output path (not the contract build-verdict.json default)", async () => {
  const root = await tmpRoot();
  const out = path.join(root, "custom-report.json");
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--output", out]), 0);
  assert.ok(await exists(out));
  assert.ok(await exists(path.join(root, "custom-report.html")));
  assert.ok(await exists(path.join(root, "custom-report.md")));
  // the contract-mode default verdict must NOT be written by profile mode
  assert.equal(await exists(path.join(root, ".loombridge", "reports", "build-verdict.json")), false);
});

test("profile mode explicit --output .html/.md never overwrites the JSON audit record", async () => {
  const root = await tmpRoot();
  const htmlNamedJson = path.join(root, "custom-report.html");
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--output", htmlNamedJson]), 0);
  const parsed = JSON.parse(await fs.readFile(htmlNamedJson, "utf-8"));
  assert.equal(parsed.kind, "feel-profile");
  assert.match(await fs.readFile(`${htmlNamedJson}.html`, "utf-8"), /^<!doctype html>/);
  assert.match(await fs.readFile(`${htmlNamedJson}.md`, "utf-8"), /^# Precision Platformer - Feel report:/);

  const mdNamedJson = path.join(root, "custom-report.md");
  assert.equal(await runVerifyCli(["--profile", "precision", "--root", root, "--output", mdNamedJson]), 0);
  const parsedMd = JSON.parse(await fs.readFile(mdNamedJson, "utf-8"));
  assert.equal(parsedMd.kind, "feel-profile");
  assert.match(await fs.readFile(`${mdNamedJson}.html`, "utf-8"), /^<!doctype html>/);
  assert.match(await fs.readFile(`${mdNamedJson}.md`, "utf-8"), /^# Precision Platformer - Feel report:/);
});

// ── engine detection ─────────────────────────────────────────────────────────

test("non-Unity root reports engine=null with a reason but still produces a report", async () => {
  const root = await tmpRoot(false); // no ProjectVersion.txt
  const report = await buildProfileReport({ root, profile: "momentum", strict: false });
  assert.equal(report.engine.engine, null);
  assert.ok(report.engine.reason && report.engine.reason.length > 0);
  assert.equal(report.profile.id, "momentum");
  assert.match(report.nextAction, /project root/i);
});

// ── S5d: confidence-aware report UX ──────────────────────────────────────────
//
// Driven by the REAL S5c-b live-capture artifacts so the report's confidence axis
// is regression-locked to the live proof, not a synthetic fixture.

const LIVE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "Docs",
  "Profiles",
  "artifacts",
  "s5cb-live-capture",
);

test("S5d: live capture grades as an honest band-fail with every metric VERIFIED", async () => {
  const root = await tmpRoot(true);
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: path.join(LIVE_DIR, "feel.json"),
    strict: false,
  });

  // A generic controller is not a precision platformer → honest band fail.
  assert.equal(report.status, "fail");

  // The three measured metrics re-derive from their own raw samples → verified.
  const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]));
  for (const id of ["runSpeed", "jumpApex", "timeToApex"]) {
    assert.equal(byId[id].confidence, "verified", `${id} should be verified`);
    assert.equal(byId[id].status, "fail", `${id} is out of the precision band`);
  }
  // Every re-derivation verdict passed (nothing rejected).
  assert.ok(report.rederivation.length >= 3);
  assert.ok(report.rederivation.every((v: any) => v.status === "pass"));
  assert.equal(report.confidence.rejected, 0);
  assert.ok(report.confidence.verified >= 3);

  // Unmeasured profile metrics carry the unmeasured confidence (not green-by-omission).
  assert.ok(report.confidence.unmeasured > 0);
  assert.ok(report.metrics.some((m) => m.confidence === "unmeasured" && m.status === "not_measured"));

  // Headline names the failure honestly; next action points at the out-of-band metrics.
  // All 3 fail on the band (none rejected), so the headline says "outside band", not "rejected".
  assert.match(report.headline, /3 outside band/i);
  assert.doesNotMatch(report.headline, /rejected/i);
  assert.match(report.nextAction, /runSpeed|jumpApex|timeToApex/);
});

test("S5d: tampered jumpApex (samples unchanged) is REJECTED, others stay verified", async () => {
  const root = await tmpRoot(true);
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: path.join(LIVE_DIR, "feel-tampered.json"),
    strict: false,
  });

  const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]));
  // jumpApex was hand-set to 3.0 (on the band) but its samples re-derive to 0.8.
  assert.equal(byId.jumpApex.confidence, "rejected");
  assert.equal(byId.jumpApex.status, "fail");
  assert.match(byId.jumpApex.detail, /rejected/i);
  // Surgical: the untampered metrics are still verified.
  assert.equal(byId.runSpeed.confidence, "verified");
  assert.equal(byId.timeToApex.confidence, "verified");
  assert.equal(report.confidence.rejected, 1);
  assert.equal(report.status, "fail");
  // The next action calls out the rejection explicitly.
  assert.match(report.nextAction, /re-derivation|reject/i);
  // Headline must NOT lump the in-band-but-rejected jumpApex under "outside band":
  // 3 failed = 2 outside band (runSpeed, timeToApex) + 1 rejected (jumpApex, which is on the band).
  assert.match(report.headline, /2 outside band/i);
  assert.match(report.headline, /1 rejected by re-derivation/i);
});

test("S5d: an in-band number with NO re-derivable capture is `reported`, not `verified`", async () => {
  const root = await tmpRoot(true);
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(root, "typed.json");
  // Plain numbers, no provenance/trajectory → graded, but unverifiable.
  await fs.writeFile(mPath, JSON.stringify(allAtTargetDoc(allAtTarget)), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });

  assert.equal(report.status, "pass"); // grading unchanged: in band is a pass
  assert.equal(report.confidence.verified, 0);
  assert.ok(report.confidence.reported > 0);
  assert.ok(report.metrics.every((m) => m.confidence === "reported"));
  // A typed-number pass must NOT read as a measured one.
  assert.match(report.headline, /reported without/i);
  assert.match(report.nextAction, /capture/i);
});

test("S5d: generic feel-capture provenance re-derives as verified", async () => {
  const root = await tmpRoot(true);
  const mPath = path.join(root, "generic-capture.json");
  await fs.writeFile(
    mPath,
    JSON.stringify({
      metrics: { runSpeed: 14 },
      provenance: {
        note: "Generated by Loombridge generic feel capture runner.",
        sources: [
          {
            source: "runtime.capture_pointer_hold_motion",
            interactionId: "run",
            status: "measured",
            sampleCount: 3,
            measuredMetrics: ["runSpeed"],
            derivation: "trajectory",
            samples: [
              { tMs: 0, x: 0, y: 0 },
              { tMs: 500, x: 7, y: 0 },
              { tMs: 1000, x: 14, y: 0 },
            ],
          },
        ],
      },
    }),
    "utf-8",
  );

  const report = await buildProfileReport({ root, profile: "momentum", measurementsPath: mPath, strict: false });
  const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]));
  assert.equal(byId.runSpeed.confidence, "verified");
  assert.equal(byId.runSpeed.status, "pass");
  assert.ok(report.rederivation.some((v: any) => v.metric === "runSpeed" && v.status === "pass"));
  assert.equal(report.confidence.reported, 0);
});

test("S5d: generic phase-delta dashDistance provenance re-derives as verified", async () => {
  const root = await tmpRoot(true);
  const mPath = path.join(root, "phase-delta-dash.json");
  await fs.writeFile(
    mPath,
    JSON.stringify({
      metrics: { dashDistance: 4 },
      provenance: {
        note: "Generated by Loombridge generic feel capture runner.",
        sources: [
          {
            source: "runtime.capture_input_motion",
            interactionId: "dash-key",
            status: "measured",
            sampleCount: 4,
            captureFps: 60,
            measuredAt: "2026-06-18T00:00:00.000Z",
            projectFixedTimestepBeforeMeasurement: 0.016667,
            measurementFixedTimestep: 0.016667,
            measuredMetrics: ["dashDistance"],
            derivation: "phase-delta",
            phases: [
              { index: 0, deltaX: 0 },
              { index: 1, keys: ["D", "LeftShift"], deltaX: 4 },
            ],
            phaseIndex: 1,
            axis: "x",
            phaseKeys: ["D", "LeftShift"],
            requiredKeys: ["D", "LeftShift"],
          },
        ],
      },
    }),
    "utf-8",
  );

  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]));
  assert.equal(byId.dashDistance.confidence, "verified");
  assert.equal(byId.dashDistance.status, "pass");
  assert.ok(report.rederivation.some((v: any) => v.metric === "dashDistance" && v.status === "pass"));
});

test("S5d: confidence counts are additive and never change pass/fail status", async () => {
  // verified + reported + rejected + unmeasured == total, and only band/§0 drive status.
  const root = await tmpRoot(true);
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: path.join(LIVE_DIR, "feel.json"),
    strict: false,
  });
  const c = report.confidence;
  assert.equal(c.verified + c.reported + c.rejected + c.unmeasured, report.summary.total);
  // status is still derived purely from band/§0: fails present → fail.
  assert.equal(report.status, report.summary.fail > 0 ? "fail" : report.status);
});

// ── F3: a scratch (non-Unity) --root must not bury a valid feel verdict ───────
//
// verify-first is run with --root <scratch> so reports never touch the partner
// project; that root isn't a Unity root. Band grading + §0 re-derivation are
// engine-independent, so a graded run must LEAD with the feel verdict and only
// append the engine note as a caveat — never the old "nothing graded" headline.

test("F3: graded band-fail on a non-Unity root leads with the verdict, not 'nothing graded'", async () => {
  const root = await tmpRoot(false); // scratch root: engine not detected
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: path.join(LIVE_DIR, "feel.json"),
    strict: false,
  });

  // Grading is engine-independent: the band fail still stands.
  assert.equal(report.engine.engine, null);
  assert.equal(report.status, "fail");

  // Headline LEADS with the feel verdict; it is NOT the old "nothing graded" line.
  assert.match(report.headline, /outside band/i);
  assert.doesNotMatch(report.headline, /nothing graded/i);
  // …and still carries the engine caveat so the user knows it isn't a Unity root.
  assert.match(report.headline, /not confirmed as Unity|engine-independent/i);

  // Next action is metric-driven (names the offenders) with the engine note appended.
  assert.match(report.nextAction, /runSpeed|jumpApex|timeToApex|outside/i);
  assert.match(report.nextAction, /Unity project root/i);
});

test("F3: a clean pass on a non-Unity root says 'can't certify a pass', not 'nothing graded'", async () => {
  const root = await tmpRoot(false); // scratch root
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = path.join(root, "typed.json");
  await fs.writeFile(mPath, JSON.stringify(allAtTargetDoc(allAtTarget)), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });

  // The engine gate still refuses to certify green on an unconfirmed project…
  assert.equal(report.engine.engine, null);
  assert.equal(report.status, "incomplete"); // pass downgraded by the engine gate
  // …but the headline/nextAction acknowledge the metrics DID grade in-band.
  assert.match(report.headline, /in band/i);
  assert.match(report.headline, /can't certify a pass/i);
  assert.doesNotMatch(report.headline, /nothing graded/i);
  assert.match(report.nextAction, /verified pass/i);
  assert.match(report.nextAction, /Unity project root/i);
});

test("F3: a partial (some-unmeasured) graded run on a non-Unity root keeps the caveat, not 'nothing graded'", async () => {
  const root = await tmpRoot(false);
  const precision = await loadProfile("precision");
  const mPath = path.join(root, "partial.json");
  // One metric in-band, the rest absent → genuinely incomplete (not an engine downgrade).
  await fs.writeFile(
    mPath,
    JSON.stringify({ metrics: { runSpeed: (precision.metrics as any).runSpeed.target } }),
    "utf-8",
  );
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });

  assert.equal(report.engine.engine, null);
  assert.equal(report.status, "incomplete");
  assert.match(report.headline, /in band/i);
  assert.match(report.headline, /still unmeasured/i);
  assert.doesNotMatch(report.headline, /nothing graded/i);
  assert.match(report.headline, /not confirmed as Unity|engine-independent/i);
});

test("F3: a graded fail on a UNITY root carries NO engine caveat (suffix is non-Unity-only)", async () => {
  const root = await tmpRoot(true); // confirmed Unity root
  const report = await buildProfileReport({
    root,
    profile: "precision",
    measurementsPath: path.join(LIVE_DIR, "feel.json"),
    strict: false,
  });
  assert.equal(report.engine.engine, "unity");
  assert.equal(report.status, "fail");
  assert.doesNotMatch(report.headline, /not confirmed as Unity|engine-independent/i);
  assert.doesNotMatch(report.nextAction, /Also run from your Unity project root/i);
});

// ── F5: inputLatency surfaced as "also measured (unbanded)", never gating ────

// An honest, re-derivable inputLatency capture source (settle then move) so the
// report can read it as a `verified` unbanded metric. inputOnsetMs at 100ms; motion
// starts ~50ms later → ~50ms latency, re-derivable from these samples + onset.
function inputLatencyProvenance(reportedLatency = 50) {
  const samples: { tMs: number; x: number; y: number }[] = [];
  const motionStart = 150;
  for (let t = 0; t <= 400; t += 10) samples.push({ tMs: t, x: t > motionStart ? (9 * (t - motionStart)) / 1000 : 0, y: 0 });
  return {
    sources: [
      ...canonicalShortHopProvenance().sources,
      {
        source: "runtime.capture_input_motion",
        derivation: "trajectory" as const,
        samples,
        inputOnsetMs: 100,
        sampleCount: samples.length,
        captureFps: 60,
        measuredAt: "2026-06-13T00:00:00.000Z",
        projectFixedTimestepBeforeMeasurement: 0.016667,
        measurementFixedTimestep: 0.016667,
        measuredMetrics: ["inputLatency"],
      },
    ],
  };
}

test("F5: a measured inputLatency appears under alsoMeasured, NOT in the graded metrics, and never gates", async () => {
  const root = await tmpRoot();
  const mPath = path.join(root, "m.json");
  const precision = await loadProfile("precision");
  // Every banded metric exactly at target → an otherwise clean pass.
  const allAtTarget = Object.fromEntries(Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]));
  const doc = {
    metrics: { ...allAtTarget, inputLatency: 60 }, // unbanded by precision
    provenance: inputLatencyProvenance(),
    mechanismEvidence: precisionMechanismEvidence(), // satisfy precision's mechanism manifest
  };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });

  // No profile bands inputLatency → it must not be in the graded list.
  assert.ok(!report.metrics.some((m: any) => m.id === "inputLatency"));
  // It IS surfaced informationally.
  const il = report.alsoMeasured.find((m: any) => m.id === "inputLatency");
  assert.ok(il, "inputLatency must appear under alsoMeasured");
  assert.equal(il.unit, "ms");
  assert.equal(il.measured, 60);
  assert.ok(il.whyItMatters && il.whyItMatters.length > 0);
  // Status is UNAFFECTED: the banded metrics all passed → still a pass.
  assert.equal(report.status, "pass");
  // The summary counts only graded metrics (alsoMeasured never enters it).
  assert.equal(report.summary.total, Object.keys(precision.metrics).length);
  assert.equal(report.summary.fail, 0);
});

test("F5: a present-but-incomplete profile with a measured inputLatency stays incomplete (latency never flips it)", async () => {
  const root = await tmpRoot();
  const mPath = path.join(root, "m.json");
  const precision = await loadProfile("precision");
  // Measure just ONE banded metric (rest unmeasured) → incomplete; add inputLatency.
  const doc = {
    metrics: { jumpApex: (precision.metrics.jumpApex as any).target, inputLatency: 42 },
    provenance: inputLatencyProvenance(),
  };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.status, "incomplete"); // unchanged by the unbanded inputLatency
  assert.ok(report.alsoMeasured.some((m: any) => m.id === "inputLatency" && m.measured === 42));
});

test("F5: an inputLatency rejected by §0 (tampered) reads as rejected under alsoMeasured but still never gates a pass", async () => {
  const root = await tmpRoot();
  const mPath = path.join(root, "m.json");
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]));
  // Tamper: claim a 3ms latency while the samples+onset re-derive ~50ms → §0 rejects.
  const doc = { metrics: { ...allAtTarget, inputLatency: 3 }, provenance: inputLatencyProvenance(), mechanismEvidence: precisionMechanismEvidence() };
  await fs.writeFile(mPath, JSON.stringify(doc), "utf-8");
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  const il = report.alsoMeasured.find((m: any) => m.id === "inputLatency");
  assert.ok(il && il.confidence === "rejected");
  // The unbanded rejection must NOT gate: the banded metrics all passed → still pass.
  assert.equal(report.status, "pass");
});

// ── F3: mechanism-presence gate wired into the report/status ─────────────────

/** A run that bursts well past `runSpeed` mid-window (an air dash). */
function dashRun(runSpeed = 9, dashSpeed = 45, durMs = 800, stepMs = 50) {
  const out: { tMs: number; x: number; y: number }[] = [];
  let x = 0;
  let prevT = 0;
  for (let t = 0; t <= durMs; t += stepMs) {
    const dt = (t - prevT) / 1000;
    x += (t > 300 && t <= 400 ? dashSpeed : runSpeed) * dt;
    out.push({ tMs: t, x, y: 0 });
    prevT = t;
  }
  return out;
}
/** A parabolic jump arc peaking at `apex`u. */
function arc(apex = 3.0, apexMs = 280, endMs = 560, stepMs = 20) {
  const out: { tMs: number; x: number; y: number }[] = [];
  for (let t = 0; t <= endMs; t += stepMs) out.push({ tMs: t, x: 0, y: apex * (1 - ((t - apexMs) / apexMs) ** 2) });
  return out;
}

async function writeMeasurements(root: string, doc: unknown): Promise<string> {
  const p = path.join(root, "m.json");
  await fs.writeFile(p, JSON.stringify(doc), "utf-8");
  return p;
}

test("F3: classic with a LIVE air-dash → status fail (the F1 #166 hole is now caught)", async () => {
  const root = await tmpRoot(true);
  const classic = await loadProfile("classic");
  const allAtTarget = Object.fromEntries(
    Object.entries(classic.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = await writeMeasurements(root, {
    metrics: allAtTarget,
    provenance: canonicalShortHopProvenance(),
    mechanismEvidence: {
      // forbids airDash → a live dash MUST fail
      airDash: { runTrajectory: dashRun(7, 45), steadyRunSpeed: 7 },
      // requires variableJump → a real cut, so only the dash fails
      variableJump: { tapTrajectory: arc(1.4), holdTrajectory: arc(3.8), tapHoldMs: 50, fullHoldMs: 300 },
    },
  });
  const report = await buildProfileReport({ root, profile: "classic", measurementsPath: mPath, strict: false });
  assert.equal(report.mechanisms.status, "fail");
  assert.equal(report.status, "fail", "a forbidden mechanism present must gate the verdict to fail");
  const dashCheck = report.mechanisms.checks.find((c) => c.id === "airDash");
  assert.equal(dashCheck?.result, "present");
  assert.equal(dashCheck?.ok, false);
});

test("F3: precision with airDash + variableJump both present → mechanisms pass", async () => {
  const root = await tmpRoot(true);
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  const mPath = await writeMeasurements(root, {
    metrics: allAtTarget,
    provenance: canonicalShortHopProvenance(),
    mechanismEvidence: {
      airDash: { runTrajectory: dashRun(9, 45), steadyRunSpeed: 9 },
      variableJump: { tapTrajectory: arc(1.1), holdTrajectory: arc(3.0), tapHoldMs: 50, fullHoldMs: 300 },
    },
  });
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.mechanisms.status, "pass");
  // metrics all in band + mechanisms pass + Unity → overall pass.
  assert.equal(report.status, "pass");
});

test("F3: a claimed mechanism with NO evidence REFUSES → status never green (incomplete, not skipped)", async () => {
  const root = await tmpRoot(true);
  const precision = await loadProfile("precision");
  const allAtTarget = Object.fromEntries(
    Object.entries(precision.metrics).map(([id, t]) => [id, (t as any).target]),
  );
  // No mechanismEvidence at all → precision requires airDash+variableJump → both refuse.
  const mPath = await writeMeasurements(root, {
    metrics: allAtTarget,
    provenance: canonicalShortHopProvenance(),
  });
  const report = await buildProfileReport({ root, profile: "precision", measurementsPath: mPath, strict: false });
  assert.equal(report.mechanisms.status, "refused");
  assert.equal(report.status, "incomplete", "an unprobed required mechanism cannot read green");
  assert.ok(report.mechanisms.checks.every((c) => c.result === "unprobed"));
});

test("F3: momentum (empty mechanisms) is not_applicable and does not gate", async () => {
  const root = await tmpRoot(true);
  const report = await buildProfileReport({ root, profile: "momentum", strict: false });
  // momentum claims no mechanism → the gate makes no checks and never gates.
  assert.equal(report.mechanisms.status, "pass");
  assert.equal(report.mechanisms.checks.length, 0);
});
