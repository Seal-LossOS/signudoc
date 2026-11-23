import assert from "node:assert/strict";
import { test } from "node:test";

import { containRect, inkBounds } from "./signature-ink.ts";

function image(width: number, height: number, inked: [number, number][]) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (const [x, y] of inked) {
    pixels[(y * width + x) * 4 + 3] = 255;
  }

  return pixels;
}

test("a blank pad has no ink", () => {
  assert.equal(inkBounds(image(10, 6, []), 10, 6), null);
});

test("the box holds exactly the inked pixels", () => {
  assert.deepEqual(
    inkBounds(
      image(10, 6, [
        [3, 2],
        [6, 4],
      ]),
      10,
      6,
    ),
    { height: 3, width: 4, x: 3, y: 2 },
  );
});

test("padding grows the box but never past the image", () => {
  assert.deepEqual(inkBounds(image(10, 6, [[1, 4]]), 10, 6, 2), {
    height: 4,
    width: 4,
    x: 0,
    y: 2,
  });
});

test("a faint antialiased edge still counts as ink", () => {
  const pixels = image(4, 4, []);

  pixels[(2 * 4 + 2) * 4 + 3] = 1;

  assert.deepEqual(inkBounds(pixels, 4, 4), {
    height: 1,
    width: 1,
    x: 2,
    y: 2,
  });
});

test("a wide drawing fits a tall box by width, centred", () => {
  assert.deepEqual(containRect(200, 50, 100, 100), {
    height: 25,
    width: 100,
    x: 0,
    y: 37.5,
  });
});
