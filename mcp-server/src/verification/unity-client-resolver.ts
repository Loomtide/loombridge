import {
  EditorRegistry,
  type EditorRoute,
} from "../editor-registry.js";
import type { UnityEndpointDiscoveryRecord } from "../types.js";
import type { UnityClient } from "../unity-client.js";

export const UNITY_PROJECT_ENV_VAR = "LOOMBRIDGE_UNITY_PROJECT";

export interface UnityClientResolverOptions {
  project?: unknown;
  env?: NodeJS.ProcessEnv;
  scanRecords?: () => UnityEndpointDiscoveryRecord[];
}

export interface ResolvedUnityClient {
  client: UnityClient;
  route: EditorRoute;
  projectTarget: string | null;
  disconnect(): Promise<void>;
}

export interface UnityRoutingMetadata {
  projectTarget: string | null;
  projectPathCanonical?: string;
  projectName?: string;
  editorSessionId?: string;
  processId?: number;
  routeReason: EditorRoute["reason"];
}

export function resolveUnityProjectTarget(
  project: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof project === "string" && project.trim().length > 0) {
    return project.trim();
  }
  const envProject = env[UNITY_PROJECT_ENV_VAR];
  return typeof envProject === "string" && envProject.trim().length > 0
    ? envProject.trim()
    : null;
}

export function createUnityClientForCli(
  options: UnityClientResolverOptions = {},
): ResolvedUnityClient {
  const registry = new EditorRegistry({
    scanRecords: options.scanRecords,
  });
  const projectTarget = resolveUnityProjectTarget(options.project, options.env);
  const route = registry.selectEditor(projectTarget);
  return {
    client: route.client,
    route,
    projectTarget,
    disconnect: () => registry.disconnectAll(),
  };
}

export function buildUnityRoutingMetadata(resolved: ResolvedUnityClient): UnityRoutingMetadata {
  const handshake = resolved.client.handshake;
  return {
    projectTarget: resolved.projectTarget,
    projectPathCanonical:
      handshake?.projectPathCanonical
      ?? resolved.route.projectPathCanonical
      ?? resolved.route.record?.projectPathCanonical,
    projectName: handshake?.projectName ?? resolved.route.record?.projectName,
    editorSessionId: handshake?.sessionId ?? resolved.route.record?.sessionId,
    processId: handshake?.processId ?? resolved.route.record?.processId,
    routeReason: resolved.route.reason,
  };
}
