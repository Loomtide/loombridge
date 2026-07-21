import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Guards the Epic-4 distribution/onboarding invariants (findings RCL-O01/O02/O03):
// an external consumer must be able to reach BOTH halves of Loombridge without a
// machine-local relative path — the bridge via a resolvable UPM dep, the CLI via
// npm/npx, and a template that wires both up out of the box.
//
// Compiled test lives at mcp-server/dist/__tests__/<this>.js, so the repo root is
// three levels up regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf-8"));
}

test("RCL-O02: CLI package.json is a private-org scoped package that ships the bundled bridge", () => {
  const pkg = readJson("mcp-server/package.json");

  // The private-org distribution decision: scoped `@loomtide/loombridge`, published
  // with restricted access — the org owns the npm scope, the CLI ships restricted
  // while the bundled bridge stays UPM-resolvable for consumers.
  assert.equal(pkg.name, "@loomtide/loombridge", "the private-org package name is @loomtide/loombridge");

  const bin = pkg.bin as Record<string, string>;
  assert.equal(bin.loombridge, "dist/cli.js", "the `loombridge` bin must point at the CLI dispatcher");
  assert.equal(bin["loombridge-mcp"], "dist/index.js", "the MCP stdio server bin must be preserved");

  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined;
  assert.equal(
    publishConfig?.access,
    "restricted",
    "publishConfig.access must be restricted — this is a PRIVATE package",
  );

  const repo = pkg.repository as Record<string, unknown> | undefined;
  assert.ok(
    typeof repo?.url === "string" && (repo.url as string).includes("github.com"),
    "a repository url is required npm publish metadata",
  );

  const files = pkg.files as string[];
  assert.ok(files.includes("dist"), "the published tarball must ship dist/");
  assert.ok(files.includes("src"), "src/ ships too (runtime resolves schemas/templates from it)");
  // The load-bearing publish invariant: without bridge/ in the allowlist the bundled
  // .tgz never ships and a partner's `install-bridge` fails with "no bundled bridge tarball".
  assert.ok(files.includes("bridge"), "the published tarball must ship the bundled bridge/ tarball");

  const scripts = pkg.scripts as Record<string, string>;
  assert.ok(scripts.prepack?.includes("build"), "prepack must build dist before packing");
  assert.ok(
    scripts.prepack?.includes("loombridge-pack-bridge"),
    "prepack must (re)pack the bridge tarball into bridge/ so a fresh publish always carries it",
  );
});

test("private channel: one-command GitHub-Releases installer + release script exist", () => {
  const installer = readFileSync(path.join(repoRoot, "scripts/install.sh"), "utf-8");
  assert.ok(installer.startsWith("#!"), "install.sh needs a shebang");
  // Must fetch the private release asset via EITHER the gh CLI or a token (no npm account).
  assert.ok(
    installer.includes("gh release download") && installer.includes("LOOMBRIDGE_TOKEN"),
    "the installer must support both gh-CLI auth and a token for the private release",
  );
  assert.ok(installer.includes("npm install -g"), "the installer must install the packed CLI globally");
  // Idempotent install==update: a --project fast-path also wires the bridge.
  assert.ok(installer.includes("install-bridge"), "the installer should also wire the bridge when --project is given");

  const release = readFileSync(path.join(repoRoot, "scripts/loombridge-release.sh"), "utf-8");
  assert.ok(
    release.includes("npm pack") && release.includes("gh release"),
    "the release script must pack the CLI and publish it as a GitHub Release",
  );
  assert.ok(release.includes("install.sh"), "the release must also publish the installer as an asset");
});

test("loombridge update points CLI self-update at the one-line installer, not an npm registry", () => {
  const src = readFileSync(path.join(repoRoot, "mcp-server/src/loombridge/update.ts"), "utf-8");
  assert.ok(
    src.includes("curl -fsSL") && src.includes("| sh"),
    "the CLI self-update hint must be the curl|sh installer (the same command used to install)",
  );
  assert.ok(
    !/npm install -g @loombridge\/cli/.test(src),
    "self-update must NOT instruct an npm-registry install while the private channel is GitHub Releases",
  );
});

test("RCL-O01: bridge package.json is a UPM-distributable package", () => {
  const pkg = readJson("packages/com.loomtide.loombridge/package.json");
  assert.equal(pkg.name, "com.loomtide.loombridge");
  assert.ok(typeof pkg.version === "string" && (pkg.version as string).length > 0, "version is required");
  assert.ok(typeof pkg.unity === "string", "a `unity` minimum-version field is required for UPM");

  const repo = pkg.repository as Record<string, unknown> | undefined;
  assert.ok(
    typeof repo?.url === "string" && (repo.url as string).includes("github.com"),
    "a git repository url is required to install via git-URL UPM",
  );
  assert.ok(typeof pkg.documentationUrl === "string", "documentationUrl points consumers at install docs");

  const deps = pkg.dependencies as Record<string, string>;
  assert.ok(deps["com.unity.nuget.newtonsoft-json"], "newtonsoft is a hard runtime dep and must resolve transitively");
});

test("RCL-O03: project template wires a RESOLVABLE bridge dep (not a machine-local path)", () => {
  const manifest = readJson("templates/create-loombridge-game/Packages/manifest.json");
  const deps = manifest.dependencies as Record<string, string>;
  const bridge = deps["com.loomtide.loombridge"];
  assert.ok(bridge, "the template manifest must declare the bridge dependency");
  assert.ok(
    !bridge.startsWith("file:"),
    "the template must NOT use a machine-local file: path (the whole point of RCL-O01/O03)",
  );
  assert.ok(
    bridge.startsWith("https://") && bridge.includes("?path=") && bridge.includes("#"),
    "the bridge dep must be a pinned git-URL UPM reference",
  );
  // P1: the pin must be a ref that actually RESOLVES today — a branch (#main) or a commit SHA —
  // NOT a version tag like #v0.1.0 that may not be published yet (a fresh external project would
  // fail package resolution). Reproducible setups pin a SHA or a published release tag; see
  // Docs/BridgeDistribution.md.
  const ref = bridge.split("#").pop() ?? "";
  assert.ok(
    ref === "main" || /^[0-9a-f]{7,40}$/.test(ref),
    `the template pin must be a resolvable ref (#main or a commit SHA), not an unpublished version tag — got "#${ref}"`,
  );
});

test("RCL-O03: project template ships a .mcp.json + .loombridge skeleton", () => {
  const mcp = readJson("templates/create-loombridge-game/.mcp.json");
  const servers = mcp.mcpServers as Record<string, { command?: string }>;
  assert.ok(servers.loombridge, "the template .mcp.json must register a loombridge MCP server");
  assert.ok(typeof servers.loombridge.command === "string", "the server entry needs a launch command");

  // The .loombridge skeleton + Unity version pin must exist as committed files.
  const skeleton = readFileSync(
    path.join(repoRoot, "templates/create-loombridge-game/.loombridge/README.md"),
    "utf-8",
  );
  assert.ok(skeleton.includes("loombridge plan"), "the .loombridge skeleton must point at `loombridge plan`");

  const version = readFileSync(
    path.join(repoRoot, "templates/create-loombridge-game/ProjectSettings/ProjectVersion.txt"),
    "utf-8",
  );
  assert.ok(version.includes("m_EditorVersion:"), "the template must pin a Unity editor version");
});
