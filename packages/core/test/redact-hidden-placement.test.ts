// Secrets in text with hidden or control characters: each replacement lands where its secret was,
// in linear time, and a key split and glued to words by such characters is still found.
import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactText } from '../src/redact.js';

const GHP = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const SETUP = `export DB_PASSWORD=hunter2abc\ngit clone https://bot:${GHP}@github.com/acme/app.git\n`;
const EXPECTED = `export DB_PASSWORD=${REDACTED}\ngit clone https://bot:${REDACTED}@github.com/acme/app.git\n`;

/** Text with the zero-width spaces taken out, as a viewer that drops them would show it. */
const shown = (text: string): string => text.replaceAll('\u200b', '');

describe('a token in a URL password, after an assignment', () => {
  // The URL rule matched the password the token rule had already replaced, and put back the
  // same text: that edit was recorded and threw every later one out of place.
  it('keeps CRLF line endings', () => {
    const crlf = SETUP.replaceAll('\n', '\r\n');
    expect(redactText(crlf)).toBe(EXPECTED.replaceAll('\n', '\r\n'));
  });

  it('keeps emoji joiners', () => {
    expect(redactText(`${SETUP}Done 👨\u200d💻`)).toBe(`${EXPECTED}Done 👨\u200d💻`);
  });

  it('keeps the rest of the text', () => {
    const text = `${SETUP}Notes: all passed. key\u200bAKIAIOSFODNN7EXAMPLE was rotated.`;
    expect(redactText(text)).toBe(
      `${EXPECTED}Notes: all passed. key\u200b${REDACTED} was rotated.`,
    );
  });

  it('counts the token once', () => {
    expect(redact(`https://bot:${GHP}@github.com\u200b`).count).toBe(1);
  });

  it('reads 250 KB of assignments after it in linear time', () => {
    const input = (size: number): string =>
      `https://u:${GHP}@h ${'password=hunter2abc '.repeat(size / 20)}\u200b`;
    const fastest = (text: string): number => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        redact(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    expect(fastest(input(250_000))).toBeLessThan(200);
  });
});

describe('a key split and glued to words by hidden characters', () => {
  it('is found when glued on the left to a word of two parts', () => {
    const text = 'foo\u200bbar\u200bAKIAIOSF\u200bODNN7EXAMPLE';
    expect(redactText(text)).toBe(`foo\u200bbar\u200b${REDACTED}`);
  });

  it('is found when glued to another split key', () => {
    const text = 'AKIAIOSF\u200bODNN7EXAMPLE\u200bAKIAI44Q\u200bH8DHBEXAMPLE';
    expect(redactText(text)).toBe(`${REDACTED}\u200b${REDACTED}`);
  });

  it('is found when glued on both sides, with runs in each word', () => {
    const split = `${GHP.slice(0, 9)}\u200b${GHP.slice(9, 20)}\u2060${GHP.slice(20)}`;
    const text = `see foo\u200bbar\u200d${split}\u200bbaz\u200bqux.`;
    const out = redactText(text);
    expect(shown(out)).not.toContain(GHP.slice(4, 16));
    expect(out).toBe(`see foo\u200bbar\u200d${REDACTED}\u200bbaz\u200bqux.`);
  });
});
