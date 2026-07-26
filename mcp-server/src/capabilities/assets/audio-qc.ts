#!/usr/bin/env node
/**
 * Deterministic technical audio QC for generated / curated SFX takes.
 *
 * This is the machine-checkable half of the Generated SFX Workflow
 * (Docs/Assets/GeneratedSfxWorkflow.md): it rejects technical DEFECTS — clipping,
 * wrong duration, excessive silence, wrong format — but it never approves taste,
 * semantic fit, or mix beauty (those stay human/advisory per the deterministic
 * boundary). Every metric is derived by hand from the decoded PCM; nothing is
 * fabricated. A codec/encoding this module cannot honestly decode returns an
 * explicit `unsupported` result with a reason, never invented numbers.
 *
 * No third-party dependencies: WAV RIFF/PCM (+ IEEE float) is parsed directly,
 * and OGG duration/channels/sample-rate come from the Vorbis identification
 * header plus the last Ogg page's granule position.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ─────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────

export interface AudioQcClipping {
  /** True when a run of >= `runThreshold` consecutive full-scale samples exists. */
  detected: boolean;
  /** Count of samples at or beyond the full-scale threshold. */
  clippedSamples: number;
  /** Longest run of consecutive full-scale samples. */
  longestRun: number;
  /** Consecutive-sample run length required to flag clipping. */
  runThreshold: number;
  /** Normalized amplitude (0..1) at/above which a sample counts as full-scale. */
  fullScaleThreshold: number;
}

export interface WavQcMetrics {
  format: "wav";
  supported: true;
  /** PCM integer or IEEE 32-bit float — the two encodings decoded honestly. */
  encoding: "pcm" | "float";
  sampleRate: number;
  channels: number;
  /** Bits per stored sample (8/16/24/32). */
  bitDepth: number;
  durationMs: number;
  /** Number of sample frames (samples per channel). */
  sampleFrames: number;
  /**
   * Peak normalized amplitude (max abs sample across all channels). 0..1 for
   * integer PCM; float32 samples may legitimately exceed 1.0 and are reported
   * unclamped.
   */
  peak: number;
  /**
   * Overall RMS across every sample. 0..1 for integer PCM; may exceed 1.0 for
   * out-of-range float32 material (reported unclamped).
   */
  rms: number;
  /** Loudest windowed RMS (same range caveat as rms) — a short-window loudness proxy. */
  peakWindowRms: number;
  /** Window length (ms) used for the loudness proxy. */
  loudnessWindowMs: number;
  clipping: AudioQcClipping;
  /** Milliseconds of leading silence before the first non-silent frame. */
  leadingSilenceMs: number;
  /** Milliseconds of trailing silence after the last non-silent frame. */
  tailLengthMs: number;
  /**
   * Milliseconds from the onset (first non-silent frame) to the first frame
   * that reaches 90% of the peak amplitude. 0 when the file is silent.
   */
  attackMs: number;
  /** Normalized amplitude (0..1) below which a frame counts as silent. */
  silenceThreshold: number;
}

export interface OggQcMetrics {
  format: "ogg";
  supported: true;
  sampleRate: number;
  channels: number;
  /**
   * Duration from the Vorbis stream's last resolvable granule position; null
   * when no page carries a resolvable granule (an honest gap rather than a
   * fabricated 0).
   */
  durationMs: number | null;
  /**
   * True when the final page is incomplete (segment table or body runs past the
   * end of the buffer) — durationMs may then under-report the true length.
   */
  truncated: boolean;
}

export interface UnsupportedQcResult {
  format: "wav" | "ogg" | "unknown";
  supported: false;
  reason: string;
}

export type AudioQcResult = WavQcMetrics | OggQcMetrics | UnsupportedQcResult;

export interface AudioQcOptions {
  /** Amplitude below which a frame is "silent" (default 0.01 ≈ -40 dBFS). */
  silenceThreshold?: number;
  /** Amplitude at/above which a sample is "full scale" (default 0.999). */
  fullScaleThreshold?: number;
  /** Consecutive full-scale samples that constitute clipping (default 3). */
  clipRunThreshold?: number;
  /** Window length in ms for the loudness proxy (default 50). */
  loudnessWindowMs?: number;
}

const DEFAULTS: Required<AudioQcOptions> = {
  silenceThreshold: 0.01,
  fullScaleThreshold: 0.999,
  clipRunThreshold: 3,
  loudnessWindowMs: 50,
};

// ─────────────────────────────────────────────
// WAV
// ─────────────────────────────────────────────

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.subarray(offset, offset + length).toString("ascii");
}

interface WavFmt {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitDepth: number;
}

