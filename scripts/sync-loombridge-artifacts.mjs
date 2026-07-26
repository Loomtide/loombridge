#!/usr/bin/env node
/**
 * sync-loombridge-artifacts — the §3d anti-drift generator (plan §7 #9, §8 M2).
 *
 * The Claude command bodies in `commands/loombridge/*.md` are the single source of
 * truth. The Codex shim (per-command `scripts/loombridge-<name>` wrappers) only
 * governs INVOCATION — it must exist for every command and point Codex at the
 * SAME `.md`. Hand-maintaining that pair drifts as commands are added; this
 * generator emits it deterministically from the command list in
 * `.claude-plugin/plugin.json` + the per-command SHIM_SPEC below.
 *
 * This graduates T0 parity from "hand-maintained pair + assertions"
 * (`shim-parity.test.ts`) to "generator-backed": add a command to plugin.json +
 * SHIM_SPEC, run this, and its wrapper appears, parity-test-clean.
 *
 *   node scripts/sync-loombridge-artifacts.mjs           # write the artifacts
 *   node scripts/sync-loombridge-artifacts.mjs --check   # CI: fail if drifted
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Per-command shim metadata. `plugin.json` is the authoritative command SET; this
 * supplies each command's invocation details. A plugin command with no entry here
 * is an error (a new command must declare its shim).
 *
 * argMode: "none" (fixed prompt) | "question" (join all positional args — the ask
 * question) | "intent" (join all positional args — the build entry point) |
 * "bundle" (optional first arg — the e2e demo bundle path).
 */
const SHIM_SPEC = {
  plan: {
    summary: "loombridge plan",
    argMode: "none",
    prompt:
      "Open and follow commands/loombridge/plan.md. Establish the design target + acceptance contract in .loombridge/.",
    profileComment:
      "`plan` writes .loombridge/ and drives the judgment-heavy Design Target Phase,\n# so: workspace-write + research enabled + medium reasoning.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      model_reasoning_effort: "medium",
      web_search: "cached",
    },
  },
  status: {
    summary: "loombridge status",
    argMode: "none",
    prompt:
      "Open and follow commands/loombridge/status.md. Report read-only Loombridge progress, warnings, and the next command.",
    profileComment:
      "`status` is read-only. It runs the deterministic CLI status command and reports\n# progress/next-command/proof warnings without mutating project state.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "read-only",
      model_reasoning_effort: "low",
      web_search: "none",
    },
  },
  ask: {
    summary: "loombridge ask",
    argMode: "question",
    prompt:
      "Open and follow commands/loombridge/ask.md. Answer this read-only Loombridge workflow question from local project state:",
    profileComment:
      "`ask` is read-only. It runs the deterministic CLI explainer over local\n# .loombridge/ state; no build/capture/verify/approval actions.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "read-only",
      model_reasoning_effort: "low",
      web_search: "none",
    },
  },
  build: {
    summary: "loombridge build",
    argMode: "intent",
    prompt:
      "Open and follow commands/loombridge/build.md. Make the project match the contract for this intent:",
    profileComment:
      "`build` is the agent-facing intent router. It drives Unity through MCP, makes\n# judgment calls (feature / level / feel-tune / polish / fix-to-green), and always\n# ends in verify + doneness. Workspace-write + high reasoning + research enabled.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      model_reasoning_effort: "high",
      web_search: "cached",
    },
  },
  verify: {
    summary: "loombridge verify",
    argMode: "none",
    prompt:
      "Open and follow commands/loombridge/verify.md. Run the Tier-1 gates and report the enforced verdict.",
    profileComment:
      "`verify` is deterministic (runs the gate CLI, interprets the verdict). It writes\n# the verdict + STATE.md, so workspace-write, but needs no research and little reasoning.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      model_reasoning_effort: "low",
      web_search: "none",
    },
  },
  e2e: {
    summary: "loombridge end-to-end demo workflow",
    argMode: "bundle",
    prompt: "Open and follow commands/loombridge/e2e.md.",
    profileComment:
      "`e2e` is a demo workflow wrapper over plan/build/verify. It may touch Unity\n# projects, assets, captures, and reports, so it uses the heavier build-like\n# profile. It is not a separate product verb.",
    profile: {
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      model_reasoning_effort: "high",
      web_search: "cached",
    },
  },
};

const GENERATED_NOTE = "GENERATED by scripts/sync-loombridge-artifacts.mjs — do not edit by hand.";

// ── F2: the feel-presets starting-params table is generated from the profiles ──
// so the build-side doc can never drift from the verify-side identity.

const PROFILES_DIR = path.join(
  REPO_ROOT,
  "mcp-server",
  "src",
  "capabilities",
  "genre",
  "genre-packs",
  "platformer-2d",
  "profiles",
);
const SHIPPED_PROFILE_IDS = ["precision", "classic", "momentum"];
const FEEL_PRESETS_REL = path.join(
  ".skills",
  "unity-2d-game",
  "references",
  "feel-presets.md",
);
const STARTING_PARAMS_BEGIN =
  "<!-- BEGIN GENERATED: starting-params (scripts/sync-loombridge-artifacts.mjs) -->";
