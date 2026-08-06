/**
 * `loombridge setup`: the composition, the confirmation, and what it refuses.
 *
 * `setup` is a front door over verbs that already exist, so the things worth guarding are the
 * WIRING and the two rules that carry the risk:
 *
 *  - **The confirmation may never block a non-interactive run.** This CLI is driven by agents
 *    as often as by humans, so a missing answer resolves to the documented default (skip the
 *    agent surface), never to a write, and the run still exits 0.
 *  - **Steps 1 to 4 never prompt.** MCP is what makes the tool work at all; the confirmation
 *    is about the opinionated slash commands, not about the wiring.
 *
 * Plus the ordering: a required step that fails stops the run before the next one writes.
 *
 * The bridge / agent-surface / doctor phases are injected because they need a packed bridge
 * tarball, a payload directory, and a Unity install respectively. `.mcp.json` is NOT injected
 * anywhere below: it is the risky writer, so setup exercises the real one.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { _defaultDeps, type SetupRunDeps, parseArgs, run } from "../../../../capabilities/setup/setup.js";
import { installBridge } from "../../../../capabilities/setup/install-bridge.js";
import { run as installAgentRun } from "../../../../capabilities/setup/install-agent.js";
import { runInstallMcp } from "../../../../capabilities/setup/install-mcp.js";
import { run as doctorRun } from "../../../../capabilities/setup/doctor.js";
import { runCliSelfUpdatePhase } from "../../../../capabilities/setup/update.js";
import { readInstallMetadata } from "../../../../capabilities/setup/bridge-install-common.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lb-setup-"));
  temps.push(dir);
  return dir;
}

function unityProjectDir(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, "ProjectSettings"), { recursive: true });
  writeFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
  mkdirSync(path.join(dir, "Assets"), { recursive: true });
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function quietlyAsync<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

/** Every injectable phase, recording the order it was called in. */
function spies(overrides: { bridge?: number; agent?: number; doctor?: number } = {}) {
  const order: string[] = [];
  const deps: SetupRunDeps = {
    selfUpdatePhase: (params) => {
      order.push(`currency:checkOnly=${params.checkOnly}`);
      return { kind: "continue" as const };
    },
    installBridgeFn: async (args) => {
      order.push(`bridge:${args.mode}:stale=${args.allowStaleBridge ?? false}`);
      return overrides.bridge ?? 0;
    },
    installAgentFn: async (args) => {
      order.push(`agent:${args.join(" ")}`);
      return overrides.agent ?? 0;
    },
    doctorFn: async () => {
      order.push("doctor");
      return overrides.doctor ?? 0;
    },
    isTTY: false,
    // An answer is ALWAYS available, so a test that expects a skip proves the skip came from
    // the TTY check rather than from a prompt that had nothing to read. It also means a
    // regression cannot hang the suite on the real readline.
    ask: async () => "y",
  };
  return { order, deps };
}

function mcpConfig(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".mcp.json"), "utf8")) as Record<string, unknown>;
}

describe("setup: argv", () => {
  test("cwd is the default target", () => {
    const project = unityProjectDir();
    const parsed = parseArgs([], project) as { project: string };
    assert.equal(parsed.project, path.resolve(project));
  });

  test("REFUSAL: a value-less --project is a usage error, never a silent cwd fallback", async () => {
    const parsed = await quietlyAsync(async () => parseArgs(["--project"], unityProjectDir()));
    assert.ok("help" in parsed);
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });

  test("REFUSAL: --project must not SWALLOW the flag that follows it", async () => {
    // `setup --project --yes` would otherwise target a directory named "--yes" AND silently
    // drop the consent flag the operator typed.
    const parsed = await quietlyAsync(async () => parseArgs(["--project", "--yes"], unityProjectDir()));
    assert.ok("help" in parsed);
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });

  test("REFUSAL: --yes and --no-agent-surface together are a usage error", async () => {
    const parsed = await quietlyAsync(async () => parseArgs(["--yes", "--no-agent-surface"], unityProjectDir()));
    assert.ok("help" in parsed);
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });
});

