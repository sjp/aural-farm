/**
 * Coffee Shop's sound: pure code with no Web Audio globals, run by
 * `coffee-shop.worklet.ts` and checked in Node.
 *
 * A busy café heard from a corner table, all from one worklet per seed:
 *
 * - **Talkers.** A pool of twelve people, the first `crowd` of them present (a
 *   change of Crowd fades people at the end of the list in or out over 1.5 s
 *   and leaves the rest alone). Each has a voice of their own from the seed: a
 *   low (95–135 Hz) or high (170–230 Hz) pitch, a syllable rate of 4–5.2 a
 *   second, a distance (−4 to −16 dB), a place in the room (±0.8) and a vocal
 *   tract length (formants scaled 0.9–1.05 for low voices, 1–1.15 for high).
 *   The voice is a band-limited saw, tilted towards a glottal spectrum by a
 *   one-pole low-pass at 1.2 × its pitch, with a per-period wobble of ±0.8 % in
 *   pitch (jitter) and ±1 dB in level (shimmer) and a breath of white noise,
 *   through three band-passes in parallel at the first three formants of one
 *   of five neutral vowels. The formants glide between vowels with a 40 ms
 *   one-pole, so vowels blend rather than step. No consonant is ever made.
 * - **Syllables and turns.** Each talker's time is a grid of syllable cells
 *   at their rate; each cell's hash picks its vowel, length (55–85 % of the
 *   cell), stress (0 to +4 dB and up to +3 semitones), and where in the cell
 *   it falls. People talk in pairs, at tables: each pair's time is a grid of
 *   2.5 s phrase cells, and each phrase's hash gives the turn to one or the
 *   other, now and then both or neither, and how much of it they fill. Across
 *   a phrase the pitch falls about 2 semitones; one phrase in four ends
 *   rising, as a question.
 * - **Blur.** The talkers' sum passes a one-pole low-pass at 2.2 kHz and a
 *   high-pass at 140 Hz, as through a room's distance: the murmur of talk,
 *   never its words.
 * - **Clinks.** Cups set down on saucers: a Poisson process of up to 0.4 a
 *   second (Clatter 100), each a strike on a ceramic bank of four modes
 *   (`modal.ts`) at ratios 1, 2.32, 4.25 and 6.63 of a hashed 1.6–3.2 kHz,
 *   ringing 0.25–0.6 s (higher modes shorter), −18 to −30 dB, within ±0.7.
 *   One in three is a soft double clink, the second 60–140 ms after.
 * - **Steam.** Now and then the hiss of a steam wand (about every 4 minutes
 *   at Clatter 50; never at 0): white noise band-passed at 3.5 kHz (Q 1.2)
 *   under a one-pole low-pass at 7 kHz, 4–9 s long with 1.5 s fades, at most
 *   −26 dBFS. Never sudden.
 * - **Room tone.** The air-conditioning and the distant kitchen: pink noise,
 *   decorrelated on each side, under a one-pole low-pass at 1.5 kHz, at
 *   −36 dBFS.
 *
 * The worklet's four channels are the sound (left, right) and its feed to the
 * room reverb (left, right), which carries the talkers at full level, the
 * clinks 6 dB lower (so they stay crisp) and the steam 3 dB lower. The Room
 * size param scales that feed.
 *
 * Every syllable, phrase and event comes from hashes of absolute time; slow
 * states (a voice's phase, its formants, the filters) are rebuilt by a short
 * unheard warm-up when a render starts afresh, and a syllable's voice starts
 * from zero phase at its cell's start, so at steady params the output depends
 * only on the seed and absolute time.
 */
import {
  blockOf,
  createEventBlock,
  eventHash,
  eventsInBlock,
  type EventBlock,
} from "../../audio/dsp/events";
import { ModalBank } from "../../audio/dsp/modal";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { svfCoefficients } from "../../audio/dsp/svf";
import { VoicePool } from "../../audio/dsp/voices";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import { MAX_CROWD } from "./coffee-shop.meta";

export const COFFEE_SHOP_PROCESSOR = "aural-coffee-shop";
/** The worklet's output channels: the sound (left, right), then its reverb feed (left, right). */
export const COFFEE_SHOP_CHANNELS = 4;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const unit = (state: number, salt: number) => hashStep(state, salt) * UINT32_SCALE;

/** Random streams: each source of randomness its own. */
const TALKER_STREAM = 1;
const PAIR_STREAM = 2;
export const CLINK_STREAM = 3;
export const STEAM_STREAM = 4;
const NOISE_STREAM = 5;
const BREATH_STREAM = 6;

// ---------------------------------------------------------------------------
// Params.

/** Clinks per second at Clatter 100. */
const MAX_CLINK_RATE = 0.4;

/** Clinks per second at `clatter` (0–100): in proportion to it. */
export function clinkRate(clatter: number): number {
  return (MAX_CLINK_RATE * clamp(clatter, 0, 100)) / 100;
}

/** The mean gap between steam hisses at Clatter 50, in seconds. */
const STEAM_GAP = 240;

/** Steam hisses per second at `clatter` (0–100): in proportion to it, none at 0. */
export function steamRate(clatter: number): number {
  return clamp(clatter, 0, 100) / 50 / STEAM_GAP;
}

/** The reverb feed's level for Room size (0–100), in dB: −14 to −2. */
export function roomDb(room: number): number {
  return -14 + (12 * clamp(room, 0, 100)) / 100;
}

/** How many people are present for Crowd `crowd`: a whole number in 0–12. */
export function crowdCount(crowd: number): number {
  return Math.round(clamp(crowd, 0, MAX_CROWD));
}

// ---------------------------------------------------------------------------
// Voices.

/**
 * Five neutral vowels' first three formants, in Hz: an open "ah", a close
 * front "ee", a close back "oo", a mid front "eh" and an open back "aw".
 */
export const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [570, 840, 2410],
];
/** Each formant's Q, and its level against the first. */
const FORMANT_Q = [5, 8, 10] as const;
const FORMANT_GAIN = [1, dbToGain(-6), dbToGain(-12)] as const;
/** How far a syllable's formants stray from its vowel's, as a share either way. */
export const VOWEL_SPREAD = 0.06;
/** The formants' glide between vowels: a one-pole's time constant, in seconds. */
const FORMANT_GLIDE = 0.04;

/** A talker's voice, from the seed and their place in the pool. */
interface TalkerVoice {
  /** Their speaking pitch, in Hz. */
  pitch: number;
  /** Syllables a second. */
  rate: number;
  /** Where their syllable grid starts, in seconds. */
  offset: number;
  /** Their level, in dB, by distance. */
  levelDb: number;
  pan: number;
  /** Their formants' scale: a shorter vocal tract is higher. */
  scale: number;
}

