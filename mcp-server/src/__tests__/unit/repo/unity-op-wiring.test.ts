/**
 * THE OP WIRING IS A DECLARED PATH NOTHING WALKS (AX5).
 *
 * An op reaches Unity through a string that crosses a language boundary: the TS registry
 * publishes `"<category>.<op>"`, the C# bootstrap routes `<category>` to a handler with
 * `_executor.RegisterCategory("<category>", …)`, and that handler switches on `<op>`. No
 * compiler, and no test in either language, connects the two halves. A category registered
 * as `"replayy"`, or an op the registry advertises that no handler answers, is a runtime
 * NOT_FOUND on a live editor: the repo's own recurring blind spot (a declared path nothing
 * imports) with a Unity licence between it and discovery.
 *
 * This reads the C# as TEXT, deliberately: it cannot compile Unity, and a text check that
 * fails on the exact typo is worth more than no check at all. It is a wiring guard, not a
 * behaviour guard: the handlers' own semantics are the EditMode tests' job.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";
import { OpRegistry } from "../../../surfaces/op-registry.js";

const BRIDGE_EDITOR = path.join(
  REPO_ROOT,
  "packages",
  "com.loomtide.loombridge",
  "Editor",
);
const BOOTSTRAP = path.join(BRIDGE_EDITOR, "UnityBridgeBootstrap.cs");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/** Every `<category>` the op registry publishes a command for. */
function registryCategories(): string[] {
  const registry = new OpRegistry();
  const categories = new Set<string>();
  for (const op of registry.getAll()) {
    const dot = op.command.indexOf(".");
    assert.ok(dot > 0, `op command "${op.command}" is not '<category>.<op>'`);
    categories.add(op.command.slice(0, dot));
  }
  return [...categories].sort();
}

/** `RegisterCategory("scene", new SceneHandler())` → { scene: "SceneHandler" }. */
function registeredCategories(): Map<string, string> {
  const source = read(BOOTSTRAP);
  const found = new Map<string, string>();
  const pattern = /RegisterCategory\(\s*"([^"]+)"\s*,\s*new\s+(\w+)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    found.set(match[1]!, match[2]!);
  }
  return found;
}

test("unity op wiring: every registry category is RegisterCategory'd in UnityBridgeBootstrap.cs", () => {
  const registered = registeredCategories();
  assert.ok(
    registered.size >= 10,
    `expected the bootstrap to register the bridge's categories, parsed ${registered.size}`,
  );

  const missing = registryCategories().filter((category) => !registered.has(category));
  assert.deepEqual(
    missing,
    [],
    `these op categories are advertised by the registry but routed to nothing in C#: ${missing.join(", ")}. ` +
      "Every command with that prefix would answer NOT_FOUND against a live editor.",
  );
});

test("unity op wiring: the replay category's ops all appear in the handler the bootstrap names", () => {
  const registered = registeredCategories();
  const handlerClass = registered.get("replay");
  assert.ok(handlerClass, "the bootstrap must register the 'replay' category");

  const handlerFile = path.join(BRIDGE_EDITOR, "Handlers", `${handlerClass}.cs`);
  assert.ok(fs.existsSync(handlerFile), `the bootstrap names ${handlerClass}, which has no file at ${handlerFile}`);
  const handler = read(handlerFile);

  const registry = new OpRegistry();
  const replayOps = registry
    .getAll()
    .filter((op) => op.command.startsWith("replay."))
    .map((op) => op.command.slice("replay.".length));
  assert.ok(replayOps.includes("settle_and_capture"), "the aligned settle must be a published op");

  for (const op of replayOps) {
    assert.ok(
      handler.includes(`"${op}"`),
      `${handlerClass}.cs never mentions the op name "${op}", so a call to replay.${op} answers NOT_FOUND`,
    );
  }
});

