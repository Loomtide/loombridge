import type { AcceptanceContract } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function gateTuningFor(
  acceptance: AcceptanceContract,
  gateId: string,
): Record<string, unknown> {
  const tuning = acceptance.gateTuning?.byGate?.[gateId];
  return isRecord(tuning) ? tuning : {};
}

export function numberGateTuning(
  acceptance: AcceptanceContract,
  gateId: string,
  key: string,
): number | undefined {
  const value = gateTuningFor(acceptance, gateId)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