const STARTING_PARAMS_END = "<!-- END GENERATED: starting-params -->";

const UNITY_GRAVITY = 9.81;

/**
 * Mirror of resolveStartingParams (solve-params.ts) — kept tiny + pure here so the
 * generator needs no build step. Derives from the band targets; reads stored params.
 */
function resolveStartingParamsForDoc(profile) {
  const t = (id) => {
    const m = profile.metrics?.[id];
    if (!m || typeof m.target !== "number") {
      throw new Error(`${profile.id}: missing solve band '${id}'`);
    }
    return m.target;
  };
  const timeToApexSec = t("timeToApex") / 1000;
  const jumpSpeed = (2 * t("jumpApex")) / timeToApexSec;
  const gravityScale = jumpSpeed / (timeToApexSec * UNITY_GRAVITY);
  return {
    moveSpeed: t("runSpeed"),
    jumpSpeed,
    gravityScale,
    jumpCutMultiplier: profile.build?.stored?.jumpCutMultiplier,
    fixedTimestep: profile.build?.fixedTimestep,
  };
}

/** The generated starting-params markdown table (no surrounding markers). */
function startingParamsTable() {
  const rows = SHIPPED_PROFILE_IDS.map((id) => {
    const raw = fs.readFileSync(path.join(PROFILES_DIR, `${id}.profile.json`), "utf-8");
    const profile = JSON.parse(raw);
    const p = resolveStartingParamsForDoc(profile);
    const cut = p.jumpCutMultiplier === undefined ? "—" : String(p.jumpCutMultiplier);
    return `| \`${id}\` | ${p.jumpSpeed.toFixed(2)} | ${p.gravityScale.toFixed(2)} | ${p.moveSpeed} | ${cut} | ${p.fixedTimestep} |`;
  });
  return [
    "| Profile | jumpSpeed (v0) | gravityScale | moveSpeed | jumpCutMultiplier | fixedTimestep |",
    "|---------|----------------|--------------|-----------|-------------------|---------------|",
    ...rows,
  ].join("\n");
}

/**
 * Splice the generated table into feel-presets.md between the markers. Returns the
 * full file content so the anti-drift check can compare on-disk vs generated.
 */
