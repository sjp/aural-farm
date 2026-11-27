/**
 * The compressed export formats, encoded with WebCodecs and muxed by
 * mediabunny: Opus in WebM, or AAC in M4A. This module (and mediabunny with
 * it) is loaded only when someone exports compressed audio, so it stays out
 * of the entry chunk.
 */
import {
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from "mediabunny";
import { CODECS, type CompressedCodec } from "./options";
import type { ExportSink } from "./sink";

/** Takes an export's audio block by block and encodes it into a file. */
export interface AudioWriter {
  write: (block: readonly Float32Array[]) => Promise<void>;
  /** Writes the end of the file, once every block is in. */
  finish: () => Promise<void>;
  /** Stops early; the sink is aborted separately. */
  cancel: () => Promise<void>;
}

/** Blocks go to the encoder in pieces this long, in seconds, to keep each one small. */
const PIECE_SECONDS = 1;

/** Planar float samples: every channel's samples, one channel after another. */
function planar(block: readonly Float32Array[], from: number, to: number): Float32Array {
  const frames = to - from;
  const data = new Float32Array(frames * block.length);
  block.forEach((samples, c) => {
    data.set(samples.subarray(from, to), c * frames);
  });
  return data;
}

/**
 * A writer that encodes `codec` at its bitrate into `sink`, as a WebM file for
 * Opus or an M4A (MP4) file for AAC, with the index at the end so nothing has
 * to be held back in memory.
 */
export async function createCompressedWriter(
  codec: CompressedCodec,
  sink: ExportSink,
  sampleRate: number,
  numberOfChannels: number,
): Promise<AudioWriter> {
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => sink.write(chunk.data, chunk.position),
  });
  const output = new Output({
    format: codec === "opus" ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true }),
  });
  const source = new AudioSampleSource({
    codec,
    quality: new Quality({ bitrate: CODECS[codec].bitrate }),
  });
  output.addAudioTrack(source);
  await output.start();
  const piece = Math.round(PIECE_SECONDS * sampleRate);
  let written = 0;
  return {
    async write(block) {
      const frames = block[0]?.length ?? 0;
      for (let from = 0; from < frames; from += piece) {
        const to = Math.min(frames, from + piece);
        const sample = new AudioSample({
          data: planar(block, from, to),
          format: "f32-planar",
          numberOfChannels,
          sampleRate,
          timestamp: written / sampleRate,
        });
        try {
          await source.add(sample);
        } finally {
          sample.close();
        }
        written += to - from;
      }
    },
    async finish() {
      source.close();
      await output.finalize();
    },
    async cancel() {
      if (output.state !== "canceled" && output.state !== "finalized") {
        await output.cancel();
      }
    },
  };
}
