/**
 * Starship Bridge's seeded signals and events, and the param mappings the
 * rest of the sound uses: pure code with no Web Audio globals, run by
 * `bridge.worklet.ts` and checked in Node.
 *
 * The worklet makes everything that depends on the seed, so a seed change
 * crossfades one node, and the sound needs a single worklet node:
 *
 * - **The room's bed.** Decorrelated counter-hashed white noise per side,
 *   integrated into brown noise and filtered to a warm room tone between 60
 *   and 380 Hz, and band-passed around 900 Hz for the ventilation, whose
 *   level and centre drift slowly. Making it here rather than with native
 *   filters on the shared noise saves a dozen nodes.
 * - **Consoles.** At construction, a vocabulary of `PHRASES` short phrases
 *   of one to four notes on a pentatonic scale over a seeded root, each tied
 *   to one or two of `CONSOLES` places in the room. Phrases come at random
 *   from per-block hashes of absolute time (`eventsInBlock`), each picking
 *   its phrase and console from its own hash, so a change of rate applies
 *   from the next block and never touches a phrase already sounding. Each
 *   note is a sine or a two-operator FM blip with a 3 ms attack and an
 *   exponential decay, worked out from the time since it began.
 * - **Doors.** Now and then, a soft whoosh of counter-hashed white noise
 *   through a band-pass whose centre sweeps up and back down, off to one side.
 * - **Alert.** When on, a soft falling major third every `ALERT_PERIOD`
 *   seconds of absolute time, a closed-form function of the time, faded in
 *   and out by its level.
 * - **The engine's drift.** A slow random walk of absolute time for the
 *   native engine hum's level.
 *
 * The consoles, doors and alert share a comfort low-pass at 5 kHz, which
 * runs only while they sound. A render that starts afresh picks up the
 * phrases and doors already sounding, part-way through, then renders a short
 * warm-up silently, so it lands on the same samples as an unbroken render.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import {
  blockOf,
  createEventBlock,
  eventHash,
  eventsInBlock,
  type EventBlock,
} from "../../audio/dsp/events";
import { Envelope } from "../../audio/dsp/envelopes";
import { sine } from "../../audio/dsp/osc";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { VoicePool, type PoolVoice } from "../../audio/dsp/voices";
import { createRng, HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import type { BridgeActivity, BridgeDoors } from "./bridge.meta";

export const BRIDGE_PROCESSOR = "aural-bridge";

/** The worklet's output channels, in order. */
export const BED_LEFT = 0;
export const BED_RIGHT = 1;
export const EVENTS_LEFT = 2;
export const EVENTS_RIGHT = 3;
export const ENGINE_DRIFT = 4;
export const BRIDGE_CHANNELS = 5;

const dbToGain = (db: number) => 10 ** (db / 20);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Console phrases a second, on average, for each Activity. */
export const ACTIVITY_RATES: Readonly<Record<BridgeActivity, number>> = {
  quiet: 1 / 15,
  normal: 1 / 6,
  busy: 1 / 2,
};

/** Doors a second, on average, for each Doors setting. */
export const DOOR_RATES: Readonly<Record<BridgeDoors, number>> = {
  off: 0,
  rarely: 1 / 360,
  sometimes: 1 / 120,
};

/** Random streams: the room's noise, phrase times, phrase picks, doors, and the two drifts. */
const NOISE_STREAM = 0;
const PHRASE_STREAM = 1;
const PICK_STREAM = 2;
const DOOR_STREAM = 3;
const VENT_STREAM = 4;
const ENGINE_STREAM = 5;

/** The ventilation's drift: its rate in Hz and octaves. */
const VENT_DRIFT_RATE = 0.04;
const VENT_DRIFT_OCTAVES = 2;
/** The engine hum's drift. */
const ENGINE_DRIFT_RATE = 0.02;
const ENGINE_DRIFT_OCTAVES = 1;

/** The vocabulary: phrases, and the consoles they come from. */
export const PHRASES = 16;
export const CONSOLES = 5;
/** The root's range, and the highest note, in Hz. */
export const ROOT_LOW = 880;
export const ROOT_HIGH = 1320;
export const TOP_NOTE = 4000;
/** A major pentatonic scale over two octaves, in semitones above the root. */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24] as const;
/** Steps between a phrase's notes, in semitones either way: unison, major third, fourth, fifth. */
export const STEPS = [0, 4, 5, 7] as const;
/** The most notes in a phrase. */
export const MAX_NOTES = 4;
/** Notes' lengths, and the gaps between their onsets, in seconds. */
const LENGTH_LOW = 0.025;
const LENGTH_HIGH = 0.14;
const GAP_LOW = 0.05;
const GAP_HIGH = 0.12;
/** FM: the modulator's ratios, and the index's range (radians). */
const FM_RATIOS = [1, 2, 3] as const;
const INDEX_LOW = 0.3;
const INDEX_HIGH = 1.5;
/** An FM note's second sidebands stay under this, in Hz. */
const SIDEBAND_LIMIT = 8000;
/** Consoles' places, −0.7..0.7, and their levels, ±3 dB. */
const CONSOLE_PAN = 0.7;
const CONSOLE_DB = 3;

