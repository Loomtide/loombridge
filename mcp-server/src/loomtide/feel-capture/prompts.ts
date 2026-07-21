import type { FeelCaptureContract } from "./types.js";

export function summarizeFeelCaptureProposal(contract: FeelCaptureContract): string[] {
  const lines = [
    `Feel capture proposal${contract.game ? ` for ${contract.game}` : ""}:`,
    `  subjects: ${contract.subjects.map((s) => `${s.id}=${s.locator.path}`).join(", ")}`,
    `  preconditions: ${contract.preconditions?.map((p) => `${p.kind}:${p.locator.path}=${p.active}`).join(", ") || "(none)"}`,
    `  interactions: ${contract.interactions.map((i) => `${i.id}:${i.kind}`).join(", ") || "(none)"}`,
    "  metric coverage:",
  ];
  for (const metric of contract.metrics) {
    lines.push(
      `    - ${metric.metric}: ${metric.interactionId ?? metric.derivation}${metric.reason ? ` (${metric.reason})` : ""}`,
    );
  }
  return lines;
}
