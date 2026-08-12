# SniperShooter `plan` findings ledger

Mined from a real `loombridge plan` run on a 3d-shooter project (SniperShooter), the first
dogfood of the plan door on a **non-platformer genre** and on a **fresh machine with no local
asset registry**.

**Verdict: `plan` completed end to end.** Contract seeded and tuned, design target approved and
frozen as a composition reference, hybrid asset manifest approved, 7 slices scaffolded, first
slice announced. It did not fail. What it cost to get there is the finding.

## Delivery status

| Epic | Findings | Status | Commits |
|---|---|---|---|
| Genre-correct generated roles | SNP-T01 | **Fixed** | PR #83 `a8366e1` |
| Catalog endpoint discoverability | SNP-P01 | **Open** | |
| Consumer-side discoverability | SNP-P02, SNP-T02, SNP-T03 | **Open** | |
| Registry onboarding | SNP-O01 | **Open** | |
| Sniper sub-genre feel | SNP-G01 | **Candidate** (needs a 2nd run) | |

## Methodology

Two-pass mining (friction + surfaces-used), provenance-tagged, claims re-verified against HEAD
rather than against the transcript's own summary. Provenance: `[observed-this-session]` /
`[inherited-handover]` / `[user-taught]`. Confidence: `[direct]` (transcript or reproduced) /
`[2nd-hand]`.

## Run log

| Run | Date | Transcript | Lines | Tool calls | Watermark note |
|---|---|---|---|---|---|
| 1 | 2026-08-12 | `ae9639da-d43a-44b3-bef1-a10a5937d867.jsonl` | 403 | 94 (78 Bash) | First mining pass. Watermark = end of file, line 403. |

## Headline finding

**The documented way to reach the hosted catalog does not exist, so the agent reverse-engineered
it.**

Three shipped docs promise the same thing:

> "The current base URL is published alongside the asset store at `https://assetstore.loomtide.ai/`."
> (`README.md:174`, `ARCHITECTURE.md:268`, `mcp-server/README.md:216`)

Tested during this mining pass:

```
/           200
/about      404
/docs       404
/api        404
/api-docs   404
base URL present in the store's page HTML:  no
```

So the promise is false. The session spent **16 curl calls** guessing hostnames
(`api.loomtide.ai`, `catalog.loomtide.ai`, `assets.loomtide.ai`, `/api/packs`, `/api/assets`,
`/api/meta`, `/api/catalog`, …) and, in its own words, *"recovered it from the store's JS
bundles"*.

This is a direct consequence of the asset-registry OSS boundary work: the deployment hostname was
correctly scrubbed from the repo, and the replacement was a **prose promise that nothing walks**.
`LOOMBRIDGE_ASSET_CATALOG_URL` is wired, guarded, and refuses cleanly when unset, and none of that
helps a user who cannot find out what to set it to. The repo's own recurring failure shape, one
layer out: a declared path with no guard, invisible to a green suite.

## T: tool / op gaps

| ID | Finding | Provenance / Conf. | Sev | Evidence | Fix | Status |
|---|---|---|---|---|---|---|
| SNP-T01 | `generated-plan`/`generated-apply` validated annotation roles against the static platformer list, so hybrid mode was broken for **every** non-platformer genre | `[observed-this-session]` `[direct]` | High | `Unknown generated asset annotation role 'reticle'.; Unknown generated asset annotation role 'impact-vfx'.` → `generated-plan slots=0 issues=4`, EXIT=1 | Resolve roles from `resolveAssetGenreProfile(manifest.genre)` | **Fixed** PR #83 |
| SNP-T02 | `loombridge target set --help` exits 2 with `unknown argument "--help"`. A subcommand cannot be asked how it works | `[observed-this-session]` `[direct]` (re-confirmed at HEAD) | Med | transcript line 29; reproduced at `4dba346` | Accept `--help` on every subcommand, or route it to the parent usage block | Open |
| SNP-T03 | Agent trying to validate its own Loombridge fix ran `npx vitest` and got `No test suite found`. The repo has **zero** vitest and uses `node --test` | `[observed-this-session]` `[direct]` | Low | transcript line 301; `grep -c vitest package.json` → 0 | Name the test command where a consumer-side agent will look | Open |

## P: product / flow gaps

