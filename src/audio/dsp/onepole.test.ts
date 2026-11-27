import { describe, expect, it } from "vitest";
import { OnePoleHighpass, OnePoleLowpass, Smoother } from "./onepole";

const SR = 48000;

function sineGain(filter: { process: (x: number) => number }, frequency: number) {
  let peak = 0;
  for (let i = 0; i < SR; i++) {
    const y = filter.process(Math.sin((2 * Math.PI * frequency * i) / SR));
    if (i > SR / 2) {
      peak = Math.max(peak, Math.abs(y));
    }
  }
  return peak;
}

describe("one-pole filters", () => {
  it("low-pass passes DC and is about −3 dB at the cutoff", () => {
    const lp = new OnePoleLowpass(SR, 500);
    let y = 0;
    for (let i = 0; i < SR; i++) {
      y = lp.process(1);
    }
    expect(y).toBeCloseTo(1, 6);
    expect(sineGain(new OnePoleLowpass(SR, 500), 500)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(sineGain(new OnePoleLowpass(SR, 500), 8000)).toBeLessThan(0.1);
  });

  it("high-pass removes DC and passes highs", () => {
    const hp = new OnePoleHighpass(SR, 100);
    let y = 1;
    for (let i = 0; i < SR; i++) {
      y = hp.process(1);
    }
    expect(Math.abs(y)).toBeLessThan(1e-6);
    expect(sineGain(new OnePoleHighpass(SR, 100), 5000)).toBeCloseTo(1, 1);
    hp.setCutoff(1000);
    expect(sineGain(hp, 100)).toBeLessThan(0.15);
  });
});

describe("Smoother", () => {
  it("glides to the target with the given time constant", () => {
    const s = new Smoother(SR, 0.01, 0);
    s.target = 1;
    let v = 0;
    for (let i = 0; i < 0.01 * SR; i++) {
      v = s.next();
    }
    expect(v).toBeCloseTo(1 - Math.exp(-1), 3);
    s.reset(0.25);
    expect(s.next()).toBe(0.25);
  });

  it("jumps at once with no time constant", () => {
    const s = new Smoother(SR, 0, 0);
    s.target = 3;
    expect(s.next()).toBe(3);
  });
});