function renderFeelPresets() {
  const abs = path.join(REPO_ROOT, FEEL_PRESETS_REL);
  const current = fs.readFileSync(abs, "utf-8");
  const begin = current.indexOf(STARTING_PARAMS_BEGIN);
  const end = current.indexOf(STARTING_PARAMS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${FEEL_PRESETS_REL}: missing the starting-params GENERATED markers — restore them and rerun.`,
    );
  }
  const before = current.slice(0, begin + STARTING_PARAMS_BEGIN.length);
  const after = current.slice(end);
  return `${before}\n${startingParamsTable()}\n${after}`;
}

function commandNamesFromPlugin() {
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"));
  if (!Array.isArray(plugin.commands)) throw new Error("plugin.json has no `commands` array.");
  return plugin.commands.map((c) => path.basename(String(c), ".md"));
}

/** The arg-handling + PROMPT block for a wrapper, per argMode. */
function promptBlock(name, spec) {
  if (spec.argMode === "intent") {
    return [
      "# Join ALL positional args so unquoted multi-word intents survive (e.g.",
      '# `loombridge-build add coin pickup` → INTENT="add coin pickup").',
      'INTENT="${*:-}"',
      `PROMPT="${spec.prompt} \${INTENT:-(no intent given — ask the user before mutating)}"`,
    ].join("\n");
  }
  if (spec.argMode === "bundle") {
    return [
      'BUNDLE="${1:-}"',
      'if [[ -z "$BUNDLE" ]]; then',
      `  PROMPT="${spec.prompt} Ask for the demo bundle path, then run the prepared end-to-end demo workflow through the real Loombridge CLI commands."`,
      "else",
      `  PROMPT="${spec.prompt} Use demo bundle: \${BUNDLE}. Run the prepared end-to-end demo workflow through the real Loombridge CLI commands."`,
      "fi",
    ].join("\n");
  }
  if (spec.argMode === "question") {
    return [
      'QUESTION="${*:-}"',
      `PROMPT="${spec.prompt} \${QUESTION:-(no question given — run the compact default explanation)}"`,
    ].join("\n");
  }
  return `PROMPT="${spec.prompt}"`;
}

function searchArgs(spec) {
  return spec.profile.web_search === "none" ? [] : ["--search"];
}

function renderWrapper(name, spec) {
  const searchLines =
    searchArgs(spec).length === 0
      ? ""
      : `if [[ "\${LOOMBRIDGE_SEARCH:-1}" == "1" ]]; then
  CODEX_ARGS+=(--search)
fi
`;
  return `#!/usr/bin/env bash
# Codex wrapper for \`${spec.summary}\` (plan §3d). ${GENERATED_NOTE}
#
# Points Codex at the SAME canonical command body Claude Code uses
# (commands/loombridge/${name}.md) — one source of truth, so the two agents cannot drift.
# \`--ephemeral\` gives a fresh \`codex\` process = genuine fresh context (§3b).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

${promptBlock(name, spec)}

CODEX_ARGS=(
  --ask-for-approval "${spec.profile.approval_policy}"
  --sandbox "${spec.profile.sandbox_mode}"
  --config 'model_reasoning_effort="${spec.profile.model_reasoning_effort}"'
)
${searchLines}CODEX_ARGS+=(exec --ephemeral)
if [[ "\${LOOMBRIDGE_JSON:-0}" == "1" ]]; then
  CODEX_ARGS+=(--json)
fi

codex "\${CODEX_ARGS[@]}" "$PROMPT"
`;
}

/** Compute the full set of (path, content, executable) artifacts. */
function plannedArtifacts() {
  const names = commandNamesFromPlugin();
  const missing = names.filter((n) => !SHIM_SPEC[n]);
  if (missing.length) {
    throw new Error(
      `plugin.json declares command(s) with no SHIM_SPEC entry: ${missing.join(", ")}. ` +
        "Add an entry to scripts/sync-loombridge-artifacts.mjs SHIM_SPEC.",
    );
  }
  const artifacts = names.map((name) => ({
    relPath: path.join("scripts", `loombridge-${name}`),
    content: renderWrapper(name, SHIM_SPEC[name]),
    executable: true,
  }));
  // F2: the feel-presets starting-params table, generated from the profile identity.
  artifacts.push({
    relPath: FEEL_PRESETS_REL,
    content: renderFeelPresets(),
    executable: false,
  });
  return artifacts;
}

/**
 * Generated Codex wrappers are extensionless `scripts/loombridge-<name>` files; the
 * hand-written helpers (install, embed-bridge, checkpoint, restore) all carry a
 * `.sh` extension. A wrapper whose `<name>` is no longer in `expectedNames` (e.g.
 * the command was removed from plugin.json) is STALE — it would linger as an
 * unintended Codex command surface. Returns the stale wrapper basenames.
 */
export function staleWrappers(scriptsDir, expectedNames) {
  const expected = new Set(expectedNames.map((n) => `loombridge-${n}`));
  let entries = [];
  try {
    entries = fs.readdirSync(scriptsDir);
  } catch {
    return [];
  }
  return entries.filter((f) => /^loombridge-[^.]+$/.test(f) && !expected.has(f));
}

function main() {
  const check = process.argv.includes("--check");
  const names = commandNamesFromPlugin();
  const artifacts = plannedArtifacts();
  const drifted = [];
  const stale = staleWrappers(path.join(REPO_ROOT, "scripts"), names);
  const staleProjectCodexConfig = path.join(REPO_ROOT, ".codex", "config.toml");

  for (const art of artifacts) {
    const abs = path.join(REPO_ROOT, art.relPath);
    if (check) {
      let current = null;
      try {
        current = fs.readFileSync(abs, "utf-8");
      } catch {
        /* missing → drift */
      }
      if (current !== art.content) drifted.push(art.relPath);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, art.content, "utf-8");
      if (art.executable) fs.chmodSync(abs, 0o755);
      console.error(`  wrote ${art.relPath}`);
    }
  }

  if (check) {
    // A stale wrapper (command removed from plugin.json but its wrapper lingers) is
    // drift too — it leaves an unintended Codex command surface.
    for (const f of stale) drifted.push(path.join("scripts", `${f} (STALE — command no longer in plugin.json)`));
    if (fs.existsSync(staleProjectCodexConfig)) {
      drifted.push(path.join(".codex", "config.toml (STALE — project-local profiles are unsupported by Codex)"));
    }
    if (drifted.length) {
      console.error("[sync-loombridge-artifacts] DRIFT — committed artifacts differ from generated:");
      for (const p of drifted) console.error(`  - ${p}`);
      console.error("Run `node scripts/sync-loombridge-artifacts.mjs` and commit.");
      process.exit(1);
    }
    console.error(`[sync-loombridge-artifacts] OK — ${artifacts.length} artifacts match the generator.`);
  } else {
    for (const f of stale) {
      fs.rmSync(path.join(REPO_ROOT, "scripts", f), { force: true });
      console.error(`  removed stale wrapper scripts/${f} (command no longer in plugin.json)`);
    }
    if (fs.existsSync(staleProjectCodexConfig)) {
      fs.rmSync(staleProjectCodexConfig, { force: true });
      console.error("  removed stale .codex/config.toml (project-local profiles are unsupported by Codex)");
    }
    console.error(`[sync-loombridge-artifacts] generated ${artifacts.length} artifacts${stale.length ? `, removed ${stale.length} stale` : ""}.`);
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

export { plannedArtifacts, renderWrapper, SHIM_SPEC, resolveStartingParamsForDoc };
