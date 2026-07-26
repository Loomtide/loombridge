import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { OpRegistry } from "../surfaces/op-registry.js";
import { EDITOR_LIST_TOOL_NAME, EDITOR_USE_TOOL_NAME } from "../surfaces/editor-tools.js";
import {
  LOOMBRIDGE_DONENESS_TOOL_NAME,
  LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME,
  LOOMBRIDGE_PROJECT_INIT_TOOL_NAME,
  LOOMBRIDGE_STATUS_TOOL_NAME,
  LOOMBRIDGE_VERIFY_TOOL_NAME,
} from "../surfaces/loombridge-bridge-tools.js";
import {
  ROUTING_DOC_VERSION,
  SUGGESTED_ROUTING_LINE,
  parseRoutingDocVersion,
  renderRoutingDoc,
} from "../capabilities/setup/routing-doc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/__tests__ -> mcp-server/src is ../../src.
const CLI_SRC = path.resolve(__dirname, "../../src/surfaces/cli.ts");

/** Every verb the CLI dispatch actually handles (parsed from the switch, so it can't drift). */
function cliVerbs(): Set<string> {
  const src = readFileSync(CLI_SRC, "utf8");
  const verbs = new Set<string>();
  for (const m of src.matchAll(/case\s+"([a-z][a-z0-9-]*)":/g)) verbs.add(m[1]);
  return verbs;
}

