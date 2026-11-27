import { describe, expect, it } from "vitest";
import {
  AIR_DB,
  airShareBelow,
  BLADE_HARMONIC,
  bladePassAt,
  bladeWave,
  CEILING_MOTOR,
  COMPRESSOR,
  FAN_CHANNELS,
  FAN_SPECS,
  FanKernel,
  fanSettings,
  facing,
  guard,
  LOWPASS_LIMIT,
  lowpassAt,
  MOTOR_RATIO,
  MOTOR_UNDER_AIR_DB,
  motorFrequency,
  motorGain,
  motorRolloff,
  motorWave,
  readFanOptions,
  rotationAt,
  SPEED_OPENS,
  SPEED_RANGE_DB,
  speedDb,
  SWEEP_PAN,
  SWEEP_PERIOD,
  sweepGain,
  sweepPosition,
  sweepShare,
  TONE_BRIGHTEST,
  TONE_DARKEST,
} from "./fan-dsp";
import type { FanType } from "./fan.meta";

const SR = 48000;
const QUANTUM = 128;
const TYPES: readonly FanType[] = ["desk", "ceiling", "box", "air-conditioner"];

const db = (x: number) => 20 * Math.log10(x);
const seconds = (s: number, sampleRate = SR) => Math.round(s * sampleRate);

interface Settings {
  type?: FanType;
  seed?: number;
  speed?: number;
  tone?: number;
  oscillate?: number;
  sampleRate?: number;
}

