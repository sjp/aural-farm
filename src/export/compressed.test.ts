import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCompressedWriter } from "./compressed";
import type { ExportSink } from "./sink";

/** What the stand-in mediabunny saw. */
const seen = vi.hoisted(() => ({
  events: [] as string[],
  samples: [] as { data: Float32Array; timestamp: number; closed: boolean }[],
  format: undefined as unknown,
  quality: undefined as unknown,
  codec: undefined as unknown,
  writable: undefined as WritableStream<{ data: Uint8Array; position: number }> | undefined,
}));

vi.mock("mediabunny", () => {
  class AudioSample {
    record: { data: Float32Array; timestamp: number; closed: boolean };
    constructor(init: { data: Float32Array; timestamp: number }) {
      this.record = { data: init.data, timestamp: init.timestamp, closed: false };
      seen.samples.push(this.record);
    }
    close() {
      this.record.closed = true;
    }
  }
  class AudioSampleSource {
    constructor(config: { codec: string; quality: unknown }) {
      seen.codec = config.codec;
      seen.quality = config.quality;
    }
    add() {
      seen.events.push("add");
      return Promise.resolve();
    }
    close() {
      seen.events.push("close source");
    }
  }
  class Output {
    state = "pending";
    constructor(options: { format: unknown; target: { writable: WritableStream } }) {
      seen.format = options.format;
      seen.writable = options.target.writable as typeof seen.writable;
    }
    addAudioTrack() {
      seen.events.push("track");
    }
    start() {
      seen.events.push("start");
      return Promise.resolve();
    }
    finalize() {
      seen.events.push("finalize");
      this.state = "finalized";
      return Promise.resolve();
    }
    cancel() {
      seen.events.push("cancel");
      this.state = "canceled";
      return Promise.resolve();
    }
  }
  class StreamTarget {
    writable: WritableStream;
    constructor(writable: WritableStream) {
      this.writable = writable;
    }
  }
  class Quality {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }
  class WebMOutputFormat {
    kind = "webm";
  }
  class Mp4OutputFormat {
    kind = "mp4";
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }
  return {
    AudioSample,
    AudioSampleSource,
    Mp4OutputFormat,
    Output,
    Quality,
    StreamTarget,
    WebMOutputFormat,
  };
});

const writes: [number[], number][] = [];
const sink: ExportSink = {
  write: (data, position) => {
    writes.push([[...data], position]);
    return Promise.resolve();
  },
  close: () => Promise.resolve(undefined),
  abort: () => Promise.resolve(),
};

beforeEach(() => {
  seen.events.length = 0;
  seen.samples.length = 0;
  writes.length = 0;
});

describe("createCompressedWriter", () => {
  it("encodes Opus at 128 kb/s into WebM", async () => {
    await createCompressedWriter("opus", sink, 10, 2);
    expect(seen.codec).toBe("opus");
    expect(seen.quality).toEqual({ options: { bitrate: 128_000 } });
    expect(seen.format).toEqual({ kind: "webm" });
    expect(seen.events).toEqual(["track", "start"]);
  });

  it("encodes AAC at 160 kb/s into M4A, with its index at the end", async () => {
    await createCompressedWriter("aac", sink, 10, 2);
    expect(seen.codec).toBe("aac");
    expect(seen.quality).toEqual({ options: { bitrate: 160_000 } });
    expect(seen.format).toEqual({ kind: "mp4", options: { fastStart: false } });
  });

  it("passes blocks on as planar pieces of up to 1 s, with running timestamps", async () => {
    const writer = await createCompressedWriter("opus", sink, 10, 2);
    const left = Float32Array.from({ length: 25 }, (_, i) => i);
    const right = Float32Array.from({ length: 25 }, (_, i) => -i);
    await writer.write([left.subarray(0, 15), right.subarray(0, 15)]);
    await writer.write([left.subarray(15), right.subarray(15)]);
    expect(seen.samples.map((s) => [s.timestamp, s.data.length, s.closed])).toEqual([
      [0, 20, true],
      [1, 10, true],
      [1.5, 20, true],
    ]);
    expect([...(seen.samples[1]?.data ?? [])]).toEqual([
      10, 11, 12, 13, 14, -10, -11, -12, -13, -14,
    ]);
    await writer.finish();
    expect(seen.events.slice(-2)).toEqual(["close source", "finalize"]);
    await writer.cancel();
    expect(seen.events.at(-1)).toBe("finalize");
  });

  it("sends what mediabunny writes to the sink at its positions", async () => {
    await createCompressedWriter("opus", sink, 10, 2);
    const writer = seen.writable?.getWriter();
    await writer?.write({ data: Uint8Array.from([1, 2]), position: 0 });
    await writer?.write({ data: Uint8Array.from([3]), position: 1 });
    expect(writes).toEqual([
      [[1, 2], 0],
      [[3], 1],
    ]);
  });

  it("cancels the output", async () => {
    const writer = await createCompressedWriter("opus", sink, 10, 2);
    await writer.cancel();
    expect(seen.events.at(-1)).toBe("cancel");
  });
});
