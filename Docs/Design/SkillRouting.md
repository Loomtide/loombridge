# RFC: Routing a slice to the skill that builds it

**Status:** PROPOSED. **Date:** 2026-08-11.
Follows the consumer-surface fix in the `slice-skill-bindings` guard and the delivery change that
took consumers from 8 skills to 13.

**This RFC rejects the design it was opened to specify.** Gate-declaration routing does not work,
the data says so twice, and the evidence is recorded here so nobody rebuilds it. What it proposes
instead is smaller than a matcher and fixes the failure that was actually observed.

## The problem, stated from a real run

A 3D game was built by hand-prompting an agent through Meshy and codex. The skill for exactly that
work, `generated-3d-art-integration`, existed, was well written, and carried DO-NOT rules that had
each cost a real session. It never surfaced.

Two causes, one now fixed:

1. **It was never delivered.** It sat outside `CONSUMER_SKILLS`, so no consumer project received
   it. Fixed: consumers now get 13 skills including the art, audio, UI and perf packs.
2. **Nothing routes a slice to it.** Still open, and this RFC is about that.

## The proposal that fails

Per-pack `slices.json` bindings were rejected first, correctly: they only ever help the five
shipped packs, and say nothing for a promoted `GenreContract` or an ungraded genre. That is the
opposite of where genre genericity went.

The replacement seemed obvious. Every slice already declares `acceptance.gates`, which is
genre-neutral vocabulary owned by the verification layer. So: skills declare which gates they build
toward, `plan`/`build` intersects, and routing derives itself for any genre forever.

It is a tidy idea. It does not survive the data.

### Kill 1: the gates that discriminate are not declared

Across all 38 shipped slices:

```
  38  console-clean          <- 100% of slices. Zero routing signal.
  19  manifest               <- 50%. Almost none.
   8  ui-conformance
   8  visual-artifacts
   5  framing
   3  playability
   3  placement
   1  each: platform-tiles, tile-render, feel, feel-provenance, feel-rederive,
         physics-timestep, coverage, parallax-motion, render-frame, reachability, prop-purpose
```

The one gate every slice carries is the one that identifies nothing. The discriminating gates sit
in a tail of ones. A matcher over this is mostly noise suppression, and the tuning required to make
it behave (drop `console-clean`, discount `manifest`, require a minimum overlap) is the tell that
the signal is not there.

### Kill 2: the new skills' concerns are not in the vocabulary at all

Eight gate modules exist that **no shipped slice declares**:

```
asset-source-fidelity   color   frame-integrity   vlm-criteria
sfx-fatigue   sfx-latency   sfx-presence   sfx-runtime
```

The four `sfx-*` gates appear only in the genre-contract SCHEMA, as permitted values, never in a
slice. So a gate matcher would route `sfx-integration-pack` to **nothing**, because nothing asks
for those gates. `mobile-device-perf` fares worse: there is no perf gate at all.

That is the whole point of the exercise failing. Four of the five skills just delivered to
consumers are precisely the ones a gate matcher cannot reach.

**Neither kill is fixable by writing a better matcher.** Fixing kill 2 means authoring gate
declarations onto slices, per pack, which is the per-pack work already rejected, plus a new gate
family for performance that does not exist.

## What actually broke, and it is smaller than a matcher

Today, `plan` prints this for every slice in both 3D packs, all 18 of them:

```
skill: (none ships for this slice — build with the generic `unity_*` MCP ops)
```

That string is now **false, and confidently so**. Reproduced on one project, at one moment, by
running `install-agent` into a fresh Unity project and asking the CLI what it would print:

```
skills the project HAS (13):
  asset-layer game-polish-2d generated-3d-art-integration genre-pack-authoring
  graybox-greed-loop-tuning-pack hero-shot-authoring mobile-device-perf parallax-2d
  platformer-level-design sfx-integration-pack ui-polish-pack unity-2d-game verify-2d-game

what plan TELLS the agent for an unbound slice (all 18 3D slices):
  skill: (none ships for this slice — build with the generic `unity_*` MCP ops)
```

