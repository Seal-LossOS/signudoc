// A drawn signature is saved cropped to its ink. The whole pad, blank space
// and all, would be scaled into the field as one picture, so a small
// drawing on a wide pad came out tiny on the document.

export type InkBounds = { height: number; width: number; x: number; y: number };

/**
 * The box around every pixel with ink (alpha above zero) in RGBA `pixels`
 * of a `width` × `height` image, grown by `padding` and kept inside the
 * image. Null when nothing was drawn.
 */
export function inkBounds(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  padding = 0,
): InkBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return null;
  }

  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(width - 1, maxX + padding);
  const bottom = Math.min(height - 1, maxY + padding);

  return { height: bottom - top + 1, width: right - left + 1, x: left, y: top };
}

/**
 * The box `inner` (of aspect `innerWidth` / `innerHeight`) takes when fitted
 * whole and centred in `outerWidth` × `outerHeight`.
 */
export function containRect(
  innerWidth: number,
  innerHeight: number,
  outerWidth: number,
  outerHeight: number,
): InkBounds {
  const scale = Math.min(outerWidth / innerWidth, outerHeight / innerHeight);
  const width = innerWidth * scale;
  const height = innerHeight * scale;

  return {
    height,
    width,
    x: (outerWidth - width) / 2,
    y: (outerHeight - height) / 2,
  };
}
