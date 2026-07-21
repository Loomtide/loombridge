import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  analyzeVisualArtifactFrames,
  readPng,
  type NamedFrame,
} from "../verification/analyze-frames.js";
import { evaluateVisualArtifacts } from "../verification/gates/index.js";
import type { AcceptanceContract } from "../verification/types.js";

const acceptance = {
  game: "test",
  render: {
    maxArtifactLineFraction: 0.85,
    maxStableRegionChangeFraction: 0.8,
  },
} as AcceptanceContract;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writeTestPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0; // no filter
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function tempFrame(id: string, png: Buffer): Promise<NamedFrame> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-analyze-frames-"));
  const filename = path.join(dir, `${id}.png`);
  await fs.writeFile(filename, png);
  return { id, path: filename, image: await readPng(filename) };
}

test("analyze-frames: jump-only dark horizontal seam is classified and fails the gate", async () => {
  const width = 64;
  const height = 48;
  const baseline = await tempFrame(
    "spawn",
    writeTestPng(width, height, (_x, y) => {
      const shade = 72 + (y % 5);
      return [shade, 48, 96, 255];
    }),
  );
  const jump = await tempFrame(
    "jump",
    writeTestPng(width, height, (_x, y) => {
      if (y === 18 || y === 19) return [0, 0, 0, 255];
      const shade = 72 + (y % 5);
      return [shade, 48, 96, 255];
    }),
  );

  const artifacts = analyzeVisualArtifactFrames(baseline, [jump], {
    stableTopFraction: 0.1,
    stableBottomFraction: 0.7,
  });
  assert.equal(artifacts.frames?.[1]?.longLines?.[0]?.classification, "background_seam");
  assert.equal(artifacts.comparisons?.[0]?.movedLine, true);

  const report = evaluateVisualArtifacts(artifacts, acceptance);
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((check) => check.id === "visual-artifacts.line.jump.0")?.status, "fail");
});

test("analyze-frames: undefined option values do not erase defaults", async () => {
  const width = 64;
  const height = 48;
  const baseline = await tempFrame(
    "spawn",
    writeTestPng(width, height, (_x, y) => {
      const shade = 72 + (y % 5);
      return [shade, 48, 96, 255];
    }),
  );
  const jump = await tempFrame(
    "jump",
    writeTestPng(width, height, (_x, y) => {
      if (y === 18 || y === 19) return [0, 0, 0, 255];
      const shade = 72 + (y % 5);
      return [shade, 48, 96, 255];
    }),
  );

  const artifacts = analyzeVisualArtifactFrames(baseline, [jump], {
    stableTopFraction: 0.1,
    stableBottomFraction: 0.7,
    darkLumaThreshold: undefined,
  });

  assert.equal(artifacts.frames?.[1]?.longLines?.[0]?.classification, "background_seam");
  assert.equal(artifacts.comparisons?.[0]?.movedLine, true);
});

test("analyze-frames: platform-like line below stable region is ignored by default", async () => {
  const width = 64;
  const height = 48;
  const baseline = await tempFrame(
    "spawn",
    writeTestPng(width, height, (_x, y) => [80 + (y % 3), 64, 110, 255]),
  );
  const jump = await tempFrame(
    "jump",
    writeTestPng(width, height, (_x, y) => {
      if (y === 42) return [0, 0, 0, 255];
      return [80 + (y % 3), 64, 110, 255];
    }),
  );

  const artifacts = analyzeVisualArtifactFrames(baseline, [jump], {
    stableTopFraction: 0.1,
    stableBottomFraction: 0.7,
  });
  assert.deepEqual(artifacts.frames?.[1]?.longLines, []);
  assert.equal(artifacts.comparisons?.[0]?.movedLine, false);

  const report = evaluateVisualArtifacts(artifacts, acceptance);
  assert.notEqual(report.verdict, "fail");
});
