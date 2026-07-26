import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EditorRegistry, EditorRoutingError } from "../bridge/editor-registry.js";
import type { UnityEndpointDiscoveryRecord } from "../shared/types.js";

function discoveryRecord(overrides: Partial<{
  sessionId: string;
  projectPathCanonical: string;
  projectPath: string;
  projectName: string;
  processId: number;
  publishedAtUnixMs: number;
  expiresAtUnixMs: number;
  port: number;
}> = {}): UnityEndpointDiscoveryRecord {
  const projectPathCanonical = overrides.projectPathCanonical ?? "/Users/dev/GameA";
  return {
    schemaVersion: "1",
    sessionId: overrides.sessionId ?? "session-a",
    projectPath: overrides.projectPath ?? projectPathCanonical,
    projectPathCanonical,
    projectName: overrides.projectName ?? path.basename(projectPathCanonical),
    processId: overrides.processId ?? 123,
    publishedAtUnixMs: overrides.publishedAtUnixMs ?? 1000,
    expiresAtUnixMs: overrides.expiresAtUnixMs ?? 10_000,
    transportModeDefault: "auto",
    endpoints: [
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: overrides.port ?? 8200,
        supportsHandshake: true,
        supportsPing: true,
      },
    ],
  };
}

test("EditorRegistry: single discovered editor is selected by default", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [discoveryRecord()],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "single");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: multiple editors without active or project fail closed", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", sessionId: "session-b" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_AMBIGUOUS"
      && /Multiple Unity editors/.test(err.message),
  );
});

test("EditorRegistry: editor.use sets active editor for later calls", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", sessionId: "session-b" }),
    ],
  });

  const used = registry.useEditor("/Users/dev/GameB");
  const selected = registry.selectEditor();

  assert.equal(used.projectPathCanonical, "/Users/dev/GameB");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameB");
  assert.equal(selected.reason, "active");
  assert.equal(selected.projectPathCanonical, "/Users/dev/GameB");
});

test("EditorRegistry: unique projectName can be used as a routing target", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const route = registry.selectEditor("GameB");

  assert.equal(route.reason, "target");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameB");
});

test("EditorRegistry: per-call project target overrides the active editor", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  registry.useEditor("GameB");
  const route = registry.selectEditor("GameA");

  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameB");
  assert.equal(route.reason, "target");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: explicit unknown project fails fast with peer list", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor("/Users/dev/Bogus"),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND"
      && err.peers.length === 1
      && /No discovered Unity editor/.test(err.message),
  );
});

test("EditorRegistry: duplicate projectName requires canonical path", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/A/Game", projectName: "Game" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/B/Game", projectName: "Game", sessionId: "session-b" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor("Game"),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_AMBIGUOUS"
      && /projectName 'Game'/.test(err.message),
  );
});

test("EditorRegistry: same project in two processes refuses path routing", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({
        sessionId: "process-a",
        projectPathCanonical: "/Users/dev/GameA",
        processId: 123,
      }),
      discoveryRecord({
        sessionId: "process-b",
        projectPathCanonical: "/Users/dev/GameA",
        processId: 456,
      }),
    ],
  });

  assert.throws(
    () => registry.selectEditor("/Users/dev/GameA"),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_AMBIGUOUS"
      && /Multiple Unity editors report projectPathCanonical/.test(err.message),
  );
});

test("EditorRegistry: same project/process reload churn collapses before routing", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({
        sessionId: "old-session",
        projectPathCanonical: "/Users/dev/GameA",
        processId: 123,
        publishedAtUnixMs: 1000,
      }),
      discoveryRecord({
        sessionId: "new-session",
        projectPathCanonical: "/Users/dev/GameA",
        processId: 123,
        publishedAtUnixMs: 2000,
      }),
    ],
  });

  const route = registry.selectEditor();

  assert.equal(route.record?.sessionId, "new-session");
});