/** Pitches of low and high voices, in Hz, from–to. */
const LOW_VOICE = [95, 135] as const;
const HIGH_VOICE = [170, 230] as const;
/** Formant scales of low and high voices, from–to. */
export const LOW_SCALE = [0.9, 1.05] as const;
export const HIGH_SCALE = [1, 1.15] as const;
/** Syllables a second, from–to. */
const RATE = [4, 5.2] as const;
/** A talker's level by distance, in dB, from–to. */
const NEAREST_DB = -4;
const FARTHEST_DB = -16;
/** How far a talker may sit from the centre. */
export const TALKER_PAN = 0.8;

const between = (range: readonly [number, number], u: number) =>
  range[0] + (range[1] - range[0]) * u;

/** Salts for a talker's voice. */
const HIGH_SALT = 1;
const PITCH_SALT = 2;
const RATE_SALT = 3;
const OFFSET_SALT = 4;
const LEVEL_SALT = 5;
const PAN_SALT = 6;
const SCALE_SALT = 7;

/** The hash of talker `index` for `seed`, which their voice and syllables come from. */
function talkerHash(seed: number, index: number): number {
  return hashStep(hashStep(hashStep(HASH_START, seed), TALKER_STREAM), index);
}

/** Talker `index`'s voice for `seed`. */
export function talkerVoice(seed: number, index: number): TalkerVoice {
  const h = talkerHash(seed, index);
  const high = unit(h, HIGH_SALT) < 0.5;
  const rate = between(RATE, unit(h, RATE_SALT));
  return {
    pitch: between(high ? HIGH_VOICE : LOW_VOICE, unit(h, PITCH_SALT)),
    rate,
    offset: unit(h, OFFSET_SALT) / rate,
    levelDb: NEAREST_DB + (FARTHEST_DB - NEAREST_DB) * unit(h, LEVEL_SALT),
    pan: TALKER_PAN * (2 * unit(h, PAN_SALT) - 1),
    scale: between(high ? HIGH_SCALE : LOW_SCALE, unit(h, SCALE_SALT)),
  };
}

// ---------------------------------------------------------------------------
// Phrases and syllables.

/** A phrase cell's length, in seconds. */
export const PHRASE = 2.5;
/** Shares of phrases given to the pair's first talker, to the second, to both; the rest to neither. */
const FIRST_SHARE = 0.43;
const SECOND_SHARE = 0.43;
const BOTH_SHARE = 0.06;
/** The share of a phrase cell a talker fills, from–to. */
const FILL = [0.6, 1] as const;
/** The chance a phrase ends rising, and how far, in semitones. */
const QUESTION_SHARE = 0.25;
const QUESTION_RISE = 3;
/** Where in the phrase a question starts to rise. */
const QUESTION_FROM = 0.7;
/** How far the pitch falls across a phrase, and how far a phrase's register strays, in semitones. */
const DECLINATION = 2;
const REGISTER = 1.5;
/** How far a phrase's level strays, in dB either way. */
const PHRASE_LEVEL_DB = 2;

/** Salts for a phrase's random properties. */
const TURN_SALT = 11;
const FILL_SALT = 12;
const QUESTION_SALT = 13;
const REGISTER_SALT = 14;
const PHRASE_LEVEL_SALT = 15;
const PAIR_OFFSET_SALT = 16;

/** One talker's part in a phrase. */
export interface Phrase {
  /** Whether they talk in it. */
  speaking: boolean;
  /** When it starts, and how long they talk, in seconds. */
  start: number;
  length: number;
  /** Whether it ends rising. */
  question: boolean;
  /** Its register against the talker's pitch, in semitones, and its level, in dB. */
  register: number;
  levelDb: number;
}

/** Where pair `pair`'s phrase grid starts, in seconds. */
function pairOffset(seed: number, pair: number): number {
  const h = hashStep(hashStep(hashStep(HASH_START, seed), PAIR_STREAM), pair);
  return PHRASE * unit(h, PAIR_OFFSET_SALT);
}

/** The phrase cell that time `t` falls in for talker `index`. */
export function phraseCell(seed: number, index: number, t: number): number {
  return Math.floor((t - pairOffset(seed, index >> 1)) / PHRASE);
}

/**
 * Talker `index`'s part in phrase cell `cell` (`everyone`: everyone talks in
 * every phrase, for the loudest case), written into `into`.
 */
export function phrase(
  seed: number,
  index: number,
  cell: number,
  into: Phrase,
  everyone = false,
): Phrase {
  const pair = index >> 1;
  const first = (index & 1) === 0;
  const pairHash = hashStep(hashStep(hashStep(HASH_START, seed), PAIR_STREAM), pair);
  const h = hashStep(pairHash, cell);
  const turn = unit(h, TURN_SALT);
  const mine = first
    ? turn < FIRST_SHARE
    : turn >= FIRST_SHARE && turn < FIRST_SHARE + SECOND_SHARE;
  const both = turn >= FIRST_SHARE + SECOND_SHARE && turn < FIRST_SHARE + SECOND_SHARE + BOTH_SHARE;
  const own = hashStep(h, index);
  into.speaking = everyone || mine || both;
  into.start = pairOffset(seed, pair) + cell * PHRASE;
  into.length = PHRASE * (everyone ? 1 : between(FILL, unit(own, FILL_SALT)));
  into.question = unit(own, QUESTION_SALT) < QUESTION_SHARE;
  into.register = REGISTER * (2 * unit(own, REGISTER_SALT) - 1);
  into.levelDb = PHRASE_LEVEL_DB * (2 * unit(own, PHRASE_LEVEL_SALT) - 1);
  return into;
}

/** A syllable's length, as a share of its cell, from–to. */
export const SYLLABLE_LENGTH = [0.55, 0.85] as const;
/** How far a syllable's centre may stray from its cell's, as a share of the cell. */
const SYLLABLE_SHIFT = 0.2;
/** The least gap kept between a syllable and its cell's edges, as a share of the cell. */
const SYLLABLE_MARGIN = 0.02;
/** A syllable's stress: up to this much louder, in dB, and higher, in semitones. */
const STRESS_DB = 4;
const STRESS_RISE = 3;
/** Stress above this share counts as a rise in pitch. */
const STRESS_PITCH_FROM = 0.5;
/** The share of syllables left out, the gaps between words. */
const DROPOUT = 0.12;
/** A syllable's edges: raised cosines of this share of it, but never under 15 ms. */
const EDGE_SHARE = 0.3;
const SHORTEST_EDGE = 0.015;

