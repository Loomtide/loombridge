/**
 * THE OP JOURNAL'S CLASSIFICATION TABLE IS A DECLARED PATH NOTHING WALKS.
 *
 * `OpJournalOpTable.cs` carries one row per published op: is it a write, and which
 * parameter holds the object it writes to. Nothing in either language connects that
 * table to the TS op registry. The failure it would hide is quiet and expensive: add a
 * new mutating op, forget the row, and the journal records it as `unknown` with no
 * target, so the evidence a consumer re-derives is bound to nothing. Worse, rename a
 * locator parameter and the row still "matches" while every target it resolves is null,
 * which reads exactly like an op that touched nothing.
 *
 * This reads the C# as TEXT, like `unity-op-wiring.test.ts` and for the same reason: it
 * cannot compile Unity, and a text check that fails on the exact drift is worth more
 * than no check at all.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";
import { OpRegistry } from "../../../surfaces/op-registry.js";

const TABLE = path.join(
  REPO_ROOT,
  "packages",
  "com.loomtide.loombridge",
  "Editor",
  "Core",
  "OpJournalOpTable.cs",
);

interface Row {
  command: string;
  kind: "read" | "write";
  targetParam: string;
}

/** `{ "scene.set_transform", KindWrite, "locator" },` → one Row. */
function tableRows(): Row[] {
  const source = fs.readFileSync(TABLE, "utf-8");
  const pattern = /\{\s*"([\w.]+)",\s*Kind(Read|Write),\s*"(\w*)"\s*\}/g;
  const rows: Row[] = [];
  for (const match of source.matchAll(pattern)) {
    rows.push({
      command: match[1]!,
      kind: match[2]!.toLowerCase() as "read" | "write",
      targetParam: match[3]!,
    });
  }
  return rows;
}

test("op journal table: parses, and the LITMUS row it is anchored on is present", () => {
  const rows = tableRows();
  // A parser that silently matched nothing would make every assertion below vacuous.
  assert.ok(rows.length > 100, `expected the full op table, parsed ${rows.length} rows`);
  const setTransform = rows.find((row) => row.command === "scene.set_transform");
  assert.deepEqual(setTransform, {
    command: "scene.set_transform",
    kind: "write",
    targetParam: "locator",
  });
});

test("op journal table: classifies EXACTLY the ops the registry publishes, both directions", () => {
  const rows = tableRows();
  const registry = new OpRegistry();
  const published = new Set(registry.getAll().map((op) => op.command));
  const classified = new Set(rows.map((row) => row.command));

  const unclassified = [...published].filter((command) => !classified.has(command)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `these published ops have no row in OpJournalOpTable.cs, so the journal records them as ` +
      `'unknown' with no target: ${unclassified.join(", ")}`,
  );

  const stale = [...classified].filter((command) => !published.has(command)).sort();
  assert.deepEqual(
    stale,
    [],
    `these rows name ops the registry no longer publishes: ${stale.join(", ")}`,
  );

  assert.equal(rows.length, classified.size, "the table must not carry a duplicate row");
});

test("op journal table: every named target parameter exists in that op's own schema", () => {
  // The drift that survives a set comparison: the row keeps its op but names a
  // parameter the op no longer takes, so the descriptor is null on every call and the
  // write looks like it touched nothing.
  const registry = new OpRegistry();
  const problems: string[] = [];

  for (const row of tableRows()) {
    if (!row.targetParam) continue;
    const op = registry.getByCommand(row.command);
    if (!op) continue; // covered by the both-directions test
    const properties = (op.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    if (!(row.targetParam in properties)) {
      problems.push(`${row.command} names target param '${row.targetParam}', which is not in its schema`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("op journal table: a target parameter is only declared on a write row", () => {
  // A read row with a target param would be dead declaration: the journal never
  // resolves a descriptor for a read, so the row would advertise a binding that does
  // not exist.
  const offenders = tableRows()
    .filter((row) => row.kind === "read" && row.targetParam !== "")
    .map((row) => row.command);
  assert.deepEqual(offenders, [], `read rows must not declare a target param: ${offenders.join(", ")}`);
});

test("op journal table: the ops that mutate the game are classified as writes", () => {
  // The rows the evidence rests on, pinned by name rather than by rule. If any of these
  // ever flips to 'read', a consumer stops refusing on the exact traffic the journal
  // exists to expose (a teleport that masquerades as a respawn, a driven input, a
  // forced tick).
  const mustWrite = [
    "scene.set_transform",
    "scene.set_parent",
    "scene.set_active",
    "scene.delete_object",
    "component.set_property",
    "component.add",
    "component.remove",
    "editor.tick",
    "editor.play",
    "editor.clear_console",
    "input.key_down",
    "input.key_up",
    "input.key_tap",
    "input.pointer_tap",
    "input.pointer_tap_world",
    "ui.dispatch_pointer",
    "replay.settle_and_capture",
    "ops.batch",
    "capture.invoke_static",
  ];
  const byCommand = new Map(tableRows().map((row) => [row.command, row]));
  for (const command of mustWrite) {
    const row = byCommand.get(command);
    assert.ok(row, `${command} must have a row in the op journal table`);
    assert.equal(row!.kind, "write", `${command} mutates the project or the running game`);
  }

  // And the reads the observer is allowed to make during a window, which must not
  // start reporting as writes either.
  for (const command of ["observe.status", "journal.stats", "journal.window", "editor.get_state"]) {
    assert.equal(byCommand.get(command)?.kind, "read", `${command} must stay a read`);
  }
});
