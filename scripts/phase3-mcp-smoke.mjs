#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "../mcp-server");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

async function loadMcpSdk() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");

  // import() takes a URL, not a path. On Windows an absolute path like
  // D:\...\index.js parses as protocol 'd:' and the ESM loader rejects it.
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientModulePath).href),
    import(pathToFileURL(stdioModulePath).href),
  ]);

  return { Client, StdioClientTransport };
}

function printUsage() {
  console.log("Usage: node scripts/phase3-mcp-smoke.mjs (--expect-connected|--expect-disconnected) [--assert-compile-clean]");
  console.log("  --expect-disconnected   Validate deterministic disconnected behavior (CONNECTION_ERROR/PREFLIGHT_BLOCKED) with Unity offline.");
  console.log("  --expect-connected      Validate tool execution and screenshot payloads with Unity online.");
  console.log("  --assert-compile-clean  Connected mode only; fails on detected C# compile errors.");
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const help = args.has("--help") || args.has("-h");
  if (help) {
    return { help: true, expectConnected: false, assertCompileClean: false };
  }

  const expectConnected = args.has("--expect-connected");
  const expectDisconnected = args.has("--expect-disconnected");
  const assertCompileClean = args.has("--assert-compile-clean");

  if (expectConnected === expectDisconnected) {
    throw new Error("Specify exactly one mode: --expect-connected or --expect-disconnected");
  }

  if (assertCompileClean && !expectConnected) {
    throw new Error("--assert-compile-clean requires --expect-connected");
  }

  return { help: false, expectConnected, assertCompileClean };
}

function parseToolPayload(result) {
  const first = result.content?.[0];
  if (!first) return null;

  if (first.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return first.text;
    }
  }

  return first;
}

function getErrorText(result) {
  const first = result.content?.[0];
  if (!first || first.type !== "text") return "";
  return first.text ?? "";
}

function isConnectionError(result) {
  if (!result.isError) return false;
  const text = getErrorText(result);
  return text.includes("CONNECTION_ERROR")
    || text.includes("PREFLIGHT_BLOCKED")
    || text.includes("INPUT_CAPABILITY_BLOCKED")
    || /deterministic scenario preflight blocked/i.test(text)
    || text.toLowerCase().includes("not connected");
}

function extractBlockedSummary(text) {
  const errorClass = text.match(/error class:\s*([A-Z_]+)/i)?.[1] ?? "UNKNOWN";
  const attemptedPorts = text.match(/attempted ports:\s*([^;]+)/i)?.[1]?.trim() ?? "unknown";
  const hostAttempts = text.match(/host attempts:\s*([^;]+)/i)?.[1]?.trim() ?? "unknown";
  return { errorClass, attemptedPorts, hostAttempts };
}

