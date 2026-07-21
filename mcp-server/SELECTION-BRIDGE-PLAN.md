# CLI Bridge — `registry-apply --from-selection` (web selection.json → project manifest)

> Build the project-local CLI step that consumes the web asset browser's `selection.json` and applies
> it to a project's `.loombridge/ASSET_MANIFEST.json`. Branch `feat/cli-registry-apply-from-selection`.
> Do NOT push to main / open a PR — the driver reviews diff + CI.

## Why

The web asset browser (`apps/asset-web`, already merged) is **read-only** — it exports a portable,
role-keyed `selection.json` and **never writes project state** (that boundary is deliberate). This CLI
is the **approved writer**: it takes that export and turns it into approved manifest entries. This
closes the loop: browse → pick in the web UI → `loombridge assets registry-apply --from-selection …` →
approved assets in the project.

## Read first (existing code you extend — do NOT rewrite)

- `mcp-server/src/loombridge/assets.ts` — the `registry-apply` verb. Today it takes
  `--selections <json>` where the JSON is a **flat `{ manifestAssetId: registryEntryId }` map** plus
  `--approved-at <iso>`, `--profile`, and a source (`--registry` | `--catalog` | `--catalog-api`).
  Find `runRegistryApply` and how it loads the manifest + registry and calls into selection apply.
- `mcp-server/src/asset-layer/manifest-selection.ts` — `buildRegistrySelectionPlan(...)` and
  `applyRegistrySelectionsToManifest({ manifest, registry, profile, selections, approvedAt, … })`.
  This is the engine; it already validates candidates, re-derives trust, sets status/styleLock, and
  asserts a valid manifest. **Reuse it unchanged** — your job is to produce the `selections` map it
  expects from the web `selection.json`.
- `mcp-server/src/asset-layer/types.ts` — `AssetManifest`, `RequiredAssetRole`, the registry/candidate
  types. Note the manifest's role vocabulary (`player-character`, `platform-tiles`, `collectible`, …).

## The web `selection.json` you consume (input contract)

Emitted by `apps/asset-web` (see its README / `src/lib/selection.ts`):
```jsonc
{
  "schemaVersion": "1",
  "kind": "loombridge-asset-selection",
  "generatedBy": "asset-web",
  "items": [
    {
      "registryId": "kenney.2d.assets...",   // the HOSTED CATALOG record id == a registry-entry id
      "role": "player-character",            // user-assigned; defaults from primitive — may be a
                                             //   manifest role OR just a primitive name
      "primitive": "player",
      "kind": "sprite",
      "title": "…",
      "license": { "spdx": "CC0-1.0", "requiresAttribution": false },
      "provider": "kenney",
      "sourceUrl": "…",
      "downloadUrl": "…",
      "checksum": { "algorithm": "sha256", "value": "…" }
    }
  ]
}
```
Validate it: `kind === "loombridge-asset-selection"`, `schemaVersion === "1"`, `items` non-empty, each
item has a `registryId`. Reject loudly otherwise (this is untrusted input — a hand-authored or stale
file). Do NOT trust the embedded `license`/trust fields for policy — re-derive from the loaded
registry/catalog record (the existing apply path already does this; pass the registryId through).

## The command

```
loombridge assets registry-apply --from-selection <web-selection.json> \
  --profile <path-or-id> \
  (--catalog-api <baseUrl> | --catalog <path-or-url> | --registry <path>) \
  --approved-at <iso> \
  [--root <projectDir>] [--strict-roles]
```
- `--from-selection` is **mutually exclusive** with the existing `--selections`. Both ultimately build
  the same `{ manifestAssetId: registryEntryId }` map and call `applyRegistrySelectionsToManifest`.
- The source should default to / support `--catalog-api` (the hosted catalog) since the web
  `registryId`s are hosted-catalog ids — they must resolve in the loaded registry. If the registryId
  isn't found in the loaded source, that's a hard error (name it).

## The mapping problem (the real work — spec it carefully)

`applyRegistrySelectionsToManifest` needs `{ manifestAssetId: registryEntryId }`. The web export gives
`{ role/primitive → registryId }`. So you must resolve each selection item to a **manifest asset id**:

1. Load the project manifest (`.loombridge/ASSET_MANIFEST.json` under `--root`). Build the list of its
   registry-sourced assets, each with `{ manifestAssetId, role, primitive-prefs }` (reuse
   `buildRegistrySelectionPlan` to get roles + candidate primitives per slot).
2. For each `selection.json` item, find the manifest slot it satisfies:
   - **Primary: match by `role`** when the item's `role` equals a manifest slot's role.
   - **Fallback: match by primitive** — if `role` is just a primitive (the web default), match it to a
     slot whose primitive-preferences include the item's `primitive`/`kind`.
   - The chosen `registryId` must be a valid candidate for that slot (the apply engine will re-validate;
     surface a clear error if it isn't).
3. **Ambiguity & coverage are first-class outcomes, not silent guesses:**
   - If one item matches multiple open slots, or multiple items match one slot → **refuse** that
     mapping with a precise message (which items, which slots). Under `--strict-roles`, ANY unmatched
     item or unfilled required slot is a non-zero exit.
   - Report a summary: matched (item→slot), unmatched items, slots left unfilled. Exit non-zero if any
     required slot is unfilled or any item couldn't be placed (unless a future `--partial` flag — out
     of scope now; default is all-or-nothing for safety).
4. Build the `{ manifestAssetId: registryEntryId }` map from the resolved matches and call the existing
   `applyRegistrySelectionsToManifest` (do not duplicate its validation/trust/status logic).

> This mapping is the crux. When in doubt, **refuse with a clear diagnostic** rather than approve the
> wrong asset into a slot — silent mis-binding is the worst outcome (mirrors the project's
> "refuse-when-absent" gate discipline). Document the exact matching rules you implement.

## Safety / boundary
- This CLI **is** allowed to write `.loombridge/ASSET_MANIFEST.json` (it's the approved project-local
  writer — unlike the web UI). It still goes through `applyRegistrySelectionsToManifest` +
  `assertValidAssetManifest`, so policy/trust/attribution gates apply.
- Attribution-required (CC-BY) selections must NOT be silently approved as trusted defaults — the apply
  engine already distinguishes trust tiers; preserve that. Surface attribution-required picks in the
  summary.
- Deterministic: `--approved-at` is provided by the caller (no `Date.now()`).

## Tests (mirror the repo's existing CLI test style)
- A `selection.json` whose roles map cleanly → correct `{manifestAssetId: registryId}` and an approved
  manifest. Use fixtures (a small profile + catalog + manifest + a web selection.json); no network.
- Role-default (primitive-only `role`) → primitive fallback match works.
- Ambiguous mapping → refuses with a clear error, manifest unchanged.
- Unknown `registryId` (not in the loaded source) → hard error.
- Malformed / wrong-`kind` selection.json → rejected before any manifest write.
- `--strict-roles` unfilled-slot → non-zero exit.
- Determinism: same inputs → byte-identical manifest.

## Verify / handback
- `cd mcp-server && npm run typecheck && npm test && npm run build` all green.
- Update the command's `--help` and any `commands/loombridge/` prose for `assets registry-apply` to
  document `--from-selection`.
- Conventional commits (`feat(cli): …`). Summarize the matching rules you chose, the new flags, and
  test results. Flag any contract ambiguity in the web `selection.json` shape rather than guessing.

## Out of scope
- Changing the web `selection.json` schema (it's fixed; build to it). Importing bytes (that's the
  prepare/import path — separate). A `--partial` apply mode. Any network/live-bridge work.
