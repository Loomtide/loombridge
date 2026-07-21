/**
 * Keeps a Unity input session alive while THIS MCP server owns it.
 *
 * The bridge tears down an input session that has been idle (with keys held) past its
 * timeout, to release injected key state if the owner walked away. But an AI agent's
 * think-time between tool calls routinely exceeds that timeout, so without a heartbeat a
 * held key would be released mid-sequence. This pings the bridge periodically — driven by
 * the Node event loop, which runs even while the model is "thinking" between requests — so
 * the session lives exactly as long as this server process is alive and connected. When the
 * server exits (stdin EOF / signal), the timers die with it, the pings stop, and the bridge
 * releases any held-key session within its timeout (orphan safety).
 */

/** Minimal injectable timer surface so the manager can be unit-tested deterministically. */
export interface KeepaliveScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: KeepaliveScheduler = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    // Don't let the heartbeat keep the process alive on its own (orphan safety + clean exit).
    if (typeof (h as { unref?: () => void }).unref === "function") {
      (h as { unref: () => void }).unref();
    }
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * A ping returns whether the session is still ours and alive:
 *  - true  → keep pinging.
 *  - false → the bridge says this session is no longer active/ours; stop.
 * It must NOT reject — transient send failures (a reconnect blip) should resolve to `true`
 * so a momentary disconnect doesn't permanently stop the heartbeat.
 */
export type KeepalivePing = () => Promise<boolean>;

export class InputSessionKeepalive {
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly intervalMs: number = 10_000,
    private readonly scheduler: KeepaliveScheduler = defaultScheduler,
  ) {}

  /** Start (or no-op if already running) the heartbeat for `sessionId`. */
  start(sessionId: string, ping: KeepalivePing): void {
    if (!sessionId || this.timers.has(sessionId)) return;
    const handle = this.scheduler.setInterval(() => {
      void ping()
        .then((alive) => {
          if (!alive) this.stop(sessionId);
        })
        .catch(() => {
          /* defensive: a throwing ping must not kill the heartbeat */
        });
    }, this.intervalMs);
    this.timers.set(sessionId, handle);
  }

  /** Stop the heartbeat for `sessionId` (idempotent). */
  stop(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle !== undefined) {
      this.scheduler.clearInterval(handle);
      this.timers.delete(sessionId);
    }
  }

  /** Stop every heartbeat — called on server shutdown. */
  stopAll(): void {
    for (const handle of this.timers.values()) {
      this.scheduler.clearInterval(handle);
    }
    this.timers.clear();
  }

  has(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  get activeCount(): number {
    return this.timers.size;
  }
}
