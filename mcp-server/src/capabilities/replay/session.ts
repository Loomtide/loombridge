/**
 * Replay Verification — shared live-session cleanup.
 *
 * Both `run-live` and `record-live` end a run the same way: leave the editor in
 * edit mode and disconnect. Naively that is `editor.stop` then `disconnect()` —
 * but `editor.stop` exits Play Mode, which triggers a Unity DOMAIN RELOAD that
 * drops the bridge socket. If we disconnect immediately, the bridge is still
 * reloading when the NEXT run tries to connect (it fails with ECONNREFUSED — the
 * exact wrinkle the record→replay loop hit).
 *
 * `endLiveSession` instead waits for the editor to settle (stopped + compile/
 * import idle) THROUGH the resilient send, which reconnects across the reload, so
 * the bridge is confirmed back up before we disconnect. It is best-effort: a
 * backgrounded/frozen editor throttles its update loop and may not settle within
 * the timeout — that's a bridge-level focus limitation this can't fix, only
 * degrade gracefully around.
 */

import type { UnityClient } from "../../bridge/unity-client.js";
import type { BridgeSend } from "./unity-driver.js";

export async function endLiveSession(send: BridgeSend, client: UnityClient): Promise<void> {
  // This runs in a `finally`, so it must NEVER throw — a cleanup error must not
  // mask the real run result (the original body error or the returned report).
  try {
    await send("editor.stop", {});
    await send(
      "editor.wait_for",
      { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 },
      20000,
    );
  } catch {
    // Best-effort cleanup — a never-settling editor must not fail the run.
  }
  try {
    await client.disconnect();
  } catch {
    // ditto: a failed disconnect must not propagate out of the caller's finally.
  }
}
