# RFC: Command Surface Redesign

**Status:** W1 IMPLEMENTED. W2 to W4 remain PROPOSED.
**Date:** 2026-07-27. Measurements in the appendix were taken against `main` at `4981142`.

**Decisions, resolved 2026-07-27.** D1: yes, an ungraded game may reach `doneness`, with coverage
derived at verdict time, the gap list mandatory and non-empty, and the claim scoped. D2: land
alongside. Entry path for an unregistered genre: genre-contract promotion only, reusing
`promoteGenreContract`; no free-form `--genre <anything>`.

Those two answers interact. With promotion as the only entry, anything that reaches `plan` has either
a registration or a `GENRE_PROMOTION.json`, so it is `graded` or `partially-graded`. `ungraded` is the
residual state (hand-edited `STATE.genre`, deleted promotion report, adopted project), and it has no
source to enumerate gaps from, so D1's own precondition cannot be met. **`ungraded` therefore refuses
in W1.** D1's "yes" becomes reachable only if a free-form entry path is added later.

## Thesis

Loombridge's command surface was shaped when the product was "verify a platformer." It is now
installed by developers who want to build *their* game from an idea. The pipeline should be a
factory for polished games: **generic workflow commands, with game-specific knowledge injected by
skills**, rather than verbs that only open for pre-shipped genres.

Two structural changes carry most of the value:

1. **Coverage, not refusal.** The closed genre set should govern what `verify` *claims*, not what
   `design` *accepts*.
2. **A real `design` stage** that terminates in deterministic state, so the plan cannot drift from
   the design and the verdict can bind to it.

## 1. The problem, measured

### 1.1 The front door only opens for three genres

`capabilities/genre/genre-registry.ts` registers exactly three: `platformer-2d` (the default),
`2d-shooter`, `3d-shooter`. Its header states that resolution refuses an unknown genre (returns
`null`, caller exits 2) and never silently defaults to platformer.

Each registration additionally requires an `acceptanceTemplatePath` and a `sliceTemplatePath`
authored *inside the CLI package*. The consequence:

> A new genre is a code change to the CLI, shipped in a release. A developer with a hyper-casual
> puzzle game cannot reach `plan` at all. Not "builds unverified." Cannot start.

For a tool people install to build their own game, that is close to fatal.

### 1.2 An authored pack was already outrunning the registry

> **Correction (implementation).** The first draft of this section counted three unreachable packs by
> reading two different pack systems as one table. `genre-contract/genre-packs/*` are **hint-card**
> packs (`pack.json` + `hint-card.json`, 7 lines each) that seed the authoring interview, not the
> front door; `hybrid-rungun` and `systems-rts` are reachable today via
> `genre-pack-authoring` -> contract -> promote. The genuinely unreachable pack was **one**.

| location | kind | packs present | registered |
|---|---|---|---|
| `capabilities/genre/genre-packs/` | full plan templates (acceptance + slice DAG) | `platformer-2d`, `2d-shooter`, `3d-shooter`, `3d-topdown-arena` | 3 of 4 |
| `capabilities/genre/genre-contract/genre-packs/` | hint cards for the authoring interview | `2d-shooter`, `3d-shooter`, `hybrid-rungun`, `systems-rts` | n/a (not registry-bound) |

`3d-topdown-arena` shipped a validating acceptance contract, whose own source note reads "a seed for
`plan --genre 3d-topdown-arena`", plus an 11-slice DAG, and no registration. This is the "defined but
not wired" class of finding this project treats as High severity, and it showed the registry was a
bottleneck in practice, not only in theory. **Resolved in W1: registered.**

### 1.3 The command set has drifted

| command | lines | assessment |
|---|---|---|
| `build.md` | 460 | Keep, restructure. Router plus construction plus verify plus doneness. |
| `plan.md` | 244 | Retarget. Currently fuses design target, asset manifest, and slice roadmap. |
| `verify.md` | 202 | Keep. This is the moat. |
| `e2e.md` | 191 | **Retire from the public surface.** Its own prose: "a demo workflow wrapper, not a third product verb." |
| `status.md` | 53 | Keep. |
| `ask.md` | 37 | **Retire.** Read-only explainer over `loombridge status`; competes with the agent's own plan mode. |

Nineteen CLI verbs sit behind these six commands.

## 2. Core diagnosis

The closed set is not wrong. It is in the wrong place.

The registry's refusal exists so an unregistered genre never silently grades against platformer
criteria and produces a false green. That reasoning is correct, and it is about **silent
defaulting**, not about **refusing to proceed**. The two were conflated.

