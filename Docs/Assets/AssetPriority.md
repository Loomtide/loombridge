# Asset Priority (canonical)

Asset selection is a **first-class pipeline stage**, not an afterthought during scene
assembly. Every Loombridge build — 2D *and* 3D — resolves each required asset role through
this priority order. The order is the same for every genre; only the profile/registry
inputs differ.

## The order

1. **Hosted Loomtide registry (FIRST, the default).**
   The hosted catalog is the canonical source for every role.
   - **Humans browse + approve** candidates at the web store: **https://assetstore.loomtide.ai/**
   - **The CLI reads the hosted search API** via `--catalog-api`, whose base today is
     **`https://asset-api-production-59d9.up.railway.app`** (the CLI appends
     `/v1/assets/search` and `/v1/packs/<id>/assets`). The web store at
     `assetstore.loomtide.ai` is a human surface and serves `/api/...`, **not** `/v1/...`,
     so it is **not** the `--catalog-api` base — do not pass it there.

   Query the hosted catalog per role first, present candidates grouped by role, get
   explicit approval, then bind them into `.loombridge/ASSET_MANIFEST.json` through the
   deterministic `loombridge assets registry-plan` / `registry-apply` helpers.

2. **Local registry / profile fixtures (only when explicitly needed).**
   The checked-in `asset-layer/registry/*.json` + `asset-layer/profiles/*.json` packs are
   for **tests and offline/air-gapped runs** — e.g. CI, a clean-room reproduction with no
   network, or a fixture-pinned regression. Reach for them only when the run is explicitly
   offline or a test demands a frozen local pack. They are not the default for a real build.

3. **Online discovery / web search (only when no suitable hosted asset exists).**
   If — and only if — no hosted catalog candidate fits a role, search the web for a
   license-clean (CC0 preferred) asset. A newly found asset may **not** be promoted into the
   manifest until its evidence is captured (see *Promotion evidence* below) and the developer
   approves it. Until then keep that role's manifest `status` at `needed` (or `placeholder`)
   and note the rationale "registry-missing" (no hosted candidate).

4. **NEVER: placeholder primitives as final assets.**
   `GameObject.CreatePrimitive` cubes/spheres/quads and procedural fills are **construction
   scaffolding only** — acceptable while wiring a scene before assets land, or as an
   explicitly recorded placeholder. They are **never** a final-ship asset for a role that has
   an approved hosted (or discovered-and-approved) asset. A role left on a primitive at
   doneness time must carry manifest `status: "placeholder"` (with a "registry-missing"
   rationale when no hosted candidate exists), never silently shipped as if it were the chosen
   art.

> **Manifest `status` is a closed set: `approved | needed | placeholder`.** "registry-missing"
> is a human-readable *rationale* for why a role has no hosted candidate — it is **not** a
> `status` value. Do not write `status: "registry-missing"` into `ASSET_MANIFEST.json`; the
> validator rejects it (`INVALID_ASSET_STATUS`). Use `needed`/`placeholder` for the status and
> record "registry-missing" as the note.

## Promotion evidence (before a discovered asset enters the manifest)

A web-search/discovered asset is promoted **only** after all of the following are captured
and shown to the developer for approval:

- **Source URL** + **provider** + **download page**.
- **License** is allowed (CC0-1.0 preferred); license URL recorded. CC-BY requires an
  explicit attribution decision.
- **Checksum** (`sha256`) of the downloaded file, recorded in the manifest/provenance.
- A **role binding rationale** — which manifest role it fills and why no hosted candidate fit
  (the "registry-missing" rationale for that role; the manifest `status` stays
  `needed`/`placeholder` until the asset is ingested + approved).

Only `loombridge assets registry-apply` / `generated-apply` may write an approved manifest
binding. Never hand-edit `.loombridge/ASSET_MANIFEST.json` to `approved`, and never call
`selectAssets` as the approval source (it is a silent best-match helper).

## Why this order

The hosted registry is curated, license-verified, sha-pinned, and agent-retrievable, so it is
the honest default. Local fixtures exist so tests and offline runs stay deterministic. Web
discovery is a controlled escape hatch, not a shortcut. Primitives certify nothing — shipping
one as final art certifies against a fiction.

## See also

- `ARCHITECTURE.md` ("Public Hosted Asset Catalog") — the hosted catalog architecture + API contract.
- `Docs/Assets/PublicCatalogQuickstart.md` — external quickstart against the public catalog.
- `commands/loombridge/plan.md` — the asset strategy stage (registry-plan / registry-apply).
- `commands/loombridge/build.md` — manifest-driven scene assembly (read the manifest first).
- `.skills/asset-layer/SKILL.md` — the full prepare/validate/import flow incl. 3D path.
