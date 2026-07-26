import fs from "node:fs/promises";
import path from "node:path";
import type { ScenarioRunResult } from "./types.js";

export interface ScenarioWriteResult {
  reportPath: string;
  artifactPaths: string[];
}

function normalizeArtifacts(artifacts: string[] | undefined): string[] {
  if (!artifacts || artifacts.length === 0) {
    return [];
  }

  return Array.from(new Set(artifacts)).sort();
}

function normalizeResultArtifacts(result: ScenarioRunResult): ScenarioRunResult {
  const normalizedArtifacts = normalizeArtifacts(result.artifacts);
  const normalizedSteps = result.steps.map((step) => {
    const stepArtifacts = normalizeArtifacts(step.artifacts);
    return {
      ...step,
      artifacts: stepArtifacts,
      artifactMetadata: {
        normalized: true as const,
        count: stepArtifacts.length,
      },
    };
  });

  return {
    ...result,
    steps: normalizedSteps,
    artifacts: normalizedArtifacts,
    artifactMetadata: {
      normalized: true,
      count: normalizedArtifacts.length,
    },
  };
}

export async function writeScenarioResult(
  outputPath: string,
  result: ScenarioRunResult,
): Promise<ScenarioWriteResult> {
  const normalizedResult = normalizeResultArtifacts(result);
  const artifactPaths = [...normalizedResult.artifacts];
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(normalizedResult, null, 2), "utf-8");
  return { reportPath: outputPath, artifactPaths };
}
