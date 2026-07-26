import fs from "node:fs/promises";
import type { ImageMetadata } from "./types.js";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegStartOfFrameMarkers = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function readPngMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) {
    return null;
  }

  return {
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) {
      offset += 1;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    if (jpegStartOfFrameMarkers.has(marker)) {
      return {
        format: "jpg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

export async function readImageMetadata(filePath: string): Promise<ImageMetadata> {
  const buffer = await fs.readFile(filePath);
  const metadata = readPngMetadata(buffer) ?? readJpegMetadata(buffer);
  if (!metadata) {
    throw new Error(`Unsupported image format or unreadable dimensions: ${filePath}`);
  }

  return metadata;
}
