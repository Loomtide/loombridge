/**
 * S7c — `loombridge --version` runtime stamp. The signal that catches a stale frozen
 * runtime: it must print the installed build (version + commit/build stamp) and exit 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loombridgeCli } from "../cli.js";

async function captureVersion(arg: string): Promise<{ code: number; out: string }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loombridgeCli(["node", "cli.js", arg]);
  } finally {
    console.log = orig;
  }
  return { code, out: lines.join("\n") };
}

test("loombridge --version prints a semver build line and exits 0", async () => {
  const { code, out } = await captureVersion("--version");
  assert.equal(code, 0);
  // e.g. "loombridge 0.1.0 (abc1234, built 2026-...)" or "...(dev)"
  assert.match(out, /^loombridge \d+\.\d+\.\d+ \(.+\)$/m);
});

test("-v and 'version' are aliases (exit 0)", async () => {
  for (const alias of ["-v", "version"]) {
    const { code, out } = await captureVersion(alias);
    assert.equal(code, 0, `alias ${alias} should exit 0`);
    assert.match(out, /^loombridge /m);
  }
});
