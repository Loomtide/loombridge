# Design Partner Protocol (S5e)

**Status:** protocol v1 — S5e shipped 2026-06-04
**Purpose:** a repeatable, low-trust, non-destructive way to run Loombridge **verify-first** on
3–5 real Unity 2D platformers, learn whether the report is *useful*, and turn that learning into
**reviewed** profile changes — never silent ones.
**Reads with:** [VerifyFirstEntry.md](VerifyFirstEntry.md) (the run mechanics + non-mutation
deny-list), [PlatformerFeelProfiles.md](PlatformerFeelProfiles.md) (the profile bands under test),
[S5cbLiveProof.md](S5cbLiveProof.md) (the live-capture recipe + negative proofs).

This is a **docs/protocol** slice. It adds no capture or report code; it standardizes how we *use*
the verify-first wedge with outside developers and how we decide what their results change.

---

## 0. Principles (do not violate to "get a result")

1. **Diagnose first; the developer stays in control.** We read and measure; we never edit their
   game. The promise is *"let Loombridge diagnose first; you stay in control."*
2. **No green if key measurements are missing or distrusted.** An unmeasured metric is reported
   `not measured`; a value that fails re-derivation is `rejected` (forced `fail`). We never fold
   either into a green summary.
3. **Success is not "every project is green."** Success is that the report identifies a *meaningful*
   issue, or *confirms a known feel choice*, in language and numbers the developer trusts. A
   confident, correct **fail** on a real project is a win.
4. **Trust over coverage.** A measured-and-`verified` metric outranks a wider set of typed-in
   (`reported`) numbers. Prefer fewer metrics we can stand behind.
5. **One-off ≠ truth.** A single project's result never edits a shipped profile band. Profile change
   is a separate, reviewed, multi-signal decision (§7).

---

## 1. Cohort target

