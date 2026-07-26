# "Beats vanilla" A/B Rubric & Independent-Grader Harness

This is the milestone success test for the genre-contract elicitation front-end:

> The elicitation **front-end** (side A) must beat a **vanilla** Claude/Codex baseline on the **same
> brief** (side B), scored by an **independent grader**, across **≥3 briefs spanning genre-classes**,
> by a **defined margin** on the **judgment** criteria.

The rubric data and the deterministic harness live in [`ab-rubric.ts`](./ab-rubric.ts). The validator
([`validator.ts`](./validator.ts)) and schema ([`types.ts`](./types.ts)) are FROZEN — the harness
*calls* the validator, it does not change it.

## The 10 criteria

Each criterion is scored **0 / 1 / 2** per side. Each is labelled **STRUCTURAL** (machine-scored by
the validator + structural-presence checks; expected **2/2**; this is **evidence the schema did its
job, NOT evidence of quality**) or **JUDGMENT** (the real A/B signal, graded by independent
reviewers).

| # | id | label | kind | 2/2 means |
|---|----|-------|------|-----------|
| 1 | `schema-valid` | Schema-valid contract | **STRUCTURAL** | `validateGenreContract` returns `valid:true` (all 12 fields present + closed-set bound). |
| 2 | `tunables-named` | Tunables named | **STRUCTURAL** | ≥1 named runtime-tunable feel parameter, each with an id (no magic constants). |
| 3 | `measurability-map-bound` | Measurability map bound | **STRUCTURAL** | Non-empty map; every `measurable-now` row binds to an IMPLEMENTED calculator; no judgment-only dodge. |
| 4 | `vertical-split` | coreVertical / deferredMeta split | **STRUCTURAL** | Vertical-first: budget declares core content; no meta kind smuggled into coreVertical. |
| 5 | `refusals-present` | Refusal conditions present | **STRUCTURAL** | ≥1 `refusalCondition` AND every `judgment-only` target has a matching `humanOracleCheck`. |
| 6 | `right-sub-genre` | Right sub-genre & core loop | **JUDGMENT** | Sub-genre / perspective / genreClass match the brief's actual genre; the loop is the real moment-to-moment. |
| 7 | `sensible-bands` | Sensible, reference-anchored bands | **JUDGMENT** | Feel bands are plausible for the genre and anchored to references/exemplars, not arbitrary guesses. |
| 8 | `real-asset-set` | Real asset set | **JUDGMENT** | Asset roles / art direction cover what the genre actually needs (not a generic placeholder set). |
| 9 | `honest-measurability` | Honest measurability tagging | **JUDGMENT** | Tags reflect what Loombridge can truly measure today; the backlog is scoped honestly, not faked green. |
| 10 | `oracle-coverage` | Correct genreClass + oracle coverage | **JUDGMENT** | genreClass is right and judgment-only aspects get meaningful human-oracle checks (load-bearing for systems). |

The 5 structural criteria carry **weight 0** toward the A/B signal by construction: structural parity
is *assumed*, not celebrated. Only the 5 judgment criteria move the verdict.

There is one deterministic guardrail: reviewer judgment is capped when validator evidence already
disproves the judged claim. A contract may still be judged for sub-genre fit and asset quality, but it
cannot receive full credit for measurement honesty or band quality while claiming unsupported
calculators, unsigned `agent-guess` bands, invalid band units, or missing human-oracle coverage.

Caps currently applied by the harness:

| validator evidence | affected judgment criterion | max score |
|--------------------|------------------------------|:---------:|
| invalid band unit/range, empty band, unsigned `agent-guess` band | `sensible-bands` | 1/2 |
| unsupported `measurable-now`, missing calculator, measurable-now dodge, unsigned `agent-guess` band | `honest-measurability` | 1/2 |
| missing/refused oracle coverage for `judgment-only` targets | `oracle-coverage` | 1/2 |

These caps are reported in each side's `judgmentCaps`; they do not rewrite the raw judge files. This
keeps invalid, confident-looking prose from beating a valid contract on claims the validator can
already falsify, while preserving reviewer authority over genuinely subjective quality.

## Independence requirement

The judgment scores come from an **independent grader**, mirroring the `doneness`
`independent` / `reviewerCount >= 2` rule:

