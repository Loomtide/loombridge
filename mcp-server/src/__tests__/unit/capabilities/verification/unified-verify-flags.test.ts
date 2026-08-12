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
 *
 * THE GUARD DRIVES THE ROUTER, NOT A SET (FX1). Comparing `ORCHESTRATOR_FLAGS` against a
 * scan proves only that two data structures agree; it says nothing about the function
 * that actually decides where an argv goes. So the central test below builds a real argv
 * per accepted flag and calls `classifyOrchestratorArgs`, and its expectation comes from
 * a PINNED literal list of the six bare-run flags rather than from the exported set.
 * That is what makes it a kill check: hijack the router with an inline set that adds any
 * legacy flag and the pinned expectation fails, where a set-vs-set comparison would
 * happily follow the hijacked set.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import {
  ORCHESTRATOR_FLAGS,
  ORCHESTRATOR_VALUE_FLAGS,
  classifyOrchestratorArgs,
} from "../../../../capabilities/verification/verify.js";

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

/**
 * THE EIGHT BARE-RUN FLAGS, pinned as a literal.
 *
 * Deliberately NOT derived from `ORCHESTRATOR_FLAGS`: the router-driven test below uses
 * this as its expectation, so a hijacked router (or a widened set) fails rather than
 * being followed. Growing the bare run is a routing decision and must show up as a diff
 * on this line.
 *
 * S2a added `--only` (the seventh), which is why every count below moved by one on purpose.
 * LiveByDefault added `--offline` (the eighth): live is now the default and `--offline` is
 * the opt-out, so it has to route to the orchestrator exactly like `--live` does. `--live`
 * STAYS on this list and stays accepted: it is a no-op kept so every shipped doc, skill and
 * script that already types it keeps working.
 */
const BARE_RUN_FLAGS: ReadonlySet<string> = new Set([
  "--id",
  "--live",
  "--offline",
  "--only",
  "--report",
  "--root",
  "--strict",
  "--workspace",
]);

/** The bare-run flags that consume the following token. Pinned, for the same reason. */
const BARE_RUN_VALUE_FLAGS: ReadonlySet<string> = new Set(["--root", "--report", "--only", "--id", "--workspace"]);

/** The well-formed argv for a bare-run flag: with its value when it takes one. */
function bareRunArgv(flag: string): string[] {
  return BARE_RUN_VALUE_FLAGS.has(flag) ? [flag, "dummy-value"] : [flag];
}

/**
 * BOTH argv shapes for a legacy flag: bare, and with a dummy value.
 *
 * Both, because the two catch different hijacks. A router widened to swallow a legacy
 * VALUE flag still rejects `[flag, "value"]` (the value token itself falls outside the
 * widened set), so only the bare form exposes it. A router widened to swallow a legacy
 * BOOLEAN flag is caught by either. Requiring null from both leaves no shape uncovered.
 */
