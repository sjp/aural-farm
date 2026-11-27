import { describe, expect, it } from "vitest";
import { createBackdrop, targetSize } from "./backdrop";

describe("targetSize", () => {
  it("is an eighth of the canvas, keeping its shape", () => {
    expect(targetSize(1920, 1080)).toEqual([240, 135]);
  });

  it("is at least 64 px tall", () => {
    expect(targetSize(800, 300)).toEqual([171, 64]);
    expect(targetSize(1, 1)).toEqual([64, 64]);
  });
});

describe("createBackdrop", () => {
  it("throws when the canvas has no WebGL2", () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => createBackdrop(canvas)).toThrow("WebGL2 isn't available");
  });
});
