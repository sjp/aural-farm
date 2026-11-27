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

The control panel sits in the top-right corner and fades out, with the cursor, after a few
seconds without input. It lists the mix's layers. Each layer has:

- a **volume** slider;
- the sound's own settings (sliders, toggles and lists), grouped into sections you can
  collapse, each with a button to reset it to its default.

The header has **Copy link**, **Fullscreen** and **Hide**. The footer has **Reset all**,
which puts every layer's settings and volume back to their defaults while keeping the
layers.

The whole mix is kept in the URL hash, so a link reopens the same mix. Editing or pasting a
hash applies it without a reload. Hiding the panel adds `panel=hidden`, and a page opened
with it starts with the panel and cursor hidden.

**Copy link** copies a link that spells out every setting, defaults included, plus
`panel=hidden`, so the mix sounds the same even if a default changes later.

### Keyboard shortcuts

| Key | Action                         |
| --- | ------------------------------ |
| `H` | Hide or show the control panel |
| `F` | Toggle fullscreen              |
| `?` | Show the keyboard shortcuts    |

Shortcuts are ignored while a form field has focus. On touch devices, tap the corner button
to bring a hidden panel back.
