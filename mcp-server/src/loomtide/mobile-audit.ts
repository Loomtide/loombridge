/**
 * `loomtide mobile-audit` — the mobile-optimization audit report verb (the extraction-shooter dogfood
 * late-polish learnings §9; backlog High #5).
 *
 *   loomtide mobile-audit --input <audit.json> [--out <p>] [--out-text <p>]
 *     [--texture-cap N] [--audio-long-seconds N] [--triangle-load-cap N] [--shadow-distance-cap N]
 *
 * FLOW: an agent runs the `editor.audit_mobile_assets` bridge op, saves its JSON
 * response to a file, then points this verb at that file with `--input`. The verb is a
 * pure offline translator — it needs no live editor.
 *
 * It states WEIGHT + advisory findings only; it never emits a pass/fail verdict (§9 —
 * measure first, humans decide). Every report is stamped hardware-unvalidated. Exit codes:
 *   0  report produced (findings NEVER change the exit code — they are advisory)
 *   2  bad args / unreadable or malformed input
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  buildMobileAuditReport,
  renderMobileAuditReportText,
  stableStringify,
  validateAuditPayloadKind,
  DEFAULT_THRESHOLDS,
  type AuditPayload,
  type MobileAuditThresholds,
} from "./mobile-audit-report.js";

interface Args {
  input?: string;
  out?: string;
  outText?: string;
  textureCap?: number;
  audioLongSeconds?: number;
  triangleLoadCap?: number;
  shadowDistanceCap?: number;
  help?: boolean;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    const num = (label: string) => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number, got \`${raw}\``);
      return n;
    };
    try {
      switch (a) {
        case "--help": case "-h": args.help = true; break;
        case "--input": args.input = next(); break;
        case "--out": args.out = next(); break;
        case "--out-text": args.outText = next(); break;
        case "--texture-cap": args.textureCap = num("--texture-cap"); break;
        case "--audio-long-seconds": args.audioLongSeconds = num("--audio-long-seconds"); break;
        case "--triangle-load-cap": args.triangleLoadCap = num("--triangle-load-cap"); break;
        case "--shadow-distance-cap": args.shadowDistanceCap = num("--shadow-distance-cap"); break;
        default:
          return { error: `unknown argument \`${a}\`` };
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  return args;
}

function usage(): string {
  return [
    "loomtide mobile-audit — advisory mobile-optimization audit over an editor.audit_mobile_assets payload",
    "",
    "  --input <path>              the saved editor.audit_mobile_assets JSON response (required)",
    "  --out <path>               write the deterministic report JSON",
    "  --out-text <path>          write the human-readable markdown report",
    "  --texture-cap <px>         texture max-dimension cap (default 2048)",
    "  --audio-long-seconds <s>   DecompressOnLoad clip length flagged beyond this (default 5)",
    "  --triangle-load-cap <n>    mesh triangle_load (tris × instances) flagged beyond this (default 500000)",
    "  --shadow-distance-cap <n>  real-time shadow distance flagged beyond this (default 50)",
    "",
    "Flow: run the editor.audit_mobile_assets bridge op, save its JSON response, then --input it here.",
    "States weight + advisory findings only — no pass/fail. Always stamped hardware-unvalidated (§9).",
  ].join("\n");
}

function resolveThresholds(args: Args): MobileAuditThresholds {
  return {
    textureCap: args.textureCap ?? DEFAULT_THRESHOLDS.textureCap,
    audioLongSeconds: args.audioLongSeconds ?? DEFAULT_THRESHOLDS.audioLongSeconds,
    triangleLoadCap: args.triangleLoadCap ?? DEFAULT_THRESHOLDS.triangleLoadCap,
    shadowDistanceCap: args.shadowDistanceCap ?? DEFAULT_THRESHOLDS.shadowDistanceCap,
  };
}

async function warnOnClobber(p: string): Promise<void> {
  try {
    await fs.access(p);
    console.warn(`[loomtide mobile-audit] overwriting existing ${p}`);
  } catch {
    /* does not exist — nothing to warn about */
  }
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[loomtide mobile-audit] ${parsed.error}`);
    console.error(usage());
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  if (!parsed.input) {
    console.error("[loomtide mobile-audit] --input <path> is required (the saved editor.audit_mobile_assets response)");
    console.error(usage());
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.resolve(parsed.input), "utf8"));
  } catch (e) {
    console.error(`[loomtide mobile-audit] cannot read audit payload at ${parsed.input}: ${(e as Error).message}`);
    return 2;
  }

  // Discriminator gate: REFUSE anything that is not a stamped audit payload — a wrong
  // file (e.g. build-verdict.json) must never render as a clean "no findings" audit.
  const kindCheck = validateAuditPayloadKind(raw);
  if (!kindCheck.ok) {
    console.error(`[loomtide mobile-audit] ${parsed.input}: ${kindCheck.error}`);
    return 2;
  }
  const payload = raw as AuditPayload;

  const report = buildMobileAuditReport(payload, resolveThresholds(parsed));
  const text = renderMobileAuditReportText(report);

  if (parsed.out) {
    const outPath = path.resolve(parsed.out);
    await warnOnClobber(outPath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, stableStringify(report), "utf8");
  }
  if (parsed.outText) {
    const outTextPath = path.resolve(parsed.outText);
    await warnOnClobber(outTextPath);
    await fs.mkdir(path.dirname(outTextPath), { recursive: true });
    // `text` already ends with the renderer's trailing newline — write it verbatim.
    await fs.writeFile(outTextPath, text, "utf8");
  }

  console.log(text);
  return 0;
}