Verification today is binary: graded, or refused. It needs three states, all explicit:

| coverage | meaning | verdict may claim |
|---|---|---|
| `graded` | registered genre; feel calculators and fidelity criteria exist | full Tier-1 pass |
| `partially-graded` | genre-neutral gates apply; no genre-specific feel oracle | pass **with declared gaps enumerated** |
| `ungraded` | no genre-specific oracle at all | build allowed; see decision D1 for doneness |

The genre-neutral gates already exist and apply to a puzzle game today: compile clean, playability,
framing, UI conformance, safe-area, perf. What is missing for an unregistered genre is the feel
calculator and the fidelity criteria, and the verdict must say so in those words.

**The moat is preserved**: never grade what there is no oracle for, never silently substitute one
genre's criteria for another. What changes is that "I cannot grade this" stops meaning "you cannot
build this." It also creates the upgrade path: build ungraded now, and when a genre earns a pack,
coverage upgrades without redoing the project.

## 3. Decisions needed before work starts

*Both resolved 2026-07-27; see the header. Kept below as the record of what was weighed.*

**D1. May an ungraded game reach `doneness` at all?**

- *Recommended:* Yes, with `coverage` stamped on the verdict and the "done" claim explicitly scoped
  to what was actually graded. An ungraded project can never present as `graded`, and the gap list
  is mandatory, non-empty, and non-suppressible.
- *Alternative:* No. `doneness` refuses below `partially-graded`. Safer, but most real users would
  never see a green, which undermines the pipeline's value.
- This is a moat decision and belongs to the maintainer, not to implementation.

**D2. Replace the current pipeline, or land alongside it during migration?**

- *Recommended:* Alongside. `design` is additive; `plan` gains a design-consuming path while
  keeping the genre-template path until the three shipped genres are migrated.
- A release is already published and has consumers. A hard cutover breaks them.

## 4. Target command surface

Five commands, down from six commands and nineteen verbs of effective surface.

```
design  ->  plan  ->  build  ->  verify
                 status (read-only, any time)
```

| command | role | writes state |
|---|---|---|
| `design` | Opinionated game design. Research, interrogation, edge cases. Open to any genre. | `.loombridge/design/` |
| `plan` | Design to executable task DAG, including polish tasks. | `.loombridge/` roadmap |
| `build` | Task by task. Implement, run, capture, observe, tune. Injects bound skills. | run state, captures |
| `verify` | Tier-1 deterministic gates plus declared coverage. | verdict |
| `status` | Deterministic resume point after a context reset. | nothing |

**Retired:** `ask` (folded into `status`), `e2e` (moved to `scripts/`).

**Naming collision to resolve:** `loombridge design` currently means "set and approve the frozen
hero shot." Rename that verb to `loombridge target`. The resulting sequence reads correctly: design
the game, then freeze the visual target. This also disambiguates the two meanings of "design target"
that currently overload the codebase.

## 5. The `design` stage

### 5.1 Why it earns a command

The value is the questions a developer skips: core loop, the single verb, failure state,
progression, session length, camera, input, platform, and what specifically must feel good. An
agent's built-in plan mode does not cover this, because plan mode plans *implementation*, not *game
design*, and holds no opinion about what makes a game work.

Multi-angle research (references, genre failure modes, what makes this loop hold attention) is
genuinely useful here, and it is the one stage where subagent fan-out pays for itself.

### 5.2 The trap, and the guardrail

The failure mode is a beautiful document that `build` ignores.

**Design must terminate in state, not prose.** This is the same binding discipline already enforced
on the hero shot. If `design` only produces chat, it is a conversation, not a pipeline stage.

### 5.3 Proposed artifact

`.loombridge/design/brief.md` (human) and `.loombridge/design/design.json` (machine), carrying:

- core loop and primary verb
- **the one thing that must feel good**, which becomes the feel target
- vertical slice definition: what "playable" means for *this* game
- platform, input, camera, session length
- genre hint, plus the resolved `coverage` and the enumerated gaps
- open questions and risks surfaced but deliberately unresolved
- **skill bindings**: which shipped skills apply to this project

### 5.4 Skill binding is load-bearing

Once commands are generic and skills carry the knowledge, **skill selection becomes the hard
problem.** Fourteen skills ship today and the number grows. If the agent picks by vibes each
session, the result is inconsistency, which is precisely what Loombridge exists to eliminate.

Binding skills in `design.json` makes injection auditable and reproducible: `build` loads what the
design declared, and a reviewer can see what knowledge was in scope.

## 6. What transfers from AgentsAtlas, and what does not

