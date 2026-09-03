/** Small id and time helpers. Kept separate so tests can mock them. */

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