describe("setup: step 1, resolving the project", () => {
  test("REFUSAL: a cwd that is not a Unity project exits 2 and writes NOTHING", async () => {
    const dir = tempDir();
    const { order, deps } = spies();
    const code = await quietlyAsync(() => run([], { ...deps, cwd: dir }));

    assert.equal(code, 2, "not a Unity project is a precondition failure");
    assert.deepEqual(readdirSync(dir), [], "a refused run must not leave a single file behind");
    assert.deepEqual(order, [], "nothing may be actuated before the target is known good");
  });

  test("REFUSAL: an explicit --project that does not exist exits 2", async () => {
    const { order, deps } = spies();
    const code = await quietlyAsync(() =>
      run(["--project", path.join(tempDir(), "nope")], { ...deps, cwd: unityProjectDir() }),
    );
    assert.equal(code, 2);
    assert.deepEqual(order, [], "cwd must never be silently substituted for a named target");
  });
});

describe("setup: the composition, in order", () => {
  test("currency, bridge, MCP, agent surface, doctor, and MCP lands for real", async () => {
    const project = unityProjectDir();
    const { order, deps } = spies();
    const code = await quietlyAsync(() => run(["--yes"], { ...deps, cwd: project }));

    assert.equal(code, 0);
    assert.deepEqual(order, [
      "currency:checkOnly=true",
      "bridge:tarball:stale=false",
      `agent:--project ${project}`,
      "doctor",
    ]);
    // Step 4 is not injected: the real writer ran, between the bridge and the agent surface.
    assert.deepEqual(mcpConfig(project), {
      mcpServers: { loombridge: { command: "loombridge", args: ["mcp"] } },
    });
  });

  test("the CLI currency check is REPORT-ONLY: no flag can make setup self-update", async () => {
    // A self-update has to END the run (the bridge ships inside the CLI), and ending a
    // first-time setup halfway is worse than telling the operator to run `loombridge update`.
    const project = unityProjectDir();
    const seen: boolean[] = [];
    const { deps } = spies();
    await quietlyAsync(() =>
      run(["--no-agent-surface", "--allow-stale-bridge"], {
        ...deps,
        cwd: project,
        selfUpdatePhase: (params) => {
          seen.push(params.checkOnly);
          return { kind: "continue" as const };
        },
      }),
    );
    assert.deepEqual(seen, [true], "checkOnly must be passed unconditionally");
  });

  test("a stale CLI WARNS and the run continues (design open question 1)", async () => {
    // `check-failed` / `instruct` / a pending update all return `continue` from the phase.
    // The point here is that setup does not turn a version report into a refusal.
    const project = unityProjectDir();
    const { order, deps } = spies();
    const code = await quietlyAsync(() =>
      run(["--no-agent-surface"], { ...deps, cwd: project, selfUpdatePhase: () => ({ kind: "continue" as const }) }),
    );
    assert.equal(code, 0, "an unrelated version check must not block a first-time setup");
    assert.ok(order.includes("bridge:tarball:stale=false"), "the run must reach the bridge");
  });

  test("--allow-stale-bridge reaches the installer (the flag must actuate, not just parse)", async () => {
    const project = unityProjectDir();
    const { order, deps } = spies();
    await quietlyAsync(() => run(["--allow-stale-bridge", "--no-agent-surface"], { ...deps, cwd: project }));
    assert.ok(order.includes("bridge:tarball:stale=true"));
  });

  test("the injected defaults ARE the real verbs (a seam must not become the shipped path)", () => {
    assert.equal(_defaultDeps.selfUpdatePhase, runCliSelfUpdatePhase);
    assert.equal(_defaultDeps.installBridgeFn, installBridge);
    assert.equal(_defaultDeps.installMcpFn, runInstallMcp);
    assert.equal(_defaultDeps.installAgentFn, installAgentRun);
    assert.equal(_defaultDeps.doctorFn, doctorRun);
  });
});

