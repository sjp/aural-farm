import { describe, expect, it } from "vitest";
import { chooseOutputRoute, type OutputFeatures, type OutputPreference } from "./output";

const PHONE: OutputFeatures = {
  mediaStreamDestination: true,
  mediaSession: true,
  coarsePointer: true,
};
const DESKTOP: OutputFeatures = { ...PHONE, coarsePointer: false };
const OLD_PHONE: OutputFeatures = { ...PHONE, mediaSession: false };
const NO_STREAMS: OutputFeatures = { ...PHONE, mediaStreamDestination: false };

describe("chooseOutputRoute", () => {
  it.each<[string, OutputPreference, OutputFeatures, string]>([
    ["a phone with Media Session", "auto", PHONE, "media"],
    ["a desktop browser", "auto", DESKTOP, "direct"],
    ["a touch device without Media Session", "auto", OLD_PHONE, "direct"],
    ["a browser without media stream destinations", "auto", NO_STREAMS, "direct"],
    ["Direct on a phone", "direct", PHONE, "direct"],
    ["Media element on a desktop browser", "media", DESKTOP, "media"],
    ["Media element without Media Session", "media", OLD_PHONE, "media"],
    ["Media element without media stream destinations", "media", NO_STREAMS, "direct"],
  ])("%s: %s gives %s", (_case, preference, features, expected) => {
    expect(chooseOutputRoute(preference, features)).toBe(expected);
  });
});
