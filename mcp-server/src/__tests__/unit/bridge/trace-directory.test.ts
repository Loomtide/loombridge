import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { resolveTraceDirectory, TRACE_DIR_ENV_VAR } from "../../../bridge/trace-directory.js";

test("trace dir: a bound project writes op traces under its .loombridge/run/op-traces", () => {
  // NOT `anchors/traces` (ArtifactStorage S2 M6). The MCP server builds this recorder at
  // STARTUP, outside every CLI verb, and appends on the first op: sharing a directory with
  // the recorded human demonstrations meant an agent session re-created that directory just
  // by connecting, so no migration could ever read "the legacy directory exists" as a
  // signal, and a machine-generated op log sat beside an irreplaceable demonstration.
  const project = "/Users/dev/Games/MyGame";
  const expected = path.join(project, ".loombridge", "run", "op-traces");

  assert.equal(resolveTraceDirectory({ kind: "strict", target: project }, {}), expected);
  assert.equal(resolveTraceDirectory({ kind: "cwd", target: project }, {}), expected);
});

test("trace dir: no bound project falls back to tmp, never to the caller's cwd", () => {
  const resolved = resolveTraceDirectory({ kind: "none" }, {});

  assert.equal(resolved, path.join(os.tmpdir(), "loombridge", "traces"));
  // The regression this replaces: a cwd-relative "./trace" dumped unbounded JSONL and
  // screenshot artifacts into whatever directory the MCP client launched us from.
  assert.ok(path.isAbsolute(resolved), "fallback must be absolute, not cwd-relative");
  assert.ok(!resolved.startsWith("."), "fallback must not be a relative ./trace path");
});

test("trace dir: the env override wins over a bound project", () => {
  const override = path.join(os.tmpdir(), "explicit-trace-dir");
  const env = { [TRACE_DIR_ENV_VAR]: override };

  assert.equal(resolveTraceDirectory({ kind: "strict", target: "/Users/dev/Games/MyGame" }, env), override);
  assert.equal(resolveTraceDirectory({ kind: "none" }, env), override);
});

test("trace dir: a blank or whitespace override is ignored, not honoured as ''", () => {
  const project = "/Users/dev/Games/MyGame";
  const expected = path.join(project, ".loombridge", "run", "op-traces");

  for (const blank of ["", "   ", "\t"]) {
    assert.equal(
      resolveTraceDirectory({ kind: "strict", target: project }, { [TRACE_DIR_ENV_VAR]: blank }),
      expected,
      `a ${JSON.stringify(blank)} override must fall through, not resolve to the process cwd`,
    );
  }
});