describe("setup: a failed required step stops the run", () => {
  test("a bridge failure stops BEFORE .mcp.json is touched", async () => {
    const project = unityProjectDir();
    const { order, deps } = spies({ bridge: 2 });
    const code = await quietlyAsync(() => run(["--yes"], { ...deps, cwd: project }));

    assert.equal(code, 2, "the bridge's exit code is passed through, refusals included");
    assert.equal(existsSync(path.join(project, ".mcp.json")), false, "a half-wired project must not look wired");
    assert.deepEqual(order, ["currency:checkOnly=true", "bridge:tarball:stale=false"]);
  });

  test("REFUSAL: a foreign .mcp.json entry stops the run at exit 2, before the agent surface", async () => {
    const project = unityProjectDir();
    const bytes = `${JSON.stringify({ mcpServers: { loombridge: { command: "mine" } } }, null, 2)}\n`;
    writeFileSync(path.join(project, ".mcp.json"), bytes);

    const { order, deps } = spies();
    const code = await quietlyAsync(() => run(["--yes"], { ...deps, cwd: project }));

    assert.equal(code, 2);
    assert.equal(readFileSync(path.join(project, ".mcp.json"), "utf8"), bytes, "not one byte may change");
    assert.deepEqual(order, ["currency:checkOnly=true", "bridge:tarball:stale=false"], "nothing may run after a refusal");
  });

  test("REFUSAL: an --embedded bridge is never clobbered by setup", async () => {
    // An embedded copy is a physical folder someone could have edited, and we cannot tell.
    // `update --force-bridge` is the deliberate override; setup does not carry it.
    const project = unityProjectDir();
    writeFileSync(
      path.join(project, "ProjectSettings", "LoombridgeInstall.json"),
      `${JSON.stringify({ schemaVersion: 1, installMode: "embedded-package", bridgeVersion: "0.2.0" }, null, 2)}\n`,
    );
    const { order, deps } = spies();
    const code = await quietlyAsync(() => run([], { ...deps, cwd: project }));

    assert.equal(code, 1);
    assert.deepEqual(order, ["currency:checkOnly=true"], "the installer must never be reached");
    assert.equal(existsSync(path.join(project, ".mcp.json")), false);
  });

  test("doctor's verdict is setup's verdict", async () => {
    const project = unityProjectDir();
    const { deps } = spies({ doctor: 1 });
    const code = await quietlyAsync(() => run(["--no-agent-surface"], { ...deps, cwd: project }));
    assert.equal(code, 1, "the run ends on evidence, not on a claim");
  });
});

