# Visual perception model path

This is a companion to `vlm-review.md`. The VLM pass is useful for qualitative
fresh-eyes review, but developers also need structured visual evidence: what is
in the screenshot, where it is, whether it overlaps, whether required UI is in a
safe area, and whether the frame has obvious render artifacts. That should not
depend on an agent writing prose from vibes.

The intended path is:

1. capture live Play Mode frames;
2. extract deterministic image facts and model-grounded visual facts;
3. compare those facts to the game's contract;
4. reserve VLM prose review for advisory long-tail judgment, unless a contract
   explicitly opts into a blocking semantic review.

This matches the S6 position: deterministic gates decide CI pass/fail; VLM
review is advisory by default.

## What developers need

For visual verification, the useful output is not "the image looks good." The
useful output is an auditable artifact:

- required elements detected, counted, and localized;
- required UI text OCR'd and localized;
- safe-area, clipping, overlap, and tap-target facts;
- black bars, clear-color exposure, seams, uniform bands, and palette drift;
- baseline comparison against approved frames, with masks for dynamic regions;
- confidence and provenance per fact.

The report can still show screenshots and overlays, but pass/fail should come
from structured facts where possible.

## Recommended layers

### 1. Deterministic image gates

Use cheap, reproducible image processing before any model:

- black-border / letterbox detection;
- uniform band and exposed clear-color detection;
- obvious seam or long-line artifact detection;
- palette role comparison;
- perceptual hash / SSIM / LPIPS-style baseline diff;
- OCR for HUD labels where the text is contract-declared;
- Unity-side object, UI, sorting-layer, collider, and camera-frame facts.

These should remain Tier-1 candidates because they are repeatable and can point
to a specific state/object/control.

### 2. Open-vocabulary grounding

Use a vision model to produce boxes, masks, OCR regions, labels, and counts.
Then let Loomtide grade those outputs against the contract.

Good questions:

- "Find the player."
- "Find the reward button."
- "Find every hazard."
- "Find the score label."
- "Find the object matching the mock's large green start button."

Bad question:

- "Does this game look correct?"

The first set creates evidence. The last one creates an opinion.

### 3. Advisory VLM review

Use `vlm-review.md` for qualitative review of composition, style, readability,
and the perceptual long tail. Keep it independent, adversarial, and unioned.
Do not fold it into Tier-1 status unless the game contract explicitly marks a
semantic criterion as blocking.

## Candidate model stack

### Florence-2

Best first local candidate for Loomtide experimentation.

Why:

- compact open model family;
- supports prompt-driven captioning, object detection, grounding,
  segmentation-style outputs, and OCR-style tasks;
- useful for a local `visual-perception.json` producer without relying on a
  cloud model.

Use it to populate detections, labels, regions, and OCR-like facts. Treat its
outputs as model evidence with confidence, not as final pass/fail.

References:

- https://huggingface.co/microsoft/Florence-2-base
- https://arxiv.org/abs/2311.06242

### GroundingDINO + SAM 2

Best open pipeline when precise localization matters.

GroundingDINO is useful for text-conditioned open-set detection: "find the
player", "find the red hazard", "find the start button." SAM 2 is useful for
turning boxes/points into masks and for tracking segmented objects across
frames.

Use this stack for placement, occlusion, masks, object visibility, and
state-to-state tracking. It is heavier than Florence-2 but often produces more
useful geometry.

References:

- https://github.com/IDEA-Research/GroundingDINO
- https://ai.meta.com/sam2/

### YOLO / RT-DETR-style detectors

Best later-stage regression model.

These are fast and reliable once the label space is known, but they are not the
right first tool for arbitrary mock comparison. They become valuable after
Loomtide has collected and labeled common mini-game categories:

- player;
- collectible;
- obstacle;
- reward;
- home/back button;
- score label;
- win modal;
- fail modal.

Use this for suite-scale release verification once a studio's visual taxonomy is
stable.

### Moondream / Qwen-VL / InternVL / Molmo-class models

Useful as smaller or open-weight multimodal reviewers and grounding assistants.
Prefer models that expose structured grounding skills: boxes, points, masks, or
OCR regions. Avoid relying on free-form chat output for blocking decisions.

Moondream is worth tracking because its public positioning emphasizes grounded
skills such as detection, pointing, captioning, visual Q&A, and segmentation.

Reference:

- https://moondream.ai/p/models

### Gemini

Good cloud oracle for image understanding, object detection, segmentation, and
model-disagreement studies. It can be useful as an independent advisory reviewer
or as a benchmark while evaluating local model quality.

Use it when privacy/cost policy allows cloud review. Keep the same rule:
structured outputs feed deterministic grading; prose is advisory unless the
contract says otherwise.

Reference:

- https://ai.google.dev/gemini-api/docs/vision

## Proposed artifact

The model worker should emit a structured artifact per frame:

```json
{
  "frame": "success_reward",
  "sourceImage": "success_reward/frames/success_reward.png",
  "imageFacts": {
    "blackBorderFraction": 0,
    "uniformBandFraction": 0.01,
    "contentRect": [0, 0, 1280, 720]
  },
  "detections": [
    {
      "id": "det-001",
      "label": "reward button",
      "bbox": [906, 548, 1168, 632],
      "confidence": 0.88,
      "source": "florence-2"
    }
  ],
  "ocr": [
    {
      "text": "You did it!",
      "bbox": [438, 88, 790, 142],
      "confidence": 0.93,
      "source": "florence-2"
    }
  ],
  "masks": []
}
```

Suggested path:

```text
.loomtide/verify/<state>/visual-perception.json
```

For a consolidated multi-state run:

```text
.loomtide/verify/visual-perception.json
```

with `frames[]` entries keyed by state/frame id.

## Contract comparison

The contract should declare expected visual facts in terms Loomtide can grade:

```json
{
  "state": "success_reward",
  "mustContain": [
    {
      "id": "reward-button",
      "label": "reward button",
      "region": "bottom-right",
      "minConfidence": 0.75,
      "tapTargetMinPx": [96, 96]
    },
    {
      "id": "success-message",
      "ocrContains": "You did it",
      "region": "top-center"
    }
  ],
  "mustNotContain": [
    { "label": "black border" },
    { "label": "overlapping required controls" }
  ]
}
```

The gate should report:

- `pass` when required facts are present and inside thresholds;
- `fail` when a required fact is absent, offscreen, clipped, overlapped, too
  small, or text-mismatched;
- `warn` when a model-dependent fact is low-confidence but not decisive;
- `not_measured` when the model worker did not run or a provider is unavailable.

## S6 implementation recommendation

Prototype in this order:

1. Add a `visual-perception.json` schema and pure gate evaluator.
2. Add deterministic image facts using local image processing.
3. Add a Florence-2 adapter as the first local model worker.
4. Add overlay output for boxes, OCR regions, safe-area violations, and diffs.
5. Add optional GroundingDINO + SAM 2 for stronger localization/masks.
6. Use Gemini only as an optional cloud oracle for advisory review and
   disagreement studies.
7. Fine-tune or train YOLO-style detectors later when real mini-game screenshots
   and labels exist.

The first proof should be one selected mini-game, 3-5 states, one approved
baseline, and one negative fixture where a required element is missing,
offscreen, clipped, or overlapped. The negative fixture must fail without a VLM
opinion.

## Non-goals

- Do not claim generic "visual correctness" from pixels alone.
- Do not make a model's prose a Tier-1 blocker by default.
- Do not require cloud review for the normal verification path.
- Do not train a detector before the studio's category taxonomy and screenshots
  exist.
- Do not hide model uncertainty; every model-derived fact needs a source and
  confidence.