| ID | Finding | Provenance / Conf. | Sev | Evidence | Fix | Status |
|---|---|---|---|---|---|---|
| SNP-P01 | **Headline.** Catalog base URL is promised as "published alongside the asset store"; the store publishes nothing and the URL had to be scraped from JS bundles | `[observed-this-session]` `[direct]` | High | 16 curl calls; store 404s on every doc path; agent's own closing note | Publish it at a stable path the docs can name, or stop promising and name the env var only | Open |
| SNP-P02 | **32 of 78 bash calls (41%) read Loombridge's own `src/`/`dist/`** from inside the consumer project, to work out the asset flow (`catalog-source.js`, `assets.js`, `manifest-selection`, `asset-genre-profile`, `generated-assets`, `asset-manifest.d.ts`) | `[observed-this-session]` `[direct]` | High | line 143→288 cluster | Whatever the agent had to read source to learn belongs in `--help`, the skill, or the plan prose | Open |

## O: onboarding / distribution

| ID | Finding | Provenance / Conf. | Sev | Evidence | Fix | Status |
|---|---|---|---|---|---|---|
| SNP-O01 | "No local asset registry is installed on this machine" was a decision point put to the user mid-plan, not a resolved setup step | `[observed-this-session]` `[direct]` | Med | AskUserQuestion at line 111 | Detect at `setup`/`doctor` time, not mid-plan | Open |

## G: genre knowledge (CANDIDATE, do not promote)

| ID | Finding | Provenance / Conf. | Sev | Evidence | Status |
|---|---|---|---|---|---|
| SNP-G01 | The `3d-shooter` pack seeds **machine-gun cadence (133 ms between shots)** as the graded feel target. For a sniper the user chose bolt-action: 1500 ms fire interval, one-shot kill at 50 ms TTK | `[user-taught]` `[direct]` | Med | AskUserQuestion at line 354, and the final contract | **Candidate.** One run is an anecdote. Gated on a second sniper/DMR validation run before any pack change |

The durable half is not the numbers, it is the shape: **`3d-shooter` is a genre family, and its
seeded feel defaults encode one weapon archetype.** A sub-genre whose whole identity is cadence
inherits targets that grade it as broken. Worth watching whether other packs have the same
one-archetype assumption.

## Surfaces used vs bypassed (mandatory)

Unlike the extraction-shooter exemplar, **this session did not bypass the front door.** It is the
first dogfood where the CLI was the primary interface.

| Surface | Used? | Evidence | Note |
|---|---|---|---|
| `loombridge plan` | **Yes**, 7 calls | contract seeded, tuned, roadmap scaffolded | the spine of the run |
| `loombridge assets` | **Yes**, 9 calls | registry-plan/apply, generated-plan/apply | where SNP-T01 surfaced |
| `loombridge target` | **Yes**, 4 calls | composition-reference approved and frozen | correct 3D two-stage usage |
| `loombridge status` | Yes, 1 call | | |
| `loombridge doctor` | **No** | | would have surfaced SNP-O01 up front |
| `loombridge build` / `verify` / `doneness` | Not reached | run ended at "ready to build" | out of scope for a plan run |
| Raw bridge / MCP ops | **No** | | notable: no bypass |
| Hand-rolled `.loombridge/` evidence | **No** | tool-created throughout | no verification theatre |

**No false-green risk in this run.** Nothing hand-fabricated contract-shaped evidence, and the
design target was correctly stamped `composition-reference` for a 3D build rather than being
frozen as a final frame.

## Cross-references

- SNP-P01 is adjacent to, but **not fixed by**, `Docs/Design/AssetRegistryOssBoundary.md`. That
  RFC removed the hostname and wired the env var; it did not make the value discoverable. Do not
  read the boundary work as closing this.
- SNP-P02 is adjacent to `Docs/Design/SkillRouting.md`: both are "the agent cannot see what the
  tool can do". Routing fixed a false absence claim; this is a wider surface gap.
- SNP-T01's root cause is the same migration that `asset-genre-profile.ts`'s header documents. Two
  call sites were converted, this third was missed, and nothing guarded it.

## Routing

**Promote now:** SNP-T02, SNP-T03 (small, immediately actionable); SNP-P01 and SNP-P02 as backlog
items with the evidence above; SNP-O01 into the `doctor`/`setup` surface.

**Do NOT promote yet:** SNP-G01's specific numbers (1500 ms, 50 ms TTK). One session is an
anecdote. The *observation* that a pack encodes one weapon archetype is worth recording now; the
dials are not.