describe("setup: the confirmation never blocks a non-interactive run", () => {
  test("not a TTY and no flag: the agent surface is SKIPPED and the run still exits 0", async () => {
    const project = unityProjectDir();
    const { order, deps } = spies();
    const code = await quietlyAsync(() => run([], { ...deps, cwd: project, isTTY: false }));

    assert.equal(code, 0, "a skipped OPTIONAL step is not a failure");
    // The injected asker would answer "y" if it were consulted. It must not be: the
    // documented default for a non-interactive run is skip, never a write.
    assert.ok(!order.some((o) => o.startsWith("agent:")), "the surface must not be installed without consent");
    assert.ok(order.includes("doctor"), "and the run must still finish");
    // Steps 1 to 4 do not prompt, so the thing that makes the tool work still landed.
    assert.deepEqual(mcpConfig(project), { mcpServers: { loombridge: { command: "loombridge", args: ["mcp"] } } });
  });

  test("not a TTY: no question is ever asked", async () => {
    const project = unityProjectDir();
    let asked = 0;
    const { deps } = spies();
    await quietlyAsync(() =>
      run([], {
        ...deps,
        cwd: project,
        isTTY: false,
        ask: async () => {
          asked += 1;
          return "y";
        },
      }),
    );
    assert.equal(asked, 0, "a prompt that cannot be answered must never be issued");
  });

  test("--yes installs without asking", async () => {
    const project = unityProjectDir();
    let asked = 0;
    const { order, deps } = spies();
    const code = await quietlyAsync(() =>
      run(["--yes"], { ...deps, cwd: project, isTTY: true, ask: async () => { asked += 1; return "n"; } }),
    );
    assert.equal(code, 0);
    assert.equal(asked, 0, "--yes is the answer; asking anyway would be a second chance to say no");
    assert.ok(order.some((o) => o.startsWith("agent:")));
  });

  test("--no-agent-surface skips without asking, even on a TTY", async () => {
    const project = unityProjectDir();
    let asked = 0;
    const { order, deps } = spies();
    const code = await quietlyAsync(() =>
      run(["--no-agent-surface"], { ...deps, cwd: project, isTTY: true, ask: async () => { asked += 1; return "y"; } }),
    );
    assert.equal(code, 0);
    assert.equal(asked, 0);
    assert.ok(!order.some((o) => o.startsWith("agent:")));
  });

  test("interactive: `y` installs, anything else skips and the run still exits 0", async () => {
    for (const [answer, expectInstall] of [["y", true], ["yes", true], ["", false], ["n", false], ["Y", true]] as const) {
      const project = unityProjectDir();
      const { order, deps } = spies();
      const code = await quietlyAsync(() =>
        run([], { ...deps, cwd: project, isTTY: true, ask: async () => answer }),
      );
      assert.equal(code, 0, `answer ${JSON.stringify(answer)} must not fail the run`);
      assert.equal(
        order.some((o) => o.startsWith("agent:")),
        expectInstall,
        `answer ${JSON.stringify(answer)} must ${expectInstall ? "" : "not "}install the surface`,
      );
    }
  });

  test("a recorded `declined` is honored SILENTLY: no prompt, no install, exit 0", async () => {
    const project = unityProjectDir();
    writeFileSync(
      path.join(project, "ProjectSettings", "LoombridgeInstall.json"),
      `${JSON.stringify({ schemaVersion: 1, agentSurface: { state: "declined", cliVersion: "0.2.0", installedAt: "", files: [] } }, null, 2)}\n`,
    );
    let asked = 0;
    const { order, deps } = spies();
    const code = await quietlyAsync(() =>
      run([], { ...deps, cwd: project, isTTY: true, ask: async () => { asked += 1; return "y"; } }),
    );
    assert.equal(code, 0);
    assert.equal(asked, 0, "a team decision is not re-litigated on every machine");
    assert.ok(!order.some((o) => o.startsWith("agent:")));
  });

  test("an agent-surface install that FAILS stops the run at its exit code", async () => {
    const project = unityProjectDir();
    const { order, deps } = spies({ agent: 1 });
    const code = await quietlyAsync(() => run(["--yes"], { ...deps, cwd: project }));
    assert.equal(code, 1, "the surface was asked for, so failing to install it is a real failure");
    assert.ok(!order.includes("doctor"));
  });
});

describe("setup: idempotence", () => {
  test("a second run over a wired project changes no .mcp.json bytes and exits 0", async () => {
    const project = unityProjectDir();
    const { deps } = spies();
    assert.equal(await quietlyAsync(() => run([], { ...deps, cwd: project })), 0);
    const first = readFileSync(path.join(project, ".mcp.json"), "utf8");
    const record = readInstallMetadata(project)?.mcpRegistration;

    assert.equal(await quietlyAsync(() => run([], { ...deps, cwd: project })), 0, "a re-run must not refuse itself");
    assert.equal(readFileSync(path.join(project, ".mcp.json"), "utf8"), first, "an idempotent run rewrites nothing");
    assert.deepEqual(readInstallMetadata(project)?.mcpRegistration, record, "nor re-stamps the ledger");
  });

  test("a second run preserves another team's MCP server", async () => {
    const project = unityProjectDir();
    writeFileSync(
      path.join(project, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }, null, 2)}\n`,
    );
    const { deps } = spies();
    await quietlyAsync(() => run([], { ...deps, cwd: project }));
    await quietlyAsync(() => run([], { ...deps, cwd: project }));

    const servers = (mcpConfig(project) as { mcpServers: Record<string, unknown> }).mcpServers;
    assert.deepEqual(servers.github, { command: "gh-mcp" });
    assert.deepEqual(servers.loombridge, { command: "loombridge", args: ["mcp"] });
  });
});
