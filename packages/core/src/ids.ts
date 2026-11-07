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

const ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'brisk',
  'calm',
  'clear',
  'cool',
  'crisp',
  'deep',
  'eager',
  'early',
  'fair',
  'fast',
  'firm',
  'fond',
  'free',
  'fresh',
  'glad',
  'gold',
  'good',
  'grand',
  'green',
  'happy',
  'hardy',
  'keen',
  'kind',
  'light',
  'lively',
  'lucky',
  'merry',
  'mild',
  'neat',
  'nimble',
  'noble',
  'plain',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'ready',
  'rosy',
  'safe',
  'sharp',
  'smart',
  'steady',
  'sunny',
  'swift',
  'tidy',
  'warm',
  'wise',
  'young',
  'blue',
  'coral',
  'ivory',
  'jade',
  'olive',
  'pearl',
  'plum',
  'ruby',
  'sage',
  'silver',
  'teal',
  'violet',
] as const;
const NOUNS = [
  'otter',
  'fox',
  'heron',
  'lynx',
  'owl',
  'panda',
  'raven',
  'seal',
  'tiger',
  'wolf',
  'bear',
  'bison',
  'crane',
  'deer',
  'dove',
  'eagle',
  'elk',
  'falcon',
  'finch',
  'gecko',
  'goose',
  'hare',
  'hawk',
  'ibis',
  'jay',
  'koala',
  'lark',
  'lemur',
  'llama',
  'loon',
  'mole',
  'moose',
  'newt',
  'orca',
  'oriole',
  'osprey',
  'oyster',
  'parrot',
  'pelican',
  'pike',
  'puffin',
  'quail',
  'rabbit',
  'robin',
  'salmon',
  'sparrow',
  'squid',
  'stork',
  'swan',
  'tapir',
  'tern',
  'toad',
  'trout',
  'turtle',
  'viper',
  'walrus',
  'wasp',
  'whale',
  'wren',
  'yak',
  'zebra',
  'badger',
  'beaver',
  'camel',
  'cobra',
  'dingo',
  'egret',
  'ferret',
  'gannet',
  'gull',
  'husky',
  'iguana',
  'jaguar',
  'kestrel',
  'macaw',
  'marten',
  'ocelot',
  'pigeon',
  'plover',
  'skink',
] as const;

/**
 * A readable name for an id, the same every time: `quiet-otter`. Shown wherever people used to
 * see the 8-character short id, and accepted by every command that takes an id. Two records in
 * one project can share a name; the lookup then lists both with their ids.
 */
export function codename(id: string): string {
  // FNV-1a over the compact id, split into two independent picks.
  let h = 0x811c9dc5;
  for (const ch of id.replace(/-/g, '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const a = ADJECTIVES[h % ADJECTIVES.length] as string;
  const n = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length] as string;
  return `${a}-${n}`;
}

const CODENAME_RE = /^[a-z]{3,8}-[a-z]{3,8}$/;

/** True when `input` is shaped like a {@link codename} (`quiet-otter`). */
export function isCodename(input: string): boolean {
  return CODENAME_RE.test(input.trim().toLowerCase());
}
