/**
 * A9: NO FLAG JOINS THE ORCHESTRATOR BY OMISSION.
 *
 * The bare `verify` front door routes on a POSITIVE allowlist, and that direction is
 * only worth something if the allowlist is checked against reality. The failure this
 * guard exists to prevent is quiet: someone adds a flag to `parseArgs`, never thinks
 * about the unified door, and the flag either silently gets swallowed by a code path
 * written for a different shape, or (worse, if the routing rule were ever relaxed to a
 * negative test) drags a whole legacy mode into the orchestrator.
 *
 * So the test walks the flags `parseArgs` actually accepts, straight out of the source,
 * and requires every one of them to be classified ON PURPOSE: orchestrator-allowed (the
 * exported `ORCHESTRATOR_FLAGS`, which is the same set the router reads at runtime) or
 * legacy (the list below). A new flag fails until its author picks a side.
 *
 * The legacy list lives here rather than in `verify.ts` deliberately: it exists only to
 * make this guard total, and a set the shipped code never reads would be dead weight in
 * the module it guards.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { ORCHESTRATOR_FLAGS } from "../../../../capabilities/verification/verify.js";

const VERIFY_SRC = path.join(PKG_ROOT, "src", "capabilities", "verification", "verify.ts");

/**
 * THE SCAN. Every flag literal the argv loop compares against, read from source.
 *
 * Both the real check and its LITMUS call this: a LITMUS that re-implemented the scan
 * inline would prove nothing about the code that ships.
 */
export function acceptedFlags(source: string): string[] {
  return [...new Set([...source.matchAll(/arg === "(-{1,2}[a-z0-9-]+)"/g)].map((m) => m[1]!))].sort();
}

/** The flags that deliberately stay on the legacy engine paths, exactly as before S1. */
const LEGACY_FLAGS: ReadonlySet<string> = new Set([
  "--acceptance",
  "--activate",
  "--animator-bool",
  "--animator-controller",
  "--animator-host",
  "--apply",
  "--capture-artifacts",
  "--capture-contract",
  "--capture-only",
  "--captures",
  "--contract",
  "--coyote-probe",
  "--dash-key",
  "--discover",
  "--enforce-taste",
  "--force",
  "--game",
  "--help",
  "-h",
  "--inputs",
  "--joystick",
  "--jump-button",
  "--jump-buffer-probe",
  "--jump-key",
  "--layout",
  "--measurements",
  "--measurements-output",
  "--minigame",
  "--move-right-key",
  "--no-auto-activate",
  "--output",
  "--player",
  "--profile",
  "--project",
  "--quiet-next",
  "--scene",
  "--setup-capture",
  "--slice",
  "--snapshot",
  "--source-root",
  "--stage",
  "--verbose",
  "--vlm",
]);

/** The flags that are neither allowlisted nor deliberately legacy: the failure case. */
function unclassified(source: string): string[] {
  return acceptedFlags(source).filter((f) => !ORCHESTRATOR_FLAGS.has(f) && !LEGACY_FLAGS.has(f));
}

test("every flag verify accepts is classified orchestrator-allowed or legacy, on purpose", () => {
  const source = readFileSync(VERIFY_SRC, "utf-8");
  assert.deepEqual(
    unclassified(source),
    [],
    "a flag reached `verify` without being routed: add it to ORCHESTRATOR_FLAGS (and teach the "
      + "orchestrator what it means) or to LEGACY_FLAGS in this test",
  );

  // The scan must actually see the parser, not an empty file or a renamed function.
  const found = acceptedFlags(source);
  assert.ok(found.length > 30, `the scan found only ${found.length} flags; it is not reading the parser`);
  for (const flag of ["--inputs", "--minigame", "--snapshot", "--profile", "--slice", "--stage"]) {
    assert.ok(found.includes(flag), `the scan missed the known flag ${flag}`);
  }
});

test("the orchestrator allowlist is exactly the six bare-run flags, and the router reads THIS set", () => {
  // Pinned as a value, not a count: growing this set is a routing decision, and it must
  // show up as a diff on this line rather than as a number quietly ticking up.
  assert.deepEqual(
    [...ORCHESTRATOR_FLAGS].sort(),
    ["--id", "--live", "--report", "--root", "--strict", "--workspace"],
  );
  // `--live` and `--report` are orchestrator-only: `parseArgs` never sees them, which is
  // why they can be absent from the scanned set without being unclassified.
  for (const flag of ["--live", "--report"]) assert.ok(ORCHESTRATOR_FLAGS.has(flag));
});

test("LITMUS: a planted, unclassified flag really does fail the walk", () => {
  // If this comes back empty, the guard above is decorative.
  const planted = `${readFileSync(VERIFY_SRC, "utf-8")}\n// planted\nfunction __planted__(arg: string) { return arg === "--brand-new"; }\n`;
  assert.deepEqual(
    unclassified(planted),
    ["--brand-new"],
    "the walk missed a flag that is in neither classification; it cannot be protecting anything",
  );
});

test("LITMUS: the walk does NOT fire on a classified flag that merely looks new", () => {
  // A guard that flagged everything would be relaxed into uselessness. A second mention
  // of an already-classified flag must stay silent.
  const planted = `${readFileSync(VERIFY_SRC, "utf-8")}\nfunction __again__(arg: string) { return arg === "--slice"; }\n`;
  assert.deepEqual(unclassified(planted), []);
});
