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
npm run test:browser  # Playwright, in headless Chromium
```

`npm run test:browser` needs Chromium once: `npx playwright install chromium`.

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
