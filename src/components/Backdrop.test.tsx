// @vitest-environment happy-dom
import { render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backdrop as BackdropProgram } from "../backdrop/backdrop";
import { act } from "../test/act";
import { Backdrop, type MasterMeter } from "./Backdrop";

const tints = [{ tint: "#4f7fd8", gain: 1 }];

function fakeProgram() {
  const program = {
    resize: vi.fn<BackdropProgram["resize"]>(),
    render: vi.fn<BackdropProgram["render"]>(),
    dispose: vi.fn<BackdropProgram["dispose"]>(),
  };
  return { program, create: vi.fn<(canvas: HTMLCanvasElement) => BackdropProgram>(() => program) };
}

function fakeMeter() {
  const stop = vi.fn<() => void>();
  const meter = {
    watch: vi.fn<MasterMeter["watch"]>(() => stop),
    get: vi.fn<MasterMeter["get"]>(() => 0.1),
  };
  return { meter, stop };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Backdrop", () => {
  it("falls back to a static CSS gradient of the tints when WebGL2 is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(
      <Backdrop mode="glow" brightness={50} respond tints={tints} playing />,
    );
    const backdrop = container.querySelector<HTMLElement>(".backdrop");
    expect(backdrop?.tagName).toBe("DIV");
    expect(backdrop?.dataset.backdrop).toBe("static");
    const background = backdrop?.style.getPropertyValue("--backdrop") ?? "";
    expect(background).toContain("radial-gradient");
    // Engine core's tint at the default brightness.
    expect(background).toContain("rgb(24 38 65 / 1.00)");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("shows a plain background and makes no program when off", () => {
    const { program, create } = fakeProgram();
    const { meter } = fakeMeter();
    const { container } = render(
      <Backdrop
        mode="off"
        brightness={50}
        respond
        tints={tints}
        playing
        level={meter}
        createProgram={create}
      />,
    );
    expect(container.querySelector<HTMLElement>(".backdrop")?.dataset.backdrop).toBe("off");
    expect(create).not.toHaveBeenCalled();
    expect(program.render).not.toHaveBeenCalled();
    expect(meter.watch).not.toHaveBeenCalled();
  });

  it("draws on a canvas, and disposes the program when turned off", () => {
    const { program, create } = fakeProgram();
    const props = { brightness: 50, respond: true, tints, playing: true, createProgram: create };
    const { container, rerender } = render(<Backdrop mode="glow" {...props} />);
    expect(container.querySelector("canvas.backdrop")).not.toBeNull();
    expect(create).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(program.render).toHaveBeenCalled();
    rerender(<Backdrop mode="off" {...props} />);
    expect(program.dispose).toHaveBeenCalledOnce();
  });

  it("watches the master level only while playing with the response on", () => {
    const { create } = fakeProgram();
    const { meter, stop } = fakeMeter();
    const props = {
      mode: "glow",
      brightness: 50,
      tints,
      level: meter,
      createProgram: create,
    } as const;
    const { rerender } = render(<Backdrop {...props} respond playing={false} />);
    expect(meter.watch).not.toHaveBeenCalled();
    rerender(<Backdrop {...props} respond playing />);
    expect(meter.watch).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(meter.get).toHaveBeenCalled();
    rerender(<Backdrop {...props} respond={false} playing />);
    expect(stop).toHaveBeenCalledOnce();
    rerender(<Backdrop {...props} respond playing />);
    expect(meter.watch).toHaveBeenCalledTimes(2);
    rerender(<Backdrop {...props} mode="off" respond playing />);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("doesn't watch the level with reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query.includes("reduced-motion"),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const { create } = fakeProgram();
    const { meter } = fakeMeter();
    render(
      <Backdrop
        mode="glow"
        brightness={50}
        respond
        tints={tints}
        playing
        level={meter}
        createProgram={create}
      />,
    );
    expect(meter.watch).not.toHaveBeenCalled();
  });
});
