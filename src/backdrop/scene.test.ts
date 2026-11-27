import { describe, expect, it } from "vitest";
import { MAX_POOLS, poolColours } from "./colours";
import {
  COLOUR_EASE_S,
  createEnvelope,
  createScene,
  cssBackdrop,
  displayColours,
  FPS_CAP,
  followLevel,
  frameInterval,
  IDLE_FPS,
  LEVEL_ATTACK_S,
  LEVEL_RELEASE_S,
  poolAt,
  POOL_FLOATS,
  RESPONSE_BRIGHTNESS,
} from "./scene";

const FRAME = 1 / FPS_CAP;
const red = poolColours([{ tint: "#ff0000", gain: 1 }]);
const blue = poolColours([{ tint: "#0000ff", gain: 1 }]);
const glow = { mode: "glow", brightness: 50 } as const;

/** Steps the envelope through `seconds` of a constant `input`, a frame at a time. */
function run(
  envelope: ReturnType<typeof createEnvelope>,
  input: number | undefined,
  seconds: number,
) {
  let moving = false;
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    moving = followLevel(envelope, input, FRAME);
  }
  return moving;
}

describe("frameInterval", () => {
  const base = { shown: true, reducedMotion: false, responding: false, easing: false };

  it("drifts at the idle rate when nothing else changes", () => {
    expect(frameInterval(base)).toBe(1000 / IDLE_FPS);
  });

  it.each([
    ["responding", { responding: true }],
    ["easing", { easing: true }],
  ])("runs at the frame cap while %s", (_, change) => {
    expect(frameInterval({ ...base, ...change })).toBe(1000 / FPS_CAP);
  });

  it.each([
    ["hidden or off", { shown: false, responding: true }],
    ["reduced motion", { reducedMotion: true, easing: true, responding: true }],
  ])("asks for no frames when %s", (_, change) => {
    expect(frameInterval({ ...base, ...change })).toBeNull();
  });
});

