import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyServerCommand,
  parseSiblingServers,
  partitionCandidates,
  isLoombridgeServerCwd,
  formatDoctorLines,
  classifyRouteHealth,
  formatRouteHealthLine,
  type SiblingCandidate,
} from "../shared/diagnostics.js";

test("classifyServerCommand: path-qualified forms are trusted, bare is flagged, look-alikes rejected", () => {
  // Path-qualified (unambiguous) — see .mcp.json + loombridge-install-locally.sh:
  assert.equal(classifyServerCommand("node mcp-server/dist/index.js"), "path", "relative");
  assert.equal(classifyServerCommand("/opt/homebrew/bin/node /a/b/mcp-server/dist/index.js"), "path", "absolute");
  assert.equal(classifyServerCommand("/usr/local/bin/node /h/.loombridge/runtime/mcp-server/dist/index.js"), "path", "frozen");
  // Bare (cwd=mcp-server) — must be flagged for a cwd check, not trusted on argv alone:
  assert.equal(classifyServerCommand("node dist/index.js"), "bare", "bare cwd=mcp-server form");
  assert.equal(classifyServerCommand("node22 dist/index.js"), "bare", "versioned node binary");
  // Not the server:
  assert.equal(classifyServerCommand("node dist/scenario-cli.js"), null, "different entrypoint");
  assert.equal(classifyServerCommand("node --test dist/__tests__/diagnostics.test.js"), null, "test runner");
  assert.equal(classifyServerCommand("node /Users/x/some-other-proj/dist/index.js"), null, "unrelated absolute dist/index.js");
  assert.equal(classifyServerCommand("/Applications/Pencil.app/mcp-server-darwin-arm64 --app desktop"), null, "not node");
  assert.equal(classifyServerCommand("bash dist/index.js"), null, "argv0 not a node binary");
});

test("isLoombridgeServerCwd recognizes repo + frozen-runtime mcp-server dirs", () => {
  assert.equal(isLoombridgeServerCwd("/Users/x/Projects/AI/Loombridge/mcp-server"), true);
  assert.equal(isLoombridgeServerCwd("/Users/x/.loombridge/runtime/mcp-server/"), true, "trailing slash tolerated");
  assert.equal(isLoombridgeServerCwd("/Users/x/some-other-proj"), false);
  assert.equal(isLoombridgeServerCwd("/Users/x/mcp-server-fork"), false, "must be the mcp-server dir, not a prefix");
});

const PS = [
  "  2338     2226    06:18:42 node mcp-server/dist/index.js", // path (relative)
  "18523    15908 01-01:53:16 /opt/homebrew/bin/node /a/b/mcp-server/dist/index.js", // path (absolute)
  "20385    20372    01:15:43 node dist/index.js", // BARE — needs cwd check
  " 4242     1234       00:05 node dist/scenario-cli.js", // not the server
  " 5000     1234    00:01:00 node /Users/x/some-other-proj/dist/index.js", // unrelated absolute
].join("\n");

test("parseSiblingServers returns candidates tagged with match confidence, excludes self", () => {
  const cands = parseSiblingServers(PS, /* selfPid */ 2338);
  assert.deepEqual(
    cands.map((c) => [c.pid, c.match]),
    [
      [18523, "path"],
      [20385, "bare"],
    ],
    "self excluded; scenario-cli + unrelated-absolute dropped; bare tagged 'bare'",
  );
});

test("partitionCandidates: path is confirmed; bare confirmed only with a verified mcp-server cwd", async () => {
  const cands: SiblingCandidate[] = [
    { pid: 1, ppid: 0, etime: "1", match: "path" },
    { pid: 2, ppid: 0, etime: "2", match: "bare" }, // cwd = mcp-server -> confirmed
    { pid: 3, ppid: 0, etime: "3", match: "bare" }, // cwd = unrelated proj -> dropped
    { pid: 4, ppid: 0, etime: "4", match: "bare" }, // cwd unresolvable -> ambiguous
  ];
  const cwds: Record<number, string | null> = {
    2: "/Users/x/Loombridge/mcp-server",
    3: "/Users/x/some-other-proj",
    4: null,
  };
  const { confirmed, ambiguous } = await partitionCandidates(cands, async (pid) => cwds[pid] ?? null);

  assert.deepEqual(confirmed.map((s) => s.pid), [1, 2], "path + cwd-verified bare are confirmed");
  assert.deepEqual(ambiguous.map((s) => s.pid), [4], "unverifiable-cwd bare is ambiguous");
  // pid 3 (bare, cwd verified NOT loombridge) is dropped entirely — never recommended for kill.
  assert.equal([...confirmed, ...ambiguous].some((s) => s.pid === 3), false, "unrelated bare app dropped");
});

test("formatDoctorLines recommends kill only for confirmed; ambiguous gets a verify-first note", () => {
  // Clean machine.
  const clean = formatDoctorLines({
    servers: { confirmed: [], ambiguous: [] },
    editorNames: ["my-game"],
    binding: "none",
    activeRoute: "my-game",
  });
  assert.equal(clean.length, 1);
  assert.match(clean[0]!, /0 other loombridge MCP servers/);

  // Confirmed servers -> kill recommendation names exact PIDs.
  const confirmedOnly = formatDoctorLines({
    servers: { confirmed: [{ pid: 18523, ppid: 1, etime: "1" }], ambiguous: [] },
    editorNames: [],
    binding: "cwd:/x",
    activeRoute: null,
  });
  assert.equal(confirmedOnly.length, 2);
  assert.match(confirmedOnly[0]!, /1 other loombridge MCP server \(pids: 18523\)/);
  assert.match(confirmedOnly[1]!, /kill 18523/);
  assert.match(confirmedOnly[1]!, /pkill -f mcp-server\/dist\/index\.js/);

  // Ambiguous-only -> NO kill recommendation, only a verify-first note.
  const ambiguousOnly = formatDoctorLines({
    servers: { confirmed: [], ambiguous: [{ pid: 777, ppid: 1, etime: "1" }] },
    editorNames: [],
    binding: "none",
    activeRoute: null,
  });
  assert.equal(ambiguousOnly.length, 2, "main line + a verify-first NOTE");
  assert.match(ambiguousOnly[0]!, /1 possible \(bare node dist\/index\.js, cwd unverified: pids 777\)/);
  assert.doesNotMatch(ambiguousOnly[1]!, /kill 777/, "must NOT recommend killing an unverified process");
  assert.match(ambiguousOnly[1]!, /verify before killing/);
});

test("route health distinguishes bridge-healthy MCP-route recovery from compile blockers", () => {
  const recoverable = {
    unityProcess: "found" as const,
    endpointFile: "found" as const,
    websocket: "healthy" as const,
    bridgeHandshake: "healthy" as const,
    compileState: "clean" as const,
    mcpRoute: "unregistered" as const,
  };
  assert.equal(classifyRouteHealth(recoverable), "recoverable");
  assert.match(formatRouteHealthLine(recoverable), /bridge is healthy but MCP route is unregistered/);

  const blocked = {
    ...recoverable,
    compileState: "failed" as const,
    latestCompileError: "CS7036 current compile window",
  };
  assert.equal(classifyRouteHealth(blocked), "blocked");
  assert.match(formatRouteHealthLine(blocked), /latest compile error: CS7036 current compile window/);

  const lines = formatDoctorLines({
    servers: { confirmed: [], ambiguous: [] },
    editorNames: ["MyGame"],
    binding: "strict:MyGame",
    activeRoute: "MyGame",
    routeHealth: recoverable,
  });
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /route health recoverable/);
});
