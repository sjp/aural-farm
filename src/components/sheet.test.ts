import { describe, expect, it } from "vitest";
import { DRAWER_QUERY, FLICK_VELOCITY, panelLayout, SHEET_QUERY, snapSheet } from "./sheet";

describe("panelLayout", () => {
  it.each([
    [false, false, "card"],
    [true, false, "sheet"],
    [false, true, "drawer"],
    [true, true, "drawer"],
  ] as const)("narrow %s and short %s give a %s", (narrow, short, layout) => {
    expect(panelLayout(narrow, short)).toBe(layout);
  });

  it("uses the portrait and landscape phone breakpoints", () => {
    expect(SHEET_QUERY).toBe("(max-width: 640px)");
    expect(DRAWER_QUERY).toBe("(max-height: 500px)");
  });
});

describe("snapSheet", () => {
  it.each([
    [0, 0, false],
    [0.49, 0, false],
    [0.5, 0, true],
    [1, 0, true],
    [0.9, -FLICK_VELOCITY + 1, true],
    [0.1, FLICK_VELOCITY - 1, false],
    [0.9, -FLICK_VELOCITY, false],
    [0.1, FLICK_VELOCITY, true],
    [0.95, -2000, false],
    [0.02, 2000, true],
  ])("let go of %d open at %d px/s snaps open: %s", (openness, velocity, open) => {
    expect(snapSheet(openness, velocity)).toBe(open);
  });
});