/** Salts for a syllable's random properties. */
const VOWEL_SALT = 21;
const LENGTH_SALT = 22;
const SHIFT_SALT = 23;
const STRESS_SALT = 24;
const DROP_SALT = 25;
const SPREAD_SALT = 26;

/** A syllable, from its talker's voice and its cell. */
interface Syllable {
  /** When it starts and ends, in seconds. */
  start: number;
  end: number;
  vowel: number;
  /** How far its formants stray from its vowel's, as a factor. */
  spread: number;
  /** Its stress, 0–1. */
  stress: number;
  /** Whether it is left out, a gap between words. */
  dropped: boolean;
}

/** Syllable `cell` of a talker of hash `hash` and voice `voice`, written into `into`. */
function syllableOf(hash: number, voice: TalkerVoice, cell: number, into: Syllable): Syllable {
  const h = hashStep(hash, cell);
  const cellLength = 1 / voice.rate;
  const share = between(SYLLABLE_LENGTH, unit(h, LENGTH_SALT));
  const room = Math.min(SYLLABLE_SHIFT, (1 - share) / 2 - SYLLABLE_MARGIN);
  const centre = voice.offset + (cell + 0.5 + room * (2 * unit(h, SHIFT_SALT) - 1)) * cellLength;
  into.start = centre - (share * cellLength) / 2;
  into.end = centre + (share * cellLength) / 2;
  into.vowel = Math.min(VOWELS.length - 1, Math.floor(unit(h, VOWEL_SALT) * VOWELS.length));
  into.spread = 1 + VOWEL_SPREAD * (2 * unit(h, SPREAD_SALT) - 1);
  into.stress = unit(h, STRESS_SALT);
  into.dropped = unit(h, DROP_SALT) < DROPOUT;
  return into;
}

/** Syllable `cell` of talker `index` for `seed`. */
export function syllable(seed: number, index: number, cell: number): Syllable {
  return syllableOf(talkerHash(seed, index), talkerVoice(seed, index), cell, {
    start: 0,
    end: 0,
    vowel: 0,
    spread: 1,
    stress: 0,
    dropped: false,
  });
}

/** The syllable cell time `t` falls in, for a talker of voice `voice`. */
export function syllableCell(voice: TalkerVoice, t: number): number {
  return Math.floor((t - voice.offset) * voice.rate);
}

/** A syllable's envelope at `t`, from 0 to 1: raised-cosine edges, flat between. */
export function syllableEnvelope(t: number, start: number, end: number): number {
  if (!(t > start && t < end)) {
    return 0;
  }
  const edge = Math.min((end - start) / 2, Math.max(SHORTEST_EDGE, EDGE_SHARE * (end - start)));
  const from = Math.min(t - start, end - t);
  return from >= edge ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * from) / edge);
}

/**
 * The pitch, in semitones against the talker's, at `t` in syllable `s` of
 * phrase `p`: the phrase's register, falling across it, the stressed
 * syllable's rise and fall, and a question's rise at the end.
 */
export function pitchOffset(t: number, s: Syllable, p: Phrase): number {
  const along = clamp((t - p.start) / p.length, 0, 1);
  let semis = p.register - DECLINATION * along;
  if (s.stress > STRESS_PITCH_FROM) {
    const rise = (STRESS_RISE * (s.stress - STRESS_PITCH_FROM)) / (1 - STRESS_PITCH_FROM);
    semis += rise * Math.sin(Math.PI * clamp((t - s.start) / (s.end - s.start), 0, 1));
  }
  if (p.question && along > QUESTION_FROM) {
    const x = (along - QUESTION_FROM) / (1 - QUESTION_FROM);
    semis += QUESTION_RISE * x * x;
  }
  return semis;
}

/** A talker's per-period wobble: ±0.8 % in pitch and ±1 dB in level. */
const JITTER = 0.008;
const SHIMMER_DB = 1;
/** The glottal tilt's low-pass, as a multiple of the pitch. */
const TILT = 1.2;
/** The breath's level against the tilted saw's. */
const BREATH = 0.05;

// ---------------------------------------------------------------------------
// Levels.

/**
 * The gain that brings a talker, at 0 dB of distance, to about −20 dBFS RMS
 * while voicing (measured over many syllables and vowels).
 */
const TALKER_GAIN = 2.5;
/** The blur: the talkers' one-pole low-pass and their high-pass, in Hz. */
const BLUR_LOWPASS = 2200;
const BLUR_HIGHPASS = 140;
/** How long a crowd change fades a talker in or out, in seconds. */
const CROWD_FADE = 1.5;
/** How long a talker keeps rendering after a syllable, for its formants to ring out, in seconds. */
const TAIL = 0.04;

/** A clink's ceramic modes: ratios to its base, and levels against the first. */
export const CLINK_RATIOS = [1, 2.32, 4.25, 6.63] as const;
const CLINK_LEVELS = [1, 0.55, 0.35, 0.2] as const;
/** A clink's base, in Hz, from–to; modes above `CLINK_TOP` are left out, for comfort. */
const CLINK_BASE = [1600, 3200] as const;
export const CLINK_TOP = 8000;
/** The base mode's decay to −60 dB, in seconds, from–to; higher modes decay sooner. */
const CLINK_DECAY = [0.25, 0.6] as const;
/** A clink's peak, in dBFS, from–to. */
const CLINK_DB = [-30, -18] as const;
/** How far a clink may sit from the centre. */
export const CLINK_PAN = 0.7;
/** The share of clinks that are double, the second's delay in seconds, and its level. */
const DOUBLE_SHARE = 1 / 3;
const DOUBLE_DELAY = [0.06, 0.14] as const;
const DOUBLE_GAIN = 0.6;
/** How long before a render a clink may have struck and still ring, in seconds. */
export const CLINK_LONGEST = 1.2;
/** Clinks ringing at once, and a block's capacity. */
const CLINK_VOICES = 6;
const CLINK_CAPACITY = 8;

/** Salts for a clink's random properties. */
const BASE_SALT = 31;
const DECAY_SALT = 32;
const CLINK_LEVEL_SALT = 33;
const CLINK_PAN_SALT = 34;
const DOUBLE_SALT = 35;
const DELAY_SALT = 36;

/** A clink, from its event hash. */
interface ClinkShape {
  base: number;
  decay: number;
  /** Its peak, as a gain. */
  peak: number;
  pan: number;
  /** The second clink's delay, in seconds, or 0 for a single clink. */
  delay: number;
}

