# Public Catalog Quickstart

This is the external-developer quickstart for browsing and preparing **public** Loomtide hosted
assets — with no private GitHub token and no checked-out private mirror.

> **The catalog is optional and its endpoint is configuration.** Loombridge bakes in no host, and this
> doc deliberately names no deployment: every command below takes the base URL from you. The public
> catalog is published at scale (66,859 assets across sprite/audio/model/vector) behind a company-run
> **read-only** search API exposing `/v1/assets/search`. Its base URL is not published at a fixed
> path, so obtain it from whoever operates the catalog and set `LOOMBRIDGE_ASSET_CATALOG_URL`.
>
> **Everything here works without it.** The default asset path is the registry packs committed in
> `asset-layer/registry/*.json`; see [`AssetPriority.md`](AssetPriority.md).

For the catalog's architecture and publish pipeline, see the "Public Hosted Asset Catalog" section of
[`ARCHITECTURE.md`](../../ARCHITECTURE.md). This doc only covers commands that exist **today** against the
read-only public catalog.

---

## What catalog URL should I use?

A public catalog URL points at a **profile shard directory** (the CLI probes it for
`part-00000.jsonl`, `part-00001.jsonl`, …) or directly at a single `.jsonl` / `.json` shard. It has
the shape `<base>/v1/catalog/public/<profile>`, e.g. `…/v1/catalog/public/2d-platformer` for the
bundled first seed (a curated `2d-platformer` set of CC0 assets).

**This repo does not name the `<base>`.** It is not published at a fixed path: obtain it from
whoever operates the catalog, or point at any catalog of your own that serves the same shards. Every command below reads it from your environment, so there is exactly one place to put it:

```bash
export LOOMBRIDGE_ASSET_CATALOG_URL="<base>/v1/catalog/public/2d-platformer"
```

> A single-file URL is also accepted: `…/2d-platformer/part-00000.jsonl`.
> An `index.json` is **informational only** — do not pass it as the catalog URL; the CLI would try
> to parse it as a catalog and fail. Always point at the shard directory or a `part-*.jsonl` file.

> `LOOMBRIDGE_ASSET_CATALOG_URL` is the **no-flag default** for `--catalog`: `assets
> registry-plan` / `registry-apply`, `prepare-cli` and `browser-payload` fall back to it when you
> pass no `--registry` / `--catalog` / `--catalog-api`. Passing `--catalog
> "$LOOMBRIDGE_ASSET_CATALOG_URL"` explicitly does the same thing. With neither the flag nor the
> variable set, the catalog layer refuses with a named error rather than silently reaching for
> someone's deployment.

## How do I browse in Unity?

`Window → Loombridge → Asset Browser` opens the in-editor browser. It ships with **no default host**,
so give it the search-API base once: paste it into the **Catalog** field in the window's toolbar and
press **Save**, or set it under **Preferences → Loombridge → Asset catalog**. Both write the
`loombridge.assetApiBaseUrl` EditorPref. `LOOMBRIDGE_ASSET_CATALOG_URL` is honoured as a fallback,
but a Unity Editor launched from the Hub or Finder inherits no shell environment, so the field is the
reliable path. Note the browser wants the **search-API base** (it calls `<base>/v1/assets/search`),
not the shard-directory URL the CLI's `--catalog` takes.

## Do I need a token?

**No.** For the public seed, browse and prepare require zero credentials. Public catalog reads and
public asset byte downloads (whatever host the records pin) are unauthenticated. Tokens are only
ever used by internal publish/admin jobs, never on the developer happy path.

---

## How do I browse candidates?

`browser-payload.js` reads the catalog and emits a JSON payload of browseable assets with their
trust tier, license, source/provenance links, and the action intents the UI is allowed to offer.

```bash
cd mcp-server
npm run build   # one-time, produces dist/
node dist/capabilities/assets/browser-payload.js \
  --profile 2d-platformer \
  --catalog "$LOOMBRIDGE_ASSET_CATALOG_URL" \
  --output payload.json
```

Each asset in `payload.json` carries:

