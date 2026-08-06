# Asset Priority (canonical)

Asset selection is a **first-class pipeline stage**, not an afterthought during scene
assembly. Every Loombridge build — 2D *and* 3D — resolves each required asset role through
this priority order. The order is the same for every genre; only the profile/registry
inputs differ.

## The order

1. **Local registry / profile fixtures and generated assets (the default path).**
   The checked-in `asset-layer/registry/*.json` + `asset-layer/profiles/*.json` packs, plus
   assets generated from the approved hero-shot annotations, are the default source for every
   role. They need no network, no account, and no configuration, so a build is reproducible
   from the repo alone and an **offline** or air-gapped run is the normal case, not a special
   mode. Bind them through `loombridge assets registry-plan` / `registry-apply` (with
   `--registry <local-registry.json>`) or `generated-plan` / `generated-apply`.

2. **Hosted Loomtide catalog (OPTIONAL accelerator, read-only).**
   A developer may choose to source roles from the hosted catalog instead. It is a
   convenience, never a requirement: nothing in Loombridge needs it, and every gate works
   with it unreachable or never configured. From this build it is **read-only**: there is no
   upload or publish path.
   - **Humans browse + approve** candidates at the web store: **https://assetstore.loomtide.ai/**
   - **The CLI reads a hosted search API** via `--catalog-api <baseUrl>` (the CLI appends
     `/v1/assets/search` and `/v1/packs/<id>/assets`), or a shard directory / `.jsonl` file via
     `--catalog <url>`. `LOOMBRIDGE_ASSET_CATALOG_URL` is the no-flag default for `--catalog`:
     with no `--registry` / `--catalog` / `--catalog-api` passed, the verbs read it, and with it
     unset they refuse by name. **The endpoint is configuration,
     never a baked-in default, and this repo does not name a deployment.** The current base
     URL is published alongside the asset store. The web store at `assetstore.loomtide.ai`
     is a human surface and serves `/api/...`, **not** `/v1/...`, so it is **not** the
     `--catalog-api` base: do not pass it there.

   When a developer opts in, query the catalog per role, present candidates grouped by role,
   get explicit approval, then bind them into `.loombridge/ASSET_MANIFEST.json` through the
   same deterministic `registry-plan` / `registry-apply` helpers.

3. **Online discovery / web search (only when no suitable asset exists in the chosen source).**
   If, and only if, neither the local registry nor the developer's chosen catalog has a
   candidate that fits a role, search the web for a license-clean (CC0 preferred) asset. A
   newly found asset may **not** be promoted into the manifest until its evidence is captured
   (see *Promotion evidence* below) and the developer approves it. Until then keep that role's
   manifest `status` at `needed` (or `placeholder`) and note the rationale "registry-missing"
   (no registry candidate).

4. **NEVER: placeholder primitives as final assets.**
   `GameObject.CreatePrimitive` cubes/spheres/quads and procedural fills are **construction
   scaffolding only**, acceptable while wiring a scene before assets land, or as an
   explicitly recorded placeholder. They are **never** a final-ship asset for a role that has
   an approved registry (or discovered-and-approved) asset. A role left on a primitive at
   doneness time must carry manifest `status: "placeholder"` (with a "registry-missing"
   rationale when no candidate exists), never silently shipped as if it were the chosen
   art.

> **Manifest `status` is a closed set: `approved | needed | placeholder`.** "registry-missing"
> is a human-readable *rationale* for why a role has no candidate, and it is **not** a
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
- A **role binding rationale**: which manifest role it fills and why no registry candidate fit
  (the "registry-missing" rationale for that role; the manifest `status` stays
  `needed`/`placeholder` until the asset is ingested + approved).

Only `loombridge assets registry-apply` / `generated-apply` may write an approved manifest
binding. Never hand-edit `.loombridge/ASSET_MANIFEST.json` to `approved`, and never call
`selectAssets` as the approval source (it is a silent best-match helper).

## Why this order

Loombridge has **no cloud requirement** (see `Docs/Design/Positioning.md`), so the default
path has to be the one that works with no network and no account: the committed registry
packs and generated assets. They are license-verified, sha-pinned, and reproducible from the
repo alone. The hosted catalog is a genuine accelerator, curated and agent-retrievable at a
scale no committed pack can match, which is exactly why it is offered as a choice rather than
imposed as a default. Web discovery is a controlled escape hatch, not a shortcut. Primitives
certify nothing: shipping one as final art certifies against a fiction.

**Whichever source a developer picks, the enforcement is identical.** License policy, source
verification, sha256 checksums, trust tiers, and the human approval checkpoint all run on the
same code path, so choosing local over hosted costs nothing in rigor.

## See also

- `ARCHITECTURE.md` ("Public Hosted Asset Catalog") — the hosted catalog architecture + API contract.
- `Docs/Assets/PublicCatalogQuickstart.md` — external quickstart against the public catalog.
- `commands/loombridge/plan.md` — the asset strategy stage (registry-plan / registry-apply).
- `commands/loombridge/build.md` — manifest-driven scene assembly (read the manifest first).
- `.skills/asset-layer/SKILL.md` — the full prepare/validate/import flow incl. 3D path.
