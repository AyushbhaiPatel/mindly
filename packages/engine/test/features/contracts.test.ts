import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isMindlyError, type ContractKind } from '@mindly/core';
import { describe, expect, it, vi } from 'vitest';
import { checkSafePattern, commandHash, contractsOf, USER } from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { agentSource, AUTH_V1, featureSetup } from './fixtures.js';

async function withDecision() {
  const f = await featureSetup();
  const memory = f.mindly.memory.remember({
    projectId: f.pid,
    projectRoot: f.root,
    kind: 'decision',
    title: 'login returns user.role',
    body: 'The login response always carries the role.',
    source: USER,
  });
  return { ...f, memory, contracts: contractsOf(f.mindly) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isMindlyError(err) ? err.code : 'other';
  }
  return 'none';
}

describe('executable memory', () => {
  it('opens a critical conflict when a contract breaks and resolves it when fixed', async () => {
    const { root, mindly, pid, cx, write, memory, contracts } = await withDecision();
    const c = contracts.create(
      memory.id,
      'pattern_present',
      { path: './src/auth.ts', pattern: 'role:' },
      USER,
    );
    expect(c.state).toBe('passing');
    expect(c.spec.path).toBe('src/auth.ts');

    write('src/auth.ts', AUTH_V1.replace('{ role: "admin" }', '{ ok: true }'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'ok') }),
    );
    const open = mindly.store.conflicts.list(pid).filter((x) => x.kind === 'contract_broken');
    expect(open).toHaveLength(1);
    expect(open[0]!.severity).toBe('critical');
    expect(mindly.store.contracts.get(c.id).state).toBe('failing');

    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'keep going' }),
    );
    expect(res.context).toContain(
      "Decision 'login returns user.role' no longer holds: pattern not found in src/auth.ts",
    );
    expect(
      mindly.store.deliveries
        .list(pid)
        .filter((d) => d.kind === 'conflict' && d.targetSessionId === cx.id),
    ).toHaveLength(1);

    write('src/auth.ts', AUTH_V1);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'role') }),
    );
    expect(mindly.store.conflicts.get(open[0]!.id).status).toBe('resolved');
    expect(mindly.store.contracts.get(c.id).state).toBe('passing');
    const results = mindly.store.events.query(pid, { types: ['contract.result'] });
    expect(results.map((e) => e.payload['state'])).toEqual(['passing', 'failing', 'passing']);
  });

  it('evaluates every declarative kind', async () => {
    const { memory, contracts } = await withDecision();
    const cases: [ContractKind, object, string][] = [
      ['file_exists', { path: 'src/auth.ts' }, 'passing'],
      ['file_exists', { path: 'src/missing.ts' }, 'failing'],
      ['pattern_absent', { path: 'src/auth.ts', pattern: 'eval\\(' }, 'passing'],
      ['pattern_absent', { path: 'src/auth.ts', pattern: 'role' }, 'failing'],
      ['json_key', { path: 'package.json', key: 'scripts.test' }, 'passing'],
      ['json_key', { path: 'package.json', key: 'scripts.build' }, 'failing'],
      ['export_present', { path: 'src/auth.ts', symbol: 'login' }, 'passing'],
      ['export_present', { path: 'src/auth.ts', symbol: 'logout' }, 'failing'],
    ];
    for (const [kind, spec, state] of cases) {
      expect(contracts.create(memory.id, kind, spec, USER).state, `${kind}`).toBe(state);
    }
  });

  it('never runs command contracts and only lets the user create them', async () => {
    const { memory, contracts, cc } = await withDecision();
    const argv = ['pnpm', 'test'];
    const c = contracts.create(memory.id, 'command', { argv }, USER);
    expect(c.state).toBe('unknown');
    expect(c.lastMessage).toBe('command contracts run in the daemon');
    expect(c.approvedHash).toBe(commandHash(argv));
    expect(codeOf(() => contracts.create(memory.id, 'command', { argv }, agentSource(cc)))).toBe(
      'forbidden',
    );
  });

  it('rejects bad specs', async () => {
    const { root, memory, contracts } = await withDecision();
    symlinkSync('/etc', join(root, 'src', 'etc-link'));
    const bad: [ContractKind, object, string][] = [
      ['file_exists', { path: '../../etc/passwd' }, 'path_outside_project'],
      ['file_exists', { path: 'src/etc-link/passwd' }, 'path_outside_project'],
      ['file_exists', { path: '.env' }, 'forbidden'],
      ['file_exists', { path: 'deploy/id_rsa' }, 'forbidden'],
      ['file_exists', { path: '.' }, 'invalid_input'],
      ['file_exists', { path: 'src/auth.ts', extra: 1 }, 'invalid_input'],
      ['pattern_present', { path: 'src/auth.ts', pattern: '(' }, 'invalid_input'],
      ['pattern_present', { path: 'src/auth.ts', pattern: '(a+)+$' }, 'invalid_input'],
      ['pattern_present', { path: 'src/auth.ts', pattern: 'x'.repeat(301) }, 'invalid_input'],
      ['json_key', { path: 'package.json', key: 'a..b' }, 'invalid_input'],
      ['export_present', { path: 'src/auth.ts', symbol: 'a b' }, 'invalid_input'],
      ['command', { argv: [] }, 'invalid_input'],
    ];
    for (const [kind, spec, code] of bad) {
      expect(
        codeOf(() => contracts.create(memory.id, kind, spec, USER)),
        JSON.stringify(spec),
      ).toBe(code);
    }
  });
});

