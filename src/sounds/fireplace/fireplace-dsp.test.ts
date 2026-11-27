import { describe, expect, it } from "vitest";
import { createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { NOISE_RMS } from "../../audio/noise-dsp";
import { hash32 } from "../../audio/random";
import {
  BAND_CHANNEL,
  clusterChildren,
  clusterRate,
  CRACKLE_STREAM,
  eventsDb,
  FIREPLACE_CHANNELS,
  FireplaceGenerator,
  FireplaceKernel,
  HISS_STREAM,
  hissRate,
  MAX_CLUSTER,
  POP_PEAK_DB,
  POP_STREAM,
  PopVoice,
  popRate,
  readFireplaceOptions,
  roarCutoff,
  roarDb,
  sendDb,
  shelfDb,
  SHIFT_STREAM,
  shiftRate,
  THUMP_DB,
  ThumpVoice,
  WARM_UP,
} from "./fireplace-dsp";

const SR = 48000;
const QUANTUM = 128;
const WOODS = [
  ["hardwood", false],
  ["softwood", true],
] as const;

interface Settings {
  seed?: number;
  size?: number;
  crackle?: number;
  softwood?: boolean;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  size = 55,
  crackle = 50,
  softwood = false,
  sampleRate = SR,
}: Settings) {
  const k = new FireplaceKernel(seed, sampleRate);
  k.set(size, crackle, softwood);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: FireplaceKernel, from: number, to: number) {
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    const length = Math.min(QUANTUM, to - n);
    const [bl, br] =
      length === QUANTUM ? [l, r] : [new Float32Array(length), new Float32Array(length)];
    k.render(bl, br, n);
    left.set(bl, n - from);
    right.set(br, n - from);
  }
  return { left, right };
}

/** Renders a voice from its start until it ends, or for `seconds`. */
function renderVoice(voice: PopVoice | ThumpVoice, seconds: number) {
  const left = new Float32Array(seconds * SR);
  const right = new Float32Array(seconds * SR);
  voice.render(left, right, 0, left.length);
  return { left, right };
}

const peak = (...channels: Float32Array[]) =>
  Math.max(...channels.map((c) => c.reduce((p, v) => Math.max(p, Math.abs(v)), 0)));
const rms = (c: Float32Array) => Math.sqrt(c.reduce((s, v) => s + v * v, 0) / c.length);
const maxDifference = (a: Float32Array, b: Float32Array) =>
  a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);
const allFinite = (c: Float32Array) => c.every((v) => Number.isFinite(v));
const dbToGain = (db: number) => 10 ** (db / 20);

