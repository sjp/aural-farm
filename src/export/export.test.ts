import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAudioScope } from "../audio/scope";
import type { Layer, Mix } from "../mixes/mix";
import type { SoundEntry } from "../sounds/registry";
import { defineSound, defineSoundMeta } from "../sounds/types";
import { FakeAudioContext, installFakeAudioGlobals } from "../test/fake-audio";
import { exportAudio, type ExportRequest } from "./export";
import { createBlobSink, type ExportSink } from "./sink";
import { WAV_HEADER_BYTES } from "./wav";

const RATE = 48000;
const HZ = 1.7;

/** The test signal: a slow stereo sine of absolute time, as a time-addressable sound makes. */
const signal = (time: number, channel: number) => 0.5 * Math.sin(2 * Math.PI * HZ * time + channel);

/** A fake offline context whose render is the test signal from the sound's `startAt`. */
class FakeOfflineContext extends FakeAudioContext {
  readonly length: number;
  startAt: number | undefined;

  constructor(length: number, sampleRate: number) {
    super({ sampleRate });
    this.length = length;
  }

  startRendering(): Promise<AudioBuffer> {
    const buffer = this.createBuffer(2, this.length, this.sampleRate);
    const start = this.startAt ?? Number.NaN;
    for (const channel of [0, 1]) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        data[i] = signal(start + i / this.sampleRate, channel);
      }
    }
    return Promise.resolve(buffer as unknown as AudioBuffer);
  }
}

let contexts: FakeOfflineContext[] = [];
const createContext = (length: number, sampleRate: number) => {
  const ctx = new FakeOfflineContext(length, sampleRate);
  contexts.push(ctx);
  return ctx as unknown as OfflineAudioContext;
};

function testSound(id: string, options: { period?: number; crash?: boolean } = {}): SoundEntry {
  const meta = defineSoundMeta({
    id,
    name: id,
    description: "A test sound.",
    categories: ["Tonal"],
    tags: [],
    cost: "very low",
    tint: "#888888",
    params: {},
  });
  const definition = defineSound(meta, {
    ...(options.period === undefined ? {} : { loopPeriod: () => options.period }),
    create(ctx, out, init) {
      return withAudioScope((scope) => {
        (ctx as unknown as FakeOfflineContext).startAt = init.startAt;
        const osc = scope.addSource(new OscillatorNode(ctx));
        osc.connect(out);
        if (options.crash === true) {
          init.onError?.(new Error("processor crashed"));
        }
        return {
          update: () => undefined,
          dispose: () => {
            scope.dispose();
          },
        };
      }, init.onError);
    },
  });
  return { ...meta, load: () => Promise.resolve(definition) };
}

const sounds = new Map([
  ["tone", testSound("tone")],
  ["beat", testSound("beat", { period: 1.3 })],
  ["crash", testSound("crash", { crash: true })],
]);

const layer = (id: string, change: Partial<Layer> = {}): Layer => ({
  id,
  volume: 80,
  muted: false,
  params: {},
  ...change,
});

const mix = (...ids: string[]): Mix => ({ master: 40, layers: ids.map((id) => layer(id)) });

function request(change: Partial<ExportRequest> = {}): ExportRequest {
  return {
    mix: mix("tone"),
    type: "clip",
    seconds: 40,
    format: "wav",
    sink: createBlobSink("audio/wav"),
    findSound: (id) => sounds.get(id),
    createContext,
    pause: () => Promise.resolve(),
    ...change,
  };
}

/** A WAV file's samples, per channel, as floats. */
async function decode(blob: Blob | undefined): Promise<Float32Array[]> {
  const bytes = new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0));
  const view = new DataView(bytes.buffer);
  const frames = view.getUint32(40, true) / 4;
  return [0, 1].map((c) =>
    Float32Array.from(
      { length: frames },
      (_, i) => view.getInt16(WAV_HEADER_BYTES + (i * 2 + c) * 2, true) / 32767,
    ),
  );
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  uninstall = installFakeAudioGlobals();
  contexts = [];
});

afterEach(() => {
  uninstall();
});

