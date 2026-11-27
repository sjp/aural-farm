# Aural Farm

Ambient and background sound, generated live in the browser with the Web Audio API. Nothing
is sampled or downloaded: every sound is synthesised as it plays, from noise, oscillators,
filters and seeded random events. Layer several sounds into a mix, tune each one, and share
the mix as a link.

## Running it

Use Node 26 (the version is in `.nvmrc`; the devcontainer already has it).

```sh
npm install
npm run dev           # dev server with hot reload
npm run build         # type-check and build to dist/
npm run check         # linting, formatting and unused exports
npm test              # vitest
npm run test:browser  # Playwright, in headless Chromium, including the sound checks
npm run render -- engine-core  # render a sound to a WAV file (see below)
```

`npm run test:browser` needs Chromium once: `npx playwright install chromium`.

### Sound checks

`npm run test:browser` also renders every sound in headless Chromium, faster than real
time in an `OfflineAudioContext`, and measures what can be measured without ears: its
loudness (about −23 LUFS at default settings) and peaks at every setting's extremes, DC
and sub-bass, mono compatibility, how much of it small speakers can play, clicks when a
setting changes or the variation crossfades, whether two renders match, whether a render
started later lines up with one started earlier, and its render cost against its budget.
A last check plays every sound at once through the master chain and watches the limiter.
The pass marks, and the few sounds allowed to miss one (with the reason), are in
`e2e/sound-thresholds.ts`.

The run ends with a table of the measurements, also written to `test-results/sounds.json`.
The cost checks time renders, so they run one at a time after everything else.

## Listening to a sound

`npm run render` renders a sound to a 16-bit, 48 kHz stereo WAV file in `renders/`, so it
can be listened to (and compared) without opening the app:

```sh
npm run render -- engine-core                      # 60 s at its defaults: renders/engine-core-1.wav
npm run render -- engine-core --seconds 300 --seed 2 --param pitch=40 --param hiss=0
npm run render -- --all                            # every sound at its defaults, 60 s each
npm run render -- "#layers=engine-core,brown-noise&brown-noise.volume=40"
```

A sound renders on its own at full layer volume, without the master chain; add `--master`
to play it through the master's high-pass and limiter. `--param` takes a setting's key as
it appears in the address bar (`pitch`, `hiss`, `seed`, …). A mix hash, copied from the
address bar or **Copy link**, renders the whole mix through the master chain, as the app
plays it, to `renders/mix-<sounds>.wav`. Listen on headphones and on laptop speakers.

## Using it

The page starts playing as soon as it opens. If the browser blocks sound until you interact
with the page, the Play button turns into **Tap to play**, and the first tap, click or key
press anywhere starts it. Playback carries on in a background tab. Pausing fades the sound
out and then suspends the audio, so nothing runs while paused.

The control panel sits in the top-right corner and fades out, with the cursor, after a few
seconds without input. It is a mixer for up to eight sounds, played at once.

The header has **Play/Pause**, **Copy link**, **Fullscreen** and **Hide**, and under them the
**master volume**, with a speaker button that mutes everything. Each layer of the mix is a
row with:

- a **tint dot** that glows with the layer's level while it plays;
- the sound's name, and a short hint for some sounds;
- **Solo (S)**: while any layer is soloed, only the soloed layers are heard, and the header
  offers **Clear solo**;
- **Mute (M)**: the row dims, and its controls still work;
- a chevron that shows the sound's own settings (sliders, toggles and lists, with a button
  to reset each one to its default); a newly added sound opens, and the others close;
- **Remove (✕)**, which fades the layer out and shows a toast with **Undo** for a few
  seconds;
- a **volume** slider, always shown.

**Add sound** under the rows lists every sound not yet in the mix; a new layer joins at
the end, at volume 70. An empty mix says so, and Play stays disabled until a sound is added.
If a sound fails to load or crashes, its layer says so and offers **Retry** and **Remove**;
the other layers keep playing. The footer has **Reset all**, which puts every layer's
settings and volume, and the master volume, back to their defaults while keeping the layers
and their mutes.

The whole mix is kept in the URL hash, so a link reopens the same mix: the master volume,
the layers in order, and each layer's volume, mute and settings. Solo and muting everything
are listening aids and aren't saved. Editing or pasting a hash applies it without a reload.
Hiding the panel adds `panel=hidden`, and a page opened with it starts with the panel and
cursor hidden.

**Copy link** copies a link that spells out every setting, defaults included, plus
`panel=hidden`, so the mix sounds the same even if a default changes later.

### Sounds

A fresh visit opens with **Starship Engine Core**: the deep, steady hum of a large engine
in a metal room, with a slow, breathing throb. Its settings are **Power** (how hard the
engine runs: darker and softer to brighter and richer), **Pitch** (the drone's fundamental,
32–72 Hz; everything in the sound follows it), **Pulse rate** and **Pulse depth** (how often
and how strongly the throb swells; depth 0 is a steady hum), **Room** (metallic resonances
and reverb), **Hiss** (faint ventilation air on top) and **Variation**, which crossfades to
different slow drifts and room detail while the hum plays on.

The noise colours (**Brown**, **Pink**, **White** and **Grey Noise**) are the plain, steady
noises used for sleep, focus and masking. Each has **Tone** (darker to brighter), **Width**
(mono to wide stereo, at a steady level), **Movement** (slow, subtle swells; 0 is perfectly
steady) and **Variation**, which crossfades to a different take on the same noise.

### Keyboard shortcuts

| Key                 | Action                                |
| ------------------- | ------------------------------------- |
| `Space`             | Play or pause                         |
| `/`                 | Add a sound (opens the list, focused) |
| `1`–`8`             | Mute or unmute layer N                |
| `Shift+1`–`Shift+8` | Solo or unsolo layer N                |
| `M`                 | Mute or unmute everything             |
| `↑` / `↓`           | Master volume up or down by 5         |
| `H`                 | Hide or show the control panel        |
| `F`                 | Toggle fullscreen                     |
| `?`                 | Show the keyboard shortcuts           |

Shortcuts are ignored while a form field has focus (`Space` still works on a slider, but
on a focused button it presses the button). `↑` and `↓` change the master volume only when
no control has focus. On touch devices, tap the corner button
to bring a hidden panel back.
