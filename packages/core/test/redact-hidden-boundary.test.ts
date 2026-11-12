// A hidden or control character between a word and a secret must not glue them: a pattern that
// wants a word boundary would miss the secret.
import { describe, expect, it } from 'vitest';
import { redactText } from '../src/redact.js';

const GHP = `ghp_${'b'.repeat(36)}`;

describe('a hidden or control character next to a secret', () => {
  const cases: [string, string][] = [
    ['NUL-separated list', `name\u0000${GHP}`],
    ['CR-only line endings', 'AKIAIOSFODNN7EXAMPLE\rAKIAI44QH8DHBEXAMPLE\r'],
    ['backspace after key', 'key AKIAIOSFODNN7EXAMPLE\bx'],
    ['zero-width space', `token\u200b${GHP}`],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const out = redactText(text);
      expect(out).not.toContain(GHP);
      expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });
  }
});
