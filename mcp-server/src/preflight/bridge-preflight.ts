import type { HandshakeResponse } from "../types.js";
import {
  UnityConnectionError,
  formatConnectionDiagnostics,
} from "../unity-client.js";
import {
  buildConnectionBlocker,
  buildGenericConnectionBlocker,
  buildMissingHandshakeBlocker,
  deterministicBlockerSignature,
  evaluatePrerequisiteChecks,
  type PreflightBlocker,
  type PreflightPrerequisiteCheck,
} from "./prerequisite-checks.js";

export type BridgePreflightStatus = "pass" | "blocked";

export interface BridgePreflightClient {
  readonly isConnected: boolean;
  readonly handshake: HandshakeResponse | null;
  connect(): Promise<HandshakeResponse>;
}

export interface BridgePreflightResult {
  status: BridgePreflightStatus;
  command: string;
  checkedAtUnixMs: number;
  deterministic: true;
  sessionReady: boolean;
  handshakeReady: boolean;
  sessionId: string | null;
  blockerSignature: string;
  blockers: PreflightBlocker[];
  prerequisites: PreflightPrerequisiteCheck[];
}

function toSortedBlockers(blockers: PreflightBlocker[]): PreflightBlocker[] {
  return [...blockers].sort((left, right) => {
    const leftKey = `${left.signature}:${left.code}`;
    const rightKey = `${right.signature}:${right.code}`;
    return leftKey.localeCompare(rightKey);
  });
}

function buildResult(
  command: string,
  checkedAtUnixMs: number,
  sessionReady: boolean,
  handshake: HandshakeResponse | null,
  blockers: PreflightBlocker[],
  prerequisites: PreflightPrerequisiteCheck[],
): BridgePreflightResult {
  const sortedBlockers = toSortedBlockers(blockers);
  const status: BridgePreflightStatus = sortedBlockers.length > 0 ? "blocked" : "pass";
  return {
    status,
    command,
    checkedAtUnixMs,
    deterministic: true,
    sessionReady,
    handshakeReady: handshake !== null,
    sessionId: handshake?.sessionId ?? null,
    blockerSignature: deterministicBlockerSignature(sortedBlockers),
    blockers: sortedBlockers,
    prerequisites,
  };
}

export class BridgePreflight {
  private readonly _client: BridgePreflightClient;

  constructor(client: BridgePreflightClient) {
    this._client = client;
  }

  async run(command: string): Promise<BridgePreflightResult> {
    const checkedAtUnixMs = Date.now();
    let handshake = this._client.handshake;
    let sessionReady = this._client.isConnected;

    if (!sessionReady || handshake === null) {
      try {
        handshake = await this._client.connect();
        sessionReady = true;
      } catch (error) {
        if (error instanceof UnityConnectionError) {
          const blocker = buildConnectionBlocker(
            error.diagnostics,
            formatConnectionDiagnostics(error.diagnostics),
          );
          return buildResult(command, checkedAtUnixMs, false, null, [blocker], []);
        }

        return buildResult(
          command,
          checkedAtUnixMs,
          false,
          null,
          [buildGenericConnectionBlocker(error)],
          [],
        );
      }
    }

    if (handshake === null) {
      return buildResult(
        command,
        checkedAtUnixMs,
        sessionReady,
        null,
        [buildMissingHandshakeBlocker(command)],
        [],
      );
    }

    const prerequisiteEvaluation = evaluatePrerequisiteChecks(command, handshake);
    return buildResult(
      command,
      checkedAtUnixMs,
      sessionReady,
      handshake,
      prerequisiteEvaluation.blockers,
      prerequisiteEvaluation.checks,
    );
  }
}

export function formatPreflightBlockedMessage(result: BridgePreflightResult): string {
  const payload = {
    status: result.status,
    command: result.command,
    blockerSignature: result.blockerSignature,
    checkedAtUnixMs: result.checkedAtUnixMs,
    sessionId: result.sessionId,
    blockers: result.blockers,
    failedPrerequisites: result.prerequisites.filter((check) => !check.passed),
    deterministic: result.deterministic,
  };

  return `deterministic scenario preflight blocked: ${JSON.stringify(payload)}`;
}
