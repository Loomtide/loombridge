/**
 * THE ROLL-UP DOOR (E5/L109): bare `loombridge verify` for a slice-planned project.
 *
 * The gap this closes was total. A 9/9 approved project's evidence lives in
 * `.loombridge/verify/<slice>/`, while bare `verify` reads the FLAT
 * `.loombridge/verify/`, so the front door refused with "nothing was graded" and there
 * was no legal route to green. The closer refused to copy slice evidence up to make it
 * pass, correctly: that would mix capture vintages and certify a fiction.
 *
 * So the door learns the layout instead, and it does the three things a roll-up has to
 * do to be worth anything:
 *
 * 1. **RE-GRADE, never re-read** (H2). The gates are pure functions over parsed JSON,
 *    so the roll-up re-runs each approved slice's own gate list over its own evidence
 *    dir and compares the result with the stored verdict. A verdict whose headline was
 *    hand-edited diverges from its own inputs and is refused. A roll-up that merely
 *    summed nine stored `status: "pass"` fields would certify nine strings.
 * 2. **BIND TO THE BYTES** (H3/L107). Each verdict carries a sha per evidence file
 *    (`evidence-ledger.ts`). The roll-up re-hashes them: a later slice that rewrote an
 *    earlier slice's inputs is the stale-approval refusal, naming the file and the
 *    slice. A verdict with NO ledger is refused outright — no legacy path, because
 *    "verdicts minted before the check existed" is exactly the population that needs
 *    it, and every re-verify mints one.
 * 3. **COVER THE CONTRACT** (H1/L108). The union of the approved slices' gates must
 *    walk every contract section that declares required content. `manifest.elements`
 *    requiring a goal object while `manifest` is in no slice's gate list is a 9/9
 *    project that never checked its own contract.
 *
 * THE SLICE-LEVEL PREDICATES ARE DONENESS'S (H4): `isSliceDone` is imported, never
 * reimplemented. Two predicates for "is this slice done" is one predicate away from
 * two answers.
 *
 * ANCHORING (M17), stated in `resolveUnifiedOutcome`'s own terms: this section is
 * ANCHORED only when at least one slice was RE-GRADED GREEN and contract coverage
 * passed. A human approval (`proof.approvedAt`) is the frozen anchor here, but an
 * approval whose evidence no longer re-grades is not an anchor that was COMPARED, and
 * the FXH zero-anchored rule exists precisely so a self-produced green cannot exit 0.
 * A refused roll-up is therefore exit 2 (harness tier: a statement about the evidence,
 * not a defect in the game) and `anchored: false`, so a project with per-slice dirs and
 * an empty flat dir can never improve its exit by this section merely existing.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { isWithin } from "../../domain/capture-paths.js";
import type { LoombridgePaths } from "../../domain/state.js";
import { isSliceDone } from "./doneness.js";
import {
  evidenceCoverageRefusals,
  fileSha256,
  originSummary,
  readEvidenceLedger,
  staleEvidenceRefusals,
} from "./evidence-ledger.js";
import { contractCoverageRefusals, runGates, sliceEvidenceFiles } from "./run-gates.js";
import { getSliceVerdictPath, getSliceVerifyDir, type SliceEntry, type SlicePlan } from "./slices.js";
import type { AcceptanceContract } from "./types.js";

/** One approved slice's roll-up row. */
export interface SliceRollupSlice {
  id: string;
  /** Root-relative path of the verdict this row read. */
  verdictPath: string;
  /** sha256 of the verdict document itself: the project verdict binds to THIS. */
  verdictSha256: string | null;
  /** True only when the re-grade reproduced the stored verdict AND it was green. */
  regradedGreen: boolean;
  /** `produced N, observed N, agent-assembled N` for this slice's ledgered evidence. */
  originSummary: string | null;
  refusals: string[];
  notes: string[];
}

export interface SliceRollupResult {
  totalSlices: number;
  approvedSlices: number;
  regradedGreen: number;
  slices: SliceRollupSlice[];
  /** H1: contract sections that declare required content and no gate walks. */
  coverageRefusals: string[];
  /** Every refusal, slice rows first then coverage, in print order. */
  refusals: string[];
  notes: string[];
  /** M17: at least one slice re-graded green AND coverage passed AND nothing refused. */
  anchored: boolean;
  /** 0 when the roll-up certifies, 2 otherwise. Never 1: a refusal here is harness tier. */
  exit: number;
  status: "pass" | "refused";
}

/**
 * The exact command an operator runs to re-mint one slice's verdict. No `--strict`:
 * slice verify is strict by DEFAULT (a warn never exits 0), so the flag would now only
 * imply that the plain command grades more leniently than this one.
 */
