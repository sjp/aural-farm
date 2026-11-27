/**
 * A recording stand-in for the Web Audio API, for unit tests in Node. Nodes record
 * their connections and whether they were started and stopped; params record their
 * automation calls and every direct `.value` assignment, and can be evaluated at any
 * time. The context's clock moves only when a test calls `advance`.
 *
 * Sounds may use the context's factory methods (`ctx.createGain()`) or the node
 * constructors (`new GainNode(ctx, options)`); `installFakeAudioGlobals` provides the
 * constructors.
 */

type Automation =
  | { type: "set"; time: number; value: number }
  | { type: "linear"; time: number; value: number }
  | { type: "exponential"; time: number; value: number }
  | { type: "target"; time: number; value: number; tau: number }
  | { type: "curve"; time: number; values: readonly number[]; duration: number };

/** One automation call, as made. */
interface ParamCall {
  method: string;
  args: unknown[];
}

export class FakeParam {
  readonly calls: ParamCall[] = [];
  /** Every direct `.value =` assignment, in order. */
  readonly assignments: number[] = [];
  readonly defaultValue: number;
  readonly minValue = -3.4028234663852886e38;
  readonly maxValue = 3.4028234663852886e38;
  automationRate: AutomationRate = "a-rate";
  readonly owner: FakeNode;
  readonly name: string;
  private intrinsic: number;
  private events: Automation[] = [];

  constructor(owner: FakeNode, name: string, initial: number) {
    this.owner = owner;
    this.name = name;
    this.defaultValue = initial;
    this.intrinsic = initial;
  }

  /** Sets the starting value without recording it, as a constructor option does. */
  init(value: number): void {
    this.intrinsic = value;
  }

  get value(): number {
    return this.valueAt(this.owner.context.currentTime);
  }

  set value(value: number) {
    this.assignments.push(value);
    if (this.events.length === 0) {
      this.intrinsic = value;
    } else {
      this.insert({ type: "set", time: this.owner.context.currentTime, value });
    }
  }

  setValueAtTime(value: number, time: number): this {
    this.record("setValueAtTime", [value, time]);
    this.insert({ type: "set", time, value });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.record("linearRampToValueAtTime", [value, time]);
    this.insert({ type: "linear", time, value });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.record("exponentialRampToValueAtTime", [value, time]);
    if (value === 0) {
      throw new RangeError("exponentialRampToValueAtTime needs a non-zero value");
    }
    this.insert({ type: "exponential", time, value });
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    this.record("setTargetAtTime", [value, time, tau]);
    this.insert({ type: "target", time, value, tau });
    return this;
  }

  setValueCurveAtTime(values: Iterable<number>, time: number, duration: number): this {
    const copy = Array.from(values);
    this.record("setValueCurveAtTime", [copy, time, duration]);
    this.insert({ type: "curve", time, values: copy, duration });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.record("cancelScheduledValues", [time]);
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    this.record("cancelAndHoldAtTime", [time]);
    const held = this.valueAt(time);
    this.events = this.events.filter((e) => e.time < time);
    this.insert({ type: "set", time, value: held });
    return this;
  }

  /** The param's value at context time `t`, from its automation. */
  valueAt(t: number): number {
    // `at` gives the value of the current segment at any time from `from` on.
    let at = (_x: number) => this.intrinsic;
    let from = 0;
    for (const e of this.events) {
      if (e.type === "linear" || e.type === "exponential") {
        const v0 = at(from);
        const t0 = from;
        if (t < e.time) {
          if (t <= t0) {
            return v0;
          }
          const k = (t - t0) / (e.time - t0);
          return e.type === "linear" ? v0 + (e.value - v0) * k : v0 * (e.value / v0) ** k;
        }
        const end = e.value;
        at = () => end;
        from = e.time;
        continue;
      }
      if (e.time > t) {
        return at(t);
      }
      if (e.type === "set") {
        const v = e.value;
        at = () => v;
      } else if (e.type === "target") {
        const v0 = at(e.time);
        const { value: target, tau, time } = e;
        at = (x) => target + (v0 - target) * Math.exp(-(x - time) / tau);
      } else {
        const { values, duration, time } = e;
        const last = values.at(-1) ?? 0;
        if (t < time + duration) {
          const pos = ((t - time) / duration) * (values.length - 1);
          const i = Math.floor(pos);
          const a = values[i] ?? last;
          const b = values[i + 1] ?? last;
          return a + (b - a) * (pos - i);
        }
        at = () => last;
        from = time + duration;
        continue;
      }
      from = e.time;
    }
    return at(t);
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    this.owner.context.checkOpen();
  }

