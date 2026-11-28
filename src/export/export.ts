/**
 * Exporting a mix to an audio file: renders it chunk by chunk in offline
 * contexts (see `plan.ts`), joins the chunks, makes a loop's head, and streams
 * the result through a WAV or compressed writer into a sink. Only one chunk's
 * audio is in memory at a time. Between chunks it yields to the event loop,
 * so the page stays responsive. A cancel stops it at once: the chunk being
 * rendered can't be stopped, but its result is dropped.
 *
 * The mix is exported as it is (layer volumes, mutes and params) with the
 * master at 100, through the real master chain (high-pass and limiter). Solo
 * and the sleep timer are the live player's, and don't apply.
 */
import { layerGain, soundParams } from "../audio/mix-graph";
import { renderMix } from "../audio/render";
import type { Mix } from "../mixes/mix";
import { getSound } from "../sounds/registry";
import type { AudioWriter } from "./compressed";
import { ChunkJoiner, LoopHead } from "./join";
import type { CompressedCodec, ExportType } from "./options";
import {
  EXPORT_CHANNELS,
  EXPORT_RATE,
  planExport,
  snapLoopSeconds,
  type Chunk,
  type ExportPlan,
} from "./plan";
import type { ExportSink } from "./sink";
import { createDither, encodePcm16, wavHeader, WAV_HEADER_BYTES } from "./wav";

/** Renders one chunk: its channels, from `chunk.from`, preroll dropped. */
type ChunkRenderer = (mix: Mix, chunk: Chunk, plan: ExportPlan) => Promise<Float32Array[]>;

export interface ExportRequest {
  mix: Mix;
  type: ExportType;
  /** The length asked for; a loop may snap to its layers' shared rhythm. */
  seconds: number;
  format: "wav" | CompressedCodec;
  sink: ExportSink;
  /** Called after each chunk with the fraction done, 0–1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Finds a sound's registry entry; the default is the registry. */
  findSound?: typeof getSound;
  /** Makes each chunk's offline context; tests pass a stand-in. */
  createContext?: (length: number, sampleRate: number) => OfflineAudioContext;
  /** Waits between chunks, letting the page handle input; the default yields to the event loop. */
  pause?: () => Promise<void>;
}

interface ExportResult {
  /** The file to download, or undefined when it was written straight to disk. */
  blob: Blob | undefined;
  /** Its length, in seconds. */
  seconds: number;
}

const yieldToPage = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Settles as `promise` does, or rejects with the abort reason as soon as
 * `signal` aborts, without waiting for `promise`.
 */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Writes blocks as 16-bit WAV: the header for the known length first, then the samples. */
async function createWavWriter(sink: ExportSink, frames: number): Promise<AudioWriter> {
  await sink.write(wavHeader(frames, EXPORT_CHANNELS, EXPORT_RATE), 0);
  let position = WAV_HEADER_BYTES;
  const dither = createDither();
  return {
    async write(block) {
      const bytes = encodePcm16(block, dither);
      await sink.write(bytes, position);
      position += bytes.length;
    },
    finish: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
}

/** The rhythm periods of the mix's audible layers, for snapping a loop's length. */
async function loopPeriods(mix: Mix, findSound: typeof getSound): Promise<number[]> {
  const periods: number[] = [];
  for (const layer of mix.layers) {
    const entry = layerGain(layer) > 0 ? findSound(layer.id) : undefined;
    if (entry) {
      const definition = await entry.load();
      const period = definition.loopPeriod?.(soundParams(definition, layer.params));
      if (period !== undefined) {
        periods.push(period);
      }
    }
  }
  return periods;
}

function chunkRenderer(request: ExportRequest): ChunkRenderer {
  return async (mix, chunk, plan) => {
    const errors: unknown[] = [];
    const buffer = await renderMix(mix, {
      seconds: (chunk.preroll + chunk.frames) / plan.sampleRate,
      startAt: chunk.startAt,
      sampleRate: plan.sampleRate,
      onError: (error) => {
        errors.push(error);
      },
      ...(request.findSound ? { findSound: request.findSound } : {}),
      ...(request.createContext ? { createContext: request.createContext } : {}),
    });
    if (errors.length > 0) {
      throw errors[0];
    }
    return Array.from({ length: buffer.numberOfChannels }, (_, c) =>
      buffer.getChannelData(c).subarray(chunk.preroll, chunk.preroll + chunk.frames),
    );
  };
}

/** Renders `request.mix` into `request.sink` as a clip or a seamless loop. Rejects on a cancel. */
export async function exportAudio(request: ExportRequest): Promise<ExportResult> {
  const { sink, signal, format } = request;
  const pause = request.pause ?? yieldToPage;
  const mix: Mix = { ...request.mix, master: 100 };
  const loop = request.type === "loop";
  const seconds = loop
    ? snapLoopSeconds(request.seconds, await loopPeriods(mix, request.findSound ?? getSound))
    : request.seconds;
  const plan = planExport(seconds, loop);
  const render = chunkRenderer(request);
  let writer: AudioWriter | undefined;
  try {
    signal?.throwIfAborted();
    const active =
      format === "wav"
        ? await createWavWriter(sink, plan.frames)
        : await import("./compressed").then((m) =>
            m.createCompressedWriter(format, sink, EXPORT_RATE, EXPORT_CHANNELS),
          );
    writer = active;

    const total = plan.chunks.reduce((sum, c) => sum + c.preroll + c.frames, 0);
    let rendered = 0;
    const renderNext = async (chunk: Chunk) => {
      signal?.throwIfAborted();
      // A chunk takes a while to render on a slow or busy machine: don't make a
      // cancel wait for it.
      const channels = await unlessAborted(render(mix, chunk, plan), signal);
      rendered += chunk.preroll + chunk.frames;
      request.onProgress?.(rendered / total);
      await pause();
      return channels;
    };

    // A loop's tail renders first: its frames after the loop point become the file's head.
    const last = plan.chunks.length - 1;
    const tailChunk = plan.crossfade > 0 ? plan.chunks[last] : undefined;
    const tail = tailChunk ? await renderNext(tailChunk) : undefined;
    const head = tail
      ? new LoopHead(tail.map((c) => c.subarray(plan.overlap, plan.overlap + plan.crossfade)))
      : undefined;

    const joiner = new ChunkJoiner(plan.overlap);
    let position = 0;
    const emit = async (block: Float32Array[]) => {
      const frames = Math.min(block[0]?.length ?? 0, plan.frames - position);
      if (frames <= 0) {
        return;
      }
      const part = block.map((c) => c.subarray(0, frames));
      head?.apply(part, position);
      await active.write(part);
      position += frames;
    };
    for (const [index, chunk] of plan.chunks.entries()) {
      const channels = index === last && tail ? tail : await renderNext(chunk);
      await emit(joiner.push(channels));
    }
    await emit(joiner.finish());
    if (position !== plan.frames) {
      throw new Error(`Wrote ${String(position)} of ${String(plan.frames)} frames`);
    }
    await active.finish();
    return { blob: await sink.close(), seconds: plan.frames / plan.sampleRate };
  } catch (error) {
    await writer?.cancel().catch(() => undefined);
    await sink.abort().catch(() => undefined);
    throw error;
  }
}
