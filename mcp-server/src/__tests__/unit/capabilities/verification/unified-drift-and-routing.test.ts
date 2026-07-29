/**
 * The unified door's half of the ratchet-findings wave: what the PLAN says about an
 * approved tolerance (R1/A2), what the SUMMARY says about a drift (R3/A3), and the
 * routing NOTE that turns a refuse-only workspace miss into an actionable id (R2/A5).
 *
 * Each of the three is a display-honesty property, and display honesty is load-bearing
 * here: the plan line is the only place a human sees that this run grades at 2% instead
 * of 0.5% BEFORE it runs, the summary word is what an agent quotes, and the note is the
 * difference between "nothing to verify" and "you are one --id away from your assets".
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import {
  WORKSPACE_SCAN_CAP,
  discoverVerificationAssets,
} from "../../../../capabilities/verification/unified/discovery.js";
import { planLines, summaryLines } from "../../../../capabilities/verification/unified/orchestrator.js";
import { FEEL_SNAPSHOT_MANIFEST } from "../../../../capabilities/feel/snapshot-manifest.js";
import { feelPaths } from "../../../../capabilities/feel/feel-workspace.js";
import { BASELINE_MANIFEST } from "../../../../capabilities/minigame/minigame-baseline.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { UnifiedVerifyReport } from "../../../../capabilities/verification/unified/report.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.error = real;
  }
}

// ── R1/A2: the approved tolerance is visible in the plan, before anything runs ──

/** A project with one trace whose baseline is approved through the real verb. */
async function projectWithApprovedTrace(id = "happy-path"): Promise<string> {
  const root = await tmpDir("unified-drift-root-");
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
  const actualDir = path.join(layout.replayReports, id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actual = path.join(actualDir, "cap.png");
  await fs.writeFile(actual, Buffer.from(`frame-${id}`));
  await fs.writeFile(
    path.join(layout.replayReports, `${id}.report.json`),
    JSON.stringify({
      traceId: id,
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actual }] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    }),
  );
  const approved = await captured(() => runTrace(["approve", "--id", id, "--root", root]));
  assert.equal(approved.code, 0, approved.out);
  return root;
}

