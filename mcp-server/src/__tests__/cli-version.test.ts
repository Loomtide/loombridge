/**
 * S7c — `loomtide --version` runtime stamp. The signal that catches a stale frozen
 * runtime: it must print the installed build (version + commit/build stamp) and exit 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loomtideCli } from "../cli.js";

async function captureVersion(arg: string): Promise<{ code: number; out: string }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loomtideCli(["node", "cli.js", arg]);
  } finally {
    console.log = orig;
  }
  return { code, out: lines.join("\n") };
}

test("loomtide --version prints a semver build line and exits 0", async () => {
  const { code, out } = await captureVersion("--version");
  assert.equal(code, 0);
  // e.g. "loomtide 0.1.0 (abc1234, built 2026-...)" or "...(dev)"
  assert.match(out, /^loomtide \d+\.\d+\.\d+ \(.+\)$/m);
});

test("-v and 'version' are aliases (exit 0)", async () => {
  for (const alias of ["-v", "version"]) {
    const { code, out } = await captureVersion(alias);
    assert.equal(code, 0, `alias ${alias} should exit 0`);
    assert.match(out, /^loomtide /m);
  }
});
