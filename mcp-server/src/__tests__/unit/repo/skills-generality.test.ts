import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;
const skillsRoot = path.join(repoRoot, ".skills");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

test("generic skills do not leak Tiderunner-specific taste constants", async () => {
  const banned = [
    /Tiderunner/i,
    /Press Start 2P/i,
    /#ffd166/i,
    /#4dd0e1/i,
    /52\/32\/18/i,
    /fruit-arc/i,
    /Ninja Frog/i,
    /Super Meat Boy/i,
  ];
  const findings: string[] = [];

  for await (const file of walk(skillsRoot)) {
    const text = await fs.readFile(file, "utf-8");
    for (const pattern of banned) {
      if (pattern.test(text)) {
        findings.push(`${path.relative(repoRoot, file)} matched ${pattern}`);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Move game-specific taste to the game brief/acceptance contract:\n${findings.join("\n")}`,
  );
});
