import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeAudioFile,
  analyzeOggBuffer,
  analyzeWavBuffer,
  type WavQcMetrics,
} from "../../../../capabilities/assets/audio-qc.js";

// ─────────────────────────────────────────────
// WAV fixture builders (in-test, deterministic)
// ─────────────────────────────────────────────

type WavEncoding = "pcm" | "float";

interface WavSpec {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  encoding?: WavEncoding;
  /** Interleaved normalized [-1, 1] samples. length must be a multiple of channels. */
  samples: number[];
  /** Override the fmt audioFormat tag (to synthesize an unsupported encoding). */
  audioFormatOverride?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function writeSample(buf: Buffer, offset: number, x: number, bitDepth: number, encoding: WavEncoding): void {
  if (encoding === "float") {
    buf.writeFloatLE(x, offset);
    return;
  }
  switch (bitDepth) {
    case 8:
      buf.writeUInt8(clamp(Math.round(x * 128) + 128, 0, 255), offset);
      break;
    case 16:
      buf.writeInt16LE(clamp(Math.round(x * 32768), -32768, 32767), offset);
      break;
    case 24: {
      const v = clamp(Math.round(x * 8388608), -8388608, 8388607) & 0xffffff;
      buf.writeUInt8(v & 0xff, offset);
      buf.writeUInt8((v >> 8) & 0xff, offset + 1);
      buf.writeUInt8((v >> 16) & 0xff, offset + 2);
      break;
    }
    case 32:
      buf.writeInt32LE(clamp(Math.round(x * 2147483648), -2147483648, 2147483647), offset);
      break;
    default:
      throw new Error(`unsupported bit depth ${bitDepth}`);
  }
}

function buildWav(spec: WavSpec): Buffer {
  const encoding = spec.encoding ?? "pcm";
  const bytesPerSample = spec.bitDepth / 8;
  const dataBytes = spec.samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(spec.audioFormatOverride ?? (encoding === "float" ? 3 : 1), 20);
  buf.writeUInt16LE(spec.channels, 22);
  buf.writeUInt32LE(spec.sampleRate, 24);
  buf.writeUInt32LE(spec.sampleRate * spec.channels * bytesPerSample, 28);
  buf.writeUInt16LE(spec.channels * bytesPerSample, 32);
  buf.writeUInt16LE(spec.bitDepth, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const sample of spec.samples) {
    writeSample(buf, offset, sample, spec.bitDepth, encoding);
    offset += bytesPerSample;
  }
  return buf;
}

function wav(buffer: Buffer): WavQcMetrics {
  const result = analyzeWavBuffer(buffer);
  assert.equal(result.supported, true, "expected a supported WAV result");
  return result as WavQcMetrics;
}

// ─────────────────────────────────────────────
// WAV tests
// ─────────────────────────────────────────────

test("audio-qc WAV: constant-level mono 16-bit derives duration/peak/rms exactly", () => {
  // 100 frames @ 1000 Hz = 100 ms; every sample = 0.5 → int 16384, decodes to 0.5.
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples: Array(100).fill(0.5) }));

  assert.equal(m.encoding, "pcm");
  assert.equal(m.sampleRate, 1000);
  assert.equal(m.channels, 1);
  assert.equal(m.bitDepth, 16);
  assert.equal(m.sampleFrames, 100);
  assert.equal(m.durationMs, 100);
  assert.equal(m.peak, 0.5);
  assert.equal(m.rms, 0.5);
  assert.equal(m.peakWindowRms, 0.5);
  // Non-silent from frame 0, so no silence and instant attack.
  assert.equal(m.leadingSilenceMs, 0);
  assert.equal(m.tailLengthMs, 0);
  assert.equal(m.attackMs, 0);
  assert.equal(m.clipping.detected, false);
  assert.equal(m.clipping.clippedSamples, 0);
});

test("audio-qc WAV: leading + trailing silence measured in ms", () => {
  // 20 frames silence, 10 frames @ 0.8, 30 frames silence = 60 frames @ 1000 Hz.
  const samples = [
    ...Array(20).fill(0),
    ...Array(10).fill(0.8),
    ...Array(30).fill(0),
  ];
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples }));

  assert.equal(m.durationMs, 60);
  assert.equal(m.peak, 0.8);
  assert.equal(m.leadingSilenceMs, 20); // first non-silent frame index 20
  assert.equal(m.tailLengthMs, 30); // last non-silent frame index 29 → 60-1-29 = 30
});

test("audio-qc WAV: consecutive full-scale samples flag clipping", () => {
  // 3 @ 0.5, then 5 @ full-scale (1.0 clamps to 32767 ≈ 0.99997 ≥ 0.999), then 2 @ 0.5.
  const samples = [...Array(3).fill(0.5), ...Array(5).fill(1.0), ...Array(2).fill(0.5)];
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples }));

  assert.equal(m.clipping.detected, true);
  assert.equal(m.clipping.longestRun, 5);
  assert.equal(m.clipping.clippedSamples, 5);
  assert.equal(m.clipping.runThreshold, 3);
});