function kernel({
  type = "desk",
  seed = 1,
  speed = 50,
  tone = 40,
  oscillate = 0,
  sampleRate = SR,
}: Settings = {}) {
  const k = new FanKernel(type, seed, sampleRate);
  k.set(speed, tone, oscillate);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: FanKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: FAN_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: FAN_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    k.render(quantum, n);
    quantum.forEach((b, c) => {
      out[c]?.set(b.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return out;
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += (x[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / (to - from));
};

const peakOf = (x: Float32Array) => x.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);

describe("fan settings", () => {
  const cases = TYPES.flatMap((type) => [0, 50, 100].map((speed) => ({ type, speed })));

  it.each(cases)("$type at speed $speed: blades, rotation and blade-pass", ({ type, speed }) => {
    const spec = FAN_SPECS[type];
    const settings = fanSettings(type, speed, 40);
    const [slow, fast] = spec.rotation;
    expect(settings.rotation).toBeCloseTo(slow + ((fast - slow) * speed) / 100, 12);
    // Blades × rotation, or for a blower (no blades) a steady ripple, whatever the speed.
    const expected = spec.blades > 0 ? spec.blades * settings.rotation : spec.ripple;
    expect(settings.bladePass).toBeCloseTo(expected, 12);
  });

  it.each(cases)("$type at speed $speed: the air's level and filters", ({ type, speed }) => {
    const spec = FAN_SPECS[type];
    const settings = fanSettings(type, speed, 40);
    expect(settings.airDb).toBeCloseTo(
      AIR_DB + spec.levelDb + SPEED_RANGE_DB * (speed / 100 - 0.5),
      12,
    );
    expect(settings.highpass).toBe(spec.highpass);
    expect(settings.peak).toBe(spec.peak);
    expect(db(settings.peakGain)).toBeCloseTo(spec.peakDb, 12);
    expect(settings.depth).toBe(spec.depth);
    // Tone 40 is the fan's own low-pass, opened by up to 30 % with Speed.
    expect(settings.lowpass).toBeCloseTo(spec.lowpass * (1 + (SPEED_OPENS * speed) / 100), 9);
  });

  it("spans the table's rotations, blade-passes and motors", () => {
    expect(rotationAt("desk", 0)).toBe(14);
    expect(rotationAt("desk", 100)).toBe(24);
    expect(bladePassAt("ceiling", 0)).toBeCloseTo(4.5, 12);
    expect(bladePassAt("ceiling", 100)).toBeCloseTo(15, 12);
    expect(bladePassAt("box", 100)).toBeCloseTo(95, 12);
    expect(bladePassAt("air-conditioner", 0)).toBe(9);
    expect(bladePassAt("air-conditioner", 100)).toBe(9);
  });

  it("raises the level 9 dB from Speed 0 to 100", () => {
    expect(speedDb(100) - speedDb(0)).toBeCloseTo(SPEED_RANGE_DB, 12);
    expect(speedDb(50)).toBe(0);
  });

  it.each(TYPES)("shifts %s's low-pass from 0.6× to 1.6× with Tone, under the limit", (type) => {
    const own = FAN_SPECS[type].lowpass;
    expect(lowpassAt(type, 0, 0)).toBeCloseTo(own * TONE_DARKEST, 9);
    expect(lowpassAt(type, 0, 100)).toBeCloseTo(Math.min(LOWPASS_LIMIT, own * TONE_BRIGHTEST), 9);
    expect(lowpassAt(type, 100, 100)).toBeLessThanOrEqual(LOWPASS_LIMIT);
  });

  it.each(TYPES)("keeps %s's air below 25 Hz at least 20 dB down", (type) => {
    expect(10 * Math.log10(airShareBelow(type, 25, SR))).toBeLessThan(-20);
  });
});

describe("oscillation", () => {
  it("only turns desk and box fans", () => {
    expect(sweepShare("desk", 1)).toBe(1);
    expect(sweepShare("box", 0.5)).toBe(0.5);
    expect(sweepShare("ceiling", 1)).toBe(0);
    expect(sweepShare("air-conditioner", 1)).toBe(0);
  });

  it("sweeps once each way per period, facing the bed in the middle", () => {
    expect(sweepPosition(0)).toBeCloseTo(0, 12);
    expect(sweepPosition(SWEEP_PERIOD / 4)).toBeCloseTo(1, 12);
    expect(sweepPosition((3 * SWEEP_PERIOD) / 4)).toBeCloseTo(-1, 12);
    expect(facing(0)).toBe(1);
    expect(facing(1)).toBe(0);
  });

  it.each([-1, -0.5, 0, 0.3, 1])(
    "keeps the two sides' power at position %d, 3 dB up facing, 3 dB down at the ends",
    (position) => {
      const l = sweepGain(1, 1, position, -1);
      const r = sweepGain(1, 1, position, 1);
      const levelDb = 3 * (2 * facing(position) - 1);
      expect(10 * Math.log10((l * l + r * r) / 2)).toBeCloseTo(levelDb, 9);
      // Balanced by up to ±0.5 of full pan.
      expect((r * r - l * l) / (r * r + l * l)).toBeCloseTo(SWEEP_PAN * position, 9);
    },
  );

  it("is still when not oscillating", () => {
    expect(sweepGain(0.7, 0, 0.8, -1)).toBe(0.7);
    expect(sweepGain(0.7, 0, 0.8, 1)).toBe(0.7);
  });
});

describe("blade-pass wave", () => {
  it("is a sine plus its second harmonic 9 dB down, spanning ±1", () => {
    let peak = 0;
    let mean = 0;
    for (let m = 0; m < 1000; m++) {
      const v = bladeWave(m / 1000);
      peak = Math.max(peak, Math.abs(v));
      mean += v / 1000;
    }
    expect(peak).toBeCloseTo(1, 4);
    expect(Math.abs(mean)).toBeLessThan(1e-9);
    const a = 0.1 * 2 * Math.PI;
    expect(bladeWave(0.1) / bladeWave(0.2)).toBeCloseTo(
      (Math.sin(a) + BLADE_HARMONIC * Math.sin(2 * a)) /
        (Math.sin(2 * a) + BLADE_HARMONIC * Math.sin(4 * a)),
      9,
    );
  });
});

describe("motor", () => {
  it("whirrs at six times a bladed fan's rotation", () => {
    expect(motorFrequency("desk", 0)).toBeCloseTo(MOTOR_RATIO * 14, 9);
    expect(motorFrequency("desk", 100)).toBeCloseTo(MOTOR_RATIO * 24, 9);
    expect(motorFrequency("box", 50)).toBeCloseTo(MOTOR_RATIO * 15, 9);
    expect(motorFrequency("air-conditioner", 0)).toBe(COMPRESSOR);
    expect(motorFrequency("ceiling", 100)).toBe(CEILING_MOTOR);
  });

  it("has a buzzy whirr, a four-harmonic compressor and a ceiling fan's lone sine", () => {
    expect(motorWave("desk").imag).toHaveLength(9);
    expect(motorWave("air-conditioner").imag).toHaveLength(5);
    expect(motorWave("ceiling").imag).toHaveLength(2);
    for (const type of TYPES) {
      expect(motorWave(type).real.every((r) => r === 0)).toBe(true);
    }
  });

  it("rolls off above 800 Hz", () => {
    expect(db(motorRolloff(100))).toBeGreaterThan(-0.1);
    expect(db(motorRolloff(800))).toBeCloseTo(-3, 1);
    expect(db(motorRolloff(1600))).toBeLessThan(-11);
  });

  it.each(TYPES)("%s's motor is off at 0 and 22 dB under the air at 100", (type) => {
    expect(motorGain(type, 0, 50)).toBe(0);
    const wave = motorWave(type);
    const waveRms = Math.sqrt(wave.imag.reduce((sum, a) => sum + (a * a) / 2, 0));
    for (const speed of [0, 50, 100]) {
      const motorDb = db(motorGain(type, 100, speed) * waveRms);
      expect(motorDb).toBeCloseTo(
        fanSettings(type, speed, 40).airDb + MOTOR_UNDER_AIR_DB + FAN_SPECS[type].motorDb,
        9,
      );
    }
  });
});

describe("kernel", () => {
  it("is the same for the same seed and differs for another", () => {
    const a = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const b = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const c = render(kernel({ seed: 5 }), 0, seconds(0.5));
    expect(a).toEqual(b);
    expect(a[0]).not.toEqual(c[0]);
  });

  it.each(TYPES)(
    "is the same for %s rendered afresh from a later sample, once its filters settle",
    (type) => {
      const settings = { type, oscillate: 1 };
      const from = seconds(3) + 37;
      const whole = render(kernel(settings), 0, seconds(5));
      const later = render(kernel(settings), from, seconds(5));
      const settle = seconds(1);
      for (const channel of [0, 1]) {
        const a = whole[channel]?.subarray(from + settle) ?? new Float32Array();
        const b = later[channel]?.subarray(settle) ?? new Float32Array();
        const difference = a.map((v, i) => v - (b[i] ?? 0));
        expect(db(rms(difference) / rms(a))).toBeLessThan(-40);
      }
    },
  );

  it("decorrelates its sides", () => {
    const [left = new Float32Array(), right = new Float32Array()] = render(kernel(), 0, seconds(4));
    let lr = 0;
    for (let i = 0; i < left.length; i++) {
      lr += (left[i] ?? 0) * (right[i] ?? 0);
    }
    expect(Math.abs(lr / (rms(left) * rms(right) * left.length))).toBeLessThan(0.15);
  });

  it.each(TYPES)("puts %s near its level at the defaults", (type) => {
    const out = render(kernel({ type }), 0, seconds(8));
    const level = db(rms(out[0] ?? new Float32Array(), seconds(0.5)));
    expect(level).toBeCloseTo(fanSettings(type, 50, 40).airDb, 0);
  });

  it("swells with the blades, in phase with absolute time", () => {
    // A ceiling fan's whum: the air's power follows the blade-pass wave.
    const type = "ceiling";
    const out = render(kernel({ type }), 0, seconds(20));
    const bladePass = bladePassAt(type, 50);
    let inPhase = 0;
    let total = 0;
    for (let n = seconds(0.5); n < seconds(20); n++) {
      const power = (out[0]?.[n] ?? 0) ** 2 + (out[1]?.[n] ?? 0) ** 2;
      inPhase += power * bladeWave((bladePass * n) / SR);
      total += power;
    }
    // Power goes with the gain squared: about twice the depth, against a wave of mean square ~0.5.
    const depth = (inPhase / total) * 2;
    expect(depth).toBeGreaterThan(FAN_SPECS[type].depth * 0.6);
    expect(depth).toBeLessThan(FAN_SPECS[type].depth * 2);
  });

  it("turns side to side when oscillating, and holds still when not", () => {
    // A quarter of the way through the sweep it faces one side.
    const at = seconds(SWEEP_PERIOD / 4);
    const balance = (oscillate: number) => {
      const out = render(kernel({ oscillate }), at - seconds(1), at + seconds(1));
      return db(rms(out[1] ?? new Float32Array()) / rms(out[0] ?? new Float32Array()));
    };
    expect(balance(1)).toBeGreaterThan(3);
    expect(Math.abs(balance(0))).toBeLessThan(0.5);
  });

  it.each(TYPES.flatMap((type) => [0, 100].map((speed) => ({ type, speed }))))(
    "stays finite and bounded: $type at speed $speed, brightest, oscillating",
    ({ type, speed }) => {
      const out = render(kernel({ type, speed, tone: 100, oscillate: 1 }), 0, seconds(6));
      for (const channel of out) {
        expect(channel.every((v) => Number.isFinite(v))).toBe(true);
        expect(db(peakOf(channel))).toBeLessThan(-4);
      }
    },
  );

  it("follows the same params to the same level at 44.1 and 48 kHz", () => {
    const level = (sampleRate: number) =>
      db(
        rms(
          render(kernel({ sampleRate }), 0, seconds(8, sampleRate))[0] ?? new Float32Array(),
          seconds(0.5, sampleRate),
        ),
      );
    expect(Math.abs(level(44100) - level(48000))).toBeLessThan(0.5);
  });
});

describe("guard", () => {
  it("leaves the air alone below its knee", () => {
    for (const x of [0, 0.1, -0.2, 0.35]) {
      expect(guard(x)).toBe(x);
    }
  });

  it("bends the rarest peaks smoothly, never past 4 dB under full scale", () => {
    let last = guard(0.35);
    for (let x = 0.35; x <= 4; x += 0.01) {
      const y = guard(x);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(10 ** (-4 / 20));
      expect(guard(-x)).toBe(-y);
      last = y;
    }
  });
});

describe("options", () => {
  it("reads the fan, seed and offset, with safe defaults", () => {
    expect(readFanOptions({ type: "box", seed: 12.7, offset: 3.5 })).toEqual({
      type: "box",
      seed: 12,
      offset: 3.5,
    });
    expect(readFanOptions(undefined)).toEqual({ type: "desk", seed: 0, offset: 0 });
    expect(readFanOptions({ type: "toString", seed: "x", offset: Number.NaN })).toEqual({
      type: "desk",
      seed: 0,
      offset: 0,
    });
  });
});
