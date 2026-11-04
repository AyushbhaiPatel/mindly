import { describe, expect, it } from 'vitest';
import { matchesGlob } from '../src/glob.js';

describe('matchesGlob', () => {
  it.each([
    ['src/a.ts', 'src/*.ts', true],
    ['src/x/a.ts', 'src/*.ts', false],
    ['src/x/a.ts', 'src/**/*.ts', true],
    ['src/a.ts', 'src/**/*.ts', true],
    ['a/b/.env', '**/.env', true],
    ['.env', '**/.env', true],
    ['.env.local', '**/.env.*', true],
    ['deep/file.pem', '*.pem', true],
    ['src/a.tsx', 'src/*.{ts,tsx}', true],
    ['src/a.js', 'src/*.{ts,tsx}', false],
    ['packages/core/src', 'packages/**', true],
    ['a(b).ts', 'a(b).ts', true],
    ['axb.ts', 'a.b.ts', false],
  ])('%s vs %s -> %s', (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});
