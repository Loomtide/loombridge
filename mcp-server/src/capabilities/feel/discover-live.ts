/**
 * Generic feel setup discovery — live bridge shell.
 *
 * The pure classifiers live in `discover.ts`; this module is the thin online
 * layer that asks a live editor for the facts they consume (a `ui.get_screen_rects`
 * dump and, optionally, an Animator controller's parameters). Every bridge read is
 * defensive: a failure yields empty facts, so discovery degrades to "nothing
 * proposed" rather than crashing or inventing a binding.
 */

import type { BridgeResponse } from "../../types.js";
import { createUnityClientForCli } from "../verification/unity-client-resolver.js";
import { resilientSend } from "../replay/resilient-send.js";
import type { BridgeSend } from "../replay/unity-driver.js";
import type { RawScreenRects } from "../minigame/minigame-capture-plan.js";
import {
  discoverUiControls,
  proposeAnimatorBool,
  type AnimatorBoolProposal,
  type AnimatorParameter,
  type FeelUiDiscovery,
} from "./discover.js";

export interface FeelDiscoveryResult {
  ui: FeelUiDiscovery;
  animatorBool?: AnimatorBoolProposal;
}

function dataOf(res: BridgeResponse): Record<string, unknown> | null {
  if (res.status === "error") return null;
  return (res.data ?? {}) as Record<string, unknown>;
}

async function openSceneForDiscovery(send: BridgeSend, scene: string): Promise<void> {
  await send("editor.stop", {}, 30000);
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
  const opened = await send("scene.open_scene", { path: scenePathFor(scene), mode: "Single" }, 30000);
  if (opened.status === "error") {
    throw new Error(opened.error?.message ?? `scene.open_scene failed for ${scene}`);
  }
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
}

function scenePathFor(scene: string): string {
  if (scene.endsWith(".unity") || scene.includes("/")) return scene;
  return `Assets/Scenes/${scene}.unity`;
}

/** Best-effort: read an Animator controller's parameters; [] on any failure. */
async function fetchAnimatorParameters(send: BridgeSend, controllerPath: string): Promise<AnimatorParameter[]> {
  try {
    const data = dataOf(await send("animator.get_state_machine", { path: controllerPath }, 15000));
    const params = data?.parameters;
    if (!Array.isArray(params)) return [];
    return params
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && typeof (p as { name?: unknown }).name === "string")
      .map((p) => ({ name: p.name as string, type: typeof p.type === "string" ? p.type : undefined }));
  } catch {
    return [];
  }
}

/**
 * Discover facts through an injected sender (testable without a live editor).
 * Opens the scene when one is given, dumps screen rects, and — when a controller
 * path or explicit bool is supplied — proposes an Animator bool sync signal.
 */
export async function discoverFeelSetup(args: {
  send: BridgeSend;
  scene?: string;
  animatorControllerPath?: string;
  animatorBool?: string;
}): Promise<FeelDiscoveryResult> {
  if (args.scene) await openSceneForDiscovery(args.send, args.scene);

  let ui: FeelUiDiscovery;
  try {
    const rects = dataOf(await args.send("ui.get_screen_rects", {}, 15000));
    ui = discoverUiControls((rects ?? {}) as RawScreenRects);
  } catch {
    ui = { controls: [], jump: { kind: "none" }, joystick: { kind: "none" } };
  }

  let animatorBool: AnimatorBoolProposal | undefined;
  if (args.animatorBool || args.animatorControllerPath) {
    const params = args.animatorControllerPath
      ? await fetchAnimatorParameters(args.send, args.animatorControllerPath)
      : [];
    animatorBool = proposeAnimatorBool(params, args.animatorBool);
  }

  return { ui, animatorBool };
}

export interface RunFeelDiscoveryArgs {
  project?: string;
  scene?: string;
  animatorControllerPath?: string;
  animatorBool?: string;
}

/** Connect to a (project-routed) live editor, discover, and always disconnect. */
export async function runFeelDiscovery(args: RunFeelDiscoveryArgs): Promise<FeelDiscoveryResult> {
  const resolved = createUnityClientForCli({ project: args.project });
  const send = resilientSend(resolved.client);
  try {
    await resolved.client.connect();
    return await discoverFeelSetup({
      send,
      scene: args.scene,
      animatorControllerPath: args.animatorControllerPath,
      animatorBool: args.animatorBool,
    });
  } finally {
    try {
      await resolved.disconnect();
    } catch {
      // Best-effort cleanup; the discovery result is already determined.
    }
  }
}