  private insert(event: Automation): void {
    const index = this.events.findIndex((e) => e.time > event.time);
    if (index === -1) {
      this.events.push(event);
    } else {
      this.events.splice(index, 0, event);
    }
  }
}

type Listener = (event: Event) => void;

/** A minimal event target, enough for `statechange`, `ended` and `processorerror`. */
class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** How many listeners `type` has. */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of Array.from(this.listeners.get(event.type) ?? [])) {
      listener(event);
    }
    return true;
  }
}

/** Where a connection goes: a node, or one of a node's params. */
type Target = FakeNode | FakeParam;

export class FakeNode extends FakeEventTarget {
  /** Outgoing connections that are still in place. */
  connections: Target[] = [];
  channelCount = 2;
  channelCountMode: ChannelCountMode = "max";
  channelInterpretation: ChannelInterpretation = "speakers";
  readonly context: FakeAudioContext;
  /** What kind of node this is: "gain", "oscillator", "worklet", … */
  readonly kind: string;
  readonly numberOfInputs: number;
  readonly numberOfOutputs: number;

  constructor(context: FakeAudioContext, kind: string, inputs = 1, outputs = 1) {
    super();
    this.context = context;
    this.kind = kind;
    this.numberOfInputs = inputs;
    this.numberOfOutputs = outputs;
  }

  /** This node's params, by name. */
  params(): FakeParam[] {
    return Object.values(this).filter((v): v is FakeParam => v instanceof FakeParam);
  }

  /** Connects to a node (returning it, for chaining) or to a param. */
  connect(target: Target): FakeNode | undefined {
    const owner = target instanceof FakeParam ? target.owner : target;
    if (owner.context !== this.context) {
      throw new Error("Can't connect nodes from different contexts");
    }
    this.connections.push(target);
    return target instanceof FakeNode ? target : undefined;
  }

  disconnect(target?: Target): void {
    if (target === undefined) {
      this.connections = [];
      return;
    }
    if (!this.connections.includes(target)) {
      throw new Error("InvalidAccessError: not connected to that destination");
    }
    this.connections = this.connections.filter((c) => c !== target);
  }

  /** Applies constructor options: params take their starting value, other fields are set. */
  applyOptions(options: object | undefined): this {
    for (const [key, value] of Object.entries(options ?? {})) {
      const field: unknown = Reflect.get(this, key);
      if (field instanceof FakeParam) {
        field.init(Number(value));
      } else {
        Reflect.set(this, key, value);
      }
    }
    return this;
  }
}

class FakeSourceNode extends FakeNode {
  startedAt: number | undefined;
  stoppedAt: number | undefined;
  onended: Listener | null = null;

  start(when = 0): void {
    if (this.startedAt !== undefined) {
      throw new Error("InvalidStateError: start called twice");
    }
    this.startedAt = when;
  }

