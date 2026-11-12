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
    // Measured against half the text, so a slow machine passes: twice the text may take up to
    // three times as long, where reading it again for every assignment takes four.
    const half = fastest(input(125_000));
    const whole = fastest(input(250_000));
    expect(whole).toBeLessThan(Math.max(3 * half, 20));
    expect(whole).toBeLessThan(600);
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
    // The token's characters run on past the hidden characters after it, so the words glued
    // after it go with it; those before it are kept.
    expect(out).toBe(`see foo\u200bbar\u200d${REDACTED}.`);
  });

  it('is found when the text also holds a private-use or noncharacter', () => {
    const split = 'foo\u200bbar\u200bAKIAIOSF\u200bODNN7EXAMPLE';
    expect(redactText(`\uE000 ${split}`)).toBe(`\uE000 foo\u200bbar\u200b${REDACTED}`);
    expect(redactText(`\uFDD0\uE000 ${split}`)).toBe(`\uFDD0\uE000 foo\u200bbar\u200b${REDACTED}`);
    let all = '';
    for (let c = 0xfdd0; c <= 0xfdef; c++) all += String.fromCharCode(c);
    for (let c = 0xe000; c <= 0xe0fe; c++) all += String.fromCharCode(c);
    expect(redactText(`${all} ${split}`)).toBe(`${all} foo\u200bbar\u200b${REDACTED}`);
  });

  it('finds a JWT split and glued to words', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text = `x foo\u200beyJhbG\u200b${jwt.slice(6)}\u200bbar`;
    expect(redactText(text)).toBe(`x foo\u200b${REDACTED}`);
  });
});

describe('a key glued on the left and split twice by hidden characters', () => {
  // The last part of the key stopped at the first hidden character it did not need, and the rest
  // of the key stayed in clear.
  it('is redacted to its end: an Anthropic key', () => {
    const tail = `YzAbCdEfGhIjKlMnOpQrStUvWx${'YzAbCdEfGhIjKlMnOpQrStUv'.repeat(2)}-AA`;
    const text = `see foo\u200bsk-ant-ap\u200bi03-AbCdEfGhIjKlMnOpQrStUvWx\u200b${tail} done`;
    expect(redactText(text)).toBe(`see foo\u200b${REDACTED} done`);
  });

  it('is redacted to its end: a JWT signature', () => {
    const sigTail = 'mNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text =
      `see foo\u200beyJhb\u200bGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.` +
      `dozjgNryP4J3jV\u200b${sigTail} done`;
    expect(redactText(text)).toBe(`see foo\u200b${REDACTED} done`);
  });
});

describe('JWT heads in a row', () => {
  it.each([
    ['eyJ\u200b'],
    ['eyJaaaaaaaa\u200b'],
    ['eyJhbG\u200bciOiJIUzI1NiJ9\u200b'],
    ['eyJa-a\u200b'],
    // Without hidden characters, each `eyJ` after a `-` started a search for the `.`.
    ['a-eyJ'],
    ['a-eyJaaaaaaaa'],
  ])('reads 250 KB of %j in linear time', (unit) => {
    const best = (size: number): number => {
      const text = unit.repeat(Math.ceil(size / unit.length));
      let fastest = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        redact(text);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    // Twice the text takes twice the time, give or take; a search that starts over at each
    // `eyJ` takes four times. Measured against the half, so a slow machine passes.
    const half = best(125_000);
    const whole = best(250_000);
    expect(whole).toBeLessThan(Math.max(3 * half, 20));
    expect(whole).toBeLessThan(600);
  });
});