/** One note of a phrase. */
interface PhraseNote {
  /** Semitones above the root, and the frequency in Hz. */
  semitone: number;
  frequency: number;
  /** Seconds from the phrase's start. */
  onset: number;
  /** Seconds: the decay's time constant is a third of it. */
  length: number;
  /** The FM modulator's ratio to the note, or 0 for a plain sine. */
  ratio: number;
  /** The FM index at the note's peak, in radians. */
  index: number;
}

interface Phrase {
  notes: PhraseNote[];
  /** The consoles (indices) it comes from. */
  consoles: number[];
  /** A rising pair: an acknowledgement. */
  acknowledge: boolean;
}

interface Console {
  pan: number;
  gain: number;
}

interface Vocabulary {
  root: number;
  phrases: Phrase[];
  consoles: Console[];
}

/**
 * The notes of `scale` (as indices) one allowed step from note `from`: up or
 * down, or only up for a rising pair, which never repeats a note.
 */
function stepsFrom(scale: readonly number[], from: number, risingOnly: boolean): number[] {
  const here = scale[from] ?? 0;
  const targets: number[] = [];
  for (const step of STEPS) {
    const moves = step === 0 ? (risingOnly ? [] : [0]) : risingOnly ? [step] : [step, -step];
    for (const move of moves) {
      const target = scale.indexOf(here + move);
      if (target >= 0) {
        targets.push(target);
      }
    }
  }
  return targets;
}

/** A note at `semitone` above `root`, `onset` seconds into its phrase, with a seeded voice. */
function makeNote(
  rng: ReturnType<typeof createRng>,
  root: number,
  semitone: number,
  onset: number,
): PhraseNote {
  const frequency = root * 2 ** (semitone / 12);
  const length = rng.range(LENGTH_LOW, LENGTH_HIGH);
  const ratios = FM_RATIOS.filter((r) => frequency * (1 + 2 * r) <= SIDEBAND_LIMIT);
  const fm = rng.next() < 0.5 && ratios.length > 0;
  const ratio = fm ? (ratios[rng.int(ratios.length)] ?? 1) : 0;
  const index = fm ? rng.range(INDEX_LOW, INDEX_HIGH) : 0;
  return { semitone, frequency, onset, length, ratio, index };
}

/**
 * The console vocabulary for `seed`: a root, `CONSOLES` places, and `PHRASES`
 * phrases, the first two or three of them rising acknowledgement pairs.
 */
export function buildVocabulary(seed: number): Vocabulary {
  const rng = createRng(seed);
  const root = rng.range(ROOT_LOW, ROOT_HIGH);
  const scale = PENTATONIC.filter((s) => root * 2 ** (s / 12) <= TOP_NOTE);
  const consoles = Array.from({ length: CONSOLES }, () => ({
    pan: rng.range(-CONSOLE_PAN, CONSOLE_PAN),
    gain: dbToGain(rng.range(-CONSOLE_DB, CONSOLE_DB)),
  }));
  const acknowledgements = 2 + rng.int(2);
  const phrases = Array.from({ length: PHRASES }, (_, p): Phrase => {
    const acknowledge = p < acknowledgements;
    const count = acknowledge ? 2 : 1 + rng.int(MAX_NOTES);
    // An acknowledgement starts where a rising step can follow.
    const starts = acknowledge
      ? scale.map((_note, i) => i).filter((i) => stepsFrom(scale, i, true).length > 0)
      : scale.map((_note, i) => i);
    let at = starts[rng.int(starts.length)] ?? 0;
    let onset = 0;
    const notes: PhraseNote[] = [];
    for (let n = 0; n < count; n++) {
      if (n > 0) {
        const targets = stepsFrom(scale, at, acknowledge);
        // Any note can repeat, and an acknowledgement starts where it can rise.
        at = targets[rng.int(targets.length)] ?? at;
        onset += rng.range(GAP_LOW, GAP_HIGH);
      }
      notes.push(makeNote(rng, root, scale[at] ?? 0, onset));
    }
    const first = rng.int(CONSOLES);
    const second = rng.int(CONSOLES);
    const both = rng.next() < 0.5 && second !== first;
    return { notes, consoles: both ? [first, second] : [first], acknowledge };
  });
  return { root, phrases, consoles };
}

/** A phrase pick's hash: `hash32(seed, PICK_STREAM, block, event)`, without allocating. */
export function pickHash(seed: number, block: number, event: number): number {
  return hashStep(hashStep(hashStep(hashStep(HASH_START, seed), PICK_STREAM), block), event);
}

