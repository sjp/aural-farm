/** A short, human-readable description of anything thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    // JSON.stringify returns undefined for undefined, functions and symbols.
    const json = JSON.stringify(error) as string | undefined;
    return json ?? String(error);
  } catch {
    return String(error);
  }
}
