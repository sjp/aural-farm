import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("describeError", () => {
  it.each([
    [new Error("boom"), "boom"],
    [Object.assign(new TypeError("x"), { message: "" }), "TypeError"],
    ["plain", "plain"],
    [{ code: 1 }, '{"code":1}'],
    [undefined, "undefined"],
  ])("describes %o as %s", (error, expected) => {
    expect(describeError(error)).toBe(expected);
  });
});
