#!/usr/bin/env node
/**
 * Loombridge Demo Tester — uses UpArrow for jump (Space broken via MCP on macOS).
 * Tests: UpArrow jump (key_down/key_up), movement, combined move+jump.
 *
 * Key insight: isPressed + manual edge detection means the first key_down
 * needs at least one FixedUpdate cycle to register. We use generous frame waits
 * and measure jump at peak (~25 frames after jump fires at 50fps).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

async function main() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModulePath), import(stdioModulePath),
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(MCP_SERVER_DIR, "dist/surfaces/index.js")],
    cwd: MCP_SERVER_DIR,
  });
  const client = new Client({ name: "demo-tester", version: "1.0" });
  await client.connect(transport);

  const loc = (path) => ({ path });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function call(tool, args = {}) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    if (result?.isError) {
      console.error(`  FAIL: ${tool} → ${text?.substring(0, 300)}`);
      throw new Error(`Tool ${tool} failed`);
    }
    return { raw: result, parsed, text };
  }

  let passed = 0;
  let failed = 0;
  function check(label, condition) {
    if (condition) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
  }

  function getPos(snapshot) {
    return snapshot.parsed?.transform?.position;
  }

  /** Wait for player to be grounded (y stable over consecutive readings). */
  async function waitForGrounded(label, maxAttempts = 10) {
    let prevY = null;
    for (let i = 0; i < maxAttempts; i++) {
      await call("unity_editor_wait_for", { frames: 30, timeoutMs: 10000 });
      const pos = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
      const y = pos?.y || 0;
      if (prevY !== null && Math.abs(y - prevY) < 0.01) {
        console.log(`  ${label}: grounded at y=${y.toFixed(4)} (stable after ${(i+1)*30} frames)`);
        return pos;
      }
      prevY = y;
    }
    const finalPos = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    console.log(`  ${label}: NOT fully grounded after ${maxAttempts*30} frames, y=${finalPos?.y?.toFixed(4)}`);
    return finalPos;
  }

  try {
    console.log("=== Connecting ===");
    const state = await call("unity_editor_get_state");
    console.log("  State:", JSON.stringify(state.parsed));

    if (state.parsed?.play_mode !== "stopped") {
      console.log("  Stopping play mode...");
      await call("unity_editor_stop");
      await sleep(3000);
    }

    // Wait for any pending compilation
    console.log("  Checking for compilation...");
    try {
      await call("unity_editor_wait_for", { compiling: false, timeoutMs: 30000 });
    } catch (e) {
      console.log(`  Wait for compile: ${e.message}`);
      await sleep(5000);
    }

    await call("unity_editor_clear_console");

    // ── Diagnostics: verify scene objects ──
    console.log("\n=== Scene Diagnostics ===");
    const groundSnap = await call("unity_runtime_get_snapshot", { locator: loc("/Ground") }).catch(() => null);
    if (groundSnap) {
      const gp = groundSnap.parsed?.transform;
      console.log(`  Ground: pos=${JSON.stringify(gp?.position)} scale=${JSON.stringify(gp?.localScale)}`);
    } else {
      console.log("  WARNING: /Ground not found in scene!");
    }

    console.log("\n=== Enter Play Mode ===");
    await call("unity_editor_play");
    await sleep(5000);
    for (let i = 0; i < 3; i++) {
      try {
        await call("unity_editor_wait_for", { playMode: "playing", timeoutMs: 20000 });
        break;
      } catch (e) {
        console.log(`  wait_for attempt ${i+1} failed: ${e.message}`);
        await sleep(5000);
      }
    }
    console.log("  Playing.");

    // Let player settle onto ground
    const settlePos = await waitForGrounded("Settle");

    // Begin input session
    console.log("\n=== Input Session ===");
    await call("unity_input_begin_session", {});

    // ── TEST 1: Jump via UpArrow key_down/key_up ──
    console.log("\n--- TEST 1: Jump via UpArrow key_down ---");
    const pos1pre = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    console.log("  Before UpArrow jump:", JSON.stringify(pos1pre));

    // Hold UpArrow for 15 frames (generous for edge detection + FixedUpdate to process)
    await call("unity_input_key_down", { key: "UpArrow" });
    await call("unity_editor_wait_for", { frames: 15, timeoutMs: 5000 });
    await call("unity_input_key_up", { key: "UpArrow" });
    // Wait 40 frames to measure near peak of jump arc
    await call("unity_editor_wait_for", { frames: 40, timeoutMs: 15000 });

    const pos1post = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    const dy1 = (pos1post?.y || 0) - (pos1pre?.y || 0);
    console.log(`  After UpArrow jump: ${JSON.stringify(pos1post)}  dy=${dy1.toFixed(4)}`);
    check("UpArrow key_down jump works (dy > 0.3)", dy1 > 0.3);

    // Wait for full landing
    const land1 = await waitForGrounded("Land after Test 1");

    // ── TEST 2: Movement RIGHT (safe direction, away from ground edge) ──
    console.log("\n--- TEST 2: Movement RIGHT (hold RightArrow 30 frames) ---");
    const pos2pre = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    console.log("  Before RIGHT:", JSON.stringify(pos2pre));

    await call("unity_input_key_down", { key: "RightArrow" });
    await call("unity_editor_wait_for", { frames: 30, timeoutMs: 10000 });
    await call("unity_input_key_up", { key: "RightArrow" });
    await call("unity_editor_wait_for", { frames: 5, timeoutMs: 5000 });

    const pos2post = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    const dx2 = (pos2post?.x || 0) - (pos2pre?.x || 0);
    const dy2 = (pos2post?.y || 0) - (pos2pre?.y || 0);
    console.log(`  After RIGHT: ${JSON.stringify(pos2post)}  dx=${dx2.toFixed(4)} dy=${dy2.toFixed(4)}`);
    check("Movement RIGHT works (dx > 0.1)", dx2 > 0.1);

    // ── TEST 3: Second jump (repeatability) ──
    console.log("\n--- TEST 3: Second UpArrow jump (repeatability) ---");
    const land2 = await waitForGrounded("Land before Test 3");
    const pos3pre = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    console.log("  Before second jump:", JSON.stringify(pos3pre));

    await call("unity_input_key_down", { key: "UpArrow" });
    await call("unity_editor_wait_for", { frames: 15, timeoutMs: 5000 });
    await call("unity_input_key_up", { key: "UpArrow" });
    await call("unity_editor_wait_for", { frames: 40, timeoutMs: 15000 });

    const pos3post = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    const dy3 = (pos3post?.y || 0) - (pos3pre?.y || 0);
    console.log(`  After second jump: ${JSON.stringify(pos3post)}  dy=${dy3.toFixed(4)}`);
    check("Second UpArrow jump works (dy > 0.3)", dy3 > 0.3);

    // Wait for landing
    const land3 = await waitForGrounded("Land before Test 4");

    // ── TEST 4: Move RIGHT + UpArrow jump (combined) ──
    console.log("\n--- TEST 4: Move RIGHT + UpArrow jump ---");
    const pos4pre = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    console.log("  Before move+jump:", JSON.stringify(pos4pre));

    await call("unity_input_key_down", { key: "RightArrow" });
    await call("unity_editor_wait_for", { frames: 5, timeoutMs: 5000 });
    await call("unity_input_key_down", { key: "UpArrow" });
    await call("unity_editor_wait_for", { frames: 15, timeoutMs: 5000 });
    await call("unity_input_key_up", { key: "UpArrow" });
    await call("unity_editor_wait_for", { frames: 35, timeoutMs: 15000 });
    await call("unity_input_key_up", { key: "RightArrow" });
    await call("unity_editor_wait_for", { frames: 5, timeoutMs: 5000 });

    const pos4post = getPos(await call("unity_runtime_get_snapshot", { locator: loc("/Player") }));
    const dx4 = (pos4post?.x || 0) - (pos4pre?.x || 0);
    const dy4 = (pos4post?.y || 0) - (pos4pre?.y || 0);
    console.log(`  After move+jump: ${JSON.stringify(pos4post)}  dx=${dx4.toFixed(4)} dy=${dy4.toFixed(4)}`);
    check("Combined move+jump: horizontal (dx > 0.1)", Math.abs(dx4) > 0.1);
    check("Combined move+jump: vertical (dy > 0.3)", dy4 > 0.3);

    // ── Console Logs ──
    console.log("\n=== Console Logs ===");
    const logs = await call("unity_editor_console_logs");
    if (logs.parsed?.logs) {
      const errors = logs.parsed.logs.filter(l => l.type === "error");
      const warnings = logs.parsed.logs.filter(l => l.type === "warning");
      console.log(`  Total: ${logs.parsed.logs.length} logs, ${errors.length} errors, ${warnings.length} warnings`);
      if (errors.length > 0) {
        console.log("  Errors:");
        for (const l of errors.slice(0, 5)) {
          console.log(`    ${l.message?.substring(0, 200)}`);
        }
      }
    }

    // Screenshot
    const ss = await call("unity_editor_screenshot", { view: "game" });
    console.log(`\n  Screenshot: ${ss.raw?.content?.[0]?.data?.length || 0} chars`);

    // Cleanup
    await call("unity_input_end_session", {});
    await call("unity_editor_stop", {});

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
