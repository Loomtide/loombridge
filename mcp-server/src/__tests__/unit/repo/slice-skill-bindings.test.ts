import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "../../_support/paths.js";
import { knownGenreIds, resolveGenrePack } from "../../../capabilities/genre/genre-registry.js";
import { assertValidSlicePlan } from "../../../capabilities/verification/slices.js";

/**
 * Guard: every skill a SHIPPED slice template names must be a skill the consumer actually receives.
 *
 * WHY THIS EXISTS. `SliceEntry.skill` is "which skill pack/component builds this slice", and
 * `loombridge plan` prints it to the agent as the instruction for the next slice
 * ("skill: <name>"), while `commands/loombridge/build.md` tells the agent to use the genre pack's
 * skills. A binding that names nothing is therefore not cosmetic: it sends the agent looking for
 * guidance that does not exist, at exactly the moment it is about to build.
 *
 * It went unnoticed because `platformer-2d` — the happy path everything is exercised through — was
 * the only pack that bound real skills (0 dangling of 4). The other three packs invented a parallel
 * `<genre>-<slice>` naming scheme (`shooter-weapon`, `topdown-arena-loot-loop`, ...) that was never
 * authored: 25 of 29 declared bindings named skills that existed nowhere. A JSON-declared name that
 * no test walks is invisible to a green suite, which is this repo's most expensive recurring
 * failure shape.
 *
 * TWO DELIBERATE CHOICES:
 *
 * 1. It reads `CONSUMER_SKILLS` from `scripts/agent-surface-lib.mjs`, NOT the
 *    `mcp-server/agent-surface/skills/` directory. That directory is generated and git-ignored, so
 *    a guard reading it would pass vacuously whenever the payload has not been built — which is
 *    most of the time, including a fresh CI checkout. `CONSUMER_SKILLS` is the declared list both
 *    install paths already share.
 *
 * 2. It walks `knownGenreIds()` rather than globbing `genre-packs/`, so a newly REGISTERED genre is
 *    covered automatically. Registration is what makes a pack reachable through the front door, and
 *    that is exactly when its bindings start being printed to agents.
 *
 * This is a claim about OUR shipped content only. The runtime validator in `slices.ts` deliberately
 * does NOT enforce membership: a consumer's own SLICES.json may name a skill they wrote themselves.
 */

const SCRUB_LIB = path.resolve(REPO_ROOT, "scripts/agent-surface-lib.mjs");

async function consumerSkills(): Promise<Set<string>> {
  const mod = (await import(pathToFileURL(SCRUB_LIB).href)) as { CONSUMER_SKILLS?: unknown };
  const list = mod.CONSUMER_SKILLS;
  assert.ok(
    Array.isArray(list) && list.length > 0,
    `scripts/agent-surface-lib.mjs must export a non-empty CONSUMER_SKILLS (got ${JSON.stringify(list)})`,
  );
  return new Set(list as string[]);
}

/**
 * THE membership scan. Both the real check and its LITMUS call THIS — do not inline a copy into
 * either.
 *
 * An earlier cut had the LITMUS re-implement the `shipped.has(...)` test inline against a fixture.
 * That looked like a self-test and was not one: replacing this scan's body with `if (false)` left
 * BOTH tests green, so the whole guard could be defused without turning CI red. Verified by doing
 * exactly that. A LITMUS that does not execute the code it certifies proves nothing about it.
 *
 * `slices` is a parameter rather than read inside, so the LITMUS can feed it a known-dangling slice
 * and force the real code path to produce a real finding.
 */
function scanBindings(shipped: ReadonlySet<string>, label: string, slices: Array<{ id: string; skill?: string }>): string[] {
  const dangling: string[] = [];
  for (const slice of slices) {
    // An ABSENT binding is fine and is the honest answer where no shipped skill fits (the 3D packs).
    // Absent sends the agent to the generic ops; WRONG sends it looking for something that is not there.
    if (slice.skill === undefined) continue;
    if (!shipped.has(slice.skill)) dangling.push(`${label}/${slice.id}: "${slice.skill}"`);
  }
  return dangling;
}

function templateSlices(genreId: string): Array<{ id: string; skill?: string }> {
  return assertValidSlicePlan(
    JSON.parse(readFileSync(resolveGenrePack(genreId)!.sliceTemplatePath, "utf-8")),
  ).slices;
}

test("every skill a registered genre's slice template names is a skill consumers receive", async () => {
  const shipped = await consumerSkills();
  const ids = knownGenreIds();
  assert.ok(ids.length > 0, "expected at least one registered genre");

  const dangling = ids.flatMap((id) => scanBindings(shipped, id, templateSlices(id)));

  assert.deepEqual(
    dangling,
    [],
    "slice templates name skills that consumers never receive — `loombridge plan` would print these " +
      "to the agent as the skill to build with, and there is nothing behind them. Bind a skill from " +
      `CONSUMER_SKILLS (${[...shipped].sort().join(", ")}), or OMIT the field if none fits:\n  ` +
      dangling.join("\n  "),
  );
});

test("the scan actually inspects bindings (not vacuous on the real templates)", async () => {
  // Guards the guard from the other side: if every template lost its `skill` — or the walk stopped
  // finding templates — the check above would pass by having nothing to check. Assert it really is
  // looking at a non-trivial number of live bindings.
  const shipped = await consumerSkills();
  const inspected = knownGenreIds().flatMap((id) =>
    templateSlices(id).filter((s) => s.skill !== undefined),
  );
  assert.ok(
    inspected.length >= 10,
    `expected the scan to inspect a meaningful number of live bindings, saw ${inspected.length}`,
  );
  assert.ok(inspected.every((s) => shipped.has(s.skill!)), "every inspected binding must resolve");
});

test("LITMUS: the scan flags a dangling binding, and clears a resolvable one", async () => {
  // Exercises `scanBindings` ITSELF — the same function the real check runs — so neutering that
  // function turns THIS red. That is the property the previous inline version lacked.
  const shipped = await consumerSkills();

  // `shooter-weapon` is the real name 2d-shooter's `weapon` slice carried before this guard existed.
  assert.ok(!shipped.has("shooter-weapon"), "fixture must name a skill consumers do NOT receive");

  const flagged = scanBindings(shipped, "fixture", [{ id: "weapon", skill: "shooter-weapon" }]);
  assert.deepEqual(flagged, ['fixture/weapon: "shooter-weapon"'], "a dangling binding must be flagged");

  // ...and it is not simply always-red: a real binding and an omitted one both come back clean.
  assert.deepEqual(
    scanBindings(shipped, "fixture", [{ id: "a", skill: "unity-2d-game" }, { id: "b" }]),
    [],
  );
});

// The validator semantics for `skill` (optional, but present-but-blank refused) live with the other
// validator tests in `loombridge-slices.test.ts`. This file owns only the membership claim.
