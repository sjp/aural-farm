/**
 * A minimal PNG encoder: 8-bit RGBA, no interlacing, every row unfiltered, compressed
 * with `node:zlib`. Enough for the app's icons, with no dependency.
 */
import { crc32, deflateSync } from "node:zlib";

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One chunk: length, type, data, and the CRC of type and data. @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes `rgba` (width × height pixels, four bytes each, row by row) as a PNG file.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Bad PNG size ${String(width)}×${String(height)}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(
      `Expected ${String(width * height * 4)} bytes, got ${String(rgba.length)}`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  // Each row starts with its filter type, 0 (None).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
