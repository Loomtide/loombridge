---
description: Scaffold .loombridge/ and establish the design target + acceptance contract for a genre
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, WebSearch, WebFetch, Bash(node:*), Bash(loombridge:*), Bash(ls:*), Bash(cat:*)
---

# loombridge plan

Establish the **design target** the build will be measured against, then **scaffold the
asset manifest** that slices will consume, then **scaffold the slice roadmap** (the ordered,
dependency-aware slice DAG the game is built from, one polished slice at a time). `plan` is
**state-driven**: it prints a read-only status echo, then dispatches by `.loombridge/` state —
establish the design target, record/approve the asset strategy, scaffold the roadmap, or
announce the next slice to build. This command is the canonical instruction for both Claude
Code (`/loombridge:plan`) and Codex (`scripts/loombridge-plan`) — there is one source of truth,
so the two agents cannot drift.

## Process

1. **Scaffold the contract + check readiness (deterministic).** Run the CLI **zero-param**
   — the developer just runs `loombridge plan` from the project root; the engine is **auto-detected**
   and the genre is **inferred** (there is a single genre pack today):

   ```bash
   loombridge plan
   ```

   This seeds `ACCEPTANCE.json` (from the genre template), `FEEL_SPEC.json`,
   `GAME_SPEC.md`, the `design/` folder, and `STATE.md`, then **checks the §3c Design
   Target gate** and the asset-manifest gate — by default `plan` exits non-zero until an
   approved + frozen hero shot exists, then exits non-zero until `.loombridge/ASSET_MANIFEST.json`
   is approved. **You don't need a flag**; the exit code is the cue to run step 3 and 4 below.
   (`--force` re-seeds; `--allow-missing-design-target` is an escape hatch for early
   scaffolding only — `build` will still block.)

   **ASK THE DEVELOPER WHEN UNCLEAR (agent layer — the CLI never prompts).** The CLI is
   deterministic: it auto-detects the engine (Unity via `ProjectSettings/ProjectVersion.txt`)
   or errors. Handle its errors by asking, then re-running:

   - If `plan` errors that it **could not detect a game engine project** (exit 2), ask the
     developer to confirm they're in a project root, or which engine they're targeting, then
     re-run with `--engine <id>` (e.g. `loombridge plan --engine unity`). Only `unity` is
     supported today.
   - If `plan` errors that it **detected a non-Unity engine** (Loombridge supports Unity only),
     tell the developer and stop — there is nothing to build here yet.
   - **Genre:** with a single genre pack, `plan` infers it silently — do NOT ask. *If* more
     than one genre pack ever exists, ask the developer which genre and pass `--genre <id>`.

2. **Read back the state.** `cat .loombridge/STATE.md` to confirm genre/engine/phase.

