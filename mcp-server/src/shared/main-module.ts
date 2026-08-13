import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Is this module the process entrypoint?
 *
 * WHY THIS EXISTS. Every CLI entrypoint used to answer this with a filename suffix:
 *
 *     process.argv[1]?.endsWith("capture-runner.js")
 *
 * That is false whenever the file is reached through its BIN NAME, because npm installs a bin as a
 * symlink whose path is the bin name, not the target filename:
 *
 *     argv[1] = /opt/homebrew/bin/loombridge-capture-runner   ends with "capture-runner.js"? no
 *
 * So the main block never ran. The command exited 0, printed nothing, and did no work. Measured
 * across the declared bins, six of eight were silent no-ops; only the two pointing at `cli.js`
 * worked, because that file has no such guard.
 *
 * This is the repo's "declared path nothing walks" shape one level deeper than usual:
 * `package-entrypoints.test.ts` verified each bin TARGET exists, which was true, while the command
 * itself did nothing. A green suite over six dead commands.
 *
 * REALPATH ON BOTH SIDES is what makes it correct:
 *   - `argv[1]` may be a bin symlink (`/opt/homebrew/bin/loombridge-capture`), a relative path
 *     (`dist/x.js`), or an absolute one;
 *   - `import.meta.url` is always the resolved module file.
 * Comparing resolved real paths makes all three forms agree, and keeps working under `tsx`, where
 * both sides resolve to the `.ts` source.
 *
 * Returns false rather than throwing when `argv[1]` is absent or unresolvable (`node -e`, a REPL,
 * a deleted script), because "not the entrypoint" is the safe answer: a module imported for its
 * exports must not start running a CLI.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
