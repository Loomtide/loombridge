---
description: Make the project match the contract — mint a §3a build run, route intent, construct via Loombridge MCP, then verify + doneness
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(node:*), Bash(loombridge:*), Bash(npm:*), Bash(cat:*), Bash(scripts/*), mcp__loombridge__*
---

# loombridge build

Make the project match the contract, then prove it. `build` is the agent-facing router: it
mints a §3a build run, routes the developer's natural-language intent to the right kind of
work, drives Unity through the Loombridge MCP, and **always ends in `verify` then `doneness`**.
One canonical body drives both Claude Code (`/loombridge:build`) and Codex
(`scripts/loombridge-build`) — single source of truth, so the two agents cannot drift.

## 1. Mint + gate (deterministic)

```bash
loombridge build
# local dogfood fallback from the repo:
# node mcp-server/dist/surfaces/cli.js build --root .
```

The CLI default-hard-gates on (a) a contract from `loombridge plan` and (b) an **approved +
frozen** Design Target. On success it mints `currentBuild` (`runId` + `startedAt` +
`captureManifest` derived from `ACCEPTANCE.capturePack`) and sets phase to `built-unverified`.
In the slice pipeline, bare `build` selects the next unblocked slice from `.loombridge/SLICES.json`.
An optional quoted intent is still accepted for ad-hoc legacy flows, but developers should not
need to remember one for the planned slice loop.

**You don't need a flag.** Non-zero exit is the cue to resolve the blocker (run `plan`,
approve a hero shot, re-approve a drifted one) and re-run. The only escape is
`--allow-ungrounded-prototype` — loud, sticky, disqualifies the run from `doneness`.

Capture the printed `runId` from `[loombridge build] minted runId=…` — the verdict and
doneness gate will be bound to it.

## 2. Asset prep (manifest-driven before construct)

Read `.loombridge/ASSET_MANIFEST.json` before constructing. Slices consume the manifest's
`sliceBindings` and each bound asset's `resolvedPaths`; they do not search the registry on
their own.

**Manifest first, primitives never (asset priority — `Docs/Assets/AssetPriority.md`).** The
manifest is the resolved output of the plan-time asset stage (committed local registry packs and
generated assets by default; the hosted catalog only if the developer opted into it; web
discovery only when no asset in the chosen source fits). At build time you **import/use exactly
the manifest-bound assets** and do not re-resolve. If the manifest holds a placeholder, an
unfilled/`needed` role, or a role still on a primitive, **STOP and go back to `loombridge assets`**
(`loombridge plan` step 4 / the `asset-layer` skill) to resolve and approve that role from the
developer's chosen asset source. **Do NOT substitute a Unity primitive** (a
`GameObject.CreatePrimitive` cube/sphere/quad) as the final asset: primitives are construction
scaffolding only, never final art for a role that has (or could have) an approved registry asset.

Canonical platformer slice bindings:

| Slice | Manifest asset IDs |
| --- | --- |
| `framing` | `player_character`, `parallax_background`, `foreground_prop` |
| `ground-tiling` | `platform_tiles`, `one_way_platform` |
| `player-feel` | `player_character` |
| `parallax` | `parallax_background`, `foreground_prop` |
| `collectibles` | `collectible` |
| `hazards` | `hazard` |
| `hud` | `hud_style`, `button_style` |
| `juice` | `vfx_particle` |
| `end-state` | `button_style`, `hud_style` |

For the current slice, resolve the matching `sliceBindings[]` entry first and import/use exactly
those assets. If a bound asset is missing, `needed`, lacks `resolvedPaths`, or points to an
unapproved source, stop and update/approve the manifest; do not substitute a registry asset.

If the approved manifest contains `source:"generated"` assets, use the recorded
`generatedExport` provenance and `resolvedPaths` as the source of truth. Import those generated
sprites/backgrounds/tiles into Unity as listed; do not replace them with registry art because a
registry match exists.

If the approved manifest contains `source:"registry"` assets, the genre pack's curated asset
registry must be **prepared into the active Unity project's handoff dir** before the agent
constructs the scene. On a clean-room project, skipping this silently relies on whatever happens
to be already imported in `Assets/`.

Use `scripts/prepare-project-assets.sh` **from the repo root**, passing `--project
<path-to-unity-project>`. The script writes to `<project>/.loombridge/handoff/`:

- `<name>-asset-prepare-report.json` — the prepare report (provenance, license, sha256, accepted/rejected sprite list, and each entry's `import.toolArguments`).
- `<name>-asset-attribution.md` — credits.
- `asset-cache/` — a deterministic cache of the downloaded source assets the build agent imports from.

It does **not** copy sprites into the Unity project's `Assets/`. That import is the
**build agent's job during construction (step 5 below)** — the agent reads each accepted
entry's `import.toolArguments` from the prepare report and invokes
`unity_asset_create_sprite` / `unity_asset_assign_sprite` with those arguments. Asset prep
in this step is the *registry side* of the handoff; Unity import is the *project side*.

Pick profile / registry / name from `STATE.md`'s `genre`:

```bash
# Platformer-2d (point --project at your Unity project):
scripts/prepare-project-assets.sh \
  --project <your-unity-project> \
  --profile asset-layer/profiles/2d-platformer.json \
  --registry asset-layer/registry/platformer-2d.json \
  --name platformer

# Top-down arena:
# scripts/prepare-project-assets.sh \
#   --project <your-topdown-project> \
#   --profile asset-layer/profiles/2d-topdown-arena.json \
#   --registry asset-layer/registry/switchyard-2d.json \
#   --name switchyard
```

(If the operator is already inside the Unity project, equivalent: invoke the script via
its absolute path — `<repo-root>/scripts/prepare-project-assets.sh --project "$PWD" …`.)

The **`asset-layer`** skill covers the full flow (registry validation, provenance,
browser confirmation, deterministic project cache, attribution).

> Do **not** run the repo-local prepare CLI (`node mcp-server/dist/capabilities/assets/prepare-cli.js`) with a
> `--output`/`--cache` under the repo's `demos/.artifacts/` for a clean-room validation run — that stages
> assets into the *repo*, not the target project. Use `loombridge-asset-prep --project <path>` so the
> handoff lands under `<project>/.loombridge/handoff/`.

## 3. Route the intent (agent judgment — the part the CLI does NOT do)

Read `.loombridge/STATE.md` (phase, genre, last verdict, currentBuild) and classify the
prompt into ONE:

| Intent (example) | Route | Construction method (the DEFAULT, not optional) |
|---|---|---|
| "add a coin pickup and a win flag" | **feature build** → `unity-2d-game` | `unity_ops_batch` for all multi-object construction |
| "lay out the level / platforms" | **level** → `platformer-level-design` | `unity_ops_batch` (or a generated editor script for very large layouts) |
| "make the jump feel snappier" | **feel-tune** → FeelHarness solve→measure→tune | **`mcp-server/dist/capabilities/verification/tuning-runner.js`** — accelerates the iterate loop (mutations + measurement recipes in one pinned pass) |
| "polish it for a recording" | **polish** → `game-polish-2d`, `parallax-2d` | `unity_ops_batch` for prop wiring |
| phase is `verified-failing` | **fix-to-green** → read `.loombridge/reports/build-verdict.json` failures, fix each | re-run only the failing gates' captures |

The phase narrows the choice: in `built-unverified` the sensible moves are fix-to-green or
polish, not a fresh build. If the intent is ambiguous, ask the user.

The right-hand column is **prescriptive, not an optional accelerator** — see §5. RUN-1 ran
316 per-op round-trips with `unity_ops_batch`=0; batching is the default construction method,
not a speed-up the agent may skip.

## 4. Echo before mutating (§3)

Before any expensive/irreversible change, state the inferred plan and what it will touch,
e.g. *"I read this as: tune feel toward snappy → adjust jumpSpeed/gravityScale, re-measure.
Proceed?"* This keeps the human in control of routing without adding a verb.

For normal slice approvals, do **not** leave the user with a passive summary. Once a slice
is verified and `loombridge plan` reports an approval seam, ask an explicit question using
the available user-question tool:

- Header: `Approve slice`
- Question: `Approve <slice-id> and advance to <next-slice-id>?`
- Recommended option: `Approve & advance` — run the internal `loombridge plan --go`, then
  report the next `Next:` line.
- Second option: `Hold` — do not mutate; wait for review or requested changes.
- Optional third option when useful: `Request changes` — ask what to adjust and continue
  through the build/fix loop.

Always include the deterministic `Next:` action in prose as well, e.g.
`Next: say "approve hazards" or run /loombridge:plan to approve and advance.` The user should
never need to remember `--go`, `--slice`, or other internal flags.

## 5. Construct via Loombridge MCP

**3D builds — mind the design-target kind.** Run `loombridge target status`. If it reports
`kind=composition-reference`, the frozen image is a **style/composition guide**, not the final
hero shot — use it to aim the scene's layout, but the build is NOT done until you (1) assemble
the scene, (2) capture a real Unity frame, (3) `loombridge target set --image <frame> --kind
rendered-unity-frame --approve` that capture, and only THEN (4) run the independent hero-shot
review + `doneness`. `doneness` REFUSES to certify while the target is a composition-reference.
For a `rendered-unity-frame` (the default, and all flat-2D builds) the frozen image already IS
the final hero shot — proceed as below.

**First, study the hero shot (plan §P0.6 — aim right, don't just get flagged).** Before
constructing, OPEN and look at the frozen `.loombridge/design/hero-shot.png` and read its
`hero-shot.html` annotations. Lay out the scene to MATCH its structure, not just the
`ACCEPTANCE.json` text:

- **Background depth** — reproduce the hero shot's parallax/layer structure (hills, trees,
  sky), not a flat two-tone fill.
- **Level staging** — reproduce its multi-tier platform composition (staged platforms /
  pits), not a single flat ground strip.
- **Element placement** — put collectibles/hazards/goal on the hero shot's traversal arc
  (the jump/platform path), not lined up in a flat row on the ground.

This is the RUN-1 lesson: a build constructed from the brief *text* alone diverged from the
hero shot (flat bg + flat level + fruit-in-a-row) and the independent review later flagged
it — now `doneness` REFUSES that build (§7), so build it right the first time.

Build toward **both** halves of the target: the `ACCEPTANCE.json` contract and the frozen
hero shot in `.loombridge/design/`. Use the slice's bound skill plus the generic `unity_*`
MCP ops. A slice's `skill` is **optional**: where no shipped skill pack covers it, `plan`
prints `skill: (none ships for this slice — build with the generic \`unity_*\` MCP ops)`.
That is a real answer, not a missing one — build from the contract and the hero shot, and do
not go hunting for a skill by guessing its name. **One Unity editor, one project — work
sequentially** (§3b: no parallel agents on the same scene).

**`unity_ops_batch` is the DEFAULT for multi-object construction — not an optional speed-up
(plan §P1.2).** Whenever you are creating/placing/wiring more than ~2 objects, assemble the
ops into one `unity_ops_batch { operations: [...] }` call rather than issuing per-object
round-trips. It runs the ops sequentially on Unity's main thread in ONE round-trip wrapped
in a single undo group — `scene.create_object`, `component.add`, `component.set_property`,
`scene.set_transform`, `asset.assign_sprite`, etc. are all batchable. Reserve per-op calls
for the ops batch can't carry (anything async: `editor.play` / `wait_for` / `screenshot` /
input sessions) and for reading back state between dependent steps.

> RUN-1 is the cautionary tale: **316 per-op MCP round-trips, `unity_ops_batch`=0** — ~48 of
> the first 85 ops were batchable `create_object`/`component_add`/`set_property`. The speed
> tooling didn't pay off because construction defaulted to per-op. Batch by default and
> re-measure F2 (`unity_ops_batch` count) on the next run.

For a very large level layout where even batches get unwieldy, a generated editor script is
the fallback — but `unity_ops_batch` is the first choice.

## 6. Capture every state in `capturePack` (mandatory evidence)

`loombridge build` minted a `captureManifest` derived from the contract's `capturePack` — the
paths are **state-prefixed** (for `platformer-2d`: `spawn/verify-manifest.json`,
`spawn/screen-rects.json`, `hazard/…`, `movement/…`, `win/…` — 8 entries total). Each
entry must end up at exactly that path under `.loombridge/verify/`; `doneness` refuses to
certify a run with missing entries.

### Speed path — capture-runner for the primary state (today: `spawn` + jump-burst)

The bundled platformer scenario is a single jump-burst from `/Player` starting at spawn —
it does **not** drive Unity through hazard / movement / win. So one runner pass writes
spawn + jump-burst evidence into `.loombridge/verify/spawn/`. Use it there only:

```bash
node mcp-server/dist/capabilities/verification/capture-runner.js \
  --acceptance .loombridge/ACCEPTANCE.json \
  --out .loombridge/verify/spawn
```

**What the default scenario writes** under `.loombridge/verify/spawn/`:

| File | Gate it feeds |
|---|---|
| `frames/` (race-free PNGs) | (VLM review reads these) |
| `visual-artifacts.json` | **visual-artifacts** |
| `render-frame.json` | **render-frame** |
| `console.json` | **console-clean** |
| `capture-sequence.json` | (diagnostic, not a gate) |
| `fix-list.json` | (diagnostic, not a gate) |
| `build-verdict.json` | (intermediate — the canonical verdict comes from `loombridge verify`) |

**Conditional outputs** (only when the scenario configures them — the bundled
`platformer-2d-basic.json` does NOT):

- `screen-rects.json` → **framing** gate (requires `scenario.collect.screenRects`)
- `runtime-assertions.json` (scenario-declared assertions; **not** the playability gate
  input — `playability.json` is a separate per-op capture)

> Do not assume per-state correctness from running the runner with `--out
> .loombridge/verify/<other-state>`. The bundled scenario produces the same jump-burst
> regardless of the label on the output dir; calling it for `hazard` / `movement` / `win`
> just writes mislabelled artifacts. Per-state coverage of those states requires the
> per-op manual captures below (or future per-state scenarios).

### Raw capture writer — `loombridge capture` (screen-rects + console; DO NOT hand-author)

`screen-rects.json` and `console.json` must come from **raw op output**, not a hand-typed
file. A hand-authored `screen-rects.json` can claim any camera (so the framing-camera check
below grades fiction), and a curated `console.json` can hide runtime errors. Write them
deterministically instead:

```bash
loombridge capture --slice <id> --root . [--locators /Player,/Level/Flag,/Level/Saw,...]
```

It enters Play Mode, projects the requested objects (`unity_scene_get_screen_rects`),
reads the live `PixelPerfectCamera` (`unity_component_get_properties`) and **merges its
settings into the `camera` block** so the **framing-camera check** can verify the pixel
grid / `upscaleRT` / world position against `framing.camera`, pulls the console, restores
Edit Mode, and stamps a `_provenance` block (writer + ops + runId) into both files under
`.loombridge/verify/<id>/`. Default locators are `["/Player"]`; pass `--locators` for the
goal / hazards / HUD labels in later slices. (For the primary state's frames + visual
gates, the jump-burst `loombridge-capture` runner still applies; `loombridge capture` is the
focused raw path for the framing/console evidence the per-op flow used to hand-write.)

The recipe is **dispatched by the slice's `acceptance.gates`** — no per-slice flag:

- a `framing` gate → `screen-rects.json` + `console.json` (play-mode projection + camera).
- a `platform-tiles`/`tile-render` gate → `platform-tiles.json` + `tile-render.json` (via
  the allowlisted `GroundTiling.WriteTileCaptures`) + `console.json`.
- a `feel` / `feel-provenance` / `feel-rederive` / `physics-timestep` gate → `feel.json` +
  `console.json`, via the **feel recipe**: it enters play, warms up, then drives
  run / jump / the canonical short hop through `runtime.capture_input_motion`, sweeps
  coyote-time and jump-buffer over tick-indexed trials (every trial's raw echo retained),
  and measures the dash through the controller seam with the input reader disabled. It
  requires a `harness.feelSeam` block in `ACCEPTANCE.json` (which component reads input,
  which fields it writes, which keys drive it) and **refuses**, naming the exact JSON to
  add, when the block is absent: it will not guess a seam. If the level has a hazard inside
  the run leg's default 10.5-unit runway, also declare
  `harness.feelSeam.runLeg` (`ticks`, and `direction: -1` when the safe ground is leftward,
  which also needs `keys.moveLeft`): the recipe drives the run leg along that runway and has
  no other way to know where the spikes are. It bounds where the harness drives, never what
  it reports. It does **not** bound the coyote calibration walk, which has to LEAVE the
  ground and so searches for the ledge on its own (its own 600-tick cap, and a named refusal
  when the declared direction has no walkable ledge). Declare
  `harness.feelSeam.fields.grounded` (the controller's public ground-probe bool) when the
  controller exposes one: it makes the coyote anchor EXACT. Without it the sweep anchors on
  the first visible descent, which on a rig whose ground probe is narrower than the collider
  fires ticks after the controller ungrounded, and the measured window is short by that much
  (TideRunner: two ticks, 0.0667s against a real 0.1000s). The written evidence names which
  anchor produced the number. Do not hand-author `feel.json`: every provenance field it carries comes from
  the op echoes, and the gates now re-derive the headline numbers from the raw evidence in
  the same file.
- a `console-clean` gate with **no** framing rects / no GroundTiling tiles (e.g. the
  `parallax` slice) → **`console.json` only**. This writes ONLY the `console-clean`
  evidence — the slice's other gates (`parallax-motion.json`, `coverage.json`,
  `render-frame.json`, `visual-artifacts.json`) come from their own capture paths
  (`runtime.probe` offset/bounds sampling for motion+coverage; the jump-burst
  `loombridge-capture` runner for the frame gates). It enters Play Mode, snapshots the
  play-enter **startup** logs after a settle, soaks a steady window, snapshots the **full**
  log, and writes BOTH phases (phase-tagged) — it does **NOT** clear the console after play
  starts, so real one-time `Awake`/`Start`/play-enter errors are still graded (clearing them
  would be a false-green). The benign "IPC transport unavailable; fallback to tcp" infra
  warning is excused by a **narrow exact-match allowlist in the `console-clean` gate**
  (`INFRA_WARNING_RE`), recorded but never build-breaking — not by hiding it at capture
  time. Use this instead of the jump-burst runner's `console.json`.

**Framing-camera check (NEW).** The `framing` gate no longer looks only at the player
rect — when the contract pins `framing.camera`, it now validates the captured camera:
orthographic projection, world position (± a small tolerance), the **authored**
`orthographicSize` (the edit-mode Camera half-height — `camera.authoredOrthographicSize` —
NOT the runtime value, which PixelPerfect overscans when the Game view isn't 16:9), and the
PixelPerfectCamera `assetsPPU` / `refResolution` / `upscaleRT` (mismatch ⇒ **fail**;
`pixelSnapping` mismatch ⇒ warn). A `screen-rects.json` with no `camera` / `pixelPerfect` /
`authoredOrthographicSize` (e.g. hand-authored) degrades those checks to **warn**
("re-capture with `loombridge capture`"), so a wrong camera can no longer pass framing as a
false green.

### Per-op manual captures (required for every state, including spawn)

For each state in the capturePack (spawn / hazard / movement / win), drive Unity into that
state and save the per-op gate captures to `.loombridge/verify/<state>/` under the exact
filenames the gates expect: `verify-manifest.json`, `ui-scan.json`, `screen-rects.json`,
`placement.json`, `coverage.json`, `reachability.json`, `platform-tiles.json`,
`objects.json`, `playability.json` (use **`loombridge capture`** above for
`screen-rects.json`, `console.json` and `feel.json`: those three have CLI producers and
must NOT be hand-authored). The **`verify-2d-game`** skill has the full
op→args→filename map. These captures satisfy `doneness`'s captureManifest *presence* check;
quality is graded by `loombridge verify` on the primary state (next step).

## 6.5. Independent hero-shot review (required for a design-targeted build)

For a build with an **approved Design Target**, `doneness` will refuse to certify unless the
verdict carries an **independent** review proving the build matches the **frozen hero-shot
image** (plan §P0.1–P0.3). Run it like a moat, not a formality:

- **Cover EVERY state in ONE consolidated review (plan §P0.4/P1.3).** Capture one play-mode
  frame per `capturePack` state into `.loombridge/verify/<state>/frames/` (spawn / hazard /
  movement / win — not spawn-only), then run a SINGLE ensemble over all of them. RUN-1 ran
  the VLM spawn-only; the consolidated single-VLM pass is now the default.
- **Do NOT grade it yourself.** Spawn **≥2 fresh-context reviewers** (Task / sub-agent tool),
  each with NO build knowledge — see `verify-2d-game/references/vlm-review.md` §"The flow".
  A build-authored self-review is exactly the RUN-1 failure (`composition-match` WARN'd then
  self-accepted); `independence.independent` must be honestly `true` with `reviewerCount ≥ 2`.
- **Compare against the IMAGE.** Hand each reviewer the bytes of `.loombridge/design/hero-shot.png`
  (not a list of contract attributes) and have them score the Group-C fidelity criteria
  (`composition-match`, `parallax-present`, `platform-tiers`, `element-placement-arc`).
- **Save ONE consolidated review at the verify root** (`.loombridge/verify/vlm-review.json`),
  referencing each frame by its state-relative path (`spawn/frames/spawn.png`, `hazard/…`).
  **Stamp the provenance** `doneness` reads: `reference.heroShotSha256`
  (= `shasum -a 256 .loombridge/design/hero-shot.png`, MUST equal the frozen
  `designTarget.pngSha256`) and `independence: { independent: true, reviewerCount: <N> }`.
- **Write the exact product-owned schema.** `criteria` must be an ARRAY of
  `{ id, status, reason, evidenceFrame }` entries. Do **not** write a custom object map
  (`criteria: { "composition-match": { verdict: "pass" } }`), do **not** use `verdict`
  instead of `status`, and do **not** add custom top-level/provenance fields. `loombridge
  doneness` validates `.loombridge/verify/vlm-review.json` and will refuse malformed reviews.

Minimal shape:

```json
{
  "reference": {
    "heroShot": ".loombridge/design/hero-shot.png",
    "heroShotSha256": "<frozen-hero-shot-sha256>"
  },
  "independence": { "independent": true, "reviewerCount": 2 },
  "frames": [
    { "id": "spawn", "path": "spawn/frames/spawn.png" },
    { "id": "hazard", "path": "hazard/frames/hazard.png" }
  ],
  "criteria": [
    {
      "id": "composition-match",
      "status": "pass",
      "reason": "Layout matches the frozen hero shot.",
      "evidenceFrame": "spawn"
    },
    {
      "id": "parallax-present",
      "status": "pass",
      "reason": "Layered background depth is visible.",
      "evidenceFrame": "spawn"
    },
    {
      "id": "platform-tiers",
      "status": "pass",
      "reason": "The level has staged tiers around the pit.",
      "evidenceFrame": "hazard"
    },
    {
      "id": "element-placement-arc",
      "status": "pass",
      "reason": "Collectibles follow the jump arc over the hazard.",
      "evidenceFrame": "hazard"
    }
  ],
  "summary": "Independent hero-shot fidelity review complete."
}
```

## 7. End in verify, then doneness — both required

`loombridge verify` today grades a single state's captures at a time. Run it against the
primary state's subdir **with `--vlm`** pointing at the unioned review; `doneness` then
enforces that **all** states' files exist AND the hero-shot fidelity holds:

```bash
# Pick the primary state per contract (for platformer-2d use `spawn`; the run grades
# spawn's gates, and doneness enforces capture-presence for every state in capturePack).
# --vlm merges the ONE consolidated multi-state review (verify root) into the verdict
# so doneness can read it; --inputs still grades the primary state's deterministic gates.
node mcp-server/dist/surfaces/cli.js verify --root . --inputs .loombridge/verify/spawn \
  --vlm .loombridge/verify/vlm-review.json --strict

# §3a freshness + hero-shot fidelity gate — the ONLY path to a "done" claim.
node mcp-server/dist/surfaces/cli.js doneness --root .
```

- **`verify`** with `--inputs <state-subdir>` reads that state's per-gate files, runs the
  Tier-1 gates, embeds `runId` + `producedAt` + the frozen `designTarget` in the verdict at
  `.loombridge/reports/build-verdict.json`, merges the `--vlm` findings under `reviewFindings`
  (advisory to the Tier-1 `status`), updates `STATE.md`'s phase, and exits non-zero on
  `fail` (or on `warn` under `--strict`).
- **`doneness`** reads `currentBuild.captureManifest` from `STATE.md` and checks every
  state-prefixed entry exists under `.loombridge/verify/`. It exits 0 only when phase is
  `verified-green` **AND** `verdict.runId === currentBuild.runId` **AND**
  `verdict.producedAt` is on/after `currentBuild.startedAt` **AND** every
  `captureManifest` entry is present and safe **AND** — for a design-targeted build — the
  verdict's `reviewFindings` references the frozen hero shot (`reference.heroShotSha256 ===
  designTarget.pngSha256`), is independent (`independent` + `reviewerCount ≥ 2`), and every
  Group-C fidelity criterion is `pass` (plan §P0). A flat/divergent build like RUN-1's now
  exits 1 here.

If `doneness` returns non-zero, the build is **not done**. Read its listed reasons, fix
them (re-run capture for the missing state, re-verify, or re-run `build` to mint a fresh
runId for a fix-to-green pass), then run `doneness` again. **Never claim success without a
`doneness=0`** — that is the moat.

> **Known limitation (M2 follow-up).** Today `loombridge verify` grades a single state per
> invocation. `doneness` enforces capture *presence* for every state in the capturePack,
> but multi-state quality *aggregation* (running verify per state and merging verdicts) is
> deferred.

### Asset handoff consistency (when applicable)

If `.loombridge/handoff/<genre>-asset-prepare-report.json` exists from the asset-prep step,
also run the consistency check — catches stale handoff prose, `registryAssets.used=false`
contradictions, and asset-id drift between the prepare report and the verdict:

```bash
node mcp-server/dist/capabilities/assets/handoff-consistency.js \
  --prepare-report .loombridge/handoff/<genre>-asset-prepare-report.json \
  --verdict .loombridge/reports/build-verdict.json \
  --output .loombridge/handoff/asset-handoff-consistency.json
```

## 8. Finish with a real user handoff

Every `/loombridge:build` turn must end in one of these states:

- **Verified slice awaiting approval:** summarize what changed, cite the green gates, print
  the developer-facing `Next:` action, and ask an explicit approval question. Do not
  auto-approve.
- **Blocked / failed verification:** list the failing gate(s), print the next fix action,
  and ask whether to fix now or hold.
- **Approved / advanced:** report the approved slice and the next unblocked slice, then
  print `Next: run /loombridge:build or say continue.`

Do not end with only `Approve <slice>?` as prose. The product experience should keep the
developer engaged with a concrete question and a clear next action.
