/**
 * `loombridge install-mcp`: the `.mcp.json` merge rules.
 *
 * This verb writes into a file the PROJECT owns, so every guard below is about touching
 * exactly one key and nothing else. Each one names the failure it closes:
 *
 *  - MERGE, never clobber: another team's MCP server silently disappearing is the whole
 *    hazard of writing into a shared config file.
 *  - A `loombridge` entry Loombridge did not write is REFUSED. A developer's edit is theirs.
 *  - Malformed JSON refuses rather than starting fresh: rewriting a file we could not parse
 *    discards configuration we never read.
 *  - Idempotent: a second run over an entry we wrote changes NO bytes and exits 0.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import {
  MCP_CONFIG_RELPATH,
  MCP_SERVER_KEY,
  canonicalJson,
  desiredServerEntry,
  entrySha,
  resolveMcpConfigPath,
  runInstallMcp,
} from "../../../../capabilities/setup/install-mcp.js";
import { readInstallMetadata } from "../../../../capabilities/setup/bridge-install-common.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lb-install-mcp-"));
  temps.push(dir);
  return dir;
}

/** A directory `looksLikeUnityProject` accepts. */
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

function quietly<T>(fn: () => T): T {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

function configPath(project: string): string {
  return path.join(project, MCP_CONFIG_RELPATH);
}

function readConfig(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(project), "utf8")) as Record<string, unknown>;
}

function install(project: string): number {
  return quietly(() => runInstallMcp({ project, dryRun: false }));
}

/** Run while capturing stdout, so "it decided to do nothing" can be asserted directly. */
function capture(fn: () => number): { code: number; out: string } {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = () => {};
  console.error = () => {};
  try {
    return { code: fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

describe("install-mcp: writing the entry", () => {
  test("a project with no .mcp.json gets one with exactly the documented entry", () => {
    const project = unityProjectDir();
    assert.equal(install(project), 0);

    const config = readConfig(project);
    assert.deepEqual(config, { mcpServers: { loombridge: { command: "loombridge", args: ["mcp"] } } });
  });

  test("the entry is recorded in the install ledger so ownership is provable later", () => {
    const project = unityProjectDir();
    install(project);

    const record = readInstallMetadata(project)?.mcpRegistration;
    assert.ok(record, "the run must record what it wrote");
    assert.equal(record.state, "enabled");
    assert.equal(record.path, MCP_CONFIG_RELPATH);
    assert.equal(record.serverKey, MCP_SERVER_KEY);
    // The sha covers OUR ENTRY, not the whole file: other tooling adds servers to this file,
    // and a whole-file hash would read every unrelated addition as a hand edit.
    assert.equal(record.entrySha256, entrySha(desiredServerEntry()));
  });

  test("the ledger is merged into an existing record, never written over it", () => {
    const project = unityProjectDir();
    mkdirSync(path.join(project, "ProjectSettings"), { recursive: true });
    writeFileSync(
      path.join(project, "ProjectSettings", "LoombridgeInstall.json"),
      `${JSON.stringify({ schemaVersion: 1, bridgeVersion: "9.9.9", agentSurface: { state: "declined", files: [] } }, null, 2)}\n`,
    );

    assert.equal(install(project), 0);
    const meta = readInstallMetadata(project);
    assert.equal(meta?.bridgeVersion, "9.9.9", "the bridge fields must survive");
    assert.equal(meta?.agentSurface?.state, "declined", "the agent-surface choice must survive");
    assert.ok(meta?.mcpRegistration, "and the MCP record must be there too");
  });
});

describe("install-mcp: MERGE, never clobber", () => {
  test("every other server and every other top-level key is preserved", () => {
    const project = unityProjectDir();
    const before = {
      $schema: "https://example.invalid/mcp.json",
      mcpServers: {
        github: { command: "gh-mcp", args: ["serve"] },
        postgres: { command: "pg-mcp", args: [], env: { PGHOST: "localhost" } },
      },
      somethingElse: { keep: true },
    };
    writeFileSync(configPath(project), `${JSON.stringify(before, null, 2)}\n`);

    assert.equal(install(project), 0);

    const after = readConfig(project) as typeof before & { mcpServers: Record<string, unknown> };
    assert.deepEqual(after.$schema, before.$schema, "unrelated top-level keys must survive");
    assert.deepEqual(after.somethingElse, before.somethingElse, "unrelated top-level keys must survive");
    assert.deepEqual(after.mcpServers.github, before.mcpServers.github, "another team's server must survive");
    assert.deepEqual(after.mcpServers.postgres, before.mcpServers.postgres, "another team's server must survive");
    assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], desiredServerEntry());
  });

  test("an existing file with no mcpServers key gains one without losing anything", () => {
    const project = unityProjectDir();
    writeFileSync(configPath(project), `${JSON.stringify({ inputs: [{ id: "token" }] }, null, 2)}\n`);

    assert.equal(install(project), 0);
    const after = readConfig(project) as { inputs: unknown; mcpServers: Record<string, unknown> };
    assert.deepEqual(after.inputs, [{ id: "token" }]);
    assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], desiredServerEntry());
  });
});

