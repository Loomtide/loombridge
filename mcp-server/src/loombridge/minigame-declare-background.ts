/**
 * `loombridge minigame declare-background` — close the report→contract loop.
 *
 * The verify report's "Likely background decoration" section flags decorative uGUI elements (sky /
 * clouds / hills) the `safe-area-sweep` check catches until they're declared in
 * `contract.safeAreaBackground`. Until now the dev had to hand-paste a `safeAreaBackground: [...]`
 * snippet into the contract JSON. This verb writes it for them: the (static, server-less) HTML report
 * emits a `declare-background <paths…>` command (checkboxes → Copy command), and this verb merges
 * those paths into the contract, validates, and writes — so the next `verify` silently exempts them.
 *
 * MOAT: declared decoration is gate-skipped SILENTLY (it's correctly-classified background, not a
 * waived real finding). So the verb REFUSES to declare a path that would exempt a real control — a
 * bound `requiredInFrame` locator, or (when a report is present) a flagged INTERACTIVE sweep element
 * (`annotation.interactive`). Declaring a control as background would make the sweep skip it without
 * a trace; the refusal names the offending path and writes nothing.
 *
 * Split pure/IO like `minigame-run.ts`: `computeDeclaration` (merge + segment-safe fold + the refuse
 * guard) is unit-tested with no disk; `runDeclareBackground` is the IO shell (resolve contract, read,
 * validate, confirm, write).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { ICON, tildify } from "./cli-ui.js";
import { backgroundCandidatesFor, covers } from "./minigame-report-render.js";
import { defaultWorkspace, findContract } from "./minigame-next.js";
import { mergeIntoOverrides } from "./minigame-overrides.js";
import { validateMinigameContract } from "./minigame-profiles/validator.js";
import type { MinigameVerifyReport } from "./verify-minigame.js";

/** The outcome of merging requested paths into the contract's safeAreaBackground — pure, no disk. */
export interface DeclareOutcome {
  /** The resulting `safeAreaBackground` (deduped, minimal-folded, sorted). */
  finalBackground: string[];
  /** Entries newly added vs `current` (what the dev's declaration introduced). */
  added: string[];
  /** Requested paths refused because they'd exempt a protected control (bound / interactive). */
  refused: string[];
  /** True iff `finalBackground` differs from `current` as a set (else it's a no-op). */
  changed: boolean;
}

/**
 * Merge `requested` background paths into the existing `safeAreaBackground` (`current`):
 *  - REFUSE any requested path that COVERS a protected control (`protectedPaths`) — never silence a
 *    real control by declaring it (or its container) as background;
 *  - union the accepted paths with the current set, then MINIMAL-FOLD (drop an entry already covered
 *    by another — `["/Canvas/Background", "/Canvas/Background/Cloud1"]` → `["/Canvas/Background"]`),
 *    reusing the same segment-safe `covers` rule the report's suggestion uses;
 *  - NEVER invent a container broader than what was given (folding only drops, never widens).
 * Pure.
 */
export function computeDeclaration(
  current: readonly string[],
  requested: readonly string[],
  protectedPaths: readonly string[],
): DeclareOutcome {
  const clean = (paths: readonly string[]): string[] => [...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0))];
  const req = clean(requested);
  const curSet = clean(current);
  // A requested entry that would exempt a protected control is refused (and excluded from the write).
  const refused = req.filter((r) => protectedPaths.some((p) => covers(r, p)));
  const accepted = req.filter((r) => !refused.includes(r));
  const union = [...new Set([...curSet, ...accepted])];
  // Drop any entry already covered by ANOTHER entry (minimal, non-overlapping set).
  const minimal = union.filter((c) => !union.some((other) => other !== c && covers(other, c)));
  const finalBackground = minimal.sort();
  const added = finalBackground.filter((e) => !curSet.includes(e));
  const changed = finalBackground.length !== curSet.length || finalBackground.some((e) => !curSet.includes(e));
  return { finalBackground, added, refused, changed };
}