  stop(when = 0): void {
    if (this.startedAt === undefined) {
      throw new Error("InvalidStateError: stop called before start");
    }
    this.stoppedAt = when;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(this, "gain", 1);
}

class FakeOscillator extends FakeSourceNode {
  readonly frequency = new FakeParam(this, "frequency", 440);
  readonly detune = new FakeParam(this, "detune", 0);
  type: OscillatorType = "sine";
  periodicWave: unknown;
  setPeriodicWave(wave: unknown): void {
    this.periodicWave = wave;
    this.type = "custom";
  }
}

class FakeBiquad extends FakeNode {
  readonly frequency = new FakeParam(this, "frequency", 350);
  readonly detune = new FakeParam(this, "detune", 0);
  readonly Q = new FakeParam(this, "Q", 1);
  readonly gain = new FakeParam(this, "gain", 0);
  type: BiquadFilterType = "lowpass";
}

class FakeConstantSource extends FakeSourceNode {
  readonly offset = new FakeParam(this, "offset", 1);
}

class FakeBufferSource extends FakeSourceNode {
  readonly playbackRate = new FakeParam(this, "playbackRate", 1);
  readonly detune = new FakeParam(this, "detune", 0);
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
}

class FakeConvolver extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
}

class FakeStereoPanner extends FakeNode {
  readonly pan = new FakeParam(this, "pan", 0);
}

class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam(this, "delayTime", 0);
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(this, "threshold", -24);
  readonly knee = new FakeParam(this, "knee", 30);
  readonly ratio = new FakeParam(this, "ratio", 12);
  readonly attack = new FakeParam(this, "attack", 0.003);
  readonly release = new FakeParam(this, "release", 0.25);
  readonly reduction = 0;
}

class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = "none";
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /** What `getFloatTimeDomainData` reports; tests set it to simulate a signal. */
  signal = 0;

  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.signal);
  }
}

class FakeMediaStreamDestination extends FakeNode {
  /** Stands in for the `MediaStream` a media element plays. */
  readonly stream = { id: "fake-stream" };
}

class FakeWorkletNode extends FakeNode {
  readonly parameters = new Map<string, FakeParam>();
  readonly port = {
    messages: [] as unknown[],
    onmessage: null as Listener | null,
    postMessage(message: unknown) {
      this.messages.push(message);
    },
    start: () => undefined,
    close: () => undefined,
  };
  onprocessorerror: Listener | null = null;
  /** The registered processor name it was made with. */
  readonly processor: string;

  constructor(
    context: FakeAudioContext,
    processor: string,
    options: AudioWorkletNodeOptions | undefined,
  ) {
    super(context, "worklet", options?.numberOfInputs ?? 1, options?.numberOfOutputs ?? 1);
    this.processor = processor;
    for (const [name, value] of Object.entries(options?.parameterData ?? {})) {
      const param = new FakeParam(this, name, 0);
      param.init(value);
      this.parameters.set(name, param);
    }
  }

  /** Simulates the processor throwing. */
  crash(message = "processor crashed"): void {
    this.dispatchEvent(Object.assign(new Event("processorerror"), { message }));
  }

  override params(): FakeParam[] {
    return [...this.parameters.values()];
  }
}

class FakeAudioBuffer {
  readonly duration: number;
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels.at(channel);
    if (data === undefined || channel < 0) {
      throw new RangeError(`No channel ${String(channel)}`);
    }
    return data;
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0): void {
    this.getChannelData(channel).set(source, offset);
  }

  copyFromChannel(target: Float32Array, channel: number, offset = 0): void {
    target.set(this.getChannelData(channel).subarray(offset, offset + target.length));
  }
}

interface FakeContextOptions {
  sampleRate?: number;
  /** Whether the browser lets the context start without a user gesture. */
  allowed?: boolean;
}

