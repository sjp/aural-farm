// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { ExportRequest } from "../export/export";
import { createPreferences } from "../lib/preferences";
import type { Mix } from "../mixes/mix";
import { act } from "../test/act";
import { useAudioExport } from "./useAudioExport";

const MIX: Mix = {
  master: 60,
  name: "Night Drive",
  layers: [{ id: "engine-core", volume: 80, muted: false, params: {} }],
};

/** A stand-in export that waits to be told how to end. */
function deferredRun() {
  const requests: ExportRequest[] = [];
  let finish: (blob: Blob | undefined) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const run = (request: ExportRequest) => {
    requests.push(request);
    return new Promise<{ blob: Blob | undefined }>((resolve, reject) => {
      finish = (blob) => {
        resolve({ blob });
      };
      fail = reject;
      request.signal?.addEventListener("abort", () => {
        reject(new DOMException("cancelled", "AbortError"));
      });
    });
  };
  return {
    run,
    requests,
    finish: (blob: Blob | undefined) => {
      finish(blob);
    },
    fail: (error: unknown) => {
      fail(error);
    },
  };
}

function setup(options: { codec?: "opus" | "aac"; canPick?: boolean; picked?: boolean } = {}) {
  const preferences = createPreferences(() => undefined);
  const notify = vi.fn<(message: string) => void>();
  const download = vi.fn<(name: string, blob: Blob) => void>();
  const exporter = deferredRun();
  const stream = {};
  const pick = vi.fn<() => Promise<FileSystemWritableFileStream | undefined>>(() =>
    Promise.resolve(
      options.picked === false ? undefined : (stream as unknown as FileSystemWritableFileStream),
    ),
  );
  const detect = () => Promise.resolve(options.codec);
  const hook = renderHook(
    ({ mix }: { mix: Mix }) =>
      useAudioExport({
        preferences,
        mix,
        coarse: false,
        notify,
        run: exporter.run,
        detect,
        canPick: () => options.canPick === true,
        pick,
        download,
      }),
    { initialProps: { mix: MIX } },
  );
  const controls = () => hook.result.current;
  /** Lets pending promises settle. */
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  return { ...hook, ...exporter, preferences, notify, download, pick, controls, settle };
}

describe("useAudioExport", () => {
  it("finds the compressed format, or none", async () => {
    const opus = setup({ codec: "opus" });
    expect(opus.controls().codec).toBeUndefined();
    await opus.settle();
    expect(opus.controls().codec).toBe("opus");
    const none = setup();
    await none.settle();
    expect(none.controls().codec).toBe("none");
  });

  it("keeps the choices in the preferences", () => {
    const { controls, preferences } = setup();
    act(() => {
      controls().onSettingsChange({ ...controls().settings, type: "loop", loopSeconds: 30 });
    });
    expect(controls().settings.type).toBe("loop");
    expect(preferences.get("export.loopSeconds")).toBe("30");
  });

  it("exports the mix as it was when the export started, and downloads it", async () => {
    const { controls, settle, rerender, requests, finish, download, notify } = setup();
    await settle();
    act(() => {
      controls().onExport();
    });
    expect(controls().progress).toEqual({ fraction: 0, remaining: undefined });
    rerender({ mix: { ...MIX, layers: [] } });
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mix: MIX, type: "clip", seconds: 600, format: "wav" });
    // A second press while one runs does nothing.
    act(() => {
      controls().onExport();
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      requests[0]?.onProgress?.(0.25);
    });
    expect(controls().progress).toEqual({ fraction: 0.25, remaining: 90 });

    const blob = new Blob(["x"]);
    finish(blob);
    await settle();
    expect(download).toHaveBeenCalledWith("aural-farm-night-drive-10min.wav", blob);
    expect(notify).toHaveBeenCalledWith("Exported aural-farm-night-drive-10min.wav");
    expect(controls().progress).toBeUndefined();
  });

  it("exports the compressed format when chosen and supported", async () => {
    const { controls, settle, requests, finish, download } = setup({ codec: "aac" });
    await settle();
    act(() => {
      controls().onSettingsChange({ ...controls().settings, format: "compressed" });
    });
    act(() => {
      controls().onExport();
    });
    await settle();
    expect(requests[0]?.format).toBe("aac");
    finish(new Blob(["x"]));
    await settle();
    expect(download.mock.calls[0]?.[0]).toBe("aural-farm-night-drive-10min.m4a");
  });

  it("writes a WAV to a picked file where it can, and says it's saved", async () => {
    const { controls, settle, requests, finish, pick, notify, download } = setup({
      canPick: true,
    });
    act(() => {
      controls().onExport();
    });
    expect(pick).toHaveBeenCalledWith("aural-farm-night-drive-10min.wav", {
      description: "WAV audio",
      accept: { "audio/wav": [".wav"] },
    });
    await settle();
    expect(requests).toHaveLength(1);
    finish(undefined);
    await settle();
    expect(download).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Saved aural-farm-night-drive-10min.wav");
  });

  it("does nothing when the user closes the picker", async () => {
    const { controls, settle, requests, notify } = setup({ canPick: true, picked: false });
    act(() => {
      controls().onExport();
    });
    await settle();
    expect(requests).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(controls().progress).toBeUndefined();
  });

  it("cancels", async () => {
    const { controls, settle, notify, download } = setup();
    act(() => {
      controls().onExport();
    });
    await settle();
    act(() => {
      controls().onCancel();
    });
    await settle();
    expect(notify).toHaveBeenCalledWith("Export cancelled");
    expect(download).not.toHaveBeenCalled();
    expect(controls().progress).toBeUndefined();
  });

  it("says when an export fails", async () => {
    const { controls, settle, notify, fail } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => {
      controls().onExport();
    });
    await settle();
    fail(new Error('No sound "nope"'));
    await settle();
    expect(notify).toHaveBeenCalledWith('Export failed: No sound "nope"');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("cancels a running export when unmounted", async () => {
    const { controls, settle, requests, unmount } = setup();
    act(() => {
      controls().onExport();
    });
    await settle();
    act(() => {
      unmount();
    });
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it("can't export a mix with nothing to hear", () => {
    const { controls, rerender } = setup();
    expect(controls().canExport).toBe(true);
    rerender({
      mix: { ...MIX, layers: [{ ...MIX.layers[0], id: "x", volume: 80, muted: true, params: {} }] },
    });
    expect(controls().canExport).toBe(false);
  });
});
