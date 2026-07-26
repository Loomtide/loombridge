import {
  collapseReloadChurn,
  normalizeProjectPathCanonical,
  projectPathCanonicalEquals,
  projectPathsEquivalent,
  scanEndpointDiscoveryRecords,
} from "./editor-discovery.js";
import type { McpStartupProjectBinding } from "./startup-binding.js";
import type { UnityEndpointDiscoveryRecord } from "../shared/types.js";
import { UnityClient } from "./unity-client.js";

export interface EditorRoute {
  client: UnityClient;
  projectPathCanonical: string | null;
  record: UnityEndpointDiscoveryRecord | null;
  reason: "target" | "active" | "single" | "legacy";
}

/**
 * Display-only descriptor for the configured startup binding, surfaced in the
 * `loombridge_editor_list` payload so an agent can see the session is auto-bound even before
 * the first routed op commits it. `resolved` = "the configured target currently maps to
 * exactly one discovered editor". Null in the payload when the binding kind is "none".
 */
export interface EditorStartupBindingDescriptor {
  kind: "strict" | "cwd";
  target: string;
  resolved: boolean;
}

export class EditorRoutingError extends Error {
  readonly code: "EDITOR_AMBIGUOUS" | "EDITOR_NOT_FOUND";
  readonly peers: UnityEndpointDiscoveryRecord[];

  constructor(
    code: "EDITOR_AMBIGUOUS" | "EDITOR_NOT_FOUND",
    message: string,
    peers: UnityEndpointDiscoveryRecord[],
  ) {
    super(message);
    this.name = "EditorRoutingError";
    this.code = code;
    this.peers = peers;
  }
}

export interface EditorRegistryEvents {
  onClientCreated?: (client: UnityClient, projectPathCanonical: string | null) => void;
}

export interface EditorRegistryOptions extends EditorRegistryEvents {
  scanRecords?: () => UnityEndpointDiscoveryRecord[];
  /** Injectable clock (ms) for deterministic eviction tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Persistent startup project binding inferred at process boot (env-strict or cwd).
   * Applied on an untargeted `selectEditor()` when no active editor is pinned. It is NOT
   * consumed once: if the bound editor disappears past the grace window and later returns,
   * the next untargeted call re-binds to it. See `resolveMcpStartupProjectBinding`.
   */
  startupBinding?: McpStartupProjectBinding;
}

/**
 * Grace period before a per-project client is evicted for being absent from discovery.
 * Kept well above the 60s discovery TTL so a single refresh/TTL blip never evicts a
 * still-live editor.
 */
const EVICT_GRACE_MS = 120_000;

export class EditorRegistry {
  private readonly _clientsByProject = new Map<string, UnityClient>();
  private readonly _queueByProject = new Map<string, Promise<unknown>>();
  private readonly _lastSeenByProject = new Map<string, number>();
  private readonly _legacyClient: UnityClient;
  private _activeProjectPathCanonical: string | null = null;
  private readonly _events: EditorRegistryEvents;
  private readonly _scanRecords: () => UnityEndpointDiscoveryRecord[];
  private readonly _now: () => number;
  private readonly _startupBinding: McpStartupProjectBinding;

  constructor(options: EditorRegistryOptions = {}) {
    this._events = options;
    this._scanRecords = options.scanRecords ?? scanEndpointDiscoveryRecords;
    this._now = options.now ?? (() => Date.now());
    this._startupBinding = options.startupBinding ?? { kind: "none" };
    this._legacyClient = new UnityClient();
    this._events.onClientCreated?.(this._legacyClient, null);
  }

  get activeProjectPathCanonical(): string | null {
    return this._activeProjectPathCanonical;
  }

  /** Read-only view of the configured startup binding (env-strict / cwd / none). */
  get startupBinding(): McpStartupProjectBinding {
    return this._startupBinding;
  }

  listRecords(): UnityEndpointDiscoveryRecord[] {
    return collapseReloadChurn(this._scanRecords());
  }

