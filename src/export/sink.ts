/**
 * Where an export's bytes go. Encoders write at byte positions, mostly in
 * order but sometimes back over earlier bytes (a container's sizes, once
 * they're known), so a sink takes positioned writes.
 *
 *   - A blob sink keeps the file as `Blob` parts, which the browser may hold on
 *     disk rather than in memory, and makes one `Blob` of them at the end. A
 *     write back over earlier bytes splits the parts it lands on (`Blob.slice`
 *     doesn't copy).
 *   - A file sink writes straight to a file the user picked, where the browser
 *     has `showSaveFilePicker`, so even a long WAV never sits in memory.
 */

export interface ExportSink {
  write: (data: Uint8Array, position: number) => Promise<void>;
  /** Finishes the file: a `Blob` to download, or undefined once it is on disk. */
  close: () => Promise<Blob | undefined>;
  /** Gives up, discarding what was written. */
  abort: () => Promise<void>;
}

interface Part {
  start: number;
  blob: Blob;
}

/** A sink that builds a `Blob` of `type`. */
export function createBlobSink(type: string): ExportSink {
  let parts: Part[] = [];
  let size = 0;
  const copy = (data: Uint8Array) => new Blob([data.slice()]);
  return {
    write(data, position) {
      const end = position + data.length;
      if (position >= size) {
        if (position > size) {
          parts.push({ start: size, blob: new Blob([new Uint8Array(position - size)]) });
        }
        parts.push({ start: position, blob: copy(data) });
        size = end;
        return Promise.resolve();
      }
      // Over earlier bytes: keep what each part has outside [position, end).
      const kept: Part[] = [];
      for (const part of parts) {
        const partEnd = part.start + part.blob.size;
        if (partEnd <= position || part.start >= end) {
          kept.push(part);
          continue;
        }
        if (part.start < position) {
          kept.push({ start: part.start, blob: part.blob.slice(0, position - part.start) });
        }
        if (partEnd > end) {
          kept.push({ start: end, blob: part.blob.slice(end - part.start) });
        }
      }
      const at = kept.findIndex((p) => p.start >= end);
      kept.splice(at === -1 ? kept.length : at, 0, { start: position, blob: copy(data) });
      parts = kept;
      size = Math.max(size, end);
      return Promise.resolve();
    },
    close() {
      const blob = new Blob(
        parts.map((p) => p.blob),
        { type },
      );
      parts = [];
      return Promise.resolve(blob);
    },
    abort() {
      parts = [];
      return Promise.resolve();
    },
  };
}

/** A sink that writes to a file on disk, through the File System Access API. */
export function createFileSink(stream: FileSystemWritableFileStream): ExportSink {
  return {
    write: (data, position) => stream.write({ type: "write", position, data: data.slice() }),
    close: async () => {
      await stream.close();
      return undefined;
    },
    abort: () => stream.abort(),
  };
}

interface SaveFileType {
  description: string;
  accept: Record<string, string[]>;
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types: SaveFileType[];
}) => Promise<FileSystemFileHandle>;

/** The browser's `showSaveFilePicker`, where it has one. */
function savePicker(): SaveFilePicker | undefined {
  const picker: unknown = Reflect.get(globalThis, "showSaveFilePicker");
  return typeof picker === "function"
    ? (options) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        (picker as SaveFilePicker).call(globalThis, options)
    : undefined;
}

/** Whether the browser can write an export straight to a file the user picks. */
export function canPickFile(): boolean {
  return savePicker() !== undefined;
}

/**
 * Asks the user where to save the file, and opens it for writing: a stream,
 * or undefined when they cancel the picker. Call it straight from the click
 * that asked for the export, since the picker needs that user activation.
 */
export async function pickFile(
  suggestedName: string,
  type: SaveFileType,
): Promise<FileSystemWritableFileStream | undefined> {
  const picker = savePicker();
  if (!picker) {
    return undefined;
  }
  try {
    const handle = await picker({ suggestedName, types: [type] });
    return await handle.createWritable();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return undefined;
    }
    throw error;
  }
}