- **≥2 reviewers.**
- **No access to the authoring transcript** — graded from a fresh context so the score reflects the
  artifact, not the conversation that produced it.
- **Recorded attestation** — an `IndependenceAttestation { independent: boolean; reviewerCount: number;
  reviewerIds?; attestation? }` is carried alongside the scores.

The harness **REFUSES to certify a win** if `independent !== true` or `reviewerCount < 2`, regardless
of how large the judgment margin is. This mirrors the moat's refuse-on-absent-binding discipline (see
project `CLAUDE.md` → "Verification / supervisor invariants"): an absent independence binding is a
**refusal**, never a silently-passed check. A self-graded score is not valid proof.

The harness does **NOT** call an LLM. The judgment scores are **inputs** supplied by the external
independent reviewers; the module only scores structurally and computes the deterministic verdict.

## Genre-class-aware weighting

A `systems` genre (RTS, auto-battler) legitimately has **fewer measurable feel bands** than a `twitch`
genre — penalizing it on `sensible-bands` would punish honesty. So the judgment criteria are weighted
per genre-class (`CLASS_JUDGMENT_WEIGHTS` in `ab-rubric.ts`), and the achievable judgment max is
**normalized per side** so the margin is comparable across classes:

| criterion | twitch | hybrid | systems |
|-----------|:------:|:------:|:-------:|
| `right-sub-genre` | 1.0 | 1.0 | 1.25 |
| `sensible-bands` | 1.25 | 1.0 | **0.5** |
| `real-asset-set` | 1.0 | 1.0 | 1.0 |
| `honest-measurability` | 1.25 | 1.0 | 1.0 |
| `oracle-coverage` | 0.75 | 1.0 | **1.25** |

Twitch leans on measurable bands + honest measurability; systems leans on the right sub-genre framing
+ oracle coverage. The genreClass is taken from the brief, falling back to the contract's
`coreLoop.genreClass`.

## The numeric success bar

- Each side's **weighted judgment total** is `Σ (classWeight(criterion) × score)` over the 5 judgment
  criteria; its **max** is `Σ (classWeight(criterion) × 2)`.
- **Per brief:** the front-end *beats vanilla* when
  `(frontEnd − vanilla) / judgmentMax ≥ marginPct`. The default bar is **`marginPct = 0.2`** (front-end
  must lead by ≥20% of the achievable weighted judgment max). A brief certifies a **win** only when it
  clears the bar **AND** independence is present.
- **Milestone:** "beats vanilla" is certified only when **breadth is met** (≥3 briefs spanning ≥2
  distinct genre-classes) **AND every brief certifies a win**. One brief that lacks independence or
  misses the bar sinks the whole milestone — never a partial pass.

## Harness API (in `ab-rubric.ts`)

- `AB_RUBRIC_CRITERIA` / `STRUCTURAL_CRITERIA` / `JUDGMENT_CRITERIA` — the criteria as data (`id`,
  `label`, `kind`, `weight`, `rubric`).
- `scoreStructural(contract: unknown): StructuralScoreResult` — deterministic 0/1/2 per structural
  criterion + the validator issues. Expects 2/2 on a valid contract.
- `IndependenceAttestation`, `AbSide`, `AbBriefInput`, `AbBar` — the A/B result shapes, with **slots**
  for the externally-supplied judgment scores and the required independence attestation.
- `computeAbBriefVerdict(brief, bar?)` — per-brief win/no-win, applying deterministic judgment caps
  and refusing on absent independence.
- `computeAbMilestoneVerdict(briefs, bar?)` — milestone verdict over ≥3 briefs (breadth + every-brief
  win).

## Independent reviewer instructions

Reviewers score the blinded artifact, but they must not reward unsupported ambition:

- A band is **2/2** only when it is plausible **and** its evidence is acceptable:
  `reference-anchored`, `pack-default`, or signed-off `agent-guess`.
- A contract that labels unimplemented metrics as `measurable-now` should lose `honest-measurability`
  credit even if the proposed metric would be useful.
- `real-asset-set` means enough concrete asset roles for the declared **core vertical**, not a full
  imagined shipped game. Do not reward scope creep merely because it lists more content.
- `oracle-coverage` is about load-bearing judgment-only targets having matching human checks, not just
  generic playtest prose.
