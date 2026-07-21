#!/usr/bin/env node
/**
 * agent-surface-lib — the SINGLE scrubbing implementation + the SINGLE consumer-skill
 * list, shared by every path that assembles Loomtide's agent-facing surface.
 *
 * Two importers, one source of truth (no duplicated sed / no duplicated skill list):
 *   - scripts/build-agent-surface.mjs  (imports scrubContent + CONSUMER_SKILLS to
 *     assemble the CONSUMER payload mcp-server/agent-surface/ shipped with @loomtide/cli)
 *   - scripts/loomtide-install-locally.sh  (shells out to this file's CLI: `--list-skills`
 *     for the skill set and `--scrub` per file — the bash `rewrite()`/`CONSUMER_SKILLS`
 *     were deleted so there is exactly one scrubber and one list)
 *
 * The anti-drift test (install-agent.test.ts) imports this module and asserts both
 * importers reference it, so the two paths can never diverge.
 *
 * SCRUBBING replaces dev-repo invocations with the released `loomtide*` binaries,
 * generalizes/removes dev-repo absolute paths (so a hand-baked `/Users/.../Loomtide`
 * path or a `$REPO`-expanded one is stripped regardless of checkout location — the old
 * bash rewrite only handled the live `$REPO`, which silently missed committed absolute
 * paths when run from a worktree), and elides internal roadmap-directory references (the
 * private planning notes a consumer project never receives).
 */

import process from "node:process";

/**
 * Consumer-facing skills only. Dev-time workflows (new-unity-test-project, session-retro,
 * genre-pack-authoring, generated-3d-art-integration, and the perf/sfx/ui authoring packs)
 * are intentionally excluded from the surface a partner project receives.
 */
export const CONSUMER_SKILLS = [
  "asset-layer",
  "game-polish-2d",
  "parallax-2d",
  "platformer-level-design",
  "unity-2d-game",
  "verify-2d-game",
];

/**
 * The ordered scrub rules. `dataDir`/`rtMcp` locate the installed asset-layer + frozen
 * runtime for the target; everything else is target-independent. Order matters: more
 * specific patterns run before the generic ones they would otherwise be shadowed by.
 */
