/**
 * WHAT ELSE A HUMAN COULD BE APPROVING, when bare `loombridge approve` has no replay run.
 *
 * `approve` was promoted to a top-level verb because approving is one of only TWO human acts
 * in the ratchet loop (the other is demonstrating). Promotion costs something: there are four
 * approve surfaces in this product (`trace approve`, `minigame baseline approve`,
 * `feel snapshot approve`, `target approve`), and a bare verb resolves to exactly one of them,
 * the replay baseline, because that is overwhelmingly the common one.
 *
 * THE AMBIGUITY IS PAID FOR AT THE ONE MOMENT IT COULD BITE. When there IS a replay run, the
 * pick is obvious and nothing here runs. When there is NOT, the operator who typed `approve`
 * meant SOMETHING, and guessing which of the other three would be the worst possible answer:
 * an approval nobody consented to is exactly the artifact this product exists to refuse. So
 * the verb refuses and NAMES what it can actually see on disk, turning an ambiguity into a
 * visible choice.
 *
 * DETECTED, NEVER LISTED. Every entry below is reached by asking the owning capability where
 * its artifact lives (`designStatus`, `feelPaths`) rather than by re-spelling a path here: a
 * hand-maintained list of directories is the "declared path nothing walks" shape CLAUDE.md
 * names as this repo's most expensive failure class, and here it would fail in the worst
 * direction, telling an operator to approve something that is not there.
 *
 * NO INTERACTIVE PROMPT, ever. This verb runs in CI and in non-interactive agent sessions;
 * a prompt would hang both.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loombridgePaths } from "../../domain/state.js";
import { projectWorkspace, sanitizeWorkspaceId } from "../../domain/workspace-paths.js";
import { feelPaths } from "../feel/feel-workspace.js";
import { designStatus } from "../verification/design.js";

/** One other approvable artifact, visible on disk right now. */
export interface ApprovableAlternative {
  /** The exact command that approves it, runnable as printed. */
  command: string;
  /** What that command would freeze, in one clause. */
  what: string;
  /** Where the evidence sits (absolute, or project-relative when it is inside the project). */
  where: string;
}

/** True when `dir` exists and is a directory holding at least one entry. */
async function nonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * The approvable artifacts OTHER than the replay baseline that are visible from `root`.
 *
 * Never throws: this runs inside a refusal path, and a detector that blew up would replace a
 * useful "here is what else you could mean" with a stack trace about the thing the operator
 * did NOT ask for.
 *
 * `minigame baseline approve` is deliberately absent. It takes `--contract` and `--captures`
 * pointing at a workspace this verb was never told about, so there is nothing on disk to
 * detect from a project root; the caller names it as prose instead of pretending to have
 * looked.
 */
export async function approvableAlternatives(root: string): Promise<ApprovableAlternative[]> {
  const found: ApprovableAlternative[] = [];
  const paths = loombridgePaths(root);

  // The Design Target hero shot. Offered when a target EXISTS but is not a ready one: a
  // `draft` waiting for the human gate, or an `approved` one whose bytes no longer match the
  // freeze (a re-approve is the only way back). A `missing` target has nothing to approve.
  try {
    const design = await designStatus(paths);
    if (design.status !== "missing" && !(design.status === "approved" && design.frozenMatches)) {
      found.push({
        command: "loombridge target approve",
        what:
          design.status === "approved"
            ? "the Design Target hero shot, whose bytes no longer match the freeze"
            : "the Design Target hero shot, still a draft",
        where: path.relative(root, paths.design) || paths.design,
      });
    }
  } catch {
    // A design directory we cannot read is not an alternative we can honestly offer.
  }

  // A staged tuning-snapshot candidate. It lives in the per-project WORKSPACE, outside the
  // repo, and the id is derived exactly the way `feel snapshot` derives it with no --workspace
  // typed, so the path printed here is the one that verb would use.
  try {
    const wsId = sanitizeWorkspaceId(path.basename(path.resolve(root)));
    if (wsId) {
      const candidateDir = feelPaths(projectWorkspace(wsId)).snapshotCandidateDir;
      if (await nonEmptyDir(candidateDir)) {
        found.push({
          command: "loombridge feel snapshot approve",
          what: "a staged tuning-snapshot candidate (the measured-behavior lockfile)",
          where: candidateDir,
        });
      }
    }
  } catch {
    // Same rule: an unreadable workspace is not an offer.
  }

  return found;
}

/**
 * The refusal `approve` prints when there is no replay run to promote: what it looked for,
 * the loop that produces one, and every other approvable thing it can actually see.
 *
 * Returned as lines rather than printed so the caller owns the stream (stderr) and so the
 * guard can assert on the text without capturing console.
 */
export function approveRefusalLines(args: {
  tag: string;
  /** Where reports were looked for, as the operator would type it. */
  reportsDir: string;
  alternatives: ApprovableAlternative[];
}): string[] {
  const { tag, reportsDir, alternatives } = args;
  const lines = [
    `${tag} nothing to approve: no replay run in ${reportsDir}/.`,
    `${tag}   bare \`approve\` freezes the REPLAY BASELINE (the frames a run captured). Produce one:`,
    `${tag}     loombridge record          a human demonstrates the flow`,
    `${tag}     loombridge verify --live   drives it and captures the frames`,
    `${tag}     loombridge approve         freezes what that run captured`,
    `${tag}   or name a run yourself with --id <id>.`,
  ];
  if (alternatives.length > 0) {
    lines.push(
      `${tag}   OTHER approvable artifacts are present here, and \`approve\` never resolves to them.`,
    );
    lines.push(`${tag}   Approve one by name:`);
    for (const alt of alternatives) {
      lines.push(`${tag}     ${alt.command}`);
      lines.push(`${tag}       ${alt.what} (${alt.where})`);
    }
  } else {
    lines.push(
      `${tag}   No other approvable artifact is visible here either (checked: the Design Target ` +
        "hero shot, a staged feel-snapshot candidate).",
    );
  }
  lines.push(
    `${tag}   A mini-game baseline is approved by \`loombridge minigame baseline approve --contract ` +
      "<c> --captures <d>\`: it names its own workspace, so nothing here can discover one for you.",
  );
  return lines;
}
