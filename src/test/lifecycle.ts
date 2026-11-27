/**
 * The lifecycle checks every sound runs through, against the fake audio context.
 * Sounds are split into `SHARDS` test files by a hash of their id, so the suite
 * runs in parallel and adding a sound doesn't reshuffle the others.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../sounds/params";
import { sounds, type SoundEntry } from "../sounds/registry";
import type { ParamValues, SoundDefinition } from "../sounds/types";
import {
  FakeAudioContext,
  FakeParam,
  installFakeAudioGlobals,
  isSource,
  type FakeNode,
} from "./fake-audio";
import { paramSets } from "./param-sets";

const SHARDS = 8;

/** FNV-1a, 32-bit. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Globals a sound must never touch: it may run in an offline context, a worklet or a background tab. */
const FORBIDDEN = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
] as const;

/**
 * Runs `fn` with the forbidden globals replaced by getters that record the access
 * and throw. Returns the result and the names touched.
 */
async function guarded<T>(fn: () => T | Promise<T>): Promise<{ result: T; touched: string[] }> {
  const touched: string[] = [];
  const saved = FORBIDDEN.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const name of FORBIDDEN) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error(`A sound touched ${name}`);
      },
    });
  }
  try {
    return { result: await fn(), touched };
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  }
}

function seedOf(params: ParamValues): number {
  return typeof params.seed === "number" ? params.seed : 0;
}

/** Builds `definition` in a fresh fake context, with every forbidden global guarded. */
async function build(definition: SoundDefinition, params = defaults(definition.params)) {
  const ctx = new FakeAudioContext();
  const out = ctx.createGain();
  const first = ctx.nodes.length;
  const { result: instance, touched } = await guarded(() =>
    definition.create(ctx.asContext(), out as unknown as AudioNode, {
      params,
      seed: seedOf(params),
      startAt: ctx.currentTime,
    }),
  );
  return { ctx, out, instance, touched, nodes: () => ctx.nodes.slice(first) };
}

/** Where `node` connects that isn't one of `own` (or a param of one) or `out`. */
function strayConnections(node: FakeNode, own: readonly FakeNode[], out: FakeNode): FakeNode[] {
  return node.connections
    .map((target) => (target instanceof FakeParam ? target.owner : target))
    .filter((target) => target !== out && !own.includes(target));
}

/** Nodes that are still connected, or sources started and never stopped. */
function leftovers(nodes: readonly FakeNode[]): string[] {
  const problems: string[] = [];
  for (const node of nodes) {
    if (node.connections.length > 0) {
      problems.push(`${node.kind} still connected`);
    }
    if (isSource(node) && node.startedAt !== undefined && node.stoppedAt === undefined) {
      problems.push(`${node.kind} never stopped`);
    }
  }
  return problems;
}

/**
 * Builds `definition` with its `failAt`-th node creation throwing, expects the build
 * to fail, and returns the context to inspect.
 */
async function buildFailing(definition: SoundDefinition, failAt: number) {
  const ctx = new FakeAudioContext();
  const out = ctx.createGain();
  // The output was node 1.
  ctx.failAt = failAt + 1;
  const params = defaults(definition.params);
  const attempt = async () =>
    definition.create(ctx.asContext(), out as unknown as AudioNode, {
      params,
      seed: seedOf(params),
      startAt: 0,
    });
  await expect(attempt(), `failing node ${String(failAt)}`).rejects.toThrow("Injected failure");
  return ctx;
}

function assignmentCount(nodes: readonly FakeNode[]): number {
  return nodes.flatMap((n) => n.params()).reduce((sum, p) => sum + p.assignments.length, 0);
}

function lifecycleTests(entry: SoundEntry): void {
  let definition: SoundDefinition;
  let uninstall: () => void = () => undefined;
  beforeEach(async () => {
    uninstall = installFakeAudioGlobals();
    definition = await entry.load();
  });
  afterEach(() => {
    uninstall();
  });

  it("connects only into its output, never to the destination", async () => {
    const { ctx, out, nodes } = await build(definition);
    const own = nodes();
    expect(own.flatMap((n) => strayConnections(n, own, out)).map((n) => n.kind)).toEqual([]);
    expect(own.some((n) => n.connections.includes(out))).toBe(true);
    expect(ctx.nodes.some((n) => n.connections.includes(ctx.destination))).toBe(false);
  });

  it.each(paramSets(entry.params))(
    "builds and updates with $name, gliding rather than setting values",
    async ({ params }) => {
      const built = await build(definition, params);
      built.instance.dispose();

      const { ctx, instance, nodes } = await build(definition);
      ctx.advance(1);
      const running = nodes();
      const before = assignmentCount(running);
      const { touched } = await guarded(() => {
        instance.update(params, ctx.currentTime);
      });
      ctx.advance(5);
      expect(touched).toEqual([]);
      expect(assignmentCount(running)).toBe(before);
      for (const param of running.flatMap((n) => n.params())) {
        expect(Number.isFinite(param.value), `${param.owner.kind}.${param.name}`).toBe(true);
      }
    },
  );

  it("stops and disconnects everything on dispose, and a second dispose is harmless", async () => {
    const { ctx, instance, nodes } = await build(definition);
    ctx.advance(1);
    const { touched } = await guarded(() => {
      instance.dispose();
      instance.dispose();
    });
    expect(touched).toEqual([]);
    expect(leftovers(nodes())).toEqual([]);
  });

  it("releases what it built when a node creation fails part-way", async () => {
    const { nodes } = await build(definition);
    const count = nodes().length;
    expect(count).toBeGreaterThan(0);
    for (const failAt of Array.from({ length: count }, (_, i) => i + 1)) {
      const ctx = await buildFailing(definition, failAt);
      expect(leftovers(ctx.nodes), `failing node ${String(failAt)}`).toEqual([]);
    }
  });

  it("never touches window, document or timers", async () => {
    const { ctx, instance, touched } = await build(definition);
    const later = await guarded(() => {
      instance.update(defaults(definition.params), ctx.currentTime);
      instance.dispose();
    });
    expect([...touched, ...later.touched]).toEqual([]);
  });
}

/** The shard (0 to `SHARDS` − 1) whose test file checks the sound `id`. */
function shardOf(id: string): number {
  return fnv1a(id) % SHARDS;
}

/** Registers the lifecycle tests for the sounds in shard `shard`. */
export function describeLifecycle(shard: number): void {
  // Every shard file holds this test, so a shard with no sounds yet still runs one.
  it("is one of the shards", () => {
    expect(shard).toBe(Math.trunc(shard));
    expect(shard >= 0 && shard < SHARDS).toBe(true);
  });
  const mine = sounds.filter((s) => shardOf(s.id) === shard);
  describe.each(mine.map((s) => [s.id, s] as const))("%s", (_, entry) => {
    lifecycleTests(entry);
  });
}
