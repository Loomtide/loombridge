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
 * falls back to its normal handling. Set `LOOMTIDE_DEBUG=1` to append the full diagnostics.
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
    `${ICON.notReady} Can't reach Unity — is the editor open with the Loomtide bridge connected?`,
    "   Open your project in Unity, wait for the bridge to connect, then re-run this command.",
    `   (tried ports ${range}; set LOOMTIDE_DEBUG=1 for the full connection diagnostics.)`,
  ];
  if (process.env.LOOMTIDE_DEBUG) lines.push("", String((error as Error).message ?? error));
  return lines;
}