export function clinkShape(hash: number): ClinkShape {
  const double = unit(hash, DOUBLE_SALT) < DOUBLE_SHARE;
  return {
    base: between(CLINK_BASE, unit(hash, BASE_SALT)),
    decay: between(CLINK_DECAY, unit(hash, DECAY_SALT)),
    peak: dbToGain(between(CLINK_DB, unit(hash, CLINK_LEVEL_SALT))),
    pan: CLINK_PAN * (2 * unit(hash, CLINK_PAN_SALT) - 1),
    delay: double ? between(DOUBLE_DELAY, unit(hash, DELAY_SALT)) : 0,
  };
}

/** A steam hiss's band-pass (Hz, Q), its low-pass (Hz), length (s), fades (s) and peak (dBFS RMS). */
const STEAM_CENTRE = 3500;
const STEAM_Q = 1.2;
const STEAM_LOWPASS = 7000;
const STEAM_LENGTH = [4, 9] as const;
export const STEAM_LONGEST = STEAM_LENGTH[1];
const STEAM_FADE = 1.5;
const STEAM_DB = -26;
/** How far a hiss may sit from the centre. */
const STEAM_PAN = 0.5;
/** Hisses at once, and a block's capacity. */
const STEAM_VOICES = 2;
const STEAM_CAPACITY = 2;
const STEAM_LENGTH_SALT = 41;
const STEAM_PAN_SALT = 42;
const STEAM_NOISE_SALT = 43;

/** A hiss's fade in and out on raised cosines, over `length` seconds. */
export function steamEnvelope(t: number, length: number): number {
  if (!(t > 0 && t < length)) {
    return 0;
  }
  const edge = Math.min(STEAM_FADE, t, length - t);
  return edge >= STEAM_FADE ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / STEAM_FADE);
}

/** The room tone's level, in dBFS RMS per side, and its low-pass, in Hz. */
const ROOM_TONE_DB = -36;
const ROOM_TONE_LOWPASS = 1500;
/**
 * The pink filter's sections (Paul Kellet's economy filter): each a one-pole
 * at its corner, in Hz, and its gain, plus the direct path. Its lowest section
 * is left out: nothing of the room tone below 25 Hz.
 */
const PINK_CORNERS = [262, 3940] as const;
const PINK_GAINS = [0.2965164, 1.0526913] as const;
const PINK_DIRECT = 0.1848;
/** The gain that brings the room tone's filtered pink to unit RMS (measured). */
const ROOM_TONE_SCALE = 0.67;

/** The feed to the reverb, against the sound: the clinks 6 dB under the talkers, the steam 3. */
const CLINK_SEND = dbToGain(-6);
const STEAM_SEND = dbToGain(-3);

// ---------------------------------------------------------------------------
// The kernel.

/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** The sample rate the noise's levels are set at: other rates scale it to the same density. */
const REFERENCE_RATE = 48000;
/** A render quantum, in samples: the most the kernel renders at once. */
const QUANTUM = 128;
/** Talkers' control points fall every this many samples of absolute time. */
const CONTROL = 32;
/** Seconds rendered silently before a render that starts afresh: longer than a syllable cell. */
const WARM_UP = 0.5;
/** The guard on the sound: above the knee, a tanh curve that never passes the ceiling. */
const GUARD_KNEE = dbToGain(-9);
const GUARD_CEILING = dbToGain(-3.5);

/** Unchanged below the knee, then easing towards the ceiling and never passing it. */
export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

/** One talker's state. */
interface Talker {
  readonly index: number;
  readonly hash: number;
  readonly voice: TalkerVoice;
  readonly level: number;
  /** Whether they are present (crowd), and their fade towards it, 0–1. */
  present: boolean;
  fade: number;
  /** Their current syllable cell and phrase cell, with what those hold. */
  cell: number;
  phraseCell: number;
  readonly syllable: Syllable;
  readonly phrase: Phrase;
  /** Whether the current syllable sounds, and the absolute sample their last sounding one ends. */
  sounding: boolean;
  tailUntil: number;
  /** Whether they rendered in the last control block. */
  active: boolean;
  /** The voice: phase, its increment and the pitch's without jitter, the period count, jitter, shimmer. */
  phase: number;
  increment: number;
  base: number;
  period: number;
  jitter: number;
  shimmer: number;
  /** The glottal tilt's coefficient and state. */
  tilt: number;
  tiltState: number;
  /** The formants now, in Hz (gliding), and the band-passes' coefficients and states. */
  readonly formants: Float64Array;
  readonly coefficients: Float64Array;
  readonly states: Float64Array;
  /** The envelope now and its step per sample, and the gains on each side. */
  envelope: number;
  envelopeStep: number;
  left: number;
  right: number;
}

/** A clink ringing. */
interface ClinkVoice {
  level: number;
  readonly bank: ModalBank;
  left: number;
  right: number;
  /** Samples since it struck, and when its second clink strikes (−1: none), and how hard. */
  position: number;
  second: number;
  secondGain: number;
}

/** A steam hiss. */
interface SteamVoice {
  active: boolean;
  position: number;
  length: number;
  noise: number;
  left: number;
  right: number;
  ic1: number;
  ic2: number;
  low: number;
}

/** The events of one stream, one block at a time: its offsets and which have started. */
class Schedule {
  readonly events: EventBlock;
  block = Number.NaN;
  next = 0;
  private readonly seed: number;
  private readonly stream: number;

  constructor(seed: number, stream: number, capacity: number) {
    this.seed = seed;
    this.stream = stream;
    this.events = createEventBlock(capacity);
  }

  /** Loads block `block`'s events at `rate` per second, which the block keeps. */
  load(block: number, rate: number): void {
    eventsInBlock(this.seed, this.stream, block, rate, this.events);
    this.block = block;
    this.next = 0;
  }

  /** The absolute sample event `i` of the loaded block starts at. */
  sample(i: number, sampleRate: number): number {
    return this.block * sampleRate + Math.floor((this.events.offsets[i] ?? 0) * sampleRate);
  }

  hash(i: number): number {
    return eventHash(this.seed, this.stream, this.block, i);
  }
}

/**
 * Coffee Shop's whole sound for one seed, from absolute samples: the same
 * whether rendered in one go or in chunks, at steady params.
 */
export class CoffeeShopKernel {
  private readonly sampleRate: number;
  private readonly seed: number;
  private readonly everyone: boolean;
  private readonly talkers: Talker[];
  private readonly white: number;
  private readonly noisePrefix: number;
  private readonly breathPrefix: number;
  private readonly glideCoef: number;
  private readonly fadeStep: number;
  private readonly blurPole: number;
  private readonly blurHighpass: Float64Array;
  /** The blur's states: per side, the low-pass, then the high-pass's two. */
  private readonly blur = new Float64Array(6);
  private readonly pinkPoles: Float64Array;
  private readonly pinkGains: Float64Array;
  private readonly roomTonePole: number;
  private readonly roomToneGain: number;
  /** The room tone's states: per side, the two pink sections and the low-pass. */
  private readonly roomTone = new Float64Array(6);

