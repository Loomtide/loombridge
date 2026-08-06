# RFC: The asset-registry OSS boundary

**Status:** PROPOSED. **Date:** 2026-08-06.
Inherits from [Positioning.md](Positioning.md). Decision recorded: the hosted asset registry
STAYS as an option, is documented openly in the OSS repo, and is READ-ONLY from the open build.

## What is already correct

An audit found the hardest requirement already met, and met well. Recording it here so the next
person does not rebuild it, and so the guards below know what they are protecting.

- **The authoring verbs are on the private side of a real split.** `pack-ingest`, `cover-build`,
  and `discover` are implemented in `src/asset-authoring/assets-authoring-cli.ts`, which is
  genuinely absent from this repo. The seam uses a `string`-typed module specifier rather than a
  literal import, so the open build compiles with no reference to the private sources.
- **Verified empirically, not from the comment.** Both `assets pack-ingest` and
  `assets pack-ingest --apply --source-root <dir>` (the byte-publishing path) exit 1 with
  "require the private asset-authoring tooling, which is not present in this build".
- **The read path is read-only.** There are ZERO non-GET HTTP calls anywhere in
  `capabilities/assets/`: no POST, PUT, PATCH, or DELETE. `http-auth.ts` handles a GitHub token
  for FETCHING registry files, never a credential for writing to the registry.
- **The catalog endpoint is not hardcoded in code.** `catalog-source.ts` requires
  `LOOMBRIDGE_ASSET_CATALOG_URL` or an explicit `--catalog` / `--catalog-api`, and refuses with a
  named error when neither is set. There is no source-level default pointing at any host.

So an OSS consumer cannot upload, cannot publish bytes to R2, and cannot mutate the catalog.

## The problem

**Every one of those properties is accidental tomorrow, because nothing walks any of them.**
That is this repo's most expensive recurring failure shape, and here it guards a security
boundary rather than a report. Nothing fails if someone vendors the private module, converts the
seam to a literal import, adds a write method to the catalog client, or introduces a hardcoded
endpoint default.

Three narrower problems sit on top:

1. **The help text advertises what the open build cannot do.** `loombridge assets --help` prints
   `Pack ingest (add a new pack to the hosted registry)` and `--apply publishes bytes to R2
   (default dry-run)`. In an open build that documents a private publish mechanic and offers a
   capability that always fails.