test("EditorRegistry: active editor disappearance clears active and fails fast", () => {
  let records = [
    discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
  ];
  const registry = new EditorRegistry({
    scanRecords: () => records,
  });

  registry.useEditor("GameA");
  records = [];

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND"
      && /Active Unity editor/.test(err.message),
  );
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: evicts a per-project client after its editor is gone beyond grace (M1)", () => {
  let records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" })];
  let clock = 1_000_000;
  const created: Array<string | null> = [];
  const registry = new EditorRegistry({
    scanRecords: () => records,
    now: () => clock,
    onClientCreated: (_client, project) => created.push(project),
  });

  registry.selectEditor("/Users/dev/GameA");
  assert.equal(created.filter((p) => p === "/Users/dev/GameA").length, 1);

  // Editor closes; advance past the grace window; a routing call runs the reaper.
  records = [];
  clock += 120_001;
  registry.selectEditor();

  // Editor returns → a fresh client is created (the old one was evicted, not reused).
  records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" })];
  registry.selectEditor("/Users/dev/GameA");
  assert.equal(created.filter((p) => p === "/Users/dev/GameA").length, 2);
});

test("EditorRegistry: keeps a per-project client through a within-grace blip (M1)", () => {
  let records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" })];
  let clock = 1_000_000;
  const created: Array<string | null> = [];
  const registry = new EditorRegistry({
    scanRecords: () => records,
    now: () => clock,
    onClientCreated: (_client, project) => created.push(project),
  });

  registry.selectEditor("/Users/dev/GameA");
  records = [];
  clock += 60_000; // within the 120s grace
  registry.selectEditor();
  records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" })];
  registry.selectEditor("/Users/dev/GameA");

  assert.equal(created.filter((p) => p === "/Users/dev/GameA").length, 1);
});

test("EditorRegistry: active pin survives a transient blip, clears past grace (m1)", () => {
  let records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })];
  let clock = 1_000_000;
  const registry = new EditorRegistry({ scanRecords: () => records, now: () => clock });

  registry.useEditor("GameA");
  registry.selectEditor();
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");

  // Transient absence within grace → active retained.
  records = [];
  clock += 60_000;
  const route = registry.selectEditor();
  assert.equal(route.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");

  // Sustained absence beyond grace → cleared + fail fast.
  clock += 120_001;
  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError && err.code === "EDITOR_NOT_FOUND",
  );
  assert.equal(registry.activeProjectPathCanonical, null);
});

// ─────────────────────────────────────────────
// Startup binding (auto project binding) — A2
// ─────────────────────────────────────────────

test("EditorRegistry: strict startup target routes to its project among many without editor_use", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", sessionId: "session-b" }),
    ],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "active");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameA");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: strict startup target by unique project name routes correctly", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "GameB" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "active");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameB");
});

test("EditorRegistry: strict startup target + single non-matching editor fails closed (EDITOR_NOT_FOUND, not single routing)", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND"
      && err.peers.length === 1
      && /No discovered Unity editor matches '\/Users\/dev\/GameA'/.test(err.message),
  );
  // Must NOT have pinned the wrong editor.
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: strict startup target + zero discovered editors fails closed (v1 hard fail)", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND",
  );
});

test("EditorRegistry: unknown strict startup target fails EDITOR_NOT_FOUND with peer list", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/Bogus" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND"
      && err.peers.length === 2,
  );
});

// ─────────────────────────────────────────────
// cwd startup binding — fail-closed, identical to env-strict (no cross-route)
// ─────────────────────────────────────────────

test("EditorRegistry: cwd target A with editors A and B discovered routes A and pins it", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "active");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameA");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: cwd target A with only editor B discovered fails closed (EDITOR_NOT_FOUND, no cross-route)", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB" }),
    ],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND"
      && err.peers.length === 1
      && /No discovered Unity editor matches '\/Users\/dev\/GameA'/.test(err.message),
  );
  // Proves no fall-through to B: the active pin stays null, so the single non-matching
  // editor was NOT silently cross-routed.
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: cwd target A with zero discovered editors fails closed (v1 hard fail)", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameA" },
    scanRecords: () => [],
  });

  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_NOT_FOUND",
  );
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: cwd binding re-asserts after the bound editor disappears past grace and returns (no editor_use)", () => {
  let records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })];
  let clock = 1_000_000;
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameA" },
    scanRecords: () => records,
    now: () => clock,
  });

  // First untargeted call auto-binds via the cwd startup binding.
  const first = registry.selectEditor();
  assert.equal(first.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");

  // Editor disappears past the grace window → fail closed, active pin cleared.
  records = [];
  clock += 120_001;
  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError && err.code === "EDITOR_NOT_FOUND",
  );
  assert.equal(registry.activeProjectPathCanonical, null);

  // Editor returns → the persistent cwd binding re-binds without a manual editor_use.
  records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })];
  const rebound = registry.selectEditor();
  assert.equal(rebound.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: no binding (kind none) + one editor still uses the single-editor fallback", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB" }),
    ],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "single");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameB");
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: manual editor_use overrides the startup binding", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  registry.useEditor("GameB");
  const route = registry.selectEditor();

  assert.equal(route.reason, "active");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameB");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameB");
});

