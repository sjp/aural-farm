import { describe, expect, it } from "vitest";
import { BUBBLE_ATTACK, BUBBLE_LIFE, BubbleVoice, minnaertFrequency } from "./bubble";

const SR = 48000;

/** Every sample of one ring, and the frequency each was played at. */
function ring(...args: Parameters<BubbleVoice["start"]>) {
  const voice = new BubbleVoice(SR);
  voice.start(...args);
  const samples: number[] = [];
  const frequencies: number[] = [];
  while (voice.active && samples.length < SR) {
    frequencies.push(voice.frequency);
    samples.push(voice.next());
  }
  return { voice, samples, frequencies };
}

describe("minnaertFrequency", () => {
  it("is about 3.26 kHz for a 1 mm bubble, falling as the bubble grows", () => {
    expect(minnaertFrequency(0.001)).toBeCloseTo(3260);
    expect(minnaertFrequency(0.003)).toBeCloseTo(1086.7, 1);
  });
});

describe("BubbleVoice", () => {
  it("starts from 0 and rises over the raised-cosine attack without overshooting", () => {
    const { samples } = ring(1, 2000, 0, 0.005);
    expect(samples[0]).toBe(0);
    const peak = Math.max(...samples.map((v) => Math.abs(v)));
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.5);
    // The attack's first quarter is far quieter than a plain decaying sine there.
    const early = Math.max(
      ...samples.slice(0, Math.round(BUBBLE_ATTACK * SR * 0.25)).map((v) => Math.abs(v)),
    );
    expect(early).toBeLessThan(0.15);
  });

  it.each([0.002, 0.005, 0.008])(
    "ends once it has decayed to −60 dB, ln(1000) time constants in (τ = %f s)",
    (decay) => {
      const { samples, voice } = ring(1, 1500, 0, decay);
      expect(voice.active).toBe(false);
      expect(voice.level).toBe(0);
      expect(samples.length).toBe(Math.ceil(decay * BUBBLE_LIFE * SR));
      // Its last few samples are at −60 dB.
      const tail = samples.slice(-6);
      expect(Math.max(...tail.map((v) => Math.abs(v)))).toBeLessThan(10 ** (-59 / 20));
    },
  );

  it("decays exponentially with time constant `decay`", () => {
    const decay = 0.004;
    const voice = new BubbleVoice(SR);
    voice.start(1, 1000, 0, decay);
    const n = Math.round(decay * SR);
    for (let i = 0; i < n; i++) {
      voice.next();
    }
    expect(voice.level).toBeCloseTo(Math.exp(-1), 3);
  });

  it("glides its frequency upwards, never past the ceiling", () => {
    const { frequencies } = ring(1, 3800, 60, 0.004, 4500);
    expect(frequencies[0]).toBeCloseTo(3800);
    for (let i = 1; i < frequencies.length; i++) {
      expect(frequencies[i]).toBeGreaterThanOrEqual(frequencies[i - 1] ?? 0);
      expect(frequencies[i]).toBeLessThanOrEqual(4500 + 1e-9);
    }
    expect(frequencies.at(-1)).toBeCloseTo(4500);
  });

  it("rises by `sweep` × its frequency per second", () => {
    const { frequencies } = ring(1, 2000, 50, 0.008);
    const t = (frequencies.length - 1) / SR;
    expect(frequencies.at(-1)).toBeCloseTo(2000 * (1 + 50 * t), 3);
  });

  it("plays at its frequency: zero crossings match it", () => {
    const { samples } = ring(1, 2400, 0, 0.008);
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1] ?? 0) < 0 && (samples[i] ?? 0) >= 0) {
        crossings++;
      }
    }
    expect(crossings / (samples.length / SR)).toBeGreaterThan(2350);
    expect(crossings / (samples.length / SR)).toBeLessThan(2450);
  });

  it("is deterministic and finite", () => {
    const a = ring(0.3, 4000, 40, 0.002).samples;
    const b = ring(0.3, 4000, 40, 0.002).samples;
    expect(a).toEqual(b);
    expect(a.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("is silent once stopped, and before it starts", () => {
    const voice = new BubbleVoice(SR);
    expect(voice.next()).toBe(0);
    voice.start(1, 1000, 0, 0.004);
    voice.next();
    voice.stop();
    expect(voice.active).toBe(false);
    expect(voice.next()).toBe(0);
  });
});
