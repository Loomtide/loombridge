/**
 * SFX capture-file SHAPES — the declared contract the SFX verification gates consume
 * (SFX dogfood backlog High #7). These are the capture files a FUTURE bridge
 * capture-producer must emit; there is no producer yet, so the gates are opt-in and
 * refuse (blocked / fail) when a declared capture is absent or degenerate rather than
 * ever passing on missing evidence (CLAUDE.md: harness-fault ≠ game-defect; a missing
 * pairing is `blocked`/`incomplete`, never green).
 *
 * This module is the single source of truth for those shapes so the gate code + the
 * bridge-side spec cannot drift. Pure TS, engine-agnostic.
 *
 * Files (staged in the verify `--inputs` directory):
 *   - `sfx-cue-map.json`   — the resolved genre-pack cue map (validated by
 *                            `cue-map.ts`); tells the gates which cues are required.
 *   - `sfx-bindings.json`  — SfxAssetBindingCapture: per-cue clip-asset binding (build
 *                            stage produces it) → `sfx-presence`.
 *   - `sfx-probe.json`     — SfxProbeSnapshot (see `probe-contract.ts`) → `sfx-runtime`.
 *   - `sfx-latency.json`   — SfxLatencyCapture: input-onset↔cue-edge pairs
 *                            → `inputToSfxLatency`.
 *   - `sfx-sequence.json`  — SfxSequenceCapture: ordered cue-fire sequence with variant
 *                            tags → `sfx-fatigue`.
 */

/** One cue's clip-asset binding, as observed at build time. */
export interface SfxCueBinding {
  /** Cue id from the cue map. */
  cueId: string;
  /** Whether a clip asset is actually bound on the SfxPlayer for this cue. */
  bound: boolean;
  /** Project-relative clip path when bound (e.g. `Assets/Audio/fire_01.wav`), else null. */
  clipPath?: string | null;
  /** Optional Unity asset GUID of the bound clip. */
  clipGuid?: string | null;
  /** Optional variant clip paths when the cue has multiple round-robin variants. */
  variantClipPaths?: string[];
}

/** `sfx-bindings.json` — the build-stage asset-binding capture (input → `sfx-presence`). */
export interface SfxAssetBindingCapture {
  /** ISO-8601 time the capture was written. Optional; informational. */
  producedAt?: string;
  /** One entry per cue the build attempted to bind. */
  bindings: SfxCueBinding[];
}

/** One input-onset → cue-edge pairing sample. */
export interface SfxLatencyPair {
  /** Engine time (ms) the driving input fired. */
  inputTimeMs: number;
  /** Engine time (ms) the SfxPlayer cue edge fired (must be >= inputTimeMs). */
  cueTimeMs: number;
}

/**
 * `sfx-latency.json` — pairs an input onset with the resulting cue edge for ONE cue
 * (input → `inputToSfxLatency`). An EMPTY `pairs` array (or a missing file) is
 * `blocked`/`incomplete`, never a pass — you cannot certify latency you did not measure.
 */
export interface SfxLatencyCapture {
  producedAt?: string;
  /** The cue whose input-to-sound latency this capture measures (e.g. `fire`). */
  cueId: string;
  /** Paired input-onset / cue-edge samples. */
  pairs: SfxLatencyPair[];
}

/** One entry in an ordered cue-fire sequence. */
export interface SfxSequenceEvent {
  /** Cue id that fired. */
  cueId: string;
  /**
   * The variant selected for this play (round-robin index or clip tag). REQUIRED for a
   * cue that declares `noImmediateRepeat` — the fatigue gate refuses to certify a
   * no-repeat cue whose fires carry no variant tag (it cannot see a repeat otherwise).
   */
  variant?: number | string;
  /** Optional engine time (ms) of this play. */
  tMs?: number;
}

/**
 * `sfx-sequence.json` — the ordered sequence of cue fires during a stress drive
 * (input → `sfx-fatigue`). Used to detect a no-immediate-repeat violation: the same
 * variant played twice consecutively for a cue that declares `noImmediateRepeat`.
 */
export interface SfxSequenceCapture {
  producedAt?: string;
  /** Cue fires in play order. */
  events: SfxSequenceEvent[];
}
