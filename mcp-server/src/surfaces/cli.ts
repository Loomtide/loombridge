#!/usr/bin/env node
/**
 * `loombridge` — the command dispatcher (plan §3, §7 decision #1).
 *
 * `loombridge` is now the verb surface; the MCP stdio server moves to the `mcp`
 * subcommand. This is non-breaking: every existing `.mcp.json` launches the
 * server by file path (`node mcp-server/dist/index.js`), not the bare bin name,
 * so repointing the `loombridge` bin to this dispatcher touches no current config.
 *
 * The dispatcher is deliberately dumb: it routes to a subcommand and gets out of
 * the way. All judgment (design-target generation, build routing) lives in the
 * agent/command layer, never here (plan §3b "orchestration lives in the agent
 * layer, not the CLI").
 */

import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveBuildStamp, formatBuildStamp } from "../shared/build-stamp.js";

/**
 * Print the running build's version + stamp so a partner can detect a STALE frozen
 * runtime (the `loombridge` bin execs `~/.loombridge/runtime`, not the repo dist — a
 * `git pull` + rebuild does NOT update it without re-running the install script).
 * The stamp (`commit` + `builtAt`) is written into `dist/build-info.json` by the
 * build (`scripts/write-build-info.mjs`) and frozen into the runtime at install. No
 * `build-info.json` at all (a hand-built dist) prints `(dev)`; a git-less build (e.g.
 * an npm-packed tarball) prints `(unknown, built …)`.
 */
function printVersion(): void {
  // Single source of truth for the running build's identity — the same resolver
  // a report stamps with (loombridge/build-stamp.ts), so `--version` and a report's
  // `producedBy` can never drift. `formatBuildStamp` renders the familiar
  // `loombridge <version> (<commit>, built <ts>)` line.
  console.log(formatBuildStamp(resolveBuildStamp()));
}

function printUsage(): void {
  // The grouping below is the positioning surface (Docs/Design/Positioning.md): three groups a
  // new developer can hold in their head, then a compressed reference list for everything demoted
  // from the headline story. Demotion is a docs decision, not a removal: every reference verb
  // still works and documents itself via `loombridge <verb> --help`.
  console.log(
    [
      "loombridge: your agent builds the Unity game; Loombridge decides whether it is actually done",
      "",
      "Usage: loombridge <command> [options]",
      "",
      "Setup (wire in, health-check, connect an agent):",
      "  install-bridge  Install the Unity bridge into a consumer project (file: tarball",
      "                    dependency by default; --embedded fallback). No repo clone.",
      "  install-agent   OPTIONAL: install Loombridge's agent commands + skills INTO the",
      "                    project repo (.claude/ + .codex/, committed/team-wide). --remove",
      "                    opts out (remembered). Skipping is the default: do nothing.",
      "  doctor          Health-check the local install + a project's bridge wiring",
      "                    (--project, --live, --ci); every failed row prints its fix.",
      "  update          Reconcile a project's bridge with this CLI's bundled bridge",
      "                    (tarball file-swap), back up, then run doctor.",
      "  mcp             Start the Loombridge MCP stdio server (the Unity bridge)",
      "",
      "Verify (anchors a human approves once; deterministic gates forever after):",
      "  verify     Bare `verify` discovers this project's verification assets, PRINTS THE",
      "               PLAN first, runs the offline ones (`--live` adds trace replay + feel",
      "               drift), and writes .loombridge/reports/verify.json. Exit 0 pass or",
      "               live-skipped partial · 1 game defect/drift · 2 harness fault, broken",
      "               asset, or nothing graded. No assets → the on-ramp, exit 2.",
      "               Modes (see `verify --help`): --snapshot grades feel drift against the",
      "               approved snapshot; --minigame grades a screen-contract capture pack",
      "               (exit 0/1/2); --profile is DIAGNOSTIC feel grading, never gating.",
      "  trace      Record once, replay deterministically: `trace record --observe` captures",
      "               a human demonstration; `trace replay --id <id>` re-drives it against",
      "               the editor and pixel-diffs frames vs the approved baseline.",
      "  feel       Tuning snapshot: `feel snapshot <capture|approve|status>` freezes the game's",
      "               MEASURED behavior once a human approves it; `verify --snapshot` then grades",
      "               kinematic drift against it (a lockfile for game feel).",
      "  target     Manage the Design Target hero shot (status/set/approve); used by `plan`",
      "               (was `design`; the old name still works and warns).",
      "  tests      Run the project's Unity EditMode tests headless and STAMP the results:",
      "               `tests run` resolves the editor, runs batchmode, and writes",
      "               .loombridge/tests/ (results + binding manifest + log) for `verify` to",
      "               grade OFFLINE. `tests grade --results <xml>` is diagnostic only.",
      "  doneness   The strict certificate: exit 0 only on a fresh, run-bound, green verdict",
      "               whose cited evidence exists on disk. A self-graded done is refused.",
      "",
      "Build loop (the supervised workflow for a new game):",
      "  plan       Scaffold .loombridge/ and seed the design target + acceptance contract",
      "               (`plan --brief <docs-dir|brief.json>` seeds from an existing design-doc",
      "               bundle instead of the interview).",
      "  build      Mint a build runId + gate preconditions; the agent constructs + verifies.",
      "  status     Read-only slice progress, next command, and proof/capture warnings.",
      "",
      "Reference (shipped and supported; run `loombridge <verb> --help` for details):",
      "  adopt          Ingest an existing built project + design docs; PROPOSE a contract",
      "                   (UNVERIFIED, never green on its own).",
      "  assets         Deterministic Asset Manifest planning/approvals.",
      "  capture        Write framing-slice evidence from raw ops + provenance.",
      "  minigame       Screen-contract helpers (setup/init/capture/finalize/baseline).",
      "  tuning-report  Deterministic telemetry run-set analysis (numbers only; humans judge fun).",
      "  mobile-audit   Advisory mobile-optimization audit (findings only, never a verdict).",
      "  ask            (deprecated: use `status`) Read-only project explanation.",
      "",
      "Run 'loombridge <command> --help' for command options.",
      "Run 'loombridge --version' to print the installed build (catches a stale frozen runtime).",
    ].join("\n"),
  );
}