/** Levels: a console blip's peak (before its console's level and pan), the alert's and a door's. */
export const BLIP_PEAK = dbToGain(-23);
export const ALERT_PEAK = BLIP_PEAK * dbToGain(-4);
export const DOOR_PEAK = BLIP_PEAK * dbToGain(-6);

/** A note's attack, in seconds; it ends 60 dB down. */
const NOTE_ATTACK = 0.003;
const NOTE_END_DB = -60;
/** A note's decay time constant, as a share of its length. */
const DECAY_SHARE = 1 / 3;

/** How long a note sounds, in seconds, from its onset to 60 dB down. */
export function noteDuration(note: PhraseNote): number {
  return NOTE_ATTACK + note.length * DECAY_SHARE * Math.log(dbToGain(-NOTE_END_DB));
}

/** One console note sounding, or waiting for its onset. */
class NoteVoice implements PoolVoice {
  active = false;
  private readonly sampleRate: number;
  private readonly envelope: Envelope;
  /** Samples left before the note starts. */
  private delay = 0;
  private peak = 0;
  private phase = 0;
  private increment = 0;
  private modPhase = 0;
  private modIncrement = 0;
  /** The FM index in cycles per unit of envelope, or 0 for a sine. */
  private depth = 0;
  private gainLeft = 0;
  private gainRight = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.envelope = new Envelope(sampleRate, NOTE_END_DB);
  }

  /** A note waiting for its onset counts at its peak, so it is never the one stolen. */
  get level(): number {
    return this.delay > 0 ? this.peak : this.envelope.value;
  }

  /**
   * Starts `note` at `gain`, panned to `pan`, `elapsed` samples in (negative:
   * that many samples before its onset).
   */
  start(note: PhraseNote, gain: number, pan: number, elapsed: number): void {
    const sr = this.sampleRate;
    const into = Math.max(0, elapsed);
    this.delay = Math.max(0, -elapsed);
    this.peak = BLIP_PEAK * gain;
    this.envelope.attackDecay(this.peak, NOTE_ATTACK, note.length * DECAY_SHARE, into / sr);
    this.increment = note.frequency / sr;
    this.modIncrement = (note.frequency * note.ratio) / sr;
    const cycles = into * this.increment;
    const modCycles = into * this.modIncrement;
    this.phase = cycles - Math.floor(cycles);
    this.modPhase = modCycles - Math.floor(modCycles);
    this.depth = note.ratio > 0 ? note.index / (2 * Math.PI * this.peak) : 0;
    this.gainLeft = panLeft(pan);
    this.gainRight = panRight(pan);
    this.active = true;
  }

  /** Adds samples `from` to `to` into the outputs. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): void {
    const envelope = this.envelope;
    let i = from;
    if (this.delay > 0) {
      const wait = Math.min(this.delay, to - from);
      this.delay -= wait;
      i += wait;
    }
    let phase = this.phase;
    let modPhase = this.modPhase;
    for (; i < to; i++) {
      const e = envelope.next();
      const x =
        this.depth > 0 ? sine(phase + this.depth * e * sine(modPhase)) * e : sine(phase) * e;
      left[i] = (left[i] ?? 0) + x * this.gainLeft;
      right[i] = (right[i] ?? 0) + x * this.gainRight;
      phase += this.increment;
      modPhase += this.modIncrement;
      if (phase >= 1) {
        phase -= 1;
      }
      if (modPhase >= 1) {
        modPhase -= Math.floor(modPhase);
      }
      if (!envelope.active) {
        this.active = false;
        break;
      }
    }
    this.phase = phase;
    this.modPhase = modPhase;
  }
}

/** A door's length range, its attack, and its centre's sweep, in seconds and Hz. */
const DOOR_SHORTEST = 0.7;
const DOOR_LONGEST = 1.1;
const DOOR_ATTACK = 0.18;
const DOOR_FROM = 500;
const DOOR_TOP = 1600;
const DOOR_TO = 700;
const DOOR_Q = 1.5;
/** Where a door's centre peaks, as a share of its length. */
const DOOR_TURN_LOW = 0.3;
const DOOR_TURN_HIGH = 0.45;
/** Its place: 0.5–0.9 to one side. */
const DOOR_PAN_LOW = 0.5;
const DOOR_PAN_HIGH = 0.9;
/** Filtered noise's peaks against its RMS, to set a door's peak. */
const DOOR_CREST = 3.5;
/** The band-pass's centre is set on a grid of this many of the door's own samples. */
const CONTROL = 32;
/** Uniform noise in [−1, 1) has this variance. */
const UNIFORM_VARIANCE = 1 / 3;

/** Keys for a door's own random properties: `hashStep(hash, key)`. */
const LENGTH = 1;
const TURN = 2;
const SIDE = 3;
const PAN = 4;
const NOISE = 5;

