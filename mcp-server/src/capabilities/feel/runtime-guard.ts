import { execFileSync } from "node:child_process";

import { formatBuildStamp, resolveBuildStamp, type BuildStamp } from "../../shared/build-stamp.js";

export interface FeelCaptureRuntimeGuardResult {
  status: "ok" | "warn";
  installed: BuildStamp;
  sourceCommit?: string;
  message: string;
}

function cleanCommit(commit: string): string {
  return commit.replace(/\+dirty$/, "");
}

export function readGitShortCommit(root: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateFeelCaptureRuntimeGuard(args: {
  sourceRoot?: string;
  installed?: BuildStamp;
  sourceCommit?: string;
} = {}): FeelCaptureRuntimeGuardResult {
  const installed = args.installed ?? resolveBuildStamp();
  const sourceCommit = args.sourceCommit ?? (args.sourceRoot ? readGitShortCommit(args.sourceRoot) : undefined);
  const installedLabel = formatBuildStamp(installed);

  if (sourceCommit && installed.commit !== "unknown" && cleanCommit(installed.commit) !== sourceCommit) {
    return {
      status: "warn",
      installed,
      sourceCommit,
      message:
        `Installed loombridge runtime is ${installedLabel}, but source checkout is ${sourceCommit}. ` +
        "Re-run scripts/loombridge-install-locally.sh before live feel capture.",
    };
  }

  if (installed.stampStatus !== "stamped") {
    return {
      status: "warn",
      installed,
      sourceCommit,
      message:
        `Installed loombridge runtime is ${installedLabel}; build stamp is incomplete. ` +
        "Re-run scripts/loombridge-install-locally.sh before relying on live feel capture.",
    };
  }

  return {
    status: "ok",
    installed,
    sourceCommit,
    message: `Installed loombridge runtime is ${installedLabel}.`,
  };
}