describe("routing-doc (LOOMBRIDGE.md front door)", () => {
  test("REALITY CHECK: every tool/op/verb name in the template exists at HEAD", () => {
    const doc = renderRoutingDoc();
    const registry = new OpRegistry();
    const toolNames = new Set(registry.getAll().map((o) => o.toolName));
    const verbs = cliVerbs();

    // MCP tool names the doc points an agent at (unity_<category>_<op>).
    const mcpNames = [...doc.matchAll(/unity_[a-z0-9_]+/g)].map((m) => m[0]);
    assert.ok(mcpNames.length >= 8, `expected several MCP tool references, saw ${mcpNames.length}`);
    for (const name of mcpNames) {
      assert.ok(
        toolNames.has(name),
        `routing doc references MCP tool "${name}" which is NOT in the op registry (renamed/removed?)`,
      );
    }

    // CLI verbs the doc points at (`loombridge <verb>`).
    const cliRefs = [...doc.matchAll(/\bloombridge ([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    assert.ok(cliRefs.length >= 5, `expected several CLI verb references, saw ${cliRefs.length}`);
    for (const verb of cliRefs) {
      assert.ok(
        verbs.has(verb),
        `routing doc references CLI verb "loombridge ${verb}" which is NOT a case in cli.ts dispatch`,
      );
    }

    // loombridge_* MCP tool names (the server's own tools, distinct from unity_* ops). Any
    // template edit naming one must resolve against the SERVED tool names, not slip past
    // the unity_*/CLI-verb checks.
    // EXTEND this set when new loombridge_* MCP tools are registered on the server.
    const servedLoombridgeMcpTools = new Set<string>([
      EDITOR_LIST_TOOL_NAME,
      EDITOR_USE_TOOL_NAME,
      LOOMBRIDGE_STATUS_TOOL_NAME,
      LOOMBRIDGE_PROJECT_INIT_TOOL_NAME,
      LOOMBRIDGE_VERIFY_TOOL_NAME,
      LOOMBRIDGE_DONENESS_TOOL_NAME,
      LOOMBRIDGE_MOBILE_AUDIT_TOOL_NAME,
    ]);
    const loombridgeMcpRefs = [...doc.matchAll(/\bloombridge_[a-z0-9_]+/g)].map((m) => m[0]);
    for (const name of loombridgeMcpRefs) {
      assert.ok(
        servedLoombridgeMcpTools.has(name),
        `routing doc references MCP tool "${name}" which is NOT a served loombridge_* tool on this branch`,
      );
    }
  });

  test("template carries a parseable version marker matching ROUTING_DOC_VERSION", () => {
    const doc = renderRoutingDoc();
    assert.equal(parseRoutingDocVersion(doc), ROUTING_DOC_VERSION);
  });

  test("template is agent-facing, moment-of-need-first, and bounded (≤120 lines)", () => {
    const doc = renderRoutingDoc();
    const lines = doc.split("\n");
    assert.ok(lines.length <= 120, `LOOMBRIDGE.md is ${lines.length} lines (budget ≤120)`);
    // The routing TABLE (moment → surface) must come before the honesty prose.
    assert.ok(doc.indexOf("Route the moment") < doc.indexOf("Honesty rules"), "routing table must lead");
    // Header echoes the exact copy-paste line install prints.
    assert.ok(doc.includes(SUGGESTED_ROUTING_LINE), "header must echo the suggested CLAUDE.md/AGENTS.md line");
    // Honesty rules the agent must keep.
    for (const needle of [".loombridge/", "capture is not a verification", "Harness fault"]) {
      assert.ok(doc.includes(needle), `honesty rules must mention: ${needle}`);
    }
  });

  test("renderRoutingDoc is deterministic (byte-identical across calls) — makes re-install a no-op", () => {
    assert.equal(renderRoutingDoc(), renderRoutingDoc());
    assert.equal(renderRoutingDoc(3), renderRoutingDoc(3));
  });

  test("agent-surface line is OFF by default and AGENT-AWARE when enabled (Codex isn't left out)", () => {
    // Default render: no surface line at all, so a surface-off project is unchanged.
    const off = renderRoutingDoc();
    assert.doesNotMatch(off, /agent commands \+ skills installed/, "no surface line when the surface is absent");

    const on = renderRoutingDoc(ROUTING_DOC_VERSION, { agentSurfaceEnabled: true });
    assert.match(on, /agent commands \+ skills installed/, "surface line appears when enabled");
    // Claude gets slash commands; Codex is explicitly routed to its OWN skills dir AND told
    // the command bodies are readable prose (it can't run the `.claude/commands` as commands).
    assert.match(on, /\.codex\/skills\//, "Codex skills location is named");
    assert.match(on, /\.claude\/commands\/loombridge\/\*\.md/, "command prose path Codex can open+follow");
    assert.match(on, /Codex/, "the line addresses Codex explicitly");

    // Enabling the surface must NOT change the version marker (only a conditional line moved),
    // so surface-off projects never see churn; enabled projects refresh via content-aware sync.
    assert.equal(parseRoutingDocVersion(on), ROUTING_DOC_VERSION);
    assert.equal(parseRoutingDocVersion(off), ROUTING_DOC_VERSION);
  });

  test("parseRoutingDocVersion returns null for a user-authored file (no marker)", () => {
    assert.equal(parseRoutingDocVersion("# My own notes\nnothing loombridge here\n"), null);
    assert.equal(parseRoutingDocVersion("<!-- loombridge:routing-doc v7 -->\n# hi"), 7);
  });

  test("marker is anchored: a user file merely QUOTING the marker mid-body stays user-authored", () => {
    // Unanchored matching would claim this file as ours and clobber it on a version bump.
    const quoting = "# My notes about Loombridge\n\nThe generated file starts with `<!-- loombridge:routing-doc v1 -->`.\n";
    assert.equal(parseRoutingDocVersion(quoting), null);
    // Leading BOM / whitespace before OUR marker is still ours (editors add these).
    assert.equal(parseRoutingDocVersion("﻿<!-- loombridge:routing-doc v2 -->\n"), 2);
    assert.equal(parseRoutingDocVersion("\n  <!-- loombridge:routing-doc v3 -->\n"), 3);
    // parse(render()) round-trip survives the anchoring.
    assert.equal(parseRoutingDocVersion(renderRoutingDoc(5)), 5);
  });
});