const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;
const raised = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/** A door's length, in seconds, from its hash. */
export function doorLength(hash: number): number {
  return lerp(DOOR_SHORTEST, DOOR_LONGEST, unit(hash, LENGTH));
}

/** A door's band-pass centre `t` seconds in, for a door `length` long peaking at `turn` of it. */
export function doorCentre(t: number, length: number, turn: number): number {
  const x = t / length;
  return x < turn
    ? DOOR_FROM * (DOOR_TOP / DOOR_FROM) ** raised(x / turn)
    : DOOR_TOP * (DOOR_TO / DOOR_TOP) ** raised((x - turn) / (1 - turn));
}

/** A door's envelope (0–1) `t` seconds in: a raised-cosine attack, then a raised-cosine fall. */
export function doorEnvelope(t: number, length: number): number {
  if (t < 0 || t >= length) {
    return 0;
  }
  return t < DOOR_ATTACK
    ? raised(t / DOOR_ATTACK)
    : 1 - raised((t - DOOR_ATTACK) / (length - DOOR_ATTACK));
}

/** One door opening: counter-hashed white noise through a sweeping band-pass. */
class DoorVoice {
  active = false;
  private readonly sampleRate: number;
  private readonly svf: Svf;
  private noise = 0;
  private length = 1;
  private turn = 0.4;
  private end = 0;
  /** Samples since the door started. */
  private position = 0;
  /** The noise's gain for a peak of `DOOR_PEAK`, at the centre now. */
  private scale = 0;
  private gainLeft = 0;
  private gainRight = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.svf = new Svf(sampleRate, DOOR_FROM, DOOR_Q);
  }

  /** Starts the door with hash `hash`, `elapsed` samples in, unless it has already ended. */
  start(hash: number, elapsed: number): void {
    const sr = this.sampleRate;
    this.length = doorLength(hash);
    this.end = Math.floor(this.length * sr);
    if (elapsed >= this.end) {
      return;
    }
    this.turn = lerp(DOOR_TURN_LOW, DOOR_TURN_HIGH, unit(hash, TURN));
    const side = unit(hash, SIDE) < 0.5 ? -1 : 1;
    const pan = side * lerp(DOOR_PAN_LOW, DOOR_PAN_HIGH, unit(hash, PAN));
    this.gainLeft = panLeft(pan);
    this.gainRight = panRight(pan);
    this.noise = hashStep(hash, NOISE);
    this.position = Math.max(0, elapsed);
    this.svf.reset();
    this.control(this.position - (this.position % CONTROL));
    this.active = true;
  }

  /** Sets the band-pass and the noise's gain for the door's sample `n`. */
  private control(n: number): void {
    const sr = this.sampleRate;
    const centre = doorCentre(n / sr, this.length, this.turn);
    this.svf.set(centre, DOOR_Q);
    // A band-pass of peak gain 1 passes white noise's power over π·centre / 2Q.
    const rms = Math.sqrt((UNIFORM_VARIANCE * Math.PI * centre) / (2 * DOOR_Q) / (sr / 2));
    this.scale = DOOR_PEAK / (DOOR_CREST * rms);
  }

  /** Adds samples `from` to `to` into the outputs. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): void {
    const sr = this.sampleRate;
    const svf = this.svf;
    let n = this.position;
    const stop = Math.min(to, from + (this.end - n));
    for (let i = from; i < stop; i++) {
      if (n % CONTROL === 0) {
        this.control(n);
      }
      const white = hashStep(this.noise, n) * UINT32_SCALE * 2 - 1;
      svf.tick(white);
      const x = svf.band * this.scale * doorEnvelope(n / sr, this.length);
      left[i] = (left[i] ?? 0) + x * this.gainLeft;
      right[i] = (right[i] ?? 0) + x * this.gainRight;
      n++;
    }
    this.position = n;
    this.active = n < this.end;
  }
}

/** The alert: every this many seconds of absolute time, a falling major third. */
export const ALERT_PERIOD = 6;
const ALERT_HIGH = 659.26;
const ALERT_LOW = 523.25;
/** The second note's onset, each note's attack and decay time constant, in seconds. */
export const ALERT_STEP = 0.28;
const ALERT_ATTACK = 0.04;
const ALERT_DECAY = 0.15;
/** Each note lasts this long, its last `ALERT_TAPER` fading to nothing. */
const ALERT_LENGTH = 1;
const ALERT_TAPER = 0.1;
/** The alert is silent from this far into each period. */
export const ALERT_END = ALERT_STEP + ALERT_LENGTH;

