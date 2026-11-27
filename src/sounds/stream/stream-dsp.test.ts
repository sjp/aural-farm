import { describe, expect, it } from "vitest";
import { BubbleVoice, minnaertFrequency } from "../../audio/dsp/bubble";
import { createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { hash32 } from "../../audio/random";
import {
  BUBBLE_PEAK_DB,
  BUBBLE_STREAM,
  BUBBLES_CHANNEL,
  bubbleDecay,
  bubbleParams,
  bubbleRate,
  type BubbleShape,
  childHash,
  clusterChildren,
  densityGain,
  LONGEST_BUBBLE,
  MAX_BUBBLE_FREQUENCY,
  MAX_CLUSTER,
  MIN_BUBBLE_FREQUENCY,
  outputCutoff,
  parentRate,
  radiusRange,
  readStreamOptions,
  rushBalanceDb,
  rushCentre,
  sendDb,
  STREAM_CHANNELS,
  StreamGenerator,
  StreamKernel,
  streamLevels,
  WARM_UP,
} from "./stream-dsp";

const SR = 48000;
const QUANTUM = 128;

interface Settings {
  seed?: number;
  flow?: number;
  size?: number;
  level?: number;
  sampleRate?: number;
}

function kernel({ seed = 1, flow = 45, size = 30, level = 1, sampleRate = SR }: Settings) {
  const k = new StreamKernel(seed, sampleRate);
  k.set(flow, size, level);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: StreamKernel, from: number, to: number) {
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

const peak = (...buffers: Float32Array[]) =>
  Math.max(...buffers.map((b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

const allFinite = (b: Float32Array) => b.every((v) => Number.isFinite(v));

function maxDifference(a: Float32Array, b: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

/** Bubble hashes to sample shapes from. */
const HASHES = Array.from({ length: 2000 }, (_, i) => hash32(7, i));

describe("param mappings", () => {
  it("runs 8 to 80 clusters a second, about 40 to 600 bubbles", () => {
    expect(parentRate(0)).toBeCloseTo(8);
    expect(parentRate(100)).toBeCloseTo(80);
    expect(bubbleRate(0)).toBeCloseTo(40);
    expect(bubbleRate(100)).toBeCloseTo(600);
  });

  it("thins each bubble only above the default flow", () => {
    expect(densityGain(0)).toBe(1);
    expect(densityGain(45)).toBeCloseTo(1);
    expect(densityGain(100)).toBeLessThan(0.7);
  });

  it("lowers the rush's band and moves the balance from bubbles to rush with size", () => {
    expect(rushCentre(0)).toBeCloseTo(1200);
    expect(rushCentre(100)).toBeCloseTo(500);
    expect(rushBalanceDb(0, 0)).toBe(-24);
    expect(rushBalanceDb(100, 0)).toBe(2);
    expect(rushBalanceDb(0, 100)).toBe(10);
    expect(rushBalanceDb(100, 100)).toBe(10);
  });

  it("fades the babble into the rush with distance: quieter, duller, more reverb", () => {
    const close = streamLevels(45, 30, 0);
    const far = streamLevels(45, 30, 100);
    expect(far.bubbles / far.pink).toBeLessThan(close.bubbles / close.pink);
    expect(far.bubbles).toBeLessThan(close.bubbles);
    expect(outputCutoff(0)).toBeCloseTo(18000);
    expect(outputCutoff(100)).toBeCloseTo(2500);
    expect(sendDb(0)).toBe(-34);
    expect(sendDb(100)).toBe(-20);
  });

  it("raises the rush by 6 dB across flow, and gives a river more of the brown noise", () => {
    const trickle = streamLevels(0, 30, 0);
    const fast = streamLevels(100, 30, 0);
    expect(20 * Math.log10(fast.pink / trickle.pink)).toBeCloseTo(6);
    expect(fast.bubbles).toBeCloseTo(trickle.bubbles);
    const brook = streamLevels(45, 0, 0);
    const river = streamLevels(45, 100, 0);
    expect(river.brown / river.pink).toBeGreaterThan(brook.brown / brook.pink);
  });

  it.each([0, 100])("keeps every gain finite and positive at flow, size and distance %d", (x) => {
    for (const value of Object.values(streamLevels(x, x, x))) {
      expect(Number.isFinite(value) && value > 0).toBe(true);
    }
  });

  it("reads processor options, falling back to safe defaults", () => {
    expect(readStreamOptions({ seed: 4.7, offset: 2 })).toEqual({ seed: 4, offset: 2 });
    expect(readStreamOptions(undefined)).toEqual({ seed: 0, offset: 0 });
  });
});

describe("bubbles", () => {
  it.each([
    [0, 0.0007, 0.003],
    [50, Math.sqrt(0.0007 * 0.002), Math.sqrt(0.003 * 0.01)],
    [100, 0.002, 0.01],
  ])("at size %d, have radii %f–%f m and resonances to match", (size, smallest, largest) => {
    const [low, high] = radiusRange(size);
    expect(low).toBeCloseTo(smallest, 6);
    expect(high).toBeCloseTo(largest, 6);
    const shape: BubbleShape = { gain: 0, rise: 0, decay: 0 };
    const frequencies = HASHES.map((h) => bubbleParams(h, size, shape));
    const lowest = Math.max(MIN_BUBBLE_FREQUENCY, minnaertFrequency(largest));
    const highest = Math.min(MAX_BUBBLE_FREQUENCY, minnaertFrequency(smallest));
    for (const f of frequencies) {
      expect(f).toBeGreaterThanOrEqual(lowest - 1e-6);
      expect(f).toBeLessThanOrEqual(highest + 1e-6);
    }
    // They spread over the range, not just its ends.
    expect(Math.min(...frequencies)).toBeLessThan(lowest * 1.1);
    expect(Math.max(...frequencies)).toBeGreaterThan(highest / 1.1);
  });

  it("decays in 2 ms at 4.5 kHz to 18 ms at 330 Hz", () => {
    expect(bubbleDecay(4500)).toBeCloseTo(0.002);
    expect(bubbleDecay(330)).toBeCloseTo(0.018);
    expect(bubbleDecay(1000)).toBeLessThan(bubbleDecay(500));
    expect(LONGEST_BUBBLE).toBeLessThan(WARM_UP);
  });

  it.each([0, 100])(
    "rise 10–60 %%, more for small bubbles, and lower the smallest by up to 6 dB (size %d)",
    (size) => {
      const shape: BubbleShape = { gain: 0, rise: 0, decay: 0 };
      for (const h of HASHES) {
        bubbleParams(h, size, shape);
        expect(shape.rise).toBeGreaterThanOrEqual(0.1);
        expect(shape.rise).toBeLessThanOrEqual(0.6);
        expect(shape.gain).toBeGreaterThanOrEqual(10 ** (-6 / 20) - 1e-9);
        expect(shape.gain).toBeLessThanOrEqual(1);
        expect(shape.decay).toBeGreaterThan(0.002 * 0.8 - 1e-9);
        expect(shape.decay).toBeLessThan(0.018 * 1.2 + 1e-9);
      }
    },
  );

  it.each([0, 100])(
    "ring with a rising pitch within 250 Hz–4.5 kHz and end below −60 dB (size %d)",
    (size) => {
      const shape: BubbleShape = { gain: 0, rise: 0, decay: 0 };
      const voice = new BubbleVoice(SR);
      for (const h of HASHES.slice(0, 50)) {
        const f0 = bubbleParams(h, size, shape);
        voice.start(1, f0, shape.rise / (3 * shape.decay), shape.decay, MAX_BUBBLE_FREQUENCY);
        let last = 0;
        let tail = 0;
        let rising = true;
        let inRange = true;
        let finite = true;
        while (voice.active) {
          const f = voice.frequency;
          rising &&= f >= last;
          inRange &&= f >= MIN_BUBBLE_FREQUENCY && f <= MAX_BUBBLE_FREQUENCY + 1e-6;
          last = f;
          const y = voice.next();
          finite &&= Number.isFinite(y);
          tail = Math.abs(y);
        }
        expect({ rising, inRange, finite }).toEqual({ rising: true, inRange: true, finite: true });
        expect(tail).toBeLessThan(10 ** (-59 / 20));
        // It rose by most of its hashed rise, unless it reached the ceiling.
        expect(last).toBeGreaterThan(Math.min(f0 * (1 + shape.rise), MAX_BUBBLE_FREQUENCY - 1));
      }
    },
  );
});

describe("clusters", () => {
  it.each([0, 45, 100])("have 1–12 children within 60 ms of their parent (flow %d)", (flow) => {
    const out = new Float64Array(MAX_CLUSTER);
    for (const h of HASHES) {
      const count = clusterChildren(h, flow, out);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(12);
      for (let c = 0; c < count; c++) {
        expect(out[c]).toBeGreaterThanOrEqual(0);
        expect(out[c]).toBeLessThanOrEqual(0.06);
      }
    }
  });

  it("are larger and tighter at high flow", () => {
    const out = new Float64Array(MAX_CLUSTER);
    const stats = (flow: number) => {
      let children = 0;
      let latest = 0;
      for (const h of HASHES) {
        const count = clusterChildren(h, flow, out);
        children += count;
        latest += Math.max(...out.subarray(0, count));
      }
      return { children: children / HASHES.length, latest: latest / HASHES.length };
    };
    const slow = stats(0);
    const fast = stats(100);
    expect(slow.children).toBeCloseTo(5, 0);
    expect(fast.children).toBeCloseTo(7.5, 0);
    expect(fast.latest).toBeLessThan(slow.latest / 2);
  });

  it("give each child its own hash", () => {
    const parent = eventHash(1, BUBBLE_STREAM, 0, 0);
    expect(childHash(parent, 0)).not.toBe(childHash(parent, 1));
  });

  it.each([0, 100])("average the cluster rate over 1 000 blocks at flow %d", (flow) => {
    const rate = parentRate(flow);
    const block = createEventBlock(512);
    let total = 0;
    for (let b = 0; b < 1000; b++) {
      total += eventsInBlock(1, BUBBLE_STREAM, b, rate, block);
    }
    expect(Math.abs(total / 1000 - rate) / rate).toBeLessThan(0.05);
  });
});

describe("StreamKernel", () => {
  it("gives the same output for the same seed, params and start, and another for another seed", () => {
    const a = render(kernel({}), 0, SR);
    const b = render(kernel({}), 0, SR);
    const c = render(kernel({ seed: 2 }), 0, SR);
    expect(a.left).toEqual(b.left);
    expect(a.right).toEqual(b.right);
    expect(maxDifference(a.left, c.left)).toBeGreaterThan(1e-3);
  });

  it("surges its cluster rate by up to ±20 % from block to block", () => {
    const k = kernel({});
    const rates = Array.from({ length: 200 }, (_, b) => k.clusterRate(b, 45));
    const base = parentRate(45);
    for (const rate of rates) {
      expect(Math.abs(rate / base - 1)).toBeLessThanOrEqual(0.2);
    }
    expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThan(base * 0.1);
  });

  it.each([
    ["a trickle", 0],
    ["fast water", 100],
  ])(
    "renders 0–4 s in one go and in two chunks split at 1.37 s alike, clusters across the seam included (%s)",
    (_, flow) => {
      const settings = { flow, size: 50 };
      const seam = Math.round(1.37 * SR);
      const whole = render(kernel(settings), 0, 4 * SR);
      const first = render(kernel(settings), 0, seam);
      const second = render(kernel(settings), seam, 4 * SR);
      const left = new Float32Array(4 * SR);
      left.set(first.left);
      left.set(second.left, seam);
      const right = new Float32Array(4 * SR);
      right.set(first.right);
      right.set(second.right, seam);
      expect(maxDifference(whole.left, left)).toBeLessThan(1e-6);
      expect(maxDifference(whole.right, right)).toBeLessThan(1e-6);
    },
  );

  it("renders a cluster that crosses a block's end alike in one chunk and in two", () => {
    // The first block with a cluster whose children run past its end.
    const k = kernel({});
    const block = createEventBlock(512);
    const out = new Float64Array(MAX_CLUSTER);
    const crosses = (b: number) => {
      const count = eventsInBlock(1, BUBBLE_STREAM, b, k.clusterRate(b, 45), block);
      for (let i = 0; i < count; i++) {
        const children = clusterChildren(eventHash(1, BUBBLE_STREAM, b, i), 45, out);
        if ((block.offsets[i] ?? 0) + Math.max(...out.subarray(0, children)) > 1) {
          return true;
        }
      }
      return false;
    };
    const b = Array.from({ length: 50 }, (_, i) => i).find((i) => crosses(i));
    expect(b).toBeDefined();
    const from = (b ?? 0) * SR;
    const seam = from + SR;
    const whole = render(kernel({}), from, seam + SR);
    const first = render(kernel({}), from, seam);
    const second = render(kernel({}), seam, seam + SR);
    expect(maxDifference(whole.left.subarray(0, SR), first.left)).toBeLessThan(1e-6);
    expect(maxDifference(whole.left.subarray(SR), second.left)).toBeLessThan(1e-6);
    expect(maxDifference(whole.right.subarray(SR), second.right)).toBeLessThan(1e-6);
  });

  it("picks up bubbles that started before its first sample, from any start", () => {
    const start = 10 * SR + 777;
    const late = render(kernel({ flow: 90 }), start, start + SR / 2);
    const early = render(kernel({ flow: 90 }), start - SR, start + SR / 2);
    expect(maxDifference(early.left.subarray(SR), late.left)).toBeLessThan(1e-6);
  });

  it("keeps a block's flow until the block ends", () => {
    // Flows up to the default share a density gain, so only the clusters change.
    const steady = kernel({ flow: 10 });
    const changed = kernel({ flow: 10 });
    render(steady, 0, SR / 2);
    render(changed, 0, SR / 2);
    changed.set(45, 30, 1);
    const restOfBlock = [render(steady, SR / 2, SR), render(changed, SR / 2, SR)];
    expect(restOfBlock[1]?.left).toEqual(restOfBlock[0]?.left);
    const nextBlock = [render(steady, SR, 2 * SR), render(changed, SR, 2 * SR)];
    expect(
      maxDifference(
        nextBlock[0]?.left ?? new Float32Array(),
        nextBlock[1]?.left ?? new Float32Array(),
      ),
    ).toBeGreaterThan(1e-3);
  });

  it("lets the bubbles already sounding ring out when their level drops to 0", () => {
    const k = kernel({ flow: 100 });
    render(k, 0, SR);
    k.set(100, 30, 0);
    const after = render(k, SR, SR + WARM_UP * SR);
    expect(
      peak(after.left.subarray(0, SR / 1000), after.right.subarray(0, SR / 1000)),
    ).toBeGreaterThan(0);
    const tail = after.left.subarray(after.left.length - SR / 100);
    expect(peak(tail)).toBe(0);
  });

  it.each([
    [0, 0],
    [0, 100],
    [100, 0],
    [100, 100],
  ])("stays finite and under −3 dBFS at flow %d and size %d", (flow, size) => {
    const level = streamLevels(flow, size, 0).bubbles;
    const { left, right } = render(kernel({ flow, size, level }), 0, 10 * SR);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(peak(left, right)).toBeLessThan(10 ** (-3 / 20));
    expect(peak(left, right)).toBeGreaterThan(10 ** ((BUBBLE_PEAK_DB - 20) / 20));
  });

  it("works at 44.1 kHz", () => {
    const k = kernel({ sampleRate: 44100 });
    const left = new Float32Array(44100);
    const right = new Float32Array(44100);
    k.render(left, right, 0);
    expect(allFinite(left)).toBe(true);
    expect(peak(left, right)).toBeGreaterThan(0);
  });
});

describe("StreamGenerator", () => {
  it("fills the noise and bubble channels, finite and bounded", () => {
    const g = new StreamGenerator(3, SR);
    g.set(45, 30, 1);
    const channels = Array.from({ length: STREAM_CHANNELS }, () => new Float32Array(QUANTUM));
    const peaks = new Float64Array(STREAM_CHANNELS);
    for (let n = 0; n < SR; n += QUANTUM) {
      g.render(channels, n);
      channels.forEach((channel, c) => {
        expect(allFinite(channel)).toBe(true);
        peaks[c] = Math.max(peaks[c] ?? 0, peak(channel));
      });
    }
    for (const p of peaks) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("is the same from an absolute start whenever it begins, once the noise settles", () => {
    const a = new StreamGenerator(1, SR);
    const b = new StreamGenerator(1, SR);
    a.set(45, 30, 1);
    b.set(45, 30, 1);
    const early = Array.from({ length: STREAM_CHANNELS }, () => new Float32Array(QUANTUM));
    const late = Array.from({ length: STREAM_CHANNELS }, () => new Float32Array(QUANTUM));
    for (let n = 0; n <= SR; n += QUANTUM) {
      a.render(early, n);
    }
    b.render(late, SR);
    // The bubbles match from the first sample (the noise's filters take a moment to settle).
    for (let c = BUBBLES_CHANNEL; c < STREAM_CHANNELS; c++) {
      expect(
        maxDifference(early[c] ?? new Float32Array(), late[c] ?? new Float32Array()),
      ).toBeLessThan(1e-6);
    }
  });
});
