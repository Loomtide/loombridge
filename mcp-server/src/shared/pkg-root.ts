import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `mcp-server` package root, found by walking up from a module until a directory
 * containing `package.json` is reached.
 *
 * Modules that read JSON data out of the source tree (genre packs, profiles, schemas)
 * used to compute this by counting `..` segments, which silently encodes how deep the
 * module happens to sit. Re-nesting one directory during the source reorganisation
 * therefore pointed several of them at `dist/` instead of the package root, and the
 * failures surfaced as ENOENT on paths like `dist/src/capabilities/...`. Searching for
 * the marker file is depth-independent, so moving a module can no longer break the data
 * it loads.
 */
export function packageRoot(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`packageRoot: no package.json above ${fileURLToPath(moduleUrl)}`);
}
