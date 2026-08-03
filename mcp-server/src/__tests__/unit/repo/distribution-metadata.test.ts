import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../../_support/paths.js";

// Guards the distribution/onboarding invariants (findings RCL-O01/O02/O03):
// an external consumer must be able to reach BOTH halves of Loombridge without a
// machine-local relative path — the bridge via a resolvable UPM dep, the CLI via
// the public GitHub-Releases installer, and a template that wires both up out of
// the box. This repo is the public source; releases are public GitHub Releases.
//
// Compiled test lives at mcp-server/dist/__tests__/<this>.js, so the repo root is
// three levels up regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = REPO_ROOT;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf-8"));
}

test("RCL-O02: CLI package.json is the public npm package that ships the bundled bridge", () => {
  const pkg = readJson("mcp-server/package.json");

  // The distribution decision: the UNSCOPED `loombridge`, published with public access.
  // The org reserved both `loombridge` and `@loomtide/loombridge`; the unscoped name won
  // because the install line is the first thing a new developer reads, and the bundled
  // bridge stays UPM-resolvable for consumers either way.
  //
  // This is pinned rather than left free because the name is wired into three places that
  // cannot discover it at runtime: the README install line, `install.sh`, and the CLI's own
  // self-update command (`cli-install-method.ts#NPM_PACKAGE_NAME`). A rename that missed any
  // of them would print an install command for a package that is not this one.
  assert.equal(pkg.name, "loombridge", "the published package name is the unscoped `loombridge`");

  const bin = pkg.bin as Record<string, string>;
  assert.equal(bin.loombridge, "dist/surfaces/cli.js", "the `loombridge` bin must point at the CLI dispatcher");
  assert.equal(bin["loombridge-mcp"], "dist/surfaces/index.js", "the MCP stdio server bin must be preserved");

  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined;
  assert.equal(
    publishConfig?.access,
    "public",
    "publishConfig.access must be public: publishing publicly is explicit, never inferred",
  );

  const repo = pkg.repository as Record<string, unknown> | undefined;
  assert.ok(
    typeof repo?.url === "string" && (repo.url as string).includes("github.com/Loomtide/loombridge"),
    "the repository url must point at the public github.com/Loomtide/loombridge source",
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

test("the CLI's self-update command names THIS package, not a different one", async () => {
  // A declared path nothing walks, at the install layer: `loombridge update` builds its own
  // `npm install -g <name>@latest` from a constant. If that constant and package.json ever
  // disagree, the CLI cheerfully installs some OTHER package over itself, and every test
  // that exercises the update flow still passes because they all read the same constant.
  const pkg = readJson("mcp-server/package.json");
  const { NPM_PACKAGE_NAME, selfUpdateCommandFor } = await import(
    "../../../capabilities/setup/cli-install-method.js"
  );

  assert.equal(
    NPM_PACKAGE_NAME,
    pkg.name,
    "cli-install-method.ts#NPM_PACKAGE_NAME must equal package.json#name",
  );
  assert.equal(
    selfUpdateCommandFor("npm-package"),
    `npm install -g ${pkg.name as string}@latest`,
    "the printed self-update command must install the package this repo publishes",
  );
});

test("release channel: one-command GitHub-Releases installer + release script exist", () => {
  const installer = readFileSync(path.join(repoRoot, "scripts/install.sh"), "utf-8");
  assert.ok(installer.startsWith("#!"), "install.sh needs a shebang");
  // Fetches the release asset via the gh CLI (with a token fallback for CI) — no npm
  // account. Public releases need no auth; the gh/token paths keep the pre-flip private
  // window working too.
  assert.ok(
    installer.includes("gh release download") && installer.includes("LOOMBRIDGE_TOKEN"),
    "the installer must support gh-CLI download plus a token fallback for the release asset",
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

test("loombridge update self-updates ONLY through the channel it owns", async () => {
  // Supersedes the earlier decision that self-update must be instruct-only via install.sh.
  // That held while the GitHub-Releases installer was the supported channel; npm is now the
  // supported channel, and `npm install -g <pkg>@latest` is one portable command that does
  // not care which node version manager is in play.
  //
  // What must NOT change is the other half: an install is run ONLY for a registry install.
  // On a source checkout, `npm install -g` would replace a developer's working tree with a
  // published build, and on a frozen runtime it would leave two CLIs on PATH. Those channels
  // are instructed, never actuated. This asserts the real function, so a regression that
  // widened the branch fails here rather than in prose.
  const { selfUpdateCommandFor } = await import("../../../capabilities/setup/cli-install-method.js");

  assert.ok(selfUpdateCommandFor("npm-package"), "the npm channel must be self-updatable");

  for (const method of ["frozen-runtime", "dev-clone", "unknown"] as const) {
    assert.equal(
      selfUpdateCommandFor(method),
      null,
      `the ${method} channel must be INSTRUCTED, never self-updated by running an install`,
    );
  }

  // The installer remains the documented fallback for the channels above.
  const src = readFileSync(
    path.join(repoRoot, "mcp-server/src/capabilities/setup/cli-install-method.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("install.sh"),
    "the manual-update instruction must still name the GitHub-Releases installer fallback",
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
