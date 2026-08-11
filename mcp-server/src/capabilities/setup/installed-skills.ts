/**
 * What skills a PROJECT actually has, read from disk.
 *
 * Implements the inventory half of Docs/Design/SkillRouting.md. The defect it exists to fix: with
 * 13 skills sitting in a project's `.claude/skills/`, `plan` told the agent
 * "(none ships for this slice)" for all 18 slices of both 3D packs. An agent told nothing exists
 * does not go looking, which is how a delivered, well-written skill stayed invisible through an
 * entire real 3D build.
 *
 * THE PROJECT IS THE AUTHORITY, not the payload bundled with this CLI. `agent-surface/` is what
 * the CLI COULD offer; `.claude/skills/` is what the agent can actually open. A user may have
 * declined `install-agent`, or removed a skill. Reading the payload would reproduce the same class
 * of lie in the opposite direction: claiming a skill is available when the project does not have
 * it.
 *
 * INVENTORY, NOT JUDGMENT. This reports names. It does not rank, score, or select, and nothing
 * here may reach `verify` or `doneness`. Matching is the agent's job: both Claude and Codex select
 * on `description` front matter natively, and those descriptions are already written as trigger
 * conditions.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Both install roots, because `install-agent` writes skills to BOTH `.claude/skills/` and
 * `.codex/skills/` and a project may retain only one (a Codex-only user who deleted `.claude/`
 * still has skills its agent can open). The union is what "the agent can open" actually means.
 */
const SKILL_ROOTS = [
  path.join(".claude", "skills"),
  path.join(".codex", "skills"),
] as const;

/**
 * Skill names installed in `projectRoot`, sorted and de-duplicated.
 *
 * Returns `[]` rather than throwing for every absent/unreadable case. A project without
 * `install-agent` genuinely has no skills, and that is a supported configuration whose correct
 * rendering is the generic-ops wording, not an error.
 */
export function readInstalledSkills(projectRoot: string): string[] {
  const found = new Set<string>();
  for (const rel of SKILL_ROOTS) {
    const dir = path.join(projectRoot, rel);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // A skill is a DIRECTORY holding SKILL.md. Requiring the file keeps stray files and empty
      // directories out of a list the agent is told it can open. `statSync` rather than
      // `withFileTypes`, so a symlinked skill (the dev-repo layout) resolves instead of being
      // skipped as a non-directory.
      const skillDoc = path.join(dir, name, "SKILL.md");
      try {
        if (statSync(skillDoc).isFile()) found.add(name);
      } catch {
        // Not a skill directory. Skip silently: this is a listing, not a validator.
      }
    }
  }
  return [...found].sort();
}
