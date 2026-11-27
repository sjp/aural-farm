/**
 * The mixes file: a JSON backup of the saved mixes, since localStorage can be
 * cleared. Reading one back is strict: a file that isn't exactly this shape, or
 * holds a mix that doesn't parse, is refused whole, with a reason to show.
 *
 *   { "app": "aural-farm", "version": 1, "mixes": [{ "name", "hash", "savedAt" }] }
 */
import { sounds } from "../sounds/registry";
import { parseHash, sanitizeName, serialiseHash, withName } from "./mix";
import { MAX_HASH_LENGTH, MAX_SAVED_MIXES, sameName, type SavedMix } from "./mixes";

export const MIXES_FILE_NAME = "aural-farm-mixes.json";
/** A file larger than this, in characters, is refused before parsing. 100 full mixes need ~400 kB. */
export const MAX_FILE_LENGTH = 1_000_000;
/** The longest raw name read from a file, before it is sanitised and cut to length. */
const MAX_RAW_NAME_LENGTH = 200;
const APP = "aural-farm";
const VERSION = 1;

/** The sounds a mix can use: the registry, or a stand-in in tests. */
type Catalogue = Parameters<typeof parseHash>[1];

/** The file's text for `mixes`. */
export function mixesFile(mixes: readonly SavedMix[]): string {
  return `${JSON.stringify({ app: APP, version: VERSION, mixes }, null, 2)}\n`;
}

type FileResult = { ok: true; mixes: SavedMix[] } | { ok: false; error: string };

const fail = (error: string): FileResult => ({ ok: false, error });

/** Reads one entry; returns it with its hash rewritten in full, or why it was refused. */
function readEntry(value: unknown, position: number, catalogue: Catalogue): SavedMix | string {
  const where = `Mix ${String(position)}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where} isn't a mix.`;
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "hash,name,savedAt") {
    return `${where} should have exactly a name, a hash and a savedAt.`;
  }
  const name = "name" in value ? value.name : undefined;
  const hash = "hash" in value ? value.hash : undefined;
  const savedAt = "savedAt" in value ? value.savedAt : undefined;
  if (typeof name !== "string" || name.length > MAX_RAW_NAME_LENGTH) {
    return `${where} has no usable name.`;
  }
  const clean = sanitizeName(name);
  if (clean === "") {
    return `${where} has no usable name.`;
  }
  const named = `"${clean}"`;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) {
    return `${named} has no valid savedAt time.`;
  }
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length > MAX_HASH_LENGTH) {
    return `${named} has no valid mix hash.`;
  }
  if (!new URLSearchParams(hash.slice(1)).has("layers")) {
    return `${named} has no layers.`;
  }
  const { mix } = parseHash(hash, catalogue);
  if (mix.layers.length === 0) {
    return `${named} has no sounds this app knows.`;
  }
  const full = serialiseHash(
    { mix: withName(mix, clean), panelHidden: false },
    { full: true },
    catalogue,
  );
  return { name: clean, hash: full, savedAt };
}

/** Reads a mixes file's text strictly; see the module comment for the shape. */
export function readMixesFile(text: string, catalogue: Catalogue = sounds): FileResult {
  if (text.length > MAX_FILE_LENGTH) {
    return fail("That file is too large to be a mixes file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("That file isn't a mixes file.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("app" in parsed) ||
    parsed.app !== APP ||
    !("mixes" in parsed) ||
    !Array.isArray(parsed.mixes)
  ) {
    return fail("That file isn't a mixes file.");
  }
  const version = "version" in parsed ? parsed.version : undefined;
  if (typeof version === "number" && version > VERSION) {
    return fail("That mixes file is from a newer version of the app.");
  }
  if (version !== VERSION) {
    return fail("That file isn't a mixes file.");
  }
  const entries: unknown[] = parsed.mixes;
  if (entries.length > MAX_SAVED_MIXES) {
    return fail(`That file holds more than ${String(MAX_SAVED_MIXES)} mixes.`);
  }
  const mixes: SavedMix[] = [];
  for (const [index, value] of entries.entries()) {
    const entry = readEntry(value, index + 1, catalogue);
    if (typeof entry === "string") {
      return fail(entry);
    }
    if (mixes.some((m) => sameName(m.name, entry.name))) {
      return fail(`"${entry.name}" is in the file twice.`);
    }
    mixes.push(entry);
  }
  if (mixes.length === 0) {
    return fail("That file holds no mixes.");
  }
  return { ok: true, mixes };
}