test("unity op wiring: the observe category's ops all appear in the handler the bootstrap names", () => {
  // The stage-3 recorder is a NEW category, which is the exact shape this guard
  // exists for: three ops behind one string that no compiler in either language
  // connects. A category registered as "observer", or a `drain` the handler spells
  // `drain_and_stop`, is a NOT_FOUND against a live editor and a green suite here.
  const registered = registeredCategories();
  const handlerClass = registered.get("observe");
  assert.ok(handlerClass, "the bootstrap must register the 'observe' category");

  const handlerFile = path.join(BRIDGE_EDITOR, "Handlers", `${handlerClass}.cs`);
  assert.ok(fs.existsSync(handlerFile), `the bootstrap names ${handlerClass}, which has no file at ${handlerFile}`);
  const handler = read(handlerFile);

  const registry = new OpRegistry();
  const observeOps = registry
    .getAll()
    .filter((op) => op.command.startsWith("observe."))
    .map((op) => op.command.slice("observe.".length));
  assert.deepEqual(observeOps.sort(), ["drain", "start", "status"], "the recorder's three ops must all be published");

  for (const op of observeOps) {
    assert.ok(
      handler.includes(`case "${op}":`),
      `${handlerClass}.cs has no \`case "${op}":\`, so a call to observe.${op} answers NOT_FOUND`,
    );
  }

  // The recorder itself lives in the RUNTIME observe assembly and is reached by
  // reflection, so the type name is another string nothing checks. LITMUS: rename
  // the class and this fails.
  const pump = path.join(
    REPO_ROOT,
    "packages",
    "com.loomtide.loombridge",
    "Runtime",
    "Observe",
    "PlayStateRecorderPump.cs",
  );
  assert.ok(fs.existsSync(pump), "the play-mode state recorder must exist in the runtime observe assembly");
  assert.match(read(pump), /class PlayStateRecorderPump/, "the reflected type name must match the handler's lookup");
  assert.match(
    handler,
    /"UnityBridge\.Runtime\.PlayStateRecorderPump"/,
    "the handler must reflect the recorder by its full type name",
  );
  for (const member of [
    "BeginRecording",
    "EndRecording",
    "IsRecording",
    "GetSampleCount",
    "GetDroppedSamples",
    "GetTimesMs",
    "GetWin",
  ]) {
    assert.match(
      read(pump),
      new RegExp(`public static [\\w\\[\\]<>, ]+ ${member}\\(`),
      `the handler invokes ${member} by reflection, so the pump must expose it as a public static`,
    );
    assert.ok(handler.includes(`"${member}"`), `${handlerClass}.cs must look up ${member}`);
  }
});

test("unity op wiring: the journal category's ops all appear in the handler the bootstrap names", () => {
  // The op journal is a NEW category (evidence-trust B1): two ops behind one string
  // that no compiler in either language connects, and the ops exist so a consumer can
  // bind evidence to a run. A `journal.window` that answers NOT_FOUND would surface as
  // "this bridge is too old", which is the WRONG diagnosis and the expensive kind.
  const registered = registeredCategories();
  const handlerClass = registered.get("journal");
  assert.ok(handlerClass, "the bootstrap must register the 'journal' category");

  const handlerFile = path.join(BRIDGE_EDITOR, "Handlers", `${handlerClass}.cs`);
  assert.ok(fs.existsSync(handlerFile), `the bootstrap names ${handlerClass}, which has no file at ${handlerFile}`);
  const handler = read(handlerFile);

  const registry = new OpRegistry();
  const journalOps = registry
    .getAll()
    .filter((op) => op.command.startsWith("journal."))
    .map((op) => op.command.slice("journal.".length));
  assert.deepEqual(journalOps.sort(), ["stats", "window"], "both journal ops must be published");

  for (const op of journalOps) {
    assert.ok(
      handler.includes(`case "${op}":`),
      `${handlerClass}.cs has no \`case "${op}":\`, so a call to journal.${op} answers NOT_FOUND`,
    );
  }

  // The ring itself is reached by direct call (same assembly), but the two EXECUTOR
  // hooks are the load-bearing wiring: journaling only Execute would leave ops.batch a
  // laundering wrapper (ledger H5(a)), because a batch child reaches its handler
  // through ExecuteCommandInline and never through Execute. LITMUS: delete either
  // Append call and this fails.
  const executor = read(path.join(BRIDGE_EDITOR, "Core", "OpExecutor.cs"));
  const executeBody = executor.slice(
    executor.indexOf("public void Execute("),
    executor.indexOf("public JObject ExecuteCommandInline("),
  );
  const inlineBody = executor.slice(executor.indexOf("public JObject ExecuteCommandInline("));
  assert.ok(executeBody.length > 0 && inlineBody.length > 0, "OpExecutor must still have both entry points");
  assert.match(executeBody, /OpJournal\.Append\(/, "OpExecutor.Execute must append to the op journal");
  assert.match(
    inlineBody,
    /OpJournal\.Append\(/,
    "OpExecutor.ExecuteCommandInline must append to the op journal, or ops.batch children are invisible (H5(a))",
  );
  assert.match(
    executeBody,
    /OpJournal\.RecordEffectFrame\(/,
    "the async completion callbacks must patch the effect frame",
  );
});

test("unity op wiring: the aligned settle's pin recovery is wired into the bootstrap", () => {
  // BX7: the leaked-pin recovery is a call the bootstrap has to MAKE. Defining
  // ReplayCapturePin.RestoreLeakedPin() and never calling it would leave an editor pinned in
  // capture mode across every reload, with the recovery sitting in the package unused: the
  // "defined but not wired" shape this repo treats as a real finding.
  const bootstrap = read(BOOTSTRAP);
  assert.match(
    bootstrap,
    /ReplayCapturePin\.RestoreLeakedPin\(\)/,
    "UnityBridgeBootstrap must call ReplayCapturePin.RestoreLeakedPin() at load",
  );
  const pinSource = read(path.join(BRIDGE_EDITOR, "Handlers", "ReplayHandler.cs"));
  assert.match(pinSource, /SessionState/, "the pre-pin values must survive a domain reload (SessionState)");
  for (const key of ["Loombridge.replay.settlePin.owned"]) {
    assert.ok(
      pinSource.includes(key),
      `the SessionState key ${key} must stay namespaced under Loombridge (one flat editor-wide dictionary)`,
    );
  }
});