/** One alert note's envelope (0–1), `t` seconds after its onset. */
function alertEnvelope(t: number): number {
  if (t < 0 || t >= ALERT_LENGTH) {
    return 0;
  }
  const rise =
    t < ALERT_ATTACK ? raised(t / ALERT_ATTACK) : Math.exp(-(t - ALERT_ATTACK) / ALERT_DECAY);
  const taper =
    t > ALERT_LENGTH - ALERT_TAPER ? 1 - raised((t - ALERT_LENGTH + ALERT_TAPER) / ALERT_TAPER) : 1;
  return rise * taper;
}

/** The alert's value (before its level), `t` seconds into a period. */
export function alertAt(t: number): number {
  const second = t - ALERT_STEP;
  return alertEnvelope(t) * sine(ALERT_HIGH * t) + alertEnvelope(second) * sine(ALERT_LOW * second);
}

/** The guard on the events: unchanged below the knee, then a tanh curve that never passes the ceiling. */
const GUARD_KNEE = dbToGain(-12);
const GUARD_CEILING = dbToGain(-6);

export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

/**
 * The room tone's level per channel, in dBFS RMS, and the ventilation's
 * against it at Ventilation 50.
 */
export const ROOM_DB = -24.8;
export const VENT_UNDER_ROOM_DB = -8;
/** The room tone: brown noise (white through a one-pole at this corner) between these, in Hz. */
const BROWN_CORNER = 38;
const ROOM_HIGHPASS = 60;
const ROOM_LOWPASS = 380;
const ROOM_HIGHPASS_Q = Math.SQRT1_2;
const ROOM_LOWPASS_Q = 0.5;
/** The ventilation: the same white noise through a wide band-pass, in Hz. */
const VENT_CENTRE = 900;
const VENT_Q = 0.6;
/** How far the drift moves the ventilation's level (±1.5 dB) and its centre (±10 %). */
const VENT_LEVEL_SWING = 0.17;
const VENT_CENTRE_SWING = 0.1;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** Steps when integrating the room tone's spectrum. */
const SPECTRUM_STEPS = 2000;

/** The ventilation's level at `air` (0–100), against its level at 50: none at 0, +6 dB at 100. */
export function ventShare(air: number): number {
  return Math.min(2, Math.max(0, air / 50));
}

/**
 * The RMS of unit-variance brown noise (a one-pole low-pass at
 * `BROWN_CORNER`) through the room tone's high-pass and low-pass, from their
 * analogue prototypes, close to their digital forms this far below Nyquist.
 */
function roomRms(sampleRate: number): number {
  const top = sampleRate / 2;
  const power = (f: number) => {
    const hp = f / ROOM_HIGHPASS;
    const lp = f / ROOM_LOWPASS;
    return (
      (1 / (1 + (f / BROWN_CORNER) ** 2)) *
      (hp ** 4 / ((1 - hp * hp) ** 2 + (hp / ROOM_HIGHPASS_Q) ** 2)) *
      (1 / ((1 - lp * lp) ** 2 + (lp / ROOM_LOWPASS_Q) ** 2))
    );
  };
  let through = 0;
  let total = 0;
  const step = top / SPECTRUM_STEPS;
  for (let i = 0; i < SPECTRUM_STEPS; i++) {
    const f = (i + 0.5) * step;
    through += power(f);
    total += 1 / (1 + (f / BROWN_CORNER) ** 2);
  }
  return Math.sqrt(through / total);
}

/**
 * The room's bed, in stereo: decorrelated counter-hashed white noise per side,
 * integrated into brown noise for a warm room tone between 60 and 380 Hz, and
 * band-passed around 900 Hz for the ventilation, whose level and centre drift.
 */