export function reverifyCommand(root: string, sliceId: string): string {
  return `loombridge verify --root ${root} --slice ${sliceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-grade one approved slice and bind its verdict to the bytes on disk.
 *
 * Every failure is collected rather than short-circuited: an operator fixing a stale
 * roll-up needs the whole list, and a first-refusal-wins loop would hand it to them one
 * re-run at a time.
 */
async function rollUpOneSlice(args: {
  root: string;
  paths: LoombridgePaths;
  acceptance: AcceptanceContract;
  slice: SliceEntry;
}): Promise<SliceRollupSlice> {
  const { root, paths, slice } = args;
  const label = `slice ${slice.id}`;
  const hint = reverifyCommand(root, slice.id);
  const refusals: string[] = [];
  const notes: string[] = [];

  // H4: the slice-level predicates are doneness's. Freshness, run binding, the
  // capture-manifest completeness rules and the state check all come from there.
  const done = await isSliceDone(slice, paths);
  for (const reason of done.reasons) refusals.push(`${label}: ${reason}`);

  const verdictAbs = slice.proof?.verdictPath
    ? path.resolve(root, slice.proof.verdictPath)
    : getSliceVerdictPath(paths, slice.id);
  const verdictRel = path.relative(root, verdictAbs);
  const verdictSha256 = await fileSha256(verdictAbs);

  let verdict: unknown = null;
  try {
    verdict = JSON.parse(await fs.readFile(verdictAbs, "utf-8"));
  } catch {
    refusals.push(
      `${label}: the approved verdict at ${verdictRel} is missing or unreadable, so there is nothing to re-grade; ${hint}`,
    );
    return { id: slice.id, verdictPath: verdictRel, verdictSha256, regradedGreen: false, originSummary: null, refusals, notes };
  }

  // H3: no ledger, no certificate. Stated as a refusal with the re-verify command,
  // never as a legacy skip.
  const read = readEvidenceLedger(verdict, hint);
  if (!read.ok) {
    refusals.push(`${label}: ${read.refusal}`);
    return { id: slice.id, verdictPath: verdictRel, verdictSha256, regradedGreen: false, originSummary: null, refusals, notes };
  }
  const ledger = read.ledger;

  // The inputs dir the verdict says it graded, resolved against the root and CONTAINED:
  // a hand-edited `evidence.inputsDir` must not be able to point the re-grade at
  // someone else's (or a fixture's) evidence.
  const recordedInputs = path.resolve(root, ledger.inputsDir);
  const defaultInputs = getSliceVerifyDir(paths, slice.id);
  let inputsDir = defaultInputs;
  if (!isWithin(root, recordedInputs)) {
    refusals.push(
      `${label}: the verdict records an evidence dir OUTSIDE the project (${ledger.inputsDir}); refusing to re-grade against it`,
    );
  } else {
    inputsDir = recordedInputs;
    if (recordedInputs !== defaultInputs) {
      notes.push(
        `${label}: the verdict graded ${ledger.inputsDir}, not the slice's default ${path.relative(root, defaultInputs)}`,
      );
    }
  }

  // THE LEDGER'S DENOMINATOR, CHECKED BEFORE ITS CONTENTS ARE TRUSTED.
  //
  // `staleEvidenceRefusals` below iterates `ledger.files`, so its thoroughness is exactly
  // the length of that array: a ledger with no entries re-hashed nothing and refused
  // nothing. Nothing here ever cross-checked it against `sliceEvidenceFiles`, the
  // deterministic set `verify --slice` minted it from, even though the slice's own
  // `acceptance.gates` is right there and re-derives it for free. Demonstrated: mutate a
  // graded evidence byte inside the passing band (so the re-grade below still reproduces
  // the stored verdict) and trim `evidence.files` from 4 to 0, and this roll-up went from
  // `exit 2 / refused` to `exit 0 / pass / anchored: true`.
  //
  // ORDER IS DELIBERATE: the coverage refusal is pushed BEFORE the byte-identity refusals,
  // so an operator reading the list sees "your verdict names 0 of 4 files" before (or
  // instead of) a silence that would otherwise read as "all four are fine".
  refusals.push(
    ...evidenceCoverageRefusals({
      ledger,
      declaredFiles: sliceEvidenceFiles(slice.acceptance.gates),
      label,
      reverifyHint: hint,
    }),
  );

  // L107 at door level: the approval must still describe the bytes on disk.
  refusals.push(...(await staleEvidenceRefusals({ ledger, inputsDir, label, reverifyHint: hint })));

  // H2: re-run this slice's gate list over that evidence and compare with the stored
  // verdict. The gates are pure over parsed JSON, so this costs no editor and no
  // capture, and it is the only thing that makes a stored `pass` mean anything.
  const stored = isRecord(verdict) ? verdict : {};
  const storedGates = isRecord(stored.gates) ? (stored.gates as Record<string, unknown>) : {};
  const storedStatus = typeof stored.status === "string" ? stored.status : "(absent)";
  const gates = [...slice.acceptance.gates];
  let regradedGreen = false;
  // A VLM-DERIVED GATE CANNOT BE RE-GRADED OFFLINE, and saying so is the honest answer.
  // `frame-integrity` is computed from the findings file `--vlm` pointed at, which the
  // verdict does not record, so a silent re-grade would report it `(absent)` and
  // present a harness limitation as a divergence. Named explicitly instead.
  if (gates.includes("frame-integrity")) {
    refusals.push(
      `${label}: the gate list includes \`frame-integrity\`, which is derived from the \`--vlm\` findings file and ` +
        "cannot be re-graded from disk alone, so this slice's stored verdict cannot be re-checked by the roll-up. " +
        "Grade VLM fidelity through `loombridge doneness` (where model judgment belongs) rather than in a slice's " +
        "deterministic gate list.",
    );
  }
  try {
    const regraded = await runGates({
      acceptance: args.acceptance,
      inputsDir,
      selectGates: new Set(gates),
    });
    const divergences: string[] = [];
    if (regraded.status !== storedStatus) {
      divergences.push(`overall status stored \`${storedStatus}\`, re-graded \`${regraded.status}\``);
    }
    for (const gate of gates) {
      const before = typeof storedGates[gate] === "string" ? (storedGates[gate] as string) : "(absent)";
      const after = regraded.gates[gate] ?? "(absent)";
      if (before !== after) divergences.push(`gate \`${gate}\` stored \`${before}\`, re-graded \`${after}\``);
    }
    if (divergences.length > 0) {
      refusals.push(
        `${label}: the stored verdict DIVERGES from re-grading its own evidence (${divergences.join("; ")}). ` +
          "Either the verdict was edited, or the ACCEPTANCE contract changed since the approval and the slice was " +
          `never re-verified against it; both make the approval unusable as a certificate. ${hint}`,
      );
    } else if (regraded.status === "pass") {
      regradedGreen = true;
    } else {
      refusals.push(
        `${label}: re-grading its own evidence yields \`${regraded.status}\`, not \`pass\`, so this approval is not green today`,
      );
    }
  } catch (error) {
    refusals.push(
      `${label}: re-grading threw (${error instanceof Error ? error.message : String(error)}) — a slice whose evidence ` +
        "cannot be re-graded is a harness fault, never a pass",
    );
  }

  return {
    id: slice.id,
    verdictPath: verdictRel,
    verdictSha256,
    regradedGreen: regradedGreen && refusals.length === 0,
    originSummary: originSummary(ledger),
    refusals,
    notes,
  };
}

