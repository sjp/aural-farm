import { afterEach, describe, expect, it } from "vitest";
import { canPickFile, createBlobSink, createFileSink, pickFile } from "./sink";

const bytes = (...values: number[]) => Uint8Array.from(values);

async function contents(blob: Blob | undefined): Promise<number[]> {
  return [...new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))];
}

describe("createBlobSink", () => {
  it("joins writes in order into a Blob of its type", async () => {
    const sink = createBlobSink("audio/wav");
    await sink.write(bytes(1, 2, 3), 0);
    await sink.write(bytes(4, 5), 3);
    const blob = await sink.close();
    expect(blob?.type).toBe("audio/wav");
    expect(await contents(blob)).toEqual([1, 2, 3, 4, 5]);
  });

  it("copies what it is given, so the caller can reuse its buffer", async () => {
    const sink = createBlobSink("x");
    const buffer = bytes(1, 2);
    await sink.write(buffer, 0);
    buffer.fill(9);
    expect(await contents(await sink.close())).toEqual([1, 2]);
  });

  it("fills a gap with zeros", async () => {
    const sink = createBlobSink("x");
    await sink.write(bytes(1), 0);
    await sink.write(bytes(2), 3);
    expect(await contents(await sink.close())).toEqual([1, 0, 0, 2]);
  });

  it("writes back over earlier bytes, across parts", async () => {
    const sink = createBlobSink("x");
    await sink.write(bytes(1, 2, 3), 0);
    await sink.write(bytes(4, 5, 6), 3);
    await sink.write(bytes(7, 8, 9), 6);
    await sink.write(bytes(0, 0, 0, 0), 2);
    await sink.write(bytes(5), 0);
    expect(await contents(await sink.close())).toEqual([5, 2, 0, 0, 0, 0, 7, 8, 9]);
  });

  it("grows when a write back runs past the end", async () => {
    const sink = createBlobSink("x");
    await sink.write(bytes(1, 2, 3), 0);
    await sink.write(bytes(8, 9), 2);
    await sink.write(bytes(4), 4);
    expect(await contents(await sink.close())).toEqual([1, 2, 8, 9, 4]);
  });
});

describe("createFileSink", () => {
  it("writes at positions, then closes, or aborts", async () => {
    const calls: unknown[] = [];
    const stream = {
      write: (chunk: unknown) => {
        calls.push(chunk);
        return Promise.resolve();
      },
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
      abort: () => {
        calls.push("abort");
        return Promise.resolve();
      },
    } as unknown as FileSystemWritableFileStream;
    const sink = createFileSink(stream);
    await sink.write(bytes(1, 2), 10);
    await expect(sink.close()).resolves.toBeUndefined();
    await sink.abort();
    expect(calls).toEqual([{ type: "write", position: 10, data: bytes(1, 2) }, "close", "abort"]);
  });
});

describe("pickFile", () => {
  const type = { description: "WAV audio", accept: { "audio/wav": [".wav"] } };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "showSaveFilePicker");
  });

  it("does nothing where the browser has no picker", async () => {
    expect(canPickFile()).toBe(false);
    await expect(pickFile("a.wav", type)).resolves.toBeUndefined();
  });

  it("opens the picked file for writing", async () => {
    const stream = {};
    const asked: unknown[] = [];
    Reflect.set(globalThis, "showSaveFilePicker", (options: unknown) => {
      asked.push(options);
      return Promise.resolve({ createWritable: () => Promise.resolve(stream) });
    });
    expect(canPickFile()).toBe(true);
    await expect(pickFile("a.wav", type)).resolves.toBe(stream);
    expect(asked).toEqual([{ suggestedName: "a.wav", types: [type] }]);
  });

  it("is undefined when the user cancels, and passes on other failures", async () => {
    Reflect.set(globalThis, "showSaveFilePicker", () =>
      Promise.reject(new DOMException("cancelled", "AbortError")),
    );
    await expect(pickFile("a.wav", type)).resolves.toBeUndefined();
    Reflect.set(globalThis, "showSaveFilePicker", () =>
      Promise.reject(new DOMException("no", "SecurityError")),
    );
    await expect(pickFile("a.wav", type)).rejects.toThrow("no");
  });
});
