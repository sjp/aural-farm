// oxlint-disable-next-line no-restricted-imports -- this module wraps act for every test
import { act as preactAct } from "@testing-library/preact";

/**
 * Preact's `act`, typed so that only an async callback returns a promise. Called
 * with a sync callback it flushes effects and renders synchronously, and returns
 * nothing to await; with an async callback the promise must be awaited, which
 * `no-floating-promises` enforces.
 */
export function act(callback: () => Promise<void>): Promise<void>;
export function act(callback: () => void): void;
export function act(callback: () => void | Promise<void>): Promise<void> | undefined {
  const result = preactAct(callback);
  return callback.constructor.name === "AsyncFunction" ? result : undefined;
}