3. **Design Target Phase (§3c — the part that decides "feel").** `plan` is not complete
   without an **approved annotated hero shot**. Without a visual target, polish is poor — do
   NOT skip this. Check the current state:

   ```bash
   loombridge design status --root .
   ```

   If it is not `approved`, pick an input path *with the user* (ask which they want):

   - **Provide:** the user points to a mock / screenshot / HTML. Save the image, then:
     ```bash
     loombridge design set --image <path.png> [--html <path.html>] --mode provided
     ```
   - **Generate (default):** produce an **annotated hero shot built from the genre's asset
     registry** (Claude Design / frontend-design — a single in-game frame at native scale,
     with callouts for HUD / camera / parallax / juice). Screenshot it to a PNG, then:
     ```bash
     loombridge design set --image hero-shot.png --html hero-shot.html --mode generated
     ```
     Keep it to assets that actually exist (no concept art) so the build can match it.
   - **Reference game:** name a game (e.g. Celeste), research its visual + feel conventions,
     generate the hero shot in that style, **and** map it to a feel preset:
     ```bash
     loombridge design set --image hero-shot.png --mode reference-game --reference-game "Celeste"
     ```

   Then **show the hero shot to the user and get explicit approval** — this is the one human
   checkpoint that earns its cost. On approval:

   ```bash
   loombridge design approve --note "approved by <user>"
   ```

   (`set --approve` does both in one step when the user pre-approves.)

   **3D verticals — the design-target split (`--kind`).** A flat 2D mock cannot faithfully
   represent a real 3D look (materials, proportions, lighting, asset silhouettes), so for a 3D
   build the mock is a *composition guide*, not the frozen hero shot. The Design Target has two
   kinds:

   - `rendered-unity-frame` *(default)* — a **real rendered frame** of the assembled scene (a
     Unity capture; or a final mock for a flat 2D game). This is the FROZEN hero shot, the only
     kind eligible for strict hero-shot fidelity + `loombridge doneness`. Existing 2D/platformer
     flows need no change — omit `--kind` and you get this.
   - `composition-reference` — a style/composition guide approved **only to unlock 3D scene
     assembly**. It can NEVER certify `doneness` or satisfy final fidelity.

   The 3D flow is therefore five explicit steps:

   1. **Create + approve a composition reference** (the 2D mock as a guide):
      ```bash
      loombridge design set --image style-reference.png --mode generated \
        --kind composition-reference --approve
      ```
   2. **Assemble the 3D scene** with the chosen registry assets (`build`).
   3. **Capture a real Unity frame** of the assembled hero shot.
   4. **Approve/freeze the rendered frame** — this replaces the composition reference:
      ```bash
      loombridge design set --image unity-hero-frame.png --mode provided \
        --kind rendered-unity-frame --approve
      ```
   5. **Only then** run the independent hero-shot fidelity review + `loombridge doneness`.

   `loombridge design status` shows the kind; while it is a `composition-reference` it prints a
   reminder that the captured frame still has to be frozen before doneness will certify.

4. **Record and approve the asset strategy.** Before slices exist, ask the developer which
   asset source strategy they want. The asset source must never be an invisible agent choice.

   **Follow the canonical asset priority (`Docs/Assets/AssetPriority.md`) — hosted registry
   FIRST.** For every required role, resolve in this order: (1) the **hosted Loomtide
   registry** (the default); (2) **local registry/profile fixtures** only for tests or
   offline/air-gapped runs; (3) **online discovery / web search** only when no hosted asset
   fits the role; (4) **never** ship placeholder primitives as final assets when an approved
   hosted asset exists for that role. Humans browse + approve candidates at the web store
   **https://assetstore.loomtide.ai/**; the CLI reads the hosted search API via `--catalog-api`
   whose base is **`https://asset-api-production-59d9.up.railway.app`** (it appends
   `/v1/assets/search`). The web-store domain serves `/api/...`, not `/v1/...`, so it is not
   the `--catalog-api` base — do not pass it there.

   - **Registry:** use the approved hosted registry; compose/build from recorded registry assets.
   - **Generated:** generate/export assets from the approved hero-shot annotations.
   - **Hybrid:** use an approved registry base and generated/manual missing assets.

   Default to **hybrid** only after saying that default out loud and getting approval. Record
   the choice deterministically:

   ```bash
   loombridge plan --asset-mode hybrid
   ```

   This writes a **draft** `.loombridge/ASSET_MANIFEST.json` bound to the frozen hero shot. Do
   not hand-edit it to approved. Use the deterministic `loombridge assets` approval helpers so
   the candidate list, selected IDs, output paths, licenses, source metadata, and provenance
   are all produced through validated code.

   For registry roles, produce and review explicit candidates **from the hosted catalog**
   (the default — `--catalog-api`):

   ```bash
   loombridge assets registry-plan \
     --catalog-api https://asset-api-production-59d9.up.railway.app \
     --profile <asset-profile.json> \
     --preferred-license CC0-1.0 \
     --output .loombridge/reports/registry-selection-plan.json
   ```

   **Show the resulting slots/options to the developer and get explicit approval BEFORE
   applying** — the candidate list is a human checkpoint, never an auto-pick. After they
   choose, write a selections JSON object such as
   `{ "selections": { "player_character": "<candidate-id>" } }`, then apply it with an explicit
   approval timestamp:

   ```bash
   loombridge assets registry-apply \
     --catalog-api https://asset-api-production-59d9.up.railway.app \
     --profile <asset-profile.json> \
     --selections .loombridge/reports/registry-selections.json \
     --approved-at "<ISO timestamp>"
   ```

   **Offline / test runs only:** swap `--catalog-api <baseUrl>` for `--registry
   <local-registry.json>` to read a checked-in `asset-layer/registry/*.json` fixture instead of
   the hosted catalog (priority order step 2 — air-gapped CI or a fixture-pinned reproduction).
   Do not default to a local registry for a real build when the hosted catalog is reachable.

   If the developer selected assets in the web asset browser, apply its exported
   `selection.json` through the same manifest approval path:

   ```bash
   loombridge assets registry-apply \
     --catalog-api https://asset-api-production-59d9.up.railway.app \
     --profile <asset-profile.json> \
     --from-selection <web-selection.json> \
     --approved-at "<ISO timestamp>"
   ```

   `--from-selection` maps each item to a manifest slot by exact manifest role
   first, then by primitive only when the role is a browser-default primitive.
   Ambiguous items, duplicate slot bindings, unknown `registryId`s, invalid
   candidates, unmatched items, and unfilled registry slots are refused before
   `.loombridge/ASSET_MANIFEST.json` is written. Use `--strict-roles` to disable
   primitive fallback and require exported roles to be manifest roles.

   For generated roles, annotate the hero shot by required asset role, export game-ready
   sprites/backgrounds/tiles, and use the generated path:

   ```bash
   loombridge assets generated-plan \
     --annotations .loombridge/reports/generated-annotations.json \
     --output .loombridge/reports/generated-asset-plan.json

   loombridge assets generated-apply \
     --annotations .loombridge/reports/generated-annotations.json \
     --exports .loombridge/reports/generated-exports.json \
     --approved-at "<ISO timestamp>"
   ```

   Hybrid mode uses the same helpers for the relevant registry and generated roles. Do not
   leave a role as `"needed"` and then let a later slice search the registry. Never call
   `selectAssets` as the approval source for a manifest; it is a silent best-match helper.
   Do not scaffold slices while the manifest is missing, draft, or invalid. If a slice later
   needs an asset not listed/bound in the manifest, stop and update the manifest through the
   asset approval helpers; do not search the registry silently.

