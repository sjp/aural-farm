/**
 * Renders a sound or a mix to a 16-bit, 48 kHz stereo WAV file for listening,
 * through the browser render harness (`e2e/harness.html`): it starts the Vite
 * dev server, drives the harness in headless Chromium, and writes the file to
 * `renders/`, which git ignores.
 *
 *   npm run render -- engine-core                       renders/engine-core-1.wav
 *   npm run render -- engine-core --seed 2 --param pitch=40 --seconds 120
 *   npm run render -- "#layers=engine-core,brown-noise&brown-noise.volume=40"
 *   npm run render -- --all                             every sound at its defaults
 *
 * A sound renders as a layer at volume 100, without the master chain (add
 * `--master` to go through its high-pass and limiter). A mix hash, as the app's
 * address bar or Copy link shows it, renders the whole mix through the master
 * chain, as the app plays it.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";

/**
 * What the script asks the harness to render: a sound, or a mix hash.
 * @typedef {{ sound: { id: string, seconds: number, params?: Record<string, number | string | boolean>, seed?: number, master?: boolean } } | { mix: { mix: string, seconds: number } }} RenderJob
 */

/**
 * The part of the harness page's `window.harness` this script uses.
 * @typedef {object} Harness
 * @property {() => { id: string, seed: number }[]} listSounds
 * @property {(hash: string) => string[]} mixLayers
 * @property {(spec: RenderJob) => Promise<string>} pcm16
 */

/** @typedef {Window & { harness: Harness }} HarnessWindow */

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = join(ROOT, "renders");
const RATE = 48000;
const CHANNELS = 2;

const USAGE = `Usage: npm run render -- <sound id | mix hash> [--seconds 60] [--seed 1] [--param key=value …] [--master]
       npm run render -- --all [--seconds 60]`;

/** A `--param` value as the param would hold it: a number, a boolean or a select's option. @param {string} raw */
function paramValue(raw) {
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  const number = Number(raw);
  return raw.trim() !== "" && Number.isFinite(number) ? number : raw;
}

/** A RIFF WAV file around interleaved 16-bit PCM. @param {Buffer} pcm */
function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Lowercase letters, digits and dashes, for a file name. @param {string} text */
const slug = (text) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "60" },
    seed: { type: "string" },
    param: { type: "string", multiple: true, default: [] },
    master: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const seconds = Number(values.seconds);
const target = positionals.at(0);
if (values.help || (!values.all && target === undefined) || !(seconds > 0)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 1);
}
/** @type {Record<string, number | string | boolean>} */
const params = {};
for (const pair of values.param) {
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    process.stderr.write(`--param needs key=value, got "${pair}"\n${USAGE}\n`);
    process.exit(1);
  }
  params[pair.slice(0, eq)] = paramValue(pair.slice(eq + 1));
}
const seed = values.seed === undefined ? undefined : Number(values.seed);

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: 0, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls?.local[0];
const browser = await chromium.launch();
try {
  if (base === undefined) {
    throw new Error("The dev server didn't report a URL");
  }
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    process.stderr.write(`Page error: ${error.message}\n`);
  });
  await page.goto(new URL("e2e/harness.html", base).href);
  await page.waitForFunction(() => "harness" in window);
  const known = await page.evaluate(() =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    /** @type {HarnessWindow} */ (/** @type {unknown} */ (window)).harness.listSounds(),
  );

  /** @type {{ file: string, spec: RenderJob }[]} */
  const jobs = [];
  if (values.all) {
    for (const sound of known) {
      jobs.push({
        file: `${sound.id}-${String(sound.seed)}.wav`,
        spec: { sound: { id: sound.id, seconds, master: values.master } },
      });
    }
  } else if (target !== undefined && (target.startsWith("#") || target.includes("="))) {
    const hash = target.startsWith("#") ? target : `#${target}`;
    const layers = await page.evaluate(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (h) => /** @type {HarnessWindow} */ (/** @type {unknown} */ (window)).harness.mixLayers(h),
      hash,
    );
    if (layers.length === 0) {
      throw new Error(`The mix "${target}" has no sounds the app knows`);
    }
    jobs.push({
      file: `mix-${slug(layers.join("-"))}.wav`,
      spec: { mix: { mix: hash, seconds } },
    });
  } else if (target !== undefined) {
    const sound = known.find((s) => s.id === target);
    if (!sound) {
      throw new Error(`No sound "${target}". Sounds: ${known.map((s) => s.id).join(", ")}`);
    }
    jobs.push({
      file: `${sound.id}-${String(seed ?? sound.seed)}.wav`,
      spec: {
        sound: {
          id: sound.id,
          seconds,
          params,
          master: values.master,
          ...(seed === undefined ? {} : { seed }),
        },
      },
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const job of jobs) {
    const began = Date.now();
    const pcm = await page.evaluate(
      async (spec) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        /** @type {HarnessWindow} */ (/** @type {unknown} */ (window)).harness.pcm16(spec),
      job.spec,
    );
    const path = join(OUT_DIR, job.file);
    writeFileSync(path, wav(Buffer.from(pcm, "base64")));
    const took = ((Date.now() - began) / 1000).toFixed(1);
    process.stdout.write(`${path} (${String(seconds)} s, rendered in ${took} s)\n`);
  }
} finally {
  await browser.close();
  await server.close();
}
