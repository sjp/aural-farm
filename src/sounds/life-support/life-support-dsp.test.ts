import { describe, expect, it } from "vitest";
import { createEventBlock, eventsInBlock } from "../../audio/dsp/events";
import {
  AIR_DB,
  airInBand,
  BED_LEFT,
  BED_RIGHT,
  FLOW_FLOOR_DB,
  flowGain,
  HISS,
  HUM,
  HUM_LEVELS_DB,
  HUM_THIRD_DB,
  HUM_UNDER_AIR_DB,
  humGain,
  humWave,
  LIFE_SUPPORT_CHANNELS,
  LifeSupportKernel,
  LONGEST_CYCLE,
  MOTOR,
  MOTOR_HARMONICS,
  MOTOR_STEP_DB,
  motorGain,
  motorRolloff,
  motorWave,
  PUMP_DRIFT,
  PUMP_FALL,
  PUMP_HOLD,
  PUMP_RISE,
  PUMP_TERMS,
  pumpIntegralWave,
  pumpSeries,
  pumpShape,
  pumpShare,
  pumpWave,
  readLifeSupportOptions,
  SIGH,
  SPIN_UP_CENTS,
  spinUp,
  SURGE,
  SURGE_RMS,
  VALVE_ATTACK,
  VALVE_KINDS,
  VALVE_LONGEST,
  VALVE_OVER_AIR_DB,
  VALVE_PAN,
  VALVE_RATES,
  VALVE_RELEASE,
  VALVE_SHORTEST,
  VALVE_SPREAD_DB,
  VALVE_STREAM,
  valveCentre,
  valveEnvelope,
  valveLength,
  valveSpec,
  VALVES_LEFT,
  VALVES_RIGHT,
  waveMagnitude,
  waveValue,
} from "./life-support-dsp";

const SR = 48000;
const QUANTUM = 128;
const STEPS = 4096;

const db = (x: number) => 20 * Math.log10(x);
const seconds = (s: number, sampleRate = SR) => Math.round(s * sampleRate);

