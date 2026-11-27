import { describe, expect, it } from "vitest";
import { hash32 } from "../../audio/random";
import {
  ACTIVITY_RATES,
  ALERT_END,
  ALERT_PEAK,
  ALERT_PERIOD,
  ALERT_STEP,
  alertAt,
  BED_LEFT,
  BED_RIGHT,
  BLIP_PEAK,
  BRIDGE_CHANNELS,
  BridgeKernel,
  buildVocabulary,
  CONSOLES,
  DOOR_PEAK,
  DOOR_RATES,
  doorCentre,
  doorEnvelope,
  doorLength,
  ENGINE_DRIFT,
  EVENTS_LEFT,
  EVENTS_RIGHT,
  guard,
  MAX_NOTES,
  noteDuration,
  PHRASES,
  pickHash,
  readBridgeOptions,
  ROOT_HIGH,
  ROOT_LOW,
  STEPS,
  ROOM_DB,
  TOP_NOTE,
  VENT_UNDER_ROOM_DB,
  ventShare,
} from "./bridge-dsp";

const SR = 48000;
const QUANTUM = 128;

interface Settings {
  seed?: number;
  rate?: number;
  doors?: number;
  alert?: number;
  air?: number;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  rate = ACTIVITY_RATES.normal,
  doors = 0,
  alert = 0,
  air = 50,
  sampleRate = SR,
}: Settings = {}) {
  const k = new BridgeKernel(seed, sampleRate);
  k.set(rate, doors, alert, air);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: BridgeKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: BRIDGE_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: BRIDGE_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    const length = Math.min(QUANTUM, to - n);
    const buffers =
      length === QUANTUM
        ? quantum
        : Array.from({ length: BRIDGE_CHANNELS }, () => new Float32Array(length));
    k.render(buffers, n);
    buffers.forEach((b, c) => {
      out[c]?.set(b, n - from);
    });
  }
  return out;
}

const peakOf = (x: Float32Array, from = 0, to = x.length) => {
  let peak = 0;
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, Math.abs(x[i] ?? 0));
  }
  return peak;
};

const events = (out: Float32Array[]) => [out[EVENTS_LEFT], out[EVENTS_RIGHT]] as const;

