---
name: verify-2d-game
description: Run the Loombridge verification pipeline on a built 2D game — deterministic Tier-1 quality gates (asset/manifest, UI conformance, framing, playability, feel) plus an advisory VLM design review against the design mock. Use AFTER unity-2d-game + game-polish-2d have built and polished the game, to self-check it against a machine-checkable acceptance contract, drive a fix→re-run loop until green, and hand over build-verdict.json + a green `loombridge doneness` as proof.
---

Use this skill to turn the human review pass — "the font is wrong, the player is clipped, it won at the wrong spot" — into reproducible self-checks the agent runs on itself. It is the third stage after `unity-2d-game` (build + feel) and `game-polish-2d` (presentation). The contract is `.loombridge/ACCEPTANCE.json`; the proof artifact is `.loombridge/reports/build-verdict.json` + a green `loombridge doneness`. The agent's primary tools are the **Loombridge CLI** (`loombridge verify --root . --inputs .loombridge/verify/<state> --strict`, `loombridge doneness`) and the **speed capture-runner** for the visual capture chunk; manual per-gate captures fill in the remaining gates. (A bare `loombridge verify` is the unified front door: it discovers the project's verification assets and refuses, exit 2, when nothing was graded; the per-state `--inputs` form above is the contract-mode invocation this skill drives.)

## When to invoke

After the game builds and plays. You need an **acceptance contract** at `.loombridge/ACCEPTANCE.json` (seeded by `loombridge plan`; authored from the design mock + the locked feel doc). If none exists, run `loombridge plan` first — it will refuse to complete without an approved Design Target, which is the right gate (see `references/report-schema.md` for the contract sections and `mcp-server/src/capabilities/verification/acceptance.schema.json` for the schema).

## Principles

1. **Fresh-eyes, not the builder.** Never let the builder grade its own work — it rationalizes ("I built a HUD so the font must be right") and rubber-stamps real defects. The Tier-1 gates are the external contract; the Tier-2 VLM review is an **independent adversarial ensemble** (≥2 fresh-context reviewers, no build knowledge, flags unioned) — see `references/vlm-review.md`.
2. **Tier-1 is deterministic and gates the build; Tier-2 (VLM) is advisory for `status` but required for handover.** The pass/fail verdict comes only from the Tier-1 gates — the VLM review is reported under a separate `reviewFindings` key, never folded into `status`. BUT the definition-of-done requires the perceptual review to run (against a play-mode HUD-visible frame) and every VLM `fail` to be resolved or justified before handover — it's the catch-all for the perceptual long tail the gates miss.
3. **Capture → evaluate.** Each gate = save a JSON file into `.loombridge/verify/` under the exact filename `loombridge verify` expects; the CLI maps it to its pure evaluator. The agent never re-implements gate logic; it only drives ops, saves outputs, and lets the CLI grade.
4. **Reproduce before you fix.** A failing gate is the reproduction. Fix the build (or consciously update the spec), then re-run the same gate — never claim green without the verdict showing it.
5. **Fast construction does not change the proof.** Whether the scene was built through individual ops, `unity_ops_batch`, or a generated editor script, verification must inspect the resulting game through screenshots, bounds, runtime probes, gate captures, and the final verdict. Never use construction shortcuts to fake playability.
6. **Prefer the one-shot speed capture-runner over hand-rolled probe-then-screenshot loops.** For the visual + runtime gates (framing / render-frame / visual-artifacts / console-clean / playability), the bundled `capture-runner` drives the sim through a scenario pack in one pinned runtime loop. Capturing a small burst across the motion in one driver pass — instead of separate `unity_editor_screenshot` calls — keeps transient seams / letterboxing / camera artifacts inside the same physics frame budget so they cannot slip between captures.

## Hard rules