Reference: AgentsAtlas (`agents-atlas` on npm, MIT), an 8-command workflow with subagent-per-task
execution.

**Transfers:** the XML task format with built-in verification steps; fresh subagent context per
task; skill disciplines declared up front in the executor prompt; status updated as work proceeds;
a non-interactive `--auto` path with deterministic tie-breaking and explicit assumption markers.

**Does not transfer:** the execution loop itself.

> AgentsAtlas's oracle is a test suite. Loombridge's oracle is a capture.

For code, "implement, test, done" closes the loop. For a game, nothing is known until it runs and
someone looks at it. The loop is implement, run, capture, observe, tune. That extra beat is exactly
where Loombridge's differentiation lives, because MCP into a live editor is the capability nobody
else has. Porting a generic executor where "task complete" means "code written" would discard the
entire advantage.

## 7. Polish is a phase, not a command

An optional `/loombridge:polish` is a skipped polish command. Polish also has the same
implement/capture/observe loop as build, so it does not want separate machinery.

Enforce it structurally instead: **`plan` emits polish tasks** as part of the task DAG, and
**`verify` gates on polish criteria**. Polished by default means polish is planned, not hoped for.

## 8. Guardrail: where knowledge is allowed to live

"Generic commands, specific skills" is the right direction, with one caution worth stating plainly.

Skills are prose an agent can ignore. The CLI is deterministic and cannot be bypassed. If too much
migrates from CLI to skills, Loombridge degrades into a prompt pack, and what is lost is the moat:
a "done" claim that cannot be self-graded.

| layer | contents | bypassable |
|---|---|---|
| **CLI** | state, contract, gates, verdicts, freshness and binding checks | No |
| **Commands** | orchestration and sequencing: which thing runs when | Partly |
| **Skills** | how to do a domain thing well | Yes |

**Admission test for any new command: does it write deterministic state?** If not, it is a
conversation, not a stage.

## 9. Sequencing

| wave | work | gate |
|---|---|---|
| **W1** ✅ | Coverage split in the genre registry: three states, `genreCoverage` stamped on the verdict, gap list mandatory and non-empty. Register `3d-topdown-arena`. | DONE. See §11. |
| **W2** | `design` command plus `design.json` schema plus skill bindings. Rename the hero-shot verb to `target`. | W1 merged. |
| **W3** | Retarget `plan` to consume `design.json`; borrow the AgentsAtlas task structure; emit polish tasks. | W2 merged. Keep the genre-template path per D2. |
| **W4** | Restructure `build` around implement/capture/observe/tune with skills injected from the design binding. Retire `ask` and `e2e`. | W3 merged. |

W1 is the change that matters. W2 to W4 without it produce a nicer pipeline over the same three
genres.

## 10. Risks

- **Coverage becomes a laundering vector.** If `coverage` can be hand-written into a verdict, an
  ungraded project can present as graded. Coverage must be derived from the registry at verdict
  time and re-derived from disk in the slice roll-up, exactly as `designTarget.kind` is today. An
  absent `coverage` field is a refusal, not a skipped check.
  *Addressed in W1, with one deliberate exception: an absent block on a `graded` project passes.
  Every verdict written before the field existed omits it, and every one of those is a registered
  genre, so the exception costs no safety and is what makes D2's "alongside" real. Absent on
  anything non-`graded` refuses.*
- **`design` becomes a wizard people skip.** Mitigation: `plan` refuses without a `design.json`, or
  offers a documented minimal path that stamps the design as thin so the gap stays visible
  downstream.
- **Skill bindings rot.** A binding naming a deleted skill must fail loudly. This needs a guard test
  in the same family as `package-entrypoints.test.ts` and `unity-project-refs.test.ts`: declared
  paths that nothing imports are this repo's recurring blind spot.
- **Migration burden on existing consumers.** Addressed by D2 (land alongside).
- **Scope.** Four waves touching the front door, the registry, and the moat. Sequence it against
  outstanding release work rather than in parallel with it.

## Appendix: measurements

Taken 2026-07-27 against `main` at `4981142`.

- Commands in `commands/loombridge/`: `ask.md` 37, `status.md` 53, `e2e.md` 191, `verify.md` 202,
  `plan.md` 244, `build.md` 460. Total 1187 lines.
- CLI verbs dispatched in `surfaces/cli.ts`: 19 (`adopt`, `ask`, `assets`, `build`, `capture`,
  `design`, `doctor`, `doneness`, `install-agent`, `install-bridge`, `mcp`, `minigame`,
  `mobile-audit`, `plan`, `status`, `trace`, `tuning-report`, `update`, `verify`).
