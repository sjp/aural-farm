import { withAudioScope } from "../../audio/scope";
import { defineSound } from "../types";
import { testToneMeta } from "./test-tone.meta";

/** About −26 dBFS: quiet, so the tone never startles. */
const LEVEL = 0.05;
/** Time constant for pitch and level glides, in seconds. */
const GLIDE = 0.08;
/** Time constant for the tone-colour glide, in seconds. */
const TIMBRE_GLIDE = 0.4;
/** The lowpass cutoff, as a multiple of the pitch, with Soft on and off. */
const SOFT_CUTOFF = 1.5;
const OPEN_CUTOFF = 20;

/** A detune of up to ±5 cents picked by the seed, so variations differ slightly. */
function detuneFor(seed: number): number {
  return (Math.trunc(seed) % 11) - 5;
}

/**
 * A plain oscillator through a gentle lowpass. It exists to exercise the sound
 * pipeline (registry, lazy loading, params and controls) end to end.
 */
export const testTone = defineSound(testToneMeta, {
  create(ctx, out, init) {
    return withAudioScope((scope) => {
      const osc = scope.addSource(
        new OscillatorNode(ctx, {
          type: init.params.wave,
          frequency: init.params.pitch,
          detune: detuneFor(init.seed),
        }),
      );
      const filter = scope.add(
        new BiquadFilterNode(ctx, {
          type: "lowpass",
          Q: 0.5,
          frequency: init.params.pitch * (init.params.soft ? SOFT_CUTOFF : OPEN_CUTOFF),
        }),
      );
      const gain = scope.add(new GainNode(ctx, { gain: LEVEL }));
      osc.connect(filter).connect(gain).connect(out);
      osc.start(init.startAt);
      return {
        update(params, when) {
          osc.frequency.setTargetAtTime(params.pitch, when, GLIDE);
          osc.detune.setTargetAtTime(detuneFor(params.seed), when, GLIDE);
          filter.frequency.setTargetAtTime(
            params.pitch * (params.soft ? SOFT_CUTOFF : OPEN_CUTOFF),
            when,
            TIMBRE_GLIDE,
          );
          if (osc.type !== params.wave) {
            osc.type = params.wave;
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    }, init.onError);
  },
});
