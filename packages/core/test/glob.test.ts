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
    ['src/{a,b}/**', 'src/c/**', true],
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
});