describe('safe regex subset', () => {
  it.each([
    'role',
    'export\\s+function\\s+login',
    '^import .* from',
    '(?:foo|bar)\\d?',
    '[a-z]+',
    '.*a.*x',
    'a?b?c?.*a.*x',
    'v\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}',
    '(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*[\'"]',
    '(TODO|FIXME|XXX|HACK|BUG|NOTE|OPTIMIZE|REVIEW|DEPRECATED)\\s*:.*',
    '^(feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert)(\\(.+\\))?: .+',
    '^\\s*(?:export\\s)?(?:const|let|var) \\w+ = require\\(',
    'https?://(?:www\\.)?(?:staging|dev)\\.[a-z]+\\.com/.*',
    '\\b(?:describe|it|test)\\.only\\(',
    '<(?<tag>script|iframe)\\b[^>]*>',
  ])('accepts %s', (p) => expect(checkSafePattern(p)).toBeNull());

  it.each([
    [
      '(api[_-]?key|secret|token|password)\\s*[:=]\\s*x',
      '(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*x',
    ],
    ['(a|ab|abc)'.repeat(3) + '.*.*x', '(?:a|ab|abc)'.repeat(3) + '.*.*x'],
    ['(?<x>a|ab|abc)(?<y>a|ab|abc)(?<z>a|ab|abc).*.*x', '(?:a|ab|abc)'.repeat(3) + '.*.*x'],
  ])('treats %s like its non-capturing form', (capturing, plain) =>
    expect(checkSafePattern(capturing)).toBe(checkSafePattern(plain)),
  );

  it.each([
    ['(a+)+', 'nested'],
    ['(a|aa)*', 'nested'],
    ['((ab)*c)+', 'nested'],
    ['(\\w+\\s?)*$', 'nested'],
    ['(a)\\1', 'backreferences'],
    ['(?=x)y', 'lookahead'],
    ['(?<!x)y', 'lookbehind'],
    ['a*b*c*d*e*', 'unbounded'],
    ['\\s*\\s*\\s*x', 'unbounded'],
    ['\\s{0,2000}\\s*\\s*x', 'unbounded'],
    ['a?a?a?a?a?a?a?a?a?aaaaaaaaa', 'quantifiers'],
    ['a?b?c?d?.*a.*x', 'backtracking'],
    ['a{0,16}a{0,16}a{0,16}a{0,16}a{0,16}a{0,16}.*.*x', 'backtracking'],
    ['(a|a)'.repeat(20) + 'x', 'backtracking'],
    ['(?:a|a)'.repeat(20) + 'x', 'backtracking'],
    ['(?:a|ab|abc)'.repeat(3) + '.*.*x', 'backtracking'],
    ['((a|b))+x', 'nested'],
    ['[', 'compile'],
  ])('rejects %s', (p, why) => expect(checkSafePattern(p)).toMatch(why));
});

describe('regex budget', () => {
  it('keeps the worst allowed pattern polynomial in the line length', () => {
    const worst = 'a?a?a?.*a.*x';
    expect(checkSafePattern(worst)).toBeNull();
    const re = new RegExp(worst);
    const fastest = (line: string): number => {
      const start = performance.now();
      re.test(line);
      return performance.now() - start;
    };
    const short = 'a'.repeat(100);
    const long = 'a'.repeat(200);
    fastest(short);
    fastest(long);
    let shortMs = Infinity;
    let longMs = Infinity;
    for (let i = 0; i < 7; i++) {
      shortMs = Math.min(shortMs, fastest(short));
      longMs = Math.min(longMs, fastest(long));
    }
    // Doubling the line costs about 8x for a cubic matcher; exponential backtracking would be
    // billions of times slower. The ratio is load-independent, unlike an absolute budget.
    expect(longMs / Math.max(shortMs, 0.01)).toBeLessThan(32);
  });

  it('explains why an existing contract with a now-rejected pattern cannot run', async () => {
    const { root, memory, contracts } = await withDecision();
    const spec = { path: 'src/auth.ts', pattern: 'role' };
    const c = contracts.create(memory.id, 'pattern_absent', spec, USER);
    const pattern = '(a|a)'.repeat(20) + 'x';
    const result = contracts.evaluate({ ...c, spec: { ...spec, pattern } }, root);
    expect(result.state).toBe('error');
    expect(result.message).toContain(
      `pattern rejected as too expensive to evaluate safely: ${pattern} (pattern allows too much backtracking`,
    );
    expect(result.message).toContain('add a contract with a simpler pattern');
  });

  it('stops evaluating once the time budget is spent', async () => {
    const { memory, contracts } = await withDecision();
    const spec = { path: 'src/auth.ts', pattern: 'never-present' };
    expect(contracts.create(memory.id, 'pattern_absent', spec, USER).state).toBe('passing');
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 60));
    try {
      expect(contracts.create(memory.id, 'pattern_absent', spec, USER).state).toBe('error');
    } finally {
      clock.mockRestore();
    }
  });
});
