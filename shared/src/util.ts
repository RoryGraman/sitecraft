/** Small helpers shared by every package. */

/** The message of an Error (its name when the message is empty), or the value as text. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
