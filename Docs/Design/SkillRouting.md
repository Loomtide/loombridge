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

**Stop asserting absence. Print nothing in its place.**

`renderSliceSkill` maps an absent binding to that false sentence. When the project HAS skills, it
now renders exactly:

```
skill: none pinned for this slice
```

No list, no count, no instruction to choose. That is the whole change.

### Why not print the inventory (the first draft of this RFC, corrected on review)

The first cut proposed listing the installed skills so the agent could match against them. Built,
it rendered a 330-character line naming all 13, and the objection on review was the right one:
**nobody should be choosing skills from a menu, and framing it as a choice defeats the point.**

Routing is **already automatic**. Claude and Codex both surface the skills in `.claude/skills/` and
`.codex/skills/` together with their `description` front matter, and those descriptions are written
as trigger conditions precisely so the agent matches without being handed anything. Observed
directly: a skill created mid-session appeared in the authoring agent's own available-skills list,
with its description, with no inventory passed to it.

So an inventory line is redundant with what the agent already has, and actively harmful in framing:
it converts an automatic match into a chore. The defect was never "the agent lacks a list". It was
that the CLI **asserted nothing existed**, which suppresses the matching that would otherwise
happen. Deleting the false claim is the entire fix.

The disk read survives, but only to answer *does this project have skills at all*, which is what
decides between the two wordings. `renderSliceSkill` reads `installed.length` and never the names,
with a comment saying not to "improve" it by enumerating them.

### Why not a text matcher over slice id / title / feelIntent

Slice ids are more discriminating than gates (`hud` in all five packs, `feedback` /
`impact-feedback`, `parallax`, `arena`). But they are free strings authored per pack, not a
controlled vocabulary, so a matcher over them is a heuristic pretending to be a rule, and it
duplicates work the agent's own selector does better with far more context.

## Invariants

- **The CLI never claims a skill is absent when it is installed.** That false claim is the whole
  defect; it must become unrepresentable.
- **The CLI does not rank, select, or ENUMERATE skills.** It reports only whether the project has
  any, because that is all that decides the wording. Ranking is judgment; listing is a menu; the
  agent's own skill system already does the matching.
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

1. ~~Where does the inventory come from?~~ **ANSWERED: the project's `.claude/skills/`**, unioned
   with `.codex/skills/`, because that is the set the agent can actually open. The bundled
   `agent-surface/` payload is what the CLI *could* offer, and reading it would reproduce the same
   class of lie in the opposite direction.
2. ~~Does the inventory belong in `ask` and `status` too?~~ **ANSWERED: yes**, all three render
   through the same helper and now agree.
3. ~~Does listing 13 names become noise?~~ **DISSOLVED.** Nothing is listed. See "Why not print the
   inventory": the question only existed because the first draft printed a menu.
4. **Should `build` print the skill line at all?** It currently does not; only `plan` and `ask` do.
   If the build decision is really made at `build`, that is a gap, but it is a separate change from
   removing a false claim.

## LITMUS obligations

- A slice with no binding, in a project WITH skills installed, must NOT print "none ships", and
  must NOT enumerate the skills either. Both directions asserted: the false sentence is gone, and
  no installed name appears in the output.
- A slice with no binding, in a project WITHOUT skills installed, still prints the generic-ops
  wording. The degrade path is not a regression.
- A slice WITH a binding prints exactly that binding, unchanged.
- The presence check is read from disk, not hardcoded: planting a skill directory and removing it
  again must change what the reader returns. A hardcoded list would pass every other test here.
- Nothing in `verify` or `doneness` output changes as a result of any skill being present or absent.
