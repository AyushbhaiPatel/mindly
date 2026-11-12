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

  it.each([
    // A pattern without wildcards names a file or a folder.
    ['src/api/billing.ts', 'src/api', true],
    ['src/api/v2/billing.ts', 'src/api', true],
    ['src/api', 'src/api', true],
    ['src/api.ts', 'src/api', false],
    ['src/apix/billing.ts', 'src/api', false],
    ['web/src/api/billing.ts', 'src/api', false],
    ['package.json', 'package.json', true],
    ['web/package.json', 'package.json', true],
    // Without a slash it is found at any depth, like the file-name patterns.
    ['infra/main.tf', 'infra', true],
    ['services/pay/infra/main.tf', 'infra', true],
    ['infrastructure/main.tf', 'infra', false],
    ['docs/infra.md', 'infra', false],
    ['infra/main.tf', './infra', true],
    ['services/pay/infra/main.tf', './infra', false],
    // A trailing slash means the folder only: what is below it, never a file of that name.
    ['deploy/k8s.yaml', 'deploy/', true],
    ['apps/web/deploy/k8s.yaml', 'deploy/', true],
    ['deploy', 'deploy/', false],
    ['src/api/billing.ts', 'src/api/', true],
    ['src/api', 'src/api/', false],
    ['web/src/api/billing.ts', 'src/api/', false],
    ['src/generated/api.ts', 'src/gen*/', true],
    ['src/generated.ts', 'src/gen*/', false],
    // Patterns with wildcards keep matching exactly what they describe.
    ['src/api/billing.ts', 'src/*', false],
    ['generated/api.ts', 'generated/**', true],
    ['src/generated/api.ts', 'generated/**', false],
    ['src/generated/api.ts', '**/generated/**', true],
    ['a.ts', '/', false],
    ['a.ts', './', false],
  ])('folder patterns: %s vs %s -> %s', (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });

  it('ignores letter case in folder patterns only with nocase', () => {
    expect(matchesGlob('SRC/API/billing.ts', 'src/api/')).toBe(false);
    expect(matchesGlob('SRC/API/billing.ts', 'src/api/', { nocase: true })).toBe(true);
  });

  it('refuses a pattern that is too long', () => {
    expect(() => matchesGlob('a.ts', 'a'.repeat(513))).toThrow('glob too long');
    expect(matchesGlob('a.ts', 'a'.repeat(512))).toBe(false);
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
    ['src/api/**', 'src/app/**', false],
    ['api/**', 'web/**', false],
    ['src/**/*.ts', 'src/**/*.css', false],
    ['src/**/index.ts', 'src/**/*.css', false],
    ['src/**/index.ts', 'src/**/main.ts', false],
    ['src/api/*.ts', 'src/api/x.*', true],
    ['src/api.ts', 'src/api.ts/**', true],
    ['docs/*.md', 'docs/*.txt', false],
    ['src/user-*.ts', 'src/admin-*.ts', false],
    // Folders overlap what is below them, however the folder is written.
    ['src/api', 'src/api/billing.ts', true],
    ['src/api/', 'src/api/**/*.ts', true],
    ['src/api/', 'src/api', true],
    ['src', 'src/api/', true],
    ['api', 'web/api/routes.ts', true],
    ['infra/', '**/*.tf', true],
    ['src/api', '*.ts', true],
    ['src/api/', 'src/app/', false],
    ['src/api', 'src/app', false],
    ['src/api/', 'src/apix/**', false],
    ['./api', 'web/api/routes.ts', false],
    // Groups are expanded before the pattern is split, so an alternative may hold a slash.
    ['src/{a,b}/**', 'src/c/**', false],
    ['src/{a,b/c}', 'src/*/c', true],
    ['src/{a,b/c}', 'src/b/*', true],
    ['src/{a,b/c}', 'src/b', true],
    ['src/{a,b/c}', 'src/d/c', false],
    ['src/{api,lib/billing}/**', 'src/lib/**', true],
    ['src/{api,lib/billing}/**', 'src/app/**', false],
    ['{src,lib}/api/**', 'lib/api/x.ts', true],
    ['{src,lib}/api/**', 'web/api/**', false],
    ['src/*.{ts,css}', 'src/*.css', true],
    ['src/*.{ts,css}', 'src/*.md', false],
    ['src/{a/**,b}', 'src/a/x/y.ts', true],
  ])('%s vs %s may overlap: %s', (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected);
    expect(globsMayOverlap(b, a)).toBe(expected);
  });

  it('ignores letter case only with nocase', () => {
    expect(globsMayOverlap('src/API/**', 'src/api/**')).toBe(false);
    expect(globsMayOverlap('src/API/**', 'src/api/**', { nocase: true })).toBe(true);
    expect(globsMayOverlap('*.TS', '*.ts')).toBe(false);
    expect(globsMayOverlap('*.TS', '*.ts', { nocase: true })).toBe(true);
    expect(globsMayOverlap('src/API/**', 'src/app/**', { nocase: true })).toBe(false);
  });

  it('assumes an overlap when a glob has too many expansions to compare', () => {
    // 32 expansions are compared; 128 are too many, so the answer is the conservative one.
    expect(globsMayOverlap('{a,b}{c,d}{e,f}{g,h}{i,j}/**', 'x/**')).toBe(false);
    expect(globsMayOverlap('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/**', 'x/**')).toBe(true);
    expect(globsMayOverlap('src/{a,b', 'x/**')).toBe(true);
  });

  it('never calls two patterns disjoint when one path matches both', () => {
    const globs = [
      'src',
      'src/',
      './src',
      'api',
      'api/',
      'src/api',
      'src/api/',
      'src/api/**',
      'src/api/*.ts',
      'src/app/',
      'src/api/billing.ts',
      'src/**/billing.ts',
      'billing.ts',
      '*.ts',
      '**/*.test.ts',
      'src/*',
      'src/**/',
      'src/{api,app}/',
      'src/{api,app/api}/*.ts',
      'src/{x,api/v2}',
      '{src,web}/api/',
      'src/{a,b/c}',
      'src/*/c',
      'src/{**/billing.ts,app}',
      'src/{api/**,app}/billing.ts',
      '{src/**,web}/routes.ts',
      'src/{a,{api,app}}/**',
      'web/api',
      'web/',
      'README.md',
      '**',
    ];
    const paths = [
      'src',
      'api',
      'README.md',
      'billing.ts',
      'src/api',
      'src/billing.ts',
      'src/api/billing.ts',
      'src/api/billing.test.ts',
      'src/api/v2/billing.ts',
      'src/app/page.tsx',
      'src/app/api/billing.ts',
      'web/api',
      'web/api/routes.ts',
      'web/src/api/billing.ts',
      'api/billing.ts',
      'docs/README.md',
      'src/b/c',
      'src/x/c',
      'src/a/c',
      'src/api/v2',
      'src/api/v2/billing.ts',
      'src/app/api/routes.ts',
      'src/{api/billing.ts',
      'src/api}/billing.ts',
      'web/routes.ts',
    ];
    for (const a of globs) {
      for (const b of globs) {
        const shared = paths.find((p) => matchesGlob(p, a) && matchesGlob(p, b));
        if (shared !== undefined) {
          expect(globsMayOverlap(a, b), `${a} and ${b} both match ${shared}`).toBe(true);
        }
      }
    }
  });

  it('agrees with matchesGlob on random patterns with groups, slashes in groups and **', () => {
    // A small seeded generator, so a failure names the same pair on every run.
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)] as T;
    const pieces = [
      'a',
      'b',
      'c',
      'A',
      'x.ts',
      'ab',
      '*',
      '*.ts',
      'a*',
      '?',
      '**',
      '{a,b}',
      '{a,b/c}',
      '{b/c,c}',
      '{a/**,c}',
      '{**/c,b}',
      '{a,{b,c}}',
      '{,a/}b',
      '{*,b/*}',
      'b}',
    ];
    const glob = (): string => {
      const segs = Array.from({ length: 1 + rand(3) }, () => pick(pieces));
      return `${segs.join('/')}${rand(5) === 0 ? '/' : ''}`;
    };
    const names = ['a', 'b', 'c', 'A', 'x.ts', 'ab', '{b', 'c}', 'a}'];
    const paths: string[] = [...names];
    for (const p of names) for (const q of names) paths.push(`${p}/${q}`);
    for (const p of ['a', 'b', 'c'])
      for (const q of names)
        for (const r of names) {
          paths.push(`${p}/${q}/${r}`);
        }
    const globs = [...new Set(Array.from({ length: 250 }, glob))];
    for (const options of [{}, { nocase: true }]) {
      const hits = globs.map((g) => new Set(paths.filter((p) => matchesGlob(p, g, options))));
      for (let i = 0; i < globs.length; i++) {
        for (let j = i; j < globs.length; j++) {
          const shared = [...(hits[i] as Set<string>)].find((p) => (hits[j] as Set<string>).has(p));
          if (shared === undefined) continue;
          const [a, b] = [globs[i] as string, globs[j] as string];
          expect(globsMayOverlap(a, b, options), `${a} and ${b} both match ${shared}`).toBe(true);
          expect(globsMayOverlap(b, a, options), `${b} and ${a} both match ${shared}`).toBe(true);
        }
      }
    }
  });
});
