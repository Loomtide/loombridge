---
name: session-retro
description: Mine a Loomtide dogfood session transcript for durable product learnings — friction, bypassed surfaces, and user corrections — into a stable-ID findings ledger with provenance tags and a routing table. Use after any real build/art/verify session (yours or a handoff) to codify what the run taught, or to re-mine a session that has grown since last time.
---

# Session Retro

Use this skill to turn a Loomtide dogfood session into product signal. A dogfood session is a real
game built or polished through the Loomtide bridge/CLI (the exemplars are an extraction-shooter dogfood
graybox and its art-integration follow-up). The deliverable is a **findings ledger** with stable IDs,
provenance tags, and a routing table — the same two-artifact shape as the internal exemplars: a
per-finding ledger plus a consolidated-learnings doc.
This loop has run manually twice with high-signal results; this skill codifies the proven rubric so any
future session is mined consistently.

The mindset: **the session is the highest-fidelity source of what the product actually feels like to use.**
A well-specified build that never once reached `loomtide plan/verify/doneness` is not a failure to report
politely — it is the central finding. Mine adversarially, verify against the transcript (never memory),
and let shipped code — not PR titles — decide what is closed.

## Hard rules

1. **Grep the transcript, don't trust memory.** Every load-bearing claim cites a `tool_result`,
   assistant line, or user message. Memory manufactures plausible findings that never happened and
   mis-attributes who said what — the validation pass on the exemplar caught real mis-attributions.
2. **Provenance tag every finding** (`[observed-this-session]` / `[inherited-handover]` / `[user-taught]`)
   — non-negotiable. A learning inherited from a prior agent's handover prompt is NOT something this
   session observed; label it so or the ledger overstates the run.
3. **Stable IDs live forever.** Assign `RCL-Txx`-style IDs (project-prefix + bucket-letter + number) and
   never renumber. Re-mining appends against existing IDs; it does not reissue them.
4. **Never promote a genre-knowledge finding from one run.** Single-session genre observations are
   candidates gated on a *second* validation run. Everything else routes immediately.
5. **Keep the raw mining notes until every finding is promoted or explicitly rejected.** Evidence quotes
   nearly vanished in a consolidation hop on the exemplar; the raw docs are the audit trail.

## Step 1 — Scope and watermark

Missing this step is how the exemplar lost a 14-hour tail: the exemplar session grew from 308 lines to
2160 lines between run 1 and run 2, and un-watermarked re-mining silently re-covers old ground while
missing the new tail.

- **Identify the transcript(s):** `~/.claude/projects/<project-slug>/<session-id>.jsonl`. The project
  slug is the cwd path with `/` → `-` (e.g. `-Users-you-Projects-MyGame`). A session may span
  multiple files; find them all (`ls -la` sorted by mtime, and grep for the build's scene/script names
  to confirm you have the right session).
- **Read the last watermark** from the existing ledger's Run log (the timestamp / line-count / session-id
  of the last mining pass). If no ledger exists, this is run 1 — watermark is the session start.
- **Mine only past the watermark.** Filter the JSONL to entries after the last-mined timestamp/line.
  Confirmations of prior findings from the new tail are appended as evidence, not re-filed.
- **Record the new watermark** in the Run log the moment you finish: date, transcript file(s), new line
  count / tool-call count / error count, and a one-line "what changed since last run." This row IS the
  watermark for the next pass.

## Step 2 — Extraction (two parallel passes, then synthesize)

Run both passes over the post-watermark slice. Keep them separate — they find different classes of
finding — then synthesize into buckets.

### Pass A — friction-mining (what fought the user)

Sweep the transcript for:
- every `tool_result` with `is_error==true`, or content matching `error/failed/timeout/CONNECTION_LOST/
  null/NOT_FOUND/INVALID_PARAMS/PREFLIGHT_BLOCKED`;
- **repeated/retried same-intent calls** — the agent trying 3 variants of one operation is a gap even if
  one eventually worked (the `set_layer` finding was three failed variants in one batch);
- assistant natural-language complaints — grep for `had to / can't / cannot / workaround / manually /
  instead / forced / no way to / undiscoverable`;
- timing/ordering pain — domain reload, `refresh_assets`, play-mode reconnect, input-session keepalive,
  focus-required, "advance the sim" hacks;
- **workarounds that distort the game to satisfy the tool** — the highest-severity friction class: adding
  `[SerializeField]` purely to read state, switching canvas render mode purely to be captured, toggling a
  whole GameObject because a renderer flag wouldn't resolve. A tool that dictates game architecture is a
  design-distorting gap, re-rate its severity up.

