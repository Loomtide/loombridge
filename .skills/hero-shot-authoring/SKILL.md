---
name: hero-shot-authoring
description: Produce and approve the Design Target (annotated hero shot) that `loombridge plan` blocks on, choosing a mode with the user (paste a reference, generate with this agent, generate with codex, or copy a reference game) and stamping the right `--kind`. Use when `loombridge target status` is not `approved`, when `plan` exits non-zero on the §3c Design Target gate, or when a 3D build needs its frozen hero shot captured from the assembled scene.
---

Use this skill to get from "no Design Target" to "approved, correctly stamped hero shot". This is
the first hard wall in the build loop: `plan` exits non-zero until an approved frozen hero shot
exists, and `doneness` later grades final fidelity against whatever got frozen here.

The hero shot is not concept art. It is the visual contract the build is graded against, so it must
show assets that will actually exist. The single most expensive mistake in this whole flow is
freezing the WRONG KIND of image, which is silent, passes every gate, and quietly certifies the
build against a picture the game can never match.

## Inputs (gather before Stage 1)

- `loombridge target status --root .` output (is it already approved?).
- Whether the game is **2D or 3D**. Loombridge does not know this: no genre contract field
  declares it. You must establish it with the user, and it decides everything in Stage 3.
- The genre's asset registry (registered pack) or the contract's `artDirection.assetRoles`
  (contract genre). The hero shot is built from assets that exist, not invented ones.
- The contract's `fidelityCriteria` list, if any. Those are the criteria `doneness` will grade,
  so they are what the annotations must call out.
- Which generation backends are available (Stage 2). Never assume; ask or detect.

## DO-NOT rules (each one is a real, silent failure)

- **Never let `--kind` default on a generated image for a 3D game.** `--kind` is absent-defaults-to
  `rendered-unity-frame`. So `target set --image hero.png --mode generated --approve` freezes a flat
  mock as the artifact `doneness` grades 3D fidelity against: no materials, no real proportions, no
  lighting, no silhouettes. Nothing refuses it. State the kind explicitly, every time, on a
  generated image.
- **Never capture the hero shot with the default screenshot view.** `unity_editor_screenshot`
  defaults to `view: 'scene'`, which captures the EDITOR's Scene view (its own camera, gizmos,
  whatever the window happens to show). A VLM review round once graded a set of skybox-and-quads
  scene-view frames as if they were the game. Pass `view: 'game'` for anything a player would see.
- **Never put concept art in the hero shot.** If an asset in the frame does not exist and is not on
  the manifest, the build cannot match it, and every fidelity check against it fails forever.
- **Never approve without showing the user.** This is the one human checkpoint in the flow that
  earns its cost. `set --approve` exists for when they have already seen it, not to skip them.
- **Never generate a 3D hero shot and stop there.** A generated 3D image is stage one of two. If you
  do not come back and capture the assembled scene, `doneness` has nothing legitimate to certify
  against.

## Stage 1: choose the mode WITH the user

Check first. If it is already approved, stop; re-seeding needs a deliberate decision.

```bash
loombridge target status --root .
```

Ask which path they want. Do not pick for them:

| Mode | When |
|---|---|
| `provided` | They have a mock, screenshot, or HTML already |
| `generated` | They want this agent (or codex) to draw it |
| `reference-game` | They want to copy a known game's look, e.g. Celeste |

## Stage 2: generation backends (offer, never assume)

Two backends can generate. **Detect and suggest; let the user choose.** They produce visibly
different art, and this is the one artifact the whole build is graded against, so a silent backend
choice is a surprise in the worst possible place.

**This agent.** Compose the frame directly (HTML/CSS at native scale, then screenshot it). Use the
`frontend-design` skill for the composition work. This is the default and needs nothing installed.

**codex.** Available only if the user has it:

```bash
command -v codex && codex --version    # verified surface: codex-cli 0.145.0
```

`codex exec` runs Codex non-interactively and takes the prompt as an argument or on stdin.
Attach reference images with `-i/--image <FILE>...`, and pick a model with `-m/--model <MODEL>`:

```bash
codex exec -i reference.png "<hero shot prompt>"
```

> **UNVERIFIED:** the exact image-production recipe used on the maintainer's Ghost Relay build is
> not yet recorded here. The CLI surface above is verified; how the image itself is produced and
> written to disk is not. Confirm with the user before relying on a specific invocation, and update
> this block with what actually ran. A plausible-looking wrong command is worse than this admission.

Whichever backend runs, keep API keys in the environment. Never in chat, commits, or reports.

## Stage 3: the fork that matters

**Neither path needs Unity at plan time.** `plan`'s readiness gate checks only that the target is
approved and still matches its freeze; it never reads the kind. So an approved
`composition-reference` clears `plan` and `build`, and only `doneness` refuses one. You are not
being asked to render anything in Unity before planning.

**`rendered-unity-frame` is a misleading name, so read it as FINAL.** It describes what the artifact
IS, the frame fidelity gets graded against, not where it came from. A flat 2D game's final mock is a
`rendered-unity-frame` with no Unity involved anywhere. The question the `--kind` refusal is really
asking is *"is this the final look, or a guide on the way to it?"*, which is a question about the
game, not about which tool drew the image.

### 3a. Flat 2D game

The generated mock IS the frozen hero shot. One stage, and `rendered-unity-frame` is correct:

```bash
loombridge target set --image hero-shot.png --html hero-shot.html \
  --mode generated --kind rendered-unity-frame
```

### 3b. 3D game (two stages, both required)

A flat image cannot represent a real 3D look, so the generated image is a composition guide only.

**Stage one, unlock assembly:**

```bash
loombridge target set --image concept.png --mode generated \
  --kind composition-reference --approve
```

This approves the composition ONLY to unlock scene assembly. It can never certify `doneness`.

**Stage two, freeze the real frame.** Assemble the scene, then capture what the player sees and
re-set as the real kind:

```
unity_editor_screenshot { view: "game", outputPath: ".loombridge/captures/hero.png" }
```

```bash
loombridge target set --image .loombridge/captures/hero.png \
  --mode provided --kind rendered-unity-frame --approve
```

Only now are hero-shot fidelity and `doneness` reachable.

## Stage 4: annotate it

An unannotated hero shot is a picture; an annotated one is a contract. Call out the things THIS
genre reads by, and make the callouts line up with the contract's `fidelityCriteria`, because those
are the ids `doneness` grades. Do not borrow another genre's callouts: parallax and platform tiers
are platformer concerns, not universal ones.

## Stage 5: show it, then approve

```bash
loombridge target approve --note "approved by <user>"
```

## What this unlocks

`plan`'s §3c gate clears, so `plan` proceeds to the asset manifest. Later, `doneness` grades the
approved Design Target against the genre's `fidelityCriteria`. A contract genre with no
`fidelityCriteria` makes `doneness` refuse any design-targeted build, so if the user is on a
contract genre, review that field with them now rather than discovering it at the end.
