import { describe, expect, it } from "vitest";
import { createPreferences } from "../lib/preferences";
import { backdropLabel, loadDisplay, nextBackdrop, saveDisplay } from "./settings";

describe("display settings", () => {
  it("defaults to a Glow at brightness 50 that responds to sound, with the screen and output left alone", () => {
    expect(loadDisplay(createPreferences(() => undefined))).toEqual({
      backdrop: "glow",
      brightness: 50,
      respond: true,
      keepAwake: false,
      audioOutput: "auto",
    });
  });

  it("round-trips through the preferences", () => {
    const preferences = createPreferences(() => undefined);
    const settings = {
      backdrop: "night",
      brightness: 12,
      respond: false,
      keepAwake: true,
      audioOutput: "media",
    } as const;
    saveDisplay(preferences, settings);
    expect(preferences.get("display.backdrop")).toBe("night");
    expect(preferences.get("display.audioOutput")).toBe("media");
    expect(loadDisplay(preferences)).toEqual(settings);
  });

  it("reads unreadable values as their defaults", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("display.backdrop", "disco");
    preferences.set("display.brightness", "250");
    preferences.set("display.respond", "maybe");
    preferences.set("display.keepAwake", "maybe");
    preferences.set("display.audioOutput", "speakers");
    expect(loadDisplay(preferences)).toEqual({
      backdrop: "glow",
      brightness: 100,
      respond: true,
      keepAwake: false,
      audioOutput: "auto",
    });
  });

  it("cycles Glow → Night → Off → Glow", () => {
    expect(nextBackdrop("glow")).toBe("night");
    expect(nextBackdrop("night")).toBe("off");
    expect(nextBackdrop("off")).toBe("glow");
    expect(backdropLabel("night")).toBe("Night");
  });
});
