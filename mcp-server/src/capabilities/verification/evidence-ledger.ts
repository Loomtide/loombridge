/**
 * THE EVIDENCE LEDGER: the sha of every file a slice verdict actually graded, minted
 * INTO the verdict at verify time (H3), and re-checked whenever that verdict is
 * consulted later (L107).
 *
 * The hole this closes was observed live: the `juice` slice rewrote the very
 * quantities `parallax`'s approved verdict had graded, `parallax` stayed `approved`,
 * and nothing on any surface could tell that the approved verdict now described a
 * scene that no longer existed. A verdict that names its inputs but not their BYTES
 * cannot answer "is this still true?", and no amount of re-reading it will make it
 * able to.
 *
 * Three rules:
 *
 * 1. **The ledger is minted by the run that graded.** `verify --slice` writes it from
 *    the files the gates just read, so it can never describe a different capture than
 *    the verdict it sits in.
 * 2. **An ABSENT ledger is a REFUSAL, not a legacy path.** Every re-verify rewrites
 *    the verdict, so the migration is "re-verify the slice" and the refusal names that
 *    command. A skip-when-absent branch here would mean the only verdicts that escape
 *    the check are exactly the ones minted before it existed, which is the population
 *    it most needs to cover.
 * 3. **Origin is RE-DERIVED per file** (`domain/evidence-origin.ts`), never read from a
 *    typed field, and it is reported rather than gated: this module's refusals are
 *    about run BINDING and byte identity, not about who wrote the file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  deriveEvidenceOrigin,
  isCliWritten,
  renderOriginCounts,
  type EvidenceOrigin,
} from "../../domain/evidence-origin.js";

/** One graded evidence file, as recorded in the verdict. */
export interface EvidenceFileRecord {
  /** Path relative to the inputs dir the gates read (a bare filename today). */
  file: string;
  /** sha256 of the bytes the gates graded. */
  sha256: string;
  /** Re-derived from the file's own markers; never author-declared. */
  evidenceOrigin: EvidenceOrigin;
  /** The writer label AS RECORDED (a report label; null when absent). */
  writer: string | null;
  /** `_provenance.runId`, or null. */
  runId: string | null;
  /** `_provenance.editorSessionId` (or the routing block's), or null. */
  editorSessionId: string | null;
}

/** The block stamped onto a slice verdict under `evidence`. */
export interface EvidenceLedger {
  schemaVersion: "1";
  /** Inputs dir the gates read, relative to the project root. */
  inputsDir: string;
  /** The run this evidence was graded under (the verdict's own runId). */
  runId: string | null;
  files: EvidenceFileRecord[];
  /** Declared gate inputs with no file on disk at grade time (those gates degraded). */
  missing: string[];
}

