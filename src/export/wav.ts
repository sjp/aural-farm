/**
 * 16-bit PCM WAV files, written in pieces: the header first, for a length
 * known up-front, then the samples block by block, so a long file never has
 * to sit in memory whole.
 */

/** The size of the canonical 44-byte header this writes. */
export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const FULL_SCALE = 32767;

/** The size of a 16-bit WAV file of `frames` frames, header included. */
export function wavBytes(frames: number, channels: number): number {
  return WAV_HEADER_BYTES + frames * channels * BYTES_PER_SAMPLE;
}

/** The RIFF header of a 16-bit PCM WAV file holding `frames` frames. */
export function wavHeader(frames: number, channels: number, sampleRate: number): Uint8Array {
  const data = frames * channels * BYTES_PER_SAMPLE;
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(at + i, value.codePointAt(i) ?? 0);
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  text(36, "data");
  view.setUint32(40, data, true);
  return header;
}

/**
 * A source of TPDF dither: the difference of two uniform values, so −1 to 1
 * least-significant bits with a triangular distribution. Seeded (xorshift32),
 * so the same render always makes the same file.
 */
export function createDither(seed = 0x2545f491): () => number {
  let state = seed >>> 0 || 1;
  const uniform = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return () => uniform() - uniform();
}

/**
 * Channels of samples as interleaved 16-bit little-endian PCM: each clipped to
 * full scale, dithered and rounded.
 */
export function encodePcm16(channels: readonly Float32Array[], dither: () => number): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(frames * count * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const sample = channels[c]?.[i] ?? 0;
      const v = Math.max(-1, Math.min(1, sample)) * FULL_SCALE + dither();
      const rounded = Math.max(-FULL_SCALE - 1, Math.min(FULL_SCALE, Math.round(v)));
      view.setInt16((i * count + c) * BYTES_PER_SAMPLE, rounded, true);
    }
  }
  return bytes;
}