  /**
   * Compute the display state for `loombridge_editor_list` WITHOUT mutating routing state.
   *
   * This is the read-only counterpart to `selectEditor`/`_tryStartupBinding`: it never sets
   * `_activeProjectPathCanonical`, never throws, and never creates clients. Listing must stay
   * side-effect-free — the first real routed op is still what commits the binding.
   *
   * `effectiveActiveProjectPathCanonical` is:
   *   1. the committed active pin if one exists, else
   *   2. the startup binding *peeked* against `records` (the target maps to exactly one
   *      discovered editor), else
   *   3. null.
   *
   * `startupBinding` is a `{kind,target,resolved}` descriptor (null when kind is "none"),
   * where `resolved` = "the configured target currently maps to exactly one discovered
   * editor". A strict target matching two editors, or a duplicate-name ambiguity, is treated
   * as unresolved (we can't safely pick one for display).
   */
  describeListDisplayState(
    records: UnityEndpointDiscoveryRecord[],
  ): {
    effectiveActiveProjectPathCanonical: string | null;
    startupBinding: EditorStartupBindingDescriptor | null;
  } {
    const binding = this._startupBinding;

    // Peek the binding against the records without committing it. A no-match or any
    // ambiguity (EDITOR_AMBIGUOUS from a duplicate path/name) yields null → unresolved.
    let peekedProject: string | null = null;
    if (binding.kind !== "none") {
      try {
        const record = resolveTargetRecord(records, binding.target, { requireMatch: false });
        peekedProject = record
          ? normalizeProjectPathCanonical(record.projectPathCanonical)
          : null;
      } catch {
        // EDITOR_AMBIGUOUS (duplicate path/name) — can't safely pick one for display.
        peekedProject = null;
      }
    }

    const effectiveActiveProjectPathCanonical =
      this._activeProjectPathCanonical ?? peekedProject;

    const startupBinding: EditorStartupBindingDescriptor | null =
      binding.kind === "none"
        ? null
        : { kind: binding.kind, target: binding.target, resolved: peekedProject !== null };

    return { effectiveActiveProjectPathCanonical, startupBinding };
  }

  async disconnectAll(): Promise<void> {
    const clients = new Set<UnityClient>([
      this._legacyClient,
      ...this._clientsByProject.values(),
    ]);
    await Promise.all([...clients].map((client) => client.disconnect()));
  }

  selectEditor(targetProject?: unknown): EditorRoute {
    const target = normalizeProjectPathCanonical(
      typeof targetProject === "string" ? targetProject : null,
    );
    const records = this.listRecords();
    this._refreshLastSeenAndReap(records);

    if (target) {
      const record = resolveTargetRecord(records, target, { requireMatch: true });
      if (!record) {
        throw new EditorRoutingError(
          "EDITOR_NOT_FOUND",
          `No discovered Unity editor matches '${target}'.`,
          records,
        );
      }
      const project = normalizeProjectPathCanonical(record.projectPathCanonical);
      if (!project) {
        throw new EditorRoutingError(
          "EDITOR_NOT_FOUND",
          `Discovered editor for '${target}' did not report projectPathCanonical.`,
          records,
        );
      }
      return {
        client: this._clientForProject(project),
        projectPathCanonical: project,
        record,
        reason: "target",
      };
    }

    if (this._activeProjectPathCanonical) {
      const record = resolveTargetRecord(records, this._activeProjectPathCanonical);
      if (!record) {
        // Don't drop the active pin on a single transient empty scan (a TTL/refresh
        // blip). Only clear it once the editor has been absent beyond the grace window;
        // within the window, keep routing to the (likely still-connected) active client.
        const key = projectMapKey(this._activeProjectPathCanonical);
        const lastSeen = this._lastSeenByProject.get(key) ?? 0;
        if (this._now() - lastSeen > EVICT_GRACE_MS) {
          const activeProjectPathCanonical = this._activeProjectPathCanonical;
          this._activeProjectPathCanonical = null;
          throw new EditorRoutingError(
            "EDITOR_NOT_FOUND",
            `Active Unity editor '${activeProjectPathCanonical}' is no longer discovered. Run loombridge_editor_list and select an active editor again.`,
            records,
          );
        }
      }
      return {
        client: this._clientForProject(this._activeProjectPathCanonical),
        projectPathCanonical: this._activeProjectPathCanonical,
        record: record ?? null,
        reason: "active",
      };
    }

    // No active pin: apply the persistent startup binding (env-strict or cwd, both
    // fail-closed) before the zero-config single-editor fallback. The binding is not
    // consumed — once the active pin is set below it short-circuits here, but if that pin is
    // later cleared (editor gone past grace) this branch re-asserts and re-binds the
    // returning editor.
    const startupRoute = this._tryStartupBinding(records);
    if (startupRoute) {
      return startupRoute;
    }

    if (records.length === 1) {
      const record = records[0]!;
      const project = normalizeProjectPathCanonical(record.projectPathCanonical);
      if (project) {
        return {
          client: this._clientForProject(project),
          projectPathCanonical: project,
          record,
          reason: "single",
        };
      }
    }

    if (records.length > 1) {
      throw new EditorRoutingError(
        "EDITOR_AMBIGUOUS",
        "Multiple Unity editors are open. Select one with loombridge_editor_use or pass a top-level project parameter.",
        records,
      );
    }

    return {
      client: this._legacyClient,
      projectPathCanonical: null,
      record: null,
      reason: "legacy",
    };
  }

