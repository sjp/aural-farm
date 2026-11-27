/**
 * Draws the app's icons as PNG files in `public/`, from the same artwork as
 * `public/favicon.svg`: soft concentric rings around a bright dot, on a near-black
 * tile. Each pixel is filled from the shapes' distance fields, so edges are
 * anti-aliased without a rasteriser or any dependency.
 *
 *   npm run icons
 *
 * The output is deterministic; commit the files it writes. Change the artwork here
 * and in `favicon.svg` together.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodePng } from "./png.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PUBLIC = join(ROOT, "public");

/** The favicon's view box is 32 units square. */
const VIEW = 32;
const CENTRE = VIEW / 2;
/** The tile's colour and its corner radius on a rounded tile. */
const TILE = { colour: "#07090f", radius: 7 };
/** The rings and dot, back to front, as in the favicon. */
const RINGS = [
  { radius: 12, width: 2, colour: "#5b8cff", opacity: 0.3 },
  { radius: 8, width: 2, colour: "#6fb4ff", opacity: 0.6 },
];
const DOT = { radius: 3.5, colour: "#9fd8ff" };

/**
 * The icons to write.
 * - `rounded`: a tile with rounded, transparent corners, as the favicon; otherwise the
 *   tile fills the square (the platform crops it).
 * - `scale`: the artwork's size within the tile. A maskable icon keeps it inside the
 *   safe zone, a centred circle 80 % of the icon across: the outer ring reaches 13 of
 *   the 16 units from the centre, so at 0.8 it ends at 65 % of the way to the edge.
 */
const ICONS = [
  { file: "icon-192.png", size: 192, rounded: true, scale: 1 },
  { file: "icon-512.png", size: 512, rounded: true, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, rounded: false, scale: 0.8 },
  // iOS rounds the corners itself and fills transparency with black.
  { file: "apple-touch-icon.png", size: 180, rounded: false, scale: 1 },
];

/** A `#rrggbb` colour as [r, g, b] in 0–1. @param {string} hex */
function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** How much of a pixel a shape covers, from its signed distance in pixels. @param {number} d */
function coverage(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

/** Signed distance from (x, y) to a rounded square of half-size h and corner radius r. */
function roundedSquare(
  /** @type {number} */ x,
  /** @type {number} */ y,
  /** @type {number} */ h,
  /** @type {number} */ r,
) {
  const qx = Math.abs(x) - h + r;
  const qy = Math.abs(y) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The icon's pixels, as straight (not premultiplied) RGBA.
 * @param {{ size: number, rounded: boolean, scale: number }} icon
 */
function draw({ size, rounded, scale }) {
  const unit = size / VIEW;
  const tile = rgb(TILE.colour);
  const ringColours = RINGS.map((ring) => rgb(ring.colour));
  const dot = rgb(DOT.colour);
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Pixel centre, in favicon units from the centre.
      const x = (px + 0.5) / unit - CENTRE;
      const y = (py + 0.5) / unit - CENTRE;
      const tileAlpha = rounded ? coverage(roundedSquare(x, y, CENTRE, TILE.radius) * unit) : 1;
      // Paint back to front, premultiplied.
      let [r, g, b] = tile.map((c) => c * tileAlpha);
      let a = tileAlpha;
      const over = (/** @type {number[]} */ colour, /** @type {number} */ alpha) => {
        r = colour[0] * alpha + r * (1 - alpha);
        g = colour[1] * alpha + g * (1 - alpha);
        b = colour[2] * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      };
      // The artwork, scaled about the centre; distances back in pixels.
      const distance = Math.hypot(x, y) / scale;
      const toPixels = unit * scale;
      RINGS.forEach((ring, k) => {
        const d = (Math.abs(distance - ring.radius) - ring.width / 2) * toPixels;
        over(ringColours[k], coverage(d) * ring.opacity * tileAlpha);
      });
      over(dot, coverage((distance - DOT.radius) * toPixels) * tileAlpha);
      const i = (py * size + px) * 4;
      const straight = a > 0 ? 1 / a : 0;
      rgba[i] = Math.round(r * straight * 255);
      rgba[i + 1] = Math.round(g * straight * 255);
      rgba[i + 2] = Math.round(b * straight * 255);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

for (const icon of ICONS) {
  const path = join(PUBLIC, icon.file);
  writeFileSync(path, encodePng(icon.size, icon.size, draw(icon)));
  process.stdout.write(`${icon.file} (${String(icon.size)} px)\n`);
}
