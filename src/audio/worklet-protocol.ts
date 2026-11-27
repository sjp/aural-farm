/** Messages between worklet nodes and their processors, shared by both sides. */

/** Posted on a node's port when it is disposed: its processor's `process` then returns false. */
export const STOP_MESSAGE = "stop";
