/**
 * Deterministic, seedable random numbers for per-person traits and decision phases.
 *
 * Every value is a pure function of (seed, person/object id, salt). Nothing is drawn per frame,
 * so a person's traits stay fixed for a whole run and the same seed reproduces the same run.
 */

function mix32(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

const stringHashCache = new Map<string, number>();

/** FNV-1a string hash, cached because edge/route ids repeat constantly. */
export function hashString(text: string): number {
  const cached = stringHashCache.get(text);
  if (cached != null) return cached;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const result = hash >>> 0;
  if (stringHashCache.size > 20000) stringHashCache.clear();
  stringHashCache.set(text, result);
  return result;
}

/** Uniform value in [0, 1) for a (seed, id, salt) triple. */
export function seeded01(seed: number, id: number, salt: number | string): number {
  const saltValue = typeof salt === "string" ? hashString(salt) : salt;
  const h = mix32(mix32(mix32((seed | 0) ^ 0x9e3779b9) ^ Math.imul(id | 0, 0x85ebca6b)) ^ Math.imul(saltValue | 0, 0xc2b2ae35));
  return h / 4294967296;
}

/** Uniform value in [min, max). */
export function seededRange(seed: number, id: number, salt: number | string, min: number, max: number): number {
  return min + (max - min) * seeded01(seed, id, salt);
}

/** Normalises user/config input into a 32-bit unsigned seed. */
export function normalizeSeed(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.abs(Math.floor(value)) % 4294967296;
}