/** Joins two renders end to end. */
function join(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

describe("param mappings", () => {
  it("makes 0.5 to 6 cluster parents per second, busier with crackle than with size", () => {
    expect(clusterRate(0, 0)).toBeCloseTo(0.5);
    expect(clusterRate(100, 100)).toBeCloseTo(6);
    expect(clusterRate(0, 100)).toBeGreaterThan(clusterRate(100, 0));
  });

  it("pops 0.05–0.3 times a second on hardwood and twice that on softwood", () => {
    expect(popRate(0, false)).toBeCloseTo(0.05);
    expect(popRate(100, false)).toBeCloseTo(0.3);
    expect(popRate(100, true)).toBeCloseTo(0.6);
  });

  it("hisses three times as often on softwood, and shifts every 3.2–5.3 minutes by size", () => {
    expect(1 / hissRate(false)).toBe(75);
    expect(hissRate(true)).toBeCloseTo(3 * hissRate(false));
    expect(1 / shiftRate(0) / 60).toBeCloseTo(5.33, 1);
    expect(1 / shiftRate(100) / 60).toBeCloseTo(3.2, 1);
  });

  it("raises the roar from −20 dB and 160 Hz to 0 dB and 320 Hz, 6 dB over the default", () => {
    expect(roarDb(0)).toBe(-20);
    expect(roarDb(55)).toBeCloseTo(-6, 0);
    expect(roarDb(100)).toBe(-0);
    expect(roarCutoff(0)).toBeCloseTo(160);
    expect(roarCutoff(100)).toBeCloseTo(320);
    expect(eventsDb(0)).toBe(-6);
    expect(eventsDb(100)).toBe(0);
  });

  it("moves back with room: more reverb, duller", () => {
    expect(sendDb(0)).toBe(-36);
    expect(sendDb(100)).toBe(-14);
    expect(shelfDb(0)).toBe(-2);
    expect(shelfDb(100)).toBe(-6);
  });

  it("reads processor options, falling back to safe defaults", () => {
    expect(readFireplaceOptions({ seed: 4.7, offset: 2 })).toEqual({ seed: 4, offset: 2 });
    expect(readFireplaceOptions(undefined)).toEqual({ seed: 0, offset: 0 });
  });
});

describe("clusters", () => {
  it.each(WOODS)("puts each child within 40–350 ms of its parent (%s)", (_, softwood) => {
    const out = new Float64Array(MAX_CLUSTER);
    let longest = 0;
    let shortest = Number.POSITIVE_INFINITY;
    const counts = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const count = clusterChildren(hash32(1, i), softwood, out);
      counts.add(count);
      const children = out.subarray(0, count);
      const last = Math.max(...children);
      expect(Math.min(...children)).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThan(0.35);
      longest = Math.max(longest, last);
      shortest = Math.min(shortest, last);
    }
    expect(longest).toBeGreaterThan(0.3);
    expect(shortest).toBeLessThan(0.04);
    const sizes = [...counts].toSorted((a, b) => a - b);
    expect(sizes).toEqual(softwood ? [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("rates", () => {
  /** Events per minute of `stream` at `rate`, averaged over `blocks` blocks. */
  function perMinute(stream: number, rate: number, blocks: number) {
    const block = createEventBlock(64);
    let total = 0;
    for (let b = 0; b < blocks; b++) {
      total += eventsInBlock(1, stream, b, rate, block);
    }
    return (60 * total) / blocks;
  }

  // Enough blocks for each rate that chance alone strays well under 10 %.
  it.each(WOODS)("averages the pop, hiss and shift rates within 10 % (%s)", (_, softwood) => {
    const cases = [
      [POP_STREAM, popRate(50, softwood), 20_000],
      [HISS_STREAM, hissRate(softwood), 200_000],
      [SHIFT_STREAM, shiftRate(55), 400_000],
    ] as const;
    for (const [stream, rate, blocks] of cases) {
      const target = rate * 60;
      expect(Math.abs(perMinute(stream, rate, blocks) - target) / target).toBeLessThan(0.1);
    }
  });

  it("averages the cluster rate over 2 000 blocks", () => {
    const rate = clusterRate(55, 50);
    const target = rate * 60;
    expect(Math.abs(perMinute(CRACKLE_STREAM, rate, 2000) - target) / target).toBeLessThan(0.1);
  });
});

describe("FireplaceKernel", () => {
  it("gives the same output for the same seed, params and start, and another for another seed", () => {
    const a = render(kernel({}), 0, 2 * SR);
    const b = render(kernel({}), 0, 2 * SR);
    const c = render(kernel({ seed: 2 }), 0, 2 * SR);
    expect(a.left).toEqual(b.left);
    expect(a.right).toEqual(b.right);
    expect(maxDifference(a.left, c.left)).toBeGreaterThan(1e-3);
  });

  it("renders a cluster that crosses a block seam alike in one chunk and in two", () => {
    const settings = { crackle: 100, size: 100, softwood: true };
    // A cluster whose parent is in block 0 and has a child in block 1.
    const parents = createEventBlock(64);
    const children = new Float64Array(MAX_CLUSTER);
    const count = eventsInBlock(1, CRACKLE_STREAM, 0, clusterRate(100, 100), parents);
    const crossing = Array.from({ length: count }, (_, i) => i).some((i) => {
      const n = clusterChildren(eventHash(1, CRACKLE_STREAM, 0, i), true, children);
      return children.subarray(0, n).some((c) => (parents.offsets[i] ?? 0) + c >= 1);
    });
    expect(crossing).toBe(true);

    const whole = render(kernel(settings), 0, 3 * SR);
    const first = render(kernel(settings), 0, SR);
    const second = render(kernel(settings), SR, 3 * SR);
    // Equal but for float rounding: voices may be summed in another order.
    expect(maxDifference(whole.left, join(first.left, second.left))).toBeLessThan(1e-6);
    expect(maxDifference(whole.right, join(first.right, second.right))).toBeLessThan(1e-6);
  });

  it("renders alike when split while a crackle is sounding", () => {
    const settings = { crackle: 100 };
    const whole = render(kernel(settings), 0, 3 * SR);
    // Split at the first loud sample after 1.3 s, so a crackle crosses the seam.
    let seam = Math.round(1.3 * SR);
    while (Math.abs(whole.left[seam] ?? 1) < 1e-3) {
      seam++;
    }
    const first = render(kernel(settings), 0, seam);
    const second = render(kernel(settings), seam, 3 * SR);
    expect(maxDifference(whole.left, join(first.left, second.left))).toBeLessThan(1e-6);
    expect(maxDifference(whole.right, join(first.right, second.right))).toBeLessThan(1e-6);
  });

  it("picks up a hiss that started long before its first sample", () => {
    const blocks = createEventBlock(64);
    let start = 0;
    for (let b = 10; start === 0; b++) {
      if (eventsInBlock(1, HISS_STREAM, b, hissRate(true), blocks) > 0) {
        // 2 s in: past its fade-in, and further back than the warm-up.
        start = Math.round((b + blocks.offsets[0] + 2) * SR);
      }
    }
    const settings = { crackle: 0, size: 0, softwood: true };
    const late = render(kernel(settings), start, start + SR / 2);
    const early = render(kernel(settings), start - 8 * SR, start + SR / 2);
    expect(maxDifference(early.left.subarray(8 * SR), late.left)).toBeLessThan(1e-6);
    expect(rms(late.left)).toBeGreaterThan(1e-4);
    expect(WARM_UP).toBeLessThan(2);
  });

  it("keeps a block's rates until the block ends", () => {
    const steady = kernel({ crackle: 0 });
    const changed = kernel({ crackle: 0 });
    render(steady, 0, SR / 2);
    render(changed, 0, SR / 2);
    changed.set(55, 100, true);
    const restOfBlock = [render(steady, SR / 2, SR), render(changed, SR / 2, SR)];
    expect(restOfBlock[1]?.left).toEqual(restOfBlock[0]?.left);
    const later = [render(steady, SR, 3 * SR), render(changed, SR, 3 * SR)];
    expect(
      maxDifference(later[0]?.left ?? new Float32Array(), later[1]?.left ?? new Float32Array()),
    ).toBeGreaterThan(1e-3);
  });

  it.each(
    WOODS.flatMap(([wood, softwood]) =>
      [0, 100].flatMap((size) =>
        [0, 100].map((crackle) => [wood, softwood, size, crackle] as const),
      ),
    ),
  )(
    "stays finite and under −3 dBFS on %s at size %d and crackle %d",
    (_, softwood, size, crackle) => {
      const { left, right } = render(kernel({ size, crackle, softwood }), 0, 20 * SR);
      expect(allFinite(left) && allFinite(right)).toBe(true);
      expect(peak(left, right)).toBeLessThan(dbToGain(-3));
      expect(peak(left, right)).toBeGreaterThan(dbToGain(-40));
    },
  );

  it("works at 44.1 kHz", () => {
    const { left, right } = render(kernel({ sampleRate: 44100, crackle: 80 }), 0, 44100);
    expect(allFinite(left)).toBe(true);
    expect(peak(left, right)).toBeGreaterThan(0);
  });
});

describe("pops and log shifts", () => {
  /** The loudest of `count` voices, each started from its own hash by `start`. */
  function loudest<V extends PopVoice | ThumpVoice>(
    make: () => V,
    start: (voice: V, i: number) => void,
    count: number,
  ) {
    let most = 0;
    for (let i = 0; i < count; i++) {
      const voice = make();
      start(voice, i);
      const { left, right } = renderVoice(voice, 1);
      most = Math.max(most, peak(left, right));
    }
    return most;
  }

  it.each([
    [350, 10],
    [1100, 6],
  ])("rings a pop at %d Hz, Q %d, within a few dB of its peak", (centre, q) => {
    const pop = new PopVoice(SR);
    pop.start(hash32(1, centre), 0.1, 0, centre, q);
    // Centred: −3 dB in each channel.
    const level = peak(renderVoice(pop, 1).left) / (0.1 * Math.SQRT1_2);
    expect(level).toBeGreaterThan(dbToGain(-3));
    expect(level).toBeLessThan(dbToGain(2));
  });

  it("keeps the loudest log shift under the biggest pop", () => {
    const pops = loudest(
      () => new PopVoice(SR),
      (pop, i) => {
        pop.start(hash32(2, i), dbToGain(POP_PEAK_DB), 0, 350 + i * 3, 6 + (i % 5));
      },
      250,
    );
    const thumps = loudest(
      () => new ThumpVoice(SR),
      (thump, i) => {
        thump.start(hash32(3, i), dbToGain(THUMP_DB), 0);
      },
      250,
    );
    expect(thumps).toBeLessThan(pops);
  });
});

describe("FireplaceGenerator", () => {
  it("fills the roar, events and band channels, finite and bounded", () => {
    const g = new FireplaceGenerator(3, SR);
    g.set(55, 100, true);
    const channels = Array.from({ length: FIREPLACE_CHANNELS }, () => new Float32Array(QUANTUM));
    const sums = new Float64Array(FIREPLACE_CHANNELS);
    for (let n = 0; n < 4 * SR; n += QUANTUM) {
      g.render(channels, n);
      channels.forEach((c, i) => {
        expect(allFinite(c)).toBe(true);
        sums[i] += c.reduce((s, v) => s + v * v, 0);
      });
    }
    for (let c = 0; c < BAND_CHANNEL; c++) {
      expect(sums[c]).toBeGreaterThan(0);
    }
    // The roar's noise at the shared level, give or take the ±3 dB flicker.
    const roar = Math.sqrt(sums[0] / (4 * SR));
    expect(Math.abs(20 * Math.log10(roar / NOISE_RMS))).toBeLessThan(3);
    // The band's drift: within ±25 % (±386 cents), the same across a quantum.
    const band = channels[BAND_CHANNEL] ?? new Float32Array();
    expect(Math.abs(band[0])).toBeLessThan(387);
    expect(band.every((v) => v === band[0])).toBe(true);
  });

  it("is the same from an absolute start whenever it begins, once the noise settles", () => {
    const a = new FireplaceGenerator(1, SR);
    const b = new FireplaceGenerator(1, SR);
    const early = Array.from({ length: FIREPLACE_CHANNELS }, () => new Float32Array(QUANTUM));
    const late = Array.from({ length: FIREPLACE_CHANNELS }, () => new Float32Array(QUANTUM));
    for (let n = 0; n <= 2 * SR; n += QUANTUM) {
      a.render(early, n);
    }
    // The roar's noise settles within 0.2 s; the events and drift are exact at once.
    for (let n = 2 * SR - 0.2 * SR; n <= 2 * SR; n += QUANTUM) {
      b.render(late, n);
    }
    for (let c = 0; c < FIREPLACE_CHANNELS; c++) {
      expect(
        maxDifference(early[c] ?? new Float32Array(), late[c] ?? new Float32Array()),
      ).toBeLessThan(1e-4);
    }
  });
});