function legacyArgvs(flag: string): string[][] {
  return [[flag], [flag, "dummy-value"]];
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

/**
 * THE WALK. Drive `classify` with one real argv per flag and report every flag that reached
 * the wrong engine.
 *
 * `classify` is a PARAMETER so the LITMUS below can feed the same walk a router whose set is
 * missing a flag. A LITMUS that re-implemented the walk would prove nothing about the walk
 * that ships.
 */
export function misroutedFlags(
  flags: readonly string[],
  classify: (argv: string[]) => unknown,
): string[] {
  const misrouted: string[] = [];
  for (const flag of flags) {
    if (BARE_RUN_FLAGS.has(flag)) {
      if (classify(bareRunArgv(flag)) === null) {
        misrouted.push(`${flag}: routed to legacy, expected orchestrator`);
      }
      continue;
    }
    // `--help`/`-h` are a parse outcome, not a mode, but they are still argv the router
    // sees, and they must reach `parseArgs` (which prints usage) rather than the
    // orchestrator. No exception is carved for them.
    for (const argv of legacyArgvs(flag)) {
      if (classify(argv) !== null) {
        misrouted.push(`${flag}: argv ${JSON.stringify(argv)} routed to orchestrator, expected legacy`);
      }
    }
  }
  return misrouted;
}

test("THE ROUTER routes every accepted flag to its classified side (not just the set)", () => {
  const source = readFileSync(VERIFY_SRC, "utf-8");
  const flags = [...new Set([...acceptedFlags(source), ...BARE_RUN_FLAGS])].sort();

  assert.deepEqual(
    misroutedFlags(flags, classifyOrchestratorArgs),
    [],
    "the ROUTER disagrees with the bare-run classification; a flag reaching the wrong engine is the "
      + "failure this guard exists for",
  );

  // Non-vacuity: the walk really covered the whole parser plus the orchestrator-only
  // flags, and it really exercised both outcomes.
  assert.ok(flags.length > 30, `the walk saw only ${flags.length} flags; it is not reading the parser`);
  assert.equal(flags.filter((f) => BARE_RUN_FLAGS.has(f)).length, 8, "all eight bare-run flags were driven");
  assert.ok(
    flags.some((f) => !BARE_RUN_FLAGS.has(f) && classifyOrchestratorArgs([f]) === null),
    "the walk must include flags that really do route legacy",
  );
  // The value-flag pinning is real: a bare-run value flag with NO value is malformed and
  // falls through to `parseArgs`, which owns how malformed invocations are reported.
  for (const flag of BARE_RUN_VALUE_FLAGS) assert.equal(classifyOrchestratorArgs([flag]), null, flag);

  // A COMBINATION of bare-run flags still routes to the orchestrator, and one legacy flag
  // anywhere in the argv takes the whole invocation legacy.
  assert.notEqual(classifyOrchestratorArgs(["--root", "/p", "--strict", "--live"]), null);
  assert.equal(classifyOrchestratorArgs(["--root", "/p", "--live", "--slice", "s1"]), null);
});

test("the orchestrator allowlist is exactly the eight bare-run flags, and the router reads THIS set", () => {
  // Pinned as a value, not a count: growing this set is a routing decision, and it must
  // show up as a diff on this line rather than as a number quietly ticking up.
  assert.deepEqual([...ORCHESTRATOR_FLAGS].sort(), [...BARE_RUN_FLAGS].sort());
  assert.deepEqual(
    [...BARE_RUN_FLAGS].sort(),
    ["--id", "--live", "--offline", "--only", "--report", "--root", "--strict", "--workspace"],
  );
  assert.deepEqual([...ORCHESTRATOR_VALUE_FLAGS].sort(), [...BARE_RUN_VALUE_FLAGS].sort());
  // `--live`, `--offline`, `--report` and `--only` are orchestrator-only: `parseArgs` never
  // handles them (the router's own branch is the only place they appear in the argv loop).
  for (const flag of ["--live", "--offline", "--report", "--only"]) assert.ok(ORCHESTRATOR_FLAGS.has(flag));
});

/**
 * LIVE IS THE DEFAULT (LiveByDefault), decided by the REAL router.
 *
 * `live` is the field the orchestrator branches on, so asserting it here is asserting the
 * behaviour rather than the spelling: no fixture, no editor, no output matching. The three
 * facts that make the change safe for everything already shipped are each pinned:
 * bare is live, `--offline` is the ONLY thing that clears it, and `--live` still parses.
 */
test("bare `verify` is LIVE; `--offline` is the opt-out; `--live` still parses as a no-op", () => {
  assert.equal(classifyOrchestratorArgs([])?.live, true, "bare `verify` must be live by default");
  assert.equal(classifyOrchestratorArgs(["--root", "/p"])?.live, true, "an unrelated flag must not change the default");
  assert.equal(classifyOrchestratorArgs(["--offline"])?.live, false, "--offline must clear live");
  assert.equal(classifyOrchestratorArgs(["--offline", "--strict"])?.live, false, "--offline must survive other flags");

  // THE COMPATIBILITY HALF. `--live` is typed by shipped docs, skills and CI scripts; it
  // must keep parsing (not fall through to the legacy unknown-flag exit 2) and must keep
  // meaning live. Asserted as `notEqual(null)` FIRST, because a router that stopped
  // adopting the argv would make the `live` assertion pass vacuously on `undefined`.
  assert.notEqual(classifyOrchestratorArgs(["--live"]), null, "--live must still route to the orchestrator");
  assert.equal(classifyOrchestratorArgs(["--live"])?.live, true);
  assert.notEqual(classifyOrchestratorArgs(["--live", "--root", "/p"]), null);

  // LAST ONE WINS, both directions, so neither spelling silently outranks the other.
  assert.equal(classifyOrchestratorArgs(["--live", "--offline"])?.live, false);
  assert.equal(classifyOrchestratorArgs(["--offline", "--live"])?.live, true);
});

test("--only is a VALUE flag on the router, and a mode flag anywhere takes the whole argv legacy", () => {
  // S2a/F8, driven through the REAL router. Three facts, because `--only` is the first flag
  // this door added since S1 and each one is a way it could be wired wrong:
  //  - it routes to the orchestrator with a value…
  assert.notEqual(classifyOrchestratorArgs(["--root", "/p", "--only", "tests"]), null);
  //  - …and the value is NOT validated here: a bad selector must reach the orchestrator's
  //    pre-write refusal (F13), not be reported as "this argv belongs to a mode".
  assert.notEqual(classifyOrchestratorArgs(["--only", "not-a-section"]), null);
  //  - a value-less `--only` is malformed argv, so the router declines it (and `run` prints
  //    the selector refusal rather than the combined-with-mode message).
  assert.equal(classifyOrchestratorArgs(["--only"]), null);
  //  - and one mode flag anywhere takes the whole invocation legacy, `--only` included.
  assert.equal(classifyOrchestratorArgs(["--only", "tests", "--slice", "s1"]), null);
});

/**
 * A stand-in router built from an ARBITRARY allowlist, mirroring the shipped one's shape
 * (allowlist test, then the value-flag rule). It exists so the LITMUS below can ask what the
 * walk does when a flag is missing from the router's set, which is the exact defect S2a could
 * have shipped: `--only` in the docs and the help text, absent from `ORCHESTRATOR_FLAGS`, and
 * therefore falling through to `parseArgs`'s unknown-argument exit 2 with a confusing message.
 */
function routerWithSet(allow: ReadonlySet<string>, valueFlags: ReadonlySet<string>) {
  return (argv: string[]): unknown => {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      if (!allow.has(arg)) return null;
      if (!valueFlags.has(arg)) continue;
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return null;
      i += 1;
    }
    return {};
  };
}

test("LITMUS: dropping --only from the ROUTER set really does fail the router walk", () => {
  // Non-vacuity for the walk that guards S2a's one routing change. The same walk, the same
  // flag list, one flag missing from the router's allowlist.
  const without = (flag: string): ReadonlySet<string> =>
    new Set([...ORCHESTRATOR_FLAGS].filter((f) => f !== flag));
  const hijacked = routerWithSet(without("--only"), ORCHESTRATOR_VALUE_FLAGS);

  assert.deepEqual(
    misroutedFlags([...BARE_RUN_FLAGS], hijacked),
    ["--only: routed to legacy, expected orchestrator"],
    "the walk must catch a bare-run flag the router does not know",
  );

  // …and the same walk over a router that DOES know it is silent, so the failure above is
  // caused by the omission and nothing else.
  assert.deepEqual(
    misroutedFlags([...BARE_RUN_FLAGS], routerWithSet(ORCHESTRATOR_FLAGS, ORCHESTRATOR_VALUE_FLAGS)),
    [],
  );
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
