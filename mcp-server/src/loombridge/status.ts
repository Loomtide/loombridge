import path from "node:path";

import { designStatus } from "./design.js";
import { loombridgePaths, readState } from "./state.js";
import { readSlicePlan } from "./slices.js";
import { computeStatusModel, renderDetailedStatus } from "./status-model.js";

export interface StatusArgs {
  root: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): StatusArgs | ParseHelp {
  let root = process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge status] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  return { root };
}

export async function runStatus(args: StatusArgs): Promise<number> {
  const paths = loombridgePaths(args.root);
  try {
    const [state, plan, design] = await Promise.all([
      readState(paths),
      readSlicePlan(paths),
      designStatus(paths),
    ]);
    const model = await computeStatusModel({ paths, state, plan, design });
    renderDetailedStatus(model);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge status] ${message}`);
    return 2;
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge status [options]",
      "",
      "Read-only progress summary for the slice pipeline. It never scaffolds,",
      "writes state, approves slices, captures, verifies, or builds.",
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
  return runStatus(parsed);
}
