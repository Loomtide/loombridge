import type { FeelCaptureCoverageEntry } from "./types.js";

export function formatCaptureCoverageLine(entry: FeelCaptureCoverageEntry): string {
  const via = entry.interactionId ? ` via ${entry.interactionId}` : "";
  const why = entry.reason ? ` — ${entry.reason}` : "";
  return `${entry.metric}: ${entry.status}${via}${why}`;
}
