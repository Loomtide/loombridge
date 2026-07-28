/**
 * Verification-asset discovery: the plan an operator reads before anything runs.
 *
 * The property under test throughout is A4: absent provenance NEVER skips into pass.
 * A recorded-but-unapproved trace, an unstamped legacy baseline, a snapshot approved
 * for another project. Each has to surface as a visible row that cannot execute,
 * rather than as silence. Silence is what makes a green meaningless.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import {
  ASSET_KINDS,
  discoverVerificationAssets,
  type DiscoveredAsset,
} from "../../../../capabilities/verification/unified/discovery.js";
import {
  notRunFor,
  resolveUnifiedOutcome,
} from "../../../../capabilities/verification/unified/report.js";
import { feelPaths } from "../../../../capabilities/feel/feel-workspace.js";
import { loadMeasurements } from "../../../../capabilities/feel/measurements.js";
import {
  DEFAULT_SNAPSHOT_TOLERANCES,
  FEEL_SNAPSHOT_MANIFEST,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
  rederiveView,
  writeSnapshotBundle,
  type FeelSnapshotManifest,
} from "../../../../capabilities/feel/snapshot-manifest.js";
import { BASELINE_MANIFEST } from "../../../../capabilities/minigame/minigame-baseline.js";
import { loombridgePaths, standardReplayLayout } from "../../../../domain/state.js";
import { REPO_ROOT } from "../../../_support/paths.js";

/** The REAL live-capture artifacts the feel-snapshot tests use (re-derives cleanly). */
const LIVE_DIR = path.join(REPO_ROOT, "Docs", "Profiles", "artifacts", "s5cb-live-capture");

const CONTRACT_FIXTURE = {
  schemaVersion: "1",
  game: "fixture-game",
  subjects: [{ id: "player", locator: { path: "/Player" } }],
  interactions: [{ id: "jump", kind: "key-tap", key: "space" }],
  metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
};

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function rowFor(assets: DiscoveredAsset[], kind: DiscoveredAsset["kind"], id?: string): DiscoveredAsset {
  const row = assets.find((a) => a.kind === kind && (id === undefined || a.id === id));
  assert.ok(row, `expected a ${kind}${id ? ` row '${id}'` : ""} row in ${JSON.stringify(assets.map((a) => [a.kind, a.id]))}`);
  return row;
}

// ── trace fixtures ───────────────────────────────────────────────────────────

/** Plant `<traces>/<id>.trace.json` (a recorded demonstration). */
async function plantTrace(root: string, id: string): Promise<void> {
  const layout = standardReplayLayout(root);
  await fs.mkdir(layout.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(layout.replayTraces, `${id}.trace.json`),
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "s", actions: [] }],
      outcome: { expected: "success" },
    }),
  );
}