2. **Infrastructure detail sits in public files.**
   `asset-layer/schemas/asset-pack-manifest.schema.json` states the R2 key convention verbatim
   ("the packId is the binding R2-key convention: provider.genre.slug maps 1:1 to the R2
   directory provider/genre/slug") and names `src/asset-authoring/pack-ingest.ts`. Separately,
   the production catalog-API hostname (a PaaS deployment host) appears in seven files:
   `ARCHITECTURE.md`, `mcp-server/README.md`, `Docs/Assets/AssetPriority.md`,
   `Docs/Assets/PublicCatalogQuickstart.md`, `commands/loombridge/plan.md`,
   `.skills/asset-layer/SKILL.md`, and a test that ASSERTS it. It is prose-only in the
   TypeScript sources, which makes it cheap to fix and embarrassing to leave.

   **Corrected on contact with the code (2026-08-06):** there is an EIGHTH occurrence, and it
   is a real code default, not prose. `packages/com.loomtide.loombridge/Editor/UI/`
   `LoombridgeAssetBrowser.cs` held the hostname in a `DefaultApiBaseUrl` constant. The
   §1 endpoint guard only scans `mcp-server/src`, so the Unity package was outside it.
3. **"Hosted registry FIRST" contradicts Positioning.md.** The positioning doc lists as a
   permanent non-goal: "No cloud requirement. Core CLI and bridge run fully local; the hosted
   asset catalog is an optional, read-only convenience." But `Docs/Assets/AssetPriority.md` makes
   the hosted registry "FIRST, the default", the plan wizard offers it as the recommended
   default, and `asset-priority-docs.test.ts` ENFORCES that wording. Optional convenience and
   recommended default are not the same claim, and the test currently locks in the wrong one.

## The changes

### 1. Guard the read-only boundary (the load-bearing one)

A guard suite asserting, for the OPEN build:

- `src/asset-authoring/` is absent from this repo;
- the authoring seam is NOT a resolvable literal import (so no bundler or `tsc` can pull the
  private side in, and the open build cannot accidentally start shipping it);
- invoking `pack-ingest`, `cover-build`, and `discover` each exits non-zero with the refusal;
- **no non-GET HTTP method appears anywhere in `capabilities/assets/`**, so the catalog client
  cannot gain a write path unnoticed;
- no source file hardcodes a catalog endpoint; the env var or an explicit flag stays the only
  way to name one.

Each needs a LITMUS proving it fails on the broken input, including one that plants a stub
authoring module and requires the refusal test to fail. A guard for a security boundary that
nobody proved can fail is not a guard.

### 2. Gate the authoring help

`assets --help` must not advertise the authoring verbs when the private side is absent. Detect
the seam's presence rather than hardcoding a build flag, so one mechanism decides both what runs
and what is advertised. When present, print as today.

### 3. Scrub infrastructure detail

- Remove the R2 key convention and the private-path reference from the public schema
  description. Keep the field semantics; drop the bucket layout.
- Replace the Railway hostname in all seven files with the configurable base
  (`LOOMBRIDGE_ASSET_CATALOG_URL` or `--catalog-api`) plus a stable, brand-owned default URL to
  be supplied. **Do not invent a hostname**: if no stable domain is ready, the docs name the env
  var and say the endpoint is published at the asset store, rather than naming a deployment.
- Update `asset-priority-docs.test.ts` so it enforces the NEW stance instead of asserting the
  hostname. The test stays non-vacuous; it just guards a different, correct claim.

### 4. Demote hosted-first to optional, and say so honestly

`Docs/Assets/AssetPriority.md`, `commands/loombridge/plan.md`, `commands/loombridge/build.md`,
and `.skills/asset-layer/SKILL.md` currently mandate hosted-registry-first. Restate the priority
so the committed `asset-layer/registry/*.json` and generated assets are the default path, and the
hosted catalog is an optional accelerator. This makes Positioning.md's non-goal true rather than
aspirational, and it decouples the OSS product from one company's infrastructure bill.

The plan wizard's three choices stay; the recommended default changes.

### 5. Document the registry openly

A short README section: what the hosted catalog is, that it is READ-ONLY for consumers, that it
is optional and the tool works fully without it, that assets carry per-asset SPDX with an
attribution flag (the current catalog records 80 assets as `CC0-1.0`), and how to point at it.

## Invariants

- **The open build can never write to the registry.** No upload verb, no non-GET method, no
  credential path for writing. Guarded, not merely true.
- **No deployment hostname in the public repo.** Endpoints are configuration, named by env var or
  flag, never baked into prose or code.
- The tool works completely with the hosted catalog unreachable or never configured.
- The private side stays optional: its absence is a clean refusal, never a crash or a silent
  degradation.

## Out of scope

- Moving the catalog off Railway, or making it public. Both are business decisions this RFC
  deliberately does not depend on; the point is that the OSS product stops caring either way.
- Auditing the catalog's asset licensing. Separately tracked: 80 entries record `CC0-1.0`, and
  the residual work is the 9 `Loombridge`-authored and 1 `Unknown` entries.
- Any change to what the authoring tooling does on the private side.

## Open questions

1. **What stable URL replaces the Railway hostname in docs?** Needs a brand-owned domain. Until
   one exists, docs name only the env var. Leaning: ship the env-var-only wording now rather than
   wait, since it is strictly better than the current state.
2. **Should `assets --help` list the authoring verbs as "unavailable in this build", or omit them
   entirely?** Leaning omit: naming a private toolchain in an open build's help is the same
   information leak in a smaller font.
