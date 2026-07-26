# 2D Kids Mini-Game Verification Contract (S6a)

**Status:** S6a — Visual/Mini-Game Contract (shipped 2026-06-05)
**Type:** `2d-kids-minigame`
**Runtime source of truth:** `mcp-server/src/capabilities/minigame/profiles/validator.ts`
**JSON Schema (docs mirror):** `mcp-server/src/domain/schemas/minigame-contract.schema.json`
**Example:** `mcp-server/src/capabilities/minigame/profiles/games/alphabet-pop.minigame.json`

A **mini-game contract** is a product-owned, per-game description of the
machine-checkable facts a kids mini-game release must satisfy before it ships:
required objects are visible, important UI sits inside the safe area, tap targets
are large enough for the declared age band, the core flow reaches a reward and a
way home, and the rendered frames have no obvious black bars or artifacts.

It is the S6 counterpart to the S5 platformer **feel profile**: where a profile
grades one *feel family* against tolerance bands, a contract grades **one
mini-game** against a named set of **deterministic** visual/UI/interaction checks.

> **Scope of S6a:** this slice ships the **contract + schema + validator + one
> example + docs only.** It does **not** capture anything, run any gate, compare a
> baseline, or support `--game all`. Those are S6b–S6f. The contract is the
> foundation everything else binds to.

## Position: deterministic decides CI, advisory advises

Loombridge is a **low-trust release-verification layer**, not "AI infers your visual
intent from pixels." That principle is encoded directly in the contract through
two separate check tiers (`checks.deterministic` and `checks.advisory`):

| | Deterministic checks | Advisory checks |
|---|---|---|
| **Decides CI pass/fail?** | **Yes** — these are the gate. | **No** by default — "needs human review". |
| **Evidence** | Bounds, viewport facts, screen rects, console — *objective, re-derivable*. | VLM/model judgment of taste, readability, age-fit. |
| **Examples** | `safe-area`, `required-in-frame`, `tap-target-size`, `text-clipping`, `control-overlap`, `background-fit`, `no-black-bars`, `render-frame`, `console-clean`, `interaction-flow` | `vlm-readability`, `vlm-age-appropriateness`, `vlm-visual-polish`, `vlm-state-plausibility` |
| **On failure** | Blocks the release; points at a state + object id. | Surfaced as a note/warning; never silently blocks unless the project explicitly opts in. |

A contract **must enable at least one deterministic check** — a contract that
relies only on advisory judgment decides nothing and is **refused**
(`NO_DETERMINISTIC_CHECKS`). This is the anti-false-green stance from CLAUDE.md
"Verification / supervisor invariants": the thing that gates a release must be a
deterministic, re-derivable fact, never a model's say-so.

The uGUI deterministic checks — `safe-area`, `required-in-frame`, `tap-target-size`,
`text-clipping`, `control-overlap` — draw their screen geometry from
`unity_ui_get_screen_rects`, which projects each RectTransform into screen-space
(pixel `screenRect` + normalized `viewportRect`) with per-element `isVisible` /
`visibilityReason` and `role`/`raycastTarget` identity. Pixel→dp conversion for the
tap-target floor is `dp = px / canvasScaleFactor`; the op emits each element's live
`canvasScaleFactor` (the CanvasScaler-driven `Canvas.scaleFactor`) as the density
basis (added S6c-3). The basis is never assumed — `tap-target-size` refuses when it
is absent rather than defaulting to 1.

`background-fit` (added S6c) is **pixel-based** rather than rect-based: it measures,
from the captured `<state>.png`, whether a declared background card's rendered fill
actually covers enough of its layout rect to envelope its content. The RectTransform
alone cannot catch this — content can sit inside the rect while the sprite renders far
smaller than it (the card not scaled/9-sliced), leaving content on the bare frame. The
frame checks `no-black-bars` / `render-frame` are likewise pixel-based (border/coverage
facts derived from the `<state>.png`).

Both tiers draw their names from **closed vocabularies**, so a typo can't silently
disable a check — an unknown name in either list is refused (`UNSUPPORTED_CHECK`).

