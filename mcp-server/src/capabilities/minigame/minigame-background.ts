/**
 * `background.json` capture for the background geometry gates (Phase 5+).
 *
 * The gates are deterministic GEOMETRY: the world-space background sprites must cover the
 * camera's view and hide interior cut edges at EVERY device aspect. World geometry doesn't
 * change with the Game-View aspect, so this pack is captured ONCE (device-invariant) and
 * written as ONE scene-level `background.json` — the per-aspect view rect is derived by the
 * evaluator from the camera's `orthoSize` × aspect.
 *
 * Bridge reads (all read-only — never mutates the project):
 *   - camera: `scene.get_bounds {locator}` → `transform.position` (world x,y); and
 *     `component.get_properties {locator, type_name:"Camera"}` → the `orthographic` (bool)
 *     + `orthographic size` (float) serialized values, parsed from `properties[]`.
 *   - each layer: `scene.get_bounds {locator}` → `renderers[].min`/`max` world AABB (a
 *     layer may have multiple renderers — union them).
 *
 * Honest-or-stop: a declared layer/camera the bridge can't read THROWS (the caller fails
 * the capture loudly) — it never writes a partial background.json that would read as
 * covered. The pure transforms (`parseCameraProps`, `unionRenderers`, locator parsing) are
 * exported + unit-tested with no live bridge.
 */

import type { BridgeResponse } from "../../shared/types.js";
import type { BridgeSend } from "../replay/unity-driver.js";
import type {
  BackgroundCamera,
  BackgroundData,
  BackgroundLayer,
  BackgroundLayerOrder,
  WorldAabb,
} from "./types.js";
import type { MinigameContract } from "./profiles/types.js";

/** A scene-object locator as the bridge wants it: `{ scene?, path }`. */
export interface SceneLocator {
  scene?: string;
  path: string;
}

/**
 * Parse a contract locator string into the bridge's `{ scene, path }` shape. Loombridge
 * locators are `SceneName:/Path/To/Object` (or a bare `/Path`). Splits on the FIRST `:`
 * (a path never contains `:`), so `CountTheFruits:/Main Camera` → `{ scene, path }`.
 */
export function parseSceneLocator(locator: string): SceneLocator {
  const colon = locator.indexOf(":");
  if (colon < 0) return { path: locator };
  return { scene: locator.slice(0, colon), path: locator.slice(colon + 1) };
}

/** A `scene.get_bounds` renderer entry (min/max are world Vector3s; we use x,y). */
interface RawRendererBounds {
  min?: { x?: number; y?: number };
  max?: { x?: number; y?: number };
}

/** The fields of `scene.get_bounds` we read. */
interface RawBoundsResult {
  transform?: { position?: { x?: number; y?: number; z?: number } };
  renderers?: RawRendererBounds[];
}

/** One descriptor from `component.get_properties`. */
interface RawPropDescriptor {
  displayName?: string;
  serializedPath?: string;
  currentValue?: unknown;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Union every renderer's world AABB (x,y) on a layer into one box. Returns null when no
 * renderer has usable min/max (the caller fails loudly — never an assumed-covered layer).
 */
export function unionRenderers(renderers: RawRendererBounds[] | undefined): WorldAabb | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const r of renderers ?? []) {
    if (!isFiniteNum(r.min?.x) || !isFiniteNum(r.min?.y) || !isFiniteNum(r.max?.x) || !isFiniteNum(r.max?.y)) {
      continue;
    }
    minX = Math.min(minX, r.min!.x!);
    minY = Math.min(minY, r.min!.y!);
    maxX = Math.max(maxX, r.max!.x!);
    maxY = Math.max(maxY, r.max!.y!);
    any = true;
  }
  return any ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/**
 * Parse the camera's `orthographic` (bool) + `orthographic size` (float) from a
 * `component.get_properties` `properties[]` array. Matches on the serialized path
 * (`m_Orthographic` / `m_OrthographicSize`) OR the display name as a fallback. Returns
 * null when either value is absent/unparseable (the caller fails loudly).
 */
export function parseCameraProps(
  props: RawPropDescriptor[] | undefined,
): { orthographic: boolean; orthoSize: number } | null {
  let orthographic: boolean | undefined;
  let orthoSize: number | undefined;
  for (const p of props ?? []) {
    const path = (p.serializedPath ?? "").toLowerCase();
    const name = (p.displayName ?? "").toLowerCase();
    // Orthographic size first (its path/name contains "orthographic", so test the more
    // specific "size" match before the bare projection flag).
    if (path === "m_orthographicsize" || name === "size" || name === "orthographic size") {
      if (isFiniteNum(p.currentValue)) orthoSize = p.currentValue;
      continue;
    }
    if (path === "m_orthographic" || name === "orthographic" || name === "projection") {
      // `m_Orthographic` is a bool; a "Projection" enum is 0=Perspective/1=Orthographic.
      if (typeof p.currentValue === "boolean") orthographic = p.currentValue;
      else if (typeof p.currentValue === "number") orthographic = p.currentValue === 1;
      else if (typeof p.currentValue === "string") orthographic = p.currentValue.toLowerCase() === "orthographic";
    }
  }
  if (orthographic === undefined || !isFiniteNum(orthoSize)) return null;
  return { orthographic, orthoSize };
}