/**
 * Grade the roll-up. PURE of console output (the caller prints), so the orchestrator
 * section and any test read the same decision.
 */
export async function evaluateSliceRollup(args: {
  root: string;
  paths: LoombridgePaths;
  acceptance: AcceptanceContract;
  plan: SlicePlan;
}): Promise<SliceRollupResult> {
  const approved = args.plan.slices.filter((s) => s.state === "approved");
  const slices: SliceRollupSlice[] = [];
  for (const slice of approved) {
    slices.push(await rollUpOneSlice({ ...args, slice }));
  }

  const refusals = slices.flatMap((s) => s.refusals);
  const notes = slices.flatMap((s) => s.notes);

  if (approved.length === 0) {
    refusals.push(
      "no slice in SLICES.json is `approved`, so there is no human-approved anchor to roll up; " +
        "build, verify and approve a slice first",
    );
  }
  // A roadmap that is not FULLY approved is not a project verdict either: the roll-up
  // answers "does this finished project still hold", and half of it is not that
  // question. Named per slice so the operator sees which ones are outstanding.
  const outstanding = args.plan.slices.filter((s) => s.state !== "approved");
  if (approved.length > 0 && outstanding.length > 0) {
    refusals.push(
      `${outstanding.length} of ${args.plan.slices.length} slice(s) are not approved (` +
        `${outstanding.map((s) => `${s.id}=${s.state}`).join(", ")}), so this roll-up is not a whole-project verdict`,
    );
  }

  // H1/L108. The union of the APPROVED slices' gates is what this project actually
  // grades; a section the contract requires and none of them walks is the 9/9-without-
  // a-goal-object shape.
  const union = new Set<string>();
  for (const slice of approved) for (const gate of slice.acceptance.gates) union.add(gate);
  const coverageRefusals = contractCoverageRefusals({ acceptance: args.acceptance, gates: union });
  refusals.push(...coverageRefusals);

  const regradedGreen = slices.filter((s) => s.regradedGreen).length;
  // M17: anchored requires a slice actually re-graded green AND full contract coverage.
  const anchored = regradedGreen > 0 && coverageRefusals.length === 0 && refusals.length === 0;
  const exit = refusals.length > 0 || regradedGreen === 0 ? 2 : 0;
  return {
    totalSlices: args.plan.slices.length,
    approvedSlices: approved.length,
    regradedGreen,
    slices,
    coverageRefusals,
    refusals,
    notes,
    anchored,
    exit,
    status: exit === 0 ? "pass" : "refused",
  };
}
