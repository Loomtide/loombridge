/**
 * Shared icon vocabulary for the human-facing mini-game CLI prose (setup / next / capture /
 * finalize / verify / trace footer). The machine surfaces — the JSON report and exit codes —
 * are untouched; this only decorates the stderr/stdout text a person reads in the terminal.
 *
 * Keep the set small and consistent so a result, a next step, and an error each read the same
 * way everywhere.
 */
import os from "node:os";
import process from "node:process";

export const ICON = {
  // Results
  ready: "✅",
  notReady: "❌",
  cantVerify: "🟡",
  pass: "✓",
  fail: "✗",
  // Tiers / sections
  mustFix: "🔴",
  warn: "⚠️",
  drift: "🎨",
  gated: "⏸",
  flow: "🔀",
  input: "👂",
  passed: "✅",
  screens: "🖼",
  stats: "📊",
  // Steps / wayfinding
  next: "👉",
  report: "📄",
  workspace: "✅",
  record: "🎬",
  capture: "📸",
  finalize: "🔗",
  info: "ℹ️",
} as const;

/** Shorten an absolute path under $HOME to `~/…` for readable output; leave anything else as-is. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** The shared two-line "next step" block: `👉 Next — <summary>` + the indented command. */
export function nextStepLines(summary: string, command?: string): string[] {
  const lines = [`${ICON.next} Next — ${summary}`];
  if (command) lines.push(`   ${command}`);
  return lines;
}

/**
 * Turn a Unity-bridge connection failure into ONE clear, actionable message — the raw
 * transport error is a wall of ECONNREFUSED diagnostics that buries the real cause (Unity
 * isn't open / the bridge isn't connected). Returns null for any OTHER error so the caller
 * falls back to its normal handling. Set `LOOMBRIDGE_DEBUG=1` to append the full diagnostics.
 *
 * Detected by `name` (duck-typed) so this UI module needn't import the bridge client.
 */
export function unityConnectionHint(error: unknown): string[] | null {
  if (!error || typeof error !== "object" || (error as { name?: string }).name !== "UnityConnectionError") {
    return null;
  }
  const ports = (error as { diagnostics?: { attemptedPorts?: number[] } }).diagnostics?.attemptedPorts ?? [];
  const range = ports.length > 0 ? `${ports[0]}–${ports[ports.length - 1]}` : "8200–8210";
  const lines = [
    `${ICON.notReady} Can't reach Unity — is the editor open with the Loombridge bridge connected?`,
    "   Open your project in Unity, wait for the bridge to connect, then re-run this command.",
    `   (tried ports ${range}; set LOOMBRIDGE_DEBUG=1 for the full connection diagnostics.)`,
  ];
  if (process.env.LOOMBRIDGE_DEBUG) lines.push("", String((error as Error).message ?? error));
  return lines;
}

/**
 * The OTHER half of the same condition: the bridge was reachable, the run started, and the
 * socket then DROPPED (a domain reload the editor never came back from, the editor closing,
 * a crash). `unity-client` rejects every in-flight op with a plain `Error` whose message
 * carries the `CONNECTION_LOST:` prefix, so it has no `UnityConnectionError` name for
 * {@link unityConnectionHint} to key on and it looked, to a caller, like an ordinary failure.
 *
 * DETECTED BY MESSAGE SHAPE ON PURPOSE, and not by renaming the client's throw: the
 * `UnityConnectionError` NAME is a contract two callers read for its `diagnostics`
 * (bridge-preflight builds a connection blocker from it; `formatConnectionErrorMessage`
 * formats it), and a mid-run socket drop has no such diagnostics to give. Reusing the name
 * would hand those callers a fabricated port scan for a socket that had already connected.
 * The message prefix is the shape `resilientSend.isConnectionLoss` already treats as the
 * contract, so both doors read the same fact.
 *
 * Returns null for any other error, so callers keep their normal handling.
 */
export function unityConnectionLostHint(error: unknown): string[] | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!/CONNECTION_LOST|Not connected|WebSocket is not open|Socket closed|Connection lost/i.test(text)) {
    return null;
  }
  const lines = [
    `${ICON.notReady} Lost the connection to Unity mid-run: the run produced no verdict about the game.`,
    "   The editor closed, crashed, or entered a domain reload it did not come back from.",
    "   Bring the editor back up, wait for the bridge to reconnect, and re-run this command.",
  ];
  if (process.env.LOOMBRIDGE_DEBUG) lines.push("", text);
  return lines;
}
