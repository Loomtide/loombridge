/**
 * `loombridge reopen <sliceId>`: send a settled slice back to `stale` THROUGH THE
 * STATE MACHINE (ledger backlog item 3; E6 runbook gap).
 *
 * Before this verb, re-opening a slice was a hand edit to `.loombridge/SLICES.json`:
 * the one file whose whole job is to record what has been approved, edited by hand, in
 * a product whose thesis is that a "done" claim cannot be self-graded. The hand edit
 * also left three things undone that the CLI must do:
 *
 *  - the approval ARTIFACTS survived (`approvedAt`, `checkpointId`, the sign-off pair),
 *    so a slice could read `stale` while still carrying everything the approval seam
 *    checks: a re-approval shortcut;
 *  - the CASCADE was the editor's problem to remember, so a downstream approved slice
 *    kept certifying against evidence its upstream had just invalidated (ledger L107);
 *  - nothing recorded that it happened at all.
 *
 * The verb is deliberately TOP-LEVEL and engine-free: it resolves no Unity editor,
 * runs no design gate, and needs no build in flight. It reads SLICES.json, applies the
 * pure `reopenSlicePlan` transition, writes it back, and prints what it cost.
 */

import path from "node:path";

import { loombridgePaths, nowIso } from "../../domain/state.js";
import {
  readSlicePlan,
  reopenSlicePlan,
  writeSlicePlan,
  type ReopenTouchedSlice,
} from "./slices.js";

const TAG = "[loombridge reopen]";

export interface ReopenArgs {
  root: string;
  sliceId: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): ReopenArgs | ParseHelp {
  let root = process.cwd();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--slice") positionals.push(args[(i += 1)] ?? "");
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--")) {
      console.error(`${TAG} unknown option "${arg}".`);
      return { help: true, usageError: true };
    } else positionals.push(arg);
  }
  if (positionals.length !== 1 || !positionals[0]) {
    console.error(`${TAG} expected exactly one slice id (got ${positionals.length}).`);
    return { help: true, usageError: true };
  }
  return { root, sliceId: positionals[0] };
}

/** How a touched slice reads in the report, prior state first. */
function describeTouched(slice: ReopenTouchedSlice): string {
  const role = slice.target ? "target" : "cascade";
  const cleared =
    slice.clearedApproval.length > 0
      ? `; cleared ${slice.clearedApproval.join(", ")}`
      : "";
  // A `built` slice is mid-flight: its runId is minted, its captures may be half
  // written, and none of that survives. Say so, rather than reporting the state change
  // alone and letting the operator discover the loss at the next `verify`.
  const lost =
    slice.priorState === "built"
      ? ". IN-FLIGHT WORK LOST (its build run is no longer bound; re-run `loombridge build`)"
      : "";
  return `  ${slice.id}: ${slice.priorState} -> stale (${role})${cleared}${lost}`;
}

export async function runReopen(args: ReopenArgs): Promise<number> {
  const paths = loombridgePaths(args.root);

  let plan;
  try {
    plan = await readSlicePlan(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${TAG} ${message}`);
    return 2;
  }
  if (!plan) {
    console.error(
      `${TAG} no ${path.relative(args.root, paths.slices)}: this project has no slice roadmap to reopen. ` +
        "Run `loombridge plan` first.",
    );
    return 2;
  }

  let result;
  try {
    result = reopenSlicePlan(plan, args.sliceId, nowIso());
  } catch (error) {
    // An unsafe id never reaches the plan lookup (assertSafeSliceId throws first).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${TAG} ${message}`);
    return 2;
  }

  if (!result.ok && result.reason === "unknown-slice") {
    const known = result.knownIds.join(", ") || "(none)";
    console.error(`${TAG} unknown slice "${args.sliceId}". Known ids: ${known}.`);
    return 2;
  }
  if (!result.ok) {
    // STATED, never silent: "nothing happened" and "it worked" must not print the same.
    console.error(
      `${TAG} nothing to reopen: ${args.sliceId} is ${result.state}. ` +
        (result.state === "stale"
          ? "It is already open for a rebuild; run `loombridge build` to take it."
          : "It has never been built, so there is no approval to withdraw."),
    );
    return 0;
  }

  await writeSlicePlan(paths, result.plan);

  console.error(`${TAG} reopened ${args.sliceId}; ${result.touched.length} slice(s) changed state:`);
  for (const slice of result.touched) console.error(describeTouched(slice));
  console.error(
    `${TAG} re-verify chain (dependencies first): ${result.reverifyChain.join(" -> ")}`,
  );
  console.error(
    `${TAG} recorded history{action:reopen, cascade:[${result.touched
      .filter((s) => !s.target)
      .map((s) => s.id)
      .join(", ")}]} on ${args.sliceId} -> ${path.relative(args.root, paths.slices)}`,
  );
  console.error(`${TAG} next: run \`loombridge build\` to rebuild ${result.reverifyChain[0]}.`);
  return 0;
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge reopen <sliceId> [options]",
      "",
      "Send a settled slice back to `stale` through the state machine: the sanctioned",
      "alternative to hand-editing .loombridge/SLICES.json.",
      "",
      "It sets the target slice `stale`, CLEARS its approval artifacts (checkpointId,",
      "approvedAt, approvalNote, signoff artifact + sha) so the slice cannot be",
      "re-approved without a fresh binding verify, cascades staleness to every",
      "transitive dependent, prints each slice it touched with the state it held",
      "before, and records the event in that slice's `history`.",
      "",
      "It resolves no engine and runs no design gate: it only rewrites SLICES.json.",
      "A slice that is already `stale` or still `pending` is reported as nothing to do",
      "(exit 0, stated); an unknown slice id is refused (exit 2) naming the known ids.",
      "",
      "Options:",
      "  --root <dir>    Project root (default: cwd)",
      "  -h, --help      Show this help",
    ].join("\n"),
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  return runReopen(parsed);
}
