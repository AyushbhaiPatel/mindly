import { describe, expect, it } from 'vitest';
import { globsMayOverlap, matchesGlob } from '../src/glob.js';

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

describe('globsMayOverlap', () => {
  it.each([
    ['src/billing/**', '**/*.test.ts', true],
    ['src/*.ts', 'src/new.*', true],
    ['web/**', '**/billing/**', true],
    ['src/**', 'src/api/**', true],
    ['src/*.ts', 'src/*.test.ts', true],
    ['src/**/index.ts', 'src/**/*.ts', true],
    ['*.md', 'docs/**', true],
    ['src/a.ts', 'src/a.ts', true],
    ['src/{a,b}/**', 'src/c/**', true],
    ['src/api/**', 'src/app/**', false],
    ['api/**', 'web/**', false],
    ['src/**/*.ts', 'src/**/*.css', false],
    ['src/**/index.ts', 'src/**/*.css', false],
    ['src/**/index.ts', 'src/**/main.ts', false],
    ['src/api/*.ts', 'src/api/x.*', true],
    ['src/api.ts', 'src/api.ts/**', true],
    ['src/api.ts', 'src/api.ts/x.ts', false],
    ['docs/*.md', 'docs/*.txt', false],
    ['src/user-*.ts', 'src/admin-*.ts', false],
  ])('%s vs %s may overlap: %s', (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected);
    expect(globsMayOverlap(b, a)).toBe(expected);
  });
});