describe("vocabulary", () => {
  const SEEDS = [1, 2, 3, 17, 99, 512, 999];

  it("is the same for the same seed and differs for another", () => {
    expect(buildVocabulary(5)).toEqual(buildVocabulary(5));
    expect(buildVocabulary(5)).not.toEqual(buildVocabulary(6));
  });

  it.each(SEEDS)(
    "seed %i has 16 phrases of one to four notes, on a root of 880–1320 Hz",
    (seed) => {
      const v = buildVocabulary(seed);
      expect(v.root).toBeGreaterThanOrEqual(ROOT_LOW);
      expect(v.root).toBeLessThan(ROOT_HIGH);
      expect(v.phrases).toHaveLength(PHRASES);
      for (const phrase of v.phrases) {
        expect(phrase.notes.length).toBeGreaterThanOrEqual(1);
        expect(phrase.notes.length).toBeLessThanOrEqual(MAX_NOTES);
      }
    },
  );

  it.each(SEEDS)("seed %i keeps every note between 880 Hz and 4 kHz", (seed) => {
    for (const phrase of buildVocabulary(seed).phrases) {
      for (const note of phrase.notes) {
        expect(note.frequency).toBeGreaterThanOrEqual(ROOT_LOW);
        expect(note.frequency).toBeLessThanOrEqual(TOP_NOTE);
      }
    }
  });

  it.each(SEEDS)("seed %i steps only by unisons, thirds, fourths and fifths", (seed) => {
    const allowed: number[] = STEPS.flatMap((s) => [s, -s]);
    for (const phrase of buildVocabulary(seed).phrases) {
      phrase.notes.slice(1).forEach((note, i) => {
        const before = phrase.notes[i];
        expect(allowed).toContain(note.semitone - before.semitone);
        const semitones = 12 * Math.log2(note.frequency / before.frequency);
        expect(allowed).toContain(Math.round(semitones));
      });
    }
  });

  it.each(SEEDS)("seed %i has two or three rising acknowledgement pairs", (seed) => {
    const pairs = buildVocabulary(seed).phrases.filter((p) => p.acknowledge);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.length).toBeLessThanOrEqual(3);
    for (const pair of pairs) {
      expect(pair.notes).toHaveLength(2);
      const [first, second] = pair.notes.map((n) => n.frequency);
      expect(second).toBeGreaterThan(first);
    }
  });

  it.each(SEEDS)("seed %i shapes notes and spaces them as consoles do", (seed) => {
    const phrases = buildVocabulary(seed).phrases;
    const notes = phrases.flatMap((p) => p.notes);
    const fm = notes.filter((n) => n.ratio > 0);
    for (const note of notes) {
      expect(note.length).toBeGreaterThanOrEqual(0.025);
      expect(note.length).toBeLessThanOrEqual(0.14);
    }
    for (const note of fm) {
      expect([1, 2, 3]).toContain(note.ratio);
      expect(note.index).toBeGreaterThanOrEqual(0.3);
      expect(note.index).toBeLessThanOrEqual(1.5);
      // The second sidebands stay well under 8 kHz.
      expect(note.frequency * (1 + 2 * note.ratio)).toBeLessThanOrEqual(8000);
    }
    const gaps = phrases.flatMap((p) => p.notes.slice(1).map((n, i) => n.onset - p.notes[i].onset));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(0.05);
      expect(gap).toBeLessThanOrEqual(0.12);
    }
  });

  it.each(SEEDS)("seed %i places five consoles, each phrase on one or two", (seed) => {
    const v = buildVocabulary(seed);
    expect(v.consoles).toHaveLength(CONSOLES);
    for (const c of v.consoles) {
      expect(Math.abs(c.pan)).toBeLessThanOrEqual(0.7);
      expect(Math.abs(20 * Math.log10(c.gain))).toBeLessThanOrEqual(3);
    }
    for (const phrase of v.phrases) {
      expect([1, 2]).toContain(phrase.consoles.length);
      expect(new Set(phrase.consoles).size).toBe(phrase.consoles.length);
    }
  });

  it("picks phrases with hash32(seed, 2, block, event)", () => {
    expect(pickHash(7, 123, 4)).toBe(hash32(7, 2, 123, 4));
    expect(pickHash(7, -3, 0)).toBe(hash32(7, 2, -3, 0));
  });

  it("lets a note ring until 60 dB down, a little over twice its length", () => {
    const note = buildVocabulary(1).phrases[0].notes[0];
    expect(noteDuration(note)).toBeCloseTo(0.003 + (note.length / 3) * Math.log(1000), 9);
  });
});

describe("doors", () => {
  it("last 0.7–1.1 s", () => {
    for (let h = 0; h < 200; h++) {
      const length = doorLength(hash32(h));
      expect(length).toBeGreaterThanOrEqual(0.7);
      expect(length).toBeLessThanOrEqual(1.1);
    }
  });

  it("sweep from 500 Hz up to 1600 Hz and back down to 700 Hz", () => {
    expect(doorCentre(0, 1, 0.4)).toBeCloseTo(500, 6);
    expect(doorCentre(0.4, 1, 0.4)).toBeCloseTo(1600, 6);
    expect(doorCentre(0.999_999, 1, 0.4)).toBeCloseTo(700, 2);
  });

  it("swell in over 180 ms and fade to nothing at their end", () => {
    expect(doorEnvelope(0, 1)).toBe(0);
    expect(doorEnvelope(0.09, 1)).toBeCloseTo(0.5, 6);
    expect(doorEnvelope(0.18, 1)).toBeCloseTo(1, 6);
    expect(doorEnvelope(0.999_99, 1)).toBeLessThan(1e-6);
    expect(doorEnvelope(1, 1)).toBe(0);
  });

  it("whoosh softly when they come", () => {
    // A door a second, so a few seconds hold several.
    const k = kernel({ rate: 0, doors: 1 });
    const [left, right] = events(render(k, 0, 6 * SR));
    const peak = Math.max(peakOf(left), peakOf(right));
    expect(peak).toBeGreaterThan(DOOR_PEAK * 0.3);
    expect(peak).toBeLessThan(DOOR_PEAK * 2);
  });

  it("stay silent when off", () => {
    const k = kernel({ rate: 0, doors: DOOR_RATES.off });
    const [left, right] = events(render(k, 0, 20 * SR));
    expect(peakOf(left) + peakOf(right)).toBe(0);
  });
});

