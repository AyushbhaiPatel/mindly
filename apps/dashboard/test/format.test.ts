import { matchesGlob } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { splitGlobs, splitList } from '../src/format';

/** What the memory form saves for a stored scope when only the title or body is edited. */
const roundTrip = (paths: string[]) => splitGlobs(paths.join('\n'));

describe('splitGlobs', () => {
  it('splits on lines and trims each one', () => {
    expect(splitGlobs('src/api/**\nsrc/web/**')).toEqual(['src/api/**', 'src/web/**']);
    expect(splitGlobs('  a.ts \n\n b.ts \r\n c.ts\rd.ts')).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
    ]);
    expect(splitGlobs('')).toEqual([]);
    expect(splitGlobs(' \n \n')).toEqual([]);
  });

  it('keeps a brace group whole', () => {
    expect(splitGlobs('src/{api,web}/**')).toEqual(['src/{api,web}/**']);
    expect(splitGlobs('src/{api,web}/**\n*.{ts,tsx}')).toEqual(['src/{api,web}/**', '*.{ts,tsx}']);
    // The plain list splitter, still used for tags and agent names, tears it apart.
    expect(splitList('src/{api,web}/**')).toEqual(['src/{api', 'web}/**']);
  });

  it('keeps a comma outside braces as part of the pattern', () => {
    // The matcher reads it as a plain character, so the file name may contain one.
    expect(matchesGlob('docs/a,b.md', 'docs/a,b.md')).toBe(true);
    expect(splitGlobs('docs/a,b.md')).toEqual(['docs/a,b.md']);
    expect(splitGlobs('src/api/**, docs/**')).toEqual(['src/api/**, docs/**']);
  });

  it('leaves the inside of braces as written', () => {
    // The matcher does not trim alternatives: `{api, web}` means "api" or " web".
    expect(matchesGlob('src/web/x.ts', 'src/{api, web}/**')).toBe(false);
    expect(splitGlobs('src/{api, web}/**')).toEqual(['src/{api, web}/**']);
    expect(splitGlobs('{a,{b,c},d}')).toEqual(['{a,{b,c},d}']);
    expect(splitGlobs('src/{api,web/**\ndocs/**')).toEqual(['src/{api,web/**', 'docs/**']);
  });

  it('gives back a stored scope unchanged', () => {
    for (const scope of [
      ['src/{api,web}/**', 'prisma/migrations/**', '*.{ts,tsx}'],
      ['docs/a,b.md'],
      ['src/{api, web}/**'],
      ['my docs/{a b,c}/**', 'x/{a,b}/{c,d}.ts'],
    ]) {
      expect(roundTrip(scope)).toEqual(scope);
    }
  });
});
