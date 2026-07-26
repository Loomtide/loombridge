/**
 * Live wiring for the scene-agnostic `check` (Phase 1 front door). Assembles the REAL IO deps for
 * `runSceneAgnosticCheck` by SHELLING the existing CLI verbs (so trace/scan/capture persistence stays
 * exactly as the normal flow writes it) + a short-lived bridge connection for scene name→path lookup:
 *
 *   record   → `trace record --observe --flat` with NO --scene (resolves the active scene, #295) → read
 *              the persisted trace from the flat layout;
 *   build    → `buildContractFromTrace` with per-scene scan IO: `minigame scan --scene <path>` per scene
 *              (path from `scene.find_by_name` over a fresh bridge connection) + the single-scene fallback;
 *   write    → the fused contract to `<id>.minigame.json`;
 *   pipeline → `driveRun` (capture → finalize → verify) over the now-populated workspace.
 *
 * Every IO step degrades a failure to a clean `{ error }` / thrown-then-caught path so the driver turns it
 * into can't-verify (exit 2), never a crash. The orchestration + exit-code precedence are tested in
 * `minigame-scene-check.test.ts` against fakes; THIS module is the thin real-IO adapter, validated by the
 * interactive cross-scene run (the DoD acceptance test).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { runSceneAgnosticCheck, EXIT, type SceneAgnosticCheckDeps } from "./minigame-scene-check.js";
import { buildContractFromTrace } from "./minigame-scene-build.js";
import { resolveScenePathByName, type SceneQueryDriver } from "./minigame-scene-gating.js";
import { sceneSlug } from "./minigame-scene-inference.js";
import { resolveSingleEditorTarget } from "./minigame-scene-endpoint.js";
import { driveRun } from "./minigame-run.js";
import { loadOverrides, applyContractOverrides, overridesPath } from "./minigame-overrides.js";
import { inspectWorkspace, defaultWorkspace } from "./minigame-next.js";
import { flatReplayLayout } from "../../domain/state.js";
import { parseTrace } from "../replay/parse.js";
import { assertValidMinigameContract } from "./profiles/validator.js";
import { UnityClient } from "../../bridge/unity-client.js";
import { scanEndpointDiscoveryRecords, TARGET_PROJECT_ENV_VAR } from "../../bridge/editor-discovery.js";
import type { BridgeResponse } from "../../shared/types.js";
import type { MinigameContract } from "./profiles/types.js";

/** Re-exec THIS CLI with the given argv, inheriting the terminal (so each shelled step looks hand-typed).
 *  `env` carries the resolved project pin so every step routes to the SAME editor (see runSceneAgnosticCheckCli). */
