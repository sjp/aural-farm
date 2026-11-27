/**
 * Seeded randomness. Nothing in the sound or audio code may use the global RNG:
 * every sound must be reproducible from its seed and time-addressable.
 *
 * - `hash32` and `hashFloat` are stateless: the same arguments always give the
 *   same value, so anything that unfolds over time (noise samples, events,
 *   modulation knots) hashes its own coordinates rather than drawing from a stream.
 * - `createRng` is a small seeded generator for build-time choices (voicings,
 *   resonance layouts), never for anything that unfolds over time.
 *
 * Give each independent random source in a sound its own `stream` constant (a
 * small integer) as an argument, so adding a source never shifts the others.
 *
 * Plain TypeScript with no Web Audio or DOM globals: it runs in worklets too.
 */

/** The fold's starting state, so `hash32()` and `hash32(0)` differ. */
const HASH_INIT = 0x9e3779b9;

/** lowbias32: a fast, well-mixing 32-bit integer hash (a bijection on uint32). */
export function lowbias32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * One step of `hash32`'s fold: the state after also hashing `x`. Lets a hot loop
 * hash a shared prefix once and then one argument per sample:
 * `hashStep(hash32(a, b), n) === hash32(a, b, n)`.
 */
export function hashStep(state: number, x: number): number {
  return lowbias32(state ^ x);
}

/**
 * A 32-bit unsigned hash of integer arguments: lowbias32 folded over them. Each
 * argument is taken modulo 2³² (negative integers work), so it is stable across
 * platforms.
 */
export function hash32(...ints: number[]): number {
  let h = HASH_INIT;
  for (const x of ints) {
    h = lowbias32(h ^ x);
  }
  return h;
}

/** 2⁻³², to map a uint32 into [0, 1). */
export const UINT32_SCALE = 1 / 4294967296;

/** `hash32(...ints) / 2³²`, in [0, 1). */
export function hashFloat(...ints: number[]): number {
  return hash32(...ints) * UINT32_SCALE;
}

export interface Rng {
  /** A float in [0, 1). */
  next: () => number;
  /** A float in [a, b). */
  range: (a: number, b: number) => number;
  /** An integer in [0, n). */
  int: (n: number) => number;
  /** A standard normal value (mean 0, standard deviation 1). */
  gaussian: () => number;
}

/** A seeded sfc32 generator, its state seeded through `hash32`. */
export function createRng(seed: number): Rng {
  let a = hash32(seed, 1);
  let b = hash32(seed, 2);
  let c = hash32(seed, 3);
  let d = 1;
  // sfc32 works modulo 2³²; `>>> 0` wraps each sum.
  const next = () => {
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t * UINT32_SCALE;
  };
  // Mix the state before the first draw.
  for (let i = 0; i < 12; i++) {
    next();
  }
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (n) => Math.floor(next() * n),
    gaussian: () => {
      // Box–Muller; 1 − u keeps the logarithm finite.
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}
