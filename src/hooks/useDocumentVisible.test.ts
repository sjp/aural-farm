// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { act } from "../test/act";
import { useDocumentVisible } from "./useDocumentVisible";

describe("useDocumentVisible", () => {
  it("follows the document's visibility", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);
    act(() => {
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);
    hidden.mockRestore();
  });
});