`generated-3d-art-integration` is sitting in `.claude/skills/` of that very project. The CLI is
telling the agent nothing exists, at the exact moment the agent decides how to build.

An agent that is told "none ships" does not go looking. This is worse than silence, and it is the
mechanism by which a well-written, installed, delivered skill stayed invisible.

## The change

**Stop asserting absence. Report the inventory and let the agent match.**

`renderSliceSkill` currently maps `undefined` to that sentence. Instead, when a slice carries no
binding, print what the project actually has:

```
skill: no pinned skill for this slice. Installed skills you can match against:
       generated-3d-art-integration, sfx-integration-pack, ui-polish-pack, ...
       (or build with the generic `unity_*` MCP ops)
```

The CLI's job here is **inventory, not judgment**: read what is installed, print it, stop. It does
not rank, score, or select. That keeps the deterministic layer making only claims it can support,
and it hands the actual matching to the component that is genuinely good at it, since both Claude
and Codex select skills from `description` front matter natively and those descriptions are already
written as trigger conditions.

A pinned `skill` still wins when a pack sets one. This only changes the absent case.

### Why not a text matcher over slice id / title / feelIntent

Slice ids are more discriminating than gates (`hud` in all five packs, `feedback` / `impact-feedback`,
`parallax`, `arena`). But they are free strings authored per pack, not a controlled vocabulary, so a
matcher over them is a heuristic pretending to be a rule, and it duplicates work the agent's own
selector does better with more context. Printing the inventory gets the same routing benefit with
none of the false precision.

## Invariants

- **The CLI never claims a skill is absent when it is installed.** That false claim is the whole
  defect; it must become unrepresentable.
- **The CLI does not rank or select skills.** Inventory only. Ranking is judgment, and judgment
  does not belong in the deterministic layer.
- **Routing is advisory and never reaches a verdict.** Nothing here may influence `verify`,
  `doneness`, or any gate. A skill declaration must never become a lever on green.
- **An explicit pack binding still wins.** This changes only the unbound case.
- **Absent inventory degrades to today's wording.** A project without `install-agent` genuinely has
  no skills, and the generic-ops sentence is correct there.

## Out of scope

- Adding `sfx-*`, `asset-source-fidelity` or a performance gate family to slice templates. That is
  real work with real value for VERIFICATION, and it should be motivated by what needs grading, not
  by a routing scheme that wanted more signal.
- Any scoring, ranking or auto-selection of skills.
- Per-pack skill bindings for the 3D packs. Rejected, and now doubly so: they were removed once
  already after 25 of 29 named skills that existed nowhere.

## Open questions

1. **Where does the inventory come from: the shipped `agent-surface/` payload, or the project's
   `.claude/skills/`?** Leaning the PROJECT, because that is the set the agent can actually open,
   and a user may have removed one. The payload is what the CLI could offer, not what the project
   has, and the difference is exactly the lie this RFC exists to stop telling.
2. **Does the inventory belong in `ask` and `status` too?** Both render slice detail through the
   same helper. Leaning yes for consistency, but `plan`/`build` is where the decision is made.
3. **Does listing 13 names every slice become noise?** Possibly. A cap with a pointer at the skills
   directory may read better than a full list. Worth deciding on real output rather than in advance.

## LITMUS obligations

- A slice with no binding, in a project WITH skills installed, must print the installed names and
  must NOT print "none ships". A test asserting the old sentence is gone.
- A slice with no binding, in a project WITHOUT skills installed, still prints the generic-ops
  wording. The degrade path is not a regression.
- A slice WITH a binding prints exactly that binding, unchanged.
- The inventory is read from disk, not hardcoded: planting a skill directory changes the output, and
  removing one removes it from the list. A hardcoded list would pass every other test here.
- Nothing in `verify` or `doneness` output changes as a result of any skill being present or absent.
