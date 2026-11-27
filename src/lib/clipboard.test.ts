import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the Clipboard API when it works", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const legacyCopy = vi.fn<(text: string) => boolean>(() => true);
    await expect(copyText("hi", { writeText, legacyCopy })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it("falls back when the Clipboard API refuses", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.reject(new Error("denied")),
    );
    const legacyCopy = vi.fn<(text: string) => boolean>(() => true);
    await expect(copyText("hi", { writeText, legacyCopy })).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith("hi");
  });

  it("falls back when the Clipboard API is missing", async () => {
    await expect(copyText("hi", { writeText: undefined, legacyCopy: () => false })).resolves.toBe(
      false,
    );
  });
});