export class FakeAudioContext extends FakeEventTarget {
  readonly sampleRate: number;
  readonly destination: FakeNode;
  readonly baseLatency = 0.02;
  state: AudioContextState;
  /** Whether `resume()` may start the context; set it to simulate a user gesture. */
  allowed: boolean;
  /** Every node made in this context, in order of creation. */
  readonly nodes: FakeNode[] = [];
  /** When set, the node creation with this 1-based number throws. */
  failAt: number | undefined;
  /** How many nodes have been made, including any that failed. */
  created = 0;
  readonly audioWorklet = {
    modules: [] as string[],
    /** URLs whose `addModule` rejects. */
    failing: new Set<string>(),
    addModule: (url: string | URL): Promise<void> => {
      const href = String(url);
      this.audioWorklet.modules.push(href);
      return this.audioWorklet.failing.has(href)
        ? Promise.reject(new Error(`Couldn't load ${href}`))
        : Promise.resolve();
    },
  };
  readonly calls: string[] = [];
  private time = 0;
  private pendingResumes: (() => void)[] = [];

  constructor(options: FakeContextOptions = {}) {
    super();
    this.sampleRate = options.sampleRate ?? 48000;
    this.allowed = options.allowed ?? true;
    this.state = this.allowed ? "running" : "suspended";
    this.destination = new FakeNode(this, "destination", 1, 0);
  }

  get currentTime(): number {
    return this.time;
  }

  /** Moves the clock on, if the context is running. */
  advance(seconds: number): void {
    if (this.state === "running") {
      this.time += seconds;
    }
  }

  checkOpen(): void {
    if (this.state === "closed") {
      throw new Error("InvalidStateError: the context is closed");
    }
  }

  /** Changes `state` and fires `statechange`, as the browser does. */
  setState(state: AudioContextState): void {
    if (this.state !== state) {
      this.state = state;
      this.dispatchEvent(new Event("statechange"));
    }
  }

  /**
   * Starts the context when it is allowed to. When it isn't, the promise stays
   * pending (as in Chromium) until a later, allowed `resume()`.
   */
  resume(): Promise<void> {
    this.calls.push("resume");
    if (this.state === "closed") {
      return Promise.reject(new Error("InvalidStateError: the context is closed"));
    }
    if (!this.allowed) {
      return new Promise((resolve) => {
        this.pendingResumes.push(resolve);
      });
    }
    this.setState("running");
    for (const resolve of this.pendingResumes.splice(0)) {
      resolve();
    }
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.calls.push("suspend");
    if (this.state === "closed") {
      return Promise.reject(new Error("InvalidStateError: the context is closed"));
    }
    this.setState("suspended");
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push("close");
    this.setState("closed");
    return Promise.resolve();
  }

  /** Makes a node of `Kind`, honouring `failAt`. */
  make<N extends FakeNode>(build: () => N): N {
    this.checkOpen();
    this.created++;
    if (this.created === this.failAt) {
      throw new Error(`Injected failure at node ${String(this.created)}`);
    }
    const node = build();
    this.nodes.push(node);
    return node;
  }

  createGain = () => this.make(() => new FakeGain(this, "gain"));
  createOscillator = () => this.make(() => new FakeOscillator(this, "oscillator", 0));
  createBiquadFilter = () => this.make(() => new FakeBiquad(this, "biquad"));
  createConstantSource = () => this.make(() => new FakeConstantSource(this, "constant", 0));
  createBufferSource = () => this.make(() => new FakeBufferSource(this, "buffer-source", 0));
  createConvolver = () => this.make(() => new FakeConvolver(this, "convolver"));
  createStereoPanner = () => this.make(() => new FakeStereoPanner(this, "panner"));
  createDelay = () => this.make(() => new FakeDelay(this, "delay"));
  createDynamicsCompressor = () => this.make(() => new FakeCompressor(this, "compressor"));
  createWaveShaper = () => this.make(() => new FakeWaveShaper(this, "waveshaper"));
  createAnalyser = () => this.make(() => new FakeAnalyser(this, "analyser"));
  createMediaStreamDestination = () =>
    this.make(() => new FakeMediaStreamDestination(this, "media-stream-destination", 1, 0));
  createChannelSplitter = (outputs = 6) =>
    this.make(() => new FakeNode(this, "splitter", 1, outputs));
  createChannelMerger = (inputs = 6) => this.make(() => new FakeNode(this, "merger", inputs, 1));
  createWorklet = (name: string, options?: AudioWorkletNodeOptions) =>
    this.make(() => new FakeWorkletNode(this, name, options));

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createPeriodicWave(real: Iterable<number>, imag: Iterable<number>): object {
    return { real: Array.from(real), imag: Array.from(imag) };
  }