test("EditorRegistry: explicit per-call project overrides the startup binding for that call only", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const route = registry.selectEditor("GameB");

  assert.equal(route.reason, "target");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameB");
  // Per-call target must not mutate the active pin.
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: startup binding re-asserts after the bound editor disappears past grace and returns", () => {
  let records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })];
  let clock = 1_000_000;
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => records,
    now: () => clock,
  });

  // First untargeted call auto-binds via the startup binding.
  const first = registry.selectEditor();
  assert.equal(first.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");

  // Editor disappears past the grace window → active pin is cleared on the next call.
  records = [];
  clock += 120_001;
  assert.throws(
    () => registry.selectEditor(),
    (err: Error) => err instanceof EditorRoutingError && err.code === "EDITOR_NOT_FOUND",
  );
  assert.equal(registry.activeProjectPathCanonical, null);

  // Editor returns → the persistent startup binding re-binds without editor_use.
  records = [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })];
  const rebound = registry.selectEditor();
  assert.equal(rebound.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");
});

// ─────────────────────────────────────────────
// editor_list display-state peek (non-mutating) — UX gap fix
// ─────────────────────────────────────────────

test("EditorRegistry: describeListDisplayState peeks a resolving strict binding as active WITHOUT mutating the active pin", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const display = registry.describeListDisplayState(registry.listRecords());

  // Peek shows the bound project as active...
  assert.equal(display.effectiveActiveProjectPathCanonical, "/Users/dev/GameA");
  assert.deepEqual(display.startupBinding, {
    kind: "strict",
    target: "/Users/dev/GameA",
    resolved: true,
  });
  // ...but the committed active pin is STILL null (no mutation from the peek).
  assert.equal(registry.activeProjectPathCanonical, null);

  // A subsequent real routed op THEN commits the binding.
  const route = registry.selectEditor();
  assert.equal(route.reason, "active");
  assert.equal(registry.activeProjectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: describeListDisplayState with strict binding + no matching editor is unresolved and never throws", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB" }),
    ],
  });

  let display: ReturnType<EditorRegistry["describeListDisplayState"]>;
  assert.doesNotThrow(() => {
    display = registry.describeListDisplayState(registry.listRecords());
  });

  assert.equal(display!.effectiveActiveProjectPathCanonical, null);
  assert.deepEqual(display!.startupBinding, {
    kind: "strict",
    target: "/Users/dev/GameA",
    resolved: false,
  });
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: describeListDisplayState with strict binding matching two editors is unresolved for display and never throws", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/A/Game" },
    scanRecords: () => [
      discoveryRecord({ sessionId: "p-a", projectPathCanonical: "/Users/dev/A/Game", projectName: "Game", processId: 1 }),
      discoveryRecord({ sessionId: "p-b", projectPathCanonical: "/Users/dev/A/Game", projectName: "Game", processId: 2 }),
    ],
  });

  let display: ReturnType<EditorRegistry["describeListDisplayState"]>;
  assert.doesNotThrow(() => {
    display = registry.describeListDisplayState(registry.listRecords());
  });

  // Two editors report the same path → can't safely pick one → unresolved.
  assert.equal(display!.effectiveActiveProjectPathCanonical, null);
  assert.deepEqual(display!.startupBinding, {
    kind: "strict",
    target: "/Users/dev/A/Game",
    resolved: false,
  });
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: describeListDisplayState peeks a resolving cwd binding as active without mutating", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameB" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  const display = registry.describeListDisplayState(registry.listRecords());

  assert.equal(display.effectiveActiveProjectPathCanonical, "/Users/dev/GameB");
  assert.deepEqual(display.startupBinding, {
    kind: "cwd",
    target: "/Users/dev/GameB",
    resolved: true,
  });
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: describeListDisplayState with a cwd binding + no matching editor is unresolved and never throws", () => {
  const registry = new EditorRegistry({
    startupBinding: { kind: "cwd", target: "/Users/dev/GameA" },
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB" }),
    ],
  });

  let display: ReturnType<EditorRegistry["describeListDisplayState"]>;
  assert.doesNotThrow(() => {
    display = registry.describeListDisplayState(registry.listRecords());
  });

  assert.equal(display!.effectiveActiveProjectPathCanonical, null);
  assert.deepEqual(display!.startupBinding, {
    kind: "cwd",
    target: "/Users/dev/GameA",
    resolved: false,
  });
  assert.equal(registry.activeProjectPathCanonical, null);
});

