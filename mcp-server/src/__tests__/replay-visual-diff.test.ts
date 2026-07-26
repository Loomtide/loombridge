import assert from "node:assert/strict";
import test from "node:test";

import { comparePerceptual, type RgbaLike } from "../capabilities/replay/visual-diff.js";

function solid(w: number, h: number, [r, g, b]: [number, number, number]): RgbaLike {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function setPixel(img: RgbaLike, x: number, y: number, [r, g, b]: [number, number, number]): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}

test("comparePerceptual: identical images → match, zero diff", () => {
  const a = solid(64, 64, [120, 80, 40]);
  const b = solid(64, 64, [120, 80, 40]);
  const d = comparePerceptual(a, b);
  assert.equal(d.status, "match");
  assert.equal(d.diffPixels, 0);
  assert.equal(d.diffFraction, 0);
  assert.equal(d.dimensionsMatch, true);
});

test("comparePerceptual: a uniform +1 channel nudge stays below the perceptual threshold → match", () => {
  const a = solid(64, 64, [100, 100, 100]);
  const b = solid(64, 64, [101, 100, 100]);
  const d = comparePerceptual(a, b);
  assert.equal(d.status, "match");
  assert.equal(d.diffPixels, 0, "sub-threshold colour delta is not counted (not hash equality)");
});

test("comparePerceptual: one changed pixel in 10k → below drift fraction → match", () => {
  const a = solid(100, 100, [0, 0, 0]);
  const b = solid(100, 100, [0, 0, 0]);
  setPixel(b, 5, 5, [255, 255, 255]);
  const d = comparePerceptual(a, b);
  assert.equal(d.diffPixels, 1);
  assert.equal(d.status, "match", "0.01% < 0.5% default tolerance");
});

test("comparePerceptual: half the image changed → drift", () => {
  const a = solid(100, 100, [0, 0, 0]);
  const b = solid(100, 100, [0, 0, 0]);
  for (let y = 0; y < 50; y += 1) for (let x = 0; x < 100; x += 1) setPixel(b, x, y, [255, 255, 255]);
  const d = comparePerceptual(a, b);
  assert.equal(d.status, "drift");
  assert.equal(d.diffPixels, 5000);
  assert.equal(d.diffFraction, 0.5);
});

test("comparePerceptual: a size mismatch is unambiguous drift", () => {
  const a = solid(100, 100, [10, 10, 10]);
  const b = solid(100, 101, [10, 10, 10]);
  const d = comparePerceptual(a, b);
  assert.equal(d.status, "drift");
  assert.equal(d.dimensionsMatch, false);
  assert.equal(d.diffFraction, 1);
});

test("comparePerceptual: a tight driftFraction makes a single pixel drift", () => {
  const a = solid(100, 100, [0, 0, 0]);
  const b = solid(100, 100, [0, 0, 0]);
  setPixel(b, 1, 1, [255, 255, 255]);
  const d = comparePerceptual(a, b, { driftFraction: 0 });
  assert.equal(d.status, "drift");
});