5. **Confirm design + asset readiness and roadmap.** Re-run **bare** `plan` (no flags):

   ```bash
   loombridge plan
   ```

   Once the Design Target is approved + frozen and `ASSET_MANIFEST.json` is approved,
   `plan` automatically scaffolds the ordered slice roadmap if it is missing, then announces
   the first slice. There is no extra roadmap flag for the developer to remember. After the
   roadmap exists, bare `plan` is a status echo that announces the next slice or approval seam.

6. **Build slice by slice.** Tell the user `plan` is complete when the design target is locked,
   `.loombridge/ASSET_MANIFEST.json` is approved, `.loombridge/SLICES.json` exists, and `plan` has
   announced the next unblocked slice. The build
   proceeds **one slice at a time** — review the announced slice, then run `loombridge build` to
   build it; each slice is verified + human-approved before `plan` advances to the next.
   Re-running bare `plan` after a slice is built but not yet approved echoes the approval seam
   (`Approving <slice> … — ok?`). **Do not ask the developer to remember `--go`.** Ask them
   whether to approve; if they say yes, you run the internal deterministic approval command
   `loombridge plan --go` yourself, then report the next unblocked slice. If they do not approve,
   stop without mutation.
   Use the available user-question tool here rather than ending with a passive summary:
   ask `Approve <slice-id> and advance to <next-slice-id>?` with `Approve & advance`
   (recommended), `Hold`, and, when useful, `Request changes`. Always preserve the CLI's
   developer-facing `Next:` line in the response.
   For read-only progress without any scaffold/state mutation, run `loombridge status`.

For local dogfooding from the Loombridge repo before installing the CLI, the equivalent command is
`node mcp-server/dist/surfaces/cli.js <subcommand>`.