function summarizeBlockedResult(toolName, result) {
  if (!isConnectionError(result)) return null;
  const errorText = getErrorText(result);
  const summary = extractBlockedSummary(errorText);
  return `${toolName}: blocked (error class=${summary.errorClass}, attempted ports=${summary.attemptedPorts}, host attempts=${summary.hostAttempts})`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function callToolWithRetry(client, request, attempts, delayMs) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await client.callTool(request);
    if (!isConnectionError(last)) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isCompileErrorLog(logEntry) {
  if (!logEntry || logEntry.type !== "error") return false;
  const message = logEntry.message ?? "";
  return /error CS\d+:/i.test(message) || /Source file .*\.cs'.*could not be found/i.test(message);
}

async function main() {
  const { help, expectConnected, assertCompileClean } = parseArgs(process.argv);
  if (help) {
    printUsage();
    return;
  }

  const mode = expectConnected ? "connected" : "disconnected";
  const { Client, StdioClientTransport } = await loadMcpSdk();
  console.log(`phase3-smoke: start mode=${mode}`);

  const childEnv = expectConnected
    ? { ...process.env }
    : {
      ...process.env,
      LOOMBRIDGE_UNITY_TRANSPORT_MODE: "ipc",
      LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR: mkdtempSync(join(tmpdir(), "loombridge-disconnected-smoke-")),
    };

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/surfaces/index.js"],
    cwd: MCP_SERVER_DIR,
    env: childEnv,
    stderr: "pipe",
  });

  const client = new Client({ name: "phase3-mcp-smoke", version: "0.0.1" });

  await client.connect(transport);

  try {
    const tools = await client.listTools();
    assert(Array.isArray(tools.tools), "tools/list did not return a tools array");
    assert(tools.tools.length >= 46, `Expected at least 46 tools, got ${tools.tools.length}`);

    const requiredTools = new Set([
      "unity_editor_get_state",
      "unity_scene_get_hierarchy",
      "unity_editor_screenshot",
    ]);
    for (const required of requiredTools) {
      assert(
        tools.tools.some((tool) => tool.name === required),
        `Required tool missing from tools/list: ${required}`,
      );
    }

    const retryCount = expectConnected ? 2 : 1;
    const retryDelayMs = 250;

    const stateResult = await callToolWithRetry(
      client,
      { name: "unity_editor_get_state", arguments: {} },
      retryCount,
      retryDelayMs,
    );
    const hierarchyResult = await callToolWithRetry(
      client,
      { name: "unity_scene_get_hierarchy", arguments: {} },
      retryCount,
      retryDelayMs,
    );
    const screenshotResult = await callToolWithRetry(
      client,
      { name: "unity_editor_screenshot", arguments: { view: "scene" } },
      retryCount,
      retryDelayMs,
    );

    const observedConnected =
      !stateResult.isError && !hierarchyResult.isError && !screenshotResult.isError;

    if (expectConnected) {
      const blockedSummaries = [
        summarizeBlockedResult("unity_editor_get_state", stateResult),
        summarizeBlockedResult("unity_scene_get_hierarchy", hierarchyResult),
        summarizeBlockedResult("unity_editor_screenshot", screenshotResult),
      ].filter(Boolean);

      if (blockedSummaries.length > 0) {
        for (const summary of blockedSummaries) {
          console.log(`phase3-smoke: ${summary}`);
        }
      }

      assert(
        observedConnected,
        `Expected Unity-connected mode, but core tools failed: state="${getErrorText(
          stateResult,
        )}" hierarchy="${getErrorText(hierarchyResult)}" screenshot="${getErrorText(screenshotResult)}"`
        + (blockedSummaries.length > 0 ? ` blocked=${blockedSummaries.join(" | ")}` : ""),
      );

      const screenshotBlock = screenshotResult.content?.[0];
      assert(screenshotBlock?.type === "image", "Expected screenshot to return image content");
      assert(
        screenshotBlock?.mimeType === "image/jpeg" || screenshotBlock?.mimeType === "image/png",
        `Unexpected screenshot mime type: ${screenshotBlock?.mimeType ?? "none"}`,
      );
      assert(
        typeof screenshotBlock?.data === "string" && screenshotBlock.data.length > 0,
        "Screenshot image payload was empty",
      );

      if (assertCompileClean) {
        const logsResult = await client.callTool({
          name: "unity_editor_console_logs",
          arguments: { max_entries: 200 },
        });
        assert(!logsResult.isError, "Failed to fetch console logs for compile check");
        const logsPayload = parseToolPayload(logsResult);
        const logItems = Array.isArray(logsPayload?.logs) ? logsPayload.logs : [];
        const compileErrors = logItems.filter(isCompileErrorLog);
        assert(
          compileErrors.length === 0,
          `Compile errors detected in Unity console: ${compileErrors.map((e) => e.message).join(" | ")}`,
        );
      }
    } else {
      // In disconnected mode, require explicit connection errors for core calls.
      assert(isConnectionError(stateResult), "Expected connection error from unity_editor_get_state");
      assert(isConnectionError(hierarchyResult), "Expected connection error from unity_scene_get_hierarchy");
      assert(isConnectionError(screenshotResult), "Expected connection error from unity_editor_screenshot");
    }

    const statePayload = parseToolPayload(stateResult);
    const hierarchyPayload = parseToolPayload(hierarchyResult);
    const screenshotBlock = screenshotResult.content?.[0];

    console.log(`phase3-smoke: mode=${mode}`);
    console.log(`phase3-smoke: tools=${tools.tools.length}`);
    console.log(
      `phase3-smoke: editor_state=${stateResult.isError ? "connection_error" : JSON.stringify(statePayload)}`,
    );
    console.log(
      `phase3-smoke: hierarchy=${hierarchyResult.isError ? "connection_error" : typeof hierarchyPayload}`,
    );
    if (screenshotBlock?.type === "image") {
      console.log(`phase3-smoke: screenshot=${screenshotBlock.mimeType}:${screenshotBlock.data.length}`);
    } else {
      console.log(`phase3-smoke: screenshot=connection_error`);
    }
    if (expectConnected) {
      console.log("phase3-smoke: checklist=connected checks passed");
    } else {
      console.log("phase3-smoke: checklist=disconnected baseline checks passed");
      console.log("phase3-smoke: next=run --expect-connected once UnityBridge is online");
    }
    console.log("phase3-smoke: success");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`phase3-smoke: failed - ${err.message}`);
  process.exitCode = 1;
});
