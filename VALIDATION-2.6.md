# Loombridge — Phase 2.6 LIVE Unity Validation

Validation of the renamed, self-contained Loombridge export against a REAL Unity editor.

- **Tree:** `/Users/avinash/Projects/AI/loombridge` (git `a12c682`, "Loombridge export snapshot (pre-verification)")
- **CLI:** `loombridge 0.2.0 (a12c682, built 2026-07-21T12:02:34Z)` via `node mcp-server/dist/cli.js`
- **Bridge package:** `com.loomtide.loombridge` 0.2.0, plugin protocol 1
- **Date:** 2026-07-21 · macOS 15.6 (Darwin 24.6.0, arm64) · Node v23.7.0
- **Transport:** TCP loopback `ws://localhost:8209` (IPC is Windows-only)
- **Editor used:** `6000.3.20f1` (see Env note E1 — the requested `6000.3.9f1` is not installed)

## Verdict: **SHIP**

All 7 matrix items PASS. The rename is complete and functional end-to-end against a live editor: the renamed Tests asmdefs compile + run, the bridge boots and publishes discovery under the NEW `<temp>/loombridge/unitybridge/` path, the handshake is enforced, `[Loombridge]` logs appear, 128 MCP tools route, input/measurement/verification/reload/install all work. No rename regressions were found. All defects below are pre-existing or cosmetic; none block ship.

## Matrix

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | Headless EditMode tests | **PASS** | Renamed `com.loomtide.loombridge` Tests asmdefs compile (0 CS errors) + run: **499/507 passed, 6 failed, 2 skipped**. 6 failures are pre-existing, none reference a renamed symbol (see D-list). |
| 2 | Interactive launch + discovery + handshake | **PASS** | `open-project.sh` (exported) → routable; discovery JSON at NEW `…/T/loombridge/unitybridge/endpoint-discovery-latest.json`; `doctor --live` handshake ok (plugin 0.2.0, protocol 1); raw WS pre-handshake command → `HANDSHAKE_REQUIRED`; `[Loombridge]` ×52 in Editor.log. |
| 3 | MCP tool smoke | **PASS** | phase3-mcp-smoke `--expect-connected`: tools=128, checks passed. One op per category driven live: scene/component/editor/ui/asset/package/ops(batch)/animator/code/capture/runtime/input all PASS or honest-refuse. |
| 4 | Input + measurement | **PASS** | `capture_input_motion` deltaX=**4.00** (1205 samples); `measure_motion` nonzero deltaX=3.54; `probe`/`wait_for_condition` ok; `assert_condition` passing=pass, failing=deterministic `classification:fail` (refused, no crash); `sample_animator` honest `NOT_FOUND` (no Animator); pointer_tap dispatched; **keep-alive lease survives >30s WITH refresh** (deltaX=3.54 after 35 s hold + key_up ok). See D5 on bare-idle. |
| 5 | Verification pipeline E2E | **PASS** | `plan` scaffolds **`.loombridge/`** (NOT `.loomtide/`); `doneness` on fresh project → refuse exit 1; post-`plan` refuse; post-warn-`verify` refuse exit 1; `verify --strict` exit 1; runId binding enforced ("no currentBuild in STATE"). doneness never green without a fresh+bound verdict. |
| 6 | Reload gauntlet | **PASS** | `modify_script` → recompile; `wait_for {compiling:false}` attempt1 `CONNECTION_LOST` (known reload response-loss) → recovered attempt2 clean; ops routable after (`get_state` error_count 0, `create_object` ok); discovery **republished** with a NEW session id + fresh mtime. |
| 7 | install-bridge round-trip | **PASS** | Into throwaway project: manifest gains `"com.loomtide.loombridge": "file:tarballs/…-0.2.0.tgz"`; `ProjectSettings/LoombridgeInstall.json` written (installMode tarball-dependency, protocol 1, sha256 match); tarball vendored; `doctor` = **healthy (0 warnings)**; no `.loomtide` leakage. |
| — | `trace record --observe` | **PENDING-USER** | Explicitly out of scope (user-interactive). Not run. |

## Evidence detail

### 1 — Headless EditMode
`Unity 6000.3.20f1 -runTests -batchmode -projectPath unity-projects/loombridge-dev -testPlatform EditMode`
→ `test-run total=507 passed=499 failed=6 inconclusive=0 skipped=2`. 0 `error CS` in log. The renamed test asmdefs imported and ran:
`com.loomtide.loombridge.tests.asmdef`, `com.loomtide.loombridge.tests.inputspike.asmdef`.

The 6 failures (all **pre-existing, NOT rename regressions** — namespaces stayed `UnityBridge.*`, method names unchanged; none touch a renamed string):
- `ComponentHandlerTests.SetProperty_ObjectReference_AssetPathStringAssignsAsset` and `…_Array_ObjectReferences_SetsAllElements` — asset-name fixture mismatch ("Expected DummyAsset but was ComponentHandlerTests-<guid>").
- `InputObserverPathTests.GenericGesturePrimitives_GettersExist…` and `…StateSignalBuffer_StaysParallel…` — tests reflect for parameterless `BeginObserver()` and 3-arg `BeginObserver(string,string,string)`; runtime only ships `BeginObserver(string,string,string,bool)`. An in-progress "signal arity" feature, unrelated to rename.
- `OpExecutorTests.Execute_HandlerThrowsGenericException_ReturnsInternalError` and `TraceCollectorTests.GetRecentLogs_ErrorType_CapturedCorrectly` — "Unhandled log message" failures: the test does no `LogAssert.Expect`, so any `Debug.LogError` fails it. Prefix-agnostic (fails identically with the old `[UnityBridge]` prefix).

