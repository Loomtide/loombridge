#!/usr/bin/env node
/**
 * build-agent-surface — assemble the SCRUBBED consumer payload that ships with
 * @loomtide/cli and is installed into a partner project by `loomtide install-agent`.
 *
 * Source of truth: commands/loomtide/*.md (Claude command bodies) + the CONSUMER_SKILLS
 * from agent-surface-lib.mjs. Every .md is scrubbed through the SAME scrubContent the
 * global install (loomtide-install-locally.sh) uses — one scrubber, no drift.
 *
 * Output (generated, git-ignored, never committed — same pattern as mcp-server/bridge/):
 *   mcp-server/agent-surface/commands/loomtide/<name>.md
 *   mcp-server/agent-surface/skills/<name>/**
 *
 * Wired into `prepack` so `npm pack` bundles it; listed in package.json "files".
 * The install-time managed-marker is NOT baked in here — install-agent.ts injects it so
 * the payload stays pure scrubbed content and the marker is an install concern.
 *
 *   node scripts/build-agent-surface.mjs            # write the payload
 *   node scripts/build-agent-surface.mjs --check    # verify the payload is up to date
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONSUMER_SKILLS, scrubContent } from "./agent-surface-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "mcp-server", "agent-surface");
const COMMANDS_SRC = path.join(REPO_ROOT, "commands", "loomtide");
const SKILLS_SRC = path.join(REPO_ROOT, ".skills");

/** Collect every planned (relPathInPayload, scrubbedContent) pair. */
function plannedFiles() {
  const files = [];

  // Commands: commands/loomtide/*.md -> agent-surface/commands/loomtide/*.md
  for (const name of fs.readdirSync(COMMANDS_SRC).filter((f) => f.endsWith(".md")).sort()) {
    const raw = fs.readFileSync(path.join(COMMANDS_SRC, name), "utf8");
    files.push({ rel: path.join("commands", "loomtide", name), content: scrubContent(raw) });
  }

  // Skills: .skills/<name>/** -> agent-surface/skills/<name>/** (every file scrubbed).
  for (const skill of CONSUMER_SKILLS) {
    const skillRoot = path.join(SKILLS_SRC, skill);
    if (!fs.existsSync(skillRoot)) throw new Error(`consumer skill missing: ${skillRoot}`);
    for (const abs of walkFiles(skillRoot)) {
      const relInSkill = path.relative(skillRoot, abs);
      const raw = fs.readFileSync(abs, "utf8");
      files.push({ rel: path.join("skills", skill, relInSkill), content: scrubContent(raw) });
    }
  }
  return files;
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(abs);
    else if (entry.isFile()) yield abs;
  }
}

function main() {
  const check = process.argv.includes("--check");
  const files = plannedFiles();

  if (check) {
    const drifted = [];
    for (const f of files) {
      const abs = path.join(OUT_DIR, f.rel);
      let current = null;
      try {
        current = fs.readFileSync(abs, "utf8");
      } catch {
        /* missing -> drift */
      }
      if (current !== f.content) drifted.push(f.rel);
    }
    if (drifted.length) {
      console.error("[build-agent-surface] payload out of date:");
      for (const r of drifted) console.error(`  - ${r}`);
      console.error("Run `node scripts/build-agent-surface.mjs`.");
      process.exit(1);
    }
    console.error(`[build-agent-surface] OK — ${files.length} payload files current.`);
    return;
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  for (const f of files) {
    const abs = path.join(OUT_DIR, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
  }
  console.error(`[build-agent-surface] wrote ${files.length} scrubbed payload files to mcp-server/agent-surface/.`);
}

main();
