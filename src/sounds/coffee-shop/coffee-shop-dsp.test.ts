import { describe, expect, it } from "vitest";
import { createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import {
  CLINK_LONGEST,
  CLINK_PAN,
  CLINK_RATIOS,
  CLINK_STREAM,
  CLINK_TOP,
  clinkRate,
  clinkShape,
  COFFEE_SHOP_CHANNELS,
  CoffeeShopKernel,
  crowdCount,
  guard,
  HIGH_SCALE,
  LOW_SCALE,
  phrase,
  PHRASE,
  phraseCell,
  type Phrase,
  pitchOffset,
  readCoffeeShopOptions,
  roomDb,
  STEAM_LONGEST,
  STEAM_STREAM,
  steamEnvelope,
  steamRate,
  syllable,
  syllableCell,
  syllableEnvelope,
  SYLLABLE_LENGTH,
  TALKER_PAN,
  talkerVoice,
  VOWEL_SPREAD,
  VOWELS,
} from "./coffee-shop-dsp";
import { MAX_CROWD } from "./coffee-shop.meta";

const SR = 48000;
const QUANTUM = 128;

const db = (x: number) => 20 * Math.log10(x);
const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const newPhrase = (): Phrase => ({
  speaking: false,
  start: 0,
  length: 0,
  question: false,
  register: 0,
  levelDb: 0,
});

interface Settings {
  seed?: number;
  crowd?: number;
  clatter?: number;
  sampleRate?: number;
  everyone?: boolean;
  /** A change of Crowd at a time, in seconds from the render's start. */
  change?: { at: number; crowd: number };
}

/** Renders `seconds` from absolute second `from`, a quantum at a time, as four channels. */
function render(
  seconds: number,
  { seed = 1, crowd = 6, clatter = 40, sampleRate = SR, everyone = false, change }: Settings = {},
  from = 0,
): Float32Array[] {
  const kernel = new CoffeeShopKernel(seed, sampleRate, everyone);
  kernel.set(crowd, clatter);
  const length = Math.round(seconds * sampleRate);
  const start = Math.round(from * sampleRate);
  const out = Array.from({ length: COFFEE_SHOP_CHANNELS }, () => new Float32Array(length));
  const block = Array.from({ length: COFFEE_SHOP_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let done = 0; done < length; done += QUANTUM) {
    if (change && done >= change.at * sampleRate) {
      kernel.set(change.crowd, clatter);
    }
    kernel.render(block, start + done);
    for (const [c, channel] of out.entries()) {
      channel.set((block[c] ?? new Float32Array()).subarray(0, length - done), done);
    }
  }
  return out;
}

/** The largest difference between `a` and `b` from sample `from` to `to`. */
function worstDifference(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let worst = 0;
  for (let i = from; i < to; i++) {
    worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return worst;
}

/** Whether talker `index` sounds anywhere from `from` to `to` seconds, by its syllables and phrases. */
function talks(seed: number, index: number, from: number, to: number): boolean {
  const voice = talkerVoice(seed, index);
  const p = newPhrase();
  for (let cell = syllableCell(voice, from) - 1; cell <= syllableCell(voice, to) + 1; cell++) {
    const s = syllable(seed, index, cell);
    const centre = (s.start + s.end) / 2;
    phrase(seed, index, phraseCell(seed, index, centre), p);
    const along = centre - p.start;
    if (p.speaking && along >= 0 && along < p.length && !s.dropped) {
      if (s.end > from && s.start < to) {
        return true;
      }
    }
  }
  return false;
}

describe("params", () => {
  it("clinks up to 0.4 times a second, in proportion to Clatter, and never at 0", () => {
    expect(clinkRate(0)).toBe(0);
    expect(clinkRate(100)).toBeCloseTo(0.4);
    expect(clinkRate(50)).toBeCloseTo(0.2);
  });

  it("hisses about every 4 minutes at Clatter 50, and never at 0", () => {
    expect(steamRate(0)).toBe(0);
    expect(1 / steamRate(50)).toBeCloseTo(240);
    expect(steamRate(100)).toBeCloseTo(2 * steamRate(50));
  });

  it("sends the talkers from −14 to −2 dB as Room size goes from 0 to 100", () => {
    expect(roomDb(0)).toBeCloseTo(-14);
    expect(roomDb(100)).toBeCloseTo(-2);
    expect(roomDb(50)).toBeCloseTo(-8);
  });

  it("counts whole people, within the pool", () => {
    expect(crowdCount(6.4)).toBe(6);
    expect(crowdCount(99)).toBe(MAX_CROWD);
    expect(crowdCount(-1)).toBe(0);
  });
});

describe("voices", () => {
  it.each(Array.from({ length: MAX_CROWD }, (_, i) => i))(
    "talker %d's voice is deterministic and within its ranges",
    (index) => {
      for (let seed = 1; seed <= 30; seed++) {
        const v = talkerVoice(seed, index);
        expect(talkerVoice(seed, index)).toEqual(v);
        // A low voice or a high one, each with its own vocal tract.
        const [pitches, scales] =
          v.pitch >= 170 ? [[170, 230], HIGH_SCALE] : [[95, 135], LOW_SCALE];
        expect(v.pitch).toBeGreaterThanOrEqual(pitches[0] ?? 0);
        expect(v.pitch).toBeLessThanOrEqual(pitches[1] ?? 0);
        expect(v.scale).toBeGreaterThanOrEqual(scales[0]);
        expect(v.scale).toBeLessThanOrEqual(scales[1]);
        expect(v.rate).toBeGreaterThanOrEqual(4);
        expect(v.rate).toBeLessThanOrEqual(5.2);
        expect(v.levelDb).toBeGreaterThanOrEqual(-16);
        expect(v.levelDb).toBeLessThanOrEqual(-4);
        expect(Math.abs(v.pan)).toBeLessThanOrEqual(TALKER_PAN);
      }
    },
  );

  it("gives about half the talkers high voices", () => {
    let high = 0;
    for (let seed = 1; seed <= 100; seed++) {
      for (let i = 0; i < MAX_CROWD; i++) {
        high += talkerVoice(seed, i).pitch >= 170 ? 1 : 0;
      }
    }
    expect(high / (100 * MAX_CROWD)).toBeGreaterThan(0.45);
    expect(high / (100 * MAX_CROWD)).toBeLessThan(0.55);
  });

  it.each([22050, 44100, 48000])(
    "keeps every vowel's formants in range and below 0.45 × %d Hz once scaled",
    (sampleRate) => {
      const highest = Math.max(HIGH_SCALE[1], LOW_SCALE[1]) * (1 + VOWEL_SPREAD);
      const lowest = Math.min(HIGH_SCALE[0], LOW_SCALE[0]) * (1 - VOWEL_SPREAD);
      for (const [f1, f2, f3] of VOWELS) {
        expect(f1).toBeGreaterThanOrEqual(250);
        expect(f1).toBeLessThan(f2);
        expect(f2).toBeLessThan(f3);
        expect(f1 * lowest).toBeGreaterThan(200);
        expect(f3 * highest).toBeLessThan(0.45 * sampleRate);
      }
    },
  );
});

describe("syllables and phrases", () => {
  it("are deterministic, each syllable inside its own cell", () => {
    for (let index = 0; index < MAX_CROWD; index++) {
      const voice = talkerVoice(5, index);
      for (let cell = -3; cell < 200; cell++) {
        const s = syllable(5, index, cell);
        expect(syllable(5, index, cell)).toEqual(s);
        const cellStart = voice.offset + cell / voice.rate;
        expect(s.start).toBeGreaterThan(cellStart);
        expect(s.end).toBeLessThan(cellStart + 1 / voice.rate);
        const share = (s.end - s.start) * voice.rate;
        expect(share).toBeGreaterThanOrEqual(SYLLABLE_LENGTH[0] - 1e-9);
        expect(share).toBeLessThanOrEqual(SYLLABLE_LENGTH[1] + 1e-9);
        expect(syllableCell(voice, (s.start + s.end) / 2)).toBe(cell);
      }
    }
  });

  it("depend only on the seed, the talker and the time", () => {
    const a = syllable(3, 4, 1000);
    syllable(9, 1, 77);
    expect(syllable(3, 4, 1000)).toEqual(a);
    const p = phrase(3, 4, 55, newPhrase());
    phrase(4, 4, 55, newPhrase());
    expect(phrase(3, 4, 55, newPhrase())).toEqual(p);
  });

  it("start and end silent, with raised-cosine edges", () => {
    expect(syllableEnvelope(1, 1, 1.2)).toBe(0);
    expect(syllableEnvelope(1.2, 1, 1.2)).toBe(0);
    expect(syllableEnvelope(1.0001, 1, 1.2)).toBeLessThan(0.001);
    expect(syllableEnvelope(1.1, 1, 1.2)).toBe(1);
    expect(syllableEnvelope(0.9, 1, 1.2)).toBe(0);
  });

  it("let each talker of a pair speak about half the time, mostly in turn", () => {
    const p = newPhrase();
    const q = newPhrase();
    let first = 0;
    let second = 0;
    let both = 0;
    const cells = 2000;
    for (let cell = 0; cell < cells; cell++) {
      phrase(2, 6, cell, p);
      phrase(2, 7, cell, q);
      first += p.speaking ? 1 : 0;
      second += q.speaking ? 1 : 0;
      both += p.speaking && q.speaking ? 1 : 0;
    }
    expect(first / cells).toBeGreaterThan(0.43);
    expect(first / cells).toBeLessThan(0.55);
    expect(second / cells).toBeGreaterThan(0.43);
    expect(second / cells).toBeLessThan(0.55);
    expect(both / cells).toBeLessThan(0.1);
  });

  it("share a pair's phrase grid, a phrase long", () => {
    const p = phrase(4, 2, 10, newPhrase());
    const q = phrase(4, 3, 10, newPhrase());
    expect(p.start).toBe(q.start);
    expect(phraseCell(4, 2, p.start + PHRASE / 2)).toBe(10);
    expect(phraseCell(4, 2, p.start + PHRASE + 0.01)).toBe(11);
  });

  it("fall about 2 semitones across a phrase, rising at the end of a question", () => {
    const s = syllable(1, 0, 0);
    const flat = { ...s, stress: 0 };
    const p: Phrase = { ...newPhrase(), speaking: true, start: 0, length: 2.5 };
    expect(pitchOffset(0, flat, p) - pitchOffset(2.5, flat, p)).toBeCloseTo(2);
    const question = { ...p, question: true };
    expect(pitchOffset(2.5, flat, question)).toBeGreaterThan(pitchOffset(1.5, flat, question));
    const stressed = { ...flat, stress: 1, start: 1, end: 1.2 };
    expect(pitchOffset(1.1, stressed, p) - pitchOffset(1.1, flat, p)).toBeCloseTo(3);
  });
});

describe("clinks", () => {
  it("are deterministic per hash and within their ranges", () => {
    let doubles = 0;
    for (let i = 0; i < 300; i++) {
      const hash = eventHash(7, CLINK_STREAM, i, 0);
      const clink = clinkShape(hash);
      expect(clinkShape(hash)).toEqual(clink);
      expect(clink.base).toBeGreaterThanOrEqual(1600);
      expect(clink.base).toBeLessThanOrEqual(3200);
      expect(clink.decay).toBeGreaterThanOrEqual(0.25);
      expect(clink.decay).toBeLessThanOrEqual(0.6);
      expect(db(clink.peak)).toBeGreaterThanOrEqual(-30.001);
      expect(db(clink.peak)).toBeLessThanOrEqual(-17.999);
      expect(Math.abs(clink.pan)).toBeLessThanOrEqual(CLINK_PAN);
      doubles += clink.delay > 0 ? 1 : 0;
      // A single clink's delay is 0; a double's second comes 60–140 ms after the first.
      expect(clink.delay === 0 || (clink.delay >= 0.06 && clink.delay <= 0.14)).toBe(true);
      // Both have died away 90 dB by the time the kernel stops picking them up.
      expect(clink.delay + clink.decay * 1.5).toBeLessThan(CLINK_LONGEST);
    }
    expect(doubles / 300).toBeGreaterThan(0.25);
    expect(doubles / 300).toBeLessThan(0.42);
  });

  it("ring a fundamental under the comfort ceiling, with ceramic ratios above it", () => {
    expect(CLINK_RATIOS[0]).toBe(1);
    expect(3200).toBeLessThan(CLINK_TOP);
  });

  it("come at the clatter's rate over a long run", () => {
    const events = createEventBlock(8);
    let count = 0;
    const seconds = 7200;
    for (let b = 0; b < seconds; b++) {
      count += eventsInBlock(1, CLINK_STREAM, b, clinkRate(40), events);
    }
    expect(count / seconds).toBeGreaterThan(0.14);
    expect(count / seconds).toBeLessThan(0.18);
  });
});

describe("steam", () => {
  it("fades in and out over 1.5 s, never suddenly", () => {
    expect(steamEnvelope(0, 6)).toBe(0);
    expect(steamEnvelope(6, 6)).toBe(0);
    expect(steamEnvelope(1.5, 6)).toBeCloseTo(1);
    expect(steamEnvelope(3, 6)).toBe(1);
    // No step between neighbouring milliseconds bigger than a smooth 1.5 s fade's.
    for (let t = 0; t < 6; t += 0.001) {
      expect(Math.abs(steamEnvelope(t + 0.001, 6) - steamEnvelope(t, 6))).toBeLessThan(0.0011);
    }
  });

  it("comes rarely, within the longest the kernel picks up", () => {
    const events = createEventBlock(4);
    let count = 0;
    const seconds = 3600 * 6;
    for (let b = 0; b < seconds; b++) {
      count += eventsInBlock(1, STEAM_STREAM, b, steamRate(50), events);
    }
    expect(seconds / count).toBeGreaterThan(180);
    expect(seconds / count).toBeLessThan(320);
    expect(STEAM_LONGEST).toBe(9);
  });
});

describe("guard", () => {
  it("passes quiet samples unchanged and never exceeds −3 dBFS", () => {
    expect(guard(0.1)).toBe(0.1);
    expect(guard(-0.2)).toBe(-0.2);
    for (const x of [0.5, 1, 4, 100, -100]) {
      expect(Math.abs(guard(x))).toBeLessThan(10 ** (-3 / 20));
    }
  });
});

describe("kernel", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    const a = render(3, { seed: 4 });
    const b = render(3, { seed: 4 });
    const c = render(3, { seed: 5 });
    expect(worstDifference(a[0], b[0], 0, a[0].length)).toBe(0);
    expect(worstDifference(a[0], c[0], 0, a[0].length)).toBeGreaterThan(0.01);
  });

  it("is time-addressable: 10–20 s rendered alone matches 0–20 s in one go, after settling", () => {
    const whole = render(20, { clatter: 100 });
    const late = render(10, { clatter: 100 }, 10);
    for (const c of [0, 1, 2, 3]) {
      const a = whole[c];
      const b = late[c];
      let worst = 0;
      for (let i = Math.round(0.2 * SR); i < b.length; i++) {
        worst = Math.max(worst, Math.abs((b[i] ?? 0) - (a[i + 10 * SR] ?? 0)));
      }
      expect(db(worst / peakOf(a))).toBeLessThan(-60);
    }
  });

  it("leaves talkers 0–5 untouched when Crowd goes from 6 to 7", () => {
    const six = render(12, { seed: 3, crowd: 6 });
    const seven = render(12, { seed: 3, crowd: 6, change: { at: 4, crowd: 7 } });
    // Before the change, nothing differs.
    expect(worstDifference(six[0], seven[0], 0, 4 * SR)).toBe(0);
    // After it, they differ only while the newcomer talks.
    const quiet: number[] = [];
    for (let t = 4; t + 0.5 <= 12; t += 0.25) {
      if (!talks(3, 6, t - 0.1, t + 0.5)) {
        quiet.push(t);
      }
    }
    expect(quiet.length).toBeGreaterThan(0);
    for (const t of quiet) {
      const from = Math.round(t * SR);
      for (const c of [0, 1]) {
        expect(worstDifference(six[c], seven[c], from, from + SR / 2)).toBeLessThan(1e-4);
      }
    }
    // And the newcomer is heard.
    expect(worstDifference(six[0], seven[0], 4 * SR, 12 * SR)).toBeGreaterThan(0.001);
  });

  it("fades a new talker in rather than starting them at full level", () => {
    const six = render(8, { seed: 2, crowd: 6, everyone: true });
    const seven = render(8, { seed: 2, crowd: 6, everyone: true, change: { at: 2, crowd: 7 } });
    const energy = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
        sum += ((seven[0][i] ?? 0) - (six[0][i] ?? 0)) ** 2;
      }
      return sum;
    };
    expect(energy(2, 2.3)).toBeLessThan(energy(4, 4.3) / 4);
  });

  it.each([44100, 48000])(
    "keeps under −3 dBFS with everyone talking and every cup clinking, at %d Hz",
    (sampleRate) => {
      const out = render(10, { crowd: 12, clatter: 100, everyone: true, sampleRate });
      for (const channel of out.slice(0, 2)) {
        for (const x of channel) {
          expect(Number.isFinite(x)).toBe(true);
        }
        expect(db(peakOf(channel))).toBeLessThan(-3);
      }
    },
  );

  it.each([2, 6, 12])("makes no NaN or Infinity at Crowd %d, at 22.05 kHz", (crowd) => {
    const out = render(4, { crowd, clatter: 100, sampleRate: 22050 });
    for (const channel of out) {
      for (const x of channel) {
        expect(Number.isFinite(x)).toBe(true);
      }
    }
  });

  it("is louder with more people, and never silent", () => {
    const level = (crowd: number) => {
      const [l] = render(20, { crowd, clatter: 0 });
      let sum = 0;
      for (const x of l) {
        sum += x * x;
      }
      return 10 * Math.log10(sum / l.length);
    };
    const two = level(2);
    const twelve = level(12);
    expect(two).toBeGreaterThan(-40);
    expect(twelve).toBeGreaterThan(two + 3);
  });

  it("starts clinks and steam, and picks them up part-way after a jump", () => {
    const kernel = new CoffeeShopKernel(1, SR);
    kernel.set(6, 100);
    const block = Array.from({ length: COFFEE_SHOP_CHANNELS }, () => new Float32Array(QUANTUM));
    let clinks = 0;
    let steam = 0;
    let talking = 0;
    for (let n = 0; n < 1800 * SR; n += 7 * SR) {
      kernel.render(block, n);
      clinks = Math.max(clinks, kernel.clinksRinging);
      steam = Math.max(steam, kernel.steamSounding);
      talking = Math.max(talking, kernel.talkersActive);
    }
    expect(clinks).toBeGreaterThan(0);
    expect(steam).toBeGreaterThan(0);
    expect(talking).toBeGreaterThan(0);
    expect(talking).toBeLessThanOrEqual(6);
  });
});

describe("options", () => {
  it("reads the seed and offset, falling back to safe defaults", () => {
    expect(readCoffeeShopOptions({ seed: 7.8, offset: 2.5 })).toEqual({ seed: 7, offset: 2.5 });
    expect(readCoffeeShopOptions(null)).toEqual({ seed: 0, offset: 0 });
    expect(readCoffeeShopOptions({ seed: "x", offset: Number.NaN })).toEqual({
      seed: 0,
      offset: 0,
    });
  });
});