/** Strip a scene prefix from a locator: `"Shape:/Canvas/Home"` → `"/Canvas/Home"` (sweep paths and
 *  `safeAreaBackground` entries are scene-prefix-free, so requiredInFrame locators must match). */
function stripScene(locator: string): string {
  return locator.includes(":") ? locator.slice(locator.indexOf(":") + 1) : locator;
}

interface ParsedArgs {
  paths: string[];
  id?: string;
  contract?: string;
  fromReport: boolean;
  yes: boolean;
  help: boolean;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { paths: [], fromReport: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--from-report") out.fromReport = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--contract") out.contract = argv[++i];
    else if (a.startsWith("--")) out.error = `unknown flag '${a}'`;
    else out.paths.push(a);
  }
  return out;
}

function printUsage(): void {
  const lines = [
    "loombridge minigame declare-background — declare decorative background so the sweep stops flagging it",
    "",
    "Usage:",
    "  loombridge minigame declare-background [--id <kebab> | --contract <path>] <scene-path>...",
    "  loombridge minigame declare-background --id <kebab> --from-report   # use the report's suggestions",
    "",
    "Writes the given uGUI scene paths (or container globs like /Canvas/Background) into the",
    "contract's `safeAreaBackground`. Run it from the report's \"Copy declare command\" button.",
    "",
    "Options:",
    "  --id <kebab>       Mini-game id; resolves ~/.loombridge/projects/<id> and finds the contract.",
    "  --contract <path>  Explicit contract path (overrides --id / cwd lookup).",
    "  --from-report      With no paths, declare the report's auto-detected background candidates.",
    "  --yes, -y          Skip the confirmation prompt.",
    "  -h, --help         Show this help.",
    "",
    "Refuses to declare a path that would exempt a real control (bound or interactive) — declaring",
    "a control as background would make the safe-area sweep skip it silently.",
  ];
  console.log(lines.join("\n"));
}

/** Read + parse a JSON file, or null if absent/unreadable. */
async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** The latest verify JSON report for a workspace — checks both the standalone (`.loombridge/reports`)
 *  and the guided (`reports`) locations, newest wins. Null when none is present. */
async function loadReport(workspace: string): Promise<MinigameVerifyReport | null> {
  const candidates = [
    path.join(workspace, ".loombridge", "reports", "minigame-verification.json"),
    path.join(workspace, "reports", "minigame-verification.json"),
  ];
  let best: { report: MinigameVerifyReport; mtime: number } | null = null;
  for (const p of candidates) {
    try {
      const mtime = (await fs.stat(p)).mtimeMs;
      const report = await readJson<MinigameVerifyReport>(p);
      if (report && (!best || mtime > best.mtime)) best = { report, mtime };
    } catch {
      /* absent → skip */
    }
  }
  return best?.report ?? null;
}

/** Interactive flagged sweep paths from a report — unbound controls the sweep would silence if their
 *  container were declared background (the report won't offer these, but a hand-typed path might). */