/** sha256 hex of a file's bytes, or null when it cannot be read. */
export async function fileSha256(absPath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Mint the ledger from the files a run just graded. `files` is the declared evidence
 * set (see `sliceEvidenceFiles`); a declared file with nothing on disk lands in
 * `missing` rather than silently vanishing, so a later reader can tell "this gate
 * degraded" from "this gate was never asked for".
 */
export async function buildEvidenceLedger(args: {
  root: string;
  inputsDir: string;
  files: readonly string[];
  runId: string | null;
}): Promise<EvidenceLedger> {
  const records: EvidenceFileRecord[] = [];
  const missing: string[] = [];
  for (const file of [...args.files].sort()) {
    const abs = path.resolve(args.inputsDir, file);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      missing.push(file);
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A present-but-unparseable capture is still evidence the run READ (the gate
      // will have thrown or failed on it); it is hashed and reported as
      // agent-assembled, never dropped from the ledger.
      parsed = null;
    }
    const facts = deriveEvidenceOrigin(parsed);
    records.push({
      file,
      sha256: createHash("sha256").update(Buffer.from(raw, "utf-8")).digest("hex"),
      evidenceOrigin: facts.origin,
      writer: facts.writer,
      runId: facts.runId,
      editorSessionId: facts.editorSessionId,
    });
  }
  return {
    schemaVersion: "1",
    inputsDir: path.relative(args.root, args.inputsDir) || ".",
    runId: args.runId,
    files: records,
    missing,
  };
}

/** `produced 2, observed 1, agent-assembled 0` for a ledger's files. */
export function originSummary(ledger: EvidenceLedger): string {
  return renderOriginCounts(ledger.files.map((f) => f.evidenceOrigin));
}

// ── reading a ledger back off an untrusted verdict ────────────────────────────

export type LedgerRead = { ok: true; ledger: EvidenceLedger } | { ok: false; refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Read the ledger off a verdict document that came from disk.
 *
 * REFUSES on absent, on malformed, and on a file entry with no sha: each of those is a
 * verdict that cannot say which bytes it graded, which is the same standing as no
 * verdict at all. `reverifyHint` is the exact command that fixes it, because a refusal
 * an operator cannot act on is a refusal they route around.
 */
export function readEvidenceLedger(verdict: unknown, reverifyHint: string): LedgerRead {
  const refuse = (why: string): LedgerRead => ({
    ok: false,
    refusal: `${why}; re-verify to mint one: ${reverifyHint}`,
  });
  if (!isRecord(verdict)) return refuse("the verdict is not a JSON object");
  const block = verdict.evidence;
  if (block === undefined) {
    return refuse(
      "the verdict records NO evidence shas (`evidence` is absent), so nothing binds it to the bytes it graded",
    );
  }
  if (!isRecord(block)) return refuse("the verdict's `evidence` block is not an object");
  if (!Array.isArray(block.files)) return refuse("the verdict's `evidence.files` is not an array");

  const files: EvidenceFileRecord[] = [];
  for (const [index, entry] of block.files.entries()) {
    if (!isRecord(entry)) return refuse(`the verdict's \`evidence.files[${index}]\` is not an object`);
    const file = optionalString(entry.file);
    const sha256 = optionalString(entry.sha256);
    if (!file) return refuse(`the verdict's \`evidence.files[${index}].file\` is missing`);
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      return refuse(`the verdict records no valid sha256 for evidence file "${file}"`);
    }
    const origin = optionalString(entry.evidenceOrigin);
    files.push({
      file,
      sha256,
      evidenceOrigin:
        origin === "produced" || origin === "observed" ? origin : "agent-assembled",
      writer: optionalString(entry.writer),
      runId: optionalString(entry.runId),
      editorSessionId: optionalString(entry.editorSessionId),
    });
  }
  return {
    ok: true,
    ledger: {
      schemaVersion: "1",
      inputsDir: optionalString(block.inputsDir) ?? ".",
      runId: optionalString(block.runId),
      files,
      missing: Array.isArray(block.missing) ? block.missing.filter((m): m is string => typeof m === "string") : [],
    },
  };
}

/**
 * Re-hash every ledgered file against disk. Returns one refusal sentence per file whose
 * bytes moved (or vanished) since the verdict was minted: THE stale-approval refusal.
 * `label` names the slice so a multi-slice roll-up says which approval went stale.
 */
export async function staleEvidenceRefusals(args: {
  ledger: EvidenceLedger;
  inputsDir: string;
  label: string;
  reverifyHint: string;
}): Promise<string[]> {
  const refusals: string[] = [];
  for (const record of args.ledger.files) {
    const actual = await fileSha256(path.resolve(args.inputsDir, record.file));
    if (actual === null) {
      refusals.push(
        `${args.label}: evidence file "${record.file}" is GONE since the verdict was minted ` +
          `(the approval graded sha ${record.sha256.slice(0, 12)}); re-capture and re-verify: ${args.reverifyHint}`,
      );
      continue;
    }
    if (actual !== record.sha256) {
      refusals.push(
        `${args.label}: evidence file "${record.file}" CHANGED since the verdict was minted ` +
          `(approved sha ${record.sha256.slice(0, 12)}, on disk ${actual.slice(0, 12)}) — the approval describes ` +
          `evidence that no longer exists; re-verify: ${args.reverifyHint}`,
      );
    }
  }
  return refusals;
}

// ── run binding at grade time (E4 / L106) ─────────────────────────────────────

export interface RunBindingResult {
  /** Hard refusals: CLI-written evidence that does not belong to this run/session. */
  refusals: string[];
  /** Warn-level notes: agent-assembled files, already capped at warn upstream. */
  notes: string[];
}

/**
 * Bind the evidence to the run the verdict is being minted under.
 *
 * TWO CHECKS, both refuse-not-skip on the CLI-written files:
 *
 *  1. `_provenance.runId` must equal the minted runId. A produced file from another
 *     run is a measurement of another build; grading it and stamping this run's id on
 *     the verdict is precisely the mixed-vintage certificate L106 recorded.
 *  2. Every CLI-written file in one slice's evidence dir must carry the SAME
 *     `editorSessionId`. Three files from three play sessions all stamped with one
 *     runId is what actually happened on the door-one run: runId is minted by `build`
 *     and says nothing about co-temporality, so the session id is the only field that
 *     can answer "was this one sitting?".
 *
 * AGENT-ASSEMBLED FILES ARE NOT HARD-REFUSED HERE. They carry no producer marker, are
 * already capped at warn by the gates that read them, and hard-refusing them now would
 * turn an existing warn into a wall for every project that has not yet moved a file to
 * a producer. They get a NOTE instead, which is where their ceiling already is.
 */
export function runBindingRefusals(args: {
  ledger: EvidenceLedger;
  mintedRunId: string | null;
  label: string;
}): RunBindingResult {
  const refusals: string[] = [];
  const notes: string[] = [];
  const cliWritten = args.ledger.files.filter((f) => isCliWritten(f.evidenceOrigin));

  if (cliWritten.length > 0 && !args.mintedRunId) {
    refusals.push(
      `${args.label}: ${cliWritten.length} CLI-written evidence file(s) carry a runId but this verify has NO run to ` +
        "bind them to (no `currentBuild.runId` and no slice proof runId) — refusing rather than grading unbound evidence",
    );
  }

  for (const record of cliWritten) {
    if (!record.runId) {
      refusals.push(
        `${args.label}: "${record.file}" is ${record.evidenceOrigin} by ${record.writer ?? "a CLI producer"} but carries ` +
          "NO `_provenance.runId`, so it cannot be bound to any run (absent is a refusal, never a skipped check)",
      );
      continue;
    }
    if (args.mintedRunId && record.runId !== args.mintedRunId) {
      refusals.push(
        `${args.label}: "${record.file}" was produced under run \`${record.runId}\`, but this verdict is being minted ` +
          `under \`${args.mintedRunId}\` — evidence from another run cannot certify this one; re-capture it`,
      );
    }
  }

  // L106: co-temporality across the slice's own evidence dir.
  const sessions = new Map<string, string[]>();
  for (const record of cliWritten) {
    if (!record.editorSessionId) {
      refusals.push(
        `${args.label}: "${record.file}" is CLI-written but carries no \`editorSessionId\`, so nothing can show it came ` +
          "from the same editor session as the rest of this slice's evidence",
      );
      continue;
    }
    const bucket = sessions.get(record.editorSessionId) ?? [];
    bucket.push(record.file);
    sessions.set(record.editorSessionId, bucket);
  }
  if (sessions.size > 1) {
    const rendered = [...sessions.entries()]
      .map(([session, files]) => `${session} (${files.join(", ")})`)
      .join(" vs ");
    refusals.push(
      `${args.label}: this slice's evidence came from ${sessions.size} DIFFERENT editor sessions — ${rendered}. ` +
        "One slice's verdict must describe one sitting; re-capture the slice in a single session (L106)",
    );
  }

  for (const record of args.ledger.files.filter((f) => !isCliWritten(f.evidenceOrigin))) {
    if (args.mintedRunId && record.runId && record.runId !== args.mintedRunId) {
      notes.push(
        `${args.label}: "${record.file}" is agent-assembled and claims run \`${record.runId}\`, not \`${args.mintedRunId}\` ` +
          "(warn-level: agent-assembled evidence is already capped below a certifying pass)",
      );
    } else if (!record.runId) {
      notes.push(
        `${args.label}: "${record.file}" is agent-assembled (no CLI producer marker), so this gate's evidence is ` +
          "self-authored (warn-level)",
      );
    }
  }
  return { refusals, notes };
}