  private readonly clinks: VoicePool<ClinkVoice>;
  private readonly clinkSchedule: Schedule;
  private readonly steam: SteamVoice[];
  private readonly steamSchedule: Schedule;
  private readonly steamBand: Float64Array;
  private readonly steamPole: number;
  private readonly steamGain: number;

  /** Scratch: the talkers' sum, the breath noise, a clink's ring, the events' sum. */
  private readonly talkL = new Float32Array(QUANTUM);
  private readonly talkR = new Float32Array(QUANTUM);
  private readonly breath = new Float32Array(QUANTUM);
  private readonly ring = new Float32Array(QUANTUM);
  private readonly eventL = new Float32Array(QUANTUM);
  private readonly eventR = new Float32Array(QUANTUM);
  private readonly steamL = new Float32Array(QUANTUM);
  private readonly steamR = new Float32Array(QUANTUM);
  /** Where a warm-up renders, unheard. */
  private readonly unheard = Array.from({ length: 4 }, () => new Float32Array(QUANTUM));
  private readonly warmUpSamples: number;

  /** The params `set` gave. */
  private crowd = 6;
  private clatter = 40;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  /** `everyone`: everyone talks all the time, for the loudest case in tests. */
  constructor(seed: number, sampleRate: number, everyone = false) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.seed = seed;
    this.everyone = everyone;
    const pole = (corner: number) => Math.exp((-2 * Math.PI * corner) / sr);
    this.white = UNIFORM_TO_UNIT * Math.sqrt(sr / REFERENCE_RATE);
    const seedHash = hashStep(HASH_START, seed);
    this.noisePrefix = hashStep(seedHash, NOISE_STREAM);
    this.breathPrefix = hashStep(seedHash, BREATH_STREAM);
    this.glideCoef = 1 - Math.exp(-CONTROL / (FORMANT_GLIDE * sr));
    this.fadeStep = CONTROL / (CROWD_FADE * sr);
    this.blurPole = pole(BLUR_LOWPASS);
    this.blurHighpass = svfCoefficients(new Float64Array(4), BLUR_HIGHPASS, Math.SQRT1_2, sr);
    this.pinkPoles = Float64Array.from(PINK_CORNERS, pole);
    // Each section's gain, kept at its 44.1 kHz design's level whatever the rate.
    this.pinkGains = Float64Array.from(
      PINK_GAINS,
      (g, i) =>
        (g * (1 - (this.pinkPoles[i] ?? 0))) /
        (1 - Math.exp((-2 * Math.PI * (PINK_CORNERS[i] ?? 0)) / 44100)),
    );
    this.roomTonePole = pole(ROOM_TONE_LOWPASS);
    this.roomToneGain = dbToGain(ROOM_TONE_DB) * ROOM_TONE_SCALE;

    this.talkers = Array.from({ length: MAX_CROWD }, (_, index) => {
      const voice = talkerVoice(seed, index);
      return {
        index,
        hash: talkerHash(seed, index),
        voice,
        level: dbToGain(voice.levelDb) * TALKER_GAIN,
        present: false,
        fade: 0,
        cell: Number.NaN,
        phraseCell: Number.NaN,
        syllable: { start: 0, end: 0, vowel: 0, spread: 1, stress: 0, dropped: true },
        phrase: {
          speaking: false,
          start: 0,
          length: PHRASE,
          question: false,
          register: 0,
          levelDb: 0,
        },
        sounding: false,
        tailUntil: -1,
        active: false,
        phase: 0,
        increment: 0,
        base: 0,
        period: 0,
        jitter: 1,
        shimmer: 1,
        tilt: 0,
        tiltState: 0,
        formants: new Float64Array(3),
        coefficients: new Float64Array(12),
        states: new Float64Array(6),
        envelope: 0,
        envelopeStep: 0,
        left: 0,
        right: 0,
      };
    });

