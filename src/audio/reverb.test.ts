import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, installFakeAudioGlobals, type FakeNode } from "../test/fake-audio";
import { dbToGain } from "./glide";
import {
  createSend,
  getReverb,
  REVERB_KINDS,
  reverbImpulse,
  reverbLength,
  routeReverb,
  type ReverbKind,
} from "./reverb";
import { withAudioScope } from "./scope";

const SR = 48000;

const energy = (x: Float32Array, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += (x[i] ?? 0) ** 2;
  }
  return sum;
};

/** Energy of the first difference: a rough measure of high-frequency content. */
const brightness = (x: Float32Array, from: number, to: number) => {
  let diff = 0;
  for (let i = from + 1; i < to; i++) {
    diff += ((x[i] ?? 0) - (x[i - 1] ?? 0)) ** 2;
  }
  return diff / energy(x, from, to);
};

describe("reverbImpulse", () => {
  it.each(REVERB_KINDS)("%s is finite, at most 3 s long, and unit energy per channel", (kind) => {
    for (const sr of [44100, 48000]) {
      const channels = reverbImpulse(kind, sr);
      expect(channels).toHaveLength(2);
      for (const data of channels) {
        expect(data.length).toBe(Math.round(reverbLength(kind) * sr));
        expect(data.length).toBeLessThanOrEqual(3 * sr);
        expect(data.every((v) => Number.isFinite(v))).toBe(true);
        expect(energy(data)).toBeCloseTo(1, 5);
      }
    }
  });

  it.each(REVERB_KINDS)("%s is deterministic and has decorrelated channels", (kind) => {
    const [left, right] = reverbImpulse(kind, SR);
    expect(reverbImpulse(kind, SR)[0]).toEqual(left);
    let cross = 0;
    for (let i = 0; i < left.length; i++) {
      cross += (left[i] ?? 0) * (right[i] ?? 0);
    }
    expect(Math.abs(cross)).toBeLessThan(kind === "metal" ? 0.5 : 0.2);
  });

  it.each(REVERB_KINDS)("%s decays, and gets darker as it does", (kind) => {
    const [left] = reverbImpulse(kind, SR);
    const tenth = Math.floor(left.length / 10);
    expect(energy(left, 9 * tenth)).toBeLessThan(energy(left, 0, 2 * tenth) / 100);
    const early = brightness(left, 0, 2 * tenth);
    const late = brightness(left, 5 * tenth, 7 * tenth);
    expect(late).toBeLessThan(early);
  });

  it("orders the kinds by length: room, metal, outdoor, hall", () => {
    const lengths = (["room", "metal", "outdoor", "hall"] as ReverbKind[]).map((k) =>
      reverbLength(k),
    );
    expect(lengths).toEqual(lengths.toSorted((x, y) => x - y));
    expect(reverbLength("room")).toBeLessThan(0.8);
    expect(reverbLength("hall")).toBeGreaterThan(2.8);
  });

  it("makes outdoor darker than room", () => {
    const [room] = reverbImpulse("room", SR);
    const [outdoor] = reverbImpulse("outdoor", SR);
    const window = Math.round(0.3 * SR);
    expect(brightness(outdoor, 0, window)).toBeLessThan(brightness(room, 0, window));
  });
});

describe("getReverb", () => {
  it("makes one unnormalised convolver per context and kind", () => {
    const ctx = new FakeAudioContext();
    const room = getReverb(ctx.asContext(), "room");
    expect(getReverb(ctx.asContext(), "room")).toBe(room);
    expect(getReverb(ctx.asContext(), "hall")).not.toBe(room);
    expect(getReverb(new FakeAudioContext().asContext(), "room")).not.toBe(room);
    expect(room.normalize).toBe(false);
    expect(room.buffer?.numberOfChannels).toBe(2);
    expect(room.buffer?.length).toBe(Math.round(reverbLength("room") * ctx.sampleRate));
  });
});

describe("createSend", () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    uninstall = installFakeAudioGlobals();
  });
  afterEach(() => {
    uninstall();
  });

  it("sends to the layer's reverb bus when the engine has routed one", () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const bus = ctx.createGain();
    const asked: ReverbKind[] = [];
    routeReverb(out as unknown as AudioNode, (kind) => {
      asked.push(kind);
      return bus as unknown as AudioNode;
    });
    const source = ctx.createGain();
    const send = withAudioScope((scope) =>
      createSend(
        ctx.asContext(),
        scope,
        source as unknown as AudioNode,
        out as unknown as AudioNode,
        "metal",
        -20,
      ),
    );
    expect(asked).toEqual(["metal"]);
    expect(send.gain.value).toBeCloseTo(dbToGain(-20), 12);
    expect(source.connections).toEqual([send]);
    expect((send as unknown as FakeNode).connections).toEqual([bus]);
  });

  it("gets its own convolver into the output without an engine, and releases it all", () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const source = ctx.createGain();
    let dispose: () => void = () => undefined;
    const send = withAudioScope((scope) => {
      dispose = () => {
        scope.dispose();
      };
      return createSend(
        ctx.asContext(),
        scope,
        source as unknown as AudioNode,
        out as unknown as AudioNode,
        "room",
        -12,
      );
    }) as unknown as FakeNode;
    const [convolver] = send.connections as FakeNode[];
    expect(convolver.kind).toBe("convolver");
    expect(convolver.connections).toEqual([out]);
    dispose();
    expect(send.connections).toEqual([]);
    expect(convolver.connections).toEqual([]);
  });
});
