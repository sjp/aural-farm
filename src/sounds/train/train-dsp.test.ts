import { describe, expect, it } from "vitest";
import { createEventBlock, eventsInBlock } from "../../audio/dsp/events";
import {
  AXLES,
  clackLevel,
  createCrossings,
  crossingSample,
  JOINT_JITTER,
  jointPeriod,
  Joints,
  metresPerSecond,
  POINTS_RATES,
  RAIL_LENGTH,
  readTrainOptions,
  roarCentre,
  roarDb,
  THUMP_RATE,
  TRACK_VALUES,
  TrainKernel,
  VOICE_LENGTH,
  WELDED_RUMBLE_DB,
} from "./train-dsp";

const SR = 48000;
const QUANTUM = 128;
const THUMP_STREAM = 3;

const db = (x: number) => 20 * Math.log10(x);
const seconds = (s: number, sampleRate = SR) => Math.round(s * sampleRate);

function rms(x: Float32Array): number {
  let sum = 0;
  for (const v of x) {
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, x.length));
}

function peakOf(x: Float32Array): number {
  let peak = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

interface Settings {
  seed?: number;
  kmh?: number;
  track?: number;
  clacks?: number;
  points?: number;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  kmh = 90,
  track = 0,
  clacks = 55,
  points = 0,
  sampleRate = SR,
}: Settings = {}) {
  const k = new TrainKernel(seed, sampleRate);
  k.set(kmh, track, clacks, points);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: TrainKernel, from: number, to: number): [Float32Array, Float32Array] {
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  const ql = new Float32Array(QUANTUM);
  const qr = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    k.render(ql, qr, n);
    const length = Math.min(QUANTUM, to - n);
    left.set(ql.subarray(0, length), n - from);
    right.set(qr.subarray(0, length), n - from);
  }
  return [left, right];
}

describe("Joints", () => {
  it("keeps every joint within its jitter of its place, and uses the range", () => {
    const joints = new Joints(1);
    let widest = 0;
    for (let k = 0; k < 1000; k++) {
      const off = joints.position(k) - k * RAIL_LENGTH;
      expect(Math.abs(off)).toBeLessThanOrEqual(JOINT_JITTER + 1e-9);
      widest = Math.max(widest, Math.abs(off));
    }
    expect(widest).toBeGreaterThan(0.9 * JOINT_JITTER);
  });

  it("finds every axle crossing every joint, at the joint's position plus the axle's", () => {
    const joints = new Joints(3);
    const out = createCrossings(64);
    const k = 20;
    const p = joints.position(k);
    joints.crossings(p, p + AXLES[3] + 0.5, out);
    const ofJoint = [];
    for (let i = 0; i < out.count; i++) {
      if (out.joints[i] === k) {
        ofJoint.push({ axle: out.axles[i], position: out.positions[i] });
      }
    }
    expect(ofJoint.map((c) => c.axle)).toEqual([0, 1, 2, 3]);
    for (const c of ofJoint) {
      expect(c.position).toBeCloseTo(p + AXLES[c.axle], 9);
    }
  });

  it("at 90 km/h, a joint's four clacks fall at the axle offsets over the speed", () => {
    const joints = new Joints(1);
    const v = metresPerSecond(90);
    const k = 50;
    const joint = (joints.position(k) / v) * SR;
    for (const axle of AXLES) {
      const n = crossingSample(joints.position(k) + axle, v, 0, SR, 0, Number.MAX_SAFE_INTEGER);
      expect(Math.abs(n - joint - (axle / v) * SR)).toBeLessThanOrEqual(1);
    }
    // The near pair 104 ms apart, the far pair 0.66 s after it, every 0.73 s.
    expect((AXLES[1] - AXLES[0]) / v).toBeCloseTo(0.104, 3);
    expect((AXLES[2] - AXLES[0]) / v).toBeCloseTo(0.656, 3);
    expect(jointPeriod(90)).toBeCloseTo(0.732, 3);
  });

  it.each([
    [0.37, 1],
    [2.9, 2],
    [18.3, 3],
  ])("gives the same crossings in windows of %f m as in windows of 1 m (seed %i)", (step, seed) => {
    const gather = (size: number) => {
      const joints = new Joints(seed);
      const part = createCrossings(64);
      const found: number[] = [];
      for (let s = -30; s < 970; s += size) {
        joints.crossings(s, Math.min(970, s + size), part);
        for (let i = 0; i < part.count; i++) {
          found.push(part.positions[i]);
        }
      }
      return found;
    };
    const whole = gather(1);
    expect(gather(step)).toEqual(whole);
    // Each of the four axles crosses each of about 53 joints.
    expect(whole.length).toBeGreaterThan(200);
  });

  it("is the same for the same seed and differs between seeds", () => {
    expect(new Joints(4).position(7)).toBe(new Joints(4).position(7));
    expect(new Joints(4).position(7)).not.toBe(new Joints(5).position(7));
  });
});

