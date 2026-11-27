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
npm run preview       # serve dist/, with the service worker, as the site would be
npm run check         # linting, formatting and unused exports
npm test              # vitest
npm run test:browser  # Playwright, in headless Chromium, including the sound checks
npm run render -- engine-core  # render a sound to a WAV file (see below)
npm run icons         # redraw the app icons in public/ (commit the PNGs it writes)
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
press anywhere starts it. Playback carries on in a background tab. Play fades the sound in
(over 3 s unless set otherwise, see below), so a mix never bursts in at full volume. Pausing
fades it out and then suspends the audio, so nothing runs while paused.

The control panel sits in the top-right corner and fades out, with the cursor, after a few
seconds without input. It is a mixer for up to eight sounds, played at once.

The header has **Play/Pause**, the **sleep timer**, the mix's name (or "Aural Farm"),
**Mixes**, **Copy link**, **Fullscreen** and **Hide**, and under them the
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

### Mixes and presets

**Mixes** in the header (or `P`) opens the Mixes view in place of the mixer, with two lists:

- **Presets:** built-in mixes that show what the app can do, such as **Engine Hum**,
  **Seaside**, **Stormy Night**, **Deep Brown**, **Soft Pink** and **Masking Blend**. More
  arrive as more sounds are added.
- **My mixes:** the mixes you've saved, newest first, each with **Rename** and **Delete**
  (which offers **Undo** for a few seconds).

Each row shows the mix's name, a line about it and the tints of its sounds, and the mix that
is playing is marked. Picking a row crossfades to that mix: sounds in both mixes glide to
their new settings, and the others fade in or out. If the mix it replaces isn't saved
anywhere, a toast offers **Undo**. Solo is cleared; muting everything is left as it is.

**Save mix…** asks for a name (up to 40 characters, emoji welcome), offering the mix's name
or its sounds. Saving under a name already used asks before replacing that mix, and up to
100 mixes can be saved. A named mix shows its name in the header, the peek bar, the page's
title and on the lock screen. The name is part of the link (`name=`), and changing the mix
afterwards keeps it, marked **(edited)**.

Saved mixes are kept in this browser only, shared between its tabs and never sent anywhere;
share one with **Copy link**. Since browser storage can be cleared, **Export my mixes**
downloads them as `aural-farm-mixes.json`, and **Import…** reads such a file back, adding
its mixes and asking before replacing any of yours with the same name.

### Sleep timer

The clock button next to Play opens the sleep timer, for falling asleep to a mix: choose
**Off**, **15 min**, **30 min**, **45 min**, **1 h**, **1 h 30**, **2 h** or **Custom** (1–480
minutes). While a timer runs, the button shows the time left, to the minute and then to the
second in the last minute. Over the last part of the timer, set by **Fade out over** (10 s,
1 min, 5 min or 15 min, never longer than the timer), the mix fades out evenly; then it
pauses, and the timer goes back to Off.

The timer counts playing time: pausing pauses it, and playing again carries on. Changing
the mix leaves it running, choosing a new length starts it again, and turning it Off during
the fade brings the sound back over 2 seconds. Stop on the lock screen turns it off too. The
fade runs on the audio clock, so it stays smooth in a background tab or on a locked phone.

The same menu sets **Fade in on Play**: **Instant**, **3 s** (the default), **10 s** or
**30 s**. The last timer length, the fade-out and the fade-in are remembered in the browser,
and the menu offers the last length first, but a timer always starts Off when the page
opens, and it is never part of a link.

### Phones and tablets

On a narrow screen (a phone held upright) the panel is a **bottom sheet**. Collapsed, it
shows a peek bar with Play/Pause, the sleep timer, the mix's name or sounds (and the time left on a
running timer), **Add sound** and an expand button.
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

### Installing it and using it offline

Aural Farm installs as an app, on a phone's home screen or a computer's desktop, and then
opens in its own window. Where the browser offers to install it (Chrome, Edge, Android),
**Install app** in the Display section does it; elsewhere use the browser's own menu: on
an iPhone or iPad, Safari's Share → **Add to Home Screen**.

Every sound is synthesised in the browser, so once the site has been opened the whole app
works with no connection, installed or not: a service worker keeps every file of the
site, every sound included, after the first visit. Pages still come from the network
first when there is one (waiting up to 3 s), so a new version is seen straight away.