1. **MCP tool names only** in plans/execution: `unity_ui_scan_text_components`, `unity_scene_get_screen_rects`, `unity_scene_verify_manifest`, `unity_runtime_probe`, `unity_runtime_assert_condition`, `unity_editor_screenshot`. Not `ui.scan_text_components`.
2. **Drive the sim via `unity_runtime_probe` (or the capture-runner's pinned loop), never real-time waits.** The Unity sim throttles/freezes when the editor is backgrounded, so wall-clock `sleep`/`wait` drifts. Probe phases advance on the physics timeline deterministically; state persists between probe calls (the sim is frozen in the inter-call gap). See `references/playability-checks.md` + `references/feel-checks.md`.
3. **New tool names need an MCP reconnect.** `unity_ui_scan_text_components`, `unity_scene_get_screen_rects`, `unity_scene_verify_manifest`, and the multi-driver `unity_runtime_probe` `drivers[]` form are only advertised after the MCP server restarts. If a tool is "unknown", reconnect, don't assume it's missing.
4. **Don't re-implement gate logic.** Save raw op output to the capture file; the CLI owns the pass/warn/fail math.
5. **`loombridge verify` is the canonical entry point — not `run-gates.js`.** `loombridge verify` writes a verdict with `runId` + `producedAt` so `loombridge doneness` (the §3a freshness gate) can certify it. Calling `run-gates.js` directly bypasses the supervisor mechanism and the build cannot be claimed "done."

## Gotchas (learned from dogfooding)

1. **Play-transition blip.** `unity_editor_play` — and the *first* op call right after entering play mode — can return `PREFLIGHT_BLOCKED` or `TIMEOUT_CONNECT`. This is transient (the editor is mid-domain-reload / re-establishing the bridge), **not** a real failure. Don't treat it as a finding: just retry the next call. Only escalate if it keeps failing across several retries.
2. **`unity_editor_screenshot` returns the PNG inline as `image_base64`** (plus width/height/format); the TS server *also* writes a trace artifact asynchronously. To collect a frame for the VLM review, **decode `image_base64` straight to `.loombridge/verify/<state>/frames/<id>.png`** (frames stay per-state — matches where the speed runner writes that state's frames). The ONE consolidated review (`.loombridge/verify/vlm-review.json`, at the verify root) references each frame by its state-relative path (`spawn/frames/<id>.png`, `hazard/frames/<id>.png`, …), and `run-gates` resolves the VLM `frames[]` paths relative to the review file's own dir. Do NOT glob the trace dir (`ls -t`); it is racy and holds stale cross-session frames. The capture-runner already does this correctly. See `references/vlm-review.md`.
3. **`feelStatus` won't advance while backgrounded.** Polling the FeelHarness does not tick FixedUpdate; the sim is frozen between MCP calls. Issue a `unity_runtime_probe` (any driver) to push game-time forward until the harness completes — see `references/feel-checks.md`.
4. **Author the contract carefully.** Every `hud` element's `colorRole` must have a matching `palette` role entry, or the color check silently degrades to an un-checkable **warn** instead of a real pass/fail — see `references/report-schema.md`.

## Workflow

The contract's `capturePack` declares **state-prefixed** capture paths (e.g.
`spawn/verify-manifest.json`, `spawn/screen-rects.json`, `hazard/…`, etc.). `doneness`
checks every entry under `.loombridge/verify/<state>/`. The canonical flow today:

- **One** capture-runner pass for the primary state's motion burst → writes a few gate
  inputs + frames into `.loombridge/verify/spawn/` (bundled scenario is spawn + jump-burst;
  it does NOT drive Unity to other states).
- Per-op MCP captures drive Unity into EVERY state in the capturePack and save the
  per-gate JSONs into the matching `.loombridge/verify/<state>/` subdir.
- `loombridge verify --root . --inputs .loombridge/verify/<primary-state> --strict` to grade
  the primary state's quality.
- `loombridge doneness --root .` to enforce capture-presence across **all** states.

**Today's M1 quality bar:** *primary-state quality verified + per-state evidence captured.*
Multi-state quality aggregation (running verify per state and merging verdicts) is a known
follow-up — until that lands, hazard / movement / win are evidence-only.

### 1. Speed path — capture-runner for the primary state's motion burst

The bundled platformer scenario (`platformer-2d-basic.json`) is a **single jump-burst from
`/Player`** at spawn — it does NOT drive Unity through hazard / movement / win. Run it
ONCE, writing into the primary state's subdir (`.loombridge/verify/spawn/`):

```bash
node mcp-server/dist/capabilities/verification/capture-runner.js \
  --acceptance .loombridge/ACCEPTANCE.json \
  --out .loombridge/verify/spawn
```

**What the default scenario actually writes** under `.loombridge/verify/spawn/`:

- `frames/` → race-free PNGs (the VLM review reads these)
- `visual-artifacts.json` → **visual-artifacts** gate
- `render-frame.json` → **render-frame** gate
- `console.json` → **console-clean** gate
- `capture-sequence.json`, `fix-list.json` — diagnostics (not gate inputs)
- `build-verdict.json` — intermediate; the canonical verdict comes from `loombridge verify` (step 3)

**Conditional outputs** (only when the scenario configures them — the bundled platformer scenario does NOT):

- `screen-rects.json` → **framing** gate (only when `scenario.collect.screenRects` is populated)
- `runtime-assertions.json` (only when `scenario.collect.runtimeAssertions[]` is non-empty)

> `runtime-assertions.json` is **not** the playability gate's input. The playability gate consumes `playability.json` — a separate per-op manual capture (see step 2).

> The runner produces the SAME jump-burst regardless of the `--out` label. Do not run it with `--out .loombridge/verify/hazard` (or movement / win) hoping to capture those states — you would only get mislabelled spawn jump-burst artifacts. Per-state evidence for those states must come from the per-op captures in step 2 (or future per-state scenarios). If `--scenario` is omitted, the runner picks a bundled scenarios pack matched against the contract's genre / capturePack.

### 2. Per-op captures for the remaining gates (same state subdir)

The speed runner does not cover the static / pre-play / structural gates. Drive each with the corresponding MCP op and save the output JSON **into the same `.loombridge/verify/<state>/`** subdir under the exact filename `loombridge verify` expects:

| Save as | From op | Gate | Reference |
|---|---|---|---|
| `verify-manifest.json` | `unity_scene_verify_manifest { manifest: <acceptance.manifest> }` | manifest | `references/acceptance-gates.md` |
| `ui-scan.json` | `unity_ui_scan_text_components { locator: "/Canvas" }` (HUD root) **+ a `canvas` block** (Canvas render mode/camera + `PixelPerfectCamera.upscaleRT` via `unity_component_get_properties`) for the blurry-HUD check | ui-conformance | `references/ui-conformance.md`, `references/framing-checks.md` |
| `screen-rects.json` | `unity_scene_get_screen_rects { locators: [player, goal, hazards, HUD labels…] }` in PLAY mode | framing | `references/framing-checks.md` |
| `placement.json` | `unity_scene_get_bounds` per ground (`minX`,`maxX`,`topY`) + grounded item (`visibleBottomY`/`surfaceTopY`) + overscan-aware `cameraFrame` | placement | `references/framing-checks.md` |
| `playability.json` | assembled from `unity_runtime_probe` (multi-driver) + `unity_runtime_assert_condition` — drive don't teleport | playability | `references/playability-checks.md` |
| `coverage.json` | play-mode "soak" then `unity_scene_get_bounds` per parallax layer + camera frame | coverage | `references/framing-checks.md` |
| `reachability.json` | `unity_scene_get_bounds` per platform/launcher/collectible (jump/dash/trampoline envelope) | reachability | `references/playability-checks.md` |
| `platform-tiles.json` | Platformer terrain construction: tile counts, row roles, collider top vs visible top | platform-tiles | `platformer-level-design/SKILL.md` |
| `objects.json` | Per-prop bounds + components for the prop-purpose gate | prop-purpose | `references/acceptance-gates.md` |
| `feel.json` | **`loombridge capture --slice <feel slice>`**: the CLI feel recipe drives run/jump/short-hop/coyote/jump-buffer/dash and writes the file from the op echoes (needs `harness.feelSeam` in the contract). Never hand-assembled. | feel | `references/feel-checks.md` |
| `vlm-review.json` (advisory, but required to run) | **independent adversarial ensemble** (≥2 fresh-context reviewers) scoring **play-mode, HUD-visible** frames vs the mock, **flags unioned**, passed to verify via `--vlm` | reviewFindings | `references/vlm-review.md` |

Missing files degrade to a WARN gate, so a partial run still produces a useful verdict. Save the op's `content[].text` JSON verbatim.

### 3. Verify + doneness (the canonical entry points)

`loombridge verify` today grades a SINGLE state's captures at a time. Run it against the
primary state's subdir; `doneness` then enforces that **every** state's capture-manifest
entries exist:

```bash
# Tier-1 verdict + advisory VLM merge — writes runId + producedAt into the verdict.
# For platformer-2d the primary state is `spawn` (--inputs grades that state's gates).
# --vlm is the ONE consolidated review at the verify ROOT, covering ALL states' frames
# (NOT a per-state spawn-only review — that misses cross-state frame-integrity, P1.3).
node mcp-server/dist/surfaces/cli.js verify --root . --inputs .loombridge/verify/spawn --strict \
  --vlm .loombridge/verify/vlm-review.json

# §3a freshness + hero-shot fidelity gate — the ONLY path to a "done" claim.
node mcp-server/dist/surfaces/cli.js doneness --root .
```

`loombridge verify` writes the canonical `.loombridge/reports/build-verdict.json`; `loombridge doneness` returns 0 only when phase=verified-green AND verdict.runId === currentBuild.runId AND verdict.producedAt is on/after currentBuild.startedAt AND every captureManifest entry is present + safe **AND — for a design-targeted build — the verdict's `reviewFindings` references the frozen hero shot (`reference.heroShotSha256 === designTarget.pngSha256`), is independent (`independent` + `reviewerCount ≥ 2`), and passes every structural fidelity criterion** (§P0). Never claim handover without a `doneness` exit 0.

> **Known limitation (M2 follow-up).** Today `loombridge verify` grades one state per
> invocation. `doneness` enforces capture *presence* across every state, but multi-state
> quality *aggregation* (running verify per state and merging verdicts) is deferred.

### 4. Tier-2 VLM perceptual + design review (REQUIRED to run; advisory for `status`)

Capture the key frames **in PLAY mode with the HUD visible** (spawn / mid-level dash / win) via probe-to-position + `unity_editor_screenshot { view: "game" }`, decoding each result's `image_base64` straight to `.loombridge/verify/<state>/frames/<id>.png` (no trace-dir glob). The speed runner already does this for the scenario pack's named frames when invoked with `--out .loombridge/verify/<state>/`; capture any additional frames the ensemble needs into the same per-state `frames/` dir so the VLM file's relative `frames/<id>.png` paths resolve correctly (`run-gates` resolves them relative to the VLM file's own directory).

