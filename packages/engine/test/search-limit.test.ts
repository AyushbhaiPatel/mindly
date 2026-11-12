// A rule limited to the folder being written asks git for no less than the rule itself covers there.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { matchesGlob } from '@mindly/core';
import { limitTo } from '../src/hooks/search.js';

const RULES = [
  'certs/**',
  'certs/*',
  'certs/*.pem',
  'certs/server.pem',
  '**/certs/**',
  '**/certs/*',
  '**/certs/*.pem',
  '**/certs/server.pem',
  '**/*.pem',
  '*.pem',
  '**/server.pem',
  'server.pem',
  'src/**/certs/**',
  'src/**/*.pem',
  'src/*/certs/*.pem',
  '**/config/secrets.json',
  'config/**/secrets.json',
  '**/migrations/**',
  '**/.env',
  '**/.env*',
  '.env.*',
  'packages/*/src/generated/**',
  '**/pkg/**/p.pem',
  // more of the same kinds
  '**/certs/**/x/*.pem',
  '**/certs/**/certs/**',
  '**/*/certs/**',
  '**/cert?/**',
  '**/{certs,keys}/**',
  '**/app/certs/**',
  '**/app/**/certs/*.pem',
  'src/**/app/**/server.pem',
  'src/**/app/certs/**',
  '**/prisma/migrations/**',
  'packages/**/migrations/**',
  'packages/*/prisma/**',
  '*/certs/**',
  '**/certs',
  '**/x/**',
  './certs/**',
  './**/certs/*.pem',
  'certs/**/certs/**',
  '**/generated/**',
  'packages/**',
  '**',
  '**/*',
];
const BASES = [
  'certs',
  'app',
  'src',
  'config',
  'pkg',
  'packages',
  'x',
  'app/certs',
  'src/app',
  'src/certs',
  'app/config',
  'config/prod',
  'prisma/migrations',
  'pkg/certs',
  'lib/pkg',
  'services/api',
  'packages/db',
  'packages/api',
  'certs/certs',
  'certs/x',
  'src/app/certs',
  'src/a/b',
  'packages/api/src',
  'packages/db/prisma',
  'certs/x/certs',
  'x/pkg/y',
  'a/b/c/certs',
  'src/x/app/certs',
  'packages/api/src/generated',
  'packages/db/prisma/migrations',
  'x/pkg/y/certs',
  'app/certs/x/y',
];

const WILD = /[*?{]/;
const names = (last: string): string[] => {
  if (last === '**' || last === '*') return ['f.txt', '.hidden'];
  if (last === '*.pem') return ['server.pem', 'f.txt'];
  if (last === '.env*') return ['.env', '.env.local', 'f.txt'];
  if (last === '.env.*') return ['.env.local', '.env', 'f.txt'];
  if (WILD.test(last)) return ['f.txt'];
  return [last, 'f.txt'];
};

it('lists every file the rule covers under the folder', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-limit-')));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], more: Record<string, string> = {}, input?: string) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...env, ...more },
      input,
      maxBuffer: 1 << 28,
    }).toString();
  git(['init', '-q']);
  const blob = git(['hash-object', '-w', '--stdin'], {}, 'x\n').trim();
  const failures: string[] = [];
  let pairs = 0;
  let files = 0;
  for (const rule of RULES) {
    const segments = rule.replace(/^\.\//, '').split('/');
    const last = segments[segments.length - 1] as string;
    const literal = segments.slice(0, -1).filter((s) => !WILD.test(s));
    const extra = segments.some((s) => s === 'cert?' || s.includes('{')) ? ['certs', 'keys'] : [];
    for (const base of BASES) {
      pairs++;
      const alphabet = [...new Set([...base.split('/'), ...literal, ...extra, 'x'])].slice(0, 7);
      // Every folder up to four levels below the base, by these names.
      let level = [base];
      const dirs = [base];
      for (let depth = 0; depth < 4; depth++) {
        level = level.flatMap((d) => alphabet.map((a) => `${d}/${a}`));
        dirs.push(...level);
      }
      const all = dirs.flatMap((d) => names(last).map((n) => `${d}/${n}`));
      // A name that is also a folder here cannot be both in one index: the folder is kept.
      const folders = new Set(dirs);
      const covered = all.filter((p) => matchesGlob(p, rule) && !folders.has(p));
      if (covered.length === 0) continue;
      files += covered.length;
      const index = join(dir, '.git', `index-${pairs}`);
      git(
        ['update-index', '--index-info'],
        { GIT_INDEX_FILE: index },
        covered.map((p) => `100644 ${blob}\t${p}\n`).join(''),
      );
      const limited = limitTo(base, rule);
      // git has no `{a,b}`: one pattern for each alternative, as the search asks.
      let forms = [limited.replace(/^\.\//, '')];
      for (let round = 0; round < 4; round++) {
        forms = forms.flatMap((f) => {
          const m = /\{([^{}]*)\}/.exec(f);
          return m
            ? (m[1] as string)
                .split(',')
                .map((alt) => f.slice(0, m.index) + alt + f.slice(m.index + m[0].length))
            : [f];
        });
      }
      const listed = new Set(
        git(['ls-files', '-z', '--', ...forms.map((f) => `:(top,glob)${f}`)], {
          GIT_INDEX_FILE: index,
        })
          .split('\0')
          .filter((x) => x !== ''),
      );
      const missing = covered.filter((p) => !listed.has(p));
      if (missing.length > 0) {
        failures.push(
          `limitTo(${base}, ${rule}) = ${limited}: ${missing.length} of ${covered.length} covered files not listed, e.g. ${missing.slice(0, 3).join(', ')}`,
        );
      }
    }
  }
  console.log(
    `${pairs} pairs, ${files} covered files held against the limited pattern, ${failures.length} pairs with a file missing`,
  );
  expect(failures).toEqual([]);
}, 600_000);