- **3–5** real Unity 2D platformer projects.
- Spanning archetypes: **at least one** precision-style, **one** classic/floaty-style, **one**
  momentum/action-platformer-style. (A project that doesn't fit any archetype is itself a finding.)
- Each project runs the same procedure (§4) and produces the same artifact set (§5).

---

## 2. Intake checklist

Two parts. Keep **2a (developer-facing) short** — this is a first touch, not an audit. **2b is the
operator's** pre-flight and is never homework for the developer.

### 2a. What we ask the developer (lightweight)

- [ ] **Consent to run** verify-first read-only/measurement on a copy of their project, and consent
      for *which* artifacts (if any) may be shared back to Loomtide (see §3). Default: nothing leaves
      their machine without explicit per-artifact opt-in.
- [ ] **Project name / contact**, and an **anonymization preference** (real name vs. an anon id like
      `partner-03`).
- [ ] **Unity version** and the **input backend — a first-class gate, it decides whether the project can
      be measured at all** (see §4). **Input System** project (`activeInputHandler` = Input System Package
      or Both; `com.unity.inputsystem` present) ⇒ autonomous OS-backgrounded capture works (PR #39).
      **Legacy `UnityEngine.Input`** project (`activeInputHandler:0`, no Input System package) ⇒
      **input-driven capture is UNSUPPORTED — not autonomous and not focus-held** (the EditorEvent backend
      cannot feed `Input.GetAxis/GetButton` even with focus; proven 2026-06-05). Route to: developer adds
      the Input System package (their mutation), or a clearly-labeled lower-confidence motor-field-drive
      adapter, or exclude (§4). Confirm with `unity_input_get_capabilities` (`backend.selected`) before
      scheduling; set the developer's expectation up front.
- [ ] **Which archetype do they *think* it is?** (precision / classic / momentum / unsure) — their
      word, before we measure. We do not lead the witness.
- [ ] **Which object is the player**, and **which keys drive it** (`jump` / `moveLeft` / `moveRight`
      / `dash` / `jumpCut`). There is no binding auto-discovery; an undeclared key → that metric is
      `not measured`, named, never guessed.
- [ ] **What do they care about most?** (e.g. "the jump feels floaty", "is my coyote time sane?") —
      one sentence. This is how we judge report *usefulness* later, not just pass/fail.

### 2b. Operator pre-flight (before touching the project)

- [ ] Work on a **throwaway copy or a checkpointed scene** — never the developer's working tree.
- [ ] Confirm the copy is a clean baseline (`git status` clean, or a pre-run snapshot taken).
- [ ] Re-read the **non-mutation deny-list** in VerifyFirstEntry.md.
- [ ] Pick the `--profile` to grade against from the developer's stated archetype (confirm; don't
      override their intent). If unsure, record "unsure" and pick the closest — the mismatch is data.
- [ ] Note the project's **fixed timestep** (50Hz vs 60Hz) up front — it changes how feel reads and
      is required provenance (`physics-timestep`).

---

## 3. Privacy & non-mutation policy

**Non-mutation (their code is untouched):**
- Never call any op on the VerifyFirstEntry.md deny-list (`scene.save_scene`, `scene.create/delete/
  set_*`, `component.add/remove/set_property`, `code.*`, `asset.*`, `ui.*`, `package.*`, and
  `input.*` outside a measurement session that reverts on Play-Stop).
- All measurement runs in Play Mode + input injection that **reverts on Stop**. If any temporary
  instrumentation is unavoidable, it goes through an explicit, auditable install/revert path or a
  duplicated/checkpointed scene — and is reverted before hand-back.
- **Prove it after every run:** `git status` clean on the copy (or diff vs the pre-run snapshot).
  No commits leave the partner project. Record the clean status as an artifact (§5).

**Data handling (their data stays theirs):**
- **Source never leaves their machine.** We do not copy the game's source/assets into Loomtide repos
  or any shared location.
- **Per-artifact consent.** Only the artifacts the developer explicitly opts into (§5) are shared
  back, and only for the agreed purpose (improving profiles/tooling).
- **Captures carry only transforms + timing** (`{tMs, x, y}` trajectories, derived metrics, timestep
  provenance) — not scene content, scripts, or assets. Still, scan a shared `feel.json`/report for
  anything identifying (object paths, scene names) and **redact or anonymize** before sharing.
- **No secrets.** Never include API keys, credentials, or private paths in shared notes/metadata.
- **Retention & withdrawal.** State where shared artifacts live, how long they're kept, and that the
  developer may request **redaction or deletion at any time**. Withdrawal removes their data from any
  future profile-change rationale.
- **Anonymized benchmark is opt-in only** (Open Question #4): we do not build a cross-project
  benchmark from partner data unless a developer explicitly opts in to that specific use.

**Consent boundary, in one line:** *read + measure on a copy, share back only what they tick.*

---

## 4. Run procedure (per project)

Mechanics live in VerifyFirstEntry.md (§"agent's read-only live entry" + §"S5c measuring") and
S5cbLiveProof.md (the operator recipe). Do **not** duplicate them here. The protocol order is:

1. **Intake** (§2) and **baseline snapshot** of the copy.
2. **Read-only inspect** the scene (hierarchy / find player / bounds / snapshot / optional
   screenshot). Confirm the player object and the archetype guess.
3. **Declare the input map** from intake. Undeclared keys → those metrics are `not measured`.
4. **Capture** run/jump/short-hop trajectories live; **bisect** coyote/buffer. Omit (with reason)
   anything that won't measure honestly — never param-read, never invent.
5. **Assemble `feel.json`** with each value derived from raw evidence (trajectory sources carry
   `derivation:"trajectory"` + their raw `samples`).
6. **Grade:** `loombridge verify --profile <id> --measurements <feel.json>`. Capture the JSON report
   and the terminal output verbatim.
7. **Confidence pass:** read the per-metric confidence — every band claim should be `verified`
   (re-derived) or honestly `reported`/`not measured`; investigate any `rejected`.
8. **Prove non-mutation** (`git status` clean) and **hand back / discard** the copy.
9. **Fill the run record** (§5 template) and **the questionnaire** (§6) with the developer.

A run is **complete** (not "passed") when steps 1–9 are done and the artifact set is present —
regardless of the verdict's color.

### Known capture limitations (validated in the 2026-06-04 internal dry run)

These are live-proven gotchas; honor them or the capture silently produces zero/wrong motion.

- **Input-driven capture works on InputSystem projects only; legacy projects can't be input-driven at all.**
  On an **Input System** project, `runtime.capture_input_motion` works while the Unity Editor app is
  OS-backgrounded (bridge applies Input System focus/background routing for the session, restores on
  teardown; issue #37 / PR #39; validated S5e dry run #1, unfocused `deltaX≈−5.43`). On a **legacy
  `UnityEngine.Input`** project (`activeInputHandler:0`, no `com.unity.inputsystem`), the #39 pump
  **compiles out** and the bridge falls back to the **EditorEvent** backend, which **cannot drive legacy
  `Input.GetAxis/GetButton` at all** — it refuses an unfocused session (`[FOCUS_REQUIRED]`) **and**, even
  with focus held, `gameView.SendEvent` does not populate legacy `Input`, so the controller does not move
  (S5e legacy-input investigation, 2026-06-05: three methods, all `deltaX=0`, app foregrounded). **There is
  no focus-held legacy mode — do not promise one.** `[FOCUS_REQUIRED]` is a stop condition, not a profile
  result; on a legacy project it is also a *dead end* (focusing won't help). For a legacy project: (a) the
  developer adds the Input System package (their mutation) → autonomous capture applies; or (b) use a
  clearly-labeled lower-confidence **motor-field-drive** adapter (drives the controller's movement field
  directly — runSpeed-only, NOT input-driven, must be labeled `drive:"component-field"` + sub-`verified`
  tier); or (c) exclude from the input-driven cohort. Check `unity_input_get_capabilities`
  (`backend.selected`): EditorEvent-only ⇒ legacy ⇒ input-driven capture unsupported. If an *InputSystem*
  unfocused capture reads zero motion, pause and classify it as a tooling regression. (Evidence: S5e dry
  run #2 + the legacy-input investigation, PC2D sample.)
- **Never assemble a `feel.json` (or grade) from a failed/zero legacy injection.** A refused or
  zero-motion legacy capture is **not a measurement**; turning it into a `feel.json` fabricates a number
  (the self-grade verify-first exists to prevent). Report the project **not input-measurable** and stop —
  do not run `verify --profile` against invented values. (Mirrors §0 principle 2: no green over missing/
  distrusted measurements.)
- **`runtime.capture_input_motion` must use `captureFps: 0`** — pinning the timestep breaks in-loop
  injection (motion reads zero). Keep phases short; the trade-off is a high sample rate.
- **Run on a clear runway.** A wall mid-run silently under-reports speed; pick an open direction,
  confirm the player traversed, and treat a standstill as "not measured".
- **Reset between captures.** The player carries position across captures in one Play session; re-enter
  Play (or move clear) so a run doesn't start against a wall.

---

## 5. Artifact checklist (per run)

Collect all of these. Items marked *(share = opt-in)* leave the developer's machine only with
explicit consent (§3).

- [ ] **Project / environment metadata** — anon id, Unity version, input backend, fixed timestep
      (50/60Hz), date, Loombridge version/commit.
- [ ] **Declared input map** — the keys used (and any metric marked `not measured` for a missing key).
- [ ] **Raw captures** *(share = opt-in)* — the `runtime.capture_input_motion` / `measure_motion`
      outputs (aggregates + `{tMs,x,y}` samples + timestep provenance).
- [ ] **`feel.json`** *(share = opt-in)* — the assembled measurements with provenance sources.
- [ ] **Report JSON** *(share = opt-in)* —
      `~/.loombridge/projects/<anon-id>/feel/reports/feel-profile.json` (status, per-metric
      result + `confidence`, `rederivation`, `headline`, `nextAction`).
- [ ] **Terminal output** — the rendered report (headline, per-metric lines, confidence roll-up,
      next action), verbatim.
- [ ] **Non-mutation proof** — `git status` clean (or snapshot diff) of the copy.
- [ ] **Notes** — operator observations, anything omitted and why, surprises.
- [ ] **Questionnaire** (§6) — the developer's answers.

> Storage: partner artifacts are **not** committed to this public repo by default. Keep them in a
> private/partner-controlled location keyed by anon id. Only an explicitly anonymized, consented
> excerpt may ever be cited in a profile-change PR (§7).

### Run record template (copy per project; fill in)

```md
# Design Partner Run — <anon-id> — <date>

## Environment
- Unity: <version>   Input backend: <InputSystem|legacy>   Fixed timestep: <50|60>Hz
- Loombridge: <version/commit>   Profile graded: <precision|classic|momentum>   Dev's guess: <…>

## Input map
- jump=<key> moveLeft=<key> moveRight=<key> dash=<key|none> jumpCut=<key|none>
- Not measured (missing key): <…>

## Result
- Status: <pass|incomplete|fail>
- Headline: <one line from the report>
- Per metric: <id> = <measured><unit> → <target><band> | <pass|fail|not_measured> | conf=<verified|reported|rejected|unmeasured>
  - …
- Rejected by re-derivation: <none | metric(s) + why>
- Next action (verbatim): <…>

## Non-mutation
- git status of copy: <clean | snapshot diff attached>

## Notes
- Omitted (with reason): <…>
- Operator observations: <…>

## Findings raised (→ §7 review; do NOT edit a shipped profile here)
- [ ] <finding> | class=<measurement-bug|profile-band|sample-only> | scope=<precision|classic|momentum|sample-only>
```

---

## 6. Developer feedback questionnaire (keep it short)

Ask after the report is on screen. Plain language; no Loombridge jargon, no internal flags.

1. **Did the report match your sense of how the game feels?** (yes / mostly / no — one sentence why.)
2. **Did it surface anything you didn't already know,** or confirm something you suspected?
3. **For the thing you cared about most** (from intake): did the report address it usefully?
4. **Was anything wrong or misleading?** (A number that looks off, a fix suggestion that doesn't fit
   your game, wording you'd push back on.)
5. **Did anything feel risky or intrusive** about running this on your project?
6. **Would you act on the next step it gave you?** (yes / no / "it's an intentional choice" — the
   last is important: a deliberate design decision reading as a "fail" is a *profile* signal, not a
   bug in their game.)

Capture answers verbatim where short; they feed both report-usefulness judgment and §7.

---

## 7. Profile-adjustment review process

The whole point of the cohort is to learn whether the **bands** are right. That learning must be
disciplined — a partner result is evidence, not a patch.

### 7.1 Classify every finding before doing anything

- **Measurement bug** — the harness/derivation/capture produced the wrong number (e.g. a `rejected`
  re-derivation, a frame-quantized short-hop, a sim-frozen read). **→ fix the tooling, never the
  band.** Re-measure once the measurement is trustworthy. A band is only revisited *after* its
  inputs are trustworthy.
- **Profile-band learning** — the measurement is trustworthy, but the band is wrong for the
  archetype (too tight, too loose, wrong center). **→ candidate for a reviewed band change (7.3).**
- **Sample-specific** — a legitimate, deliberate design choice unique to this game that does *not*
  generalize. **→ record it; do not touch any shipped profile.**

### 7.2 Tag scope

Every finding records **which** it affects: `precision` / `classic` / `momentum` / `sample-only`.
A finding from a precision project says nothing about the momentum band.

### 7.3 Gate for a shipped band change (all required)

1. **Measurement is trustworthy** — the value is `verified` (re-derived), not a measurement bug.
2. **Developer-validated intent** — the developer confirms the finding reflects how the archetype
   *should* feel, not a quirk of their game (questionnaire Q6 is the tell).
3. **More than one signal** — corroboration from **≥2 projects of the same archetype**, *or* an
   explicit maintainer decision with written rationale for why a single strong signal generalizes.
4. **Reviewed PR** — the change edits the profile JSON, passes the **S5a validator + tests**
   (`platformer-profile.schema.json` / `validator.ts` / `loombridge-platformer-profiles.test.ts`), and
   is reviewed by a maintainer.
5. **Provenance** — the PR links the (anonymized, consented) run records that motivated it.

**No silent promotion.** A one-off learning, an un-consented result, or a measurement bug **never**
edits a shipped band. If the gate isn't met, the finding stays recorded as a candidate.

### 7.4 Record the decision

For each finding, record the outcome: `tooling-bug-filed` / `band-change-merged (PR #…)` /
`sample-only-recorded` / `candidate-held (needs more signal)`. The cohort's value is this ledger,
not a count of green projects.

---

## 8. Definition of done (S5e the slice vs. running it)

**S5e (this doc) is done** when the intake checklist, privacy/non-mutation policy, run procedure +
template, artifact checklist, questionnaire, and the reviewed profile-adjustment process all exist
and are reviewed.

**Running the protocol is the next product move** (not more S5 implementation): execute it first on
the cloned sample project(s) as a dry run, then on 3–5 external/partner projects, and let the §7
ledger drive any reviewed band changes.

### Runs

- **Internal fixture — `2D-Character-Controller` (2026-06-05).** Full §4 procedure on a cloned online
  sample (Unity 6000.3.9f1, Input System backend, 60Hz, `PlatformerPlayerController`) as a controlled
  internal fixture, not an external partner. Autonomous (Game-view-unfocused) `runtime.capture_input_motion`
  → `feel.json` → `verify --profile precision --root <scratch>` = **honest `status=fail`** (runSpeed +
  jumpApex out-of-band, timeToApex in-band; all three `verified`; 9 metrics honestly `not measured`).
  **N1 keystone tamper rejected** (`jumpApex`→3.0 in-band, samples untouched → §0 re-derivation forced
  `[rejected]`). Target **byte-for-byte unmodified**. Findings F1–F4 classified per §7.1 as
  sample-only / measurement-caveat / process — **no band changed** (none met the §7.3 gate); F3 (a
  report-UX issue where a scratch `--root` headline buries a valid feel verdict) filed as a deferred
  known issue. Artifacts + run record: `~/loombridge-runs/s5-run-2dcc/`. This is
  the first end-to-end protocol run; the §7 ledger stays empty (no shipped-band evidence yet).
