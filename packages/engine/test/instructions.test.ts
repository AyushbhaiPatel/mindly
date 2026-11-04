import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dedupeRules,
  parseInstructions,
  scanInstructionFiles,
  selfHealingOf,
  USER,
} from '../src/index.js';
import { featureSetup } from './features/fixtures.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'instructions', 'project');

function tempRoot(files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-instr-')));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function titles(text: string): string[] {
  return parseInstructions(text).rules.map((r) => r.title);
}

describe('instruction file discovery', () => {
  it('finds and parses one fixture of every supported file type', () => {
    const files = scanInstructionFiles(FIXTURE);
    const byPath = Object.fromEntries(
      files.map((f) => [f.path, { agents: f.agents, skipped: f.skipped, rules: f.rules }]),
    );
    const ruleTitles = (path: string): string[] => (byPath[path]?.rules ?? []).map((r) => r.title);

    expect(ruleTitles('CLAUDE.md')).toEqual([
      'Use pnpm, never npm or yarn',
      'Prefer named exports over default exports',
      'Testing: write tests with vitest',
      'Testing: never use snapshot tests',
      'Keep functions small and avoid deep nesting',
    ]);
    expect(ruleTitles('AGENTS.md')).toEqual([
      'Run `pnpm check` before every commit',
      'Use Conventional Commits for commit messages',
      'Use pnpm, never npm or yarn',
      'Keep pull requests small and focused on one change',
      'Never log secrets or tokens',
    ]);
    expect(ruleTitles('GEMINI.md')).toEqual([
      'Answer in British English',
      'All new modules live under `src/features`',
    ]);
    expect(ruleTitles('.cursorrules')).toEqual([
      'Always use strict TypeScript types and avoid any',
      'Do not add new dependencies without asking',
    ]);
    expect(ruleTitles('.cursor/rules/testing.mdc')).toEqual([
      'Use `describe`/`it` blocks, one behaviour per test',
    ]);
    expect(byPath['.cursor/rules/testing.mdc']?.rules[0]?.scopePaths).toEqual([
      'src/**/*.test.ts',
      'test/**/*.ts',
    ]);
    expect(byPath['.cursor/rules/release.mdc']?.skipped).toBe('manual');
    expect(ruleTitles('.windsurfrules')).toEqual([
      'Use Tailwind utility classes instead of custom CSS',
    ]);
    expect(byPath['.windsurf/rules/api.md']?.rules[0]?.scopePaths).toEqual(['src/api/**']);
    expect(ruleTitles('.github/copilot-instructions.md')).toEqual([
      'We use React with function components and hooks only',
    ]);
    expect(byPath['.github/instructions/docs.instructions.md']?.rules[0]?.scopePaths).toEqual([
      'docs/**/*.md',
    ]);
    expect(ruleTitles('.clinerules/style.md')).toEqual([
      'Prefer early returns over nested if statements',
    ]);
    expect(ruleTitles('.roorules')).toEqual(['Keep migrations backwards compatible']);
    expect(ruleTitles('.roo/rules/db.md')).toEqual(['Every SQL statement must be parameterised']);
    expect(ruleTitles('.kiro/steering/tech.md')).toEqual([
      'The backend runs on Node.js 22 with node:sqlite',
    ]);
    expect(byPath['.kiro/steering/api.md']?.rules[0]?.scopePaths).toEqual(['src/api/**/*.ts']);
    expect(byPath['.kiro/steering/manual.md']?.skipped).toBe('manual');
    expect(ruleTitles('.rules')).toEqual(['Run the formatter before you hand back code']);
    expect(ruleTitles('.augment-guidelines')).toEqual([
      'Document every public function with TSDoc',
    ]);
    expect(byPath['CLAUDE.md']?.agents).toBe('Claude Code');
    expect(byPath['.kiro/steering/tech.md']?.agents).toBe('Kiro');
  });

  it('records the line each rule came from as provenance', () => {
    const [claude] = scanInstructionFiles(FIXTURE);
    expect(claude?.rules[4]).toMatchObject({
      file: 'CLAUDE.md',
      line: 19,
      excerpt: '- Keep functions small and',
    });
    const agents = scanInstructionFiles(FIXTURE).find((f) => f.path === 'AGENTS.md');
    expect(agents?.rules[3]).toMatchObject({ line: 8, title: expect.stringMatching(/^Keep pull/) });
  });

  it('reads a symlinked file once, accepts .clinerules as a file and skips unsafe paths', () => {
    const root = tempRoot({
      'AGENTS.md': '- Use pnpm, never npm or yarn.\n',
      '.clinerules': '- Prefer early returns over nested ifs.\n',
    });
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    const outside = tempRoot({ 'secret.md': '- Leaked rule from elsewhere.\n' });
    symlinkSync(join(outside, 'secret.md'), join(root, 'GEMINI.md'));
    const paths = scanInstructionFiles(root).map((f) => f.path);
    expect(paths).toEqual(['CLAUDE.md', '.clinerules']);
    expect(scanInstructionFiles(root, ['.clinerules']).map((f) => f.path)).toEqual(['CLAUDE.md']);
  });

  it('skips files that are too large', () => {
    const root = tempRoot({ 'AGENTS.md': '- Use pnpm, never npm or yarn.\n'.repeat(10_000) });
    expect(scanInstructionFiles(root)[0]?.skipped).toBe('too_large');
  });
});