### Pass B — flow/gap analysis (which surfaces got used vs BYPASSED)

This pass produces the **mandatory surfaces-used-vs-bypassed report**. The headline exemplar finding came
from exactly here: **0 `loomtide plan/build/verify/doneness/genre/assets/design` CLI verbs across an
entire finished 9-step build** — the core had no front door in a consuming repo, so the build reached for
the only lever it could see (the raw bridge). This is not a footnote; it is the top-line product signal.

- Read the build's own spec/README/design docs (`<project>/README.md`, `DesignDocs/*.md`) to know what
  was built and what "done" was graded against.
- Tally which Loomtide surfaces the session **used** (which bridge ops, which CLI verbs, whether
  `.loomtide/` was created by the tool or hand-rolled) vs **BYPASSED** (which verbs/gates never ran that
  the build's own plan implied should have).
- Watch for **false-green / verification theatre**: the build hand-creating `.loomtide/`-shaped evidence
  (screenshots into `.loomtide/captures/`, "contract pass" graded against a prose checklist) with no
  contract, no gate, nothing routed to the supervisor. A more `.loomtide`-aware agent produces a MORE
  convincing fake green — flag it as High.
- Output a short table: `Surface | Used? | Evidence | If bypassed, why (missing front door / undiscoverable / not applicable)`.

## Step 3 — Provenance tags and user corrections

**User corrections are first-class findings — treat them as the highest-signal channel.** On the exemplar
the GLB→FBX pivot, the camera-zoom spec violation, the firing-pose grammar, the movement/aim-facing rule,
and the rejected tiled-wall direction ALL came from the user, not the agent. Headless/bridge checks caught
compile errors and null refs but did not judge animation feel, weapon grip, UI readability, camera scale,
or art direction — the user did. Extract **every** user pushback, correction, interrupt, and "actually…"
as its own finding with a `[user-taught]` tag and a verbatim quote.

Tag every finding with exactly one provenance:
- **`[observed-this-session]`** — grounded in this transcript's tool results / messages. High confidence.
- **`[inherited-handover]`** — carried in from a prior agent's handoff prompt or an earlier doc, not
  observed in this session. Still may be a valid lesson, but the ledger must not claim this run proved it.
- **`[user-taught]`** — the user supplied or corrected it. Never bury these in chat memory; they are the
  channel that catches what automated checks miss.

Keep the older confidence axis too where useful: `[direct]` (transcript/trace evidence) vs `[2nd-hand]`
(asserted by an analysis agent reading the repo — verify against current code before acting). Provenance
(who/where it came from) and confidence (how well-grounded) are orthogonal; a finding can be
`[observed-this-session]` yet `[2nd-hand]` on its proposed fix's internals.

## Step 4 — Stable IDs and status lifecycle

- **ID scheme:** `<PROJECT>-<BUCKET><NN>` — e.g. `RCL-T08` (the extraction-shooter exemplar project, Tool-bug bucket, #8). Buckets on the
  exemplar: **T** tool/op gaps, **P** product/flow gaps, **G** missing genre capability, **F**
  framing/camera/input, **D** graybox/art-deferred identity, **O** onboarding/distribution. Reuse this
  bucket set unless the session genuinely needs a new letter. IDs are immortal: never renumber, never
  recycle, append-only across runs.
- **Status values:** `Open` · `Verified` (reproduced/confirmed in code) · `In-progress` · `Fixed` ·
  `Wontfix`. Use the **`Fixed²` variant** for the common real case: shipped as a measure-only calculator /
  framing contract / synthetic-trace-tested capability whose **live-proof on a built scene is deferred**.
  `Fixed²` is honest — it says "the code exists and unit-tests pass, but it has not been proven live"; do
  not launder it to a plain `Fixed`.
- **Shipped work updates the ledger — the delivery block is authoritative.** Stale `Open` cells were a
  real problem on the exemplar. When a finding ships, flip its status cell and cite the commit/PR; add or
  update a top-of-doc **Delivery status** block (epic → findings → status → key commits) that is the
  source of truth the per-finding cells must match. If the delivery block and a status cell disagree, the
  delivery block wins and the cell is stale — fix it.

## Step 5 — Routing table

Every finding routes to exactly one destination. Do not consolidate a finding out of existence before it
is filed somewhere durable.

| Finding class | Routes to | Notes |
|---|---|---|
| Tool / op gap, bug | Core backlog item or a tracked issue | The immediately-actionable bucket; cite the bridge handler it lives in. |
| Reusable workflow pattern | A `.skills/<name>` skill or a `Docs/` runbook | Codify the *procedure*, not the one-off. |
| Genre knowledge (dial, grammar, framing) | Genre-pack candidate — **gated on a second validation run** | Never promote from one run; park in a "Genre Pack Candidates" section. |
| Op-development gotcha | CLAUDE.md "Op Development Gotchas" / verification-invariants section | Durable trap for the next op author. |
| Distribution / product-seam gap | A planning doc (roadmap / execution plan) | Structural product work, not a quick fix. |

**Promote-now vs do-not-promote-yet discipline** (from the exemplar's "What To Promote Now"):
- **Promote now:** durable tool/backlog items, workflow stages+gates into a `Docs/` runbook, and the
  provenance-tag convention itself. These are validated the moment they're observed.
- **Do NOT promote yet:** exact game-specific art choices, exact provider action-IDs / clip names as
  canonical, one-off UI aesthetics, and any game-specific tuning value — until a *second* extraction-run
  (or genre-run) validates it. A single session's numbers are anecdotes; a genre pack is a claim about
  the genre.

## Step 6 — Verification pass (before the doc is final)

Two mandatory audits. Skipping either is how the exemplar's "9/10 shipped" claim collapsed to **0/12** and
its provenance mis-attributions slipped through the first draft.

1. **Spot-validate load-bearing claims against the transcript.** For each headline/High finding, re-grep
   the JSONL for the quoted error string or message and confirm it exists and means what you claimed.
   Correct any seed finding whose stated cause is subtly wrong (the exemplar's `find_object` root-cause
   was off in the seed and corrected on audit).
2. **Audit every "already shipped" claim at HANDLER level against HEAD — PR titles lie.** A PR titled
   "ship X" may have shipped an adjacent op, a partial subset, or nothing at the layer that matters. Grep
   the actual bridge handler / TS module for the behavior and the `RCL-ID` marker comment. Score each
   claimed-shipped item `shipped / PARTIAL / REAL GAP` from the code, not the changelog. The exemplar's
   backlog audit against HEAD scored `0 fully shipped / 5 PARTIAL / 7 REAL GAP` — the opposite of the
   optimistic pre-audit read.

## Step 7 — Recurrence check

Diff the new findings against the still-`Open` (and recently-`Fixed`) findings from prior runs. **A
recurrence means the fix didn't ship or didn't work** — the old bridge being live in the runtime the
session used, a partial fix, or a regression. File the recurrence as a *confirmation* against the existing
stable ID (strengthening it, and upgrading a `[2nd-hand]` finding to `[direct]` if the new run gives
transcript evidence), and re-open or re-rate the status. Distinguish "recurred because the runtime was
stale" (confirmation, not regression) from "recurred despite the fix being in HEAD" (regression — a new,
higher-severity finding).

## Step 8 — Keep the raw mining docs

Do not delete or overwrite the raw friction-mining notes when you consolidate into the polished ledger.
Evidence quotes and the surfaces-used tally nearly disappeared in a single consolidation hop on the
exemplar. Keep the raw pass output (the grep'd error lines, the retry clusters, the verbatim user quotes)
alongside the ledger until **every** finding is either promoted to its routing destination or explicitly
marked `Wontfix`. The raw doc is the audit trail that lets a later pass re-verify a claim without
re-reading the whole transcript.

## Output shape

Produce (or append to) a findings ledger mirroring the exemplars:
- **Delivery status** block at top (authoritative epic→status→commits) once any finding ships.
- **How to use / methodology** (the two-pass method, provenance + confidence tags, status values).
- **Run log** table (the watermark record, one row per mining pass).
- **Headline finding** — the single biggest signal (usually the surfaces-bypassed / false-green one).
- **Per-bucket tables** (`ID | Finding | Provenance/Conf. | Sev. | Evidence | Fix | Status`).
- **Surfaces-used-vs-bypassed report** (mandatory, from Pass B).
- **Cross-references** to adjacent findings in sibling docs — mark adjacency explicitly so a later reader
  does NOT dismiss an open item as "already fixed" by a related-but-different shipped fix.
- **Routing / promote-now vs not-yet** section.

## References

- The exemplar per-finding ledger (internal): stable IDs, confidence tags, run log, delivery-status
  audit, cross-references.
- The exemplar consolidated-learnings doc (internal): Provenance Corrections, durable principles,
  HEAD-audited backlog, promote-now/not-yet split.
- The exemplar execution plan (internal): how mined learnings became scheduled, reviewed work.
