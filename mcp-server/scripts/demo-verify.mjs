#!/usr/bin/env node
/**
 * Loombridge Demo Verification — Step 6 play mode test.
 * Enter play, test jump + movement, capture game screenshot, exit.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

async function main() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModulePath),
    import(stdioModulePath),
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(MCP_SERVER_DIR, "dist/index.js")],
    cwd: MCP_SERVER_DIR,
  });

  const client = new Client({ name: "demo-verify", version: "1.0" });
  await client.connect(transport);

  async function call(tool, args = {}) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { raw: result, parsed, text, isError: result?.isError };
  }

  async function log(label, tool, args = {}) {
    const r = await call(tool, args);
    const summary = r.isError
      ? `ERROR: ${r.text?.substring(0, 150)}`
      : typeof r.parsed === "object"
        ? JSON.stringify(r.parsed).substring(0, 150)
        : String(r.text || "").substring(0, 150);
    console.log(`  [${label}] ${summary}`);
    return r;
  }

  try {
    console.log("=== Play Mode Verification ===\n");

    // 1. Enter play mode
    console.log("1. Entering play mode...");
    await log("play", "unity_editor_play", {});

    // 2. Wait for play mode (with reconnect tolerance)
    console.log("2. Waiting for play mode active...");
    await log("wait", "unity_editor_wait_for", { playMode: "playing", timeoutMs: 15000 });

    // 3. Begin input session
    console.log("3. Starting input session...");
    const caps = await log("caps", "unity_input_get_capabilities", {});
    const session = await log("session", "unity_input_begin_session", {});

    // 4. Jump test
    console.log("4. Testing jump (Space)...");
    await log("jump", "unity_input_key_tap", { key: "Space" });
    await log("wait-frames", "unity_editor_wait_for", { frames: 12 });

    // 5. Movement test (right arrow)
    console.log("5. Testing movement (RightArrow)...");
    await log("right-down", "unity_input_key_down", { key: "RightArrow" });
    await log("wait-frames", "unity_editor_wait_for", { frames: 24 });
    await log("right-up", "unity_input_key_up", { key: "RightArrow" });

    // 6. Wait a bit for game state to settle
    await log("wait-settle", "unity_editor_wait_for", { frames: 30 });

    // 7. End input session
    console.log("6. Ending input session...");
    await log("end-session", "unity_input_end_session", {});

    // 8. Screenshot in game view
    console.log("7. Capturing game screenshot...");
    const screenshot = await call("unity_editor_screenshot", { view: "game" });
    const img = screenshot.raw?.content?.find(c => c.type === "image");
    if (img) {
      writeFileSync("/tmp/loombridge-playtest.jpg", Buffer.from(img.data, "base64"));
      console.log("  Screenshot saved to /tmp/loombridge-playtest.jpg");
    }

    // 9. Check console logs
    console.log("8. Checking console logs...");
    await log("logs", "unity_editor_console_logs", { count: 20 });

    // 10. Stop play mode
    console.log("9. Stopping play mode...");
    await log("stop", "unity_editor_stop", {});

    console.log("\n=== VERIFICATION COMPLETE ===");

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