Then run an **independent adversarial ensemble — N ≥ 2 (recommend 3) fresh-context reviewers with NO build knowledge**, spawned via the Task / sub-agent tool; each gets ONLY the mock, the frames, and the rubric, and is prompted to assume the build is flawed and hunt the flaws. **Union their flags** (worst status per criterion survives; a criterion passes only if ALL reviewers passed it), emit one `vlm-review.json`, and pass it to verify with `--vlm`. The independent + adversarial + unioned design defeats the builder-grading-itself confirmation bias. Recipe + rubric + ensemble flow: `references/vlm-review.md`.

### 5. Fix → re-run loop

For each Tier-1 `failures[]` entry: reproduce (the gate already did) → fix the build → re-capture that gate's output → `loombridge verify --root . --inputs .loombridge/verify/<state> --strict` → `loombridge doneness`. For an anchor/extras `warn` or an intentional deviation, either fix or **consciously update the acceptance contract** (document the decision). Loop until `loombridge doneness` exits 0. For the advisory `reviewFindings`: **every unioned perceptual `fail` must be resolved (fix → re-capture → re-run the ensemble → re-union) or explicitly justified in writing** — warns are triaged but don't block.

### 6. Asset handoff consistency check (when applicable)

If `.loombridge/handoff/<genre>-asset-prepare-report.json` exists, run the consistency check explicitly (the bare `npm run asset:handoff:check` script requires `--prepare-report` and exits 1 without it):