test("audio-qc WAV: a short full-scale blip below the run threshold is NOT clipping", () => {
  // Two isolated full-scale samples separated by a quiet one → longest run 1.
  const samples = [1.0, 0.2, 1.0, 0.2, 0.2];
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples }));

  assert.equal(m.clipping.detected, false);
  assert.equal(m.clipping.longestRun, 1);
  assert.equal(m.clipping.clippedSamples, 2);
});

test("audio-qc WAV: attack time = ms from onset to 90% of peak", () => {
  // Ramp frame i (0..99) value = (i+1)/100, peak ≈ 1.0. 90% threshold ≈ 0.9 → first
  // frame reaching it is i=89 (value 0.90). @1000 Hz → 89 ms. Onset is frame 0 (0.01).
  const samples = Array.from({ length: 100 }, (_, i) => (i + 1) / 100);
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples }));

  assert.equal(m.leadingSilenceMs, 0);
  assert.equal(m.attackMs, 89);
});

test("audio-qc WAV: DC-offset signal has peak == rms and no silence", () => {
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples: Array(50).fill(-0.25) }));

  assert.equal(m.peak, 0.25);
  assert.equal(m.rms, 0.25);
  assert.equal(m.leadingSilenceMs, 0);
  assert.equal(m.tailLengthMs, 0);
});

test("audio-qc WAV: fully-silent clip reports full-length leading + tail silence", () => {
  const m = wav(buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples: Array(40).fill(0) }));

  assert.equal(m.peak, 0);
  assert.equal(m.rms, 0);
  assert.equal(m.durationMs, 40);
  assert.equal(m.leadingSilenceMs, 40);
  assert.equal(m.tailLengthMs, 40);
  assert.equal(m.attackMs, 0);
});

test("audio-qc WAV: stereo peak is the max across channels", () => {
  // Interleaved L/R: L quiet (0.1), R loud (0.6).
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(0.1, 0.6);
  }
  const m = wav(buildWav({ sampleRate: 1000, channels: 2, bitDepth: 16, samples }));

  assert.equal(m.channels, 2);
  assert.equal(m.sampleFrames, 30);
  assert.equal(m.peak, 0.6);
});

test("audio-qc WAV: 24-bit PCM decodes", () => {
  const m = wav(buildWav({ sampleRate: 8000, channels: 1, bitDepth: 24, samples: Array(80).fill(0.5) }));
  assert.equal(m.bitDepth, 24);
  assert.equal(m.encoding, "pcm");
  assert.equal(m.peak, 0.5);
});

test("audio-qc WAV: IEEE 32-bit float is supported", () => {
  const m = wav(buildWav({
    sampleRate: 1000,
    channels: 1,
    bitDepth: 32,
    encoding: "float",
    samples: Array(40).fill(0.5),
  }));
  assert.equal(m.encoding, "float");
  assert.equal(m.peak, 0.5);
  assert.equal(m.rms, 0.5);
});

test("audio-qc WAV: an unsupported encoding returns an honest unsupported result", () => {
  // audioFormat 6 = A-law: not decoded. No fabricated metrics.
  const result = analyzeWavBuffer(buildWav({
    sampleRate: 8000,
    channels: 1,
    bitDepth: 8,
    samples: Array(10).fill(0.5),
    audioFormatOverride: 6,
  }));
  assert.equal(result.supported, false);
  assert.equal(result.format, "wav");
  assert.match((result as { reason: string }).reason, /Unsupported WAV encoding/);
});

test("audio-qc WAV: a non-RIFF buffer is unsupported, not a crash", () => {
  const result = analyzeWavBuffer(Buffer.from("this is not audio at all!!"));
  assert.equal(result.supported, false);
  assert.match((result as { reason: string }).reason, /Not a RIFF/);
});

// ─────────────────────────────────────────────
// OGG tests
// ─────────────────────────────────────────────