A new version downloads in the background, and a message then says **A new version is
ready**, with **Reload**. Nothing changes until you press it. Reloading keeps the mix,
which is in the address, but stops the sound for a moment, so the message waits for you
rather than reloading by itself.

The service worker is part of the build only: `npm run dev` has none. To try it locally,
`npm run build` and then `npm run preview`.

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
- **Install app:** installs Aural Farm (see below; shown only where the browser offers to);
- **Advanced → Audio output:** **Auto**, **Direct** or **Media element**. Auto plays
  through the hidden audio element on touch devices and straight to the speakers elsewhere.
  It's an escape hatch for a device where the automatic choice misbehaves, and a change
  applies once the page is reloaded.

The backdrop is meant to cost next to nothing: it draws a tiny image and scales it up, at
most 30 frames a second while it breathes or changes colour and 2 a second for the drift
alone, and not at all in a background tab. With reduced motion set in the system, it stands
still and doesn't respond to sound. Without WebGL2 it shows a still gradient of the same
colours.

### Exporting audio

The **Export** section under Display (collapsed at first) saves the mix as an audio file,
for a video edit, an offline player, or a media player or game engine that repeats it:

- **Type:** **Clip** (1, 5, 10, 15, 30, 45 or 60 min, 10 by default) or **Seamless loop**
  (30 s, 1, 2, 5 or 10 min, 2 by default). A loop's end runs into its start without a
  seam: the few seconds after the loop point are crossfaded into its first seconds. When
  the mix has a steady rhythm, such as Engine Core's throb, the loop's length is rounded to
  a whole number of beats so the rhythm carries on across the loop point.
- **Format:** **WAV** (16-bit, 48 kHz stereo) or **Compressed**: Opus in WebM at 128 kb/s,
  or AAC in M4A at 160 kb/s, whichever the browser can encode. Where it can encode neither,
  Compressed is disabled.
- The file's size, shown as you choose. A WAV over 500 MB (45 and 60 min) gets a warning
  that suggests Compressed, and on phones and tablets a WAV can be at most 15 min long.

**Export** then shows a progress bar, with the time left and **Cancel**. The file is made
from the mix as it was when the export started (each layer's volume, mute and settings,
with the master volume at 100 and solo ignored), through the same high-pass and limiter as
playback, and with the same sound for the same Variation. Playback carries on meanwhile,
and changing the mix doesn't affect an export already running. Rendering runs much faster
than real time, in pieces of 30 seconds, so memory stays small whatever the length.

The file is named after the mix (or its sounds) and its length, such as
`aural-farm-night-drive-10min.wav` or `aural-farm-engine-core-2min-loop.webm`. A WAV is
written straight to a file you pick, where the browser can do that (Chrome and Edge on
desktop); otherwise, and for compressed files, it downloads when it's done. The choices are
remembered in the browser.

### Sounds

A fresh visit opens with **Starship Engine Core**: the deep, steady hum of a large engine
in a metal room, with a slow, breathing throb. Its settings are **Power** (how hard the
engine runs: darker and softer to brighter and richer), **Pitch** (the drone's fundamental,
32–72 Hz; everything in the sound follows it), **Pulse rate** and **Pulse depth** (how often
and how strongly the throb swells; depth 0 is a steady hum), **Room** (metallic resonances
and reverb), **Hiss** (faint ventilation air on top) and **Variation**, which crossfades to
different slow drifts and room detail while the hum plays on.

**Rain** is steady rain heard from under cover: an even hiss with single nearer drops on
top, some of them ringing with the small rising "plip" of a bubble. **Intensity** goes from a
sparse drizzle to a downpour, **Surface** sets what the rain lands on (open ground with
puddles, leaves, a roof, a window or a tent; a change crossfades, with the same drops landing
on the new surface), **Distance** moves it from a close, detailed patter to a soft, far wash,
**Plinks** sets how many drops ring, and **Variation** crossfades to a different pattern of
drops and swells.

