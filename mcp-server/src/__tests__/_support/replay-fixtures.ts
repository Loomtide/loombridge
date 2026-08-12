import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ReplayLayout } from "../../domain/state.js";

/**
 * sha256 of `<traces>/<id>.trace.json` as it sits on disk.
 *
 * A replay report records WHICH demonstration it was produced from (`traceSha256`), and
 * `approve` refuses to promote a report whose value is absent or is not the sha of the trace
 * on disk. That binding is what stops a re-recorded id from promoting the PREVIOUS
 * demonstration's frames under the new trace's identity.
 *
 * Fixtures that hand-write a report therefore have to carry the same stamp a real run would.
 * They read it FROM THE FILE they just wrote rather than re-spelling the trace body, so a
 * fixture whose trace changes shape cannot quietly start stamping a sha for bytes that are
 * not there.
 */
export async function traceShaOnDisk(layout: ReplayLayout, id: string): Promise<string> {
  const bytes = await fs.readFile(path.join(layout.replayTraces, `${id}.trace.json`));
  return createHash("sha256").update(bytes).digest("hex");
}