describe("install-mcp: refusals", () => {
  test("REFUSAL: a `loombridge` entry we did not write is never overwritten", () => {
    const project = unityProjectDir();
    const theirs = {
      mcpServers: {
        loombridge: { command: "/opt/custom/loombridge", args: ["mcp", "--port", "9999"] },
      },
    };
    const bytes = `${JSON.stringify(theirs, null, 2)}\n`;
    writeFileSync(configPath(project), bytes);

    const code = quietly(() => runInstallMcp({ project, dryRun: false }));
    assert.equal(code, 2, "a foreign entry is a precondition failure, not a silent overwrite");
    assert.equal(readFileSync(configPath(project), "utf8"), bytes, "not one byte may change");
    assert.equal(readInstallMetadata(project)?.mcpRegistration, undefined, "and nothing may be claimed in the ledger");
  });

  test("REFUSAL: an entry we DID write, then a human changed, is treated as theirs", () => {
    // The ledger is what tells the two apart. Once the bytes stop matching what we recorded,
    // the entry is the developer's, the same rule install-agent applies to its managed files.
    const project = unityProjectDir();
    assert.equal(install(project), 0);

    const config = readConfig(project) as { mcpServers: Record<string, unknown> };
    config.mcpServers[MCP_SERVER_KEY] = { command: "loombridge", args: ["mcp", "--verbose"] };
    const bytes = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(configPath(project), bytes);

    const code = quietly(() => runInstallMcp({ project, dryRun: false }));
    assert.equal(code, 2);
    assert.equal(readFileSync(configPath(project), "utf8"), bytes, "a hand-edited entry is never rewritten");
  });

  test("REFUSAL: malformed JSON refuses rather than starting fresh", () => {
    const project = unityProjectDir();
    const bytes = '{ "mcpServers": { "github": { "command": "gh-mcp" } }, }  // trailing junk\n';
    writeFileSync(configPath(project), bytes);

    const code = quietly(() => runInstallMcp({ project, dryRun: false }));
    assert.equal(code, 2, "an unparseable config is a precondition failure");
    assert.equal(readFileSync(configPath(project), "utf8"), bytes, "rewriting it would delete servers we never read");
  });

  test("REFUSAL: a JSON file that is not an object, and an mcpServers that is not an object", () => {
    for (const bytes of ["[1, 2, 3]\n", '{ "mcpServers": ["github"] }\n']) {
      const project = unityProjectDir();
      writeFileSync(configPath(project), bytes);
      const code = quietly(() => runInstallMcp({ project, dryRun: false }));
      assert.equal(code, 2, `must refuse: ${bytes.trim()}`);
      assert.equal(readFileSync(configPath(project), "utf8"), bytes, "nothing may be replaced");
    }
  });

  test("REFUSAL: a directory that is not a Unity project, and nothing is written", () => {
    const dir = tempDir();
    const code = quietly(() => runInstallMcp({ project: dir, dryRun: false }));
    assert.equal(code, 2);
    assert.deepEqual(readdirSync(dir), [], "a refusal must leave the directory untouched");
  });

  test("REFUSAL: a config path that escapes the project root", () => {
    // No argv route reaches this today (the relpath is a constant), which is exactly why it is
    // asserted directly: "never write outside the project root" is an invariant of the verb,
    // not a property of one string a later change could quietly alter.
    const project = unityProjectDir();
    assert.throws(() => resolveMcpConfigPath(project, "../escaped.json"), /outside the project root/);
    assert.throws(() => resolveMcpConfigPath(project, path.join(os.tmpdir(), "abs.json")), /outside the project root/);
    assert.equal(resolveMcpConfigPath(project), path.join(project, MCP_CONFIG_RELPATH));
  });
});

