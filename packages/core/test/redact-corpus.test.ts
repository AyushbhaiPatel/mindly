import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED, redactText } from '../src/redact.js';

/*
 * A corpus of command lines checked against what redaction did as of b9305ce, recorded once in
 * the fixture so these tests need no old code: every secret it removed must still be removed, and
 * lines without a secret must come out exactly as recorded.
 */

interface Corpus {
  commands: { text: string; parentRedacted: boolean; mustRedact: boolean; knownMiss?: true }[];
  exact: { text: string; parentRedacted: boolean }[];
  benign: { text: string; parent?: string; expected?: string }[];
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'redaction-corpus.json'), 'utf8'),
) as Corpus;

describe('redaction corpus', () => {
  it('holds every kind of case', () => {
    expect(corpus.commands.length).toBeGreaterThan(200);
    expect(corpus.exact.length).toBeGreaterThan(400);
    expect(corpus.benign.length).toBeGreaterThan(50);
  });

  it('removes every secret removed before, and every one removed since', () => {
    const leaks = corpus.commands
      .filter((c) => c.mustRedact && !c.knownMiss && redactText(c.text).includes('S3CR3T'))
      .map((c) => c.text);
    expect(leaks).toEqual([]);
  });

  it('misses only the one secret listed: a value on the line after its flag', () => {
    // Lines are joined only across a continuation or into an indented option line, so a value
    // after a bare line break is not read. Redaction as of b9305ce removed this one.
    const misses = corpus.commands.filter((c) => c.knownMiss).map((c) => c.text);
    expect(misses).toEqual(['curl -u\r\nadmin:S3CR3T']);
    expect(misses.every((text) => redactText(text).includes('S3CR3T'))).toBe(true);
  });

  it('changes nothing in a generated command line but its secret', () => {
    const wrong = corpus.exact
      .map((c) => ({ ...c, out: redactText(c.text) }))
      .filter(({ text, out, parentRedacted }) => {
        const redacted = text.replace('Zq9S3CR3Tw7', REDACTED);
        return parentRedacted ? out !== redacted : out !== redacted && out !== text;
      });
    expect(wrong).toEqual([]);
  });

  it('turns lines without a secret into exactly what is recorded', () => {
    const changed = corpus.benign
      .map((c) => ({ ...c, out: redactText(c.text) }))
      .filter(({ text, expected, out }) => out !== (expected ?? text));
    expect(changed).toEqual([]);
    // Each recorded change is a value after `-u`, `-a` or the like redacted, nothing else.
    for (const { text, expected } of corpus.benign) {
      if (expected === undefined) continue;
      const pattern = new RegExp(
        `^${expected
          .split(REDACTED)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^\\s]+')}$`,
      );
      expect(pattern.test(text), text).toBe(true);
    }
  });
});