describe("followLevel", () => {
  it("starts at rest, from the first level it hears", () => {
    const envelope = createEnvelope();
    followLevel(envelope, 0.1, FRAME);
    expect(envelope.response).toBe(0);
    run(envelope, 0.1, 5);
    expect(envelope.response).toBeCloseTo(0, 6);
  });

  it("rises with the attack time and falls with the release time", () => {
    // One time constant takes it about 63 % of the way, however it is split into frames.
    const step = (from: number, to: number, tau: number) => {
      const envelope = createEnvelope();
      followLevel(envelope, from, FRAME);
      for (let i = 0; i < 10; i++) {
        followLevel(envelope, to, tau / 10);
      }
      return (envelope.level - from) / (to - from);
    };
    expect(step(0.1, 0.2, LEVEL_ATTACK_S)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(step(0.2, 0.1, LEVEL_RELEASE_S)).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it("swings positive on a swell and negative on a dip, within ±1", () => {
    const envelope = createEnvelope();
    run(envelope, 0.1, 5);
    run(envelope, 0.14, 0.3);
    expect(envelope.response).toBeGreaterThan(0.3);
    run(envelope, 10, 1);
    expect(envelope.response).toBe(1);
    const dip = createEnvelope();
    run(dip, 0.1, 5);
    run(dip, 0, 2);
    expect(dip.response).toBeLessThan(-0.5);
    expect(dip.response).toBeGreaterThanOrEqual(-1);
  });

  it("responds the same at any volume", () => {
    const quiet = createEnvelope();
    const loud = createEnvelope();
    for (const [input, seconds] of [
      [1, 3],
      [1.5, 0.4],
      [0.8, 0.5],
    ] as const) {
      run(quiet, input * 0.01, seconds);
      run(loud, input * 0.3, seconds);
    }
    expect(quiet.response).toBeCloseTo(loud.response, 6);
  });

  it("eases back to rest when turned off, then reports it has settled", () => {
    const envelope = createEnvelope();
    run(envelope, 0.1, 3);
    run(envelope, 0.2, 0.5);
    expect(followLevel(envelope, undefined, FRAME)).toBe(true);
    expect(run(envelope, undefined, 5)).toBe(false);
    expect(envelope.response).toBe(0);
  });

  it("rests in silence", () => {
    const envelope = createEnvelope();
    run(envelope, 0, 3);
    expect(envelope.response).toBe(0);
  });
});

describe("poolAt", () => {
  it("is a function of time alone", () => {
    expect(poolAt(2, 123.4)).toEqual(poolAt(2, 123.4));
    expect(poolAt(0, 10)).not.toEqual(poolAt(1, 10));
  });

  it.each(Array.from({ length: MAX_POOLS }, (_, i) => i))(
    "keeps pool %i on screen, large, and slow",
    (index) => {
      for (let t = 0; t < 600; t += 0.5) {
        const [x, y, radius] = poolAt(index, t);
        const [nx, ny] = poolAt(index, t + 1);
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(y)).toBeLessThanOrEqual(0.32);
        expect(radius).toBeGreaterThanOrEqual(0.24);
        // Moves less than 3 % of the screen's height in any second.
        expect(Math.hypot(nx - x, ny - y)).toBeLessThan(0.03);
      }
    },
  );
});

describe("displayColours", () => {
  it("scales with brightness, from black at 0", () => {
    const half = displayColours(red, glow);
    const full = displayColours(red, { mode: "glow", brightness: 100 });
    expect(full[0]).toBeCloseTo(half[0] * 2);
    expect(half[0]).toBeCloseTo(0.3);
    expect([...displayColours(red, { mode: "glow", brightness: 0 })].slice(0, -1)).toEqual(
      Array.from({ length: MAX_POOLS * 4 }, (_, i) => (i % 4 === 3 && i < 12 ? 1 : 0)),
    );
  });

  it("keeps Night under about 6 % and warm", () => {
    const white = poolColours([{ tint: "#ffffff", gain: 1 }]);
    const night = displayColours(white, { mode: "night", brightness: 100 });
    const [r = 0, g = 0, b = 0] = night;
    expect(night.at(-1)).toBeCloseTo(0.06);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(0.075);
  });
});

describe("createScene", () => {
  it("shows its first target at once, then eases a change over two seconds", () => {
    const scene = createScene();
    scene.setTarget(red, glow, false);
    expect(scene.frame(0, 0, undefined).colours[0]).toBeCloseTo(0.3);
    expect(scene.easing).toBe(false);
    scene.setTarget(blue, glow, false);
    const start = scene.frame(10, FRAME, undefined).colours[0];
    expect(start).toBeCloseTo(0.3);
    expect(scene.easing).toBe(true);
    const mid = scene.frame(10 + COLOUR_EASE_S / 2, FRAME, undefined);
    expect(mid.colours[0]).toBeCloseTo(0.15);
    expect(mid.colours[2]).toBeCloseTo(0.15);
    const end = scene.frame(10 + COLOUR_EASE_S, FRAME, undefined);
    expect(end.colours[0]).toBeCloseTo(0);
    expect(end.colours[2]).toBeCloseTo(0.3);
    expect(scene.easing).toBe(false);
  });

  it("eases from wherever an interrupted ease had got to", () => {
    const scene = createScene();
    scene.setTarget(red, glow, false);
    scene.frame(0, 0, undefined);
    scene.setTarget(blue, glow, false);
    scene.frame(1, FRAME, undefined);
    const mid = scene.frame(2, FRAME, undefined).colours[0];
    scene.setTarget(red, glow, false);
    expect(scene.frame(2.01, FRAME, undefined).colours[0]).toBeCloseTo(mid, 2);
  });

  it("ignores an unchanged target, and jumps when asked to", () => {
    const scene = createScene();
    scene.setTarget(red, glow, false);
    scene.frame(0, 0, undefined);
    expect(scene.setTarget(red, glow, false)).toBe(false);
    scene.frame(1, FRAME, undefined);
    expect(scene.easing).toBe(false);
    scene.setTarget(blue, glow, true);
    expect(scene.frame(2, FRAME, undefined).colours[2]).toBeCloseTo(0.3);
    expect(scene.easing).toBe(false);
  });

  it("breathes with the level: brighter and larger on a swell", () => {
    const scene = createScene();
    scene.setTarget(red, glow, false);
    let t = 0;
    for (; t < 4; t += FRAME) {
      scene.frame(t, FRAME, 0.1);
    }
    const rest = scene.frame(t, FRAME, 0.1);
    const restColour = rest.colours[0];
    const restRadius = rest.pools[2] / poolAt(0, t)[2];
    expect(restColour).toBeCloseTo(0.3, 2);
    expect(scene.responding).toBe(true);
    for (const end = t + 1; t < end; t += FRAME) {
      scene.frame(t, FRAME, 1);
    }
    const swell = scene.frame(t, FRAME, 1);
    expect(swell.colours[0]).toBeCloseTo(0.3 * (1 + RESPONSE_BRIGHTNESS), 4);
    expect(swell.pools[2] / poolAt(0, t)[2]).toBeGreaterThan(restRadius);
  });

  it("lays out each pool's position and radius", () => {
    const scene = createScene();
    scene.setTarget(red, glow, false);
    const { pools } = scene.frame(42, 0, undefined);
    for (let i = 0; i < MAX_POOLS; i++) {
      expect(Array.from(pools.slice(i * POOL_FLOATS, (i + 1) * POOL_FLOATS))).toEqual([
        ...poolAt(i, 42).map((v) => Math.fround(v)),
        i < 3 ? 1 : 0,
      ]);
    }
  });
});

describe("cssBackdrop", () => {
  it("draws each pool as a radial gradient over black", () => {
    const background = cssBackdrop(red, glow);
    expect(background.match(/radial-gradient/g)).toHaveLength(MAX_POOLS);
    expect(background).toContain("rgb(77 0 0 / 1.00)");
    expect(background.endsWith("#000")).toBe(true);
  });
});
