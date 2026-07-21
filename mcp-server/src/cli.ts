#!/usr/bin/env node
/**
 * `loomtide` — the command dispatcher (plan §3, §7 decision #1).
 *
 * `loomtide` is now the verb surface; the MCP stdio server moves to the `mcp`
 * subcommand. This is non-breaking: every existing `.mcp.json` launches the
 * server by file path (`node mcp-server/dist/index.js`), not the bare bin name,
 * so repointing the `loomtide` bin to this dispatcher touches no current config.
 *
 * The dispatcher is deliberately dumb: it routes to a subcommand and gets out of
 * the way. All judgment (design-target generation, build routing) lives in the
 * agent/command layer, never here (plan §3b "orchestration lives in the agent
 * layer, not the CLI").
 */

import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveBuildStamp, formatBuildStamp } from "./loomtide/build-stamp.js";

/**
 * Print the running build's version + stamp so a partner can detect a STALE frozen
 * runtime (the `loomtide` bin execs `~/.loomtide/runtime`, not the repo dist — a
 * `git pull` + rebuild does NOT update it without re-running the install script).
 * The stamp (`commit` + `builtAt`) is written into `dist/build-info.json` by the
 * build (`scripts/write-build-info.mjs`) and frozen into the runtime at install. No
 * `build-info.json` at all (a hand-built dist) prints `(dev)`; a git-less build (e.g.
 * an npm-packed tarball) prints `(unknown, built …)`.
 */
function printVersion(): void {
  // Single source of truth for the running build's identity — the same resolver
  // a report stamps with (loomtide/build-stamp.ts), so `--version` and a report's
  // `producedBy` can never drift. `formatBuildStamp` renders the familiar
  // `loomtide <version> (<commit>, built <ts>)` line.
  console.log(formatBuildStamp(resolveBuildStamp()));
}

function printUsage(): void {
  console.log(
    [
      "loomtide — gameplay intelligence layer for AI-built games",
      "",
      "Usage: loomtide <command> [options]",
      "",
      "Commands:",
      "  plan      Scaffold .loomtide/ and seed the design target + acceptance contract",
      "              (`plan --brief <docs-dir|brief.json>` seeds from an existing design-doc",
      "               bundle instead of the interview)",
      "  adopt     Build-then-verify on-ramp: ingest an existing built project + design",
      "              docs and PROPOSE an acceptance contract (UNVERIFIED — never green)",
      "  status    Read-only slice progress, next command, and proof/capture warnings",
      "  ask       Read-only project explanation for progress, blockers, and next steps",
      "  verify    Run the Tier-1 gates against the contract and write the verdict",
      "              (verify-first: `verify --profile precision|classic|momentum` grades an",
      "               existing 2D platformer against a feel profile — no plan/build needed;",
      "               `verify --minigame --contract <p> --captures <d>` grades a 2D kids",
      "               mini-game capture pack against a contract — exit 0/1/2)",
      "  build     Mint a build runId (§3a) + gate preconditions; agent constructs + verifies",
      "  assets    Deterministically plan/apply registry or generated Asset Manifest approvals",
      "  minigame  Mini-game helpers: `minigame setup` (guided first-time setup),",
      "              `minigame init` (scaffold), `minigame capture` (drive the trace →",
      "              capture pack), `minigame finalize` (fill real locators from captures),",
      "              `minigame declare-background` (mark report decoration into the contract),",
      "              `minigame baseline approve|status`",
      "  mcp       Start the Loomtide MCP stdio server (the Unity bridge)",
      "",
      "Setup:",
      "  install-bridge  Install the Unity bridge into a consumer project (file: tarball",
      "                    dependency by default; --embedded fallback). No repo clone.",
      "  install-agent   OPTIONAL: install Loomtide's agent commands + skills INTO the",
      "                    project repo (.claude/ + .codex/, committed/team-wide). --remove",
      "                    opts out (remembered). Skipping is the default — do nothing.",
      "  doctor          Health-check the local install + a project's bridge wiring",
      "                    (--project, --live, --ci); every failed row prints its fix.",
      "  update          Reconcile a project's bridge with this CLI's bundled bridge",
      "                    (tarball file-swap), back up, then run doctor.",
      "",
      "Helpers:",
      "  design     Manage the Design Target hero shot (status/set/approve) — used by `plan`",
      "  capture    Write framing-slice evidence (screen-rects/console) from raw ops + provenance",
      "  doneness   §3a freshness gate: 0 only on fresh + green verdict for the current build",
      "  trace      Replay Verification: `trace replay --id <id>` drives a recorded action",
      "              trace against the editor and writes a report.json + self-contained HTML",
      "  tuning-report  Deterministic tuning analysis over telemetry run-sets: aggregate a",
      "              genre-pack telemetry schema's metrics (segmented by map/persona/route/",
      "              outcome), before/after deltas, and a one-lever-isolation warning. With",
      "              --personas, also grades each scripted persona against its declared",
      "              envelope + a cross-persona spread. States numbers + deltas only — humans",
      "              judge fun; persona drift/uncalibrated flags are caveats about the bots.",
      "  mobile-audit  Advisory mobile-optimization audit over an editor.audit_mobile_assets",
      "              payload: texture/audio/mesh weight + triangle_load offenders, shadow budget.",
      "              States sizes + findings only, always stamped hardware-unvalidated — no verdict.",
      "",
      "Run 'loomtide <command> --help' for command options.",
      "Run 'loomtide --version' to print the installed build (catches a stale frozen runtime).",
    ].join("\n"),
  );
}

