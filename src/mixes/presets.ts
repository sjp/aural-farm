/**
 * The built-in presets: hand-tuned mixes that show what the app can do, listed
 * most appealing first in the Mixes view. Each hash is written in the full form
 * Copy link uses, every value spelled out (and the name as `name=`), so a preset
 * keeps its sound when a default changes and reads plainly in review.
 *
 * A preset ships only once every sound it uses is registered (`presets.test.ts`
 * checks), and each is added along with the last of its sounds.
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
    id: "rainy-cabin",
    name: "Rainy Cabin",
    description: "Rain on the roof, a crackling fire and a clock ticking on the shelf.",
    hash:
      "#name=Rainy%20Cabin&master=70&layers=fireplace,rain,clock" +
      "&fireplace.volume=65&fireplace.muted=0&fireplace.size=45&fireplace.crackle=45" +
      "&fireplace.wood=hardwood&fireplace.room=40&fireplace.seed=1" +
      "&rain.volume=55&rain.muted=0&rain.intensity=45&rain.surface=roof&rain.distance=40" +
      "&rain.bubbles=20&rain.seed=1" +
      "&clock.volume=90&clock.muted=0&clock.clock=mantel&clock.tone=30&clock.room=45" +
      "&clock.chime=0&clock.seed=1",
  },
  {
    id: "night-train",
    name: "Night Train",
    description: "A sleeper carriage clacking through the night, rain on the window beside you.",
    hash:
      "#name=Night%20Train&master=70&layers=train,rain" +
      "&train.volume=75&train.muted=0&train.speed=100&train.track=jointed&train.clacks=55" +
      "&train.points=rarely&train.seed=1" +
      "&rain.volume=55&rain.muted=0&rain.intensity=40&rain.surface=window&rain.distance=20" +
      "&rain.bubbles=25&rain.seed=1",
  },
  {
    id: "city-night",
    name: "City Night",
    description: "A city at night from an open window, light rain falling on the street below.",
    hash:
      "#name=City%20Night&master=70&layers=city,rain" +
      "&city.volume=75&city.muted=0&city.time=night&city.traffic=50&city.rumble=60" +
      "&city.signals=off&city.space=55&city.seed=1" +
      "&rain.volume=50&rain.muted=0&rain.intensity=25&rain.surface=ground&rain.distance=45" +
      "&rain.bubbles=30&rain.seed=1",
  },
  {
    id: "cafe-study",
    name: "Café Study",
    description: "A corner table in a busy café, light rain running down the window beside it.",
    hash:
      "#name=Caf%C3%A9%20Study&master=70&layers=coffee-shop,rain" +
      "&coffee-shop.volume=70&coffee-shop.muted=0&coffee-shop.crowd=6&coffee-shop.clatter=35" +
      "&coffee-shop.room=55&coffee-shop.seed=1" +
      "&rain.volume=50&rain.muted=0&rain.intensity=30&rain.surface=window&rain.distance=35" +
      "&rain.bubbles=25&rain.seed=1",
  },
  {
    id: "meditation",
    name: "Meditation",
    description: "Singing bowls struck now and then over a warm, slow chord, chimes stirring by.",
    hash:
      "#name=Meditation&master=70&layers=bowls,drone,chimes" +
      "&bowls.volume=70&bowls.muted=0&bowls.root=a&bowls.bowls=3&bowls.interval=25" +
      "&bowls.rub=0&bowls.space=50&bowls.seed=1" +
      "&drone.volume=55&drone.muted=0&drone.key=a&drone.brightness=30&drone.movement=30" +
      "&drone.space=60&drone.seed=1" +
      "&chimes.volume=50&chimes.muted=0&chimes.tuning=major&chimes.tubes=5&chimes.wind=20" +
      "&chimes.space=40&chimes.seed=1",
  },
  {
    id: "deep-focus",
    name: "Deep Focus",
    description: "A soft hush over a warm, slow chord, and two quiet tones pulsing gently.",
    hash:
      "#name=Deep%20Focus&master=70&layers=pink-noise,binaural,drone" +
      "&pink-noise.volume=60&pink-noise.muted=0&pink-noise.tone=-20&pink-noise.width=70" +
      "&pink-noise.movement=20&pink-noise.seed=1" +
      "&binaural.volume=65&binaural.muted=0&binaural.preset=alpha&binaural.beat=10" +
      "&binaural.carrier=220&binaural.mode=binaural&binaural.bed=0&binaural.seed=1" +
      "&drone.volume=70&drone.muted=0&drone.key=d&drone.brightness=30&drone.movement=35" +
      "&drone.space=55&drone.seed=1",
  },
  {
    id: "baby-sleep",
    name: "Baby Sleep",
    description: "A slow, muffled heartbeat over soft brown noise and a fan's gentle hum.",
    hash:
      "#name=Baby%20Sleep&master=70&layers=heartbeat,brown-noise,fan" +
      "&heartbeat.volume=75&heartbeat.muted=0&heartbeat.rate=62&heartbeat.muffle=70" +
      "&heartbeat.bed=50&heartbeat.seed=1" +
      "&brown-noise.volume=45&brown-noise.muted=0&brown-noise.tone=-35&brown-noise.width=75" +
      "&brown-noise.movement=20&brown-noise.seed=1" +
      "&fan.volume=35&fan.muted=0&fan.type=desk&fan.speed=35&fan.tone=30" +
      "&fan.motor=15&fan.oscillate=0&fan.seed=1",
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
    id: "server-hall",
    name: "Server Hall",
    description: "Rows of humming server racks, cooled by an air conditioner's steady blow.",
    hash:
      "#name=Server%20Hall&master=70&layers=server-room,fan" +
      "&server-room.volume=75&server-room.muted=0&server-room.airflow=60&server-room.racks=9" +
      "&server-room.hvac=55&server-room.whine=10&server-room.disks=0&server-room.seed=1" +
      "&fan.volume=45&fan.muted=0&fan.type=air-conditioner&fan.speed=55&fan.tone=35" +
      "&fan.motor=30&fan.oscillate=0&fan.seed=1",
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
