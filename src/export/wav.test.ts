import { describe, expect, it } from "vitest";
import { createDither, encodePcm16, WAV_HEADER_BYTES, wavBytes, wavHeader } from "./wav";

/** Reads a canonical WAV header back. */
function parseHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCodePoint(...bytes.subarray(at, at + 4));
  return {
    riff: text(0),
    riffSize: view.getUint32(4, true),
    wave: text(8),
    fmt: text(12),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36),
    dataSize: view.getUint32(40, true),
  };
}

describe("wavHeader", () => {
  it.each([
    [1, 48000, 1000],
    [2, 48000, 1000],
    [2, 44100, 12345],
    [1, 22050, 7],
  ])("round-trips %d channel(s) at %d Hz, %d frames", (channels, sampleRate, frames) => {
    const header = wavHeader(frames, channels, sampleRate);
    expect(header).toHaveLength(WAV_HEADER_BYTES);
    const data = frames * channels * 2;
    expect(parseHeader(header)).toEqual({
      riff: "RIFF",
      riffSize: 36 + data,
      wave: "WAVE",
      fmt: "fmt ",
      fmtSize: 16,
      format: 1,
      channels,
      sampleRate,
      byteRate: sampleRate * channels * 2,
      blockAlign: channels * 2,
      bits: 16,
      data: "data",
      dataSize: data,
    });
    expect(wavBytes(frames, channels)).toBe(WAV_HEADER_BYTES + data);
  });

  it("holds a 60-minute stereo file in its 32-bit sizes", () => {
    const frames = 60 * 60 * 48000;
    expect(parseHeader(wavHeader(frames, 2, 48000)).dataSize).toBe(frames * 4);
    expect(wavBytes(frames, 2)).toBe(691_200_044);
  });
});

describe("createDither", () => {
  it("stays within ±1 LSB, centred on 0, and repeats per seed", () => {
    const dither = createDither(7);
    const values = Array.from({ length: 20000 }, dither);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(Math.min(...values)).toBeGreaterThan(-1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    // Triangular: a variance of 1/6.
    const variance = values.reduce((a, b) => a + b * b, 0) / values.length;
    expect(variance).toBeCloseTo(1 / 6, 2);
    const again = createDither(7);
    expect(Array.from({ length: 5 }, again)).toEqual(values.slice(0, 5));
  });
});

describe("encodePcm16", () => {
  const read = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer);
    return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
  };

  it("interleaves channels, little-endian", () => {
    const left = Float32Array.from([0, 0.5, -0.5]);
    const right = Float32Array.from([1, -1, 0.25]);
    const pcm = read(encodePcm16([left, right], () => 0));
    expect(pcm).toEqual([0, 32767, 16384, -32767, -16383, 8192]);
  });

  it("handles an odd number of frames in mono", () => {
    expect(encodePcm16([new Float32Array(5)], () => 0)).toHaveLength(10);
  });

  it("clips past full scale and keeps dithered values in range", () => {
    const pcm = read(encodePcm16([Float32Array.from([2, -2, 1, -1])], () => 0.999));
    expect(pcm).toEqual([32767, -32766, 32767, -32766]);
    const low = read(encodePcm16([Float32Array.from([-1])], () => -0.999));
    expect(low).toEqual([-32768]);
  });

  it("rounds each sample within 1.5 LSB of its exact value", () => {
    const dither = createDither(3);
    const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i * 0.01) * 0.9);
    const pcm = read(encodePcm16([samples], dither));
    pcm.forEach((v, i) => {
      expect(Math.abs(v - (samples[i] ?? 0) * 32767)).toBeLessThan(1.5);
    });
  });

  it("writes silence as zero or ±1 LSB of dither", () => {
    const pcm = read(encodePcm16([new Float32Array(1000)], createDither()));
    expect(pcm.every((v) => Math.abs(v) <= 1)).toBe(true);
  });
});
