import { describe, expect, it } from 'vitest';
import { toSafePayload } from '../src/sanitize.js';

// Format characters (Unicode Cf) and variation selectors render as nothing. One inside a token
// must not hide it from the redactor.
const half = 'A1b2C3d4E5f6G7h8J9';
const FORMAT = [
  0xad, 0x61c, 0x180e, 0x200d, 0x2063, 0xfe0f, 0xfff9, 0xfffb, 0xe0001, 0xe0041, 0xe0100,
].map((c) => String.fromCodePoint(c));

describe('format characters inside a token in a pager payload', () => {
  for (const ch of FORMAT) {
    const name = `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`;
    it(`redacts a GitHub token split by ${name}`, () => {
      const p = toSafePayload({
        trigger: 'check_failed',
        title: 'check failed',
        body: `deploy uses ghp_${half}${ch}${half}`,
      });
      expect(p.body).not.toContain(half);
    });
  }
});