describe('instruction parsing', () => {
  it('skips headings, code, tables, comments, imports and boilerplate', () => {
    const text = [
      '# Project',
      'This file provides guidance to Claude Code when working with code in this repository.',
      'You are an expert TypeScript engineer.',
      '```',
      '- not a rule inside a fence',
      '```',
      '| a | b |',
      '<!-- - a commented out rule',
      '-->',
      '@AGENTS.md',
      'Overview',
      '========',
      '**Style**',
      '- Ok',
      '- Use tabs for indentation in Go files.',
    ].join('\n');
    expect(titles(text)).toEqual(['Use tabs for indentation in Go files']);
  });

  it('folds lead-ins into the items under them', () => {
    expect(
      titles('When writing tests:\n\n- Use vitest for unit tests\n- Mock the clock, never sleep'),
    ).toEqual(['Use vitest for unit tests', 'Mock the clock, never sleep']);
    expect(titles('- Git:\n  - Rebase on main before opening a PR')).toEqual([
      'Git: rebase on main before opening a PR',
    ]);
    expect(titles('- Errors\n    - Wrap errors with context before rethrowing')).toEqual([
      'Errors: wrap errors with context before rethrowing',
    ]);
  });

  it('keeps links and code spans readable and shortens long rules', () => {
    expect(titles('- **Always** follow [the guide](docs/guide.md) for `api/` changes.')).toEqual([
      'Always follow the guide (docs/guide.md) for `api/` changes',
    ]);
    const long = parseInstructions(`- Use ${'very '.repeat(60)}long names.`).rules[0];
    expect(long?.title.length).toBeLessThanOrEqual(160);
    expect(long?.title.endsWith('…')).toBe(true);
    expect(long?.text).toContain('long names');
  });

  it('reads front matter scopes and manual triggers', () => {
    const scoped = parseInstructions('---\nglobs: ["src/**/*.ts"]\n---\n- Use strict null checks.');
    expect(scoped.scopePaths).toEqual(['src/**/*.ts']);
    expect(parseInstructions('---\ntrigger: manual\n---\n- Only on demand please.').manual).toBe(
      true,
    );
    expect(
      parseInstructions('---\nalwaysApply: true\n---\n- Always applied rule here.').manual,
    ).toBe(false);
    expect(
      parseInstructions('---\nglobs: ../outside/**\n---\n- Scoped outside.').scopePaths,
    ).toEqual([]);
  });

  it('dedupes by normalised title against known rules and across files', () => {
    const rule = (title: string, file: string) => ({
      file,
      line: 1,
      text: title,
      title,
      excerpt: title,
      scopePaths: [],
    });
    const { fresh, known } = dedupeRules(
      [
        rule('Use pnpm', 'CLAUDE.md'),
        rule('use PNPM.', 'AGENTS.md'),
        rule('Use tabs', 'AGENTS.md'),
      ],
      ['Use tabs!'],
    );
    expect(fresh.map((r) => r.file)).toEqual(['CLAUDE.md']);
    expect(known.map((r) => r.title)).toEqual(['use PNPM.', 'Use tabs']);
  });
});

describe('rule import', () => {
  it('imports new rules as approved user rules with file evidence, once', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    cpSync(FIXTURE, root, { recursive: true });
    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Answer in British English',
      body: 'added earlier',
      source: USER,
    });
    const archived = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Never use snapshot tests',
      body: '',
      source: USER,
    });
    mindly.memory.archive(archived.id);
    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Testing: never use snapshot tests',
      body: '',
      source: USER,
      trust: 'rejected',
    });

    const plan = mindly.rules.planImport(pid, root);
    expect(plan.fresh.map((r) => r.title)).not.toContain('Answer in British English');
    expect(plan.fresh.map((r) => r.title)).not.toContain('Testing: never use snapshot tests');
    expect(plan.known.map((r) => r.title)).toEqual([
      'Testing: never use snapshot tests',
      'Use pnpm, never npm or yarn',
      'Answer in British English',
    ]);
    const stored = mindly.rules.importRules(pid, root, plan.fresh);
    expect(stored).toHaveLength(plan.fresh.length);
    const pnpm = stored.find((m) => m.title === 'Use pnpm, never npm or yarn');
    expect(pnpm).toMatchObject({
      kind: 'rule',
      trust: 'approved',
      enforce: false,
      tags: ['imported'],
    });
    expect(pnpm?.source.type).toBe('user');
    expect(pnpm?.body).toBe('Imported from CLAUDE.md, line 14.');
    expect(mindly.store.memories.evidenceFor(pnpm!.id)[0]).toMatchObject({
      type: 'file',
      ref: 'CLAUDE.md',
      excerpt: '- Use pnpm, never npm or yarn.',
    });
    const scoped = stored.find((m) => m.title.startsWith('Use `describe`'));
    expect(scoped?.scope.paths).toEqual(['src/**/*.test.ts', 'test/**/*.ts']);

    expect(mindly.rules.planImport(pid, root).fresh).toEqual([]);

    // Editing the line out of the file marks the imported rule as possibly outdated.
    write('CLAUDE.md', '# CLAUDE.md\n\n- Prefer named exports over default exports.\n');
    selfHealingOf(mindly).sweep(pid);
    expect(mindly.store.memories.get(pnpm!.id).trust).toBe('stale');
  });

  it('honours the project ignore list', async () => {
    const { root, mindly, pid } = await featureSetup();
    cpSync(FIXTURE, root, { recursive: true });
    const plan = mindly.rules.planImport(pid, root, ['.cursor/**', '*.md']);
    const files = plan.files.map((f) => f.path);
    expect(files).not.toContain('CLAUDE.md');
    expect(files).not.toContain('.cursor/rules/testing.mdc');
    expect(files).toContain('.cursorrules');
  });
});