### 2 — Launch/discovery/handshake
- discovery: `{"sessionId":"5a7b470e…","endpoints":[{"transport":"tcp","host":"localhost","port":8209}],"projectName":"loombridge-dev"}` under `…/T/loombridge/unitybridge/`.
- `doctor --project unity-projects/loombridge-dev --live`: `✓ Unity bridge (live): handshake ok — plugin 0.2.0, protocol 1` / `Live transport: tcp` / `✓ Live protocol preflight: protocol 1 accepted`. (Two non-live rows flagged: no `LoombridgeInstall.json` — expected because the dev project uses a `file:` package ref, not an install-bridge install.)
- raw WS (`ws://localhost:8209`), first frame `editor.get_state` without `bridge.initialize` →
  `{"error":{"code":"HANDSHAKE_REQUIRED","message":"You must send 'bridge.initialize' before any other command."}}`.
- `package.list` shows `"com.loomtide.loombridge"` displayName `"Loombridge …"` loaded (13 packages).

### 4 — Keep-alive nuance
The lease is refreshed by the MCP server's internal `input.keepalive` ping loop (the C# op is documented "internal liveness ping from the owning MCP server, not an agent tool"). With periodic refresh (the real product path) a held `RightArrow` still moved the object after 35 s (deltaX 3.54) and `key_up` succeeded. A bare hold with **zero** intervening ops idles out at ~30 s by design (object stopped at x≈154 ≈ 31 s of motion, `key_up` → `INPUT_SESSION_REQUIRED`) — see D5.

## Defects / findings

| ID | Sev | Kind | Finding |
|----|-----|------|---------|
| D1 | Low | Rename-miss (cosmetic) | `packages/com.loomtide.loombridge/Editor/Core/TraceCollector.cs:18` — `ScreenshotDir = "Logs/UnityBridge/screenshots"`. Trace + auto-error-capture artifacts are still written under `Logs/UnityBridge/…` (observed live: `Logs/UnityBridge/screenshots/error_…jpg`). Cosmetic; no functional impact. |
| D2 | Info | By design | C# namespaces (`UnityBridge.*`), asmdef `rootNamespace: "UnityBridge"`, and test namespace `UnityBridge.Tests` were intentionally NOT renamed. Only package id, product/log-prefix (`[Loombridge]`), env vars (`LOOMBRIDGE_*`), CLI bin (`loombridge`), and discovery dir (`loombridge/unitybridge`) changed. |
| D3 | Info | By design | Package id retains the `loomtide` org segment: `com.loomtide.loombridge`. |
| D4 | — | Pre-existing | 6 EditMode test failures (see item 1). None are rename regressions. |
| D5 | Low | Pre-existing / by-design | A held key with no intervening ops is released by the ~30 s idle watchdog. Only relevant to raw-bridge drivers; the MCP server's keepalive loop keeps real sessions alive (verified). Matches project memory ("keep-alive lease so measure/capture/probe don't starve the 30s watchdog"). |

## Environment notes

- **E1 — Editor version:** `loombridge-dev` pins Unity `6000.3.9f1`, which is **not installed** (installed: `6000.3.20f1`, `6000.5.3f1`). All live work used `6000.3.20f1` via `--unity` / batchmode override. `demo-platformer` pins `6000.3.20f1` (exact match). Opening `loombridge-dev` with the newer editor upgraded its `ProjectVersion.txt` + `Packages/*lock*` (incidental working-tree changes, left uncommitted).
- **E2 — Missing Assets/ fixture:** `loombridge-dev` ships with **no `Assets/` directory**; Unity batchmode refuses to open the project ("Couldn't set project path to:") until one exists. Created an empty `Assets/` to run the EditMode suite (known gotcha per project memory). Left uncommitted; consider committing an `Assets/.gitkeep` to the fixture.
- **E3 — Licensing:** batchmode logs a transient `Licensing 505 "Unsupported protocol version '1.18.1'"` against Unity Hub's V1 license client, then self-heals to the versioned client. Non-fatal; tests and interactive launch both succeeded.
- **E4 — Known reload behavior:** `editor.wait_for` can return `CONNECTION_LOST (1006)` across a domain reload (recompile / play-mode enter). The client auto-reconnects and subsequent ops route — distinguished from real breakage, and confirmed recoverable (items 4 & 6).
- Unity editor was launched for the live matrix and **quit at the end** of validation.

## Reproduction commands (abridged)

```
# Item 1
Unity6000.3.20f1 -runTests -batchmode -projectPath unity-projects/loombridge-dev \
  -testPlatform EditMode -testResults results.xml -logFile run.log
# Item 2
scripts/unity/open-project.sh unity-projects/loombridge-dev --unity <6000.3.20f1> --skip-build
node mcp-server/dist/cli.js doctor --project unity-projects/loombridge-dev --live
# Items 3/4/6 — driven via dist UnityClient (connect() auto-handshake, send(op, params))
# Item 5
node mcp-server/dist/cli.js plan --genre platformer-2d --root <copy> --allow-missing-design-target
node mcp-server/dist/cli.js doneness --root <copy>   # exit 1 until fresh+green
node mcp-server/dist/cli.js verify --root <copy> --strict
# Item 7
scripts/loombridge-pack-bridge.sh
node mcp-server/dist/cli.js install-bridge --project <throwaway> --tarball dist/bridge/com.loomtide.loombridge-0.2.0.tgz
node mcp-server/dist/cli.js doctor --project <throwaway>   # healthy
```