```bash
node mcp-server/dist/capabilities/assets/handoff-consistency.js \
  --prepare-report .loombridge/handoff/<genre>-asset-prepare-report.json \
  --verdict .loombridge/reports/build-verdict.json \
  --output .loombridge/handoff/asset-handoff-consistency.json \
  [--text .loombridge/handoff/handoff.md,scripts/builder.cs]
```

This catches stale handoff prose, `registryAssets.used=false` contradictions, and asset ids in the verdict that don't match the prepare report.

### 7. Hand over

`build-verdict.json` (+ `reviewFindings`, + the captured frames) and a green `loombridge doneness` exit are the proof artifacts.

## Definition of done

Before handover, ALL of the following must hold — not just a green Tier-1 verdict:

1. **`loombridge doneness` exits 0.** This subsumes Tier-1 green + the §3a freshness predicate (runId match, producedAt fresh, every captureManifest entry present and safe) **and — for a design-targeted build — the hero-shot fidelity predicate** (plan §P0): the verdict's `reviewFindings` must reference the frozen hero shot (`reference.heroShotSha256 === designTarget.pngSha256`), be independent (`independent` + `reviewerCount ≥ 2`), and pass every Group-C fidelity criterion (`composition-match`, `parallax-present`, `platform-tiers`, `element-placement-arc`). A green Tier-1 alone is NOT done — only `doneness` is.
2. **PLAY-MODE frames with the HUD visible were captured** under `.loombridge/verify/<state>/frames/` — the live render, not the edit-mode scene view — by decoding each `unity_editor_screenshot` result's `image_base64` straight to the named frame file (no trace-dir glob, race-free). The capture-runner does this for scenario-pack frames when invoked with `--out .loombridge/verify/<state>/`; supplement with extra frames the VLM ensemble needs *into the same per-state `frames/` dir* so the `--vlm` file's relative `frames/<id>.png` paths resolve correctly under `run-gates`.
3. **The independent adversarial ensemble ran against the frozen hero-shot IMAGE** — N ≥ 2 (recommend 3) fresh-context reviewers with NO build knowledge, each given ONLY the **frozen `.loombridge/design/hero-shot.png` bytes** (not contract attributes) + the frames + the rubric and prompted adversarially. Their flags were **unioned** into one `vlm-review.json` (worst status per criterion survives; a criterion passes only if ALL reviewers passed it), **stamped with `reference.heroShotSha256` + `independence: { independent: true, reviewerCount: N }`**, and produced and merged via `loombridge verify --vlm`. It appears under `reviewFindings`, and the Group-C fidelity subset is what `doneness` enforces (#1).
4. **Every union `fail` is resolved or justified.** Each unioned `criteria[].status == "fail"` is either fixed in the build and re-verified — re-capture the frame, re-run the ensemble, re-union (the finding flips to pass/warn on the re-run) — OR carries a written one-line justification recorded next to the verdict. A `fail` left unaddressed and unexplained is NOT done.
5. **Registry handoff consistency is green when registry assets were prepared.** If `.loombridge/handoff/*asset-prepare-report.json` exists, the asset-handoff check ran with no mismatches between prepare-report ids and verdict ids and no stale "registry skipped" prose.

## Reference files

- `references/acceptance-gates.md` — the Tier-1 gates + the op→args→evaluator orchestration recipe + warn-vs-fail policy.
- `references/ui-conformance.md` — font + HUD-color + presence checks (`unity_ui_scan_text_components`).
- `references/framing-checks.md` — clipping + player-anchor checks (`unity_scene_get_screen_rects`).
- `references/playability-checks.md` — contract-defined win rule / hazard / collectible via multi-driver `unity_runtime_probe` + `unity_runtime_assert_condition`; reconcile build behavior against `acceptance.win.rule`.
- `references/feel-checks.md` — FeelHarness (apex / time-to-apex / run) + probe recipes for dash distance / short-hop / coyote / buffer.
- `references/vlm-review.md` — the advisory rubric, the independent adversarial ensemble flow (spawn ≥2 fresh-context reviewers → adversarial prompt → union the flags), and the race-free base64-decode key-frame capture recipe.
- `references/visual-perception-models.md` — the structured visual-perception path for S6: deterministic image facts + model-grounded boxes/OCR/masks compared against contract facts, with VLM prose kept advisory by default.
- `references/report-schema.md` — the `build-verdict.json` + `reviewFindings` shapes + the acceptance-contract sections.