test("the PLAN prints a non-default tolerance with its consent sentence, and stays silent about the default", async () => {
  const root = await projectWithApprovedTrace();
  const workspace = await tmpDir("unified-drift-ws-");
  try {
    const before = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const beforeRow = before.assets.find((a) => a.kind === "trace")!;
    assert.equal(beforeRow.driftTolerance, undefined, "the default is not a fact worth printing");
    assert.doesNotMatch(planLines(root, before.assets, before.notes, true).join("\n"), /drift tolerance/);

    const stamped = await captured(() => runTrace(["tolerance", "--id", "happy-path", "--root", root, "--set", "0.02"]));
    assert.equal(stamped.code, 0, stamped.out);

    const after = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = after.assets.find((a) => a.kind === "trace")!;
    assert.equal(row.driftTolerance, 0.02, "typed, so a reader never has to parse a sentence for it");
    assert.equal(row.runnable, "live", "a stamped tolerance does not change what the row can do");
    const plan = planLines(root, after.assets, after.notes, true).join("\n");
    assert.match(
      plan,
      /drift tolerance 2%: at 2%, anything covering up to ~14% of frame width by ~14% of height can change undetected/,
      "a silent tolerance is indistinguishable from a gate nobody has",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an over-cap tolerance HAND-EDITED into the manifest makes the trace row BROKEN in the unified door", async () => {
  const root = await projectWithApprovedTrace();
  const workspace = await tmpDir("unified-drift-ws-");
  try {
    const manifestPath = path.join(standardReplayLayout(root).replayBaselines, "happy-path", "baseline-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, driftTolerance: 0.9 }));

    const { assets } = await discoverVerificationAssets({ root, workspace, workspacesRoot: workspace });
    const row = assets.find((a) => a.kind === "trace")!;
    assert.equal(row.runnable, "no", "an anchor whose terms cannot be read never executes");
    assert.equal(row.notRunClass, "broken", "…and it is BROKEN (tier 2), not a quiet fall back to the default");
    assert.match(row.broken ?? "", /above the 0\.02 cap/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ── R3/A3: the flow section names the drift instead of printing "pass (exit 1)" ──

/** A minimal report shell so `summaryLines` can be driven over one section. */
function reportWith(sections: UnifiedVerifyReport["sections"]): UnifiedVerifyReport {
  return {
    kind: "unified-verify",
    schemaVersion: "1",
    producedAt: "t",
    root: "/p",
    runId: null,
    live: true,
    plan: [],
    notRun: [],
    only: null,
    deselected: [],
    sections,
    anchoredSections: Object.keys(sections) as UnifiedVerifyReport["anchoredSections"],
    unanchoredSections: [],
    status: "fail",
    exit: 1,
    notes: [],
  };
}

test("R3: the flow line LEADS with pixel-drift regression, and the per-trace detail names which trace moved", () => {
  const lines = summaryLines(
    reportWith({
      flow: {
        // The engine's own word for a trace whose ACTUATION passed is `pass`; that word
        // printed beside `exit 1` is exactly the display dishonesty this closes.
        status: "pass",
        exit: 1,
        anchored: true,
        drift: { driftCaptures: 39, maxDiffFraction: 0.013, toleranceUsed: 0.005 },
        assets: [
          { kind: "trace", id: "a-clean", status: "pass", exit: 0 },
          {
            kind: "trace",
            id: "b-drifted",
            status: "pass",
            exit: 1,
            drift: { driftCaptures: 39, maxDiffFraction: 0.013, toleranceUsed: 0.005 },
          },
        ],
      },
    }),
    true,
  );
  const flow = lines.find((l) => l.includes("flow:"))!;
  assert.match(
    flow,
    /flow: pixel-drift regression \(exit 1\): actuation passed, 39 capture\(s\) over tolerance, max 1\.3%/,
  );
  assert.doesNotMatch(flow, /flow: pass \(/, "the bare `pass (exit 1)` line is the thing being removed");
  assert.match(flow, /a-clean=pass/, "a clean trace still reads as a clean trace");
  assert.match(flow, /b-drifted=pixel drift 1\.3% \(39 capture\(s\) over tolerance 0\.5%\)/);
});

test("R3: a section with NO drift keeps the ordinary wording (the new line never fires on a clean run)", () => {
  const lines = summaryLines(
    reportWith({
      flow: {
        status: "pass",
        exit: 0,
        anchored: true,
        assets: [{ kind: "trace", id: "a-clean", status: "pass", exit: 0 }],
      },
    }),
    true,
  );
  assert.match(lines[0]!, /flow: pass \(exit 0\) \[a-clean=pass\]/);
  assert.doesNotMatch(lines.join("\n"), /pixel-drift/);
});

test("R3: a tier-2 unreadable keeps the S1 harness wording, never the drift wording", () => {
  // A capture gap is not drift, so the drift line must not colonise the harness tier's
  // report. `drift` is absent for that section by construction (nothing was compared).
  const lines = summaryLines(
    reportWith({
      flow: { status: "harness-fault", exit: 2, anchored: true, assets: [{ kind: "trace", id: "t", status: "harness-fault", exit: 2 }] },
    }),
    true,
  );
  assert.match(lines[0]!, /flow: harness-fault \(exit 2\)/);
  assert.doesNotMatch(lines.join("\n"), /pixel-drift regression/);
});

// ── R2/A5: the workspace routing note ────────────────────────────────────────

/** A workspace that STAMPS `projectRoot` through the feel snapshot's manifest. */
async function stampFeelWorkspace(scanRoot: string, id: string, projectRoot: string): Promise<void> {
  const dir = feelPaths(path.join(scanRoot, id)).snapshotCurrentDir;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FEEL_SNAPSHOT_MANIFEST), JSON.stringify({ projectRoot }));
}

/** …and one that stamps it through the screen-contract layout baseline instead. */
async function stampScreensWorkspace(scanRoot: string, id: string, projectRoot: string): Promise<void> {
  const dir = path.join(scanRoot, id, "baseline");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, BASELINE_MANIFEST), JSON.stringify({ projectRoot }));
}

test("R2: a foreign-id workspace that STAMPS this root becomes a routing note, and adds no asset", async () => {
  const root = await tmpDir("unified-route-root-");
  const scanRoot = await tmpDir("unified-route-scan-");
  const derived = path.join(scanRoot, "derived-empty");
  try {
    await fs.mkdir(derived, { recursive: true });
    await stampFeelWorkspace(scanRoot, "renamed-game", path.resolve(root));
    await stampScreensWorkspace(scanRoot, "another-one", path.resolve(root));
    await stampFeelWorkspace(scanRoot, "someone-elses", path.join(path.resolve(root), "..", "different-project"));

    const { assets, notes } = await discoverVerificationAssets({
      root,
      workspace: derived,
      workspacesRoot: scanRoot,
    });

    assert.deepEqual(assets, [], "THE NOTE IS NOT AN ASSET: nothing was adopted, so nothing can be graded");
    const note = notes.find((n) => n.includes("stamp"))!;
    assert.ok(note, `expected a routing note, got ${JSON.stringify(notes)}`);
    // Every match, sorted, so an operator picking an id sees all of the candidates.
    assert.match(note, /workspace 'another-one', workspace 'renamed-game' stamp this project root/);
    assert.doesNotMatch(note, /someone-elses/, "a workspace stamping a DIFFERENT root is not a candidate");
    assert.match(note, /pass --id <id> \(or --workspace <dir>\) to include its assets/);
    assert.match(
      note,
      /WHICH id you pass changes what is measured and therefore the verdict/,
      "the note must say that the choice is part of the verdict, not a convenience",
    );
    // …and it reaches the operator through the plan, which is where it is actionable.
    assert.match(planLines(root, assets, notes, false).join("\n"), /note: workspace 'another-one'/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scanRoot, { recursive: true, force: true });
  }
});

test("R2 LITMUS: no stamp, no note (the scan never guesses from a folder name)", async () => {
  const root = await tmpDir("unified-route-root-");
  const scanRoot = await tmpDir("unified-route-scan-");
  const derived = path.join(scanRoot, "derived-empty");
  try {
    await fs.mkdir(derived, { recursive: true });
    // A workspace that exists, is named after this project, and has NO ownership stamp.
    await fs.mkdir(path.join(scanRoot, path.basename(root), "feel"), { recursive: true });
    const { notes } = await discoverVerificationAssets({ root, workspace: derived, workspacesRoot: scanRoot });
    assert.deepEqual(notes, [], "a name is not a stamp; only a stamped projectRoot routes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scanRoot, { recursive: true, force: true });
  }
});

test("R2: the scan is BOUNDED, and says so when the cap cuts the answer short", async () => {
  const root = await tmpDir("unified-route-root-");
  const scanRoot = await tmpDir("unified-route-scan-");
  const derived = path.join(scanRoot, "zz-derived-empty");
  try {
    await fs.mkdir(derived, { recursive: true });
    for (let i = 0; i <= WORKSPACE_SCAN_CAP; i += 1) {
      await fs.mkdir(path.join(scanRoot, `ws-${String(i).padStart(3, "0")}`), { recursive: true });
    }
    const { notes } = await discoverVerificationAssets({ root, workspace: derived, workspacesRoot: scanRoot });
    const truncation = notes.find((n) => n.includes("stopped at the first"));
    assert.ok(truncation, `expected a truncation note, got ${JSON.stringify(notes)}`);
    assert.match(truncation, new RegExp(`stopped at the first ${WORKSPACE_SCAN_CAP} of `));
    assert.match(truncation, /this routing list may be incomplete/, "a truncated scan never presents itself as complete");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scanRoot, { recursive: true, force: true });
  }
});

test("R2: the scan only runs when the derived workspace produced NOTHING", async () => {
  // A project whose own workspace holds assets is already answered; a routing note there
  // would be noise pointing at workspaces the operator did not ask about.
  const root = await tmpDir("unified-route-root-");
  const scanRoot = await tmpDir("unified-route-scan-");
  try {
    const derived = path.join(scanRoot, "derived-real");
    await stampScreensWorkspace(scanRoot, "derived-real", path.resolve(root));
    // A real screen contract in the derived workspace, so discovery finds an asset there.
    await fs.writeFile(
      path.join(derived, "game.minigame.json"),
      JSON.stringify({ schemaVersion: "1", id: "game", description: "d", states: [] }),
    );
    await stampFeelWorkspace(scanRoot, "other-match", path.resolve(root));

    const { assets, notes } = await discoverVerificationAssets({ root, workspace: derived, workspacesRoot: scanRoot });
    assert.equal(assets.length, 1, "the derived workspace's own asset is discovered");
    assert.deepEqual(notes, [], "…so no routing note fires");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scanRoot, { recursive: true, force: true });
  }
});
