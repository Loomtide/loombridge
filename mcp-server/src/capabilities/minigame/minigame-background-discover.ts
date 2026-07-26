/**
 * Background-coverage DISCOVERY (advisory).
 *
 * Walks a live 2D mini-game scene over the bridge and auto-suggests the
 * `background-coverage` binding: the gameplay camera + the background-layer sprites that
 * cover the camera view. It scores each sprite's coverage at the WIDEST device aspect,
 * classifies coverage-layers vs decorative, and returns a structured `BackgroundCandidates`
 * recommendation — the data a later phase turns into a "suggest-and-confirm" CLI flow.
 *
 * Read-only + ADVISORY: it never mutates the project, enables no gate, and writes no files.
 * It must NOT throw on a missing/odd scene — a missing hierarchy, no orthographic camera, or
 * an unreadable sprite yields a well-formed result with an empty `recommended` and a clear
 * `warnings[]` entry. Only genuinely unexpected programmer errors propagate.
 *
 * The coverage geometry is SHARED with the `background-coverage` gate
 * (`minigame-gates/coverage-geometry.ts`): a layer set discovery calls "covered" is exactly
 * the set the gate will pass (no drift). Bridge reads mirror `minigame-background.ts`'s
 * device-invariant capture, but applied to MANY objects discovered from the hierarchy.
 */

import type { BridgeResponse } from "../../types.js";
import type { BridgeSend } from "../replay/unity-driver.js";
import {
  COVERAGE_EPSILON,
  coverageStats,
  viewRect,
  type CoverageCamera,
} from "./coverage-geometry.js";
import type {
  BackgroundCandidates,
  BackgroundCoverageByDevice,
  DiscoveredCamera,
  DiscoveredLayer,
  WorldAabb,
} from "./types.js";
import {
  parseCameraProps,
  parseSceneLocator,
  parseSpriteRendererOrder,
  unionRenderers,
} from "./minigame-background.js";
import { resolveDevices, type MinigameContract } from "./profiles/types.js";

/** A single-layer fraction at or above this is treated as a coverage layer on its own. */
const SINGLE_LAYER_COVERAGE = 0.98;
/** A recommended-union fraction at or above this (widest aspect) rescues the all-recommend case. */
const UNION_COVERAGE = 0.98;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A bridge `scene.get_hierarchy` node (only the fields we walk). */
interface RawHierNode {
  name?: string;
  locator?: { scene?: string; path?: string };
  components?: unknown;
  children?: RawHierNode[];
}

/** A discovered scene object with a Camera or SpriteRenderer component. */
interface DiscoveredNode {
  locator: string;
  name: string;
  scene?: string;
  path: string;
}

/** Build the bridge's `{scene,path}` locator and the canonical `<scene>:/<path>` string. */
function nodeLocator(node: RawHierNode): { locator: string; scene?: string; path: string } | null {
  const scene = node.locator?.scene;
  const path = node.locator?.path;
  if (typeof path !== "string" || path.length === 0) return null;
  const locator = typeof scene === "string" && scene.length > 0 ? `${scene}:${path}` : path;
  return { locator, scene, path };
}

/** Components array → lowercase set (defensive against odd shapes). */
function componentSet(components: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(components)) {
    for (const c of components) {
      if (typeof c === "string") out.add(c);
    }
  }
  return out;
}

