import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { knownGenreIds } from "../../../../capabilities/genre/genre-registry.js";

/**
 * The decoupling LITMUS (slice-2 of genre-pack decoupling). The genre-neutral pipeline core must not
 * hard-code a genre id nor statically import a genre pack — the ONE sanctioned place those live is
 * `genre-registry.ts` (the wiring point), with pack material under `genre-packs/`.
 *
 * SCOPE: the plan → build → verify → doneness genre pipeline = everything under `src/capabilities/` and
 * `src/capabilities/verification/`. Exclusions (each a deliberate, sanctioned home for genre knowledge):
 *   - `genre-registry.ts`  — the single wiring point; genre ids + pack bindings live here by design.
 *   - `genre-packs/**`     — relocated per-genre pack material.
 *   - `__tests__/**`       — tests may name genres freely.
 * The hosted asset-catalog layer (`src/asset-layer/`) is a SEPARATE subsystem with its own
 * genre→asset-pack mappings; it is intentionally outside this pipeline litmus.
 *
 * This enforces the two CONCRETE coupling axes closed in slice 2 (a hard-coded genre-id string literal,
 * and a static `genre-packs/` import) — in any quote style, with comments excluded. It is a regression
 * tripwire for the honest refactor, NOT an exhaustive moat: it matches genre ids written as LITERALS,
 * not strings assembled by concatenation/interpolation; and it deliberately does NOT police every way a
 * file could be genre-aware — e.g. the platformer gate-tuning section's `platformer` key on
 * AcceptanceContract is a distinct axis handled in the contract-promotion work. Coupling in the
 * separate asset-catalog subsystem is likewise out of scope (tracked there) — it moved from
 * `src/asset-layer/` to `src/capabilities/assets/` in the source reorganisation, so the exclusion
 * below follows it. That subsystem legitimately declares genre ids in its own profile table.
 */

const SRC_ROOTS = ["src/capabilities", "src/domain"].map((rel) => path.join(process.cwd(), rel));
const EXCLUDED_FILE = path.join(process.cwd(), "src", "capabilities", "genre", "genre-registry.ts");
/** The asset-catalog subsystem: out of scope by the same decision recorded above. */
const EXCLUDED_DIRS = [path.join(process.cwd(), "src", "capabilities", "assets")];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "genre-packs" || entry.name === "__tests__") continue;
      if (EXCLUDED_DIRS.includes(full)) continue;
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith(".ts") && full !== EXCLUDED_FILE) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The genre-id detector that BOTH scan tests and the self-test share (so they can never drift apart).
 * Matches a registered id as a string literal in ANY quote style — `"x"` / `'x'` / `` `x` `` — because
 * a backtick literal is idiomatic TS and an easy bypass of a double-quote-only matcher.
 */
function buildGenreLiteralRe(): RegExp {
  const ids = knownGenreIds()
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp("[\"'`](?:" + ids + ")[\"'`]");
}

/** Detects a static import from a genre pack (any quote style). */
const PACK_IMPORT_RE = /\bfrom\s+["'`][^"'`]*genre-packs\/[^"'`]*["'`]/;

/**
 * Strip comments so a genre id MENTIONED in prose (e.g. a `// e.g. "2d-shooter"` doc comment) is not a
 * violation — only genre ids in LIVE code count. Block comments are removed first (across lines); then
 * each line's trailing `//` comment is removed with a STRING-AWARE scan, so a `//` inside a
 * `"…"`/`'…'`/`` `…` `` literal is NOT treated as a comment and a real genre literal can never hide
 * behind a string that happens to contain `//`.
 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlock.split("\n").map(stripLineComment).join("\n");
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\") {
        i += 1; // skip the escaped character
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

test("LITMUS: no genre-pipeline core file hard-codes a genre id (only genre-registry may)", () => {
  assert.ok(knownGenreIds().length > 0, "expected at least one registered genre");
  const literalRe = buildGenreLiteralRe();

  const violations: string[] = [];
  for (const root of SRC_ROOTS) {
    for (const file of tsFilesUnder(root)) {
      const code = stripComments(readFileSync(file, "utf-8"));
      code.split("\n").forEach((line, i) => {
        if (literalRe.test(line)) {
          violations.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    violations,
    [],
    `genre id hard-coded in pipeline core — route it through genre-registry.js (defaultGenreId()/` +
      `resolveGenrePack()/scenarioPacks()), not a literal:\n${violations.join("\n")}`,
  );
});

test("LITMUS: no genre-pipeline core file statically imports a genre pack (only genre-registry may)", () => {
  const violations: string[] = [];
  for (const root of SRC_ROOTS) {
    for (const file of tsFilesUnder(root)) {
      const code = stripComments(readFileSync(file, "utf-8"));
      code.split("\n").forEach((line, i) => {
        if (PACK_IMPORT_RE.test(line)) {
          violations.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    violations,
    [],
    `genre pack imported into pipeline core — resolve it lazily through genre-registry.js instead:\n${violations.join("\n")}`,
  );
});

test("LITMUS self-test: the detector actually fires on a violation and ignores a commented mention", () => {
  // A litmus that can never fail is worthless. Prove the literal detector + comment-stripper work, so
  // this gate can't silently degrade into a no-op (e.g. a broken glob or an over-eager stripper).
  const literalRe = buildGenreLiteralRe();
  const sample = knownGenreIds()[0]!;

  // Live code with the literal → caught, in every quote style (incl. backtick — the bypass an agent
  // "fixing" a regression could reach for).
  assert.ok(literalRe.test(stripComments(`const g = "${sample}";`)), "must flag a double-quoted literal");
  assert.ok(literalRe.test(stripComments(`const g = '${sample}';`)), "must flag a single-quoted literal");
  assert.ok(literalRe.test(stripComments("const g = `" + sample + "`;")), "must flag a backtick literal");
  // The SAME literal inside a line comment / block comment → stripped, not flagged.
  assert.ok(!literalRe.test(stripComments(`const g = x; // e.g. "${sample}"`)), "must ignore a line-comment mention");
  assert.ok(!literalRe.test(stripComments(`/** stable id, e.g. "${sample}" */`)), "must ignore a block-comment mention");
  // A `//` INSIDE a string must not let a real literal hide after it (the string-aware stripper).
  assert.ok(
    literalRe.test(stripComments(`const u = "http://x"; const g = "${sample}";`)),
    "must still flag a live literal that follows a string containing //",
  );
  // The genre-packs import detector fires, including backtick-quoted specifiers.
  assert.ok(PACK_IMPORT_RE.test(`import { x } from "./genre-packs/platformer-2d/profiles.js";`), "must flag a pack import");
  assert.ok(PACK_IMPORT_RE.test("import { x } from `./genre-packs/platformer-2d/profiles.js`;"), "must flag a backtick pack import");
});

test("LITMUS scope is real: the excluded genre-registry.ts is where the genre ids actually live", () => {
  // Guards against the exclusion masking nothing (e.g. a renamed/empty registry): the registry file
  // must itself contain every registered genre id, proving it is the genuine wiring point we exclude.
  const registry = readFileSync(EXCLUDED_FILE, "utf-8");
  for (const id of knownGenreIds()) {
    assert.ok(registry.includes(`"${id}"`), `genre-registry.ts must declare genre id "${id}"`);
  }
});