function interactivePathsFrom(report: MinigameVerifyReport | null): string[] {
  if (!report) return [];
  return report.cr.blockingFailures
    .filter((f) => f.source === "gate" && f.gate === "safe-area-sweep" && f.annotation?.interactive === true)
    .map((f) => f.annotation?.locator)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

export async function runDeclareBackground(argv: string[], root: string = process.cwd()): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.error) {
    console.error(`${ICON.fail} ${args.error}`);
    return 2;
  }

  // Resolve the workspace + contract: --contract wins; else --id's default workspace; else cwd.
  const workspace = args.id ? defaultWorkspace(args.id) : root;
  const contractPath = args.contract ?? (await findContract(workspace));
  if (!contractPath) {
    console.error(`${ICON.fail} no <id>.minigame.json found in ${tildify(workspace)} — pass --contract or --id.`);
    return 2;
  }
  const contract = await readJson<Record<string, unknown>>(contractPath);
  if (!contract) {
    console.error(`${ICON.fail} could not read contract ${tildify(contractPath)}.`);
    return 2;
  }

  const report = await loadReport(workspace);

  // Requested paths: positional, or (with --from-report) the report's auto-detected candidates.
  let requested = args.paths;
  if (requested.length === 0 && args.fromReport) {
    requested = report ? backgroundCandidatesFor(report) : [];
    if (requested.length === 0) {
      console.error(`${ICON.fail} --from-report: no background candidates in the latest report (run \`verify --minigame\` first).`);
      return 2;
    }
  }
  if (requested.length === 0) {
    console.error(`${ICON.fail} nothing to declare — pass scene paths, or --from-report. See --help.`);
    return 2;
  }

  // Protected controls: bound requiredInFrame locators (scene-stripped) + flagged interactive sweep
  // paths. Declaring any of these (or a container covering them) as background would silence a control.
  const required = Array.isArray(contract.requiredInFrame) ? contract.requiredInFrame : [];
  const requiredPaths = required
    .map((r) => (r && typeof r === "object" ? (r as { locator?: unknown }).locator : undefined))
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .map(stripScene);
  const protectedPaths = [...new Set([...requiredPaths, ...interactivePathsFrom(report)])];

  const current = Array.isArray(contract.safeAreaBackground) ? (contract.safeAreaBackground as string[]) : [];
  const outcome = computeDeclaration(current, requested, protectedPaths);

  if (outcome.refused.length > 0) {
    console.error(`${ICON.fail} refused — these would exempt a real control from the safe-area sweep (a control is never background):`);
    for (const r of outcome.refused) console.error(`     ${r}`);
    console.error(`   Remove them and re-run; declared background is skipped silently, so a control declared as background would never be checked.`);
    return 1;
  }
  if (!outcome.changed) {
    console.log(`${ICON.pass} already declared — \`safeAreaBackground\` already covers ${requested.length === 1 ? "that path" : "those paths"}. Nothing to do.`);
    return 0;
  }

  // Confirm in an interactive terminal (the report-emitted command runs in the dev's TTY); skip with
  // --yes or when piped (CI / tests).
  console.log(`${ICON.drift} Declaring as background decoration (exempt from the safe-area sweep):`);
  for (const a of outcome.added) console.log(`     + ${a}`);
  if (process.stdin.isTTY === true && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question("   Write these to the contract? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log(`${ICON.info} cancelled — contract unchanged.`);
      return 0;
    }
  }

  // Write the mutated contract, but validate FIRST — never write an invalid contract.
  const next = { ...contract, safeAreaBackground: outcome.finalBackground };
  const validation = validateMinigameContract(next);
  if (!validation.valid) {
    console.error(`${ICON.fail} the declaration would make the contract invalid — not written:`);
    for (const issue of validation.issues) console.error(`     ${issue.code}: ${issue.message}`);
    return 1;
  }
  await fs.writeFile(contractPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");

  // Persist the declaration to the workspace overrides sidecar (next to the contract) so it SURVIVES a
  // record-first `check --id` regeneration (which rebuilds the contract from a fresh recording and would
  // otherwise wipe this). The contract write above gives the immediate effect for the current `verify`.
  await mergeIntoOverrides(path.dirname(contractPath), { safeAreaBackground: outcome.finalBackground });

  console.log(`${ICON.pass} wrote ${outcome.added.length} background ${outcome.added.length === 1 ? "entry" : "entries"} to ${tildify(contractPath)} (persisted to overrides.json — survives a full \`minigame check\` re-run).`);
  // Print the EXACT verify command (copy-pasteable), same shape the capture/finalize footers use — the
  // declared decoration won't be flagged. The captures/report live next to the contract by convention.
  const ws = path.dirname(contractPath);
  const captures = path.join(ws, "captures");
  const reportOut = path.join(ws, "reports", "minigame-verification.json");
  console.log(`${ICON.next} Re-run the release check (no re-capture needed) — copy:`);
  console.log(`   loombridge verify --minigame --contract ${tildify(contractPath)} --captures ${tildify(captures)} --output ${tildify(reportOut)} --strict`);
  return 0;
}
