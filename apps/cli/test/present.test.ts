import { describe, expect, it } from 'vitest';
import { REPO_FILE_SOURCE } from '@mindly/core';
import {
  agentName,
  argvWords,
  conflictStatusWord,
  contractWords,
  handoffStatusWord,
  humanizeText,
  memoryKindWord,
  relativeTime,
  screenFor,
  sessionName,
  sessionStatusWord,
  severityWord,
  sourceWord,
  symbolsFor,
  trustWord,
  useAscii,
  visibleLength,
  widthFor,
  wrap,
} from '../src/present/index.js';

const NOW = new Date(2026, 10, 4, 15, 30, 0).getTime();
const MIN = 60_000;

describe('relative time', () => {
  it('reads like a person would say it', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 2 * MIN, NOW)).toBe('2m ago');
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe('3h ago');
    expect(relativeTime(new Date(2026, 10, 3, 14, 5).getTime(), NOW)).toBe('yesterday 14:05');
    expect(relativeTime(new Date(2026, 10, 1, 9, 0).getTime(), NOW)).toBe('3d ago');
    expect(relativeTime(new Date(2026, 9, 1, 9, 0).getTime(), NOW)).toBe('2026-10-01');
    expect(relativeTime(null, NOW)).toBe('never');
  });
});

describe('symbols and width', () => {
  it('falls back to ASCII without a UTF-8 locale or with MINDLY_ASCII=1', () => {
    expect(useAscii({ LANG: 'en_US.UTF-8' })).toBe(false);
    expect(useAscii({ LC_ALL: 'C.utf8', LANG: 'C' })).toBe(false);
    expect(useAscii({ LANG: 'C' })).toBe(true);
    expect(useAscii({ LC_ALL: 'POSIX', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(useAscii({ LANG: 'en_US.UTF-8', MINDLY_ASCII: '1' })).toBe(true);
    expect(symbolsFor({ LANG: 'C' })).toMatchObject({ ok: '[ok]', warn: '[!]', fail: '[x]' });
    expect(symbolsFor({ LANG: 'C' })).toMatchObject({ item: '-', next: '->' });
    expect(symbolsFor({ LANG: 'en_US.UTF-8' })).toMatchObject({
      ok: '\u2713',
      warn: '!',
      fail: '\u2717',
      item: '\u2022',
      next: '\u2192',
    });
  });

  it('wraps at COLUMNS, the terminal width, or 100', () => {
    const out = (isTTY: boolean, columns?: number) => ({
      write: () => undefined,
      isTTY,
      ...(columns !== undefined ? { columns } : {}),
    });
    expect(widthFor(out(false), {})).toBe(100);
    expect(widthFor(out(true, 80), {})).toBe(80);
    expect(widthFor(out(false, 80), {})).toBe(100);
    expect(widthFor(out(true, 80), { COLUMNS: '120' })).toBe(120);
    expect(widthFor(out(true, 10), {})).toBe(40);
  });

  it('wraps words with a hanging indent and never cuts long words', () => {
    expect(wrap('one two three four', 10, '- ', '  ')).toEqual(['- one two', '  three', '  four']);
    const path = 'src/a/very/long/path/that/does/not/fit.ts';
    expect(wrap(`see ${path} now`, 20)).toEqual(['see', path, 'now']);
    expect(visibleLength('\u001b[32mok\u001b[39m')).toBe(2);
  });
});

describe('vocabulary', () => {
  it('names agents and sessions by product name and short id', () => {
    expect(agentName('claude-code')).toBe('Claude Code');
    expect(agentName('gemini')).toBe('Gemini CLI');
    expect(agentName('augment')).toBe('Augment');
    expect(agentName('my-agent')).toBe('my-agent');
    const id = '01a1a6ed-ddf5-7ae7-8e36-9ff94409d433';
    expect(sessionName({ id, agentKind: 'claude-code', label: null })).toBe(
      'Claude Code \u00B7 4409d433',
    );
    expect(sessionName({ id, agentKind: 'codex', label: 'auth' })).toBe(
      'Codex "auth" \u00B7 4409d433',
    );
  });

  it('rewrites engine labels inside stored text', () => {
    expect(humanizeText('claude-code #6518e3b9 changed the exports of src/auth.ts')).toBe(
      'Claude Code \u00B7 6518e3b9 changed the exports of src/auth.ts',
    );
    expect(humanizeText('Stated by the user in a codex session')).toBe(
      'Stated by the user in a Codex session',
    );
    expect(humanizeText('see src/codex session.ts and claude-code-tools')).toBe(
      'see src/codex session.ts and claude-code-tools',
    );
  });

  it('translates every internal value', () => {
    expect(sessionStatusWord('active')).toBe('working');
    expect(sessionStatusWord('rate_limited')).toBe('hit its usage limit');
    expect(sessionStatusWord('ended')).toBe('finished');
    expect(severityWord('info')).toBe('FYI');
    expect(severityWord('warning')).toBe('check this');
    expect(severityWord('critical')).toBe('urgent');
    expect(conflictStatusWord('acknowledged')).toBe('seen');
    expect(trustWord('approved')).toBe('approved by you');
    expect(trustWord('verified')).toBe('confirmed in the code');
    expect(trustWord('stale')).toBe('may be outdated (code changed)');
    expect(trustWord('proposed', { type: 'agent', sessionId: null, agentKind: 'codex' })).toBe(
      'suggested by Codex, waiting for you',
    );
    expect(trustWord('proposed', { type: 'user', sessionId: null, agentKind: 'claude-code' })).toBe(
      'you said it in Claude Code, waiting for you',
    );
    expect(trustWord('proposed', REPO_FILE_SOURCE)).toBe(
      'imported from a repository file, waiting for you',
    );
    expect(sourceWord(REPO_FILE_SOURCE)).toBe('a repository file');
    expect(memoryKindWord('mistake')).toBe('known pitfall');
    expect(handoffStatusWord('pending', 'cursor')).toBe('waiting for Cursor');
    expect(handoffStatusWord('pending', null)).toBe('waiting for any agent');
    expect(handoffStatusWord('claimed', 'codex')).toBe('picked up by Codex');
    expect(contractWords('export_present', { path: 'src/a.ts', symbol: 'login' })).toBe(
      'src/a.ts exports login',
    );
    expect(argvWords(['pnpm', 'run', 'test:unit', 'a b'])).toBe('pnpm run test:unit "a b"');
  });
});

describe('screen', () => {
  function capture(env: NodeJS.ProcessEnv, isTTY = false) {
    const lines: string[] = [];
    const sc = screenFor((l) => lines.push(l), { write: () => undefined, isTTY }, env, NOW);
    return { sc, lines };
  }

  it('aligns ids and next steps', () => {
    const { sc, lines } = capture({ LANG: 'en_US.UTF-8' });
    sc.rows([
      { marker: 'warn', text: 'Short', id: '01a1a6ed-ddf5-7ae7-8e36-9ff96518e3b9' },
      { marker: 'ok', text: 'A bit longer text', id: '01a1a6ed-ddf5-7ae7-8e36-9ff9aaaaaaaa' },
    ]);
    sc.next([
      { cmd: 'mindly a', why: 'first' },
      { cmd: 'mindly longer', why: 'second' },
    ]);
    expect(lines).toEqual([
      '  ! Short              [6518e3b9]',
      '  \u2713 A bit longer text  [aaaaaaaa]',
      '',
      '\u2192 mindly a        first',
      '\u2192 mindly longer   second',
    ]);
  });

  it('colours only on a TTY without NO_COLOR, with the same text', () => {
    const plain = capture({ LANG: 'C' }, true);
    plain.sc.rows([{ marker: 'fail', text: 'Broken' }]);
    expect(plain.lines[0]).toBe('  \u001b[31m[x]\u001b[39m Broken');
    const noColor = capture({ LANG: 'C', NO_COLOR: '1' }, true);
    noColor.sc.rows([{ marker: 'fail', text: 'Broken' }]);
    expect(noColor.lines[0]).toBe('  [x] Broken');
  });
});
