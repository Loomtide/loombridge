import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";

/**
 * Guard: the docs may not claim the hosted catalog's base URL is published somewhere it is not.
 *
 * SNP-P01. SEVEN shipped files told the reader "the current base URL is published alongside the
 * asset store at https://assetstore.loomtide.ai/". It was not published there, or anywhere. Tested
 * while mining the run that hit it: the store answers 200 on `/` and 404 on `/about`, `/docs`,
 * `/api` and `/api-docs`, and the base URL appears nowhere in its page HTML.
 *
 * A real `loombridge plan` session burned 16 curl calls guessing hostnames and finally, in its own
 * words, "recovered it from the store's JS bundles".
 *
 * This is the repo's recurring failure shape moved one layer out. `AssetRegistryOssBoundary.md`
 * correctly scrubbed the deployment hostname and wired `LOOMBRIDGE_ASSET_CATALOG_URL`, and every
 * guard around it passes. The REPLACEMENT was a prose promise, and prose is where this repo has no
 * guards, so a false claim shipped and stayed green.
 *
 * WHAT THIS CAN AND CANNOT CHECK. It cannot fetch the store: CI must stay offline and
 * deterministic, and a network assertion would fail on an unrelated outage. So it bans the CLAIM
 * rather than verifying the fact. That trade has a KNOWN COST, paid once already: banning one
 * phrasing let an equally-false replacement ship in the same file. Hence two patterns, and hence
 * this note: adding a phrasing here is cheaper than the alternative, but the list can never be
 * complete. If the URL ever IS published at a stable path, replace this guard with one that names
 * that path rather than deleting it.
 */
/**
 * The claims. TWO patterns, because banning one phrasing let an equally-false one ship: the same
 * doc that survived the first pass also said "Get the current one from the asset store", which the
 * single phrase-ban could not see.
 */
const BANNED_CLAIMS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /published\s+alongside\s+the\s+asset\s+store/i, why: "the store publishes no such thing" },
  {
    re: /\b(?:get|obtain|find|grab)\s+(?:the\s+)?(?:current\s+)?(?:one|it|url|base\s*url)\s+from\s+the\s+asset\s+store/i,
    why: "the store does not surface it; a reader following this ends up scraping JS bundles",
  },
];

/**
 * Collapse whitespace AND markdown blockquote/list markers before matching.
 *
 * THIS IS THE LOAD-BEARING PART, learned the hard way. The first cut scanned line by line and
 * therefore missed the seventh instance of the claim, in `Docs/Assets/PublicCatalogQuickstart.md`,
 * purely because markdown had wrapped it across two blockquote lines. The guard shipped green over
 * a live false claim, in the very doc the other fixed docs link to. The sibling guard
 * `asset-priority-docs.test.ts` already had `flatten` for exactly this reason; this one reimplemented
 * the walk and dropped it.
 *
 * Flattening alone is still not enough here: the `>` markers sit between the wrapped halves, so
 * they must be stripped too. Verified against the real file: line scan MISSED, flatten-only MISSED,
 * flatten-plus-marker-stripping CAUGHT.
 */
function flatten(text: string): string {
  return text.replace(/[>*\-\s]+/g, " ");
}

/**
 * Files allowed to contain the phrase, with the reason. The findings ledger QUOTES the false claim
 * as the evidence for the finding; deleting the quote there would destroy the audit trail that
 * explains why this guard exists.
 */
const ALLOWED = new Map<string, string>([
  ["Docs/Design/SniperShooterPlanLedger.md", "quotes the false claim verbatim as the finding's evidence"],
  // This guard lives inside the tree it scans, and it must NAME the sentence it bans: in the test
  // title, in the failure message, and in the LITMUS fixtures. Without this entry the scan reports
  // itself, which it did the moment the file became tracked (it passed only while untracked, since
  // `git ls-files` could not see it). Sibling guards solve the same problem by assembling the
  // pattern from parts; an explicit allowlist entry says it out loud instead.
  ["mcp-server/src/__tests__/unit/repo/catalog-url-claim.test.ts", "the guard must name the claim it bans"],
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".wav", ".ogg", ".mp3",
  ".ttf", ".otf", ".woff", ".woff2", ".zip", ".gz", ".tgz", ".pdf", ".unitypackage", ".dll", ".so", ".dylib",
]);
const SKIP_PREFIXES = ["node_modules/", "dist/", ".claude/worktrees/"];

