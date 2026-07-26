import path from "node:path";
import { packageRoot } from "../../shared/pkg-root.js";

/**
 * Depth-independent roots for tests.
 *
 * Tests used to derive these by counting `..` from `__dirname`, which encodes how deep the
 * test file happens to sit — 43 of them broke the moment the suite was re-nested to mirror
 * the source layout, and the same trap had already cost a debugging round in the source
 * tree itself. `packageRoot()` searches upward for package.json, so a test can be moved
 * anywhere without touching the paths it reads.
 */

/** `mcp-server/` — the package root. */
export const PKG_ROOT = packageRoot(import.meta.url);

/** The repository root, one above the package. */
export const REPO_ROOT = path.dirname(PKG_ROOT);

/** Built CLI entrypoint (`dist/surfaces/cli.js`). */
export const CLI_DIST = path.join(PKG_ROOT, "dist", "surfaces", "cli.js");

/** CLI source entrypoint (`src/surfaces/cli.ts`). */
export const CLI_SRC = path.join(PKG_ROOT, "src", "surfaces", "cli.ts");