describe("alert", () => {
  it("is a falling major third: the second note starts 280 ms after the first", () => {
    expect(alertAt(0)).toBe(0);
    expect(Math.abs(alertAt(0.1))).toBeGreaterThan(0);
    expect(ALERT_STEP).toBeCloseTo(0.28, 9);
    expect(alertAt(ALERT_END + 0.01)).toBe(0);
  });

  it("is silent when off", () => {
    const k = kernel({ rate: 0, alert: 0 });
    const [left] = events(render(k, 0, 13 * SR));
    expect(peakOf(left)).toBe(0);
  });

  it("lands at multiples of 6 s of absolute time when on", () => {
    const k = kernel({ rate: 0, alert: 1 });
    const from = 5 * SR;
    const [left, right] = events(render(k, from, 19 * SR));
    for (const t of [6, 12, 18]) {
      const at = t * SR - from;
      // Nothing just before the period starts (the comfort low-pass's ringing
      // apart), then the tone.
      expect(peakOf(left, at - SR, at)).toBeLessThan(1e-6);
      expect(peakOf(left, at, at + 0.4 * SR)).toBeGreaterThan(ALERT_PEAK * 0.3);
      expect(peakOf(left, at + Math.ceil((ALERT_END + 0.05) * SR), at + 4 * SR)).toBe(0);
    }
    // Centred.
    expect(left).toEqual(right);
    expect(ALERT_PERIOD).toBe(6);
  });

  it("stays under a console blip", () => {
    expect(ALERT_PEAK).toBeLessThan(BLIP_PEAK);
    const k = kernel({ rate: 0, alert: 1 });
    const [left] = events(render(k, 0, 7 * SR));
    expect(peakOf(left)).toBeLessThanOrEqual(ALERT_PEAK);
  });
});

