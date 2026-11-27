// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Description } from "./Description";

const TEXT = "A long description that runs on well past the two lines the panel has room for.";

/** Makes every element's content `scroll` px tall in a box `client` px tall. */
function measuring(scroll: number, client: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(client);
}

describe("Description", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a description that fits two lines without More", () => {
    measuring(34, 34);
    render(<Description text="Short." />);
    expect(screen.getByText("Short.").dataset.open).toBe("false");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clamps a longer one, with More and Less", () => {
    measuring(68, 34);
    render(<Description text={TEXT} />);
    const text = screen.getByText(TEXT);
    const more = screen.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(text.id);
    fireEvent.click(more);
    expect(text.dataset.open).toBe("true");
    const less = screen.getByRole("button", { name: "Less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(text.dataset.open).toBe("false");
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });
});