  /**
   * Resolve the persistent startup binding against the current discovery records.
   *
   * - `none`            → `null` (no binding; caller continues to single/ambiguous fallbacks).
   * - `strict` / `cwd`  → both fail closed, identically: the target MUST resolve to a
   *   discovered editor; if it does not, throw `EDITOR_NOT_FOUND` regardless of editor count
   *   — including the zero-record cold-discovery case (v1 hard fail). A startup binding must
   *   NEVER route to a non-matching single editor. The binding is named by its *source*
   *   (env vs cwd), not by how strictly it is enforced. Matches today's per-call `project`
   *   semantics.
   *
   * On a successful resolve, `_activeProjectPathCanonical` is pinned to the matched
   * record's canonical path so subsequent calls and `editor_list` reflect the auto-binding.
   */
  private _tryStartupBinding(
    records: UnityEndpointDiscoveryRecord[],
  ): EditorRoute | null {
    const binding = this._startupBinding;
    if (binding.kind === "none") {
      return null;
    }
    // env-strict and cwd take the identical fail-closed path; the kind only names the source.
    return this._resolveFailClosed(records, binding.target);
  }

  /**
   * Fail-closed resolution shared by both startup binding kinds (env-strict and cwd):
   * resolve `target` to exactly one discovered editor or throw (`EDITOR_NOT_FOUND` on no
   * match, `EDITOR_AMBIGUOUS` on a duplicate path/name). Never falls through to a
   * non-matching editor; pins `_activeProjectPathCanonical` on success.
   */
  private _resolveFailClosed(
    records: UnityEndpointDiscoveryRecord[],
    target: string,
  ): EditorRoute {
    // requireMatch:true makes resolveTargetRecord throw EDITOR_NOT_FOUND (with the peer
    // list) on no match — including the zero-record cold-discovery case (v1 hard fail).
    const record = resolveTargetRecord(records, target, { requireMatch: true })!;
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    if (!project) {
      throw new EditorRoutingError(
        "EDITOR_NOT_FOUND",
        `Discovered editor for '${target}' did not report projectPathCanonical.`,
        records,
      );
    }
    this._activeProjectPathCanonical = project;
    return {
      client: this._clientForProject(project),
      projectPathCanonical: project,
      record,
      reason: "active",
    };
  }

  useEditor(targetProject: unknown): EditorRoute {
    const target = normalizeProjectPathCanonical(
      typeof targetProject === "string" ? targetProject : null,
    );
    const records = this.listRecords();
    if (!target) {
      throw new EditorRoutingError(
        "EDITOR_NOT_FOUND",
        "editor.use requires a non-empty project path or unique project name.",
        records,
      );
    }

    const record = resolveTargetRecord(records, target, { requireMatch: true });
    if (!record) {
      throw new EditorRoutingError(
        "EDITOR_NOT_FOUND",
        `No discovered Unity editor matches '${target}'.`,
        records,
      );
    }
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    if (!project) {
      throw new EditorRoutingError(
        "EDITOR_NOT_FOUND",
        `Discovered editor for '${target}' did not report projectPathCanonical.`,
        records,
      );
    }

    this._activeProjectPathCanonical = project;
    return {
      client: this._clientForProject(project),
      projectPathCanonical: project,
      record,
      reason: "target",
    };
  }

