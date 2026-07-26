/**
 * T0 shim parity (plan §3d / v0.6 §3d).
 *
 * For every command in `.claude-plugin/plugin.json`, we require:
 *   1. the canonical Claude command markdown exists,
 *   2. a Codex wrapper `scripts/loombridge-<name>` exists, is executable, and
 *      points its PROMPT at the SAME command markdown (one source of truth),
 *   3. the wrapper uses `codex exec --ephemeral` (the §3b fresh-process pattern),
 *   4. the wrapper carries its approval/sandbox policy INLINE
 *      (`--ask-for-approval` + `--sandbox`), NOT via a project-local profile.
 *
 * Note (a7baf5b): Codex warns on a project-local `.codex/config.toml`, so the old
 * `[profiles.loombridge-<name>]` mechanism was removed — the wrappers now carry their
 * policy inline and no `.codex/config.toml` is committed/generated (the
 * `sync-loombridge-artifacts` generator + test enforce its ABSENCE). This parity test
 * checks the committed wrappers against that same invariant.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/__tests__/ → repo root is three up.
const repoRoot = REPO_ROOT;

interface PluginManifest {
  commands: string[];
}

async function loadPlugin(): Promise<PluginManifest> {
  const raw = await fs.readFile(
    path.join(repoRoot, ".claude-plugin", "plugin.json"),
    "utf-8",
  );
  return JSON.parse(raw) as PluginManifest;
}

function commandNameFromPath(commandPath: string): string {
  // "./commands/loombridge/plan.md" → "plan"
  return path.basename(commandPath, ".md");
}

test("T0 shim parity — plugin manifest declares at least one command", async () => {
  const plugin = await loadPlugin();
  assert.ok(Array.isArray(plugin.commands) && plugin.commands.length > 0);
});

test("T0 shim parity — `build` wrapper joins ALL positional args (not just $1)", async () => {
  // `loombridge build` is the primary slice-loop entry point, but optional
  // multi-word intents (`loombridge-build add coin pickup`) remain supported.
  // Dropping everything after $1 would route/build the wrong thing.
  const wrapperPath = path.join(repoRoot, "scripts", "loombridge-build");
  let body: string;
  try {
    body = await fs.readFile(wrapperPath, "utf-8");
  } catch {
    // If the wrapper doesn't exist yet, the broader parity test will surface it.
    return;
  }
  // Anchor at line start to skip comment-line examples (`# … INTENT="…" …`).
  const intentAssignment = body.match(/^INTENT=("([^"\n]*)")/m);
  assert.ok(intentAssignment, "loombridge-build must define a top-level INTENT=…");
  const rhs = intentAssignment![2];
  // Accept any form that uses $* / $@ / ${*…} / ${@…} (the "all positional
  // args" expansions). Reject $1 / ${1:-…} (drops args 2+).
  assert.match(
    rhs,
    /\$\{?[*@]/,
    `loombridge-build INTENT must use $* or $@ to capture every positional arg; got "${rhs}"`,
  );
  assert.doesNotMatch(
    rhs,
    /^\$\{?1[^*@]/,
    `loombridge-build INTENT must NOT be a bare $1 / \${1…} (drops args 2+); got "${rhs}"`,
  );
});

test("command currency — e2e.md drives the independent hero-shot review so a design-targeted run can certify (§P0)", async () => {
  // After the §P0 moat, a design-targeted flow MUST run the independent consolidated VLM
  // (--vlm) before doneness, else doneness refuses (no reviewFindings). e2e approves a hero
  // shot, so without the VLM step the whole e2e flow dead-ends at doneness. Guard the fix.
  const e2e = await fs.readFile(path.join(repoRoot, "commands", "loombridge", "e2e.md"), "utf-8");
  assert.match(e2e, /--vlm/, "e2e.md must pass --vlm so doneness can read reviewFindings");
  assert.match(e2e, /independent/i, "e2e.md must instruct the independent hero-shot review");
  assert.match(
    e2e,
    /loombridge-embed-bridge/,
    "e2e.md must include the consumer bridge-embed pre-step (Tests/-excluded embed)",
  );
});

test("command currency — the verify-2d-game skill uses the consolidated ROOT review, not a per-state path (P1.3)", async () => {
  // P1.3 moved the VLM review to ONE consolidated `.loombridge/verify/vlm-review.json`
  // (root), so frame-integrity spans every state. A per-state `--vlm
  // .loombridge/verify/<state>/vlm-review.json` is spawn-scoped and misses that. Guard
  // the skill docs (an agent can invoke verify-2d-game directly, bypassing build/e2e).
  const docs = ["SKILL.md", path.join("references", "vlm-review.md")];
  const perStateReviewFile = /verify\/[^/"\s]+\/vlm-review\.json/; // verify/<segment>/vlm-review.json
  for (const rel of docs) {
    const body = await fs.readFile(
      path.join(repoRoot, ".skills", "verify-2d-game", rel),
      "utf-8",
    );
    assert.doesNotMatch(
      body,
      perStateReviewFile,
      `${rel}: the VLM review file must be the consolidated root .loombridge/verify/vlm-review.json, not a per-state path`,
    );
    assert.match(
      body,
      /verify\/vlm-review\.json/,
      `${rel}: must reference the consolidated root review .loombridge/verify/vlm-review.json`,
    );
  }
});

test("T0 shim parity — every Claude command has a Codex wrapper pointing at the same md", async () => {
  const plugin = await loadPlugin();
  const projectCodexConfig = await fs.stat(path.join(repoRoot, ".codex", "config.toml")).catch(() => null);
  assert.equal(projectCodexConfig, null, ".codex/config.toml must not exist; wrappers carry Codex flags inline.");

  for (const commandPath of plugin.commands) {
    const name = commandNameFromPath(commandPath);

    // 1. The Claude command markdown actually exists.
    const mdAbs = path.join(repoRoot, commandPath.replace(/^\.\//, ""));
    const mdStat = await fs.stat(mdAbs).catch(() => null);
    assert.ok(mdStat?.isFile(), `Claude command md missing: ${commandPath}`);

    // 2. The Codex wrapper exists and is executable.
    const wrapperRel = `scripts/loombridge-${name}`;
    const wrapperAbs = path.join(repoRoot, wrapperRel);
    const wrapperStat = await fs.stat(wrapperAbs).catch(() => null);
    assert.ok(wrapperStat?.isFile(), `Codex wrapper missing: ${wrapperRel}`);
    assert.ok(
      (wrapperStat!.mode & 0o111) !== 0,
      `Codex wrapper not executable: ${wrapperRel}`,
    );

    const wrapperBody = await fs.readFile(wrapperAbs, "utf-8");

    // 3. Wrapper's PROMPT references the SAME command markdown (no drift).
    const expectedRef = `commands/loombridge/${name}.md`;
    assert.ok(
      wrapperBody.includes(expectedRef),
      `${wrapperRel} must reference ${expectedRef} in its PROMPT (single source of truth).`,
    );

    // 4. Wrapper uses `codex exec --ephemeral` — the §3b fresh-process pattern.
    assert.ok(
      /codex\s+["']?exec/.test(wrapperBody) || wrapperBody.includes("exec --ephemeral"),
      `${wrapperRel} must invoke \`codex exec\` (saw no \`codex exec\` form).`,
    );
    assert.ok(
      wrapperBody.includes("--ephemeral"),
      `${wrapperRel} must pass --ephemeral (§3b fresh-process independence).`,
    );

    // 5. The wrapper carries its approval/sandbox policy INLINE (a7baf5b) — Codex
    // rejects project-local profiles, so there is no `.codex/config.toml` to point at.
    assert.ok(
      wrapperBody.includes("--ask-for-approval"),
      `${wrapperRel} must carry --ask-for-approval inline (no project-local profile).`,
    );
    assert.ok(
      wrapperBody.includes("--sandbox"),
      `${wrapperRel} must carry --sandbox inline (no project-local profile).`,
    );
  }

  // And the obsolete project-local profile file must NOT come back (the generator
  // removes it; a committed `.codex/config.toml` would re-trigger the Codex warning).
  const staleConfig = await fs.stat(path.join(repoRoot, ".codex", "config.toml")).catch(() => null);
  assert.equal(staleConfig, null, "a project-local .codex/config.toml must not be committed (a7baf5b)");
});