test("EditorRegistry: describeListDisplayState with no startup binding reports null descriptor and prefers a committed pin", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  // No binding, nothing pinned yet → null descriptor, no effective active.
  const before = registry.describeListDisplayState(registry.listRecords());
  assert.equal(before.startupBinding, null);
  assert.equal(before.effectiveActiveProjectPathCanonical, null);

  // Once pinned, the committed pin is preferred.
  registry.useEditor("GameB");
  const after = registry.describeListDisplayState(registry.listRecords());
  assert.equal(after.startupBinding, null);
  assert.equal(after.effectiveActiveProjectPathCanonical, "/Users/dev/GameB");
});

test("EditorRegistry: no startup binding preserves single-editor zero-config default", () => {
  const registry = new EditorRegistry({
    scanRecords: () => [discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" })],
  });

  const route = registry.selectEditor();

  assert.equal(route.reason, "single");
  assert.equal(route.projectPathCanonical, "/Users/dev/GameA");
});

test("EditorRegistry: runExclusive serializes work per editor", async () => {
  const registry = new EditorRegistry({
    scanRecords: () => [discoveryRecord()],
  });
  const route = registry.selectEditor();
  const order: string[] = [];

  const first = registry.runExclusive(route, async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first-end");
  });
  const second = registry.runExclusive(route, async () => {
    order.push("second-start");
    order.push("second-end");
  });

  await Promise.all([first, second]);

  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("EditorRegistry: symlink-skewed startup target resolves to the real-path record (no fail-closed)", () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "loombridge-registry-symlink-"));
  try {
    const realDir = path.join(root, "real-project");
    const linkDir = path.join(root, "linked-project");
    fsSync.mkdirSync(realDir);
    fsSync.symlinkSync(realDir, linkDir);

    // The record reports the REAL path; the startup binding target is the SYMLINK path.
    // Pre-fix this fails closed (EDITOR_NOT_FOUND); projectPathsEquivalent resolves both.
    const registry = new EditorRegistry({
      startupBinding: { kind: "cwd", target: linkDir },
      scanRecords: () => [discoveryRecord({ projectPathCanonical: realDir })],
    });

    const route = registry.selectEditor();

    assert.equal(route.reason, "active");
    assert.equal(route.projectPathCanonical, realDir);
    assert.equal(registry.activeProjectPathCanonical, realDir);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test("EditorRegistry: a bare projectName target is never resolved as a cwd-relative path", () => {
  // A bare name like "GameA" must NOT be treated as a filesystem path. If it were, a
  // ./GameA dir/symlink in the server's cwd could match a record by-path and bypass the
  // duplicate-projectName ambiguity check. Here only a (wrong) path resolution could match.
  const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "loombridge-name-path-")));
  const prevCwd = process.cwd();
  try {
    const realProj = path.join(root, "real-project");
    fsSync.mkdirSync(realProj);
    process.chdir(root);
    // ./GameA → realProj: realpath("GameA") would equal the record's path.
    fsSync.symlinkSync(realProj, path.join(root, "GameA"));

    const registry = new EditorRegistry({
      // The record's NAME is deliberately NOT "GameA"; the only way "GameA" could resolve is
      // by wrongly treating it as the ./GameA path symlink.
      scanRecords: () => [discoveryRecord({ projectPathCanonical: realProj, projectName: "SomethingElse" })],
    });

    assert.throws(
      () => registry.useEditor("GameA"),
      (err: Error) => err instanceof EditorRoutingError && err.code === "EDITOR_NOT_FOUND",
    );
  } finally {
    process.chdir(prevCwd);
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});