describe("exportAudio", () => {
  it("renders each chunk 5 s early, from its start, in a context of its length", async () => {
    await exportAudio(request({ seconds: 65 }));
    expect(contexts.map((c) => c.length / RATE)).toEqual([35, 35.05, 10.05]);
    const startAts = contexts.map((c) => c.startAt ?? Number.NaN);
    expect(startAts[0]).toBe(0);
    expect(startAts[1]).toBeCloseTo(29.95, 9);
    expect(startAts[2]).toBeCloseTo(59.95, 9);
  });

  it("exports with the master at 100, whatever the mix's master volume", async () => {
    await exportAudio(request({ seconds: 10 }));
    // The master chain's first node is its level.
    const level = contexts[0]?.nodes.find((n) => n.kind === "gain") as unknown as {
      gain: { value: number };
    };
    expect(level.gain.value).toBe(1);
  });

  it("writes the signal from absolute time 5 s on, joined across chunks without a seam", async () => {
    const result = await exportAudio(request());
    expect(result.seconds).toBe(40);
    const channels = await decode(result.blob);
    for (const [c, samples] of channels.entries()) {
      expect(samples).toHaveLength(40 * RATE);
      let worst = 0;
      samples.forEach((v, i) => {
        worst = Math.max(worst, Math.abs(v - signal(5 + i / RATE, c)));
      });
      expect(worst).toBeLessThan(2 / 32767);
    }
  });

  it("makes a loop that starts where its end leaves off", async () => {
    const result = await exportAudio(request({ type: "loop", seconds: 30 }));
    expect(result.seconds).toBe(30);
    // The tail renders first, then the loop's body.
    expect(contexts.map((c) => c.length / RATE)).toEqual([10.05, 35]);
    const [left = new Float32Array(0)] = await decode(result.blob);
    expect(left).toHaveLength(30 * RATE);
    const end = 30 + 5;
    expect(Math.abs(left[0] - signal(end, 0))).toBeLessThan(2 / 32767);
    expect(Math.abs((left.at(-1) ?? 0) - signal(end - 1 / RATE, 0))).toBeLessThan(2 / 32767);
    // Past the crossfade, the file is the signal itself.
    expect(Math.abs(left[6 * RATE] - signal(11, 0))).toBeLessThan(2 / 32767);
  });

  it("snaps a loop to a whole number of its layers' shared period", async () => {
    const result = await exportAudio(
      request({ mix: mix("tone", "beat"), type: "loop", seconds: 30 }),
    );
    expect(result.seconds).toBeCloseTo(23 * 1.3, 4);
    expect((await decode(result.blob))[0]).toHaveLength(Math.round(23 * 1.3 * RATE));
  });

  it("leaves a clip's length alone", async () => {
    const result = await exportAudio(request({ mix: mix("beat"), seconds: 30 }));
    expect(result.seconds).toBe(30);
  });

  it("ignores a muted layer's period", async () => {
    const muted: Mix = { master: 40, layers: [layer("tone"), layer("beat", { muted: true })] };
    const result = await exportAudio(request({ mix: muted, type: "loop", seconds: 30 }));
    expect(result.seconds).toBe(30);
  });

  it("reports progress after each chunk, up to 1", async () => {
    const progress: number[] = [];
    await exportAudio(
      request({
        seconds: 65,
        onProgress: (fraction) => {
          progress.push(fraction);
        },
      }),
    );
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
  });

  it("stops at a cancel, rendering nothing more and discarding the file", async () => {
    const controller = new AbortController();
    const aborted: string[] = [];
    const blob = createBlobSink("audio/wav");
    const sink: ExportSink = {
      ...blob,
      abort: () => {
        aborted.push("abort");
        return blob.abort();
      },
    };
    const promise = exportAudio(
      request({
        seconds: 65,
        sink,
        signal: controller.signal,
        onProgress: () => {
          controller.abort();
        },
      }),
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(contexts).toHaveLength(1);
    expect(aborted).toEqual(["abort"]);
  });

  it("stops at a cancel during a chunk, without waiting for its render", async () => {
    const controller = new AbortController();
    const promise = exportAudio(
      request({
        signal: controller.signal,
        createContext: (length, sampleRate) => {
          const ctx = createContext(length, sampleRate);
          // A render that never finishes, cancelled while it runs.
          ctx.startRendering = () => {
            controller.abort();
            return new Promise<AudioBuffer>(() => {
              // Never settles.
            });
          };
          return ctx;
        },
      }),
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails when a sound reports a failure while rendering", async () => {
    await expect(exportAudio(request({ mix: mix("crash") }))).rejects.toThrow("processor crashed");
  });

  it("fails for an unknown sound", async () => {
    await expect(exportAudio(request({ mix: mix("nope") }))).rejects.toThrow('No sound "nope"');
  });
});