    this.clinks = new VoicePool<ClinkVoice>(CLINK_VOICES, () => ({
      level: 0,
      bank: new ModalBank(sr, CLINK_RATIOS.length),
      left: 0,
      right: 0,
      position: 0,
      second: -1,
      secondGain: 0,
    }));
    this.clinkSchedule = new Schedule(seed, CLINK_STREAM, CLINK_CAPACITY);
    this.steam = Array.from({ length: STEAM_VOICES }, () => ({
      active: false,
      position: 0,
      length: 0,
      noise: 0,
      left: 0,
      right: 0,
      ic1: 0,
      ic2: 0,
      low: 0,
    }));
    this.steamSchedule = new Schedule(seed, STEAM_STREAM, STEAM_CAPACITY);
    this.steamBand = svfCoefficients(new Float64Array(4), STEAM_CENTRE, STEAM_Q, sr);
    this.steamPole = pole(STEAM_LOWPASS);
    // The band's RMS from unit-variance white at 48 kHz is √(π·f/(Q·sr)): brought to `STEAM_DB`.
    this.steamGain =
      dbToGain(STEAM_DB) / Math.sqrt((Math.PI * STEAM_CENTRE) / (STEAM_Q * REFERENCE_RATE));
    this.warmUpSamples = Math.ceil((WARM_UP * sr) / CONTROL) * CONTROL;
  }

  /** Sets the params for the next render: Crowd (2–12; fades) and Clatter (0–100; latched per block). */
  set(crowd: number, clatter: number): void {
    this.crowd = crowdCount(crowd);
    this.clatter = clamp(clatter, 0, 100);
  }

  /** How many talkers rendered in the last control block. */
  get talkersActive(): number {
    return this.talkers.filter((t) => t.active).length;
  }

  /** How many clinks are ringing. */
  get clinksRinging(): number {
    return this.clinks.active;
  }

  /** How many steam hisses are sounding. */
  get steamSounding(): number {
    return this.steam.filter((s) => s.active).length;
  }

  /** Fills `outputs` (four channels of one length) from absolute sample `start`. */
  render(outputs: readonly Float32Array[], start: number): void {
    const length = outputs[0]?.length ?? 0;
    if (start !== this.expected) {
      this.warmUp(start);
    }
    for (let done = 0; done < length; done += QUANTUM) {
      const n = Math.min(QUANTUM, length - done);
      this.process(outputs, done, n, start + done);
    }
    this.expected = start + length;
  }

  /**
   * A fresh start, or a jump: the talkers at their crowd, the clinks and hisses
   * that started before and still sound picked up part-way through, then a
   * warm-up from a control point rendered silently, for each talker's
   * syllable and the filters.
   */
  private warmUp(start: number): void {
    const sr = this.sampleRate;
    let from = Math.floor(start / CONTROL) * CONTROL - this.warmUpSamples;
    this.blur.fill(0);
    this.roomTone.fill(0);
    for (const t of this.talkers) {
      t.present = t.index < this.crowd;
      t.fade = t.present ? 1 : 0;
      t.cell = Number.NaN;
      t.phraseCell = Number.NaN;
      t.tailUntil = -1;
      t.active = false;
      t.states.fill(0);
      t.tiltState = 0;
      t.formants[0] = Number.NaN;
    }
    for (let v = 0; v < this.clinks.active; v++) {
      this.clinks.live[v].bank.silence();
    }
    this.clinks.active = 0;
    for (const s of this.steam) {
      s.active = false;
    }
    const first = blockOf(from, sr);
    for (let b = first - Math.ceil(CLINK_LONGEST); b <= first; b++) {
      this.loadClinks(b);
      const schedule = this.clinkSchedule;
      for (; schedule.next < schedule.events.count; schedule.next++) {
        const at = schedule.sample(schedule.next, sr);
        if (at >= from) {
          break;
        }
        this.startClink(schedule.hash(schedule.next), from - at);
      }
    }
    for (let b = first - Math.ceil(STEAM_LONGEST); b <= first; b++) {
      this.loadSteam(b);
      const schedule = this.steamSchedule;
      for (; schedule.next < schedule.events.count; schedule.next++) {
        const at = schedule.sample(schedule.next, sr);
        if (at >= from) {
          break;
        }
        this.startSteam(schedule.hash(schedule.next), from - at);
      }
    }
    while (from < start) {
      const n = Math.min(QUANTUM, start - from);
      this.process(this.unheard, 0, n, from);
      from += n;
    }
  }

  private loadClinks(block: number): void {
    this.clinkSchedule.load(block, clinkRate(this.clatter));
  }

  private loadSteam(block: number): void {
    this.steamSchedule.load(block, steamRate(this.clatter));
  }

  /** Strikes the clink of hash `hash`, `elapsed` samples after it struck, unless it has died away. */
  private startClink(hash: number, elapsed: number): void {
    const sr = this.sampleRate;
    const shape = clinkShape(hash);
    if (elapsed >= CLINK_LONGEST * sr) {
      return;
    }
    const voice = this.clinks.allocate();
    const bank = voice.bank;
    bank.clear();
    let sum = 0;
    for (const [m, ratio] of CLINK_RATIOS.entries()) {
      const frequency = shape.base * ratio;
      if (frequency <= CLINK_TOP) {
        sum += CLINK_LEVELS[m] ?? 0;
      }
    }
    for (const [m, ratio] of CLINK_RATIOS.entries()) {
      const frequency = shape.base * ratio;
      const level = frequency <= CLINK_TOP ? (CLINK_LEVELS[m] ?? 0) / sum : 0;
      bank.setMode(m, frequency, shape.decay / Math.sqrt(ratio), level);
    }
    voice.left = shape.peak * panLeft(shape.pan) * Math.SQRT2;
    voice.right = shape.peak * panRight(shape.pan) * Math.SQRT2;
    voice.position = elapsed;
    bank.strike(1, elapsed);
    voice.second = -1;
    if (shape.delay > 0) {
      const second = Math.floor(shape.delay * sr);
      voice.secondGain = DOUBLE_GAIN;
      if (elapsed >= second) {
        bank.strike(DOUBLE_GAIN, elapsed - second);
      } else {
        voice.second = second;
      }
    }
    voice.level = bank.level;
  }

  /** Starts the hiss of hash `hash`, `elapsed` samples in, unless it has ended. */
  private startSteam(hash: number, elapsed: number): void {
    const length = Math.floor(
      between(STEAM_LENGTH, unit(hash, STEAM_LENGTH_SALT)) * this.sampleRate,
    );
    if (elapsed >= length) {
      return;
    }
    let voice = this.steam[0];
    for (const s of this.steam) {
      if (!s.active) {
        voice = s;
        break;
      }
      if (s.position > voice.position) {
        voice = s;
      }
    }
    const pan = STEAM_PAN * (2 * unit(hash, STEAM_PAN_SALT) - 1);
    voice.active = true;
    voice.position = elapsed;
    voice.length = length;
    voice.noise = hashStep(hash, STEAM_NOISE_SALT);
    voice.left = this.steamGain * panLeft(pan) * Math.SQRT2;
    voice.right = this.steamGain * panRight(pan) * Math.SQRT2;
    voice.ic1 = 0;
    voice.ic2 = 0;
    voice.low = 0;
  }

  /** Renders `length` samples (at most a quantum) from absolute sample `start` into `outputs` at `at`. */
  private process(
    outputs: readonly Float32Array[],
    at: number,
    length: number,
    start: number,
  ): void {
    const [dryL, dryR, feedL, feedR] = outputs;
    this.renderTalkers(length, start);

    // The blur on the talkers' sum, into the sound and the feed.
    const talkL = this.talkL;
    const talkR = this.talkR;
    const bp = this.blurPole;
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.blurHighpass;
    const st = this.blur;
    for (let side = 0; side < 2; side++) {
      const input = side === 0 ? talkL : talkR;
      const dry = side === 0 ? dryL : dryR;
      const feed = side === 0 ? feedL : feedR;
      const o = side * 3;
      let low = st[o];
      let ic1 = st[o + 1];
      let ic2 = st[o + 2];
      for (let i = 0; i < length; i++) {
        const x = input[i] ?? 0;
        low = x + bp * (low - x);
        const v3 = low - ic2;
        const v1 = ha1 * ic1 + ha2 * v3;
        const v2 = ic2 + ha2 * ic1 + ha3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const y = low - hk * v1 - v2;
        dry[at + i] = y;
        feed[at + i] = y;
      }
      st[o] = low;
      st[o + 1] = ic1;
      st[o + 2] = ic2;
    }

    this.renderEvents(length, start);
    const eventL = this.eventL;
    const eventR = this.eventR;
    const steamL = this.steamL;
    const steamR = this.steamR;
    for (let i = 0; i < length; i++) {
      const cl = eventL[i] ?? 0;
      const cr = eventR[i] ?? 0;
      const sl = steamL[i] ?? 0;
      const sr = steamR[i] ?? 0;
      dryL[at + i] += cl + sl;
      dryR[at + i] += cr + sr;
      feedL[at + i] += CLINK_SEND * cl + STEAM_SEND * sl;
      feedR[at + i] += CLINK_SEND * cr + STEAM_SEND * sr;
    }

    this.renderRoomTone(dryL, dryR, at, length, start);
    for (let i = at; i < at + length; i++) {
      dryL[i] = guard(dryL[i] ?? 0);
      dryR[i] = guard(dryR[i] ?? 0);
    }
  }

  /** The talkers' sum into `talkL` and `talkR`, from absolute sample `start`. */
  private renderTalkers(length: number, start: number): void {
    this.talkL.fill(0, 0, length);
    this.talkR.fill(0, 0, length);
    let breathFilled = false;
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const grid = now % CONTROL === 0;
      const end = Math.min(length, pos + CONTROL - (((now % CONTROL) + CONTROL) % CONTROL));
      for (const t of this.talkers) {
        if (grid) {
          this.control(t, now);
        }
        if (t.active) {
          if (!breathFilled) {
            this.fillBreath(length, start);
            breathFilled = true;
          }
          this.renderTalker(t, pos, end);
        }
      }
      pos = end;
    }
  }

  /** Hashed white noise for the talkers' breath. */
  private fillBreath(length: number, start: number): void {
    const prefix = this.breathPrefix;
    const white = this.white;
    for (let i = 0; i < length; i++) {
      this.breath[i] = (hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1) * white;
    }
  }

  /** Talker `t`'s control point at absolute sample `n` (a multiple of `CONTROL`). */
  private control(t: Talker, n: number): void {
    const sr = this.sampleRate;
    // Presence fades in or out over `CROWD_FADE`.
    t.present = t.index < this.crowd;
    t.fade = clamp(t.fade + (t.present ? this.fadeStep : -this.fadeStep), 0, 1);
    const time = n / sr;
    const voice = t.voice;
    const s = t.syllable;
    const p = t.phrase;
    const cell = syllableCell(voice, time);
    if (cell !== t.cell) {
      t.cell = cell;
      syllableOf(t.hash, voice, cell, s);
      const centre = (s.start + s.end) / 2;
      const pc = phraseCell(this.seed, t.index, centre);
      if (pc !== t.phraseCell) {
        t.phraseCell = pc;
        phrase(this.seed, t.index, pc, p, this.everyone);
      }
      const along = centre - p.start;
      t.sounding = p.speaking && along >= 0 && along < p.length && (this.everyone || !s.dropped);
      if (t.sounding) {
        t.tailUntil = Math.ceil((s.end + TAIL) * sr);
      }
      // A new syllable's voice starts from zero phase, before it sounds.
      t.phase = 0;
      t.period = 0;
      t.jitter = 1;
      t.shimmer = 1;
    }
    // The formants glide towards the syllable's vowel (a fresh start begins there).
    const vowel = VOWELS[s.vowel] ?? VOWELS[0];
    const f = t.formants;
    const scale = voice.scale * s.spread;
    const fresh = Number.isNaN(f[0]);
    for (let k = 0; k < 3; k++) {
      const target = (vowel[k] ?? 0) * scale;
      f[k] = fresh ? target : (f[k] ?? 0) + (target - (f[k] ?? 0)) * this.glideCoef;
    }
    const wasActive = t.active;
    t.active = t.fade > 0 && n < t.tailUntil;
    if (!t.active) {
      if (wasActive) {
        t.states.fill(0);
        t.tiltState = 0;
      }
      return;
    }
    const next = time + CONTROL / sr;
    const envNow = t.sounding ? syllableEnvelope(time, s.start, s.end) : 0;
    const envNext = t.sounding ? syllableEnvelope(next, s.start, s.end) : 0;
    const gain =
      t.level * t.fade * dbToGain(p.levelDb + STRESS_DB * s.stress) * (t.sounding ? 1 : 0);
    t.envelope = envNow * gain;
    t.envelopeStep = (envNext * gain - t.envelope) / CONTROL;
    t.left = panLeft(voice.pan);
    t.right = panRight(voice.pan);
    const pitch = voice.pitch * 2 ** (pitchOffset(time, s, p) / 12);
    t.base = pitch / sr;
    t.increment = t.base * t.jitter;
    t.tilt = 1 - Math.exp((-2 * Math.PI * TILT * pitch) / sr);
    const c = t.coefficients;
    for (let k = 0; k < 3; k++) {
      const into = c.subarray(4 * k, 4 * k + 4);
      svfCoefficients(into, f[k] ?? 0, FORMANT_Q[k] ?? 1, sr);
      // The band's gain folds the formant's level in.
      into[3] = into[3] * (FORMANT_GAIN[k] ?? 0);
    }
  }

  /** Talker `t`'s voice, added into the talkers' sum from `from` to `to`. */
  private renderTalker(t: Talker, from: number, to: number): void {
    const c = t.coefficients;
    const [a1 = 0, a2 = 0, a3 = 0, k1 = 0, b1 = 0, b2 = 0, b3 = 0, k2 = 0] = c;
    const d1 = c[8];
    const d2 = c[9];
    const d3 = c[10];
    const k3 = c[11];
    const st = t.states;
    let x1 = st[0];
    let x2 = st[1];
    let y1 = st[2];
    let y2 = st[3];
    let z1 = st[4];
    let z2 = st[5];
    let phase = t.phase;
    let increment = t.increment;
    let shimmer = t.shimmer;
    let tiltState = t.tiltState;
    let envelope = t.envelope;
    const step = t.envelopeStep;
    const tilt = t.tilt;
    const breath = this.breath;
    const left = t.left;
    const right = t.right;
    const talkL = this.talkL;
    const talkR = this.talkR;
    for (let i = from; i < to; i++) {
      phase += increment;
      if (phase >= 1) {
        phase -= 1;
        // A new period: its own jitter and shimmer.
        t.period++;
        const h = hashStep(t.hash ^ t.cell, t.period);
        t.jitter = 1 + JITTER * ((h >>> 16) * HALF_SCALE - 1);
        shimmer = dbToGain(SHIMMER_DB * ((h & 0xffff) * HALF_SCALE - 1));
        increment = t.base * t.jitter;
      }
      // A PolyBLEP saw.
      let saw = 2 * phase - 1;
      if (phase < increment) {
        const x = phase / increment;
        saw -= x + x - x * x - 1;
      } else if (phase > 1 - increment) {
        const x = (phase - 1) / increment;
        saw -= x * x + x + x + 1;
      }
      tiltState += tilt * (saw * shimmer - tiltState);
      const source = tiltState + BREATH * (breath[i] ?? 0);
      // Three band-passes, `svfCoefficients`' tick written out.
      let v3 = source - x2;
      let v1 = a1 * x1 + a2 * v3;
      let v2 = x2 + a2 * x1 + a3 * v3;
      x1 = 2 * v1 - x1;
      x2 = 2 * v2 - x2;
      let y = k1 * v1;
      v3 = source - y2;
      v1 = b1 * y1 + b2 * v3;
      v2 = y2 + b2 * y1 + b3 * v3;
      y1 = 2 * v1 - y1;
      y2 = 2 * v2 - y2;
      y += k2 * v1;
      v3 = source - z2;
      v1 = d1 * z1 + d2 * v3;
      v2 = z2 + d2 * z1 + d3 * v3;
      z1 = 2 * v1 - z1;
      z2 = 2 * v2 - z2;
      y += k3 * v1;
      y *= envelope;
      envelope += step;
      talkL[i] += left * y;
      talkR[i] += right * y;
    }
    st[0] = x1;
    st[1] = x2;
    st[2] = y1;
    st[3] = y2;
    st[4] = z1;
    st[5] = z2;
    t.phase = phase;
    t.increment = increment;
    t.shimmer = shimmer;
    t.tiltState = tiltState;
    t.envelope = envelope;
  }

  /** The clinks into `eventL`/`eventR` and the steam into `steamL`/`steamR`. */
  private renderEvents(length: number, start: number): void {
    const sr = this.sampleRate;
    this.eventL.fill(0, 0, length);
    this.eventR.fill(0, 0, length);
    this.steamL.fill(0, 0, length);
    this.steamR.fill(0, 0, length);
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.clinkSchedule.block) {
        this.loadClinks(block);
      }
      if (block !== this.steamSchedule.block) {
        this.loadSteam(block);
      }
      const cs = this.clinkSchedule;
      while (cs.next < cs.events.count && cs.sample(cs.next, sr) <= now) {
        this.startClink(cs.hash(cs.next), now - cs.sample(cs.next, sr));
        cs.next++;
      }
      const ss = this.steamSchedule;
      while (ss.next < ss.events.count && ss.sample(ss.next, sr) <= now) {
        this.startSteam(ss.hash(ss.next), now - ss.sample(ss.next, sr));
        ss.next++;
      }
      let end = Math.min(length, (block + 1) * sr - start);
      if (cs.next < cs.events.count) {
        end = Math.min(end, cs.sample(cs.next, sr) - start);
      }
      if (ss.next < ss.events.count) {
        end = Math.min(end, ss.sample(ss.next, sr) - start);
      }
      this.renderClinks(pos, end);
      for (const s of this.steam) {
        if (s.active) {
          this.renderSteam(s, pos, end);
        }
      }
      pos = end;
    }
  }

  /** The clinks ringing, added into `eventL` and `eventR` from `from` to `to`. */
  private renderClinks(from: number, to: number): void {
    const pool = this.clinks;
    const ring = this.ring;
    for (let v = pool.active - 1; v >= 0; v--) {
      const voice = pool.live[v];
      const bank = voice.bank;
      ring.fill(0, from, to);
      let i = from;
      // A double clink's second strike, part-way through.
      if (voice.second >= 0 && voice.second - voice.position < to - from) {
        const split = from + (voice.second - voice.position);
        bank.render(ring, from, split);
        bank.strike(voice.secondGain);
        voice.second = -1;
        i = split;
      }
      bank.render(ring, i, to);
      voice.position += to - from;
      const left = voice.left;
      const right = voice.right;
      for (let j = from; j < to; j++) {
        const x = ring[j] ?? 0;
        this.eventL[j] += left * x;
        this.eventR[j] += right * x;
      }
      voice.level = bank.level;
      if (!bank.ringing && voice.second < 0) {
        pool.release(v);
      }
    }
  }

  /** A steam hiss, added into `steamL` and `steamR` from `from` to `to`. */
  private renderSteam(voice: SteamVoice, from: number, to: number): void {
    const sr = this.sampleRate;
    const [a1 = 0, a2 = 0, a3 = 0, k = 0] = this.steamBand;
    const pole = this.steamPole;
    const lengthSeconds = voice.length / sr;
    let n = voice.position;
    const stop = Math.min(to, from + (voice.length - n));
    let ic1 = voice.ic1;
    let ic2 = voice.ic2;
    let low = voice.low;
    for (let i = from; i < stop; i++, n++) {
      const x = (hashStep(voice.noise, n) * UINT32_SCALE * 2 - 1) * UNIFORM_TO_UNIT;
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      const band = k * v1;
      low = band + pole * (low - band);
      const y = low * steamEnvelope(n / sr, lengthSeconds);
      this.steamL[i] += voice.left * y;
      this.steamR[i] += voice.right * y;
    }
    voice.ic1 = ic1;
    voice.ic2 = ic2;
    voice.low = low;
    voice.position = n;
    if (n >= voice.length) {
      voice.active = false;
    }
  }

  /** The room tone, added into `left` and `right` at `at`. */
  private renderRoomTone(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const [p1 = 0, p2 = 0] = this.pinkPoles;
    const [g1 = 0, g2 = 0] = this.pinkGains;
    const lp = this.roomTonePole;
    const gain = this.roomToneGain;
    const white = this.white;
    const prefix = this.noisePrefix;
    const st = this.roomTone;
    let l1 = st[0];
    let l2 = st[1];
    let l3 = st[2];
    let r1 = st[3];
    let r2 = st[4];
    let r3 = st[5];
    for (let i = 0; i < length; i++) {
      // One hash per sample: its high half for the left, its low half for the right.
      const hash = hashStep(prefix, start + i);
      const wl = ((hash >>> 16) * HALF_SCALE - 1) * white;
      const wr = ((hash & 0xffff) * HALF_SCALE - 1) * white;
      l1 = p1 * l1 + g1 * wl;
      l2 = p2 * l2 + g2 * wl;
      r1 = p1 * r1 + g1 * wr;
      r2 = p2 * r2 + g2 * wr;
      const pl = l1 + l2 + PINK_DIRECT * wl;
      const pr = r1 + r2 + PINK_DIRECT * wr;
      l3 = pl + lp * (l3 - pl);
      r3 = pr + lp * (r3 - pr);
      left[at + i] += gain * l3;
      right[at + i] += gain * r3;
    }
    st[0] = l1;
    st[1] = l2;
    st[2] = l3;
    st[3] = r1;
    st[4] = r2;
    st[5] = r3;
  }
}

interface CoffeeShopOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readCoffeeShopOptions(raw: unknown): CoffeeShopOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
