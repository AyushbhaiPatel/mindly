import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED, redactText } from '../src/redact.js';

/*
 * A corpus of command lines checked against what redaction did as of b9305ce, recorded once in
 * the fixture so these tests need no old code: every secret it removed must still be removed, and
 * lines without a secret must not change more than it changed them.
 */

interface Corpus {
  commands: { text: string; parentRedacted: boolean; mustRedact: boolean }[];
  exact: { text: string; parentRedacted: boolean }[];
  benign: { text: string; parent?: string }[];
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
      .filter((c) => c.mustRedact && redactText(c.text).includes('S3CR3T'))
      .map((c) => c.text);
    expect(leaks).toEqual([]);
  });

  it('changes nothing in a generated command line but its secret', () => {
    const wrong = corpus.exact
      .map((c) => ({ text: c.text, out: redactText(c.text) }))
      .filter(({ text, out }) => out !== text.replace('Zq9S3CR3Tw7', REDACTED));
    expect(wrong).toEqual([]);
  });

  it('leaves lines without a secret as they were, or as redaction before left them', () => {
    const changed = corpus.benign
      .map((c) => ({ ...c, out: redactText(c.text) }))
      .filter(({ text, parent, out }) => out !== text && out !== parent);
    expect(changed).toEqual([]);
    // Lines it left alone are still left alone.
    const kept = corpus.benign.filter((c) => c.parent === undefined);
    expect(kept.filter((c) => redactText(c.text) !== c.text).map((c) => c.text)).toEqual([]);
  });
});
