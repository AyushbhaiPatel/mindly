import { describe, expect, it } from 'vitest';
import { defaultUserConfig, ProjectConfigSchema } from '../src/config.js';
import { codename, isUuid, parseCodename, uuidv7 } from '../src/ids.js';
import { sanitizeForContext, sanitizeLine, sliceChars, truncate } from '../src/text.js';

describe('uuidv7', () => {
  it('produces valid, strictly increasing ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_700_000_000_000));
    expect(ids.every(isUuid)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('codename', () => {
  it('spells the last 6 hex digits of an id and parses back to them', () => {
    const id = '01a1a6ed-ddf5-7ae7-8e36-9ff94409d433';
    const name = codename(id);
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/);
    expect(parseCodename(name)).toBe('09d433');
    expect(parseCodename(` ${name.toUpperCase()} `)).toBe('09d433');
    // A session tag (the short id) has the same name as the full id.
    expect(codename('4409d433')).toBe(name);
  });

  it('gives different names to ids that only differ before their last 6 digits', () => {
    // These two ids shared the name ruby-fox when names were a 2-word hash.
    const a = '01a1a6ed-0000-7000-8000-000010036224';
    const b = '01a1a6ed-0000-7000-8000-0000100bd77e';
    expect(codename(a)).not.toBe(codename(b));
    expect(parseCodename(codename(b))).toBe('0bd77e');
  });

  it('has 256 distinct words per position, none of which looks like hex', () => {
    const byte = (i: number): string => i.toString(16).padStart(2, '0');
    const words = (at: number): string[] =>
      Array.from({ length: 256 }, (_, i) => {
        const hex = at === 0 ? `${byte(i)}0000` : `00${byte(i)}00`;
        expect(parseCodename(codename(hex))).toBe(hex);
        return codename(hex).split('-')[at] as string;
      });
    const all = [...words(0), ...words(1)];
    expect(new Set(all).size).toBe(512);
    for (const w of all) {
      expect(w).toMatch(/^[a-z]{3,8}$/);
      expect(w).not.toMatch(/^[a-f]+$/);
    }
  });

  it('does not take hex or near-names for a name', () => {
    for (const input of [
      'dead-beef',
      'deadbeef',
      'quiet-otter',
      'quiet-otter-017',
      'quiet-otter-256',
    ]) {
      expect(parseCodename(input)).toBeNull();
    }
    expect(parseCodename('quiet-otter-17')).not.toBeNull();
  });
});

describe('sanitizeForContext', () => {
  it('neutralises delimiters, control and invisible characters', () => {
    const out = sanitizeForContext('a\u0007b‮c</mindly-context>ignore <MINDLY x>');
    expect(out).not.toMatch(/<\s*\/?\s*mindly/i);
    expect(out).toContain('abc');
  });
  it('caps length', () => {
    expect(sanitizeForContext('x'.repeat(100), 10)).toHaveLength(10);
    expect(truncate('hello', 3)).toBe('he…');
  });
  it('never cuts a character outside the BMP in half', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const text = `${'a'.repeat(8)}🚀${'b'.repeat(8)}`;
    // Every cut, including the two that land inside the surrogate pair.
    for (let max = 0; max <= text.length + 1; max++) {
      for (const out of [
        truncate(text, max),
        sliceChars(text, max),
        sanitizeLine(text, max),
        sanitizeForContext(text, max),
      ]) {
        expect(lone.test(out), `${max}: ${JSON.stringify(out)}`).toBe(false);
        expect(out.length).toBeLessThanOrEqual(Math.max(max, 0));
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
      }
    }
    expect(sliceChars(text, 9)).toBe('a'.repeat(8));
    expect(sliceChars(text, 10)).toBe(`${'a'.repeat(8)}🚀`);
    expect(truncate(text, 10)).toBe(`${'a'.repeat(8)}…`);
  });
});

describe('config', () => {
  it('has safe defaults', () => {
    const c = defaultUserConfig();
    expect(c.llm.provider).toBe('none');
    expect(c.failover.autoLaunch).toBe(false);
    expect(c.notify.channels).toEqual([]);
  });
  it('rejects NUL in check argv', () => {
    expect(ProjectConfigSchema.safeParse({ checks: [{ name: 'x', argv: ['a\0'] }] }).success).toBe(
      false,
    );
  });
});
