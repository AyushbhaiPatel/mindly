import { randomBytes } from 'node:crypto';

let lastMs = 0;
let lastRand = 0n;

/**
 * Generates an RFC 9562 UUIDv7: 48-bit Unix millisecond timestamp followed by random bits.
 * Ids are time-ordered (good for SQLite B-tree locality) and globally unique, so records can be
 * merged across machines when sync is added. Within the same millisecond the random part is
 * incremented to keep ids strictly monotonic in this process.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = now;
  // 74 random bits: 12 in rand_a, 62 in rand_b.
  let rand = 0n;
  for (let i = 6; i < 16; i++) rand = (rand << 8n) | BigInt(bytes[i] ?? 0);
  rand &= (1n << 74n) - 1n;

  if (ms <= lastMs) {
    ms = lastMs;
    rand = lastRand + 1n;
    if (rand >= 1n << 74n) {
      ms += 1;
      rand = 0n;
    }
  }
  lastMs = ms;
  lastRand = rand;

  const out = Buffer.alloc(16);
  out.writeUIntBE(ms, 0, 6);
  const randA = Number(rand >> 62n) & 0x0fff;
  out[6] = 0x70 | (randA >> 8);
  out[7] = randA & 0xff;
  const randB = rand & ((1n << 62n) - 1n);
  out[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  for (let i = 9; i < 16; i++) {
    out[i] = Number((randB >> BigInt((15 - i) * 8)) & 0xffn);
  }
  const hex = out.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Generates a URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short, human-friendly prefix of an id for display (`mindly why` output, dashboards). */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(-8);
}