/** Recursively collect camera + sprite nodes from a hierarchy forest. */
function collectNodes(
  roots: RawHierNode[],
): { cameras: DiscoveredNode[]; sprites: DiscoveredNode[] } {
  const cameras: DiscoveredNode[] = [];
  const sprites: DiscoveredNode[] = [];
  const walk = (node: RawHierNode): void => {
    const loc = nodeLocator(node);
    if (loc) {
      const comps = componentSet(node.components);
      const name = typeof node.name === "string" ? node.name : (loc.path.split("/").pop() ?? loc.path);
      const entry: DiscoveredNode = { locator: loc.locator, name, scene: loc.scene, path: loc.path };
      if (comps.has("Camera")) cameras.push(entry);
      if (comps.has("SpriteRenderer")) sprites.push(entry);
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return { cameras, sprites };
}

/** A raw bounds result's world position (transform.position) or null. */
function readPosition(data: Record<string, unknown>): { x: number; y: number } | null {
  const transform = data.transform as { position?: { x?: unknown; y?: unknown } } | undefined;
  const pos = transform?.position;
  if (pos && isFiniteNum(pos.x) && isFiniteNum(pos.y)) return { x: pos.x, y: pos.y };
  return null;
}

function readZ(data: Record<string, unknown>): number {
  const transform = data.transform as { position?: { z?: unknown } } | undefined;
  const z = transform?.position?.z;
  return isFiniteNum(z) ? z : 0;
}

function dataOrNull(res: BridgeResponse): Record<string, unknown> | null {
  if (res.status === "error") return null;
  return (res.data ?? {}) as Record<string, unknown>;
}

/**
 * Send a bridge command and return its data, or null on ANY failure — an error status OR a
 * transport REJECTION (a connection-lost at the end of a long capture). Discovery is advisory
 * and documented as never-throwing, so a rejected per-node read must be a skipped node, not an
 * escaping exception.
 */
async function safeSend(
  send: BridgeSend,
  command: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    return dataOrNull(await send(command, params));
  } catch {
    return null;
  }
}

/**
 * Walk the live scene and recommend a background geometry binding (camera + layers), scored
 * against the contract's device set. Advisory + read-only; never throws on an odd scene.
 */
export async function discoverBackgroundCandidates(
  send: BridgeSend,
  contract: MinigameContract,
): Promise<BackgroundCandidates> {
  const warnings: string[] = [];
  const empty = (): BackgroundCandidates => ({
    cameras: [],
    recommended: [],
    excluded: [],
    allLayers: [],
    coverageByDevice: [],
    warnings,
  });

  // 1. Hierarchy → camera + sprite nodes. An unreadable hierarchy is advisory-empty, not a throw.
  let hierData: Record<string, unknown> | null = null;
  try {
    hierData = dataOrNull(await send("scene.get_hierarchy", { depth: -1 }));
  } catch {
    hierData = null;
  }
  if (!hierData) {
    warnings.push("could not read the scene hierarchy (scene.get_hierarchy failed) — cannot suggest a background binding.");
    return empty();
  }
  const scenes = (hierData.scenes as { rootObjects?: RawHierNode[] }[] | undefined) ?? [];
  const roots: RawHierNode[] = [];
  for (const s of scenes) roots.push(...(s.rootObjects ?? []));
  const { cameras: cameraNodes, sprites: spriteNodes } = collectNodes(roots);

  // 2. Cameras: read position + orthographic/size; keep the orthographic ones.
  const orthoCameras: DiscoveredCamera[] = [];
  for (const node of cameraNodes) {
    const boundsData = await safeSend(send, "scene.get_bounds", { locator: { scene: node.scene, path: node.path } });
    const position = boundsData ? readPosition(boundsData) : null;
    const propsData = await safeSend(send, "component.get_properties", {
      locator: { scene: node.scene, path: node.path },
      type_name: "Camera",
    });
    const props = propsData && Array.isArray(propsData.properties) ? propsData.properties : undefined;
    const parsed = propsData ? parseCameraProps(props as Parameters<typeof parseCameraProps>[0]) : null;
    if (!position || !parsed || !parsed.orthographic) continue;
    orthoCameras.push({
      locator: node.locator,
      name: node.name,
      orthographic: true,
      orthoSize: parsed.orthoSize,
      position,
    });
  }

  // Choose the gameplay camera: the single orthographic one, else prefer "Main Camera".
  let camera: DiscoveredCamera | undefined;
  if (orthoCameras.length === 1) {
    camera = orthoCameras[0];
  } else if (orthoCameras.length > 1) {
    const main = orthoCameras.filter((c) => c.name.toLowerCase() === "main camera");
    if (main.length === 1) {
      camera = main[0];
    } else {
      warnings.push(
        `${orthoCameras.length} orthographic cameras found (${orthoCameras.map((c) => c.locator).join(", ")}) — pass --background-camera to disambiguate.`,
      );
    }
  } else {
    warnings.push("no orthographic camera found — background coverage is only defined for an orthographic 2D camera.");
  }

  // 3. Layers: each sprite's world AABB (union renderers). Skip unreadable ones.
  const layers: { locator: string; name: string; aabb: WorldAabb; order?: DiscoveredLayer["order"] }[] = [];
  for (const node of spriteNodes) {
    const boundsData = await safeSend(send, "scene.get_bounds", { locator: { scene: node.scene, path: node.path } });
    if (!boundsData) continue; // bridge error/rejection on this sprite → skip (don't throw)
    const renderers = Array.isArray(boundsData.renderers) ? boundsData.renderers : undefined;
    const aabb = unionRenderers(renderers as Parameters<typeof unionRenderers>[0]);
    if (!aabb) continue;
    const spritePropsData = await safeSend(send, "component.get_properties", {
      locator: { scene: node.scene, path: node.path },
      type_name: "SpriteRenderer",
    });
    const props = spritePropsData && Array.isArray(spritePropsData.properties) ? spritePropsData.properties : undefined;
    const order = spritePropsData ? parseSpriteRendererOrder(props as Parameters<typeof parseSpriteRendererOrder>[0], readZ(boundsData)) : undefined;
    layers.push({ locator: node.locator, name: node.name, aabb, order: order ?? undefined });
  }

  // Every discovered sprite with usable bounds — the geometry source for an explicit
  // `--background-layers` override (recommended + excluded sprites alike carry an AABB here).
  const allLayers = layers.map((l) => ({ locator: l.locator, aabb: l.aabb, order: l.order }));

  // No chosen camera → we can still report the cameras for disambiguation, but cannot score.
  if (!camera) {
    return { camera: undefined, cameras: orthoCameras, recommended: [], excluded: [], allLayers, coverageByDevice: [], warnings };
  }

  const cov: CoverageCamera = { orthoSize: camera.orthoSize, position: camera.position };
  const devices = resolveDevices(contract);
  const aspects = devices.map((d) => (d.height > 0 ? d.width / d.height : 0)).filter((a) => a > 0);
  const widestAspect = aspects.length > 0 ? Math.max(...aspects) : 1;

  // 4. Score + classify each layer at the WIDEST aspect.
  const widestRect = viewRect(cov, widestAspect);
  const scored: DiscoveredLayer[] = layers.map((l) => {
    const widestFraction = coverageStats([l.aabb], cov, widestAspect).fraction;
    const fullWidthBand =
      l.aabb.min.x <= widestRect.left + COVERAGE_EPSILON && l.aabb.max.x >= widestRect.right - COVERAGE_EPSILON;
    return { locator: l.locator, name: l.name, aabb: l.aabb, widestFraction, fullWidthBand, order: l.order };
  });

  const recommended: DiscoveredLayer[] = [];
  const excluded: { locator: string; name: string; reason: string }[] = [];
  for (const s of scored) {
    if (s.fullWidthBand || s.widestFraction >= SINGLE_LAYER_COVERAGE) {
      recommended.push(s);
    } else {
      excluded.push({
        locator: s.locator,
        name: s.name,
        reason: `decorative: covers ${(s.widestFraction * 100).toFixed(0)}% of the frame, not a full-width band`,
      });
    }
  }

  // Edge case: nothing qualifies as full-width, but the UNION of ALL layers covers the WIDEST
  // aspect (single-image background / tiled set) → recommend all rather than exclude everything.
  // Score at the widest aspect (NOT the base) so the rescue stays consistent with the gate, which
  // grades EVERY device aspect — a set that covers only the base but gaps at the wide aspect must
  // NOT be all-recommended here (it would recommend a set the gate then fails at the wide aspect).
  if (recommended.length === 0 && scored.length > 0) {
    const unionFraction = coverageStats(scored.map((s) => s.aabb), cov, widestAspect).fraction;
    if (unionFraction >= UNION_COVERAGE) {
      recommended.push(...scored);
      excluded.length = 0;
    }
  }

  if (recommended.length === 0 && scored.length > 0) {
    warnings.push("no background layer qualified as a coverage band — all sprites look decorative; pass --background-layers to override.");
  }

  // 5. Per-device union coverage of the RECOMMENDED set (the proof text a later phase prints).
  const recommendedAabbs = recommended.map((r) => r.aabb);
  const coverageByDevice: BackgroundCoverageByDevice[] = [];
  for (const d of devices) {
    const aspect = d.height > 0 ? d.width / d.height : 0;
    if (aspect <= 0) continue;
    const stats = coverageStats(recommendedAabbs, cov, aspect);
    const gapEdges = (["left", "right", "top", "bottom"] as const).filter((e) => stats.sideGaps[e] > 0);
    coverageByDevice.push({ deviceId: d.id, label: d.label, fraction: stats.fraction, gapEdges });
  }

  return { camera, cameras: orthoCameras, recommended, excluded, allLayers, coverageByDevice, warnings };
}
