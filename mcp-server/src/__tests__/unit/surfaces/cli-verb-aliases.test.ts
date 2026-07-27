/**
 * Deprecated CLI verb aliases (CommandSurfaceRedesign §4 / §1.3).
 *
 * Two verbs changed meaning on the agent surface without changing meaning for a script:
 *
 *  - `design` -> `target`. The verb FREEZES the hero shot; it never designed the game, and the old
 *    name collided with the RFC's proposed game-design stage.
 *  - `ask` was retired as a slash command — it rendered the same `status-model` facts in a second
 *    voice — but the verb stays.
 *
 * Both are published, so both keep working. This guards the two properties that make an alias an
 * alias rather than a slow break: it reaches the SAME handler, and it SAYS it is deprecated.
 *
 * The notice must be on STDERR. These verbs print machine-readable status to stdout, so a
 * deprecation line there would corrupt anything parsing it — the alias would then break the exact
 * scripts it exists to protect.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loombridgeCli } from "../../../surfaces/cli.js";
// Depth-independent root — never count `..` segments (CLAUDE.md); re-nesting this file would
// silently point them at the wrong tree.
import { REPO_ROOT } from "../../_support/paths.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-alias-"));
}

/** Run the CLI, capturing stdout and stderr separately — the split is the point. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const outLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loombridgeCli(["node", "cli.js", ...argv]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

test("`design` is an alias of `target`: same exit, same stdout, plus a deprecation notice", async () => {
  const root = await tmpRoot();
  try {
    const canonical = await capture(["target", "status", "--root", root]);
    const alias = await capture(["design", "status", "--root", root]);

    // Same handler: identical exit code AND identical stdout on the same project state. If the
    // alias were wired to anything else, or dropped, one of these diverges.
    assert.equal(alias.code, canonical.code, "alias must exit like the canonical verb");
    assert.equal(alias.out, canonical.out, "alias must produce identical stdout");

    // ...and it must announce itself, or it is a silent rename that nobody migrates off.
    assert.match(alias.err, /DEPRECATED/);
    assert.match(alias.err, /loombridge target/, "the notice must name the replacement");
    assert.doesNotMatch(canonical.err, /DEPRECATED/, "the canonical verb must NOT warn");

    // LITMUS on the stream: the notice is on stderr, so stdout stays parseable.
    assert.doesNotMatch(alias.out, /DEPRECATED/, "the notice must never reach stdout");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("`ask` still works and announces its retirement from the agent surface", async () => {
  const root = await tmpRoot();
  try {
    const { code, out, err } = await capture(["ask", "--root", root, "where", "are", "we"]);
    // Still functional — retiring the slash command must not break a scripted verb.
    assert.ok(code === 0 || code === 1, `ask must still run, got exit ${code}`);
    assert.match(err, /DEPRECATED/);
    assert.match(err, /loombridge status/, "the notice must point at the surviving surface");
    assert.doesNotMatch(out, /DEPRECATED/, "the notice must never reach stdout");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the retired commands are gone from the plugin manifest, with no orphan wrappers", async () => {
  // The agent-surface half of the retirement. `shim-parity.test.ts` walks plugin.commands and
  // requires a wrapper for each, so it catches a command left WITHOUT a wrapper; nothing catches a
  // wrapper left behind for a command that no longer exists. This does.
  const plugin = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { commands: string[] };

  for (const retired of ["ask", "e2e"]) {
    assert.ok(
      !plugin.commands.some((c) => c.endsWith(`/${retired}.md`)),
      `${retired} must be off the agent surface`,
    );
    const wrapper = path.join(REPO_ROOT, "scripts", `loombridge-${retired}`);
    assert.equal(
      await fs.stat(wrapper).then(() => true).catch(() => false),
      false,
      `orphan Codex wrapper left behind: scripts/loombridge-${retired}`,
    );
  }

  // The walkthrough was MOVED, not deleted — its content is still guarded by shim-parity.
  await fs.access(path.join(REPO_ROOT, "Docs", "E2E-Walkthrough.md"));
});
