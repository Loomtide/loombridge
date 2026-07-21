#!/usr/bin/env tsx
/**
 * tools-doc-gen.ts — Auto-generates TOOLS.md from the OpRegistry.
 *
 * Usage: tsx src/tools-doc-gen.ts
 * npm script: npm run docs:tools
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpRegistry, type OpDef } from "./op-registry.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Extract the category from a command string (e.g. "scene" from "scene.create_object"). */
function getCategory(command: string): string {
  return command.split(".")[0];
}

/** Title-case a category name (e.g. "scene" -> "Scene"). */
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Category display names. */
const CATEGORY_NAMES: Record<string, string> = {
  scene: "Scene Operations",
  editor: "Editor Operations",
  component: "Component Operations",
  code: "Code Operations",
  animator: "Animator Operations",
  ui: "UI Operations",
  asset: "Asset Operations",
  package: "Package Operations",
};

interface PropInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Extract flat property list from a JSON Schema object. */
function extractProperties(schema: Record<string, unknown>): PropInfo[] {
  const props: PropInfo[] = [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties) return props;

  for (const [name, def] of Object.entries(properties)) {
    const type = formatType(def);
    const desc = (def.description as string) || "";
    props.push({
      name,
      type,
      required: required.includes(name),
      description: desc,
    });
  }

  return props;
}

/** Format a JSON Schema type into a readable string. */
function formatType(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined;

  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      return `${formatType(items)}[]`;
    }
    return "array";
  }

  if (type === "object") {
    // Check if it has named properties (structured object)
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties) {
      return "object";
    }
    return "object";
  }

  if (schema.enum) {
    const values = schema.enum as string[];
    return values.map((v) => `"${v}"`).join(" \\| ");
  }

  return type || "any";
}

// ─────────────────────────────────────────────
// Main Generation
// ─────────────────────────────────────────────

function generateToolsDoc(): string {
  const registry = new OpRegistry();
  const allOps = registry.getAll();

  // Group by category
  const grouped = new Map<string, OpDef[]>();
  for (const op of allOps) {
    const cat = getCategory(op.command);
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push(op);
  }

  const lines: string[] = [];

  // Header
  lines.push("# Loomtide Tools Reference");
  lines.push("");
  lines.push(`> Auto-generated from OpRegistry. ${allOps.length} tools across ${grouped.size} categories.`);
  lines.push(">");
  lines.push("> Regenerate: \\`npm run docs:tools\\`");
  lines.push("");

  // Table of contents
  lines.push("## Table of Contents");
  lines.push("");
  for (const [cat, ops] of grouped) {
    const displayName = CATEGORY_NAMES[cat] || `${titleCase(cat)} Operations`;
    const anchor = displayName.toLowerCase().replace(/\s+/g, "-");
    lines.push(`- [${displayName}](#${anchor}) (${ops.length} tools)`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Each category
  for (const [cat, ops] of grouped) {
    const displayName = CATEGORY_NAMES[cat] || `${titleCase(cat)} Operations`;
    lines.push(`## ${displayName}`);
    lines.push("");

    // Summary table
    lines.push("| Tool | Description |");
    lines.push("|------|-------------|");
    for (const op of ops) {
      lines.push(`| \`${op.toolName}\` | ${op.description} |`);
    }
    lines.push("");

    // Detailed section for each tool
    for (const op of ops) {
      lines.push(`### ${op.toolName}`);
      lines.push("");
      lines.push(op.description);
      lines.push("");
      lines.push(`**Wire command:** \`${op.command}\``);
      lines.push("");

      const props = extractProperties(op.inputSchema);
      if (props.length > 0) {
        lines.push("**Parameters:**");
        lines.push("");
        lines.push("| Name | Type | Required | Description |");
        lines.push("|------|------|----------|-------------|");
        for (const p of props) {
          lines.push(`| \`${p.name}\` | ${p.type} | ${p.required ? "Yes" : "No"} | ${p.description} |`);
        }
        lines.push("");
      } else {
        lines.push("*No parameters.*");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

const output = generateToolsDoc();
const scriptPath = fileURLToPath(import.meta.url);
const outPath = path.join(path.dirname(scriptPath), "..", "TOOLS.md");
fs.writeFileSync(outPath, output, "utf-8");

console.log(`Generated TOOLS.md at ${outPath}`);
const lineCount = output.length === 0
  ? 0
  : output.endsWith("\n")
    ? output.split("\n").length - 1
    : output.split("\n").length;
console.log(`Total lines: ${lineCount}`);
