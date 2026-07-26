import path from "node:path";

import { designStatus } from "./design.js";
import { loombridgePaths, readState } from "../../domain/state.js";
import { readSlicePlan } from "./slices.js";
import { computeStatusModel, developerNextAction, type LoombridgeStatusModel } from "./status-model.js";

export interface AskArgs {
  root: string;
  question?: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): AskArgs | ParseHelp {
  let root = process.cwd();
  const questionParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") {
      const value = args[(i += 1)];
      if (!value || value.startsWith("--")) {
        console.error("[loombridge ask] --root requires a project directory.");
        return { help: true, usageError: true };
      }
      root = path.resolve(value);
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else questionParts.push(arg);
  }

  const question = questionParts.join(" ").trim();
  return { root, ...(question ? { question } : {}) };
}

function progressLine(model: LoombridgeStatusModel): string {
  if (!model.hasRoadmap) return "No slice roadmap exists yet.";
  return `${model.counts.approved}/${model.counts.total} slices approved.`;
}

function currentSliceSummary(model: LoombridgeStatusModel): string {
  if (!model.currentSlice) {
    return model.hasRoadmap ? "No current slice is waiting." : "No current slice yet; run the planning flow first.";
  }
  const s = model.currentSlice;
  return `${s.id} (${s.state}) — ${s.title}.`;
}

function currentSliceDetails(model: LoombridgeStatusModel): string {
  if (!model.currentSlice) return currentSliceSummary(model);
  const s = model.currentSlice;
  const deps = s.dependsOn.length ? s.dependsOn.join(", ") : "none";
  return `${s.id} (${s.state}) — ${s.title}. Skill: ${s.skill}. Gates: ${s.acceptance.gates.join(", ")}. Dependencies: ${deps}.`;
}

function nextLine(model: LoombridgeStatusModel): string {
  return `Next: ${developerNextAction(model)}`;
}

function warningLines(model: LoombridgeStatusModel): string[] {
  const warnings = [...model.warnings];
  if (!model.designApproved) {
    const label = model.designStatus === "approved" ? "approved but changed since approval" : model.designStatus;
    warnings.unshift(`Design Target is not ready (${label}).`);
  }
  return warnings;
}

function warningSummary(model: LoombridgeStatusModel): string | null {
  const warnings = warningLines(model);
  if (warnings.length === 0) return null;
  return `${warnings.length} warning${warnings.length === 1 ? "" : "s"} need attention. Ask "warnings" for details.`;
}

export function answerAsk(model: LoombridgeStatusModel, question?: string): string {
  const q = (question ?? "").toLowerCase();
  const lines: string[] = [];

  const wantsProgress = !q || /\b(where|status|progress)\b/.test(q);
  const wantsNext = /\b(next|what do i do|what should i do|do next)\b/.test(q);
  const wantsApproval = /\b(approve|approval|waiting)\b/.test(q);
  const wantsBlocked = /\b(blocked|warning|warnings|fail|failing|failed)\b/.test(q);
  const wantsSlice = /\b(slice|current)\b/.test(q);

  if (wantsProgress) {
    lines.push(`Progress: ${progressLine(model)}`);
    lines.push(`Current: ${currentSliceSummary(model)}`);
    lines.push(nextLine(model));
    const summary = warningSummary(model);
    if (summary) lines.push(`Warnings: ${summary}`);
    return lines.join("\n");
  }

  if (wantsNext) {
    lines.push(nextLine(model));
    if (model.nextCommand.startsWith("loombridge capture --slice ")) {
      lines.push("Reason: the current slice is built but still needs evidence before it can be verified.");
    } else if (model.nextCommand.startsWith("loombridge verify")) {
      lines.push("Reason: the current slice is built and ready for verification.");
    } else if (model.nextCommand === "loombridge build") {
      lines.push("Reason: the current slice is pending or stale and ready to build.");
    }
    const summary = warningSummary(model);
    if (summary) lines.push(`Watch: ${summary}`);
    return lines.join("\n");
  }

  if (wantsApproval) {
    if (model.awaitingApproval.length) {
      lines.push(`Waiting for approval: ${model.awaitingApproval.map((s) => `${s.id} — ${s.title}`).join(", ")}.`);
      lines.push("Approval is the human checkpoint between a verified slice and advancing the roadmap.");
      lines.push(`Next: ${developerNextAction(model)}`);
    } else {
      lines.push("No slice is currently waiting for approval.");
      lines.push(nextLine(model));
    }
    return lines.join("\n");
  }

  if (wantsBlocked) {
    const warnings = warningLines(model);
    if (warnings.length) {
      lines.push("Blocked or risky:");
      for (const warning of warnings) lines.push(`- ${warning}`);
    } else {
      lines.push("No proof/capture warnings are currently reported.");
      lines.push(nextLine(model));
    }
    return lines.join("\n");
  }

  if (wantsSlice) {
    lines.push(`Current slice: ${currentSliceDetails(model)}`);
    lines.push(nextLine(model));
    return lines.join("\n");
  }

  lines.push(`Progress: ${progressLine(model)}`);
  lines.push(`Current: ${currentSliceSummary(model)}`);
  lines.push(nextLine(model));
  lines.push("You can ask about progress, next step, current slice, approval, or warnings.");
  return lines.join("\n");
}

export async function runAsk(args: AskArgs): Promise<number> {
  const paths = loombridgePaths(args.root);
  try {
    const [state, plan, design] = await Promise.all([
      readState(paths),
      readSlicePlan(paths),
      designStatus(paths),
    ]);
    const model = await computeStatusModel({ paths, state, plan, design });
    console.log(answerAsk(model, args.question));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge ask] ${message}`);
    return 2;
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge ask [question...] [options]",
      "",
      "Read-only explanation of the current Loombridge project state. Answers from",
      "local .loombridge/ state only; never builds, captures, verifies, plans, or approves.",
      "",
      "Examples:",
      "  loombridge ask where are we",
      "  loombridge ask what should I do next",
      "  loombridge ask why is approval needed",
      "",
      "Options:",
      "  --root <dir>    Project root (default: cwd)",
      "  -h, --help      Show this help",
    ].join("\n"),
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  return runAsk(parsed);
}