/** Plant a trace + a replay report, then approve it for real (the verb writes the manifest). */
async function plantApprovedTrace(root: string, id: string): Promise<void> {
  const layout = standardReplayLayout(root);
  await plantTrace(root, id);
  const actualDir = path.join(layout.replayReports, id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actualPng = path.join(actualDir, "cap.png");
  await fs.writeFile(actualPng, Buffer.from(`frame-${id}`));
  await fs.writeFile(
    path.join(layout.replayReports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
  assert.equal(await runTrace(["approve", "--id", id, "--root", root]), 0, `approve ${id}`);
}

// ── feel snapshot fixtures ───────────────────────────────────────────────────

/** Freeze a REAL snapshot bundle into the workspace, optionally with the ownership stamp. */
async function plantSnapshot(workspace: string, projectRoot: string | undefined): Promise<string> {
  const staging = await tmpDir("unified-snapshot-candidate-");
  const candidate = path.join(staging, "candidate");
  await fs.mkdir(candidate, { recursive: true });
  await fs.copyFile(path.join(LIVE_DIR, "feel.json"), path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  await fs.writeFile(path.join(candidate, SNAPSHOT_CONTRACT_FILE), JSON.stringify(CONTRACT_FIXTURE, null, 2), "utf-8");

  const measurements = await loadMeasurements(path.join(candidate, SNAPSHOT_MEASUREMENTS_FILE));
  const view = rederiveView(measurements);
  const metrics: FeelSnapshotManifest["metrics"] = {};
  for (const [id, value] of Object.entries(measurements.metrics)) {
    metrics[id] = { value, derivation: "trajectory", confidence: view.verified.has(id) ? "verified" : "reported" };
  }
  const currentDir = feelPaths(workspace).snapshotCurrentDir;
  await writeSnapshotBundle({
    candidateDir: candidate,
    currentDir,
    engine: { engine: "unity" },
    capturedAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
    note: "feels right",
    tolerancePolicy: DEFAULT_SNAPSHOT_TOLERANCES,
    metrics,
    rederivation: { pass: view.pass, total: view.total },
    game: "fixture-game",
    projectRoot,
    contractStats: { interactions: 1, metrics: 1 },
  });
  await fs.rm(staging, { recursive: true, force: true });
  return currentDir;
}

// ── screen contract fixtures ─────────────────────────────────────────────────

async function plantScreenContract(
  workspace: string,
  opts: { id: string; draft?: boolean; baseline?: "none" | "unstamped" | { projectRoot: string } | "malformed" },
): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  const description = opts.draft ? "DRAFT: scaffolded by scan" : "Finalized from captures.";
  await fs.writeFile(
    path.join(workspace, `${opts.id}.minigame.json`),
    JSON.stringify({ id: opts.id, description, states: [{ id: "active", kind: "active", description: "active screen." }] }, null, 2),
    "utf-8",
  );
  const baseline = opts.baseline ?? "none";
  if (baseline === "none") return;
  const dir = path.join(workspace, "baseline");
  await fs.mkdir(dir, { recursive: true });
  if (baseline === "malformed") {
    await fs.writeFile(path.join(dir, BASELINE_MANIFEST), "{ not json", "utf-8");
    return;
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: "1",
    kind: "minigame-baseline",
    contractId: opts.id,
    capturedAt: "2026-07-28T00:00:00.000Z",
    masks: [],
    approvedStatus: "pass",
    approvedSummary: { pass: 1, warn: 0, fail: 0, notApplicable: 0 },
    states: [{ id: "active", pngSha256: "a".repeat(64), viewport: { width: 1, height: 1, aspect: 1 } }],
  };
  if (baseline !== "unstamped") manifest.projectRoot = baseline.projectRoot;
  await fs.writeFile(path.join(dir, BASELINE_MANIFEST), JSON.stringify(manifest, null, 2), "utf-8");
}

// ── tests ────────────────────────────────────────────────────────────────────

test("an empty project discovers NOTHING: no invented assets, no notes it cannot justify", async () => {
  const root = await tmpDir("unified-empty-");
  const workspace = await tmpDir("unified-ws-");
  try {
    const { assets, notes } = await discoverVerificationAssets({ root, workspace });
    assert.deepEqual(assets, []);
    assert.deepEqual(notes, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("all four kinds are discovered, deterministically ordered, with their anchors named", async () => {
  const root = await tmpDir("unified-full-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    await plantApprovedTrace(root, "b-second");
    await plantApprovedTrace(root, "a-first");
    await plantSnapshot(workspace, root);
    await plantScreenContract(workspace, { id: "kids-adventure", baseline: { projectRoot: root } });

    const { assets } = await discoverVerificationAssets({ root, workspace });
    assert.deepEqual(
      assets.map((a) => a.kind),
      ["contract", "trace", "trace", "feel-snapshot", "screen-contract"],
      "rows are grouped by the CLOSED inventory order",
    );
    assert.deepEqual(
      assets.filter((a) => a.kind === "trace").map((a) => a.id),
      ["a-first", "b-second"],
      "ties inside a kind are sorted by id, so the plan is byte-stable",
    );

    // Runnability follows D2: contract + screens are offline, trace + feel are live.
    assert.equal(rowFor(assets, "contract").runnable, "offline");
    assert.equal(rowFor(assets, "screen-contract").runnable, "offline");
    assert.equal(rowFor(assets, "trace", "a-first").runnable, "live");
    assert.equal(rowFor(assets, "feel-snapshot").runnable, "live");

    // Every approved anchor answers WHEN and BY WHAT.
    for (const kind of ["trace", "feel-snapshot", "screen-contract"] as const) {
      const row = rowFor(assets, kind);
      assert.ok(row.approvedAt, `${kind} row records when it was approved`);
      assert.ok(row.approvedBy, `${kind} row records what approved it`);
      assert.equal(row.broken, undefined);
    }
    assert.ok(assets.every((a) => a.paths.asset.length > 0), "every row names where it lives");

    // A plan of anchors alone is not a pass: nothing has executed yet.
    assert.equal(
      resolveUnifiedOutcome({ executed: [], notRun: assets.filter((a) => a.runnable === "no").map(notRunFor) }).status,
      "nothing-checked",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("ASSET_KINDS is the closed inventory: discovery emits no kind outside it", async () => {
  const root = await tmpDir("unified-closed-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    await plantApprovedTrace(root, "demo");
    await plantSnapshot(workspace, root);
    await plantScreenContract(workspace, { id: "sc", baseline: { projectRoot: root } });
    const { assets } = await discoverVerificationAssets({ root, workspace });
    assert.equal(new Set(assets.map((a) => a.kind)).size, ASSET_KINDS.length, "every declared kind is reachable");
    for (const a of assets) assert.ok((ASSET_KINDS as readonly string[]).includes(a.kind), `${a.kind} is declared`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a recorded-but-UNAPPROVED trace is a visible non-anchor row that never executes", async () => {
  const root = await tmpDir("unified-unapproved-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await plantTrace(root, "kq-happy-path");
    const { assets } = await discoverVerificationAssets({ root, workspace });
    const row = rowFor(assets, "trace", "kq-happy-path");
    assert.equal(row.runnable, "no");
    assert.equal(row.notRunClass, "non-anchor");
    assert.equal(row.broken, undefined, "unapproved is a provenance gap, not tampering");
    assert.ok(row.reason?.includes("trace approve"), row.reason);
    assert.equal(row.approvedAt, undefined);
    assert.equal(resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [notRunFor(row)] }).exit, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a LEGACY baseline (PNGs, no manifest) is an unstamped non-anchor: never executed, never tier-2 tampering", async () => {
  const root = await tmpDir("unified-legacy-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await plantTrace(root, "legacy");
    const baselineDir = path.join(standardReplayLayout(root).replayBaselines, "legacy");
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, "cap.png"), Buffer.from("legacy frame"));

    const row = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "trace", "legacy");
    assert.equal(row.runnable, "no");
    assert.equal(row.notRunClass, "non-anchor");
    assert.equal(row.broken, undefined);
    assert.ok(row.reason?.includes("unstamped"), row.reason);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("LITMUS: a TAMPERED trace baseline PNG is a broken row at tier 2 (the sha cross-check is what catches it)", async () => {
  const root = await tmpDir("unified-tampered-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await plantApprovedTrace(root, "demo");
    const clean = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "trace", "demo");
    assert.equal(clean.runnable, "live", "clean before tampering, so the LITMUS has something to break");

    await fs.writeFile(
      path.join(standardReplayLayout(root).replayBaselines, "demo", "cap.png"),
      Buffer.from("repainted after approval"),
    );

    const row = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "trace", "demo");
    assert.equal(row.runnable, "no");
    assert.equal(row.notRunClass, "broken");
    assert.ok(row.broken && row.broken.length > 0, "the failure is reported, not swallowed");
    assert.equal(
      resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [notRunFor(row)] }).exit,
      2,
      "a broken asset is the harness tier, never a pass",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("LITMUS: a hand-edited feel-snapshot metric makes the row broken and the tier 2", async () => {
  // Structured so the ONLY thing that can produce the broken marker is discovery's
  // `verifySnapshotIntegrity` call: the test edits the manifest and asserts the row,
  // it never re-derives the failure text or re-runs integrity itself.
  const root = await tmpDir("unified-snap-litmus-");
  const workspace = await tmpDir("unified-ws-");
  try {
    const currentDir = await plantSnapshot(workspace, root);
    const clean = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "feel-snapshot");
    assert.equal(clean.runnable, "live", "clean before tampering, so the LITMUS has something to break");
    assert.equal(clean.broken, undefined);

    const manifestPath = path.join(currentDir, FEEL_SNAPSHOT_MANIFEST);
    const doc = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const metric = Object.keys(doc.metrics)[0]!;
    doc.metrics[metric].value = 999; // "the game measures 999, trust me"
    await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2), "utf-8");

    const row = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "feel-snapshot");
    assert.equal(row.runnable, "no", "a baseline that fails its own integrity cannot grade anything");
    assert.equal(row.notRunClass, "broken");
    assert.ok(row.broken && row.broken.includes(metric), `the refusal names the metric: ${row.broken}`);
    assert.equal(
      resolveUnifiedOutcome({ executed: [{ section: "contract", exit: 0 }], notRun: [notRunFor(row)] }).exit,
      2,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an UNSTAMPED feel snapshot is a non-anchor; one stamped for ANOTHER project is broken", async () => {
  const root = await tmpDir("unified-stamp-");
  const other = await tmpDir("unified-other-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await plantSnapshot(workspace, undefined);
    const legacy = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "feel-snapshot");
    assert.equal(legacy.runnable, "no");
    assert.equal(legacy.notRunClass, "non-anchor");
    assert.equal(legacy.broken, undefined, "legacy is not tampering");
    assert.ok(legacy.reason?.includes("re-approve"), legacy.reason);

    // The workspace path is derived from the project BASENAME, so two checkouts can
    // land on the same workspace, so a snapshot naming another root must never grade here.
    await plantSnapshot(workspace, other);
    const foreign = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "feel-snapshot");
    assert.equal(foreign.runnable, "no");
    assert.equal(foreign.notRunClass, "broken");
    assert.ok(foreign.broken?.includes(other), foreign.broken);
  } finally {
    for (const d of [root, other, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("a DRAFT screen contract is not-runnable and NOT broken; alone it yields nothing-checked", async () => {
  const root = await tmpDir("unified-draft-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await plantScreenContract(workspace, { id: "sc", draft: true });
    const { assets } = await discoverVerificationAssets({ root, workspace });
    const row = rowFor(assets, "screen-contract");
    assert.equal(row.runnable, "no");
    assert.equal(row.notRunClass, "draft");
    assert.equal(row.broken, undefined, "a scaffold is unfinished work, not a defect");
    assert.ok(row.reason?.includes("minigame finalize"), row.reason);
    assert.deepEqual(resolveUnifiedOutcome({ executed: [], notRun: [notRunFor(row)] }), {
      status: "nothing-checked",
      exit: 2,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("screen-contract baselines: an APPROVED one is required to run; unstamped is a non-anchor; foreign and unreadable are broken", async () => {
  const root = await tmpDir("unified-screens-");
  const other = await tmpDir("unified-other-");
  const workspace = await tmpDir("unified-ws-");
  try {
    // DELIBERATE CHANGE (H1). An earlier cut ran this row anyway, calling the declared
    // contract "itself a human-authored anchor". It is not one: the contract and the
    // capture pack are both producible by the same agent in the same session, so with no
    // frozen third artifact the section grades a document against captures of that
    // document and reports `pass` with nothing a human ever approved involved. The
    // baseline manifest is the only artifact on this path that a human's `baseline
    // approve` had to produce, so its absence is a non-anchor row, never an execution.
    await plantScreenContract(workspace, { id: "sc", baseline: "none" });
    const noBaseline = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "screen-contract");
    assert.equal(noBaseline.runnable, "no", "no approved layout baseline means no execution");
    assert.equal(noBaseline.notRunClass, "non-anchor");
    assert.equal(noBaseline.broken, undefined, "an absent baseline is missing provenance, not tampering");
    assert.ok(noBaseline.reason?.includes("minigame baseline approve"), noBaseline.reason);

    await plantScreenContract(workspace, { id: "sc", baseline: "unstamped" });
    const unstamped = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "screen-contract");
    assert.equal(unstamped.runnable, "no");
    assert.equal(unstamped.notRunClass, "non-anchor");
    assert.equal(unstamped.broken, undefined);

    await plantScreenContract(workspace, { id: "sc", baseline: { projectRoot: other } });
    const foreign = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "screen-contract");
    assert.equal(foreign.notRunClass, "broken");
    assert.ok(foreign.broken?.includes(other), foreign.broken);

    await plantScreenContract(workspace, { id: "sc", baseline: "malformed" });
    const malformed = rowFor((await discoverVerificationAssets({ root, workspace })).assets, "screen-contract");
    assert.equal(malformed.notRunClass, "broken");
    assert.ok(malformed.broken?.includes(BASELINE_MANIFEST), malformed.broken);
  } finally {
    for (const d of [root, other, workspace]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("a malformed ACCEPTANCE.json is ONE broken contract row: discovery does not throw and the other assets still resolve", async () => {
  const root = await tmpDir("unified-badcontract-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    await plantApprovedTrace(root, "demo");
    await fs.writeFile(loombridgePaths(root).acceptance, "{ this is not json", "utf-8");

    const { assets } = await discoverVerificationAssets({ root, workspace });
    const contract = rowFor(assets, "contract");
    assert.equal(contract.runnable, "no");
    assert.equal(contract.notRunClass, "broken");
    assert.ok(contract.broken?.includes("malformed"), contract.broken);
    assert.equal(rowFor(assets, "trace", "demo").runnable, "live", "one bad asset must not blind the plan to the rest");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an underivable workspace id skips the workspace kinds VISIBLY, via a note", async () => {
  const parent = await tmpDir("unified-underivable-");
  try {
    // `1bad` cannot sanitize to a workspace id (ids must start with a letter), so the
    // two workspace-resident kinds are announced as unreachable rather than dropped.
    const root = path.join(parent, "1bad");
    await fs.mkdir(root, { recursive: true });
    const { assets, notes } = await discoverVerificationAssets({ root });
    assert.deepEqual(assets, []);
    assert.equal(notes.length, 1);
    assert.ok(/feel snapshot, screen contract/.test(notes[0]!), notes[0]);
    assert.ok(/--id|--workspace/.test(notes[0]!), notes[0]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("discovery is idempotent: two runs over the same disk produce byte-identical plans", async () => {
  const root = await tmpDir("unified-stable-");
  const workspace = await tmpDir("unified-ws-");
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    await plantApprovedTrace(root, "demo");
    await plantTrace(root, "zz-unapproved");
    await plantSnapshot(workspace, root);
    await plantScreenContract(workspace, { id: "sc", baseline: { projectRoot: root } });

    const first = await discoverVerificationAssets({ root, workspace });
    const second = await discoverVerificationAssets({ root, workspace });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
