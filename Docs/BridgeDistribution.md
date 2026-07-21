# Distributing & Installing the Loombridge Unity Bridge

`com.loomtide.loombridge` is the C# half of Loombridge — the "Playwright for Unity"
package that lets an AI agent see, control, and verify a Unity project over MCP.

This page documents how an **external** Unity project (one that is NOT a sibling
checkout of this monorepo) installs the bridge. It exists because the in-repo
fixtures under `unity-projects/*` reference the package by a **machine-local
relative path**:

```jsonc
// unity-projects/<fixture>/Packages/manifest.json — DEV-ONLY, do not copy
"com.loomtide.loombridge": "file:../../../packages/com.loomtide.loombridge"
```

That `file:` reference is intentional for fixtures (they track the package source
in this repo), but it **only resolves on a machine where this repo sits at exactly
that relative location**. An external clone gets a broken package ref
(finding RCL-O01, internal dogfood ledger). Use one of
the distributable options below instead.

> **Just want the steps?** See [`Install.md`](Install.md) for the simplest new-machine flow.
> The recommended path is Option A below (`loombridge install-bridge`) — the other options are for
> specific situations.

---

## Option A — Bundled tarball via `loombridge install-bridge` (recommended)

The `loombridge` CLI carries a versioned bridge `.tgz` and installs it into your
project as a **`file:` immutable dependency** — no git, no registry, no repo clone:

```bash
loombridge install-bridge --project <unity-project-dir>
```

This writes the tarball to `<project>/Packages/tarballs/` and adds:

```jsonc
{ "dependencies": {
    "com.loomtide.loombridge": "file:tarballs/com.loomtide.loombridge-<ver>.tgz"
} }
```

- **Immutable dependency ⇒ Tests self-exclude.** Unity resolves the tarball
  read-only into `Library/PackageCache`; an immutable dependency is not a
  "testable", so `UNITY_INCLUDE_TESTS` stays undefined and the `nunit`-referencing
  test asmdef never compiles into the consumer (proven live — see the decision doc).
- **Keeps the (private) monorepo private** — only the packaged bridge bytes ship,
  inside `@loomtide/loombridge`. No consumer git credentials.
- **Read-only** ⇒ no "developer edited the embedded bridge" drift.
- `loombridge update --project <p>` swaps the tarball and re-runs `doctor`.
- Transitive UPM deps (`com.unity.ugui`, `com.unity.2d.sprite`,
  `com.unity.nuget.newtonsoft-json`) resolve from the bridge `package.json`.

This is the default because it was proven live to keep a private monorepo private while avoiding the
"developer edited the embedded bridge" drift that the legacy embedded-copy route was prone to.

## Option B — Git-URL UPM dependency

> **Caveat for the private monorepo:** a git-URL forces git credentials on every
> consumer machine + CI runner and makes Unity **clone the whole private repo** to
> resolve the `?path=` subfolder. Prefer Option A while the repo is private; a
> git-URL becomes attractive mainly once the bridge is public (or via a dedicated
> mirror repo).

Unity's Package Manager can install a package directly from a git repository,
pointing at a subdirectory with `?path=` and pinning a ref with `#<branch-tag-or-sha>`.

Add this to the consumer project's `Packages/manifest.json`:

```jsonc
{
  "dependencies": {
    "com.loomtide.loombridge": "https://github.com/Loomtide/loombridge.git?path=/packages/com.loomtide.loombridge#main"
  }
}
```

> **Pick a ref that actually resolves.** The `#<ref>` must exist on the remote. As
> of this writing **no `v0.2.0` release tag has been published**, so `#v0.2.0` would
> FAIL package resolution — do not pin a tag that isn't pushed.
> - `#main` (used above and by the `create-loombridge-game` template) resolves today
>   and tracks the latest merged bridge — convenient, but **non-reproducible**.
> - For a **reproducible** pin, use a **commit SHA** (`#<40-char-sha>`), or a
>   **release tag once one is published**: `git tag v0.2.0 <commit> && git push origin v0.2.0`
>   from a release commit whose version matches the bridge `package.json` `version`,
>   then pin `#v0.2.0`.
- Unity rewrites the entry into a `lock` block in `Packages/packages-lock.json`
  on first resolve, capturing the exact resolved hash.
- **Tests are not compiled.** A git-URL (immutable) package's `Tests/` assembly
  is only compiled when the consumer lists the package in the manifest's
  `testables` array, so the `nunit`-referencing test asmdef does NOT break the
  consumer compile. (This is the failure mode that the *embedded* path in
  Option C must explicitly strip — see below.)
- Requires `git` on PATH for the editor's Package Manager.

The bridge's own UPM dependencies (`com.unity.ugui`, `com.unity.2d.sprite`,
`com.unity.nuget.newtonsoft-json`) are declared in its `package.json` and resolve
transitively.

## Option C — Scoped registry (OpenUPM / a Loombridge registry)

Once the package is **published** to a scoped registry, a consumer adds the
registry + dependency:

```jsonc
{
  "scopedRegistries": [
    {
      "name": "Loombridge",
      "url": "https://registry.loomtide.ai",
      "scopes": ["com.loombridge"]
    }
  ],
  "dependencies": {
    "com.loomtide.loombridge": "0.2.0"
  }
}
```

> **Status: needs a publish step.** No public scoped registry hosts the package
> yet, so this path is documented but not usable until `com.loomtide.loombridge`
> is published (OpenUPM build pipeline, or a self-hosted Verdaccio/registry at the
> URL above). Until then, use Option A (git-URL) — it requires no registry.

## Option D — Vendored / embedded copy (offline, no git/registry)

Physically copy the package into the consumer's `Packages/` directory —
`loombridge install-bridge --project <p> --embedded` (or the older
`scripts/loombridge-embed-bridge.sh`):

```bash
loombridge install-bridge --project <unity-project-dir> --embedded
```

The embed step **excludes `Tests/`** on purpose: an *embedded* (mutable) package's
test asmdef is compiled, and a consumer without `com.unity.test-framework` fails
with CS0246 (RUN-1 finding #62). Options A and B do not have this problem because
an installed package is immutable and its tests are opt-in via `testables`.

Use this when the editor cannot reach git or a registry (air-gapped CI, etc.).

---

## Which option to use

| Situation | Use |
|-----------|-----|
| **Any external project (default)** | **A — `loombridge install-bridge`** (bundled tarball) |
| Public bridge / native UPM-git workflow | **B — git-URL** (pin a tag/SHA) |
| Org with a published registry | **C — scoped registry** |
| Air-gapped / vendored snapshot | **D — `install-bridge --embedded`** |
| In-repo fixture under `unity-projects/*` | the `file:` ref (dev-only) |

For a brand-new project pre-wired with Option A plus a `.loombridge/` skeleton and
`.mcp.json`, see the template at `templates/create-loombridge-game/`
(`Docs/GettingStarted.md` links it).