/**
 * Parse SpriteRenderer order fields from a `component.get_properties` result.
 * Unity exposes these with slightly different display names across versions, so
 * match both serialized paths and human names. `z` is read from transform.position
 * separately because renderer sorting order alone is not enough for tied sprites.
 */
export function parseSpriteRendererOrder(
  props: RawPropDescriptor[] | undefined,
  z: number,
): BackgroundLayerOrder | null {
  let sortingOrder: number | undefined;
  let sortingLayerId: number | undefined;
  let sortingLayerName: string | undefined;
  for (const p of props ?? []) {
    const path = (p.serializedPath ?? "").toLowerCase();
    const name = (p.displayName ?? "").toLowerCase();
    if (path === "m_sortingorder" || name === "order in layer" || name === "sorting order") {
      if (isFiniteNum(p.currentValue)) sortingOrder = p.currentValue;
      continue;
    }
    if (path === "m_sortinglayerid" || name === "sorting layer id") {
      if (isFiniteNum(p.currentValue)) sortingLayerId = p.currentValue;
      continue;
    }
    if (path === "m_sortinglayer" || name === "sorting layer" || name === "sorting layer name") {
      if (typeof p.currentValue === "string" && p.currentValue.length > 0) sortingLayerName = p.currentValue;
    }
  }
  if (!isFiniteNum(sortingOrder) || !isFiniteNum(z)) return null;
  const order: BackgroundLayerOrder = { sortingOrder, z };
  if (sortingLayerId !== undefined) order.sortingLayerId = sortingLayerId;
  if (sortingLayerName !== undefined) order.sortingLayerName = sortingLayerName;
  return order;
}

function dataOf(res: BridgeResponse, what: string): Record<string, unknown> {
  if (res.status === "error") {
    throw new Error(`${what} failed: ${res.error?.message ?? "unknown bridge error"}`);
  }
  return (res.data ?? {}) as Record<string, unknown>;
}

/**
 * Read the device-INVARIANT `background.json` geometry for the background geometry gates.
 * Reads the camera (position + orthographic/size) and each declared layer's world AABB via
 * the bridge `send`. THROWS on any unreadable camera/layer (honest-or-stop) so the caller
 * never writes a partial pack that reads as covered. Pure aside from the bridge reads.
 */
export async function captureBackgroundData(
  send: BridgeSend,
  contract: MinigameContract,
): Promise<BackgroundData> {
  const cameraLocator = contract.backgroundCamera;
  const layerLocators = contract.backgroundLayers ?? [];
  if (typeof cameraLocator !== "string" || cameraLocator.trim().length === 0) {
    throw new Error("background geometry is enabled but contract.backgroundCamera is missing — cannot capture background.json.");
  }
  if (layerLocators.length === 0) {
    throw new Error("background geometry is enabled but contract.backgroundLayers is empty — cannot capture background.json.");
  }

  // Camera world position (from get_bounds.transform.position).
  const camBounds = dataOf(
    await send("scene.get_bounds", { locator: parseSceneLocator(cameraLocator) }),
    `scene.get_bounds for background camera '${cameraLocator}'`,
  ) as RawBoundsResult;
  const pos = camBounds.transform?.position;
  if (!isFiniteNum(pos?.x) || !isFiniteNum(pos?.y)) {
    throw new Error(`background camera '${cameraLocator}' has no usable transform.position — refusing to write a partial background.json.`);
  }

  // Camera orthographic flag + size (from component.get_properties).
  const camProps = dataOf(
    await send("component.get_properties", { locator: parseSceneLocator(cameraLocator), type_name: "Camera" }),
    `component.get_properties Camera for '${cameraLocator}'`,
  );
  const parsed = parseCameraProps(camProps.properties as RawPropDescriptor[] | undefined);
  if (!parsed) {
    throw new Error(`background camera '${cameraLocator}' did not report a usable orthographic flag + orthographic size — refusing to write a partial background.json.`);
  }

  const camera: BackgroundCamera = {
    orthographic: parsed.orthographic,
    orthoSize: parsed.orthoSize,
    position: { x: pos!.x!, y: pos!.y! },
  };

  // Each layer's world AABB (union its renderers).
  const layers: BackgroundLayer[] = [];
  for (const locator of layerLocators) {
    const bounds = dataOf(
      await send("scene.get_bounds", { locator: parseSceneLocator(locator) }),
      `scene.get_bounds for background layer '${locator}'`,
    ) as RawBoundsResult;
    const aabb = unionRenderers(bounds.renderers);
    if (!aabb) {
      throw new Error(`background layer '${locator}' has no renderer bounds — refusing to write a partial background.json that would read as covered.`);
    }
    const layerPos = bounds.transform?.position;
    const z = isFiniteNum(layerPos?.z) ? layerPos.z : 0;
    const spriteProps = dataOf(
      await send("component.get_properties", { locator: parseSceneLocator(locator), type_name: "SpriteRenderer" }),
      `component.get_properties SpriteRenderer for '${locator}'`,
    );
    const order = parseSpriteRendererOrder(spriteProps.properties as RawPropDescriptor[] | undefined, z);
    if (!order) {
      throw new Error(`background layer '${locator}' did not report a usable SpriteRenderer sorting order — refusing to write a background.json that cannot support seam detection.`);
    }
    layers.push({ locator, ...aabb, order });
  }

  return { camera, layers };
}