export async function loombridgeCli(argv: string[]): Promise<number> {
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
      const { run } = await import("../capabilities/verification/plan.js");
      return run(rest);
    }
    case "adopt": {
      const { run } = await import("../capabilities/verification/adopt.js");
      return run(rest);
    }
    case "status": {
      const { run } = await import("../capabilities/verification/status.js");
      return run(rest);
    }
    case "ask": {
      // RETIRED from the agent surface (CommandSurfaceRedesign §1.3): `ask` was a read-only prose
      // explainer over the SAME model `status` renders — `ask.ts` imports `computeStatusModel` and
      // `developerNextAction` from `status-model.ts`, so it was a second voice for one set of facts.
      // The slash command and its Codex wrapper are gone.
      //
      // The VERB stays, deprecated. It is published and consumers may script it; breaking it to
      // save a dispatch case is not a trade worth making. Notice goes to stderr so it cannot
      // corrupt anything parsing stdout.
      console.error(
        "[loombridge ask] DEPRECATED — `ask` reads the same state as `loombridge status`, which is now the " +
          "single read-only surface. This verb still works and will be removed in a future major.",
      );
      const { run } = await import("../capabilities/verification/ask.js");
      return run(rest);
    }
    case "verify": {
      const { run } = await import("../capabilities/verification/verify.js");
      return run(rest);
    }
    case "minigame": {
      const { run } = await import("../capabilities/minigame/minigame.js");
      return run(rest);
    }
    case "target":
    case "design": {
      // RENAMED `design` -> `target` (CommandSurfaceRedesign §4). `loombridge design` reads as
      // "design the game"; the verb actually FREEZES the hero shot the build converges on, which is
      // a target. The old name also collided with the RFC's proposed game-design stage, so the two
      // meanings of "design" were overloading each other.
      //
      // `design` stays as an alias. It is published and consumers script it; the notice goes to
      // STDERR so it can never corrupt anything parsing stdout. Removal is a future major.
      if (sub === "design") {
        console.error(
          "[loombridge design] DEPRECATED — renamed to `loombridge target` (it freezes the hero-shot " +
            "TARGET; it does not design the game). This alias still works and will be removed in a " +
            "future major. `.loombridge/design/` on disk is unchanged.",
        );
      }
      const { run } = await import("../capabilities/verification/design.js");
      return run(rest);
    }
    case "capture": {
      const { run } = await import("../capabilities/verification/capture.js");
      return run(rest);
    }
    case "tests": {
      // The Test Runner gate's PRODUCER. `tests run` is the only verb that launches a Unity
      // editor to get test results; `verify` grades the stamped pair offline so a bare
      // verify never takes the license seat or fights a domain reload.
      const { run } = await import("../capabilities/tests/tests.js");
      return run(rest);
    }
    case "doneness": {
      const { run } = await import("../capabilities/verification/doneness.js");
      return run(rest);
    }
    case "trace": {
      const { run } = await import("../capabilities/replay/trace.js");
      return run(rest);
    }
    case "feel": {
      // `feel snapshot <capture|approve|status>`: the tuning-snapshot lifecycle
      // (freeze approved measured behavior; `verify --snapshot` grades drift).
      // Distinct from `tuning-report` (telemetry run-set analysis).
      const { run } = await import("../capabilities/feel/snapshot.js");
      return run(rest);
    }
    case "tuning-report": {
      const { run } = await import("../capabilities/feel/tuning-report.js");
      return run(rest);
    }
    case "mobile-audit": {
      const { run } = await import("../capabilities/mobile/mobile-audit.js");
      return run(rest);
    }
    case "build": {
      const { run } = await import("../capabilities/verification/build.js");
      return run(rest);
    }
    case "assets": {
      const { run } = await import("../capabilities/assets/assets.js");
      return run(rest);
    }
    case "install-bridge": {
      const { run } = await import("../capabilities/setup/install-bridge.js");
      return run(rest);
    }
    case "install-agent": {
      const { run } = await import("../capabilities/setup/install-agent.js");
      return run(rest);
    }
    case "doctor": {
      const { run } = await import("../capabilities/setup/doctor.js");
      return run(rest);
    }
    case "update": {
      const { run } = await import("../capabilities/setup/update.js");
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
      console.error(`[loombridge] unknown command "${sub}".`);
      printUsage();
      return 2;
  }
}

/**
 * True when this file is the process entry point. The `cli.js`/`cli.ts` suffix
 * covers `node dist/cli.js` and the frozen-runtime wrapper (both exec by path); the
 * realpath comparison covers an INSTALLED bin — `npm link` / `npm i -g` / `npm pack`
 * symlink a bin named `loombridge`, so argv[1] ends in `loombridge`, not `cli.js`, and the
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
  loombridgeCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
