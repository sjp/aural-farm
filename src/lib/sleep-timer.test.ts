import { describe, expect, it } from "vitest";
import { createPreferences } from "./preferences";
import {
  countdownDelay,
  CUSTOM_MINUTES,
  FADE_IN_CHOICES,
  FADE_OUT_CHOICES,
  formatCountdown,
  loadSleepSettings,
  nextCycleMinutes,
  saveSleepSettings,
  timerLabel,
  TIMER_MINUTES,
  validMinutes,
  type SleepSettings,
} from "./sleep-timer";

describe("timerLabel", () => {
  it.each([
    [1, "1 min"],
    [15, "15 min"],
    [45, "45 min"],
    [60, "1 h"],
    [90, "1 h 30"],
    [100, "1 h 40"],
    [125, "2 h 05"],
    [480, "8 h"],
  ])("names %s minutes %s", (minutes, label) => {
    expect(timerLabel(minutes)).toBe(label);
  });

  it("names every length the menu offers", () => {
    expect(TIMER_MINUTES.map((minutes) => timerLabel(minutes))).toEqual([
      "15 min",
      "30 min",
      "45 min",
      "1 h",
      "1 h 30",
      "2 h",
    ]);
  });
});

describe("nextCycleMinutes", () => {
  it.each([
    [undefined, 15],
    [15, 30],
    [30, 60],
    [45, 60],
    [60, 90],
    [90, undefined],
    [120, undefined],
    [7, 15],
  ])("goes from %s to %s", (from, to) => {
    expect(nextCycleMinutes(from)).toBe(to);
  });
});

describe("formatCountdown", () => {
  it.each([
    [42 * 60, "42:00"],
    [41 * 60 + 10, "42:00"],
    [61, "2:00"],
    [60, "1:00"],
    [59.2, "1:00"],
    [59, "0:59"],
    [0.4, "0:01"],
    [0, "0:00"],
    [3600, "1:00:00"],
    [3600 + 2 * 60 + 10, "1:03:00"],
    [8 * 3600, "8:00:00"],
  ])("shows %s s as %s", (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });
});

describe("countdownDelay", () => {
  it.each([
    [125, 5020],
    [120, 60_020],
    [61, 1020],
    [60, 1020],
    [30.5, 520],
  ])("waits from %s s left until the text changes (%s ms)", (seconds, ms) => {
    expect(countdownDelay(seconds)).toBeCloseTo(ms);
  });

  it("lands on a different text", () => {
    for (const seconds of [3725, 600, 61, 59.5, 3]) {
      const after = seconds - countdownDelay(seconds) / 1000;
      expect(formatCountdown(after)).not.toBe(formatCountdown(seconds));
    }
  });
});

describe("validMinutes", () => {
  it.each([
    ["1", 1],
    [" 30 ", 30],
    [480, 480],
    ["0", undefined],
    ["481", undefined],
    ["1.5", undefined],
    ["", undefined],
    ["abc", undefined],
    [null, undefined],
  ])("reads %j as %s", (value, minutes) => {
    expect(validMinutes(value)).toBe(minutes);
  });

  it("takes 1 to 8 hours' worth of minutes", () => {
    expect(CUSTOM_MINUTES).toEqual({ min: 1, max: 480 });
  });
});

describe("sleep settings", () => {
  it("defaults to a 5 min fade-out, a 3 s fade-in and no last length", () => {
    expect(loadSleepSettings(createPreferences(() => undefined))).toEqual({
      lastMinutes: undefined,
      fadeOut: 300,
      fadeIn: 3,
    });
  });

  it("keeps what was saved", () => {
    const preferences = createPreferences(() => undefined);
    const settings: SleepSettings = { lastMinutes: 100, fadeOut: 900, fadeIn: 0.1 };
    saveSleepSettings(preferences, settings);
    expect(loadSleepSettings(preferences)).toEqual(settings);
  });

  it("reads anything unknown as its default", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("sleep.lastMinutes", "9999");
    preferences.set("sleep.fadeOut", "7");
    preferences.set("fadeIn", "nope");
    expect(loadSleepSettings(preferences)).toEqual({
      lastMinutes: undefined,
      fadeOut: 300,
      fadeIn: 3,
    });
  });

  it("offers the fade choices in order", () => {
    expect(FADE_OUT_CHOICES.map((c) => c.label)).toEqual(["10 s", "1 min", "5 min", "15 min"]);
    expect(FADE_IN_CHOICES.map((c) => c.label)).toEqual(["Instant", "3 s", "10 s", "30 s"]);
  });
});