describe("BridgeKernel", () => {
  it("gives the same output for the same seed, params and start, and another for another seed", () => {
    const settings = { rate: ACTIVITY_RATES.busy, doors: 0.5, alert: 1 };
    const a = render(kernel(settings), 0, 4 * SR);
    const b = render(kernel(settings), 0, 4 * SR);
    const c = render(kernel({ ...settings, seed: 2 }), 0, 4 * SR);
    expect(a).toEqual(b);
    expect(a[EVENTS_LEFT]).not.toEqual(c[EVENTS_LEFT]);
    expect(a[BED_LEFT]).not.toEqual(c[BED_LEFT]);
  });

  it("is time-addressable: a render from 100 s matches one from 95 s", () => {
    const settings = { seed: 3, rate: ACTIVITY_RATES.busy, doors: 0.5, alert: 1 };
    const from = 95 * SR;
    const start = 100 * SR;
    const to = 110 * SR;
    const unbroken = render(kernel(settings), from, to);
    const fresh = render(kernel(settings), start, to);
    for (let c = 0; c < BRIDGE_CHANNELS; c++) {
      const whole = unbroken[c] ?? new Float32Array(0);
      const tail = fresh[c] ?? new Float32Array(0);
      // The bed's filters settle within a few tens of milliseconds.
      const settle = c === BED_LEFT || c === BED_RIGHT ? Math.round(0.2 * SR) : 0;
      let worst = 0;
      for (let i = settle; i < tail.length; i++) {
        worst = Math.max(worst, Math.abs((whole[i + start - from] ?? 0) - (tail[i] ?? 0)));
      }
      expect(worst).toBeLessThan(1e-4 * Math.max(1e-3, peakOf(tail)));
    }
  });

  it("sounds phrases at about the Activity's rate", () => {
    const k = kernel({ rate: ACTIVITY_RATES.busy });
    const [left, right] = events(render(k, 0, 60 * SR));
    let seconds = 0;
    for (let s = 0; s < 60; s++) {
      if (peakOf(left, s * SR, (s + 1) * SR) + peakOf(right, s * SR, (s + 1) * SR) > 0) {
        seconds++;
      }
    }
    // One phrase every 2 s, each under a second: about 20–35 seconds of 60 hold one.
    expect(seconds).toBeGreaterThan(12);
    expect(seconds).toBeLessThan(45);
  });

  it("is silent between events, with no activity, doors or alert", () => {
    const k = kernel({ rate: 0 });
    const [left, right] = events(render(k, 0, 10 * SR));
    expect(peakOf(left) + peakOf(right)).toBe(0);
    expect(k.sounding).toBe(0);
  });

  it.each([1, 2, 3, 42, 500, 999])(
    "stays finite and under −6 dBFS with Busy, doors Sometimes and the alert on, seed %i",
    (seed) => {
      const k = kernel({ seed, rate: ACTIVITY_RATES.busy, doors: DOOR_RATES.sometimes, alert: 1 });
      const out = render(k, 0, 30 * SR);
      for (const channel of out) {
        expect(channel.every((x) => Number.isFinite(x))).toBe(true);
      }
      const [left, right] = events(out);
      expect(20 * Math.log10(Math.max(peakOf(left), peakOf(right)))).toBeLessThanOrEqual(-6);
    },
  );

  it.each([SR, 44100])("sets the room tone and the ventilation's levels at %i Hz", (sampleRate) => {
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);
    const db = (x: Float32Array) => 20 * Math.log10(rms(x));
    const bed = (air: number) => {
      const out = render(kernel({ rate: 0, air, sampleRate }), 0, 20 * sampleRate);
      return [out[BED_LEFT], out[BED_RIGHT]] as const;
    };
    const [roomLeft, roomRight] = bed(0);
    expect(db(roomLeft)).toBeCloseTo(ROOM_DB, 0);
    expect(db(roomRight)).toBeCloseTo(ROOM_DB, 0);
    // The room tone is the same at any Ventilation, so the difference is the ventilation alone.
    const [bothLeft] = bed(50);
    const vent = bothLeft.map((x, i) => x - roomLeft[i]);
    expect(Math.abs(db(vent) - (ROOM_DB + VENT_UNDER_ROOM_DB))).toBeLessThan(1);
  });

  it("raises the ventilation from none at 0 to 6 dB over its default at 100", () => {
    expect(ventShare(0)).toBe(0);
    expect(ventShare(50)).toBe(1);
    expect(ventShare(100)).toBe(2);
    expect(ventShare(150)).toBe(2);
  });

  it("decorrelates the bed's sides", () => {
    const out = render(kernel(), 0, 2 * SR);
    expect(out[BED_RIGHT]).not.toEqual(out[BED_LEFT]);
  });

  it("keeps the engine's drift within ±1 and moving slowly", () => {
    const drift = render(kernel(), 0, 60 * SR)[ENGINE_DRIFT];
    expect(peakOf(drift)).toBeLessThanOrEqual(1);
    expect(peakOf(drift)).toBeGreaterThan(0.05);
    let step = 0;
    for (let i = 1; i < drift.length; i++) {
      step = Math.max(step, Math.abs(drift[i] - drift[i - 1]));
    }
    expect(step).toBeLessThan(1e-4);
  });

  it("works at 44.1 kHz at about the same level", () => {
    const at = (sampleRate: number) => {
      const k = kernel({ rate: 0, doors: 1, alert: 1, sampleRate });
      const [left] = events(render(k, 0, 6 * sampleRate));
      let sum = 0;
      for (const x of left) {
        sum += x * x;
      }
      return 10 * Math.log10(sum / left.length);
    };
    expect(Math.abs(at(44100) - at(SR))).toBeLessThan(1.5);
  });
});

describe("guard", () => {
  it("leaves quiet samples alone and never passes −6 dBFS", () => {
    expect(guard(0.1)).toBe(0.1);
    expect(guard(-0.1)).toBe(-0.1);
    expect(guard(10)).toBeLessThanOrEqual(10 ** (-6 / 20));
    expect(guard(-10)).toBeGreaterThanOrEqual(-(10 ** (-6 / 20)));
  });
});

describe("readBridgeOptions", () => {
  it("reads processor options, falling back to safe defaults", () => {
    expect(readBridgeOptions({ seed: 4.7, offset: 2.5 })).toEqual({ seed: 4, offset: 2.5 });
    expect(readBridgeOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readBridgeOptions({ seed: "x", offset: Number.NaN })).toEqual({ seed: 0, offset: 0 });
  });
});
