---
description: Run a complete demo build from a prepared brief bundle through plan, build, capture, verify, and doneness
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(node:*), Bash(loombridge:*), Bash(scripts/*), Bash(ls:*), Bash(cat:*), Bash(test:*), mcp__loombridge__*
---

# loombridge e2e

Run a **demo workflow wrapper**, not a third product verb. The public product remains
`loombridge plan` + `loombridge build`; this wrapper is for prepared demos where the brief,
assets, hero shot, and expected capture states are already bundled.

## Input

Require a bundle path from the user. If absent, ask for it. The bundle should contain:

```text
demo-bundle/
  GAME_BRIEF.md              # required: product/game brief
  run.json                   # required: genre, engine, project, capture pack, options
  design/
    hero-shot.png            # required: frozen visual target
    hero-shot.html           # optional: annotated editable source
    annotation-patch.json    # optional until schema extraction ships
  assets/
    registry.json            # optional: bundle-local registry
    prepared-assets.json     # optional: deterministic prepare report
  acceptance.overrides.json  # optional: patch/overrides to apply after plan
  feel-preset.json           # optional: explicit feel metrics
```

`run.json` minimum shape:

```json
{
  "genre": "platformer-2d",
  "engine": "unity",
  "projectName": "demo-e2e",
  "capturePack": ["spawn", "hazard", "movement", "win"],
  "showWork": true,
  "efficiency": "bulk"
}
```

## Process

1. **Validate bundle shape.** Confirm `GAME_BRIEF.md`, `run.json`, and
   `design/hero-shot.png` exist. Read `run.json`; default `genre=platformer-2d`,
   `engine=unity`, `efficiency=bulk` only if omitted.

2. **Prepare the project.** Use the selected/current Unity project.

   For an OUTSIDE-repo consumer project, ensure the Loombridge bridge is embedded into its
   `Packages/` first (Tests/ excluded — the embedded `Tests/Editor` asmdef breaks consumer
   compile with CS0246):

   ```bash
   loombridge-embed-bridge --project <unity-project-dir>
   # then open/reload the project in Unity so the MCP bridge compiles + connects
   ```

   If the bundle declares asset prep and a project path, run the existing asset-layer prepare
   script; otherwise record what assets are already staged. Do not invent unstaged art when
   the bundle claims assets are provided.

3. **Plan through the real CLI.**

   ```bash
   node mcp-server/dist/surfaces/cli.js plan --genre <genre> --engine <engine> --root .
   ```

   `plan` hard-gates on an approved Design Target by default. The first call exits non-zero
   when no target is approved yet; that exit IS the cue to run step 4 and re-run `plan`.

4. **Set and approve the provided hero shot.**

   ```bash
   node mcp-server/dist/surfaces/cli.js design set \
     --root . \
     --image <bundle>/design/hero-shot.png \
     [--html <bundle>/design/hero-shot.html] \
     --mode provided

   node mcp-server/dist/surfaces/cli.js design approve --root . --note "approved from e2e bundle"
   ```

   Re-run `plan` with the same genre/engine. It must pass the Design Target gate before build.

   **3D bundles:** the provided image is a 2D composition mock, not a final hero shot — set it
   with `--kind composition-reference` so it unlocks scene assembly without being frozen as the
   hero shot. After the scene is built and captured, freeze the real Unity frame with
   `design set --image <unity-frame>.png --kind rendered-unity-frame --approve`; `doneness`
   refuses to certify until the Design Target is a frozen `rendered-unity-frame`. Flat-2D
   bundles omit `--kind` (the default `rendered-unity-frame` — the mock IS the final hero shot).

5. **Apply optional contract inputs.** If the bundle has `annotation-patch.json`,
   `acceptance.overrides.json`, or `feel-preset.json`, apply them using the product-owned
   schema/patch tools once they exist. Until then, surface them as manual follow-up inputs and
   do not silently edit `ACCEPTANCE.json` with ad hoc string manipulation.

6. **Build through the real build wrapper.** Use the brief as the intent. `loombridge build`
   gates preconditions (contract + approved Design Target by default; the
   `--allow-ungrounded-prototype` escape is loud and disqualifies the run from `doneness`),
   then mints `currentBuild` (`runId` + `startedAt` + a `captureManifest` derived from the
   contract's `capturePack`). Prefer efficient Loombridge paths: generated editor builder or
   `ops.batch`, sparse Show Work pulses, one-shot capture sequence, and minimal per-object
   round trips.

   ```bash
   node mcp-server/dist/surfaces/cli.js build "$(cat <bundle>/GAME_BRIEF.md)" --root .
   ```

   Record the printed `runId` — it binds the verdict to this build. Do not hand-roll a
   second e2e build pipeline in this wrapper.

7. **Capture required states** into `.loombridge/verify/<state>/`. The bundled platformer
   scenario is a single jump-burst from `/Player` at spawn — it does NOT drive Unity to
   hazard / movement / win. Use it once for the primary state's motion burst, then drive
   Unity into the other states manually and use per-op MCP captures. The
   **`verify-2d-game`** skill has the full op→args→filename map; in short:

   ```bash
   # Speed path — only writes spawn + jump-burst (visual-artifacts, render-frame, console-clean
   # gates + frames). Does NOT cover hazard/movement/win.
   node mcp-server/dist/capabilities/verification/capture-runner.js \
     --acceptance .loombridge/ACCEPTANCE.json \
     --out .loombridge/verify/spawn
   ```

   Then for each state in `capturePack`, drive Unity into that state and save the per-op
   gate captures (`verify-manifest.json`, `ui-scan.json`, `screen-rects.json`,
   `placement.json`, `coverage.json`, `reachability.json`, `platform-tiles.json`,
   `objects.json`, `playability.json`, `feel.json`) into the matching
   `.loombridge/verify/<state>/` subdir. **Also capture one play-mode game frame per state**
   into `.loombridge/verify/<state>/frames/<state>.png` — the consolidated hero-shot review
   (step 8) reads every state's frame, not spawn only. These captures satisfy `doneness`'s
   captureManifest *presence* check; their *quality* is graded by `loombridge verify` on the
   primary state only (today's limitation — see "Known limitation" in [`build.md`](build.md) §7).

8. **Run the independent hero-shot review (REQUIRED for a design-targeted demo).** The bundle
   approved a hero shot (step 4), so `doneness` enforces the §P0 fidelity moat: it refuses
   unless the verdict carries an INDEPENDENT review proving the build matches the **frozen
   hero-shot IMAGE**. Do NOT grade it yourself — spawn **≥2 fresh-context reviewers** (Task /
   sub-agent), each given ONLY the bytes of `.loombridge/design/hero-shot.png` + the per-state
   frames + the rubric, and have them score the structural fidelity criteria
   (`composition-match`, `parallax-present`, `platform-tiers`, `element-placement-arc`). Union
   into ONE consolidated `.loombridge/verify/vlm-review.json` referencing each state's frame by
   its relative path, and stamp the provenance `doneness` reads:

   - `reference.heroShotSha256` = `shasum -a 256 .loombridge/design/hero-shot.png` (MUST equal
     the frozen `designTarget.pngSha256`), and
   - `independence: { independent: true, reviewerCount: <N≥2> }`.

   Full recipe + adversarial prompt: [`build.md`](build.md) §6.5 and the **`verify-2d-game`**
   skill's `references/vlm-review.md`.

9. **Verify, then doneness — both required.**

   ```bash
   # verify grades the primary state's gates; --vlm merges the ONE consolidated multi-state
   # review (verify root) so doneness can read it.
   node mcp-server/dist/surfaces/cli.js verify --root . --inputs .loombridge/verify/spawn \
     --vlm .loombridge/verify/vlm-review.json --strict
   node mcp-server/dist/surfaces/cli.js doneness --root .
   ```

   `doneness` is **mandatory**, not optional: it is the §3a freshness predicate and the only
   path to a "done" claim. It exits 0 only when phase is `verified-green` AND
   `verdict.runId === currentBuild.runId` AND `verdict.producedAt` is on/after
   `currentBuild.startedAt` AND every entry in `captureManifest` is present (and safe —
   path-traversal entries are refused) **AND — for this design-targeted demo — the verdict's
   `reviewFindings` references the frozen hero shot, is independent (≥2 reviewers), and passes
   every structural fidelity criterion** (§P0). A green Tier-1 with no independent review
   still fails `doneness` — that is the moat, not a bug.

   If `doneness` returns non-zero, the demo is NOT complete. Read its listed reasons, fix
   them (re-run capture, re-run the review, re-verify, or re-run `build` to mint a fresh
   `runId` if the previous one is contaminated), and run `doneness` again. Never claim demo
   success from command prose without a 0 exit from `doneness`.

## Output

Report the paths to:

- `.loombridge/STATE.md`
- `.loombridge/reports/build-verdict.json`
- `.loombridge/verify/`
- `.loombridge/replays/traces/`

Keep the final answer honest: this wrapper is successful only if the real plan/build/verify
pipeline produced the proof artifacts. It must never claim demo success from command prose
alone.
