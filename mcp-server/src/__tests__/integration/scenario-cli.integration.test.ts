import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "../../..");

describe("Scenario CLI integration", { timeout: 30000 }, () => {
  let tempDir = "";

  before(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loombridge-scenario-cli-"));
  });

  after(async () => {
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run validates and writes deterministic report", async () => {
    const outputPath = path.join(tempDir, "dry-run-report.json");
    const result = spawnSync(
      "node",
      [
        "dist/surfaces/scenario-cli.js",
        "--scenario",
        "../demo/scenarios/generic-smoke.json",
        "--dry-run",
        "--output",
        outputPath,
      ],
      {
        cwd: MCP_SERVER_DIR,
        encoding: "utf-8",
      },
    );

    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr=${result.stderr}`);
    assert.ok(fs.existsSync(outputPath), "Dry-run should write report file");

    const report = JSON.parse(await fsp.readFile(outputPath, "utf-8")) as {
      status: string;
      dryRun?: boolean;
    };
    assert.equal(report.status, "pass");
    assert.equal(report.dryRun, true);
  });

  test("invalid scenario returns non-zero and writes validation errors", async () => {
    const invalidScenarioPath = path.join(tempDir, "invalid-scenario.json");
    const outputPath = path.join(tempDir, "invalid-report.json");
    await fsp.writeFile(
      invalidScenarioPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "invalid",
        steps: [{ id: "s1", name: "missing kind" }],
      }),
      "utf-8",
    );

    const result = spawnSync(
      "node",
      [
        "dist/surfaces/scenario-cli.js",
        "--scenario",
        invalidScenarioPath,
        "--dry-run",
        "--output",
        outputPath,
      ],
      {
        cwd: MCP_SERVER_DIR,
        encoding: "utf-8",
      },
    );

    assert.notEqual(result.status, 0, "Invalid scenario should fail");
    const report = JSON.parse(await fsp.readFile(outputPath, "utf-8")) as {
      status: string;
      validationIssues?: Array<{ code: string }>;
    };
    assert.equal(report.status, "fail");
    assert.ok((report.validationIssues?.length ?? 0) > 0, "Validation issues should be present");
  });

  test("execution failure propagates deterministic step error", async () => {
    const scenarioPath = path.join(tempDir, "unknown-tool-scenario.json");
    const outputPath = path.join(tempDir, "unknown-tool-report.json");
    await fsp.writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "unknown-tool",
        steps: [
          {
            id: "s1",
            name: "unknown tool",
            kind: "tool_call",
            tool: "unity_nonexistent_tool",
            arguments: {},
          },
        ],
      }),
      "utf-8",
    );

    const result = spawnSync(
      "node",
      [
        "dist/surfaces/scenario-cli.js",
        "--scenario",
        scenarioPath,
        "--output",
        outputPath,
      ],
      {
        cwd: MCP_SERVER_DIR,
        encoding: "utf-8",
      },
    );

    assert.notEqual(result.status, 0, "Unknown tool scenario should fail");
    const report = JSON.parse(await fsp.readFile(outputPath, "utf-8")) as {
      status: string;
      failedStepIndex?: number;
      steps: Array<{ error?: { message?: string } }>;
    };
    assert.equal(report.status, "fail");
    assert.equal(report.failedStepIndex, 0);
    const errorMessage = report.steps[0]?.error?.message ?? "";
    assert.ok(
      /Unknown tool|nonexistent/i.test(errorMessage),
      `Expected unknown tool message, got "${errorMessage}"`,
    );
  });
});