/** Every tracked, text-ish file. `git ls-files` is the authority on what ships. */
function trackedTextFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return (result.stdout ?? "")
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !BINARY_EXTS.has(path.extname(f).toLowerCase()))
    .filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p) || f.includes(`/${p}`)))
    .filter((f) => {
      const abs = path.join(REPO_ROOT, f);
      return fs.existsSync(abs) && fs.lstatSync(abs).isFile();
    })
    .sort();
}

/** THE scan. Both the real check and the LITMUS call this, so neutering it turns the LITMUS red. */
export function unverifiableClaimFindings(files: Array<{ file: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { file, text } of files) {
    if (ALLOWED.has(file)) continue;
    const flat = flatten(text);
    for (const { re } of BANNED_CLAIMS) {
      if (re.test(flat)) findings.push(file);
    }
  }
  return [...new Set(findings)].sort();
}

test("no shipped doc claims the catalog base URL is published alongside the asset store", () => {
  const files = trackedTextFiles().map((file) => ({
    file,
    text: fs.readFileSync(path.join(REPO_ROOT, file), "utf-8"),
  }));
  assert.ok(files.length > 500, `scan looks vacuous: ${files.length} files walked`);

  const findings = unverifiableClaimFindings(files);
  assert.deepEqual(
    findings,
    [],
    "this claim was false and cost a real session 16 curl calls and a JS-bundle scrape. Say what is " +
      "true instead: the base URL is not published at a fixed path, so obtain it from the catalog's " +
      `operator and set LOOMBRIDGE_ASSET_CATALOG_URL:\n  ${findings.join("\n  ")}`,
  );
});

test("LITMUS: the scan catches both claims, survives markdown wrapping, respects the allowlist", () => {
  // Exercises the same function the real check runs, so neutering the scan turns THIS red.
  assert.deepEqual(
    unverifiableClaimFindings([{ file: "a.md", text: "The base URL is published alongside the asset store." }]),
    ["a.md"],
  );

  // THE REGRESSION THIS GUARD SHIPPED WITH. The first cut was a line scan and missed exactly this
  // shape: the claim wrapped across two blockquote lines in PublicCatalogQuickstart.md, live and
  // green. Reproduced here in its real form, markers and all.
  assert.deepEqual(
    unverifiableClaimFindings([{
      file: "b.md",
      text: "> search API exposing `/v1/assets/search`, and the current base URL is published\n> alongside the asset store (`https://assetstore.loomtide.ai/`).",
    }]),
    ["b.md"],
    "a claim wrapped across blockquote lines must be caught: this is the miss that shipped",
  );

  // The SECOND claim, which the single-phrase ban could not see even on one line.
  assert.deepEqual(
    unverifiableClaimFindings([{ file: "c.md", text: "Get the current one from the asset store (https://x/)." }]),
    ["c.md"],
  );

  // Allowlisted files keep their evidence quotes.
  assert.deepEqual(
    unverifiableClaimFindings([
      { file: "Docs/Design/SniperShooterPlanLedger.md", text: "published alongside the asset store" },
    ]),
    [],
  );

  // ...and it is not always-red: the honest replacement wording passes.
  assert.deepEqual(
    unverifiableClaimFindings([{
      file: "d.md",
      text: "The base URL is not published at a fixed path, so obtain it from whoever operates the\ncatalog and set `LOOMBRIDGE_ASSET_CATALOG_URL`.",
    }]),
    [],
  );
});
