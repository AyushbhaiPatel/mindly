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

  it('does not let an unclosed brace swallow the lines below it', () => {
    expect(splitGlobs('src/{api,web/**\ndocs/**, a.ts')).toEqual([
      'src/{api,web/**',
      'docs/**',
      'a.ts',
    ]);
    expect(splitGlobs('a}, b')).toEqual(['a}', 'b']);
  });
});