describe("crossingSample", () => {
  it("keeps the sample within the quantum", () => {
    expect(crossingSample(10, 25, 0, SR, 0, 128)).toBe(127);
    expect(crossingSample(-1, 25, 0, SR, 128, 256)).toBe(128);
    expect(crossingSample(25 * (200 / SR), 25, 0, SR, 128, 256)).toBe(200);
  });
});

describe("param mappings", () => {
  it("raises the clacks 4 dB from 40 to 160 km/h, and scales them with Clacks", () => {
    expect(db(clackLevel(100, 160) / clackLevel(100, 40))).toBeCloseTo(4, 6);
    expect(clackLevel(0, 90)).toBe(0);
    expect(clackLevel(50, 90) / clackLevel(100, 90)).toBeCloseTo(0.5, 9);
  });

  it("lifts the roar 8 dB and from 300 to 650 Hz from 40 to 160 km/h", () => {
    expect(roarDb(160) - roarDb(40)).toBeCloseTo(8, 9);
    expect(roarCentre(40)).toBeCloseTo(300, 9);
    expect(roarCentre(160)).toBeCloseTo(650, 9);
  });

  it("maps the selects", () => {
    expect(TRACK_VALUES).toEqual({ jointed: 0, welded: 1 });
    expect(POINTS_RATES.off).toBe(0);
    expect(1 / POINTS_RATES.rarely).toBeCloseTo(240);
    expect(1 / POINTS_RATES.sometimes).toBeCloseTo(90);
  });
});

