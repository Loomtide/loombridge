/**
 * Which hero-shot GENERATION backends this machine can offer.
 *
 * Implements Docs/Design/HeroShotAuthoring.md §3. The split is deliberate and load-bearing:
 *
 *   DETECTION is the CLI's job   - local, deterministic, cheap, and it never chooses.
 *   GENERATION is NOT the CLI's job - the agent runs the image tool with its own credentials.
 *
 * Keeping generation out of here keeps provider retries, cost, rate limits and API-key handling
 * out of a tool whose job is deterministic grading. It is also the arrangement already proven in
 * practice: a real 3D game was built driving these tools agent-side with no CLI involvement.
 *
 * DETECTION MUST NOT SELECT. An available backend is an offer. Claude and codex produce visibly
 * different art, and the hero shot is the single artifact the whole build is later graded against,
 * so silently picking one is a surprise on the worst possible artifact. Callers present what is
 * here and let the human choose.
 */
import { spawnSync } from "node:child_process";

/** A local command probe: returns the process result, or null when the binary is absent. */
export type ProbeExec = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout?: string | null } | null;

export interface BackendStatus {
  /** Backend id, e.g. `codex`. */
  id: string;
  available: boolean;
  /** Version string when the probe reported one. Absent is fine: presence is what gates the offer. */
  version?: string;
  /** Human-readable one-liner for a doctor row or a prompt. */
  detail: string;
}

/**
 * `shell: true` on Windows, for the same reason `cli-self-update.ts` needs it: npm-installed CLIs
 * land as `.cmd`/`.ps1` shims that `spawnSync` cannot exec directly, so a probe without it reports
 * "not installed" on a machine where the tool works fine in every shell.
 */
const probeSpawnOptions = { shell: process.platform === "win32" } as const;

/**
 * Default probe. Returns null on ENOENT (binary absent) rather than throwing, because "not
 * installed" is a NORMAL answer here, not an error: zero backends is a legitimate configuration
 * (paste a reference, or let the agent compose one directly).
 *
 * The timeout is not optional. `doctor` must stay fast and must never hang on a wedged binary, so
 * a probe that does not answer promptly is treated as unavailable.
 */
export function defaultProbe(timeoutMs = 5000): ProbeExec {
  return (cmd, args) => {
    try {
      const result = spawnSync(cmd, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        ...probeSpawnOptions,
        // Never inherit: this runs inside a CLI whose stdout may be a structured channel, and the
        // value is parsed rather than displayed.
        stdio: ["ignore", "pipe", "pipe"],
      });
      // ENOENT surfaces as an `error` on the result rather than a throw.
      if (result.error) return null;
      return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : null };
    } catch {
      return null;
    }
  };
}

/**
 * Probe the `codex` CLI.
 *
 * Verified surface at the time of writing: `codex --version` prints `codex-cli 0.145.0`. Only
 * PRESENCE gates the offer; the version is reported so a user can see what would run, never
 * compared against a minimum. A version floor would be a guess about a third-party tool's
 * behaviour that nothing here can verify, and it would refuse working setups.
 */
export function detectCodex(probe: ProbeExec = defaultProbe()): BackendStatus {
  const result = probe("codex", ["--version"]);
  if (!result || result.status !== 0) {
    return {
      id: "codex",
      available: false,
      detail: "codex: not found (optional; only needed if you want codex to generate the hero shot)",
    };
  }
  const version = (result.stdout ?? "").trim().split("\n")[0]?.trim();
  return {
    id: "codex",
    available: true,
    version: version && version.length > 0 ? version : undefined,
    detail: version && version.length > 0 ? `codex: available (${version})` : "codex: available",
  };
}

/**
 * Every generation backend, in the order a caller should present them.
 *
 * `claude` (this agent composing the frame directly) is ALWAYS available and always first: it
 * needs nothing installed, so a project is never left with zero ways to produce a hero shot. That
 * is what makes "no backends detected" a non-event rather than a blocker, and why the doctor row
 * below is informational rather than a warning.
 */
export function detectGenerationBackends(probe: ProbeExec = defaultProbe()): BackendStatus[] {
  return [
    {
      id: "claude",
      available: true,
      detail: "this agent: available (composes the frame directly; nothing to install)",
    },
    detectCodex(probe),
  ];
}

/**
 * The doctor row. INFO, never warn, and never fail.
 *
 * Answers HeroShotAuthoring.md open question 2. A warning would imply a missing dependency, and
 * nothing is missing: an optional accelerator being absent is a legitimate, fully supported
 * configuration. Warning on it would train users to ignore doctor warnings, which is the only
 * thing that makes a real warning worthless.
 */
export function generationBackendsDoctorDetail(backends: BackendStatus[]): string {
  const available = backends.filter((b) => b.available);
  const names = available.map((b) => b.version ?? b.id).join(", ");
  return `${available.length} of ${backends.length} hero-shot generation backend(s) available: ${names}`;
}