function buildOggPage(
  granule: bigint,
  serial: number,
  pageSeq: number,
  body: Buffer,
): Buffer {
  // Split body into ≤255-byte lacing segments (fixtures stay tiny, so ≤255).
  assert.ok(body.length <= 255, "test fixture body must fit one lacing segment");
  const segmentCount = body.length === 0 ? 0 : 1;
  const page = Buffer.alloc(27 + segmentCount + body.length);
  page.write("OggS", 0, "ascii");
  page.writeUInt8(0, 4); // version
  page.writeUInt8(0, 5); // header type
  page.writeBigInt64LE(granule, 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(pageSeq, 18);
  page.writeUInt32LE(0, 22); // CRC (ignored by the parser)
  page.writeUInt8(segmentCount, 26);
  if (segmentCount === 1) page.writeUInt8(body.length, 27);
  body.copy(page, 27 + segmentCount);
  return page;
}

function buildOggVorbis(channels: number, sampleRate: number, finalGranule: bigint): Buffer {
  // Vorbis identification header: 0x01 "vorbis" + version(4) + channels(1) + rate(4) + …
  const idHeader = Buffer.alloc(30);
  idHeader.writeUInt8(0x01, 0);
  idHeader.write("vorbis", 1, "ascii");
  idHeader.writeUInt32LE(0, 7); // vorbis version
  idHeader.writeUInt8(channels, 11);
  idHeader.writeUInt32LE(sampleRate, 12);
  // bitrate/blocksize/framing fields left zero — the parser only reads ch + rate.

  const page0 = buildOggPage(0n, 1, 0, idHeader);
  const page1 = buildOggPage(finalGranule, 1, 1, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
  return Buffer.concat([page0, page1]);
}

test("audio-qc OGG: reads channels/sample-rate from the id header and duration from the last granule", () => {
  // 44100 samples @ 44100 Hz → exactly 1000 ms.
  const result = analyzeOggBuffer(buildOggVorbis(2, 44100, 44100n));
  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.format, "ogg");
  assert.equal(result.channels, 2);
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.durationMs, 1000);
  assert.equal(result.truncated, false);
});

test("audio-qc OGG: mono half-second stream", () => {
  const result = analyzeOggBuffer(buildOggVorbis(1, 48000, 24000n));
  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.channels, 1);
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.durationMs, 500);
  assert.equal(result.truncated, false);
});

test("audio-qc OGG: chained/multiplexed Ogg (two serialnos) is refused, never a wrong duration", () => {
  // Vorbis stream on serial 1 + a second logical stream (serial 2) whose page
  // carries a LARGER granule. Using the last page's granule blindly would report
  // a wrong duration — the honest answer is unsupported.
  const idHeader = Buffer.alloc(30);
  idHeader.writeUInt8(0x01, 0);
  idHeader.write("vorbis", 1, "ascii");
  idHeader.writeUInt8(1, 11);
  idHeader.writeUInt32LE(44100, 12);

  const page0 = buildOggPage(0n, 1, 0, idHeader); // Vorbis BOS, serial 1
  const alien = buildOggPage(999999n, 2, 0, Buffer.from("second-stream-bos-payload")); // serial 2
  const page1 = buildOggPage(44100n, 1, 1, Buffer.from([0xaa, 0xbb]));
  const result = analyzeOggBuffer(Buffer.concat([page0, alien, page1]));

  assert.equal(result.supported, false);
  assert.equal(result.format, "ogg");
  assert.match((result as { reason: string }).reason, /[Cc]hained or multiplexed/);
});

test("audio-qc OGG: an incomplete final page sets truncated instead of silently under-reporting", () => {
  const whole = buildOggVorbis(1, 44100, 44100n);
  // Chop mid-way through the final page's body: its header + segment table parse
  // but the body runs past the buffer end.
  const chopped = whole.subarray(0, whole.length - 2);
  const result = analyzeOggBuffer(chopped);

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.truncated, true);
  // The final page's granule was never accepted, so duration comes from the
  // preceding page (granule 0 → 0 ms) — visible as truncated, not fabricated.
  assert.equal(result.durationMs, 0);
});

test("audio-qc OGG: a non-Ogg buffer is unsupported, not a crash", () => {
  const result = analyzeOggBuffer(Buffer.from("RIFF....WAVE not ogg"));
  assert.equal(result.supported, false);
  assert.match((result as { reason: string }).reason, /Not an Ogg stream/);
});

test("audio-qc OGG: an Ogg stream that is not Vorbis is unsupported", () => {
  // Valid Ogg page framing but the body is not a Vorbis id header.
  const page = buildOggPage(0n, 1, 0, Buffer.from("NOTVORBISHEADERPAYLOAD1234567890"));
  const result = analyzeOggBuffer(page);
  assert.equal(result.supported, false);
  assert.match((result as { reason: string }).reason, /not Vorbis/);
});

// ─────────────────────────────────────────────
// File dispatch
// ─────────────────────────────────────────────

test("audio-qc analyzeAudioFile dispatches by extension", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-qc-"));
  try {
    const wavPath = path.join(dir, "beep.wav");
    await fs.writeFile(wavPath, buildWav({ sampleRate: 1000, channels: 1, bitDepth: 16, samples: Array(50).fill(0.5) }));
    const wavResult = await analyzeAudioFile(wavPath);
    assert.equal(wavResult.format, "wav");
    assert.equal(wavResult.supported, true);

    const oggPath = path.join(dir, "beep.ogg");
    await fs.writeFile(oggPath, buildOggVorbis(1, 22050, 22050n));
    const oggResult = await analyzeAudioFile(oggPath);
    assert.equal(oggResult.format, "ogg");
    assert.equal(oggResult.supported, true);

    const otherPath = path.join(dir, "notes.txt");
    await fs.writeFile(otherPath, "hello");
    const otherResult = await analyzeAudioFile(otherPath);
    assert.equal(otherResult.supported, false);
    assert.equal(otherResult.format, "unknown");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