/**
 * Analyze a WAV buffer into full technical QC metrics. PCM (8/16/24/32-bit) and
 * IEEE 32-bit float are decoded; any other encoding returns `unsupported` with a
 * reason — no fabricated metrics.
 */
export function analyzeWavBuffer(buffer: Buffer, options: AudioQcOptions = {}): WavQcMetrics | UnsupportedQcResult {
  const opts = { ...DEFAULTS, ...options };

  if (buffer.length < 12 || readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
    return { format: "unknown", supported: false, reason: "Not a RIFF/WAVE file." };
  }

  let fmt: WavFmt | undefined;
  let dataOffset: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = readAscii(buffer, offset, 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16 || chunkStart + 16 > buffer.length) {
        return { format: "wav", supported: false, reason: "Invalid or truncated WAV fmt chunk." };
      }
      let audioFormat = buffer.readUInt16LE(chunkStart);
      const channels = buffer.readUInt16LE(chunkStart + 2);
      const sampleRate = buffer.readUInt32LE(chunkStart + 4);
      const bitDepth = buffer.readUInt16LE(chunkStart + 14);
      // WAVE_FORMAT_EXTENSIBLE stores the real format in the SubFormat GUID's
      // first two bytes (see the extension block).
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && chunkSize >= 26 && chunkStart + 26 <= buffer.length) {
        audioFormat = buffer.readUInt16LE(chunkStart + 24);
      }
      fmt = { audioFormat, channels, sampleRate, bitDepth };
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      // A truncated/streamed file can under-report the data size; clamp to what
      // is actually present so we never read past the buffer.
      dataBytes = Math.min(chunkSize, buffer.length - chunkStart);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) {
    return { format: "wav", supported: false, reason: "WAV is missing its fmt chunk." };
  }
  if (dataOffset === undefined || dataBytes === undefined) {
    return { format: "wav", supported: false, reason: "WAV is missing its data chunk." };
  }
  if (fmt.channels <= 0 || fmt.sampleRate <= 0 || fmt.bitDepth <= 0) {
    return { format: "wav", supported: false, reason: "WAV fmt chunk has invalid channel/rate/bit-depth values." };
  }

  let encoding: "pcm" | "float";
  if (fmt.audioFormat === WAVE_FORMAT_PCM) {
    if (![8, 16, 24, 32].includes(fmt.bitDepth)) {
      return {
        format: "wav",
        supported: false,
        reason: `Unsupported PCM bit depth ${fmt.bitDepth}; only 8/16/24/32-bit integer PCM is decoded.`,
      };
    }
    encoding = "pcm";
  } else if (fmt.audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (fmt.bitDepth !== 32) {
      return {
        format: "wav",
        supported: false,
        reason: `Unsupported IEEE float bit depth ${fmt.bitDepth}; only 32-bit float is decoded.`,
      };
    }
    encoding = "float";
  } else {
    return {
      format: "wav",
      supported: false,
      reason: `Unsupported WAV encoding 0x${fmt.audioFormat.toString(16)}; only PCM and IEEE float are decoded.`,
    };
  }

  const bytesPerSample = fmt.bitDepth / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const sampleFrames = Math.floor(dataBytes / frameBytes);
  const durationMs = Math.round((sampleFrames / fmt.sampleRate) * 1000);

  const decode = makeSampleDecoder(encoding, fmt.bitDepth);

  // Single pass over the interleaved samples derives every amplitude metric.
  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;

  // Clipping: track consecutive full-scale samples.
  let clippedSamples = 0;
  let longestRun = 0;
  let currentRun = 0;

  // Frame-level onset/tail (a frame is silent when its loudest channel is silent).
  let firstNonSilentFrame = -1;
  let lastNonSilentFrame = -1;

  // Loudness proxy: non-overlapping windowed RMS, keep the max.
  const windowFrames = Math.max(1, Math.round((opts.loudnessWindowMs / 1000) * fmt.sampleRate));
  let windowSumSquares = 0;
  let windowSampleCount = 0;
  let peakWindowMeanSquare = 0;

  // Attack: first frame reaching 90% of peak — needs peak first, so record the
  // per-frame amplitude and resolve attack in a light second scan below.
  const frameAmp = new Float64Array(sampleFrames);

  for (let frame = 0; frame < sampleFrames; frame++) {
    let frameMaxAbs = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const sampleIndex = dataOffset + (frame * fmt.channels + ch) * bytesPerSample;
      const value = decode(buffer, sampleIndex);
      const abs = Math.abs(value);

      if (abs > peak) peak = abs;
      if (abs > frameMaxAbs) frameMaxAbs = abs;
      sumSquares += value * value;
      sampleCount++;

      if (abs >= opts.fullScaleThreshold) {
        clippedSamples++;
        currentRun++;
        if (currentRun > longestRun) longestRun = currentRun;
      } else {
        currentRun = 0;
      }

      windowSumSquares += value * value;
      windowSampleCount++;
    }

    frameAmp[frame] = frameMaxAbs;
    if (frameMaxAbs >= opts.silenceThreshold) {
      if (firstNonSilentFrame === -1) firstNonSilentFrame = frame;
      lastNonSilentFrame = frame;
    }

    if ((frame + 1) % windowFrames === 0 || frame === sampleFrames - 1) {
      if (windowSampleCount > 0) {
        const meanSquare = windowSumSquares / windowSampleCount;
        if (meanSquare > peakWindowMeanSquare) peakWindowMeanSquare = meanSquare;
      }
      windowSumSquares = 0;
      windowSampleCount = 0;
    }
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const peakWindowRms = Math.sqrt(peakWindowMeanSquare);

  let leadingSilenceMs: number;
  let tailLengthMs: number;
  let attackMs: number;

  if (firstNonSilentFrame === -1) {
    // Wholly silent (or empty): every frame is below threshold.
    leadingSilenceMs = Math.round((sampleFrames / fmt.sampleRate) * 1000);
    tailLengthMs = leadingSilenceMs;
    attackMs = 0;
  } else {
    leadingSilenceMs = Math.round((firstNonSilentFrame / fmt.sampleRate) * 1000);
    tailLengthMs = Math.round(((sampleFrames - 1 - lastNonSilentFrame) / fmt.sampleRate) * 1000);

    const attackTarget = 0.9 * peak;
    let attackFrame = firstNonSilentFrame;
    for (let frame = firstNonSilentFrame; frame < sampleFrames; frame++) {
      if (frameAmp[frame] >= attackTarget) {
        attackFrame = frame;
        break;
      }
    }
    attackMs = Math.round(((attackFrame - firstNonSilentFrame) / fmt.sampleRate) * 1000);
  }

  return {
    format: "wav",
    supported: true,
    encoding,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    durationMs,
    sampleFrames,
    peak: round4(peak),
    rms: round4(rms),
    peakWindowRms: round4(peakWindowRms),
    loudnessWindowMs: opts.loudnessWindowMs,
    clipping: {
      detected: longestRun >= opts.clipRunThreshold,
      clippedSamples,
      longestRun,
      runThreshold: opts.clipRunThreshold,
      fullScaleThreshold: opts.fullScaleThreshold,
    },
    leadingSilenceMs,
    tailLengthMs,
    attackMs,
    silenceThreshold: opts.silenceThreshold,
  };
}

