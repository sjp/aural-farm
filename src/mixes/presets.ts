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
 *   Rainy Cabin       Rain (on a roof), Fireplace, Ticking Clock
 *   Night Train       Train Carriage, Rain (on a window)
 *   Café Study        Coffee Shop, Rain (light)
 *   City Night        Distant City (night), Rain (light)
 *   Server Hall       Server Room, Fan
 *   Deep Focus        Pink Noise, Binaural Beats, Drone Pad
 *   Meditation        Singing Bowls, Wind Chimes, Drone Pad
 *   Baby Sleep        Heartbeat, Brown Noise, Fan
 */

export interface Preset {
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
    id: "night-shift",
    name: "Night Shift",
    description: "A starship at night: low engines, a quiet bridge and a cabin's soft rumble.",
    hash:
      "#name=Night%20Shift&master=70&layers=quarters,engine-core,bridge" +
      "&quarters.volume=75&quarters.muted=0&quarters.air=60&quarters.hum=30&quarters.hull=45" +
      "&quarters.warmth=65&quarters.seed=1" +
      "&engine-core.volume=50&engine-core.muted=0&engine-core.power=40&engine-core.pitch=46" +
      "&engine-core.pulseRate=0.7&engine-core.pulseDepth=25&engine-core.room=45" +
      "&engine-core.hiss=10&engine-core.seed=1" +
      "&bridge.volume=45&bridge.muted=0&bridge.activity=quiet&bridge.engine=25&bridge.air=40" +
      "&bridge.doors=off&bridge.alert=0&bridge.seed=1",
  },
  {
    id: "engine-room",
    name: "Engine Room",
    description: "The engine core's deep throb over the quiet, steady work of life support.",
    hash:
      "#name=Engine%20Room&master=70&layers=engine-core,life-support" +
      "&engine-core.volume=75&engine-core.muted=0&engine-core.power=60&engine-core.pitch=48" +
      "&engine-core.pulseRate=0.82&engine-core.pulseDepth=45&engine-core.room=55" +
      "&engine-core.hiss=30&engine-core.seed=1" +
      "&life-support.volume=45&life-support.muted=0&life-support.flow=55&life-support.pump=40" +
      "&life-support.pumpCycle=28&life-support.valves=rarely&life-support.hum=30" +
      "&life-support.seed=1",
  },
  {
    id: "seaside",
    name: "Seaside",
    description: "Waves breaking on a sandy shore, under a light breeze off the sea.",
    hash:
      "#name=Seaside&master=70&layers=ocean,wind" +
      "&ocean.volume=75&ocean.muted=0&ocean.period=11&ocean.size=45&ocean.distance=40" +
      "&ocean.shore=sand&ocean.seed=1" +
      "&wind.volume=55&wind.muted=0&wind.strength=25&wind.gustiness=40&wind.setting=field" +
      "&wind.whistle=0&wind.seed=1",
  },
  {
    id: "stormy-night",
    name: "Stormy Night",
    description: "Heavy rain on the window and wind around the house, as a storm rumbles far off.",
    hash:
      "#name=Stormy%20Night&master=70&layers=rain,thunder,wind" +
      "&rain.volume=70&rain.muted=0&rain.intensity=85&rain.surface=window&rain.distance=30" +
      "&rain.bubbles=20&rain.seed=1" +
      "&thunder.volume=80&thunder.muted=0&thunder.often=sometimes&thunder.distance=30" +
      "&thunder.roll=60&thunder.seed=1" +
      "&wind.volume=50&wind.muted=0&wind.strength=65&wind.gustiness=60&wind.setting=house" +
      "&wind.whistle=30&wind.seed=1",
  },
  {
    id: "dawn-chorus",
    name: "Dawn Chorus",
    description: "Songbirds near and far greeting the day, over a gentle brook.",
    hash:
      "#name=Dawn%20Chorus&master=70&layers=birdsong,stream" +
      "&birdsong.volume=75&birdsong.muted=0&birdsong.time=dawn&birdsong.density=55" +
      "&birdsong.distance=40&birdsong.seed=1" +
      "&stream.volume=60&stream.muted=0&stream.flow=45&stream.size=30&stream.distance=35" +
      "&stream.seed=1",
  },
  {
    id: "summer-night",
    name: "Summer Night",
    description: "Crickets on a warm night, a quiet brook nearby and a breeze in the trees.",
    hash:
      "#name=Summer%20Night&master=70&layers=insects,stream,wind" +
      "&insects.volume=75&insects.muted=0&insects.count=6&insects.warmth=22&insects.distance=40" +
      "&insects.katydids=0&insects.seed=1" +
      "&stream.volume=50&stream.muted=0&stream.flow=35&stream.size=25&stream.distance=50" +
      "&stream.seed=1" +
      "&wind.volume=45&wind.muted=0&wind.strength=25&wind.gustiness=35&wind.setting=trees" +
      "&wind.whistle=0&wind.seed=1",
  },
  {
    id: "long-haul-flight",
    name: "Long-haul Flight",
    description: "A night flight from a seat over the wing, deepened with soft brown noise.",
    hash:
      "#name=Long-haul%20Flight&master=70&layers=airplane,brown-noise" +
      "&airplane.volume=75&airplane.muted=0&airplane.seat=wing&airplane.engines=35" +
      "&airplane.vent=30&airplane.chime=off&airplane.seed=1" +
      "&brown-noise.volume=40&brown-noise.muted=0&brown-noise.tone=-30&brown-noise.width=80" +
      "&brown-noise.movement=15&brown-noise.seed=1",
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