**Ocean Waves** are waves breaking on a shore, heard from a little way up the beach: each
one swells with a low rumble, breaks into a bright crash, spreads into hissing foam and
drains back, and no two are quite the same, with now and then a set of bigger ones.
**Wave period** sets the average time between waves (6–14 s; they arrive irregularly
around it), **Wave size** goes from gentle lapping to big surf, **Distance** moves you from
the water's edge to far up the beach, **Shore** sets what the backwash drains over (sand,
or pebbles that rattle softly), and **Variation** crossfades to a different run of waves.

**Stream** is running water over stones, heard from the bank: the liquid chatter of countless
small bubbles, each ringing briefly with a rising pitch, in little bursts where the water
tumbles over a stone, each from its own place along the stream, over a soft rush of the
flow. **Flow** goes from a gentle trickle to fast-running water, which also surges and eases
on its own, **Size** from a small brook (small, high bubbles over a faint rush) to a broad
river (larger, lower bubbles almost lost in a deep, full rush), **Distance** moves you from
the bank to further away, where the babble fades into the rush, and **Variation** crossfades
to a different pattern of bubbles and surges.

**Fireplace** is a wood fire in an open hearth, heard from an armchair across the room: the
soft, flickering breath of the flames under little clusters of dry crackles, the odd
louder pop, now and then a few seconds of sap hissing out of a log, and rarely a log
settling with a soft thump. **Fire** goes from glowing embers to a roaring blaze, **Crackle**
sets how busy the crackles and pops are, **Wood** picks hardwood (steady, few pops) or
softwood (more pops and sap), **Room** moves you from close to the hearth to across a large
room, and **Variation** crossfades to a different pattern of crackles and flicker.

**Wind** is moving air: a broad rush that grows louder and brighter as it picks up, with
irregular gusts that surge and die away between lulls, and now and then a soft, hollow
whistle that rises a little with each gust. **Strength** goes from a light breeze to a gale,
**Gusts** from steady to strongly gusting, **Setting** picks what it blows past (an open
field; trees, with a flutter of leaves; or a house, heard muffled from inside, with moans at
the gaps; a change crossfades, with the gusts carrying on through it), **Whistle** sets how
much it whistles, and **Variation** crossfades to a different run of gusts.

**Distant Thunder** is a storm some miles away: mostly quiet, then now and again a long, low
rumble that swells in over a second or two, rolls through a few overlapping peaks and dies
away over many seconds, felt as much as heard. Nothing about it is sudden. The first rumble
rolls in a couple of seconds after the audio starts (the first Play); after that they come
at random. **How often** sets the mean gap between rumbles (Rarely, about 8 minutes;
Sometimes, 3; Often, a little over 1; Storm, 30 seconds), **Distance** goes from far and low
to nearer, brighter and quicker, with a muffled crack at the start of each rumble from 60
up, **Roll** from short grumbles to long rolling rumbles, and **Variation** picks a different
run of rumbles. A change applies from the next rumble, never to one already sounding.

The noise colours (**Brown**, **Pink**, **White** and **Grey Noise**) are the plain, steady
noises used for sleep, focus and masking. Each has **Tone** (darker to brighter), **Width**
(mono to wide stereo, at a steady level), **Movement** (slow, subtle swells; 0 is perfectly
steady) and **Variation**, which crossfades to a different take on the same noise.

### Keyboard shortcuts

| Key                 | Action                                 |
| ------------------- | -------------------------------------- |
| `Space`             | Play or pause                          |
| `/`                 | Add a sound (opens the picker)         |
| `P`                 | Presets and saved mixes                |
| `S`                 | Star or unstar the focused layer       |
| `1`–`8`             | Mute or unmute layer N                 |
| `Shift+1`–`Shift+8` | Solo or unsolo layer N                 |
| `M`                 | Mute or unmute everything              |
| `↑` / `↓`           | Master volume up or down by 5          |
| `H`                 | Hide or show the control panel         |
| `F`                 | Toggle fullscreen                      |
| `D`                 | Backdrop: Glow, Night or Off           |
| `T`                 | Sleep timer: Off, 15, 30, 60 or 90 min |
| `?`                 | Show the keyboard shortcuts            |

Shortcuts are ignored while a form field has focus (`Space` still works on a slider, but
on a focused button it presses the button). `↑` and `↓` change the master volume only when
no control has focus. On touch devices, tap the corner button
to bring a hidden panel back.