function spawnCli(argv: string[], env: NodeJS.ProcessEnv): number {
  const res = spawnSync(process.execPath, [process.argv[1], ...argv], { stdio: "inherit", env });
  if (res.error) {
    console.error(`[loombridge minigame] check: could not spawn step: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/** Adapt a fresh `UnityClient` to the `SceneQueryDriver` (one `scene.find_by_name` round-trip). */
function sceneQuery(client: UnityClient): SceneQueryDriver {
  return {
    op: async (command, params) => {
      try {
        const resp: BridgeResponse = await client.send(command, params);
        if (resp.status === "error") return { error: resp.error?.message ?? "bridge error" };
        return { data: (resp.data ?? {}) as Record<string, unknown> };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Resolve a scene NAME → asset path over a SHORT-LIVED bridge connection (connect → query → disconnect).
 *  Pinned to `projectPathCanonical` so it can't drift to a different editor than record/scan used.
 *  Null on any failure (the scan loop treats that scene as can't-verify, never a guess). */
async function resolveScenePathLive(sceneName: string, projectPathCanonical: string): Promise<string | null> {
  const client = new UnityClient({ targetIdentity: { projectPathCanonical } });
  try {
    await client.connect();
    return await resolveScenePathByName(sceneQuery(client), sceneName);
  } catch {
    return null;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

const readContract = async (file: string): Promise<MinigameContract> =>
  assertValidMinigameContract(JSON.parse(await fs.readFile(file, "utf-8")));

/**
 * Run the scene-agnostic `check --id <id>` (no `--scene`). Returns the process exit code. Assembles the
 * real IO and delegates the sequencing + the can't-verify-dominates verdict to `runSceneAgnosticCheck`.
 */
export async function runSceneAgnosticCheckCli(id: string, root: string = process.cwd()): Promise<number> {
  const workspace = defaultWorkspace(id);
  const contractPath = path.join(workspace, `${id}.minigame.json`);
  const traceId = `${id}-happy-path`;
  await fs.mkdir(workspace, { recursive: true });

  // Resolve the ONE editor every step routes to, BEFORE recording. With several editors open, an
  // unpinned record/scan can pick different ones (record in project A, scan opening a path in B →
  // "scene not found"). Refuse rather than misroute; pin the rest of the run to the chosen project.
  const resolution = resolveSingleEditorTarget(
    scanEndpointDiscoveryRecords(),
    process.env[TARGET_PROJECT_ENV_VAR],
  );
  if (!resolution.ok) {
    console.error(`✗ ${resolution.message}`);
    return EXIT.CANT_VERIFY;
  }
  const target = resolution.target;
  console.log(`▶ verifying against editor: ${target.projectName ?? target.projectPathCanonical}`);
  // Force every spawned CLI step to the same editor (UnityClient honours this env pin).
  const targetEnv: NodeJS.ProcessEnv = { ...process.env, [TARGET_PROJECT_ENV_VAR]: target.projectPathCanonical };

  const scanTo = async (scenePath: string, outPath: string, sceneName: string): Promise<MinigameContract> => {
    const code = spawnCli(["minigame", "scan", "--scene", scenePath, "--id", id, "--output", outPath], targetEnv);
    if (code !== 0) throw new Error(`scan of '${sceneName}' (${scenePath}) exited ${code}`);
    return readContract(outPath);
  };

  const deps: SceneAgnosticCheckDeps = {
    record: async () => {
      // --auto-state-signal: the observer auto-detects each scene's phase signal live (Phase 2 / D1-B),
      // so a multi-gesture scene (StarChef) gets per-scene gates instead of being can't-verify.
      const code = spawnCli(["trace", "record", "--observe", "--flat", "--auto-state-signal", "--id", traceId, "--root", workspace], targetEnv);
      if (code !== 0) return { error: `recording exited ${code}` };
      try {
        const file = path.join(flatReplayLayout(workspace).replayTraces, `${traceId}.trace.json`);
        return parseTrace(JSON.parse(await fs.readFile(file, "utf-8")));
      } catch (e) {
        return { error: `couldn't read the recorded trace — ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    build: (trace) =>
      buildContractFromTrace(trace, id, {
        scan: {
          resolveScenePath: (sceneName) => resolveScenePathLive(sceneName, target.projectPathCanonical),
          scanScene: (scenePath, sceneName) =>
            scanTo(scenePath, path.join(workspace, `.scan-${sceneSlug(sceneName)}.json`), sceneName),
          log: (l) => console.log(l),
        },
        singleSceneScan: (scenePath) => scanTo(scenePath, contractPath, "start scene"),
        log: (l) => console.log(l),
      }),
    writeContract: async (c) => {
      // Re-apply the developer's persisted verification-config (overrides.json) onto the freshly-built
      // contract — record-first regeneration would otherwise wipe a declared `safeAreaBackground` etc.
      // every run. Applied BEFORE the pipeline so capture/finalize/verify see it (finalize spreads the
      // draft, so these contract-level fields survive). A bad/stale override field is dropped loudly.
      const overrides = await loadOverrides(workspace);
      const { contract: merged, applied, dropped } = applyContractOverrides(c, overrides);
      if (applied.length > 0) {
        console.log(`[loombridge minigame] check: re-applied persisted overrides from ${path.basename(overridesPath(workspace))} (${applied.join(", ")}).`);
      }
      if (dropped.length > 0) {
        console.error(`[loombridge minigame] check: ignored invalid override field(s) in ${path.basename(overridesPath(workspace))}: ${dropped.join(", ")} — fix or remove them.`);
      }
      await fs.writeFile(contractPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    },
    runPipeline: () =>
      driveRun({
        inspect: () => inspectWorkspace(workspace),
        runStep: async (_at, argv) => spawnCli(argv, targetEnv),
        log: (l) => console.log(l),
      }),
    log: (l) => console.log(l),
  };

  return runSceneAgnosticCheck(deps);
}
