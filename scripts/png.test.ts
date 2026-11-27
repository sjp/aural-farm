import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, PNG_SIGNATURE } from "./png.mjs";

/** The CRC-32 PNG uses, computed bit by bit, independently of the encoder's. */
function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
  expected: number;
}

/** Splits a PNG file into its chunks, after the signature. */
function chunks(file: Buffer): Chunk[] {
  const out: Chunk[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const typeAndData = file.subarray(at + 4, at + 8 + length);
    out.push({
      type: typeAndData.subarray(0, 4).toString("ascii"),
      data: typeAndData.subarray(4),
      crc: file.readUInt32BE(at + 8 + length),
      expected: crc(typeAndData),
    });
    at += 12 + length;
  }
  return out;
}

/** A small test image whose every pixel differs. */
function pixels(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i++) {
    rgba[i] = (i * 37 + 11) & 255;
  }
  return rgba;
}

describe("encodePng", () => {
  const width = 5;
  const height = 3;
  const rgba = pixels(width, height);
  const file = encodePng(width, height, rgba);

  it("starts with the PNG signature", () => {
    expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("writes IHDR, IDAT and IEND, each with a correct CRC", () => {
    const found = chunks(file);
    expect(found.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    for (const c of found) {
      expect(c.crc).toBe(c.expected);
    }
  });

  it("describes an 8-bit RGBA, non-interlaced image of the given size in IHDR", () => {
    const ihdr = chunks(file)[0].data;
    expect(ihdr.length).toBe(13);
    expect({
      width: ihdr.readUInt32BE(0),
      height: ihdr.readUInt32BE(4),
      bitDepth: ihdr[8],
      colourType: ihdr[9],
      compression: ihdr[10],
      filter: ihdr[11],
      interlace: ihdr[12],
    }).toEqual({
      width,
      height,
      bitDepth: 8,
      colourType: 6,
      compression: 0,
      filter: 0,
      interlace: 0,
    });
  });

  it("stores every row unfiltered, so the pixels inflate back unchanged", () => {
    const raw = inflateSync(chunks(file)[1].data);
    const stride = width * 4;
    expect(raw.length).toBe((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1));
      expect(row[0]).toBe(0);
      expect([...row.subarray(1)]).toEqual([...rgba.subarray(y * stride, (y + 1) * stride)]);
    }
  });

  it.each([
    { width: 0, height: 1, length: 0 },
    { width: 1.5, height: 1, length: 6 },
    { width: 2, height: 2, length: 15 },
  ])("rejects a $width × $height image of $length bytes", ({ width: w, height: h, length }) => {
    expect(() => encodePng(w, h, new Uint8Array(length))).toThrow(RangeError);
  });
});
