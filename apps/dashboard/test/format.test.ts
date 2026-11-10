import { globToRegExp, matchesGlob } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { splitGlobs, splitList } from '../src/format';

describe('splitGlobs', () => {
  it('splits on lines and on commas outside braces', () => {
    expect(splitGlobs('src/api/**\nsrc/web/**')).toEqual(['src/api/**', 'src/web/**']);
    expect(splitGlobs('src/api/**, docs/**')).toEqual(['src/api/**', 'docs/**']);
    expect(splitGlobs('  a.ts ,, \n\n b.ts \r\n c.ts')).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(splitGlobs('')).toEqual([]);
  });

  it('keeps a brace group whole', () => {
    expect(splitGlobs('src/{api,web}/**')).toEqual(['src/{api,web}/**']);
    expect(splitGlobs('src/{api,web}/**, *.{ts,tsx}\ndocs/**')).toEqual([
      'src/{api,web}/**',
      '*.{ts,tsx}',
      'docs/**',
    ]);
    // The plain list splitter, still used for tags and agent names, tears it apart.
    expect(splitList('src/{api,web}/**')).toEqual(['src/{api', 'web}/**']);
  });

  it('gives back what the form shows for a saved memory', () => {
    const saved = ['src/{api,web}/**', 'prisma/migrations/**', '*.{ts,tsx}'];
    // The form fills the field with one pattern per line.
    expect(splitGlobs(saved.join('\n'))).toEqual(saved);
  });

  it('trims the alternatives of a group', () => {
    expect(splitGlobs('src/{api, web}/**')).toEqual(['src/{api,web}/**']);
    expect(splitGlobs('*.{ ts ,tsx , mts }, docs/**')).toEqual(['*.{ts,tsx,mts}', 'docs/**']);
    // Space that is part of a name elsewhere is kept.
    expect(splitGlobs('my docs/{a b, c}/**')).toEqual(['my docs/{a b,c}/**']);
  });

  it('reads one group at a time, never nested, like the matcher', () => {
    // The first `}` closes the group, so the comma after it separates two patterns.
    expect(splitGlobs('{a,{b,c},d}')).toEqual(['{a,{b,c}', 'd}']);
    expect(splitGlobs('x/{a,b}/{c,d}.ts, y')).toEqual(['x/{a,b}/{c,d}.ts', 'y']);
    // What the form gives back is what the matcher accepts for the same text.
    for (const p of splitGlobs('src/{api, web}/**\n{a,{b,c},d}')) {
      if (p.includes('{') && p.includes('}')) expect(() => globToRegExp(p)).not.toThrow();
    }
    expect(matchesGlob('src/web/x.ts', splitGlobs('src/{api, web}/**')[0]!)).toBe(true);
  });

  it('does not let an unclosed brace swallow the lines below it', () => {
    expect(splitGlobs('src/{api,web/**\ndocs/**, a.ts')).toEqual([
      'src/{api,web/**',
      'docs/**',
      'a.ts',
    ]);
    expect(splitGlobs('a}, b')).toEqual(['a}', 'b']);
  });
});
