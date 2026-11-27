import { describe, expect, it } from "vitest";
import { MODAL_MAX_RATIO, ModalBank } from "./modal";

const SR = 48000;

/** Renders `seconds` of `bank` in 128-sample quanta. */
function renderBank(bank: ModalBank, seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i += 128) {
    bank.render(out, i, Math.min(out.length, i + 128));
  }
  return out;
}

/** The largest magnitude in `a` from sample `from`, over `length` samples. */
const peakIn = (a: Float32Array, from: number, length: number) => {
  let peak = 0;
  for (let i = from; i < Math.min(a.length, from + length); i++) {
    peak = Math.max(peak, Math.abs(a[i] ?? 0));
  }
  return peak;
};

describe("ModalBank", () => {
  it.each([
    [440, 1],
    [2200, 0.4],
    [6000, 0.25],
    [130, 30],
  ])("a %d Hz mode falls 60 dB over its decay of %d s, within 5 %%", (frequency, decay) => {
    const bank = new ModalBank(SR, 1);
    bank.setMode(0, frequency, decay, 1);
    bank.strike(1);
    const out = renderBank(bank, decay * 1.2);
    const period = Math.ceil(SR / frequency) + 1;
    const start = peakIn(out, 0, period);
    // The time the ring's envelope reaches −60 dB, from its peaks a period at a time.
    let reached = out.length;
    for (let i = 0; i + period <= out.length; i += period) {
      if (peakIn(out, i, period) < start / 1000) {
        reached = i;
        break;
      }
    }
    expect(Math.abs(reached / SR - decay)).toBeLessThan(0.05 * decay);
  });

  it("rings at the mode's amplitude after a unit strike", () => {
    const bank = new ModalBank(SR, 1);
    bank.setMode(0, 1000, 5, 0.3);
    bank.strike(1);
    expect(peakIn(renderBank(bank, 0.01), 0, 480)).toBeCloseTo(0.3, 2);
  });

  it("picks up a strike part-way through exactly as if rendered from the start", () => {
    const whole = new ModalBank(SR, 2);
    const late = new ModalBank(SR, 2);
    for (const bank of [whole, late]) {
      bank.setMode(0, 1800, 0.5, 1);
      bank.setMode(1, 4200, 0.3, 0.5);
    }
    whole.strike(0.7);
    const full = renderBank(whole, 0.5);
    const skip = 9001;
    late.strike(0.7, skip);
    const tail = renderBank(late, 0.5 - skip / SR);
    let worst = 0;
    for (let i = 0; i < tail.length; i++) {
      worst = Math.max(worst, Math.abs((tail[i] ?? 0) - (full[skip + i] ?? 0)));
    }
    // Equal but for float rounding and where each stops a mode at −90 dB, which
    // falls on its own render quantum.
    expect(worst).toBeLessThan(1e-4);
  });

  it("adds a second strike to the ring already sounding", () => {
    const once = new ModalBank(SR, 1);
    const twice = new ModalBank(SR, 1);
    for (const bank of [once, twice]) {
      bank.setMode(0, 1000, 2, 1);
    }
    once.strike(1);
    twice.strike(1);
    twice.strike(1);
    const a = renderBank(once, 0.01);
    const b = renderBank(twice, 0.01);
    expect(peakIn(b, 0, 480) / peakIn(a, 0, 480)).toBeCloseTo(2, 3);
  });

  it("driven by an impulse through tick, rings as a strike does", () => {
    const struck = new ModalBank(SR, 1);
    const driven = new ModalBank(SR, 1);
    for (const bank of [struck, driven]) {
      bank.setMode(0, 900, 1, 0.8);
    }
    struck.strike(1);
    const a = renderBank(struck, 0.05);
    for (let i = 0; i < a.length; i++) {
      expect(driven.tick(i === 0 ? 1 : 0)).toBeCloseTo(a[i] ?? 0, 6);
    }
  });

  it("goes quiet and stops ringing once below −90 dB", () => {
    const bank = new ModalBank(SR, 2);
    bank.setMode(0, 1000, 0.1, 1);
    bank.setMode(1, 3000, 0.05, 1);
    bank.strike(1);
    expect(bank.ringing).toBe(true);
    renderBank(bank, 0.2);
    expect(bank.ringing).toBe(false);
    expect(bank.level).toBe(0);
    const out = renderBank(bank, 0.01);
    expect(peakIn(out, 0, out.length)).toBe(0);
  });

  it("drops modes at or above the cutoff ratio, and has none ringing until struck", () => {
    const bank = new ModalBank(SR, 2);
    bank.setMode(0, MODAL_MAX_RATIO * SR + 1, 1, 1);
    expect(bank.ringing).toBe(false);
    bank.strike(1);
    expect(bank.ringing).toBe(false);
    bank.setMode(1, 1000, 1, 1);
    bank.strike(1);
    expect(bank.ringing).toBe(true);
  });

  it.each([8000, 22050, 44100, 48000, 96000])(
    "makes no NaN and stays bounded at %d Hz, whatever the modes",
    (sampleRate) => {
      const bank = new ModalBank(sampleRate, 6);
      bank.setMode(0, 20000, 0.5, 1);
      bank.setMode(1, 5000, 0, 1);
      bank.setMode(2, 0, 1, 1);
      bank.setMode(3, -100, 1, 1);
      bank.setMode(4, 100, 60, 1);
      bank.setMode(5, 3000, 2, Number.NaN);
      bank.strike(1, 1e9);
      bank.strike(1);
      const out = renderBank(bank, 0.5, sampleRate);
      for (const x of out) {
        expect(Number.isFinite(x)).toBe(true);
      }
      expect(peakIn(out, 0, out.length)).toBeLessThan(6);
    },
  );
});