type SampleDecoder = (buffer: Buffer, offset: number) => number;

// Returns a decoder that maps a stored sample to a normalized [-1, 1] float.
function makeSampleDecoder(encoding: "pcm" | "float", bitDepth: number): SampleDecoder {
  if (encoding === "float") {
    return (buffer, offset) => buffer.readFloatLE(offset);
  }
  switch (bitDepth) {
    case 8:
      // 8-bit PCM WAV is UNSIGNED with a midpoint of 128.
      return (buffer, offset) => (buffer.readUInt8(offset) - 128) / 128;
    case 16:
      return (buffer, offset) => buffer.readInt16LE(offset) / 32768;
    case 24:
      return (buffer, offset) => {
        const b0 = buffer[offset];
        const b1 = buffer[offset + 1];
        const b2 = buffer[offset + 2];
        let value = b0 | (b1 << 8) | (b2 << 16);
        if (value & 0x800000) value -= 0x1000000; // sign-extend 24-bit
        return value / 8388608;
      };
    case 32:
      return (buffer, offset) => buffer.readInt32LE(offset) / 2147483648;
    default:
      throw new Error(`Unsupported PCM bit depth ${bitDepth}`);
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ─────────────────────────────────────────────
// OGG (Vorbis identification header + last-page granule)
// ─────────────────────────────────────────────

/**
 * Analyze an OGG buffer for duration/channels/sample-rate. Walks the Ogg page
 * structure to read the Vorbis identification header (channels + sample rate)
 * and the Vorbis stream's last resolvable granule position (total PCM samples
 * → duration). Returns `unsupported` with a reason when the stream is not
 * Ogg/Vorbis rather than guessing. Chained or multiplexed files (more than one
 * bitstream serial number) are refused as `unsupported` — a last-page granule
 * from a different logical stream would silently yield a wrong duration, and
 * this module never fabricates. An incomplete final page sets `truncated` so an
 * under-reported duration is visible instead of silent.
 */
export function analyzeOggBuffer(buffer: Buffer): OggQcMetrics | UnsupportedQcResult {
  if (buffer.length < 27 || readAscii(buffer, 0, 4) !== "OggS") {
    return { format: "ogg", supported: false, reason: "Not an Ogg stream (missing 'OggS' capture pattern)." };
  }

  let sampleRate: number | undefined;
  let channels: number | undefined;
  let vorbisSerial: number | undefined;
  let lastGranule: bigint | undefined;
  let truncated = false;
  const serials = new Set<number>();
  let offset = 0;

  while (offset + 27 <= buffer.length) {
    if (readAscii(buffer, offset, 4) !== "OggS") {
      // A malformed / non-page-aligned region: stop rather than scan for a
      // possibly-spurious 'OggS' inside packet payload.
      break;
    }

    const granule = buffer.readBigInt64LE(offset + 6);
    const serial = buffer.readUInt32LE(offset + 14);
    serials.add(serial);

    const segmentCount = buffer.readUInt8(offset + 26);
    const segmentTableStart = offset + 27;
    if (segmentTableStart + segmentCount > buffer.length) {
      truncated = true;
      break;
    }

    let bodyBytes = 0;
    for (let i = 0; i < segmentCount; i++) {
      bodyBytes += buffer.readUInt8(segmentTableStart + i);
    }
    const bodyStart = segmentTableStart + segmentCount;
    if (bodyStart + bodyBytes > buffer.length) {
      truncated = true;
      break;
    }

    // The Vorbis identification header is the first packet: 0x01 "vorbis".
    // Bind the Vorbis stream to this page's serial so granules from any other
    // logical stream are never used for duration.
    if (sampleRate === undefined && bodyBytes >= 30 && buffer.readUInt8(bodyStart) === 0x01
      && readAscii(buffer, bodyStart + 1, 6) === "vorbis") {
      channels = buffer.readUInt8(bodyStart + 11);
      sampleRate = buffer.readUInt32LE(bodyStart + 12);
      vorbisSerial = serial;
    }

    // Granule -1 (0xFFFFFFFFFFFFFFFF) marks a page with no completed packet;
    // only pages belonging to the Vorbis stream may advance the duration.
    if (granule >= 0n && vorbisSerial !== undefined && serial === vorbisSerial) {
      lastGranule = granule;
    }

    offset = bodyStart + bodyBytes;
  }

  if (sampleRate === undefined || channels === undefined) {
    return { format: "ogg", supported: false, reason: "Ogg stream is not Vorbis or its identification header was not found." };
  }

  if (serials.size > 1) {
    return {
      format: "ogg",
      supported: false,
      reason: `Chained or multiplexed Ogg (${serials.size} bitstream serial numbers) — duration would be ambiguous.`,
    };
  }

  const durationMs = lastGranule !== undefined && sampleRate > 0
    ? Math.round((Number(lastGranule) / sampleRate) * 1000)
    : null;

  return {
    format: "ogg",
    supported: true,
    sampleRate,
    channels,
    durationMs,
    truncated,
  };
}

// ─────────────────────────────────────────────
// File dispatch
// ─────────────────────────────────────────────

/**
 * Analyze an audio file by extension (falling back to the magic bytes). Unknown
 * containers return an `unsupported` result rather than throwing.
 */
export async function analyzeAudioFile(filePath: string, options: AudioQcOptions = {}): Promise<AudioQcResult> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".wav" || (buffer.length >= 12 && readAscii(buffer, 0, 4) === "RIFF")) {
    return analyzeWavBuffer(buffer, options);
  }
  if (ext === ".ogg" || (buffer.length >= 4 && readAscii(buffer, 0, 4) === "OggS")) {
    return analyzeOggBuffer(buffer);
  }

  return {
    format: "unknown",
    supported: false,
    reason: `Unsupported audio container for '${path.basename(filePath)}' (only .wav and .ogg are analyzed).`,
  };
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

interface CliArgs {
  filePath?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--file":
        args.filePath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      default:
        // Bare positional path for convenience.
        if (!arg.startsWith("-") && !args.filePath) {
          args.filePath = path.resolve(process.cwd(), arg);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }
  return args;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help || !args.filePath) {
    console.log("Usage: node dist/capabilities/assets/audio-qc.js --file <audio.wav|audio.ogg>");
    return args.help ? 0 : 1;
  }

  const result = await analyzeAudioFile(args.filePath);
  console.log(JSON.stringify(result, null, 2));
  // A technically-unsupported file is not a crash; the caller inspects `supported`.
  return 0;
}

const isMainModule = process.argv[1]?.endsWith("audio-qc.js") || process.argv[1]?.endsWith("audio-qc.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[audio-qc] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
