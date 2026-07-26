import assert from "node:assert/strict";
import test, { describe, after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// mcp-server root (from dist/__tests__/integration/ -> mcp-server/)
const MCP_SERVER_DIR = resolve(__dirname, "../../..");

describe("MCP Integration: server over stdio", { timeout: 30000 }, () => {
  let client: Client;
  let transport: StdioClientTransport;

  before(async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: ["dist/surfaces/index.js"],
      cwd: MCP_SERVER_DIR,
      stderr: "pipe",
    });

    client = new Client(
      { name: "integration-test", version: "0.0.1" },
    );

    await client.connect(transport);
  });

  after(async () => {
    try {
      await client.close();
    } catch {
      // Ignore close errors during cleanup
    }
  });

  test("tools/list returns the full op catalogue", async () => {
    const result = await client.listTools();

    // Asserted as a floor, not a frozen count: a hard 59 went stale the moment ops were
    // added and left test:all permanently red, which is how a later regression stayed
    // invisible. The op registry's own tests cover the exact catalogue.
    assert.ok(
      result.tools.length >= 120,
      `Expected the full catalogue (>=120 tools), got ${result.tools.length}`,
    );
  });

  test("tools/list: every tool is namespaced (unity_ or loombridge_)", async () => {
    const result = await client.listTools();

    for (const tool of result.tools) {
      assert.ok(
        tool.name.startsWith("unity_") || tool.name.startsWith("loombridge_"),
        `Tool name "${tool.name}" is not namespaced unity_/loombridge_`,
      );
    }
  });

  test("tools/list: unity_scene_create_object has correct inputSchema shape", async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "unity_scene_create_object");

    assert.ok(tool, "unity_scene_create_object should exist");
    assert.equal(tool!.inputSchema.type, "object");

    const props = tool!.inputSchema.properties as Record<string, unknown> | undefined;
    assert.ok(props, "Should have properties");
    assert.ok(props!.name, "Should have 'name' property");
    assert.ok(props!.parent, "Should have 'parent' property");
    assert.ok(props!.position, "Should have 'position' property");
  });

  test("tools/list: unity_editor_screenshot has view enum with scene and game", async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "unity_editor_screenshot");

    assert.ok(tool, "unity_editor_screenshot should exist");

    const props = tool!.inputSchema.properties as Record<string, { enum?: string[] }>;
    assert.ok(props?.view, "Should have 'view' property");
    assert.deepEqual(
      props.view.enum,
      ["scene", "game"],
      "view enum should contain exactly ['scene', 'game']",
    );
  });

  test("tools/list: unity_input_key_tap requires key argument", async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "unity_input_key_tap");
    assert.ok(tool, "unity_input_key_tap should exist");

    const props = tool!.inputSchema.properties as Record<string, { type?: string }>;
    const required = (tool!.inputSchema.required ?? []) as string[];

    assert.equal(props.key?.type, "string");
    assert.ok(required.includes("key"), "unity_input_key_tap should require key");
  });

  test("tools/call: scene tool returns stable envelope in connected or disconnected mode", async () => {
    const result = await client.callTool({
      name: "unity_scene_create_object",
      arguments: { name: "Test" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    assert.ok(content.length > 0, "Should have content");

    // Disconnected path: MCP wrapper returns a CONNECTION_ERROR payload.
    if (result.isError === true) {
      const text = content[0]!.text ?? "";
      assert.ok(
        text.includes("CONNECTION_ERROR") || text.includes("not connected"),
        `Error text should mention CONNECTION_ERROR or not connected, got: "${text}"`,
      );
      return;
    }

    // Connected path: tool call succeeded; response should be text/json envelope.
    assert.equal(result.isError ?? false, false, "Connected path should not set isError");
    const first = content[0]!;
    assert.equal(first.type, "text", "Connected path should return text/json for scene op");
    assert.doesNotThrow(() => JSON.parse(first.text ?? "{}"));
  });

  test("tools/call: unknown tool returns MCP error", async () => {
    await assert.rejects(
      () => client.callTool({ name: "nonexistent_tool", arguments: {} }),
      (err: Error) => {
        // MCP SDK throws McpError for MethodNotFound
        assert.ok(
          err.message.includes("Unknown tool") || err.message.includes("nonexistent_tool"),
          `Error should mention unknown tool, got: "${err.message}"`,
        );
        return true;
      },
    );
  });
});
