import assert from "node:assert/strict";
import test from "node:test";

import {
  logsArrayOf,
  partitionConsolePhases,
  type ConsoleEntry,
} from "../verification/capture-console.js";
import { evaluateConsoleClean } from "../verification/gates/console-clean.js";
import type { AcceptanceContract } from "../verification/types.js";

const acceptance = {} as AcceptanceContract; // console-clean ignores the contract

// ── logsArrayOf ──────────────────────────────────────────────────────────────

test("logsArrayOf: unwraps { logs } and tolerates a bare array / junk", () => {
  assert.deepEqual(logsArrayOf({ logs: [{ message: "a" }] }), [{ message: "a" }]);
  assert.deepEqual(logsArrayOf([{ message: "b" }]), [{ message: "b" }]);
  assert.deepEqual(logsArrayOf(null), []);
  assert.deepEqual(logsArrayOf({ nope: 1 }), []);
});

// ── partitionConsolePhases (the no-drop contract) ─────────────────────────────

test("partitionConsolePhases: full = startup ++ steady; every entry preserved + phase-tagged", () => {
  const startup: ConsoleEntry[] = [
    { type: "log", message: "Awake" },
    { type: "log", message: "Start" },
  ];
  const full: ConsoleEntry[] = [
    { type: "log", message: "Awake" },
    { type: "log", message: "Start" },
    { type: "log", message: "frame-1" },
    { type: "log", message: "frame-2" },
  ];
  const p = partitionConsolePhases(startup, full);
  // Nothing dropped: logs length equals the authoritative full snapshot.
  assert.equal(p.logs.length, full.length);
  assert.deepEqual(p.startupLogs.map((e) => e.message), ["Awake", "Start"]);
  assert.deepEqual(p.steadyLogs.map((e) => e.message), ["frame-1", "frame-2"]);
  assert.deepEqual(
    p.logs.map((e) => e.phase),
    ["startup", "startup", "steady", "steady"],
  );
});

test("partitionConsolePhases: a play-enter STARTUP error is preserved (not dropped) and fails console-clean", () => {
  // This is the regression for the false-green: the OLD capture cleared the
  // console after settle, dropping startup errors. Now startup logs are kept.
  const startup: ConsoleEntry[] = [
    { type: "warning", message: "[Loombridge] IPC transport unavailable; fallback to tcp" },
    { type: "error", message: "NullReferenceException in PlayerController.Awake" },
  ];
  const full: ConsoleEntry[] = [
    ...startup,
    { type: "log", message: "steady frame" },
  ];
  const p = partitionConsolePhases(startup, full);

  // The startup error survives partition, tagged "startup".
  const startupError = p.logs.find((e) => e.type === "error");
  assert.ok(startupError, "startup error must be present in logs[]");
  assert.equal(startupError?.phase, "startup");

  // And feeding the written logs through the gate FAILs (infra warning excused,
  // real startup error is not).
  const r = evaluateConsoleClean({ logs: p.logs }, acceptance);
  assert.equal(r.verdict, "fail");
});

test("partitionConsolePhases: clamps the boundary if the full snapshot was truncated (no invented/dropped entries)", () => {
  // Pathological: full snapshot shorter than the startup count (count-cap
  // truncation). Must not slice past the end or crash.
  const startup: ConsoleEntry[] = [{ message: "a" }, { message: "b" }, { message: "c" }];
  const full: ConsoleEntry[] = [{ message: "b" }, { message: "c" }];
  const p = partitionConsolePhases(startup, full);
  assert.equal(p.logs.length, full.length); // exactly the full snapshot, nothing invented
  assert.equal(p.steadyLogs.length, 0);
  assert.deepEqual(p.startupLogs, full);
});
