/**
 * Safe-path helpers for capturePack / captureManifest entries (§3a evidence).
 *
 * A capture path is the relative path of a JSON file the build must drop into
 * `.loomtide/verify/`. Without constraint, a contract could declare
 * `../reports/build-verdict.json` (or absolute paths) and the doneness gate
 * would count those external files as required evidence, hollowing out the
 * capture-evidence guarantee. This module is the SINGLE SOURCE OF TRUTH for
 * what counts as safe, used at three layers:
 *
 *   1. validator (`verification/validator.ts`) — refuses contracts whose
 *      `capturePack.states[].requiredCaptures` declares an unsafe path.
 *   2. build (`loomtide/build.ts`) — defense in depth at mint time; throws if
 *      `deriveCaptureManifest` projects an unsafe path (catches a hand-
 *      constructed pack that bypassed the validator).
 *   3. doneness (`loomtide/doneness.ts`) — refuses to certify when an entry
 *      in the minted manifest fails the check or its resolved path escapes
 *      `.loomtide/verify/`. Caught at certification time, not just write time.
 */

import path from "node:path";

/**
 * A safe capture path is a forward-slash, RELATIVE path that names a file:
 *
 * - non-empty string,
 * - not absolute (POSIX `/...` or Windows-style `C:\...`),
 * - forward-slash-only (no `\` — would silently mean "escape" on Windows),
 * - no trailing `/` (capture paths name files, not directories),
 * - no empty segments (e.g. `a//b`),
 * - no `.` or `..` segments anywhere (no traversal, no non-canonical input).
 *
 * Direct segment inspection (no `path.posix.normalize`) — normalize keeps
 * trailing slashes on Node, which previously slipped through a canonical-form
 * check.
 */
export function isSafeCapturePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (path.posix.isAbsolute(p) || path.isAbsolute(p)) return false;
  if (p.includes("\\")) return false;
  if (p.endsWith("/")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * Defensive containment: returns true iff `abs` resolves to a path that is
 * `baseAbs` itself or strictly inside it. Both inputs are resolved first so a
 * caller does not have to pre-normalise.
 *
 * Use this AFTER `path.resolve(baseAbs, untrustedRelative)` to refuse cases
 * where the relative path still escapes (e.g. through symlinks or a bypass of
 * `isSafeCapturePath`).
 */
export function isWithin(baseAbs: string, abs: string): boolean {
  const base = path.resolve(baseAbs);
  const candidate = path.resolve(abs);
  if (candidate === base) return true;
  return candidate.startsWith(base + path.sep);
}