class RoomBed {
  private readonly prefixes = new Uint32Array(2);
  private readonly pole: number;
  private readonly brownGain: number;
  private readonly brown = new Float64Array(2);
  private readonly highpass: Svf[];
  private readonly lowpass: Svf[];
  private readonly band: Svf[];
  private readonly drift: DriftGenerator;
  /** The room tone's and the ventilation's gains on their filters' outputs. */
  private readonly roomScale: number;
  private readonly ventScale: number;
  /** The ventilation's share (`ventShare`) at the end of the last render, to ramp from. */
  private share = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    const base = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    this.prefixes[0] = hashStep(base, 0);
    this.prefixes[1] = hashStep(base, 1);
    this.pole = Math.exp((-2 * Math.PI * BROWN_CORNER) / sampleRate);
    this.brownGain = UNIFORM_TO_UNIT * Math.sqrt(1 - this.pole ** 2);
    const make = (cutoff: number, q: number) => [0, 1].map(() => new Svf(sampleRate, cutoff, q));
    this.highpass = make(ROOM_HIGHPASS, ROOM_HIGHPASS_Q);
    this.lowpass = make(ROOM_LOWPASS, ROOM_LOWPASS_Q);
    this.band = make(VENT_CENTRE, VENT_Q);
    this.drift = new DriftGenerator(
      seed,
      VENT_STREAM,
      VENT_DRIFT_RATE,
      VENT_DRIFT_OCTAVES,
      sampleRate,
    );
    this.roomScale = dbToGain(ROOM_DB) / roomRms(sampleRate);
    // A band-pass of peak gain 1 passes unit white noise's power over π·centre / 2Q of sr / 2.
    const ventRms = Math.sqrt((Math.PI * VENT_CENTRE) / (2 * VENT_Q) / (sampleRate / 2));
    this.ventScale = dbToGain(ROOM_DB + VENT_UNDER_ROOM_DB) / ventRms;
  }

  /** Starts afresh, at the ventilation's `share`. */
  prime(share: number): void {
    this.share = share;
  }

  /** Writes `length` samples from absolute sample `start`, ramping the ventilation to `share`. */
  render(
    left: Float32Array,
    right: Float32Array,
    length: number,
    start: number,
    share: number,
  ): void {
    const [highpassLeft, highpassRight] = this.highpass;
    const [lowpassLeft, lowpassRight] = this.lowpass;
    const [bandLeft, bandRight] = this.band;
    const prefixLeft = this.prefixes[0];
    const prefixRight = this.prefixes[1];
    const pole = this.pole;
    const gain = this.brownGain;
    const room = this.roomScale;
    // The drift barely moves in a render quantum: the band follows it once a
    // quantum, and the level ramps between its values at either end.
    const driftFrom = this.drift.valueAt(start);
    const driftTo = this.drift.valueAt(start + length);
    const centre = VENT_CENTRE * (1 + VENT_CENTRE_SWING * driftFrom);
    bandLeft.set(centre, VENT_Q);
    bandRight.set(centre, VENT_Q);
    const from = Number.isNaN(this.share) ? share : this.share;
    const ventFrom = this.ventScale * from * (1 + VENT_LEVEL_SWING * driftFrom);
    const ventTo = this.ventScale * share * (1 + VENT_LEVEL_SWING * driftTo);
    const step = (ventTo - ventFrom) / length;
    let brownLeft = this.brown[0];
    let brownRight = this.brown[1];
    for (let i = 0; i < length; i++) {
      const n = start + i;
      const vent = ventFrom + step * (i + 1);
      const whiteLeft = hashStep(prefixLeft, n) * UINT32_SCALE * 2 - 1;
      const whiteRight = hashStep(prefixRight, n) * UINT32_SCALE * 2 - 1;
      brownLeft = pole * brownLeft + gain * whiteLeft;
      brownRight = pole * brownRight + gain * whiteRight;
      highpassLeft.tick(brownLeft);
      highpassRight.tick(brownRight);
      lowpassLeft.tick(highpassLeft.high);
      lowpassRight.tick(highpassRight.high);
      bandLeft.tick(whiteLeft * UNIFORM_TO_UNIT);
      bandRight.tick(whiteRight * UNIFORM_TO_UNIT);
      left[i] = room * lowpassLeft.low + vent * bandLeft.band;
      right[i] = room * lowpassRight.low + vent * bandRight.band;
    }
    this.brown[0] = brownLeft;
    this.brown[1] = brownRight;
    this.share = share;
  }
}

/** The consoles' comfort low-pass, in Hz, and how long it rings on after the events stop. */
const EVENTS_LOWPASS = 5000;
const EVENTS_TAIL = 0.01;

/** Notes sounding at once, and doors. */
const NOTE_VOICES = 6;
const DOOR_VOICES = 2;
/** The most phrases or doors one block can hold: far above any rate's. */
const BLOCK_CAPACITY = 16;
/** Blocks a fresh render looks back for phrases and doors still sounding (each under 1.2 s). */
const LOOKBACK = 2;
/** Seconds rendered silently before a render that starts afresh, for the filters to settle. */
const WARM_UP = 0.1;
/** The scratch buffers the warm-up renders into, in samples. */
const SCRATCH = 128;

/**
 * Everything the bridge worklet makes, from absolute samples: the room noise,
 * the consoles, doors and alert (stereo), and the two drifts, the same whether
 * rendered in one go or in chunks.
 */
