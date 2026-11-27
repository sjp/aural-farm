/**
 * The built-in presets: hand-tuned mixes that show what the app can do, listed
 * most appealing first in the Mixes view. Each hash is written in the full form
 * Copy link uses, every value spelled out (and the name as `name=`), so a preset
 * keeps its sound when a default changes and reads plainly in review.
 *
 * A preset ships only once every sound it uses is registered (`presets.test.ts`
 * checks). Planned presets still waiting for their sounds, each to be added here
 * along with the last of its sounds:
 *
 *   Engine Room       Starship Engine Core, Life Support
 *   Night Shift       Starship Engine Core (power 40), Starship Bridge (quiet), Crew Quarters
 *   Rainy Cabin       Rain (on a roof), Fireplace, Ticking Clock
 *   Stormy Night      Rain (heavy), Distant Thunder, Wind
 *   Seaside           Ocean Waves, Wind (light)
 *   Summer Night      Night Insects, Stream (quiet), Wind (light)
 *   Dawn Chorus       Birdsong (dawn), Stream
 *   Night Train       Train Carriage, Rain (on a window)
 *   Long-haul Flight  Airplane Cabin, Brown Noise
 *   Café Study        Coffee Shop, Rain (light)
 *   City Night        Distant City (night), Rain (light)
 *   Server Hall       Server Room, Fan
 *   Deep Focus        Pink Noise, Binaural Beats, Drone Pad
 *   Meditation        Singing Bowls, Wind Chimes, Drone Pad
 *   Baby Sleep        Heartbeat, Brown Noise, Fan
 */

interface Preset {
  /** A stable id, in kebab-case. */
  id: string;
  /** The name shown, the same as the hash's `name=`. */
  name: string;
  /** One line on what it sounds like. */
  description: string;
  /** The mix, in the full hash form, with its leading `#`. */
  hash: string;
}

export const presets: readonly Preset[] = [
  {
    id: "engine-hum",
    name: "Engine Hum",
    description: "A starship's engine at low power, over a soft, deep rumble.",
    hash:
      "#name=Engine%20Hum&master=70&layers=engine-core,brown-noise" +
      "&engine-core.volume=75&engine-core.muted=0&engine-core.power=40&engine-core.pitch=46" +
      "&engine-core.pulseRate=0.7&engine-core.pulseDepth=35&engine-core.room=50" +
      "&engine-core.hiss=20&engine-core.seed=1" +
      "&brown-noise.volume=40&brown-noise.muted=0&brown-noise.tone=-30&brown-noise.width=80" +
      "&brown-noise.movement=25&brown-noise.seed=1",
  },
  {
    id: "deep-brown",
    name: "Deep Brown",
    description: "Dark, wide brown noise that swells now and then, for sleep.",
    hash:
      "#name=Deep%20Brown&master=70&layers=brown-noise" +
      "&brown-noise.volume=75&brown-noise.muted=0&brown-noise.tone=-40&brown-noise.width=85" +
      "&brown-noise.movement=30&brown-noise.seed=1",
  },
  {
    id: "soft-pink",
    name: "Soft Pink",
    description: "Gentle, slightly darkened pink noise, for focus or sleep.",
    hash:
      "#name=Soft%20Pink&master=70&layers=pink-noise" +
      "&pink-noise.volume=65&pink-noise.muted=0&pink-noise.tone=-25&pink-noise.width=70" +
      "&pink-noise.movement=25&pink-noise.seed=1",
  },
  {
    id: "masking-blend",
    name: "Masking Blend",
    description: "Brown, pink and a little white noise, to cover voices and traffic.",
    hash:
      "#name=Masking%20Blend&master=70&layers=brown-noise,pink-noise,white-noise" +
      "&brown-noise.volume=55&brown-noise.muted=0&brown-noise.tone=-10&brown-noise.width=70" +
      "&brown-noise.movement=15&brown-noise.seed=2" +
      "&pink-noise.volume=55&pink-noise.muted=0&pink-noise.tone=0&pink-noise.width=70" +
      "&pink-noise.movement=15&pink-noise.seed=3" +
      "&white-noise.volume=30&white-noise.muted=0&white-noise.tone=-50&white-noise.width=60" +
      "&white-noise.movement=10&white-noise.seed=4",
  },
];