describe("TrainKernel", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    const [a] = render(kernel({ seed: 7 }), 0, seconds(2));
    const [b] = render(kernel({ seed: 7 }), 0, seconds(2));
    const [c] = render(kernel({ seed: 8 }), 0, seconds(2));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it.each([1, 2, 3, 4])(
    "stays finite and under −3 dBFS at 160 km/h, Clacks 100, rattling often (seed %i)",
    (seed) => {
      // Rattles every few seconds rather than every 90 s, to meet several.
      const [l, r] = render(kernel({ seed, kmh: 160, clacks: 100, points: 0.3 }), 0, seconds(20));
      for (const x of [l, r]) {
        expect(x.every((v) => Number.isFinite(v))).toBe(true);
        expect(db(peakOf(x))).toBeLessThan(-3);
      }
    },
  );

  it.each([40, 160])("stays finite at %i km/h, welded, with no clacks", (kmh) => {
    const [l] = render(kernel({ kmh, track: 1, clacks: 0 }), 0, seconds(2));
    expect(l.every((v) => Number.isFinite(v))).toBe(true);
    expect(rms(l)).toBeGreaterThan(0);
  });

  it("is time-addressable: a fresh render from 30 s matches the tail of one from 0, once its filters settle", () => {
    const settings = { seed: 2, clacks: 100, points: 1, track: 0 };
    const from = seconds(30);
    const to = seconds(36);
    const [whole] = render(kernel(settings), 0, to);
    const [part] = render(kernel(settings), from, to);
    let worst = 0;
    for (let i = seconds(0.5); i < part.length; i++) {
      worst = Math.max(worst, Math.abs(part[i] - whole[from + i]));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("on welded track strikes no joints: its clacks are only the thumps", () => {
    const seed = 5;
    const length = seconds(12);
    const [withClacks] = render(kernel({ seed, track: 1, clacks: 100 }), 0, length);
    const [without] = render(kernel({ seed, track: 1, clacks: 0 }), 0, length);
    // Where a thump could be sounding.
    const thumping = new Uint8Array(length);
    const block = createEventBlock(16);
    for (let b = 0; b < 12; b++) {
      eventsInBlock(seed, THUMP_STREAM, b, THUMP_RATE, block);
      for (let i = 0; i < block.count; i++) {
        const at = seconds(b + block.offsets[i]);
        thumping.fill(1, Math.max(0, at - 1), Math.min(length, at + seconds(VOICE_LENGTH) + 1));
      }
    }
    let outside = 0;
    let inside = 0;
    for (let i = 0; i < length; i++) {
      const d = Math.abs(withClacks[i] - without[i]);
      if (thumping[i]) {
        inside = Math.max(inside, d);
      } else {
        outside = Math.max(outside, d);
      }
    }
    // Float rounding aside: the voices add onto the rumble.
    expect(outside).toBeLessThan(1e-5);
    expect(inside).toBeGreaterThan(0);

    // Jointed track, by contrast, clacks between the thumps' times.
    const [jointed] = render(kernel({ seed, track: 0, clacks: 100 }), 0, length);
    const [quiet] = render(kernel({ seed, track: 0, clacks: 0 }), 0, length);
    expect(jointed.some((v, i) => !thumping[i] && v !== quiet[i])).toBe(true);
  });

  it("lifts the rumble on welded track", () => {
    const [jointed] = render(kernel({ clacks: 0 }), 0, seconds(10));
    const [welded] = render(kernel({ clacks: 0, track: 1 }), 0, seconds(10));
    expect(db(rms(welded) / rms(jointed))).toBeCloseTo(WELDED_RUMBLE_DB, 1);
  });

  it("speeds the rhythm up without a jump when the speed changes", () => {
    const k = kernel({ clacks: 100 });
    const [before] = render(k, 0, seconds(3));
    k.set(160, 0, 100, 0);
    const [after] = render(k, seconds(3), seconds(8));
    for (const x of [before, after]) {
      expect(x.every((v) => Number.isFinite(v))).toBe(true);
    }
    // The rumble carries straight on across the change: no step at the join.
    const step = Math.abs(after[0] - (before.at(-1) ?? 0));
    expect(step).toBeLessThan(5 * rms(before) * 0.2);
  });

  it("crossfades the track rather than switching it", () => {
    const k = kernel({ clacks: 0 });
    const [jointed] = render(k, 0, seconds(4));
    k.set(90, 1, 0, 0);
    const [fading] = render(k, seconds(4), seconds(4.4));
    const [faded] = render(k, seconds(4.4), seconds(10));
    const level = db(rms(fading) / rms(jointed));
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(WELDED_RUMBLE_DB * 0.6);
    expect(db(rms(faded) / rms(jointed))).toBeGreaterThan(WELDED_RUMBLE_DB * 0.7);
  });

  it("holds its level within 1 dB at 44.1 kHz", () => {
    const [a] = render(kernel(), 0, seconds(10));
    const [b] = render(kernel({ sampleRate: 44100 }), 0, seconds(10, 44100));
    expect(Math.abs(db(rms(b) / rms(a)))).toBeLessThan(1);
  });
});

describe("readTrainOptions", () => {
  it("reads the seed and offset, falling back to safe defaults", () => {
    expect(readTrainOptions({ seed: 4.7, offset: 2 })).toEqual({ seed: 4, offset: 2 });
    expect(readTrainOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readTrainOptions({ seed: "x", offset: Number.NaN })).toEqual({ seed: 0, offset: 0 });
  });
});
