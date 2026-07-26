/**
 * Shipped example mini-game contract loader (S6a).
 *
 * The example contracts live as JSON next to this module under `games/`. `tsc`
 * does not copy `.json` into `dist/`, so — like the platformer profile loader —
 * we resolve the source tree at runtime via `import.meta.url` and read + validate
 * the files there. Every load goes through `assertValidMinigameContract`, so a
 * malformed example throws at load time rather than reaching a verify run.
 *
 * These are EXAMPLES that exercise the contract shape, not a live game registry.
 * S6b+ wires real per-project `.loombridge/games/<id>.json` contracts to capture.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertValidMinigameContract } from "./validator.js";
import type { MinigameContract } from "./types.js";
import { packageRoot } from "../../../shared/pkg-root.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is dist/domain/minigame-profiles at runtime; the JSON lives in the
// source tree (not copied by tsc), so resolve to the package root and read src/.
const PKG_ROOT = packageRoot(import.meta.url);
const GAMES_DIR = path.join(PKG_ROOT, "src", "capabilities", "minigame", "profiles", "games");

/** The ids of the example mini-game contracts this package ships. */
export const EXAMPLE_MINIGAME_IDS = ["alphabet-pop"] as const;

export type ExampleMinigameId = (typeof EXAMPLE_MINIGAME_IDS)[number];

function contractPath(id: string): string {
  return path.join(GAMES_DIR, `${id}.minigame.json`);
}

/** Load and validate a single example mini-game contract by id. Throws if absent or invalid. */
export async function loadExampleMinigame(id: string): Promise<MinigameContract> {
  let raw: string;
  try {
    raw = await fs.readFile(contractPath(id), "utf-8");
  } catch {
    throw new Error(
      `Unknown example mini-game '${id}'. Shipped examples: ${EXAMPLE_MINIGAME_IDS.join(", ")}.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const contract = assertValidMinigameContract(parsed);
  if (contract.id !== id) {
    throw new Error(`Mini-game file ${id}.minigame.json declares mismatched id '${contract.id}'.`);
  }
  return contract;
}

/** Load and validate every shipped example mini-game contract. */
export async function loadAllExampleMinigames(): Promise<MinigameContract[]> {
  return Promise.all(EXAMPLE_MINIGAME_IDS.map((id) => loadExampleMinigame(id)));
}
