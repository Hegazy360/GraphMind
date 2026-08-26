/** Compact unique-id generation for runs, node instances, and pauses. */

function randomHex(length: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const uuid = cryptoObj?.randomUUID?.();
  if (uuid !== undefined) return uuid.replaceAll('-', '').slice(0, length);
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

/** Monotonic per-process counter with a random session base, for pause ids. */
export function makeCounterIds(prefix: string): () => string {
  const base = randomHex(6);
  let n = 0;
  return () => `${prefix}_${base}_${(n += 1)}`;
}
