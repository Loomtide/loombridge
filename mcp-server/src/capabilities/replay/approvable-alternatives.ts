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
import { SNAPSHOT_CONTRACT_FILE, SNAPSHOT_MEASUREMENTS_FILE } from "../feel/snapshot-manifest.js";
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

/**
 * What the detectors managed to do, so the refusal can state a check it really performed.
 *
 * `checked` and `unchecked` are DISJOINT and together name every detector, so "we looked and
 * found nothing" and "we could not look" can never print as the same sentence. The old
 * refusal said `(checked: the Design Target hero shot, a staged feel-snapshot candidate)`
 * from a hard-coded string, while both detectors swallowed their errors: an unreadable design
 * directory produced a claim to have checked it.
 */
export interface ApprovableAlternativesResult {
  found: ApprovableAlternative[];
  /** Human names of the detectors that completed (whether or not they found anything). */
  checked: string[];
  /** Human names of the detectors that could NOT complete, each with its reason. */
  unchecked: { what: string; why: string }[];
}

const DESIGN_TARGET_DETECTOR = "the Design Target hero shot";
const FEEL_CANDIDATE_DETECTOR = "a staged feel-snapshot candidate";

/** True when every named file exists under `dir`. */
async function hasAll(dir: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    try {
      await fs.access(path.join(dir, file));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The approvable artifacts OTHER than the replay baseline that are visible from `root`.
 *
 * Never throws: this runs inside a refusal path, and a detector that blew up would replace a
 * useful "here is what else you could mean" with a stack trace about the thing the operator
 * did NOT ask for. A detector that failed is REPORTED as unchecked rather than silently
 * counted as "looked, found nothing".
 *
 * DETECTION REQUIRES THE ARTIFACT, NOT A DIRECTORY. The feel probe used to accept any
 * non-empty directory, so a lone `.DS_Store` (or a candidate dir a previous capture created
 * and then failed to fill) made the refusal advertise `loombridge feel snapshot approve` for
 * a candidate that does not exist: the operator runs the command this text handed them and
 * gets a second refusal. The files it looks for are the two `feel snapshot approve` itself
 * refuses without, named by the owning capability's own constants.
 *
 * `minigame baseline approve` is deliberately absent. It takes `--contract` and `--captures`
 * pointing at a workspace this verb was never told about, so there is nothing on disk to
 * detect from a project root; the caller names it as prose instead of pretending to have
 * looked.
 */
export async function approvableAlternatives(
  root: string,
  opts: {
    /**
     * The resolved workspace DIRECTORY to look in, overriding the one derived from the
     * project folder name.
     *
     * Injectable for the same reason `discoverVerificationAssets` takes `workspacesRoot`:
     * without it the only reachable workspace is the one under the real `$HOME`, so the
     * detector below would either be untested or "tested" against a directory the shipped
     * code never reads. Production omits it and derives, which is the path the tests then
     * exercise separately through the derivation itself.
     */
    workspace?: string;
  } = {},
): Promise<ApprovableAlternativesResult> {
  const found: ApprovableAlternative[] = [];
  const checked: string[] = [];
  const unchecked: { what: string; why: string }[] = [];
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
    checked.push(DESIGN_TARGET_DETECTOR);
  } catch (error) {
    // A design directory we cannot read is not an alternative we can honestly offer, AND it
    // is not a check we may claim to have made.
    unchecked.push({ what: DESIGN_TARGET_DETECTOR, why: message(error) });
  }

  // A staged tuning-snapshot candidate. It lives in the per-project WORKSPACE, outside the
  // repo, and the id is derived exactly the way `feel snapshot` derives it with no --workspace
  // typed, so the path printed here is the one that verb would use.
  try {
    const derivedFrom = path.basename(path.resolve(root));
    const wsId = sanitizeWorkspaceId(derivedFrom);
    const workspace = opts.workspace ?? (wsId === undefined ? undefined : projectWorkspace(wsId));
    if (workspace === undefined) {
      // No derivable workspace id means there is no directory to look in, which is a gap in
      // the LOOK rather than an answer about what is on disk.
      unchecked.push({
        what: FEEL_CANDIDATE_DETECTOR,
        why: `no workspace id derives from the project folder name '${derivedFrom}'`,
      });
    } else {
      const candidateDir = feelPaths(workspace).snapshotCandidateDir;
      if (await hasAll(candidateDir, [SNAPSHOT_MEASUREMENTS_FILE, SNAPSHOT_CONTRACT_FILE])) {
        found.push({
          command: "loombridge feel snapshot approve",
          what: "a staged tuning-snapshot candidate (the measured-behavior lockfile)",
          where: candidateDir,
        });
      }
      checked.push(FEEL_CANDIDATE_DETECTOR);
    }
  } catch (error) {
    // Same rule: an unreadable workspace is not an offer, and not a check either.
    unchecked.push({ what: FEEL_CANDIDATE_DETECTOR, why: message(error) });
  }

  return { found, checked, unchecked };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  alternatives: ApprovableAlternativesResult;
}): string[] {
  const { tag, reportsDir } = args;
  const { found, checked, unchecked } = args.alternatives;
  const lines = [
    `${tag} nothing to approve: no replay run in ${reportsDir}/.`,
    `${tag}   bare \`approve\` freezes the REPLAY BASELINE (the frames a run captured). Produce one:`,
    `${tag}     loombridge record          a human demonstrates the flow`,
    `${tag}     loombridge verify --live   drives it and captures the frames`,
    `${tag}     loombridge approve         freezes what that run captured`,
    `${tag}   or name a run yourself with --id <id>.`,
  ];
  if (found.length > 0) {
    lines.push(
      `${tag}   OTHER approvable artifacts are present here, and \`approve\` never resolves to them.`,
    );
    lines.push(`${tag}   Approve one by name:`);
    for (const alt of found) {
      lines.push(`${tag}     ${alt.command}`);
      lines.push(`${tag}       ${alt.what} (${alt.where})`);
    }
  } else if (checked.length > 0) {
    // THE CLAIM NAMES THE CHECKS THAT REALLY RAN. It used to name both detectors from a
    // hard-coded string while both swallowed their errors, so a detector that threw was
    // reported as one that looked and found nothing.
    lines.push(
      `${tag}   No other approvable artifact is visible here either (checked: ${checked.join(", ")}).`,
    );
  }
  // A DETECTOR THAT COULD NOT LOOK SAYS SO, whether or not the others found something. An
  // unreported gap here reads as "there is nothing else", which is the one thing this list
  // must never imply about a place it never managed to open.
  for (const gap of unchecked) {
    lines.push(`${tag}   NOT checked: ${gap.what} (${gap.why}).`);
  }
  lines.push(
    `${tag}   A mini-game baseline is approved by \`loombridge minigame baseline approve --contract ` +
      "<c> --captures <d>\`: it names its own workspace, so nothing here can discover one for you.",
  );
  return lines;
}
