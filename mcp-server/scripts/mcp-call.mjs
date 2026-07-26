#!/usr/bin/env node
/**
 * Helper: send a single MCP tools/call and print the result.
 * Usage: node scripts/mcp-call.mjs <tool_name> [json_args]
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

const toolName = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

if (!toolName) {
  console.error("Usage: mcp-call.mjs <tool_name> [json_args]");
  process.exit(1);
}

async function main() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModulePath),
    import(stdioModulePath),
  ]);

  const transport = new StdioClientTransport({
    command: "/opt/homebrew/bin/node",
    args: [resolve(MCP_SERVER_DIR, "dist/surfaces/index.js")],
    cwd: MCP_SERVER_DIR,
  });

  const client = new Client({ name: "mcp-call", version: "1.0" });
  await client.connect(transport);

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const content = result?.content;
    if (content && content.length > 0) {
      for (const c of content) {
        if (c.type === "text") {
          console.log(c.text);
        } else if (c.type === "image") {
          console.log(`[IMAGE: ${c.mimeType}, ${c.data?.length || 0} chars base64]`);
        } else {
          console.log(JSON.stringify(c));
        }
      }
    } else {
      console.log(JSON.stringify(result));
    }
    if (result?.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