function scrubRules(dataDir, rtMcp) {
  return [
    // Dev-repo ABSOLUTE node invocations (any /abs/prefix/node <abs>/mcp-server/dist/...).
    [/(?:\S*\/)?node\s+\S*\/mcp-server\/dist\/verification\/capture-runner\.js/g, "loomtide-capture"],
    [/(?:\S*\/)?node\s+\S*\/mcp-server\/dist\/verification\/analyze-frames\.js/g, "loomtide-analyze-frames"],
    [/(?:\S*\/)?node\s+\S*\/mcp-server\/dist\/asset-layer\/handoff-consistency\.js/g, "loomtide-handoff-check"],
    // Dev-repo RELATIVE node invocations -> released binaries.
    [/node mcp-server\/dist\/cli\.js/g, "loomtide"],
    [/node mcp-server\/dist\/verification\/capture-runner\.js/g, "loomtide-capture"],
    [/node mcp-server\/dist\/verification\/tuning-runner\.js/g, "loomtide-tune"],
    [/node mcp-server\/dist\/asset-layer\/handoff-consistency\.js/g, "loomtide-handoff-check"],
    [/node mcp-server\/dist\/verification\/analyze-frames\.js/g, "loomtide-analyze-frames"],
    // prepare-project-assets.sh, in any form (relative, $REPO-relative, or a committed
    // absolute path) -> the released wrapper.
    [/(?:\S*\/)?scripts\/prepare-project-assets\.sh/g, "loomtide-asset-prep"],
    // Legacy `cd <abs>/mcp-server` into the dev repo -> a no-op comment.
    [/cd \S*\/mcp-server(?=\s|$)/g, ": # (legacy cd into dev repo removed by loomtide install)"],
    // $REPO-relative wrapper paths (defensive; collapse any path prefix to the binary).
    [/\S*\/loomtide-asset-prep/g, "loomtide-asset-prep"],
    [/\S*\/loomtide-capture/g, "loomtide-capture"],
    [/\S*\/loomtide-tune/g, "loomtide-tune"],
    [/\S*\/loomtide-handoff-check/g, "loomtide-handoff-check"],
    [/\S*\/loomtide-analyze-frames/g, "loomtide-analyze-frames"],
    [/\S*\/loomtide-mcp/g, "loomtide-mcp"],
    // Asset-layer data + frozen-runtime paths relocate to the install target.
    [/asset-layer\/profiles\//g, `${dataDir}/asset-layer/profiles/`],
    [/asset-layer\/registry\//g, `${dataDir}/asset-layer/registry/`],
    [/mcp-server\/src\/verification\/scenarios\//g, `${rtMcp}/src/verification/scenarios/`],
    // Bare (no `node ` prefix) dev binary references that still name the dist path.
    [/mcp-server\/dist\/verification\/tuning-runner\.js/g, "loomtide-tune"],
    // Internal schemas/types/gates -> a consumer-safe pointer at the CLI.
    [/mcp-server\/src\/verification\/acceptance\.schema\.json/g, "<internal schema — validated by `loomtide plan`>"],
    [/mcp-server\/src\/verification\/vlm-review\.schema\.json/g, "<internal schema — validated by `loomtide verify --vlm`>"],
    [/mcp-server\/src\/verification\/types\.ts/g, "<internal types — see `loomtide verify --help`>"],
    [/mcp-server\/src\/verification\/gates\//g, "<internal — see `loomtide verify --help`>"],
    // GENERAL catch (LAST, after every specific binary/schema rule so it never shadows
    // them): any remaining internal mcp-server/(src|dist)/… path — e.g. genre-pack internals
    // referenced in prose — collapses to a consumer-safe pointer. This is the backstop that
    // keeps dev-repo layout from leaking through a rule nobody wrote.
    [/mcp-server\/(?:src|dist)\/[^\s`)\]]*/g, "<internal — see `loomtide --help`>"],
    // Dev Unity-project paths -> consumer-neutral references (specific before generic).
    [/unity-projects\/demo-platformer\/Assets\/Scripts\/[A-Za-z0-9_]*\.cs/g, "<internal — script body is reproduced verbatim above>"],
    [/unity-projects\/demo-platformer\/Assets\/Audio/g, "the project's Assets/Audio"],
    [/unity-projects\/<project>\/Assets/g, "the Unity project's Assets"],
    [/unity-projects\/[a-zA-Z0-9_-]*\/Assets/g, "the Unity project's Assets"],
    [/unity-projects\/tiderunner-clean/g, "<unity-project>"],
    [/unity-projects\/switchyard-courier-clean/g, "<unity-project>"],
    [/unity-projects\/[a-zA-Z0-9_-]*-clean/g, "<unity-project>"],
    // Internal planning references (links first, then bare paths).
    [/\[([^\]]*)\]\(\.\.\/\.\.\/\.planning\/[^)]*\)/g, "$1 (internal Loomtide roadmap — out of scope for consumers)"],
    [/\.planning\/design\/[a-zA-Z0-9/_-]*/g, "<design-annotation-mock>"],
    [/\.planning\/[a-zA-Z0-9/_.-]*\.md/g, "<internal planning ref>"],
  ];
}

/**
 * Scrub one file's text. `dataDir`/`rtMcp` default to a machine-neutral `~/.loomtide`
 * layout (used for the shipped consumer payload); loomtide-install-locally.sh passes the
 * expanded absolute home paths for its global ~/.claude install.
 */
export function scrubContent(text, { dataDir = "~/.loomtide", rtMcp = "~/.loomtide/runtime/mcp-server" } = {}) {
  // Normalize to LF first. A Windows checkout can hold CRLF in the source commands/skills
  // (git reports them clean under core.autocrlf=input), and copying those bytes verbatim
  // would ship a CRLF agent surface. The install ledger hashes the bytes written, so a
  // CRLF payload makes every file look hand-edited to a teammate who checked out LF.
  let out = text.replace(/\r\n/g, "\n");
  for (const [re, rep] of scrubRules(dataDir, rtMcp)) out = out.replace(re, rep);
  // Drop standalone `npm run build` lines — the frozen runtime ships prebuilt dist.
  out = out
    .split("\n")
    .filter((line) => line.trim() !== "npm run build")
    .join("\n");
  return out;
}

// ── CLI (used by loomtide-install-locally.sh; bash cannot import an ES module) ──
function cliMain(argv) {
  if (argv.includes("--list-skills")) {
    process.stdout.write(`${CONSUMER_SKILLS.join(" ")}\n`);
    return;
  }
  if (argv.includes("--scrub")) {
    const dataDir = argValue(argv, "--data-dir") ?? undefined;
    const rtMcp = argValue(argv, "--rt-mcp") ?? undefined;
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => {
      const opts = {};
      if (dataDir) opts.dataDir = dataDir;
      if (rtMcp) opts.rtMcp = rtMcp;
      process.stdout.write(scrubContent(Buffer.concat(chunks).toString("utf8"), opts));
    });
    return;
  }
  process.stderr.write("usage: agent-surface-lib.mjs (--list-skills | --scrub [--data-dir D] [--rt-mcp M])\n");
  process.exitCode = 2;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// Run as a CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2));
}