  /** This context as the type sound and engine code expects. */
  asContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

/** Whether `node` is a source that has been started. */
export function isSource(node: FakeNode): node is FakeSourceNode {
  return node instanceof FakeSourceNode;
}

/** The node constructors, each backed by the matching fake factory. */
const CONSTRUCTORS: Record<string, (ctx: FakeAudioContext, options?: object) => object> = {
  GainNode: (ctx, o) => ctx.createGain().applyOptions(o),
  OscillatorNode: (ctx, o) => {
    const { periodicWave, ...rest } = (o ?? {}) as { periodicWave?: unknown };
    const osc = ctx.createOscillator().applyOptions(rest);
    if (periodicWave !== undefined) {
      osc.setPeriodicWave(periodicWave);
    }
    return osc;
  },
  BiquadFilterNode: (ctx, o) => ctx.createBiquadFilter().applyOptions(o),
  ConstantSourceNode: (ctx, o) => ctx.createConstantSource().applyOptions(o),
  AudioBufferSourceNode: (ctx, o) => ctx.createBufferSource().applyOptions(o),
  ConvolverNode: (ctx, o) => {
    const { disableNormalization, ...rest } = (o ?? {}) as { disableNormalization?: boolean };
    return ctx
      .createConvolver()
      .applyOptions({ ...rest, normalize: disableNormalization !== true });
  },
  StereoPannerNode: (ctx, o) => ctx.createStereoPanner().applyOptions(o),
  DelayNode: (ctx, o) => {
    const { maxDelayTime: _max, ...rest } = (o ?? {}) as { maxDelayTime?: number };
    return ctx.createDelay().applyOptions(rest);
  },
  DynamicsCompressorNode: (ctx, o) => ctx.createDynamicsCompressor().applyOptions(o),
  WaveShaperNode: (ctx, o) => ctx.createWaveShaper().applyOptions(o),
  ChannelSplitterNode: (ctx, o?: ChannelSplitterOptions) =>
    ctx.createChannelSplitter(o?.numberOfOutputs),
  ChannelMergerNode: (ctx, o?: ChannelMergerOptions) => ctx.createChannelMerger(o?.numberOfInputs),
  PeriodicWave: (ctx, o) => {
    const { real = [], imag = [] } = (o ?? {}) as { real?: number[]; imag?: number[] };
    return ctx.createPeriodicWave(real, imag);
  },
};

/**
 * Defines the Web Audio constructors (`GainNode`, `OscillatorNode`, …,
 * `AudioWorkletNode`) as globals backed by the fakes. Returns a function that
 * removes them again.
 */
export function installFakeAudioGlobals(): () => void {
  const definitions: Record<string, unknown> = {};
  for (const [name, make] of Object.entries(CONSTRUCTORS)) {
    // A plain function: called with `new`, it returns the object it builds.
    definitions[name] = function (ctx: FakeAudioContext, options?: object) {
      return make(ctx, options);
    };
  }
  definitions.AudioBuffer = function (options: AudioBufferOptions) {
    return new FakeAudioBuffer(options.numberOfChannels ?? 1, options.length, options.sampleRate);
  };
  definitions.AudioWorkletNode = function (
    ctx: FakeAudioContext,
    name: string,
    options?: AudioWorkletNodeOptions,
  ) {
    return ctx.createWorklet(name, options);
  };
  const saved = Object.keys(definitions).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(definitions)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}
