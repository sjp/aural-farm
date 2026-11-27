// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { SleepSettings } from "../lib/sleep-timer";
import { SleepTimer, type SleepTimerControls } from "./SleepTimer";

function renderTimer(change: Partial<SleepTimerControls> = {}) {
  const onChoose = vi.fn<SleepTimerControls["onChoose"]>();
  const onSettingsChange = vi.fn<(settings: SleepSettings) => void>();
  const settings: SleepSettings = { lastMinutes: undefined, fadeOut: 300, fadeIn: 3 };
  render(
    <SleepTimer
      minutes={undefined}
      remaining={undefined}
      settings={settings}
      hover
      showTime
      onChoose={onChoose}
      onSettingsChange={onSettingsChange}
      {...change}
    />,
  );
  const button = () => screen.getByRole("button", { name: /^Sleep timer/ });
  const menu = () => {
    const found = document.querySelector<HTMLElement>(".sleep-popover");
    if (!found) {
      throw new Error("No sleep timer menu");
    }
    return found;
  };
  const open = () => {
    fireEvent.click(button());
  };
  /** A button in one of the menu's groups: "Sleep timer", "Fade out over" or "Fade in on Play". */
  const option = (name: string, group = "Sleep timer") =>
    within(within(menu()).getByRole("group", { name: group })).getByRole("button", { name });
  return { onChoose, onSettingsChange, settings, button, menu, open, option };
}

describe("SleepTimer", () => {
  it("opens a menu of lengths from Off to 2 h, and Custom", () => {
    const { button, menu, open } = renderTimer();
    expect(button().title).toBe("Sleep timer (T)");
    expect(menu().hidden).toBe(true);
    open();
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    const lengths = [...menu().querySelectorAll(".sleep-lengths > button")].map(
      (b) => b.textContent,
    );
    expect(lengths).toEqual([
      "Off",
      "15 min",
      "30 min",
      "45 min",
      "1 h",
      "1 h 30",
      "2 h",
      "Custom",
    ]);
  });

  it("marks Off while no timer runs, and focuses the length chosen last", () => {
    const { open, option } = renderTimer({
      settings: { lastMinutes: 45, fadeOut: 300, fadeIn: 3 },
    });
    open();
    expect(option("Off").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(option("45 min"));
  });

  it("chooses a length, closes and returns focus to the clock", () => {
    const { onChoose, open, option, menu, button } = renderTimer();
    open();
    fireEvent.click(option("30 min"));
    expect(onChoose).toHaveBeenCalledWith(30);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it("turns the timer Off", () => {
    const { onChoose, open, option } = renderTimer({ minutes: 30, remaining: 600 });
    open();
    expect(option("30 min").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(option("Off"));
    expect(onChoose).toHaveBeenCalledWith(undefined);
  });

  it("starts a custom length of 1 to 480 minutes", () => {
    const { onChoose, open, option } = renderTimer();
    open();
    fireEvent.click(option("Custom"));
    const input = screen.getByLabelText("Minutes");
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: "481" } });
    fireEvent.click(option("Start"));
    expect(onChoose).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.input(input, { target: { value: "100" } });
    fireEvent.click(option("Start"));
    expect(onChoose).toHaveBeenCalledWith(100);
  });

  it("shows a running custom length on Custom, and offers it again", () => {
    const { open, option } = renderTimer({ minutes: 100, remaining: 3000 });
    open();
    const custom = option("Custom: 1 h 40");
    expect(custom.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(custom);
    fireEvent.click(custom);
    expect(screen.getByLabelText<HTMLInputElement>("Minutes").value).toBe("100");
  });

  it("changes the fade-out and the fade-in without closing", () => {
    const { onSettingsChange, settings, open, option, menu } = renderTimer();
    open();
    expect(option("5 min", "Fade out over").getAttribute("aria-pressed")).toBe("true");
    expect(option("3 s", "Fade in on Play").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(option("15 min", "Fade out over"));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, fadeOut: 900 });
    fireEvent.click(option("Instant", "Fade in on Play"));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, fadeIn: 0.1 });
    expect(menu().hidden).toBe(false);
  });

  it("closes on Escape, back to the clock, and on a press outside", () => {
    const { open, menu, button } = renderTimer();
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
    open();
    fireEvent.pointerDown(document.body);
    expect(menu().hidden).toBe(true);
  });

  it("shows the time left in the button only when asked", () => {
    const { button } = renderTimer({ minutes: 1, remaining: 42 });
    expect(button().getAttribute("aria-label")).toBe("Sleep timer, 0:42 left");
    expect(button().textContent).toBe("0:42");
  });
});
