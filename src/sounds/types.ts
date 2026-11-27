/**
 * The sound model. A sound is split in two: its metadata (`defineSoundMeta`), which
 * is small and ships in the entry chunk so the panel can list and configure every
 * sound, and its implementation (`defineSound`), which is loaded on demand.
 */

export interface NumberParam {
  kind: "number";
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown after the value, e.g. "Hz". */
  unit?: string;
  /** "log" moves the slider logarithmically; the stored value is still the real one. */
  scale?: "linear" | "log";
  group?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectParam {
  kind: "select";
  label: string;
  options: readonly SelectOption[];
  default: string;
  group?: string;
}

interface BooleanParam {
  kind: "boolean";
  label: string;
  default: boolean;
  group?: string;
}

/** One setting of a sound. `group` picks the panel section it appears in. */
export type ParamDef = NumberParam | SelectParam | BooleanParam;

export type ParamSchema = Readonly<Record<string, ParamDef>>;

/** The value type a param holds: a select holds one of its option values. */
export type ParamValue<D extends ParamDef = ParamDef> = D extends NumberParam
  ? number
  : D extends { kind: "select"; options: readonly { value: infer V }[] }
    ? V
    : D extends BooleanParam
      ? boolean
      : never;

/** A value for every param of a schema. */
export type ParamValues<P extends ParamSchema = ParamSchema> = {
  -readonly [K in keyof P]: ParamValue<P[K]>;
};

export const SOUND_CATEGORIES = [
  "Noise",
  "Sci-fi",
  "Nature",
  "Machines",
  "Places",
  "Tonal",
  "Cosy",
  "Sleep",
  "Focus",
] as const;

type SoundCategory = (typeof SOUND_CATEGORIES)[number];

/** Rough CPU cost of one layer, for sorting the lightest sounds first. */
type SoundCost = "very low" | "low" | "medium";

export interface SoundMeta<P extends ParamSchema = ParamSchema> {
  id: string;
  name: string;
  description: string;
  /** 1–3 categories, primary first. */
  categories: readonly [SoundCategory, ...SoundCategory[]];
  /** Lowercase search words not already in the name, description or categories. */
  tags: readonly string[];
  cost: SoundCost;
  /** The backdrop's and the mixer's colour for this sound. */
  tint: `#${string}`;
  /** A short note under the layer name, e.g. "Use headphones". */
  hint?: string;
  params: P;
}

interface SoundInit<P extends ParamSchema = ParamSchema> {
  params: ParamValues<P>;
  seed: number;
  /** Context time, in seconds, the sound starts at. */
  startAt: number;
  /**
   * Reports a failure after `create` has returned, such as a worklet processor
   * crashing; the engine then disposes this layer alone. Pass it to `withAudioScope`.
   */
  onError?: (error: unknown) => void;
}

/** A running sound. `when` is the context time a change applies from. */
interface SoundInstance<P extends ParamSchema = ParamSchema> {
  update: (params: ParamValues<P>, when: number) => void;
  /** Stops and disconnects everything the sound built. */
  dispose: () => void;
}

interface SoundImplementation<P extends ParamSchema = ParamSchema> {
  /**
   * Builds the sound's graph in `ctx` (a live or offline context) and connects it to
   * `out`. It must not touch `ctx.destination`, the DOM or timers. It may be async,
   * for a sound that has to load a worklet module first.
   */
  create: (
    ctx: BaseAudioContext,
    out: AudioNode,
    init: SoundInit<P>,
  ) => SoundInstance<P> | Promise<SoundInstance<P>>;
}

/** A loaded sound: its metadata plus its implementation. */
export type SoundDefinition = SoundMeta & SoundImplementation;

/** Declares a sound's metadata, keeping the exact param schema for `defineSound`. */
export function defineSoundMeta<const P extends ParamSchema>(meta: SoundMeta<P>): SoundMeta<P> {
  return meta;
}

/**
 * Pairs a sound's metadata with its implementation. `create` and `update` get
 * their param types from the schema, so a schema change is a type error there.
 */
export function defineSound<const P extends ParamSchema>(
  meta: SoundMeta<P>,
  implementation: SoundImplementation<P>,
): SoundDefinition {
  // The engine only ever passes params coerced against this sound's own schema, so
  // widening the implementation to the general param types is safe.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const create = implementation.create as unknown as SoundImplementation["create"];
  return { ...meta, create };
}
