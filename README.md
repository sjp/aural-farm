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
- a **star**, while the row is expanded, which adds the sound to your favourites;
- **Solo (S)**: while any layer is soloed, only the soloed layers are heard, and the header
  offers **Clear solo**;
- **Mute (M)**: the row dims, and its controls still work;
- a chevron that shows the sound's description (two lines, with **More** for the rest) and
  its own settings (sliders, toggles and lists, with a button to reset each one to its
  default); a newly added sound opens, and the others close;
- **Remove (✕)**, which fades the layer out and shows a toast with **Undo** for a few
  seconds;
- a **volume** slider, always shown.

**Add sound** under the rows opens the sound picker in place of the mixer. Its search field
finds sounds by name, description, tags and categories (every word must match, ignoring
case and accents, and name matches come first). Under it, category chips narrow the list
(a sound shows if it's in any chosen category), and a count sits beside the sort:
**Featured**, **A–Z**, **By category** or **Lightest first** (which shows each sound's
processing cost), remembered in the browser. Starred sounds list first under
**Favourites**; stars are kept in the browser and shared between its tabs, never put in the
link. Each row shows the sound's tint, name, description and star, and **In mix ✓** for the
sounds already playing.

Picking a sound adds it at the end of the mix, at volume 70, closes the picker and moves
focus to the new row; `Shift+Enter` (or Shift-click) adds it and keeps the picker open.
Picking a sound already in the mix moves focus to its row instead. In a full mix of eight
the other sounds can't be picked, and a note says why. In the picker, `↑` `↓` `PageUp`
`PageDown` `Home` `End` move through the list, `Enter` picks, `*` stars, and `Esc` clears
the search, then the chips, then closes the picker. An empty mix says so, and Play stays disabled until a sound is added.
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

### Phones and tablets

On a narrow screen (a phone held upright) the panel is a **bottom sheet**. Collapsed, it
shows a peek bar with Play/Pause, the mix's sounds, **Add sound** and an expand button.
Drag the handle up (or tap the bar) to expand it to about two thirds of the screen, with the
master volume at the top and **Copy link**, **Fullscreen** and **Hide** in the bar; drag it
down, flick it, or tap the backdrop to collapse it. The sound picker fills the expanded
sheet and stays above the on-screen keyboard. On a short screen (a phone on its side) the
panel is a full-height drawer on the right.

On touch screens every control is at least 44 px, sliders have large thumbs, and a vertical
swipe over a slider scrolls the panel: a slider moves only when dragged sideways or tapped.
The panel doesn't fade after touch input, and the keyboard hints are left out. With the
**Night** backdrop, the panel dims too.

### Background playback and media controls

The mix keeps playing with the screen locked or another app open. On phones and tablets the
sound plays through a hidden audio element, so the system treats it as media: it plays with
iPhone's silent switch on, and the lock screen and notification shade show the mix's sounds
with Play and Pause. Media keys and desktop media controls play and pause it too. If
another app takes the audio, the mix pauses and stays paused; after a phone call it resumes
by itself where the browser says the call has ended. While paused, nothing runs.

### Backdrop

Behind the panel, a few large, soft pools of colour drift slowly over a near-black
background. Each layer adds its sound's tint, weighted by how loud the mixer makes it
(volume, mute and solo), and colour changes ease in over two seconds; past five layers, the
closest tints share a pool. An empty or paused mix fades to a dim neutral grey. While the
mix plays, the glow breathes gently with the sound's level, so a throb or a swell shows.

The **Display** section at the bottom of the panel (collapsed at first) sets it up for this
device, and is remembered in the browser rather than the link:

- **Backdrop:** **Glow**, **Night** (very dim and warm, for a dark bedroom) or **Off** (a
  plain black background, and nothing drawn at all);
- **Brightness:** 0–100, 50 by default;
- **Respond to sound:** whether the glow breathes with the sound;
- **Keep screen on:** keeps the screen from sleeping while the mix plays, for watching the
  backdrop (shown only where the browser can do it);
- **Advanced → Audio output:** **Auto**, **Direct** or **Media element**. Auto plays
  through the hidden audio element on touch devices and straight to the speakers elsewhere.
  It's an escape hatch for a device where the automatic choice misbehaves, and a change
  applies once the page is reloaded.

The backdrop is meant to cost next to nothing: it draws a tiny image and scales it up, at
most 30 frames a second while it breathes or changes colour and 2 a second for the drift
alone, and not at all in a background tab. With reduced motion set in the system, it stands
still and doesn't respond to sound. Without WebGL2 it shows a still gradient of the same
colours.

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

| Key                 | Action                           |
| ------------------- | -------------------------------- |
| `Space`             | Play or pause                    |
| `/`                 | Add a sound (opens the picker)   |
| `S`                 | Star or unstar the focused layer |
| `1`–`8`             | Mute or unmute layer N           |
| `Shift+1`–`Shift+8` | Solo or unsolo layer N           |
| `M`                 | Mute or unmute everything        |
| `↑` / `↓`           | Master volume up or down by 5    |
| `H`                 | Hide or show the control panel   |
| `F`                 | Toggle fullscreen                |
| `D`                 | Backdrop: Glow, Night or Off     |
| `?`                 | Show the keyboard shortcuts      |

Shortcuts are ignored while a form field has focus (`Space` still works on a slider, but
on a focused button it presses the button). `↑` and `↓` change the master volume only when
no control has focus. On touch devices, tap the corner button
to bring a hidden panel back.