export async function loomtideCli(argv: string[]): Promise<number> {
  const sub = argv[2];
  const rest = argv.slice(3);

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return 0;
  }

  if (sub === "--version" || sub === "-v" || sub === "version") {
    printVersion();
    return 0;
  }

  switch (sub) {
    case "plan": {
      const { run } = await import("./loomtide/plan.js");
      return run(rest);
    }
    case "adopt": {
      const { run } = await import("./loomtide/adopt.js");
      return run(rest);
    }
    case "status": {
      const { run } = await import("./loomtide/status.js");
      return run(rest);
    }
    case "ask": {
      const { run } = await import("./loomtide/ask.js");
      return run(rest);
    }
    case "verify": {
      const { run } = await import("./loomtide/verify.js");
      return run(rest);
    }
    case "minigame": {
      const { run } = await import("./loomtide/minigame.js");
      return run(rest);
    }
    case "design": {
      const { run } = await import("./loomtide/design.js");
      return run(rest);
    }
    case "capture": {
      const { run } = await import("./loomtide/capture.js");
      return run(rest);
    }
    case "doneness": {
      const { run } = await import("./loomtide/doneness.js");
      return run(rest);
    }
    case "trace": {
      const { run } = await import("./loomtide/trace.js");
      return run(rest);
    }
    case "tuning-report": {
      const { run } = await import("./loomtide/tuning-report.js");
      return run(rest);
    }
    case "mobile-audit": {
      const { run } = await import("./loomtide/mobile-audit.js");
      return run(rest);
    }
    case "build": {
      const { run } = await import("./loomtide/build.js");
      return run(rest);
    }
    case "assets": {
      const { run } = await import("./loomtide/assets.js");
      return run(rest);
    }
    case "install-bridge": {
      const { run } = await import("./loomtide/install-bridge.js");
      return run(rest);
    }
    case "install-agent": {
      const { run } = await import("./loomtide/install-agent.js");
      return run(rest);
    }
    case "doctor": {
      const { run } = await import("./loomtide/doctor.js");
      return run(rest);
    }
    case "update": {
      const { run } = await import("./loomtide/update.js");
      return run(rest);
    }
    case "mcp": {
      // Boot the existing stdio server in-process. index.ts only auto-runs under
      // its own main-module guard (which is false here), so call main() directly.
      const { main } = await import("./index.js");
      await main();
      return 0; // the server keeps the event loop alive until SIGINT/SIGTERM.
    }
    default:
      console.error(`[loomtide] unknown command "${sub}".`);
      printUsage();
      return 2;
  }
}

/**
 * True when this file is the process entry point. The `cli.js`/`cli.ts` suffix
 * covers `node dist/cli.js` and the frozen-runtime wrapper (both exec by path); the
 * realpath comparison covers an INSTALLED bin — `npm link` / `npm i -g` / `npm pack`
 * symlink a bin named `loomtide`, so argv[1] ends in `loomtide`, not `cli.js`, and the
 * suffix check alone would silently no-op (the command would print nothing). Both
 * sides are realpath'd so a symlinked bin resolves to this module.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (entry.endsWith("cli.js") || entry.endsWith("cli.ts")) return true;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  loomtideCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