## Contract shape

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | ✔ | `"1"`. |
| `id` | ✔ | Stable mini-game id (lowercase kebab). |
| `type` | ✔ | Must be `"2d-kids-minigame"`. |
| `title` / `description` | — | Human copy for the report. |
| `scenes[]` | ✔ | Unity scenes (≥1), each an `Assets/**.unity` path. |
| `ageBand` | ✔ | `2-4` / `3-5` / `5-7` / `8-12` — pins the tap-target floor. |
| `visualProfile` | ✔ | `phone-portrait` / `phone-landscape` / `tablet-portrait` / `tablet-landscape` — the aspect/orientation the frame must fill. |
| `states[]` | ✔ | Named capture states (≥1; ids unique). Each has a `kind` (`start` / `active` / `success_reward` / `failure_timeout` / `home_back`), an optional `scene` (must be declared), and optional per-state `requiredInFrame` object ids. |
| `requiredInFrame[]` | ✔ | Objects that must be visible (≥1). Each is `{ id, locator, description? }` so a failed check points at a concrete object. |
| `allowedOffscreen[]` | — | Objects explicitly allowed offscreen (must not also be `requiredInFrame`). |
| `uiSafeAreas` | ✔ | `maxOverflowFraction` (0 = strict) + optional per-edge `insets`. |
| `tapTargets` | ✔ | `minSizeDp` — must be ≥ the age-band ergonomic floor. |
| `interactionFlow` | ✔ | `happyPath[]` of state ids; must reference declared states and reach a `success_reward`. |
| `artifactThresholds` | ✔ | Frame/visual tolerances (`maxBorderFraction`, `maxUniformBorderFraction`, `minContentCoverage`, `maxArtifactSeverity`, and the S6e baseline tolerances `maxBaselineDiffFraction`/`maxRectDriftFraction`), each a fraction in [0,1]. |
| `containers` | — | Background→content bindings for the `background-fit` gate (added S6c; required **iff** `background-fit` is enabled). Each `{ background, content?, bgColor?, minBgFillFraction? }`: the background's rendered fill must cover ≥ `minBgFillFraction` (default 0.6; `0` refused) of its layout rect, and visible `content` with an absent/hidden background fails. `background`/`content` must be declared object ids; `bgColor` is `#RRGGBB` (default white). |
| `checks` | ✔ | `deterministic[]` (≥1) and optional `advisory[]`. |
| `baseline` | — | Optional approved-baseline reference (`{ ref, capturedAt?, masks? }`, S6e). `ref` is the bundle dir (relative to root or absolute). Each `masks` entry must be a declared `requiredInFrame`/`allowedOffscreen` object id (a typo'd mask is refused, not silently ignored). See **Baseline regression** below. |

### Age bands and the tap-target floor

Younger hands need bigger targets, so each age band pins an ergonomic **minimum**
tap-target edge length (dp). A `tapTargets.minSizeDp` below the floor is an
**impossible** setting — the declared minimum could never serve the age the game
claims to target — and is refused (`IMPOSSIBLE_TAP_TARGET`):

| Age band | Min tap target |
|---|---|
| `2-4` (toddler) | 100 dp |
| `3-5` (preschool) | 80 dp |
| `5-7` (early elementary) | 64 dp |
| `8-12` (tween) | 48 dp |

## What the validator refuses

The validator returns `{ valid, issues[] }` (non-throwing) or throws via
`assertValidMinigameContract`. Every refusal carries a `code`, a `path`, and a
message. The refusals that define S6a's done-bar:

| Code | Refuses |
|---|---|
| `MISSING_STATES` | no `states` (nothing to capture) |
| `MISSING_REQUIRED_OBJECTS` | no `requiredInFrame` (verifies nothing visible) |
| `IMPOSSIBLE_TAP_TARGET` | `minSizeDp` below the age-band floor |
| `UNSUPPORTED_CHECK` | a deterministic/advisory check name outside the closed vocab |
| `DUPLICATE_STATE_ID` | two states share an id |
| `INVALID_SCENE_PATH` / `MISSING_SCENES` | a non-`Assets/**.unity` path, a `..`/`.` traversal segment, a backslash / no scenes |
| `NO_DETERMINISTIC_CHECKS` | `checks.deterministic` empty/absent |

Plus supporting refusals: `UNSUPPORTED_TYPE`, `UNKNOWN_AGE_BAND`,
`UNKNOWN_VISUAL_PROFILE`, `UNKNOWN_STATE_KIND`, `STATE_SCENE_NOT_DECLARED`,
`UNKNOWN_STATE_OBJECT`, `DUPLICATE_OBJECT_ID`, `INVALID_LOCATOR`,
`CONTRADICTORY_OFFSCREEN`, `INVALID_TAP_TARGET`, `INVALID_SAFE_AREA`,
`UNKNOWN_THRESHOLD`, `INVALID_THRESHOLD`, `FLOW_UNKNOWN_STATE`, `FLOW_NO_REWARD`,
`FLOW_NO_TRANSITIONS` / `FLOW_INDISTINCT_TRANSITION` (interaction-flow enabled but
`happyPath` has <2 states / repeats an adjacent state — no gradeable transition),
`UNKNOWN_MASK_OBJECT`, the `containers`/`background-fit` refusals
(`BACKGROUND_FIT_NO_CONTAINERS`, `UNKNOWN_CONTAINER_BACKGROUND`,
`UNKNOWN_CONTAINER_CONTENT`, `CONTAINER_SELF_CONTENT`, `INVALID_CONTAINER_COLOR`,
`INVALID_CONTAINER_FILL` — note `minBgFillFraction` must be in `(0,1]`; `0` would
always pass), and the structural `INVALID_DOCUMENT` /
`INVALID_SCHEMA_VERSION` / `MISSING_FIELD` / `INVALID_FIELD` / `INVALID_ID`.

## Example

`alphabet-pop.minigame.json` is a worked example: a `3-5` tablet-landscape letter
game with five required objects, four states (`start → active → success_reward →
home_back`), a 96 dp tap-target minimum (above the 80 dp floor), the full
deterministic check set, and two advisory VLM checks. It loads and validates via
`loadExampleMinigame("alphabet-pop")`.

## Interaction flow (S6d): `flow.json` + harness-vs-game separation

When `interaction-flow` is enabled, the gate grades the declared
`interactionFlow.happyPath` per **transition** (each consecutive `from → to` pair),
and — the headline guarantee — **separates a GAME failure from a HARNESS/capture
failure so a harness fault is never reported as a game defect or a pass.** It is a
cross-state gate (`evaluateInteractionFlow`), not a per-state check.

Each transition needs two independent pieces of evidence: **(A) actuation** — the
input was honestly delivered (harness OK) — and **(B) outcome** — the resulting
capture **re-derives** to the expected target state (game OK). The gate never trusts
a harness-asserted "reached"/"matched" field; it recomputes reachability from the
actual `to` capture (`to`'s `requiredInFrame` all visible AND the `from` state left).

### `<captures>/flow.json` — the actuation evidence

The per-state captures (`<state>.ui-rects.json`) are the before/after snapshots;
`flow.json` adds, per transition, the actuation record(s) — written **verbatim** from
`unity_ui_dispatch_pointer`'s return so the gate can corroborate (and never fabricate)
that the declared control was acted on. Refuse-on-absent: an absent/unparseable
`flow.json` makes every declared transition `missing_evidence`.

```jsonc
{
  "schemaVersion": "1",
  "transitions": [
    {
      "from": "start", "to": "active",
      "trigger": { "kind": "ui-dispatch", "target": "/HUD/StartScreen/StartButton" },
      "actuation": { "actuated": true, "handlerTarget": "/HUD/StartScreen/StartButton",
                     "raycastHit": "/HUD/StartScreen/StartButton",
                     "handlersFired": ["pointerDown","pointerUp","pointerClick"] },
      "console": { "errorCount": 0 }          // informational only — console health is the `console-clean` gate's job
    },
    {
      "from": "active", "to": "success_reward",
      "trigger": { "kind": "ui-dispatch", "target": "/HUD/AnswerButton<correct>" },
      "steps": [ /* one actuation record PER step (e.g. each round); EVERY step must be honest */ ]
    }
  ]
}
```

Actuation honesty (all three required; weak/partial evidence is a **harness fault**,
never a pass): `actuated === true`, the declared `target` matches `handlerTarget` **or**
`raycastHit`, and `handlersFired` carries a click signal (`pointerClick`/`click`).
`trigger.kind` **must be `ui-dispatch`** (the only kind this slice grades) — any other
kind is refused as a harness fault, so it can never waive the click corroboration.
Use `steps[]` (not a single `actuation`) for a multi-click transition; every step is
checked independently.

### Outcome taxonomy and exit codes

| Outcome | Meaning | `loombridge verify --minigame` exit |
|---|---|---|
| `pass` | honest actuation + target state re-derived from the capture | `0` |
| `game_fail` | honest actuation, but the target state was NOT reached (soft-lock / missing reward) | `1` |
| `harness_fault` | input didn't actuate / target mismatch / partial bridge evidence — the game was **not honestly tested** | `2` |
| `missing_evidence` | no `flow.json` entry, or a `from`/`to` capture absent, or a `to` state with no `requiredInFrame` to re-derive against | `2` |

These compose with the per-state gates (precedence `fail > incomplete > pass`): a graded
gate **fail** (incl. an object missing **inside** a present capture) or a flow `game_fail`
is exit `1`; a **`captureAbsent`** state (a wholly-missing/unreadable capture file — a
capture/harness gap, **not** a game defect) or a flow `harness_fault`/`missing_evidence`
is exit `2`. A harness/capture fault **cannot be laundered into a green** by other passing
gates — only a real `fail` outranks it. The terminal report renders a `interaction-flow:`
block per transition and labels harness faults as NOT game defects.

## Baseline regression (S6e): approve a reference, then detect drift

A *baseline* is an APPROVED snapshot of the per-state captures, frozen from a PASS run.
When the contract declares `baseline.ref` and an approved bundle exists there, every
`loombridge verify --minigame` compares the current captures to it.

**Approve (a dedicated, MUTATING subcommand — kept off the read-only `verify`):**

```
loombridge minigame baseline approve --contract <c> --captures <dir> [--ref <bundle>] [--root <dir>]
loombridge minigame baseline status  --contract <c> [--ref <bundle>]          # read-only summary
```

`approve` refuses a non-pass run (you must never freeze a broken reference) and grades
WITHOUT comparing to any existing baseline (so re-approving an *intended* change is never
blocked by the old one). It writes, into `<baseline.ref>` (outside the game project): each
state's `<state>.png` + `<state>.ui-rects.json`, and a `baseline-manifest.json`
(`contractId`, `capturedAt`, `masks`, per-state `pngSha256`/viewport, the approved summary).

**Compare**, per declared state with both a current and a baseline capture:

- **perceptual PNG diff** — fraction of perceptually-differing pixels (`comparePerceptual`),
  with every `baseline.masks` object's rect **blanked in both images** (dynamic content —
  score text, randomized answers — must not trip it). Drift > `maxBaselineDiffFraction`
  (default `0.02`) regresses the state.
- **rect drift** — each non-masked object present in both: the max normalized edge delta of
  its rect vs the baseline. Drift > `maxRectDriftFraction` (default `0.02`) regresses the state.

**A baseline regression is its OWN tier** (CR group `baselineRegressions`): it blocks
release (**exit 1**) but is reported separately from a game defect (`blockingFailures`) and
from a harness/capture gap (`incompleteHarness`) — the next action is *review the change; if
intended, re-approve the baseline*, never "fix the game". A regression is computed from
present captures, so it is real even alongside a harness fault (`fail` outranks `incomplete`).
A **current** capture that is absent is `captureAbsent` (incomplete) — never a regression; a
**baseline** state file that is missing/corrupt is incomplete (cannot compare), **never a
silent pass**. A contract that declares `baseline.ref` with no approved bundle yet is an
advisory note (not enforced), not a failure.

## Next (not in S6a)

- **S6b** — generic 2D capture pack: capture `start` / `active` / `success_reward`
  states (screenshots, bounds, viewport facts, console), or mark a state blocked. **(shipped)**
- **S6c** — wire the deterministic checks to gates that consume the capture. **(shipped)**
- **S6d** — interaction-flow gate over the declared `happyPath` (above). **S6d-1 (offline core) shipped;**
  live CountTheFruits proof pending.
- **S6e** — single-game baseline regression (the `baseline` field gets teeth). **(shipped — see above)**
- **S6f** — producer/QA/engineer CR report UX. **(shipped)**

For S6b named screenshots, agents must call `unity_editor_screenshot` with an explicit
`outputPath` such as `.loombridge/captures/start.png` or `captures/start.png`. The tool
returns JSON with the written path and image metadata. Do not discover named captures by
scraping `trace/artifacts`; trace artifacts are recorder internals, not the capture-pack API.

## Fixture readiness: Input System only

For Loombridge-built S6 fixtures, use the new Unity Input System. This is not a preference; it is a
verification prerequisite for input-driven capture.

Before running S6b capture on a mini-game fixture:

- `Packages/manifest.json` must include `com.unity.inputsystem`.
- `ProjectSettings/ProjectSettings.asset` must use Active Input Handling = Input System or Both.
- Gameplay scripts must not poll legacy `UnityEngine.Input` (`Input.GetAxis*`, `GetButton*`,
  `GetKey*`, `GetMouseButton*`).
- Interaction code should use `InputAction`, `PlayerInput`, `Keyboard.current`, `Mouse.current`, or a
  small wrapper built on the Input System.
- `unity_input_get_capabilities` should select `InputSystem` and report `requiresGameViewFocus: false`.

Legacy `UnityEngine.Input` projects are not input-drivable by Loombridge. They must either be migrated by
the developer, verified through non-input visual/static checks only, or reported as not input-measurable.
