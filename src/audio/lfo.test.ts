import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, installFakeAudioGlobals } from "../test/fake-audio";
import {
  createLfo,
  fourierWave,
  pulseWave,
  rotateWave,
  setLfoFrequency,
  SINE_WAVE,
  waveAt,
  type Wave,
} from "./lfo";
import { withAudioScope } from "./scope";

const ODD: Wave = { real: [0, 0.3, -0.2, 0.1], imag: [0, 1, 0.5, -0.25] };

describe("rotateWave", () => {
  it.each([0, 0.1, 0.25, 0.5, 0.77, 3.4, -0.3])("starts the wave %d cycles in", (phase) => {
    const rotated = rotateWave(ODD, phase);
    for (let i = 0; i < 50; i++) {
      const p = i / 50;
      expect(waveAt(rotated, p)).toBeCloseTo(waveAt(ODD, p + phase), 12);
    }
  });
});

describe("pulseWave", () => {
  it("spans 0..1 with its offset, peaking at the end of the rise", () => {
    const wave = pulseWave(0.35, 6);
    expect(wave.real).toHaveLength(7);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let peakAt = 0;
    for (let i = 0; i < 1000; i++) {
      const v = waveAt(wave, i / 1000) + wave.offset;
      min = Math.min(min, v);
      if (v > max) {
        max = v;
        peakAt = i / 1000;
      }
    }
    expect(min).toBeCloseTo(0, 3);
    expect(max).toBeCloseTo(1, 3);
    expect(peakAt).toBeGreaterThan(0.3);
    expect(peakAt).toBeLessThan(0.4);
  });

  it("is asymmetric: it rises faster than it falls", () => {
    const wave = pulseWave(0.35, 6);
    const at = (p: number) => waveAt(wave, p) + wave.offset;
    // Halfway up comes sooner after the trough than halfway down after the peak.
    expect(at(0.175)).toBeGreaterThan(0.3);
    expect(at(0.35 + 0.175)).toBeGreaterThan(at(0.175));
  });
});

describe("fourierWave", () => {
  it("keeps the first harmonics of a shape, spanning 0..1 with its offset", () => {
    // A square wave: its first three terms are the odd harmonics 1 and 3.
    const wave = fourierWave((phase) => (phase < 0.5 ? 1 : 0), 3);
    expect(wave.real).toHaveLength(4);
    expect(Math.abs(wave.imag[2] ?? 1)).toBeLessThan(1e-9);
    expect((wave.imag[3] ?? 0) / (wave.imag[1] ?? 1)).toBeCloseTo(1 / 3, 4);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 1000; i++) {
      const v = waveAt(wave, i / 1000) + wave.offset;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeCloseTo(0, 4);
    expect(max).toBeCloseTo(1, 4);
  });
});

describe("createLfo", () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    uninstall = installFakeAudioGlobals();
  });
  afterEach(() => {
    uninstall();
  });

  it.each([0, 1.3, 10, -5, 12345.6])(
    "aligns the phase at startAt %d to absolute time",
    (startAt) => {
      const ctx = new FakeAudioContext();
      ctx.advance(2);
      const frequency = 0.37;
      const osc = withAudioScope((scope) =>
        createLfo(ctx.asContext(), scope, { frequency, wave: ODD, startAt }),
      ) as unknown as { periodicWave: Wave; frequency: { value: number }; startedAt: number };
      expect(osc.startedAt).toBe(2);
      expect(osc.frequency.value).toBe(frequency);
      // At its start (absolute time startAt) the oscillator is at phase frequency · startAt.
      for (let i = 0; i < 20; i++) {
        const t = i / 20 / frequency;
        expect(waveAt(osc.periodicWave, frequency * t)).toBeCloseTo(
          waveAt(ODD, frequency * (startAt + t)),
          9,
        );
      }
    },
  );

  it("defaults to a sine, is registered with the scope, and glides its frequency", () => {
    const ctx = new FakeAudioContext();
    let dispose: () => void = () => undefined;
    const osc = withAudioScope((scope) => {
      dispose = () => {
        scope.dispose();
      };
      return createLfo(ctx.asContext(), scope, { frequency: 1, startAt: 0 });
    });
    const fake = osc as unknown as { periodicWave: Wave; stoppedAt: number | undefined };
    expect(waveAt(fake.periodicWave, 0.25)).toBeCloseTo(waveAt(SINE_WAVE, 0.25), 12);
    setLfoFrequency(osc, 2, 0);
    ctx.advance(5);
    expect(osc.frequency.value).toBeCloseTo(2, 6);
    dispose();
    expect(fake.stoppedAt).toBeDefined();
  });
});
