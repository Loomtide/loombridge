import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces the dependency DIRECTION between the source layers.
 *
 * The reorganisation that created `domain/` and `capabilities/` is only worth anything if
 * it stays true. Directory names alone don't stop the next contributor re-creating the
 * 168-file bin this replaced, so the rule is checked, not just documented:
 *
 *     surfaces  ->  capabilities  ->  domain  ->  shared
 *
 * Each layer may import from the ones to its right, never to its left.
 *  - `shared/`       leaf helpers: no domain vocabulary, no capability logic.
 *  - `domain/`       the shared nouns only — schemas, capture paths, workspace layout,
 *                    contract presence. Deliberately small: this check is what proved the
 *                    first cut too generous. Genre packs, sfx cue-maps and mini-game
 *                    profiles all LOOK like vocabulary but import gate implementations,
 *                    so they are capabilities, not domain.
 *  - `capabilities/` one directory per area (verification, replay, minigame, feel, genre,
 *                    assets, sfx, telemetry, setup, mobile), including that area's CLI
 *                    verb entrypoint.
 *
 * KNOWN GAP (step 3 of the organisation plan, deliberately not enforced yet): the files
 * still sitting directly in `src/` mix three layers — MCP transport (unity-client,
 * editor-registry), CLI/MCP entrypoints (index, cli), and shared primitives (types,
 * bridge-protocol). Until they are split into `bridge/`, `surfaces/` and `shared/`, that
 * root is treated as an unlayered zone that anything may import. Enforcing a rule we
 * cannot yet satisfy would mean either a failing suite or a fake exemption list; naming
 * the gap is honest, and this test tightens the moment step 3 lands.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

type Layer = "shared" | "domain" | "bridge" | "capabilities" | "surfaces" | "root";

/**
 * Layers a file may NOT import from.
 *
 *   surfaces -> capabilities -> { bridge, domain } -> shared
 *
 * `bridge` (Unity transport, editor discovery/registry) and `domain` (the shared nouns)
 * are siblings: neither needs the other, and keeping them independent is what stops the
 * wire protocol leaking into contract vocabulary.
 */
const FORBIDDEN: Record<Layer, Layer[]> = {
  shared: ["domain", "bridge", "capabilities", "surfaces"],
  domain: ["bridge", "capabilities", "surfaces"],
  bridge: ["domain", "capabilities", "surfaces"],
  capabilities: ["surfaces"],
  surfaces: [],
  root: [],
};

export function layerOf(relPath: string): Layer {
  const top = relPath.split("/")[0];
  if (top === "shared") return "shared";
  if (top === "domain") return "domain";
  if (top === "bridge") return "bridge";
  if (top === "capabilities") return "capabilities";
  if (top === "surfaces") return "surfaces";
  return "root";
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      tsFiles(abs, acc);
    } else if (e.name.endsWith(".ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

/** Every (importer, imported) layer pair produced by relative imports in the tree. */
export function collectViolations(
  srcRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): string[] {
  const violations: string[] = [];
  for (const abs of tsFiles(srcRoot)) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join("/");
    const from = layerOf(rel);
    const forbidden = FORBIDDEN[from];
    if (forbidden.length === 0) continue;

    const text = readFile(abs);
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const resolved = path
        .relative(srcRoot, path.resolve(path.dirname(abs), spec))
        .split(path.sep)
        .join("/");
      const to = layerOf(resolved);
      if (forbidden.includes(to)) {
        violations.push(`${rel} (${from}) imports ${resolved} (${to})`);
      }
    }
  }
  return violations.sort();
}

test("layering: no import points backwards through the layers", () => {
  const violations = collectViolations(SRC);
  assert.deepEqual(
    violations,
    [],
    `dependency direction violated — a layer may only import layers to its right\n` +
      `(surfaces -> capabilities -> domain -> shared):\n  ${violations.join("\n  ")}`,
  );
});

test("layering LITMUS: the detector actually fires on a planted violation", () => {
  // A checker that cannot fail is worse than no checker: it reads as enforcement while
  // enforcing nothing. Plant a domain -> capabilities import and require a report.
  const planted = path.join(SRC, "domain", "capture-paths.ts");
  assert.ok(fs.existsSync(planted), "fixture file for the litmus must exist");

  const violations = collectViolations(SRC, (p) =>
    p === planted
      ? 'import { runVerify } from "../capabilities/verification/verify.js";'
      : fs.readFileSync(p, "utf-8"),
  );

  assert.equal(violations.length, 1, "exactly the planted violation should be reported");
  assert.match(violations[0], /^domain\/capture-paths\.ts \(domain\) imports capabilities\//);
});

test("layering: the layer classifier maps each top-level directory", () => {
  assert.equal(layerOf("shared/build-stamp.ts"), "shared");
  assert.equal(layerOf("domain/genre-registry.ts"), "domain");
  assert.equal(layerOf("capabilities/replay/engine.ts"), "capabilities");
  assert.equal(layerOf("index.ts"), "root");
  assert.equal(layerOf("verification-legacy/x.ts"), "root");
});
