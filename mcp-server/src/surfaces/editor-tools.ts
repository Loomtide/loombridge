import type { UnityEndpointDiscoveryRecord } from "../shared/types.js";
import type { EditorStartupBindingDescriptor } from "../bridge/editor-registry.js";
import {
  collapseReloadChurn,
  normalizeProjectPathCanonical,
  projectPathCanonicalEquals,
} from "../bridge/editor-discovery.js";

export const EDITOR_LIST_TOOL_NAME = "loombridge_editor_list";
export const EDITOR_USE_TOOL_NAME = "loombridge_editor_use";

export const EDITOR_LIST_TOOL = {
  name: EDITOR_LIST_TOOL_NAME,
  description: "List Unity editors discovered by Loombridge and show the active/pinned editor when known.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const EDITOR_USE_TOOL = {
  name: EDITOR_USE_TOOL_NAME,
  description: "Select the active Unity editor for subsequent Loombridge calls in this MCP process.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project path canonical value, full project path, or unique project name from loombridge_editor_list.",
      },
    },
    required: ["project"],
  },
};

export interface EditorPeer {
  sessionId: string;
  projectPath?: string;
  projectPathCanonical?: string;
  projectName?: string;
  processId?: number;
  publishedAtUnixMs: number;
  expiresAtUnixMs: number;
  transportModeDefault: UnityEndpointDiscoveryRecord["transportModeDefault"];
  endpointCount: number;
  active: boolean;
  status: "discovered";
}

export interface EditorListPayload {
  peers: EditorPeer[];
  activeProjectPathCanonical: string | null;
  count: number;
  /**
   * The configured startup binding (env-strict / cwd), or null when none is configured.
   * Surfaced so an agent sees the session is auto-bound even before the first routed op.
   */
  startupBinding?: EditorStartupBindingDescriptor | null;
}

export function buildEditorListPayload(
  records: UnityEndpointDiscoveryRecord[],
  activeProjectPathCanonical: string | null,
  startupBinding?: EditorStartupBindingDescriptor | null,
): EditorListPayload {
  const active = normalizeProjectPathCanonical(activeProjectPathCanonical);
  const peers = collapseReloadChurn(records).map((record): EditorPeer => {
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    return {
      sessionId: record.sessionId,
      projectPath: record.projectPath,
      projectPathCanonical: record.projectPathCanonical,
      projectName: record.projectName,
      processId: record.processId,
      publishedAtUnixMs: record.publishedAtUnixMs,
      expiresAtUnixMs: record.expiresAtUnixMs,
      transportModeDefault: record.transportModeDefault,
      endpointCount: record.endpoints.length,
      active: Boolean(active && project && projectPathCanonicalEquals(active, project)),
      status: "discovered",
    };
  });

  return {
    peers,
    activeProjectPathCanonical: active,
    count: peers.length,
    startupBinding: startupBinding ?? null,
  };
}