  async runExclusive<T>(route: EditorRoute, action: () => Promise<T>): Promise<T> {
    const key = route.projectPathCanonical
      ? projectMapKey(route.projectPathCanonical)
      : "__legacy__";
    const previous = this._queueByProject.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this._queueByProject.set(key, next);
    try {
      return await next;
    } finally {
      if (this._queueByProject.get(key) === next) {
        this._queueByProject.delete(key);
      }
    }
  }

  private _clientForProject(projectPathCanonical: string): UnityClient {
    const key = projectMapKey(projectPathCanonical);
    const existing = this._clientsByProject.get(key);
    if (existing && !existing.reconnectAbandoned) {
      return existing;
    }
    if (existing) {
      // The pinned client gave up reconnecting (its editor was replaced by a
      // different-project editor on the same endpoint). Drop it and build a fresh one
      // that re-attempts against current discovery.
      void existing.disconnect().catch(() => {});
      this._clientsByProject.delete(key);
    }

    const client = new UnityClient({
      targetIdentity: { projectPathCanonical },
    });
    this._clientsByProject.set(key, client);
    this._events.onClientCreated?.(client, projectPathCanonical);
    return client;
  }

  /**
   * Mark every currently-discovered project as seen, then evict per-project clients that
   * are no longer routable: ones whose editor has been gone past the grace window, or that
   * abandoned reconnect after repeated ROUTE_MISMATCH. The active editor's client is left
   * alone here — its lifecycle is handled by the active-pin grace check and
   * `_clientForProject` recreation — so a momentary blip can't sever the active session.
   */
  private _refreshLastSeenAndReap(records: UnityEndpointDiscoveryRecord[]): void {
    const now = this._now();
    const liveKeys = new Set<string>();
    for (const record of records) {
      const project = normalizeProjectPathCanonical(record.projectPathCanonical);
      if (project) {
        const key = projectMapKey(project);
        liveKeys.add(key);
        this._lastSeenByProject.set(key, now);
      }
    }

    const activeKey = this._activeProjectPathCanonical
      ? projectMapKey(this._activeProjectPathCanonical)
      : null;

    for (const [key, client] of this._clientsByProject) {
      if (key === activeKey) {
        continue;
      }
      const absentTooLong = !liveKeys.has(key)
        && now - (this._lastSeenByProject.get(key) ?? 0) > EVICT_GRACE_MS;
      if (client.reconnectAbandoned || absentTooLong) {
        void client.disconnect().catch(() => {});
        this._clientsByProject.delete(key);
        this._lastSeenByProject.delete(key);
      }
    }
  }
}

function resolveTargetRecord(
  records: UnityEndpointDiscoveryRecord[],
  target: string,
  options: { requireMatch?: boolean } = {},
): UnityEndpointDiscoveryRecord | null {
  // Only path-like targets (containing a separator) go through symlink-resolving
  // (`realpathSync`) comparison. A bare projectName like "GameA" must NOT be treated as a
  // cwd-relative filesystem path — otherwise a `./GameA` dir/symlink could win by-path and
  // bypass the duplicate-projectName ambiguity check below. Names fall through to the pure
  // string compare (always false against an absolute path) → no by-path match, no realpath I/O.
  const targetIsPathLike = /[/\\]/.test(target);
  const byPath = records.filter((record) => {
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    if (!project) {
      return false;
    }
    return targetIsPathLike
      ? projectPathsEquivalent(project, target)
      : projectPathCanonicalEquals(project, target);
  });
  if (byPath.length === 1) {
    return byPath[0]!;
  }
  if (byPath.length > 1) {
    throw new EditorRoutingError(
      "EDITOR_AMBIGUOUS",
      `Multiple Unity editors report projectPathCanonical '${target}'. Use editor.list diagnostics before routing.`,
      records,
    );
  }

  const byName = records.filter((record) => record.projectName === target);
  if (byName.length === 1) {
    return byName[0]!;
  }
  if (byName.length > 1) {
    throw new EditorRoutingError(
      "EDITOR_AMBIGUOUS",
      `Multiple Unity editors share projectName '${target}'. Use projectPathCanonical instead.`,
      records,
    );
  }

  if (options.requireMatch) {
    throw new EditorRoutingError(
      "EDITOR_NOT_FOUND",
      `No discovered Unity editor matches '${target}'.`,
      records,
    );
  }
  return null;
}

function projectMapKey(projectPathCanonical: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? projectPathCanonical.toLocaleLowerCase()
    : projectPathCanonical;
}