- Registered genres in `capabilities/genre/genre-registry.ts`: 3 (`platformer-2d` default,
  `2d-shooter`, `3d-shooter`). Unknown genre refuses; caller exits 2.
- Genre packs on disk: 4 full plan templates under `genre-packs/`, 4 hint cards under
  `genre-contract/genre-packs/`. One full pack is unregistered: `3d-topdown-arena`. (The original
  draft said three; see the correction in §1.2.)
- Skills in `.skills/`: 14.

## 11. W1 as built

Post-implementation record. The design above stands; these are the points where building it taught
something the proposal did not know.

**The block was one line, and it gated a template that is never read.** For a promoted contract,
`plan.ts` called `resolveGenrePack(genre)` and exited 2 on `null`, but the resolved
`acceptanceTemplatePath` was only ever consumed as `promoted?.acceptance ?? readFile(templatePath)`.
On the promoted path the pack template is never opened. The registry lookup there was a pure
gatekeeper on a plan it contributes nothing to. Lifting it is scoped to that path: a bare `--genre`
naming an unregistered genre still exits 2, because there the pack IS the plan.

**Where each thing lives.**

| concern | file |
|---|---|
| the three states, gap derivation (pure, no I/O) | `capabilities/genre/genre-coverage.ts` |
| reading `.loombridge/GENRE_PROMOTION.json` | `capabilities/genre/promotion-report.ts` |
| the criterion allow-list, shared by both declaring sites | `capabilities/verification/gates/vlm-criteria.ts` |
| refusal predicate (pure) | `genreCoverageRefusals` in `doneness.ts` |
| the stamp | `verify.ts`, next to `designTarget` |

**Gaps are structural, not authored.** Two entries are computed from the *absence* of a registration
("no registered feel oracle", "no hero-shot fidelity criteria"), so a contract declaring zero slice
gaps with every measurability row `measurable-now` still cannot reach an empty gap list. If gaps came
only from the contract, "partially-graded with nothing missing" would be authorable, and that reads
exactly like a full pass.

**An unregistered genre can declare its own fidelity criteria.** The genre contract gained an optional
`fidelityCriteria`, validated at authoring time and RE-validated by doneness at gate time (the
promotion report lives in the project and is editable, so plan-time validation is not a trust
boundary). Without it, a promoted genre with an approved Design Target refuses, naming the two honest
exits: declare criteria, or declare `art: { "mode": "deferred" }`. It never borrows another genre's.

**The slice roll-up resolves genre from `SLICES.json`, not STATE**, since the slice plan is the
artifact being certified and declares its own genre. A plan-vs-STATE genre drift is refused, which is
the companion the switch requires: without it, editing either file to name a registered genre would
be a bypass.

**Adversarial review found a false green, reproduced end-to-end.** The first cut of
`deriveGenreCoverage` checked the registry before checking whether the promotion report agreed with
`STATE.genre`, and treated a mismatched report as merely irrelevant. That was a working laundering
route: plan a puzzle game from a contract, hand-edit `STATE.genre` to `platformer-2d`, delete
`SLICES.json` to take the whole-game path, and `doneness` printed `OK — fresh + green` as a full
`graded` pass, graded against platformer feel and fidelity criteria, while `GENRE_PROMOTION.json` on
disk still read `sourceGenreId: "puzzle-hypercasual"`. The contradicting evidence was on disk and
was being discarded.

The bug was ordering alone. `STATE.genre` and the promotion report are two independent on-disk
claims about what a project IS; when they conflict there is no honest claim, so the derivation now
refuses and names both sides rather than taking the reading that grades higher. The contradiction
check runs FIRST, before the registry short-circuit.

Two consequences worth keeping:

- `plan` now clears a stale promotion report when it re-seeds a project onto a templated genre.
  Without that, the legitimate "promoted a contract, now I want a shipped pack" switch strands the
  developer on a permanent refusal. A correct refusal that cannot be escaped is still a bug.
- The generic "report names another genre" test did NOT catch this, because its genre was
  unregistered and so never reached the short-circuit. The regression test uses a REGISTERED genre
  on purpose, and carries a LITMUS: restore the old ordering and it fails with `graded`.

**Guard test added with the declared paths.** `genre-registry.test.ts` hand-wrote an `existsSync` pair
per genre, so a fourth registration would have had no path check at all. It now walks
`knownGenreIds()` and runs each template through the validator that consumes it, since a path that
exists but does not validate fails at runtime rather than in CI. LITMUS: point any registration's
`sliceTemplatePath` at its own `acceptance.json` and the test fails; an existsSync-only check passes.
