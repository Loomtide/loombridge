/**
 * Replay Verification CLI (Phase A, slice A4).
 *
 * `node dist/replay-cli.js --trace <path> [--out <path>] [--capture-dir <dir>]`
 *
 * Reads an action trace, connects a `UnityClient` to the running bridge, replays
 * the trace via `UnityDriver`, writes the report JSON, and exits with a status
 * code (pass=0, fail=1, blocked=2, harness error=3). This is the thin live
 * wiring over the deterministic engine; all decision logic lives in `engine.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { parseTrace } from "./loombridge/replay/index.js";
import { runLiveReplay } from "./loombridge/replay/run-live.js";

interface CliArgs {
  trace: string;
  out?: string;
  captureDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  const takeValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--trace":
        args.trace = takeValue(flag, argv[++i]);
        break;
      case "--out":
        args.out = takeValue(flag, argv[++i]);
        break;
      case "--capture-dir":
        args.captureDir = takeValue(flag, argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.trace) throw new Error("Missing required --trace <path>");
  return args as CliArgs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = JSON.parse(await fs.readFile(args.trace, "utf8"));
  const trace = parseTrace(raw);

  const home = process.env.HOME ?? process.cwd();
  const proofRoot = `${home}/loombridge-runs/replay-proof/${trace.id}`;
  const captureDir = args.captureDir ?? `${proofRoot}/actual`;
  const outPath = args.out ?? `${proofRoot}/report.json`;

  const report = await runLiveReplay(trace, { captureDir });

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));

  const blocked = report.blockedReason ? ` (${report.blockedReason})` : "";
  console.log(`[replay] ${trace.id}: ${report.status.toUpperCase()}${blocked}`);
  if (report.firstDivergence) {
    const d = report.firstDivergence;
    console.log(
      `[replay] first divergence: ${d.kind} @ segment=${d.segment} step=${d.step ?? "-"}`,
    );
    console.log(`[replay]   expected: ${d.expected}`);
    console.log(`[replay]   actual:   ${d.actual}`);
  }
  for (const capture of report.segments.flatMap((s) => s.captures)) {
    if (capture.artifact) console.log(`[replay] capture ${capture.id} → ${capture.artifact}`);
  }
  console.log(`[replay] report → ${outPath}`);

  process.exit(report.status === "pass" ? 0 : report.status === "blocked" ? 2 : 1);
}

main().catch((error) => {
  console.error(`[replay] harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
});
