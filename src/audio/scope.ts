/**
 * Clean-up bookkeeping for a sound's audio graph. Everything a sound builds is
 * registered with a scope as it is made, so one `dispose()` stops and disconnects
 * it all, and a throw part-way through building releases what was built so far.
 */

interface Disposable {
  dispose: () => void;
}

export interface AudioScope {
  /** Disconnects `node` on dispose. Returns it, so creation and registration read as one. */
  add: <T extends AudioNode>(node: T) => T;
  /** Stops and disconnects a scheduled source (oscillator, buffer or constant source) on dispose. */
  addSource: <T extends AudioScheduledSourceNode>(source: T) => T;
  /** Disposes `disposable` on dispose. */
  own: <T extends Disposable>(disposable: T) => T;
  /** Runs `fn` on dispose. */
  defer: (fn: () => void) => void;
  /**
   * Runs every clean-up in reverse order of registration. It keeps going when one
   * throws, then rethrows the first error. Running it again does nothing.
   */
  dispose: () => void;
}

/** Whether `node` is an `AudioWorkletNode`, which reports processor crashes as events. */
function isWorkletNode(node: AudioNode): node is AudioWorkletNode {
  return "port" in node && "parameters" in node;
}

/** The error a `processorerror` event carries, or one describing it. */
function crashOf(event: Event): unknown {
  if ("error" in event && event.error !== undefined && event.error !== null) {
    return event.error;
  }
  const message = "message" in event && typeof event.message === "string" ? event.message : "";
  return new Error(message === "" ? "The audio processor crashed" : message);
}

function createAudioScope(onError: ((error: unknown) => void) | undefined): AudioScope {
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const register = (cleanup: () => void) => {
    if (disposed) {
      // Something registered after dispose (an async build finishing late) is
      // released straight away rather than leaked.
      cleanup();
    } else {
      cleanups.push(cleanup);
    }
  };

  const add = <T extends AudioNode>(node: T): T => {
    if (onError && isWorkletNode(node)) {
      const report = (event: Event) => {
        onError(crashOf(event));
      };
      node.addEventListener("processorerror", report);
      register(() => {
        node.removeEventListener("processorerror", report);
        node.disconnect();
      });
    } else {
      register(() => {
        node.disconnect();
      });
    }
    return node;
  };

  return {
    add,
    addSource(source) {
      register(() => {
        try {
          source.stop();
        } catch {
          // Stopping a source that never started throws; it makes no sound either way.
        }
        source.disconnect();
      });
      return source;
    },
    own(disposable) {
      register(() => {
        disposable.dispose();
      });
      return disposable;
    },
    defer: register,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      let first: { error: unknown } | undefined;
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        try {
          cleanup?.();
        } catch (error) {
          first ??= { error };
        }
      }
      if (first) {
        throw first.error;
      }
    },
  };
}

/**
 * Builds with a fresh scope. If `build` throws (or its promise rejects), whatever
 * it registered so far is disposed and the error is rethrown. `onError` receives a
 * processor crash from any `AudioWorkletNode` added to the scope.
 *
 *   create(ctx, out, init) {
 *     return withAudioScope((scope) => {
 *       const osc = scope.addSource(new OscillatorNode(ctx));
 *       …
 *       return { update, dispose: () => scope.dispose() };
 *     }, init.onError);
 *   }
 */
export function withAudioScope<T>(
  build: (scope: AudioScope) => T,
  onError?: (error: unknown) => void,
): T {
  const scope = createAudioScope(onError);
  const release = (error: unknown): never => {
    try {
      scope.dispose();
    } catch {
      // The build's own error matters more than a clean-up's.
    }
    throw error;
  };
  let result: T;
  try {
    result = build(scope);
  } catch (error) {
    return release(error);
  }
  if (result instanceof Promise) {
    // An async build: release on rejection too. The cast keeps T as the caller's promise type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return result.catch(release) as T;
  }
  return result;
}