export class BridgeKernel {
  readonly vocabulary: Vocabulary;
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly bed: RoomBed;
  private readonly engineDrift: DriftGenerator;
  private readonly eventsLeft: Svf;
  private readonly eventsRight: Svf;
  /** Samples the comfort low-pass rings on for after the events stop, and how many are left. */
  private readonly tailSamples: number;
  private tail = 0;
  private readonly notes: VoicePool<NoteVoice>;
  private readonly doors: DoorVoice[];
  /** The params `set` gave: phrases and doors a second (latched per block), and the alert's level. */
  private rate = ACTIVITY_RATES.normal;
  private doorRate = 0;
  private alert = 0;
  private air = 50;
  /** The alert's level at the end of the last render, to ramp from. */
  private alertLevel = Number.NaN;
  /** The loaded block, its phrases and doors, and the next of each to start. */
  private block = Number.NaN;
  private readonly phrases: EventBlock = createEventBlock(BLOCK_CAPACITY);
  private readonly doorTimes: EventBlock = createEventBlock(BLOCK_CAPACITY);
  private nextPhrase = 0;
  private nextDoor = 0;
  private readonly period: number;
  private readonly warmUpSamples: number;
  private readonly scratch = Array.from(
    { length: BRIDGE_CHANNELS },
    () => new Float32Array(SCRATCH),
  );
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    this.vocabulary = buildVocabulary(seed);
    this.bed = new RoomBed(seed, sampleRate);
    this.eventsLeft = new Svf(sampleRate, EVENTS_LOWPASS, Math.SQRT1_2);
    this.eventsRight = new Svf(sampleRate, EVENTS_LOWPASS, Math.SQRT1_2);
    this.tailSamples = Math.ceil(EVENTS_TAIL * sampleRate);
    this.engineDrift = new DriftGenerator(
      seed,
      ENGINE_STREAM,
      ENGINE_DRIFT_RATE,
      ENGINE_DRIFT_OCTAVES,
      sampleRate,
    );
    this.notes = new VoicePool(NOTE_VOICES, () => new NoteVoice(sampleRate));
    this.doors = Array.from({ length: DOOR_VOICES }, () => new DoorVoice(sampleRate));
    this.period = Math.round(ALERT_PERIOD * sampleRate);
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
  }

  /**
   * Sets the params for the next render: console phrases and doors a second
   * (each latched as a block of time starts), the alert's level (0–1) and the
   * Ventilation (0–100).
   */
  set(rate: number, doorRate: number, alert: number, air: number): void {
    this.rate = Math.max(0, rate);
    this.doorRate = Math.max(0, doorRate);
    this.alert = Math.min(1, Math.max(0, alert));
    this.air = air;
  }

  /** How many notes and doors are sounding or waiting to. */
  get sounding(): number {
    return this.notes.active + this.doors.filter((d) => d.active).length;
  }

  /**
   * Fills `outputs` (`BRIDGE_CHANNELS` arrays of one length, in channel order)
   * from absolute sample `start`.
   */
  render(outputs: readonly Float32Array[], start: number): void {
    const length = outputs[0]?.length ?? 0;
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(outputs, length, start);
    this.expected = start + length;
  }

  /**
   * Picks up the phrases and doors that started up to `LOOKBACK` blocks before
   * the warm-up and are still sounding, each part-way through, then renders
   * the `WARM_UP` before `start` silently.
   */
  private warmUp(start: number): void {
    for (const voice of this.notes.live) {
      voice.active = false;
    }
    this.notes.active = 0;
    for (const door of this.doors) {
      door.active = false;
    }
    this.alertLevel = this.alert;
    const sr = this.sampleRate;
    let from = start - this.warmUpSamples;
    this.bed.prime(ventShare(this.air));
    this.eventsLeft.reset();
    this.eventsRight.reset();
    this.tail = 0;
    const first = blockOf(from, sr);
    for (let b = first - LOOKBACK; b < first; b++) {
      this.load(b);
      for (let i = 0; i < this.phrases.count; i++) {
        this.startPhrase(i, from - this.sampleOf(this.phrases, i));
      }
      for (let i = 0; i < this.doorTimes.count; i++) {
        this.startDoor(i, from - this.sampleOf(this.doorTimes, i));
      }
    }
    this.load(first);
    this.startDue(from - 1, from);
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratch, length, from);
      from += length;
    }
  }

  /** Loads block `block`'s phrases and doors at the current rates, which the block keeps. */
  private load(block: number): void {
    this.block = block;
    eventsInBlock(this.seed, PHRASE_STREAM, block, this.rate, this.phrases);
    eventsInBlock(this.seed, DOOR_STREAM, block, this.doorRate, this.doorTimes);
    this.nextPhrase = 0;
    this.nextDoor = 0;
  }

  /** The absolute sample event `i` of `events` (in the loaded block) starts at. */
  private sampleOf(events: EventBlock, i: number): number {
    return this.block * this.sampleRate + Math.floor((events.offsets[i] ?? 0) * this.sampleRate);
  }

  /**
   * Starts every phrase and door of the loaded block due by absolute sample
   * `due`, each as far in as it is at absolute sample `at`.
   */
  private startDue(due: number, at: number): void {
    while (
      this.nextPhrase < this.phrases.count &&
      this.sampleOf(this.phrases, this.nextPhrase) <= due
    ) {
      this.startPhrase(this.nextPhrase, at - this.sampleOf(this.phrases, this.nextPhrase));
      this.nextPhrase++;
    }
    while (
      this.nextDoor < this.doorTimes.count &&
      this.sampleOf(this.doorTimes, this.nextDoor) <= due
    ) {
      this.startDoor(this.nextDoor, at - this.sampleOf(this.doorTimes, this.nextDoor));
      this.nextDoor++;
    }
  }

  /** Starts phrase event `i` of the loaded block, `elapsed` samples in: its notes still to sound. */
  private startPhrase(i: number, elapsed: number): void {
    const vocabulary = this.vocabulary;
    const hash = pickHash(this.seed, this.block, i);
    const phrase = vocabulary.phrases[hash % PHRASES];
    const place = phrase.consoles[hashStep(hash, 1) % phrase.consoles.length];
    const where = vocabulary.consoles[place];
    const sr = this.sampleRate;
    for (const note of phrase.notes) {
      const into = elapsed - Math.round(note.onset * sr);
      if (into >= Math.floor(noteDuration(note) * sr)) {
        continue;
      }
      this.notes.allocate().start(note, where.gain, where.pan, into);
    }
  }

  /** Starts door event `i` of the loaded block, `elapsed` samples in, in a free voice or the oldest. */
  private startDoor(i: number, elapsed: number): void {
    const hash = eventHash(this.seed, DOOR_STREAM, this.block, i);
    const voice = this.doors.find((d) => !d.active) ?? this.doors[0];
    voice.start(hash, elapsed);
  }

  /** Renders `length` samples from absolute sample `start` into `outputs`, overwriting them. */
  private process(outputs: readonly Float32Array[], length: number, start: number): void {
    const sr = this.sampleRate;
    const left = outputs[EVENTS_LEFT];
    const right = outputs[EVENTS_RIGHT];
    const engine = outputs[ENGINE_DRIFT];
    left.fill(0, 0, length);
    right.fill(0, 0, length);
    let sounded = false;
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.block) {
        this.load(block);
      }
      this.startDue(now, now);
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.nextPhrase < this.phrases.count) {
        end = Math.min(end, this.sampleOf(this.phrases, this.nextPhrase) - start);
      }
      if (this.nextDoor < this.doorTimes.count) {
        end = Math.min(end, this.sampleOf(this.doorTimes, this.nextDoor) - start);
      }
      const pool = this.notes;
      for (let v = pool.active - 1; v >= 0; v--) {
        const voice = pool.live[v];
        voice.render(left, right, pos, end);
        sounded = true;
        if (!voice.active) {
          pool.release(v);
        }
      }
      for (const door of this.doors) {
        if (door.active) {
          door.render(left, right, pos, end);
          sounded = true;
        }
      }
      pos = end;
    }
    sounded = this.renderAlert(left, right, length, start) || sounded;
    if (sounded) {
      this.tail = this.tailSamples;
    } else {
      this.tail -= length;
    }
    if (this.tail > 0) {
      const lowLeft = this.eventsLeft;
      const lowRight = this.eventsRight;
      for (let i = 0; i < length; i++) {
        lowLeft.tick(left[i]);
        lowRight.tick(right[i]);
        left[i] = guard(lowLeft.low);
        right[i] = guard(lowRight.low);
      }
    } else {
      this.eventsLeft.reset();
      this.eventsRight.reset();
    }
    this.bed.render(outputs[BED_LEFT], outputs[BED_RIGHT], length, start, ventShare(this.air));
    // The engine's drift ramps between its values at either end of the quantum.
    const driftFrom = this.engineDrift.valueAt(start);
    const driftStep = (this.engineDrift.valueAt(start + length) - driftFrom) / length;
    for (let i = 0; i < length; i++) {
      engine[i] = driftFrom + driftStep * i;
    }
  }

  /** Adds the alert, ramping its level from the last render's; returns whether it sounded. */
  private renderAlert(
    left: Float32Array,
    right: Float32Array,
    length: number,
    start: number,
  ): boolean {
    const from = Number.isNaN(this.alertLevel) ? this.alert : this.alertLevel;
    const to = this.alert;
    this.alertLevel = to;
    if (from <= 0 && to <= 0) {
      return false;
    }
    const sr = this.sampleRate;
    const period = this.period;
    const end = Math.ceil(ALERT_END * sr);
    // Centred: the same on both sides, at equal power.
    const peak = ALERT_PEAK * Math.SQRT1_2;
    let sounded = false;
    for (let i = 0; i < length; i++) {
      const n = start + i;
      const into = n - Math.floor(n / period) * period;
      if (into >= end) {
        continue;
      }
      const level = from + ((to - from) * (i + 1)) / length;
      const x = alertAt(into / sr) * level * peak;
      left[i] = (left[i] ?? 0) + x;
      right[i] = (right[i] ?? 0) + x;
      sounded = true;
    }
    return sounded;
  }
}

interface BridgeOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readBridgeOptions(raw: unknown): BridgeOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