describe("install-mcp: idempotence and ownership across upgrades", () => {
  test("a second run changes no bytes, says so, and exits 0", () => {
    const project = unityProjectDir();
    assert.equal(install(project), 0);
    const first = readFileSync(configPath(project), "utf8");

    const second = capture(() => runInstallMcp({ project, dryRun: false }));
    assert.equal(second.code, 0, "a re-run is a no-op, not a refusal");
    assert.equal(readFileSync(configPath(project), "utf8"), first, "an idempotent run rewrites nothing");
    // Byte equality alone would still pass if the run rewrote identical content and re-stamped
    // the ledger, so the DECISION is asserted too: it recognised the entry and stopped.
    assert.match(second.out, /already registered by Loombridge; nothing to change/);
  });

  test("an entry we own is REFRESHED when the desired entry changes", () => {
    // Loombridge owns its entry across upgrades. Simulated by recording the sha of an older
    // entry shape, then re-running: the ledger says it is ours, so it is updated in place.
    const project = unityProjectDir();
    const old = { command: "loombridge", args: ["mcp", "--legacy"] };
    writeFileSync(configPath(project), `${JSON.stringify({ mcpServers: { loombridge: old } }, null, 2)}\n`);
    mkdirSync(path.join(project, "ProjectSettings"), { recursive: true });
    writeFileSync(
      path.join(project, "ProjectSettings", "LoombridgeInstall.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mcpRegistration: {
            state: "enabled",
            cliVersion: "0.0.1",
            installedAt: "2020-01-01T00:00:00.000Z",
            path: MCP_CONFIG_RELPATH,
            serverKey: MCP_SERVER_KEY,
            entrySha256: entrySha(old),
          },
        },
        null,
        2,
      )}\n`,
    );

    assert.equal(install(project), 0);
    const after = readConfig(project) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], desiredServerEntry(), "our own entry is ours to update");
  });

  test("an identical entry we did NOT write is left alone and NOT claimed", () => {
    // Nothing to refuse (no bytes would change) and nothing to claim: recording ownership of
    // a line a human typed would let a later version rewrite it.
    const project = unityProjectDir();
    const bytes = `${JSON.stringify({ mcpServers: { loombridge: desiredServerEntry() } }, null, 2)}\n`;
    writeFileSync(configPath(project), bytes);

    assert.equal(install(project), 0);
    assert.equal(readFileSync(configPath(project), "utf8"), bytes);
    assert.equal(readInstallMetadata(project)?.mcpRegistration, undefined, "ownership is not claimed by adoption");
  });

  test("--dry-run writes nothing at all", () => {
    const project = unityProjectDir();
    const code = quietly(() => runInstallMcp({ project, dryRun: true }));
    assert.equal(code, 0);
    assert.equal(existsSync(configPath(project)), false, "--dry-run must not create the config");
    assert.equal(readInstallMetadata(project)?.mcpRegistration, undefined, "nor the ledger entry");
  });
});

describe("install-mcp: the ownership sha", () => {
  test("canonical JSON is key-order independent, so a reformat is not a hand edit", () => {
    assert.equal(
      entrySha({ command: "loombridge", args: ["mcp"] }),
      entrySha({ args: ["mcp"], command: "loombridge" }),
      "a client rewriting the same entry with keys reordered must still be recognised as ours",
    );
  });

  test("but array order and values DO change it, so a real edit is detected", () => {
    assert.notEqual(entrySha({ args: ["mcp", "--x"] }), entrySha({ args: ["--x", "mcp"] }));
    assert.notEqual(entrySha(desiredServerEntry()), entrySha({ command: "loombridge", args: ["mcp", "--x"] }));
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  });
});
