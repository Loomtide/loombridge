import fs from "node:fs/promises";
import type { AudioMetadata } from "./types.js";

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.subarray(offset, offset + length).toString("ascii");
}

export async function readWavMetadata(filePath: string): Promise<AudioMetadata> {
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 44 || readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
    throw new Error("File is not a RIFF/WAVE audio file.");
  }

  let offset = 12;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;
  let dataBytes: number | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = readAscii(buffer, offset, 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16 || chunkStart + chunkSize > buffer.length) {
        throw new Error("Invalid WAV fmt chunk.");
      }
      const audioFormat = buffer.readUInt16LE(chunkStart);
      if (audioFormat !== 1) {
        throw new Error(`Unsupported WAV encoding ${audioFormat}; only PCM is supported.`);
      }
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitDepth = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channels || !bitDepth || dataBytes === undefined) {
    throw new Error("WAV metadata is missing fmt or data chunks.");
  }

  const bytesPerSampleFrame = channels * (bitDepth / 8);
  if (bytesPerSampleFrame <= 0) {
    throw new Error("WAV metadata has invalid channel or bit depth values.");
  }

  return {
    format: "wav",
    sampleRate,
    channels,
    bitDepth,
    durationMs: Math.round((dataBytes / bytesPerSampleFrame / sampleRate) * 1000),
  };
}
