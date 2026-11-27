import { describe, expect, it } from "vitest";
import { Envelope, envelopeAt, expDecayCoef } from "./envelopes";

const SR = 48000;

function render(env: Envelope, samples: number): number[] {
  return Array.from({ length: samples }, () => env.next());
}

describe("expDecayCoef", () => {
  it("falls to 1/e after the time constant, at any sample rate", () => {
    for (const sr of [44100, 48000]) {
      expect(expDecayCoef(0.01, sr) ** (0.01 * sr)).toBeCloseTo(Math.exp(-1), 10);
    }
  });

  it("decays at once for a zero time constant", () => {
    expect(expDecayCoef(0, SR)).toBe(0);
  });
});

describe("Envelope", () => {
  it("rises linearly, holds, then decays exponentially, matching envelopeAt", () => {
    const env = new Envelope(SR);
    env.attackHoldRelease(0.8, 0.002, 0.001, 0.005);
    const samples = render(env, 1000);
    samples.forEach((v, i) => {
      expect(v).toBeCloseTo(envelopeAt(i / SR, 0.8, 0.002, 0.001, 0.005), 9);
    });
    expect(samples[0]).toBe(0);
    expect(Math.max(...samples)).toBeCloseTo(0.8, 12);
  });

  it("ends once it has decayed below its floor", () => {
    const env = new Envelope(SR, -60);
    env.attackDecay(1, 0.001, 0.002);
    expect(env.active).toBe(true);
    const samples = render(env, 2000);
    expect(env.active).toBe(false);
    // −60 dB is 6.9 time constants after the 1 ms attack.
    const last = samples.findLastIndex((v) => v > 0);
    expect(last / SR).toBeCloseTo(0.001 + 0.002 * Math.log(1000), 3);
    expect(env.next()).toBe(0);
  });

  it.each([0, 0.0005, 0.0013, 0.004])(
    "starting %d s in matches the same envelope rendered from its start",
    (elapsed) => {
      const whole = new Envelope(SR);
      whole.attackHoldRelease(0.5, 0.001, 0.0005, 0.003);
      const skip = Math.round(elapsed * SR);
      const all = render(whole, skip + 300);
      const late = new Envelope(SR);
      late.attackHoldRelease(0.5, 0.001, 0.0005, 0.003, elapsed);
      const tail = render(late, 300);
      tail.forEach((v, i) => {
        expect(v).toBeCloseTo(all[skip + i] ?? Number.NaN, 12);
      });
    },
  );

  it("handles zero-length stages", () => {
    const env = new Envelope(SR);
    env.attackDecay(1, 0, 0);
    expect(render(env, 3)).toEqual([1, 0, 0]);
    expect(env.active).toBe(false);
  });

  it("stops at once", () => {
    const env = new Envelope(SR);
    env.attackDecay(1, 0.01, 0.1);
    render(env, 10);
    env.stop();
    expect(env.active).toBe(false);
    expect(env.next()).toBe(0);
  });
});