- `trustTier` / `policyStatus` — see [Trust tiers](#trust-tiers) below.
- `actionIntents` — `select` for a trusted-default asset, `request-explicit-approval` for anything
  that needs a human decision (attribution-required or unverified).
- `license`, `licenseName`, `author`, `sourceTitle`, `sourceUrl`, `sourceLinks` — to inspect
  source / license / provenance before you commit to an asset.

> Cards show thumbnails only when previews are available. For an HTTP catalog, add
> `--cache-previews` to download + checksum-verify remote bytes into a local preview cache.

## How do I prepare assets?

`prepare-cli.js` selects the trusted-default asset for each requested primitive, downloads the
bytes (or resolves a bundled/local mirror), **verifies the SHA-256 against the pinned checksum**,
validates the sprite, and writes a deterministic project cache plus a prepare report.

```bash
cd mcp-server
node dist/capabilities/assets/prepare-cli.js \
  --profile 2d-platformer \
  --catalog "$LOOMBRIDGE_ASSET_CATALOG_URL" \
  --primitive tile \
  --output assets.json \
  --cache .cache
```

Pass `--primitive` multiple times (e.g. `--primitive tile --primitive player`) to prepare several
primitives in one run. Add `--preferred-license CC0-1.0` to bias selection toward CC0.

### Where do prepared files and attribution reports go?

- **Prepared bytes** land under the `--cache` directory you pass (e.g. `.cache/…`), at a
  deterministic content-addressed filename. Each accepted asset's `cachePath` in `assets.json`
  points at its cached byte.
- **The prepare report** is the `--output` file (`assets.json`): it records, per asset, the
  `status` (`accepted`/`rejected`), the verified `checksum`, the `license` (including
  `requiresAttribution`), the `source`/`provider` provenance, and the Unity `import` plan.
- **Attribution**: trusted-default CC0 assets do not require attribution. For any
  attribution-required asset you explicitly opt into, the license + author + source are carried on
  that asset's record in the report so you can produce an attribution credit.

## Which assets can be auto-selected?

Only **`trusted-default`** assets are auto-selected by `prepare`. The trust tier is **re-derived
locally** from the license + review status — the catalog's asserted `trustTier` can only make an
asset *more* restrictive, never elevate it. Attribution-required and unverified records remain
browseable but are **never** silently selected or prepared; they require an explicit decision.

<a id="trust-tiers"></a>
## What do the trust tiers mean?

| Tier | Meaning | Auto-selectable? |
| --- | --- | --- |
| `trusted-default` | Verified review + commercial-use-compatible license (at minimum `CC0-1.0`) + public downloadable bytes whose checksum matches. | Yes (`select`). |
| `attribution-required` | Verified, but the license requires attribution (e.g. `CC-BY-*`). Usable only if you handle attribution. | No — `request-explicit-approval`. |
| `unverified-discovery` | Scraped/discovered candidate, not review-verified. Visible for inspection only. | No — `request-explicit-approval`. |
| `blocked` | Excluded from the public seed entirely (fails validation). | No — never appears. |

## How do I inspect source / license / provenance?

Every browse asset and every prepared asset record carries `source.title`, `source.url`,
`source.author`, `source.provenance` (origin + public URL), `license.spdx`,
`license.requiresAttribution`, and `provider`. Read these from `payload.json` (browse) or
`assets.json` (prepare) before importing.

## What does a checksum failure mean?

Every public record pins a `sha256` for its bytes. During prepare, the downloaded (or resolved)
bytes are re-hashed and compared. A mismatch means the bytes you received are **not** the reviewed,
pinned bytes — the asset is **rejected** with a `CHECKSUM_MISMATCH` diagnostic and is not cached or
imported. This is a hard stop: treat it as a tamper/corruption/staleness signal, not a warning.
(The HTTP provider also refuses redirects and non-public hosts, so a checksum failure is the last
line of a layered integrity check, not the only one.)

## How do I import prepared sprites into Unity?

Each accepted asset in `assets.json` includes an `import` plan:

```json
{
  "import": {
    "tool": "unity_asset_create_sprite",
    "toolArguments": { "source_path": "<cachePath>", "path": "Assets/Art/…" }
  }
}
```

Through the Loombridge MCP bridge, call `unity_asset_create_sprite` with that asset's
`import.toolArguments` (`source_path` = the prepared cache byte, `path` = the target `Assets/…`
location). The sprite imports from the verified cache byte and is ready to place in a scene. After
import, you can verify the imported file's checksum matches the cache and that the rendered sprite
has non-zero on-screen extent (`unity_scene_get_bounds`).

---

## End-to-end, in three commands

```bash
cd mcp-server && npm run build

# 1) Browse public candidates (no token).
node dist/capabilities/assets/browser-payload.js \
  --profile 2d-platformer \
  --catalog "$LOOMBRIDGE_ASSET_CATALOG_URL" \
  --output payload.json

# 2) Prepare the trusted-default tile (downloads + checksum-verifies into .cache).
node dist/capabilities/assets/prepare-cli.js \
  --profile 2d-platformer \
  --catalog "$LOOMBRIDGE_ASSET_CATALOG_URL" \
  --primitive tile \
  --output assets.json \
  --cache .cache

# 3) Import each accepted asset's import.toolArguments via unity_asset_create_sprite (MCP bridge).
```