interface Settings {
  seed?: number;
  flow?: number;
  rate?: number;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  flow = 60,
  rate = VALVE_RATES.rarely,
  sampleRate = SR,
}: Settings = {}) {
  const k = new LifeSupportKernel(seed, sampleRate);
  k.set(flow, rate);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: LifeSupportKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: LIFE_SUPPORT_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: LIFE_SUPPORT_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    k.render(quantum, n);
    quantum.forEach((b, c) => {
      out[c]?.set(b.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return out;
}

const rms = (x: Float32Array, from = 0) => {
  let sum = 0;
  for (let i = from; i < x.length; i++) {
    sum += (x[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / (x.length - from));
};

const peakOf = (x: Float32Array) => x.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);

/** The first second-long block at or after `from` with a valve in it, at `rate`. */
function firstValveBlock(seed: number, rate: number, from = 0): number {
  const block = createEventBlock(8);
  for (let b = from; b < from + 100000; b++) {
    if (eventsInBlock(seed, VALVE_STREAM, b, rate, block) > 0) {
      return b;
    }
  }
  throw new Error("no valve");
}

describe("pump cycle", () => {
  const wave = pumpWave();
  const at = (phase: number) => waveValue(wave, phase) + wave.offset;

  it(`has ${String(PUMP_TERMS)} Fourier terms and spans exactly 0..1 with its offset`, () => {
    expect(wave.real).toHaveLength(PUMP_TERMS + 1);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let m = 0; m < STEPS; m++) {
      min = Math.min(min, at(m / STEPS));
      max = Math.max(max, at(m / STEPS));
    }
    expect(min).toBeCloseTo(0, 3);
    expect(max).toBeCloseTo(1, 3);
  });

  it("overshoots the ideal 0..1 by under 2 % before normalising", () => {
    const series = pumpSeries();
    for (let m = 0; m < STEPS; m++) {
      const v = waveValue(series, m / STEPS) + series.mean;
      expect(v).toBeGreaterThan(-0.02);
      expect(v).toBeLessThan(1.02);
    }
  });

  it("has a mean equal to its offset, so the wave has no DC", () => {
    let mean = 0;
    for (let m = 0; m < STEPS; m++) {
      mean += pumpShape(m / STEPS) / STEPS;
    }
    expect(wave.offset).toBeCloseTo(mean, 2);
  });

  /** Where the wave crosses `level` going up and coming down, in cycles. */
  function crossings(level: number): { up: number; down: number } {
    let up = Number.NaN;
    let down = Number.NaN;
    for (let m = 1; m < STEPS; m++) {
      const a = at((m - 1) / STEPS);
      const b = at(m / STEPS);
      if (a < level && b >= level) {
        up = m / STEPS;
      }
      if (a > level && b <= level) {
        down = m / STEPS;
      }
    }
    return { up, down };
  }

  it("rises for 25 %, holds for 20 %, falls for 35 % and rests for 20 %, within 3 %", () => {
    // Each stage measured from where the wave leaves one level to where it reaches the next,
    // scaled by the ideal shape's share between the same levels.
    const low = 0.1;
    const high = 0.9;
    const inner = 1 - (2 * Math.acos(1 - 2 * low)) / Math.PI;
    const a = crossings(low);
    const b = crossings(high);
    const rise = (b.up - a.up) / inner;
    const fall = (a.down - b.down) / inner;
    const hold = b.down - b.up - (1 - inner) * (rise + fall) * 0.5;
    const rest = 1 - rise - hold - fall;
    expect(Math.abs(rise - PUMP_RISE)).toBeLessThan(0.03);
    expect(Math.abs(hold - PUMP_HOLD)).toBeLessThan(0.03);
    expect(Math.abs(fall - PUMP_FALL)).toBeLessThan(0.03);
    expect(Math.abs(rest - (1 - PUMP_RISE - PUMP_HOLD - PUMP_FALL))).toBeLessThan(0.03);
  });

  it("stays within 2 % of the ideal shape everywhere", () => {
    for (let m = 0; m < STEPS; m++) {
      expect(Math.abs(at(m / STEPS) - pumpShape(m / STEPS))).toBeLessThan(0.02);
    }
  });

  it("has an integral whose slope is the wave", () => {
    const integral = pumpIntegralWave();
    const h = 1e-5;
    for (let m = 0; m < 64; m++) {
      const phase = m / 64;
      const slope = (waveValue(integral, phase + h) - waveValue(integral, phase - h)) / (2 * h);
      expect(slope).toBeCloseTo(waveValue(wave, phase), 5);
    }
  });
});

describe("motor spin-up", () => {
  const spin = spinUp();
  const integral = pumpIntegralWave();
  const wave = pumpWave();

  it.each([15, 28, LONGEST_CYCLE])("keeps the delay inside its line at a %i s cycle", (cycle) => {
    const swing = Math.abs(spin.depth(cycle)) * waveMagnitude(integral);
    expect(spin.base - swing).toBeGreaterThan(0);
    expect(spin.base + swing).toBeLessThan(spin.longest);
  });

  it.each([15, 28, LONGEST_CYCLE])(
    "rests at the motor's pitch and peaks 60 cents up at a %i s cycle",
    (cycle) => {
      // The pitch heard is the oscillator's, scaled by 1 − the delay's rate of change.
      const pitchAt = (phase: number) => {
        const h = 1e-6;
        const rate =
          (spin.depth(cycle) * (waveValue(integral, phase + h) - waveValue(integral, phase - h))) /
          (2 * h * cycle);
        return spin.frequency * (1 - rate);
      };
      let low = Number.POSITIVE_INFINITY;
      let high = 0;
      for (let m = 0; m < 512; m++) {
        low = Math.min(low, pitchAt(m / 512));
        high = Math.max(high, pitchAt(m / 512));
      }
      expect(low).toBeCloseTo(MOTOR, 1);
      expect(1200 * Math.log2(high / low)).toBeCloseTo(SPIN_UP_CENTS, 0);
      // The pitch follows the cycle: highest where the cycle is.
      expect(waveValue(wave, 0.35) + wave.offset).toBeGreaterThan(0.98);
      expect(Math.abs(1200 * Math.log2(pitchAt(0.35) / MOTOR) - SPIN_UP_CENTS)).toBeLessThan(2);
    },
  );
});

describe("motor and hum", () => {
  it("gives the motor harmonics 1–6, each 5 dB under the last before its low-pass", () => {
    const { real, imag } = motorWave();
    expect(imag).toHaveLength(MOTOR_HARMONICS + 1);
    expect(real.every((r) => r === 0)).toBe(true);
    for (let k = 1; k <= MOTOR_HARMONICS; k++) {
      expect((imag[k] ?? 0) / motorRolloff(MOTOR * k)).toBeCloseTo(
        10 ** ((MOTOR_STEP_DB * (k - 1)) / 20),
        10,
      );
    }
    // Its upper harmonics still carry on small speakers.
    expect(db((imag[4] ?? 0) / (imag[1] ?? 1))).toBeGreaterThan(-25);
  });

  it("sets the motor 3 dB under the surge at Pump 100 and the cycle's peak", () => {
    const { imag } = motorWave();
    const rmsOf = Math.sqrt(imag.reduce((sum, a) => sum + (a * a) / 2, 0));
    expect(db(motorGain() * rmsOf)).toBeCloseTo(db(SURGE_RMS) - 3, 6);
  });

  it("gives the hum harmonics of 100 Hz at 0, −8, −14 and −20 dB plus a 300 Hz sine", () => {
    const { imag } = humWave();
    expect(HUM).toBe(100);
    HUM_LEVELS_DB.forEach((level, k) => {
      const extra = k === 2 ? 10 ** (HUM_THIRD_DB / 20) : 0;
      expect(imag[k + 1]).toBeCloseTo(10 ** (level / 20) + extra, 10);
    });
  });

  it("is off at Hum 0 and 26 dB under the air's full level at 100", () => {
    const { imag } = humWave();
    const rmsOf = Math.sqrt(imag.reduce((sum, a) => sum + (a * a) / 2, 0));
    expect(humGain(0)).toBe(0);
    expect(db(humGain(100) * rmsOf)).toBeCloseTo(AIR_DB + HUM_UNDER_AIR_DB, 6);
  });
});

describe("param mappings", () => {
  it("keeps the air 14 dB down at Air flow 0, never silent", () => {
    expect(flowGain(100)).toBe(1);
    expect(db(flowGain(0))).toBeCloseTo(FLOW_FLOOR_DB, 9);
    expect(db(flowGain(50))).toBeCloseTo(FLOW_FLOOR_DB / 2, 9);
  });

  it("brings the pump in on a squared curve, none at 0", () => {
    expect(pumpShare(0)).toBe(0);
    expect(pumpShare(100)).toBe(1);
    expect(pumpShare(50)).toBeCloseTo(0.25, 9);
  });

  it("releases valves rarely, sometimes or often, or never", () => {
    expect(VALVE_RATES.off).toBe(0);
    expect(1 / VALVE_RATES.rarely).toBe(300);
    expect(1 / VALVE_RATES.sometimes).toBe(90);
    expect(1 / VALVE_RATES.often).toBe(40);
  });
});

describe("valves", () => {
  const HASHES = [1, 2, 3, 0xdeadbeef, 0x12345678, 99999, 424242, 7];

  it.each(HASHES)("hash %i gives a hiss or a sigh of 0.8–2.5 s, placed and levelled", (hash) => {
    const spec = valveSpec(hash);
    expect([HISS, SIGH]).toContain(spec.kind);
    const stretch = VALVE_KINDS[spec.kind].stretch;
    expect(spec.hold).toBeGreaterThanOrEqual(VALVE_SHORTEST * stretch);
    expect(spec.hold).toBeLessThanOrEqual(VALVE_LONGEST * stretch);
    expect(Math.abs(spec.pan)).toBeLessThanOrEqual(VALVE_PAN);
    expect(Math.abs(spec.levelDb)).toBeLessThanOrEqual(VALVE_SPREAD_DB);
  });

  it("hisses about 70 % of the time", () => {
    let hisses = 0;
    for (let h = 0; h < 2000; h++) {
      hisses += valveSpec(h * 7919 + 13).kind === HISS ? 1 : 0;
    }
    expect(hisses / 2000).toBeGreaterThan(0.65);
    expect(hisses / 2000).toBeLessThan(0.75);
  });

  it("eases in over no less than 200 ms, holds, and fades over a second", () => {
    expect(VALVE_ATTACK).toBeGreaterThanOrEqual(0.2);
    expect(valveEnvelope(0, 1)).toBe(0);
    expect(valveEnvelope(0.2, 1)).toBeLessThan(1);
    // Gently: a raised cosine, barely moving in its first 50 ms.
    expect(valveEnvelope(0.05, 1)).toBeLessThan(0.1);
    expect(valveEnvelope(VALVE_ATTACK + 0.5, 1)).toBe(1);
    expect(valveEnvelope(VALVE_ATTACK + 1 + VALVE_RELEASE / 2, 1)).toBeCloseTo(0.5, 9);
    expect(valveEnvelope(valveLength(1), 1)).toBe(0);
    let last = 0;
    for (let t = 0; t <= VALVE_ATTACK; t += 0.001) {
      const v = valveEnvelope(t, 1);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it("glides a hiss from 4.5 kHz to 2.2 kHz and a sigh from 1.4 kHz to 600 Hz", () => {
    expect(valveCentre(HISS, 0, 1)).toBeCloseTo(4500, 6);
    expect(valveCentre(HISS, valveLength(1), 1)).toBeCloseTo(2200, 6);
    expect(valveCentre(SIGH, 0, 1)).toBeCloseTo(1400, 6);
    expect(valveCentre(SIGH, valveLength(1), 1)).toBeCloseTo(600, 6);
  });

  it("sits no more than 4 dB above the air in its own band", () => {
    expect(VALVE_OVER_AIR_DB + VALVE_SPREAD_DB).toBeLessThanOrEqual(4);
    // The air thins out above its low-pass, so a hiss starts quieter than it ends.
    expect(airInBand(HISS, 4500, SR)).toBeLessThan(airInBand(HISS, 2200, SR));
  });

  it.each([1, 2, 3, 42, 999])("seed %i is silent with valves off", (seed) => {
    const k = kernel({ seed, rate: VALVE_RATES.off });
    const out = render(k, 0, seconds(20));
    expect(peakOf(out[VALVES_LEFT] ?? new Float32Array())).toBe(0);
    expect(peakOf(out[VALVES_RIGHT] ?? new Float32Array())).toBe(0);
  });

  it.each([1, 2, 3, 42, 999])("seed %i keeps a valve's peak bounded at Often", (seed) => {
    const block = firstValveBlock(seed, VALVE_RATES.often);
    const k = kernel({ seed, flow: 100, rate: VALVE_RATES.often });
    const out = render(k, seconds(block - 0.5), seconds(block + 5));
    const left = out[VALVES_LEFT] ?? new Float32Array();
    const right = out[VALVES_RIGHT] ?? new Float32Array();
    const peak = Math.max(peakOf(left), peakOf(right));
    expect(peak).toBeGreaterThan(0);
    expect(db(peak)).toBeLessThan(-12);
    for (const channel of out) {
      expect(channel.every((v) => Number.isFinite(v))).toBe(true);
    }
    // It eases in: nothing much in its first 50 ms.
    const onset = left.findIndex((v, i) => v !== 0 || right[i] !== 0);
    const early = Math.max(
      peakOf(left.subarray(onset, onset + seconds(0.05))),
      peakOf(right.subarray(onset, onset + seconds(0.05))),
    );
    expect(early).toBeLessThan(peak * 0.2);
  });
});

describe("kernel", () => {
  it("is the same for the same seed and differs for another", () => {
    const a = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const b = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const c = render(kernel({ seed: 5 }), 0, seconds(0.5));
    expect(a).toEqual(b);
    expect(a[BED_LEFT]).not.toEqual(c[BED_LEFT]);
    expect(a[SURGE]).not.toEqual(c[SURGE]);
  });

  it("is time-addressable: seconds 100–110 rendered afresh match the tail of 0–110", () => {
    // Valves far more often than any setting, so some sound in the window.
    const settings = { seed: 3, rate: 0.5 };
    const whole = render(kernel(settings), 0, seconds(110));
    const later = render(kernel(settings), seconds(100), seconds(110));
    const settle = seconds(0.5);
    for (let channel = 0; channel < LIFE_SUPPORT_CHANNELS; channel++) {
      const a = whole[channel]?.subarray(seconds(100) + settle) ?? new Float32Array();
      const b = later[channel]?.subarray(settle) ?? new Float32Array();
      const difference = a.map((v, i) => v - (b[i] ?? 0));
      expect(rms(a)).toBeGreaterThan(0);
      expect(db(rms(difference) / rms(a))).toBeLessThan(-60);
    }
  });

  it.each([SR, 44100])("sets the air and the surge's levels at %i Hz", (sampleRate) => {
    const out = render(kernel({ flow: 100, rate: 0, sampleRate }), 0, seconds(20, sampleRate));
    const from = seconds(0.5, sampleRate);
    // The air's level drifts by a decibel either way.
    expect(Math.abs(db(rms(out[BED_LEFT] ?? new Float32Array(), from)) - AIR_DB)).toBeLessThan(1.5);
    expect(Math.abs(db(rms(out[BED_RIGHT] ?? new Float32Array(), from)) - AIR_DB)).toBeLessThan(
      1.5,
    );
    expect(Math.abs(db(rms(out[SURGE] ?? new Float32Array(), from) / SURGE_RMS))).toBeLessThan(
      0.75,
    );
  });

  it("decorrelates the air's sides", () => {
    const [left = new Float32Array(), right = new Float32Array()] = render(
      kernel({ rate: 0 }),
      0,
      seconds(4),
    );
    let lr = 0;
    for (let i = 0; i < left.length; i++) {
      lr += (left[i] ?? 0) * (right[i] ?? 0);
    }
    expect(Math.abs(lr / (rms(left) * rms(right) * left.length))).toBeLessThan(0.1);
  });

  it("keeps the bed well under full scale at Air flow 100", () => {
    const out = render(kernel({ flow: 100, rate: 0 }), 0, seconds(20));
    expect(db(peakOf(out[BED_LEFT] ?? new Float32Array()))).toBeLessThan(-6);
    expect(db(peakOf(out[SURGE] ?? new Float32Array()))).toBeLessThan(-12);
  });

  it("keeps the pump's drift within ±1 and moving slowly", () => {
    const out = render(kernel(), 0, seconds(30));
    const drift = out[PUMP_DRIFT] ?? new Float32Array();
    expect(peakOf(drift)).toBeLessThanOrEqual(1);
    let step = 0;
    for (let i = 1; i < drift.length; i++) {
      step = Math.max(step, Math.abs((drift[i] ?? 0) - (drift[i - 1] ?? 0)));
    }
    expect(step).toBeLessThan(1e-5);
  });
});

describe("readLifeSupportOptions", () => {
  it("reads processor options, falling back to safe defaults", () => {
    expect(readLifeSupportOptions({ seed: 7.8, offset: 12.5 })).toEqual({ seed: 7, offset: 12.5 });
    expect(readLifeSupportOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readLifeSupportOptions({ seed: "x", offset: Number.NaN })).toEqual({
      seed: 0,
      offset: 0,
    });
  });
});
