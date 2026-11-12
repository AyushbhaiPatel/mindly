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

  it('checks a line past its 200th character', async () => {
    const { write, memory, contracts } = await withDecision();
    const pad = 'const data = [' + '"aaaaaaaa", '.repeat(30);
    write('src/long.ts', `${pad}eval("x")];\n`);
    write(
      'data.json',
      `{"pad":"${'x'.repeat(5000)}","apiVersion":"v2","tail":"${'y'.repeat(900)}"}`,
    );
    const cases: [ContractKind, object, string][] = [
      ['pattern_absent', { path: 'src/long.ts', pattern: 'eval\\(' }, 'failing'],
      ['pattern_present', { path: 'data.json', pattern: '"apiVersion":"v2"' }, 'passing'],
      ['pattern_present', { path: 'data.json', pattern: '"apiVersion":"v3"' }, 'failing'],
      ['pattern_present', { path: 'data.json', pattern: '^\\{"pad"' }, 'passing'],
      ['pattern_present', { path: 'data.json', pattern: 'y"\\}$' }, 'passing'],
    ];
    for (const [kind, spec, state] of cases) {
      expect(contracts.create(memory.id, kind, spec, USER).state, JSON.stringify(spec)).toBe(state);
    }
  });

  it('keeps anchors and word boundaries exact inside a long line', async () => {
    const { write, memory, contracts } = await withDecision();
    // Windows of a long line start every 100 characters and are 200 long: put text on those edges.
    const line =
      '-'.repeat(100) + 'import x' + '-'.repeat(89) + 'foobar' + '-'.repeat(97) + 'import y;';
    expect(line.indexOf('foobar')).toBe(197);
    write('src/edges.ts', `${line}\n`);
    const cases: [string, string][] = [
      ['^import', 'failing'],
      ['\\bfoo\\b', 'failing'],
      ['foo$', 'failing'],
      ['\\bfoobar\\b', 'passing'],
      ['import y;$', 'passing'],
      ['^-+import x', 'passing'],
    ];
    for (const [pattern, state] of cases) {
      const spec = { path: 'src/edges.ts', pattern };
      expect(contracts.create(memory.id, 'pattern_present', spec, USER).state, pattern).toBe(state);
    }
  });

  it('matches line anchors in a file with CRLF line endings', async () => {
    const { write, memory, contracts } = await withDecision();
    write('src/crlf.ts', 'export const a = 1;\r\nexport const b = 2;\r\n');
    const spec = { path: 'src/crlf.ts', pattern: '^export const a = 1;$' };
    expect(contracts.create(memory.id, 'pattern_present', spec, USER).state).toBe('passing');
    const absent = { path: 'src/crlf.ts', pattern: '^export const c = 3;$' };
    expect(contracts.create(memory.id, 'pattern_absent', absent, USER).state).toBe('passing');
  });

  it('reads JSON with comments and trailing commas', async () => {
    const { write, memory, contracts } = await withDecision();
    write(
      'tsconfig.json',
      [
        '﻿// Shared compiler options.',
        '{',
        '  "compilerOptions": {',
        '    /* keep strict on */ "strict": true,',
        '    "types": ["node", ], // trailing comma',
        '    "note": "not a // comment, and not a trailing comma: ,}",',
        '  },',
        '}',
      ].join('\n'),
    );
    write('broken.json', '{ "a": 1,, }');
    const cases: [object, string, string][] = [
      [{ path: 'tsconfig.json', key: 'compilerOptions.strict' }, 'passing', 'present'],
      [{ path: 'tsconfig.json', key: 'compilerOptions.types' }, 'passing', 'present'],
      [{ path: 'tsconfig.json', key: 'compilerOptions.note' }, 'passing', 'present'],
      [{ path: 'tsconfig.json', key: 'compilerOptions.noEmit' }, 'failing', 'missing'],
      [{ path: 'broken.json', key: 'a' }, 'failing', 'not valid JSON'],
    ];
    for (const [spec, state, message] of cases) {
      const c = contracts.create(memory.id, 'json_key', spec, USER);
      expect(c.state, JSON.stringify(spec)).toBe(state);
      expect(c.lastMessage).toContain(message);
    }
  });

  it('judges a result after an inconclusive one against the last pass or fail', async () => {
    const { root, mindly, pid, cc, cx, write, memory, contracts } = await withDecision();
    const broken = () =>
      mindly.store.conflicts
        .list(pid, { statuses: ['open', 'acknowledged'] })
        .filter((x) => x.kind === 'contract_broken');
    const spec = { path: 'src/auth.ts', pattern: 'role:' };
    const c = contracts.create(memory.id, 'pattern_present', spec, USER);
    const step = (content: string) => {
      write('src/auth.ts', content);
      return contracts.run(mindly.store.contracts.get(c.id), root, cc).state;
    };
    const tooLarge = `// ${'x'.repeat(600 * 1024)}\n`;

    // Passing, then unreadable, then failing: the break is reported once it shows.
    expect(step(tooLarge)).toBe('error');
    expect(broken()).toHaveLength(0);
    expect(step('export const nothing = 1;\n')).toBe('failing');
    expect(broken()).toHaveLength(1);
    expect(
      mindly.store.deliveries
        .list(pid)
        .filter((d) => d.kind === 'conflict' && d.targetSessionId === cx.id),
    ).toHaveLength(1);

    // Failing, then unreadable, then passing: the conflict is closed.
    expect(step(tooLarge)).toBe('error');
    expect(broken()).toHaveLength(1);
    expect(step(AUTH_V1)).toBe('passing');
    expect(broken()).toHaveLength(0);

    // A contract that never passed is not a break when it fails again after an error.
    const never = contracts.create(
      memory.id,
      'pattern_present',
      { path: 'src/auth.ts', pattern: 'never-there' },
      USER,
    );
    expect(never.state).toBe('failing');
    write('src/auth.ts', tooLarge);
    expect(contracts.run(mindly.store.contracts.get(never.id), root, cc).state).toBe('error');
    write('src/auth.ts', AUTH_V1);
    expect(contracts.run(mindly.store.contracts.get(never.id), root, cc).state).toBe('failing');
    expect(broken()).toHaveLength(0);
  });

  it('remembers the last pass however many results other contracts record after it', async () => {
    const { root, mindly, pid, cc, write, memory, contracts } = await withDecision();
    const spec = { path: 'src/auth.ts', pattern: 'role:' };
    const c = contracts.create(memory.id, 'pattern_present', spec, USER);
    expect(c.state).toBe('passing');
    write('src/auth.ts', `// ${'x'.repeat(600 * 1024)}\n`);
    expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('error');
    for (let i = 0; i < 2500; i++) {
      mindly.store.events.append({
        projectId: pid,
        sessionId: null,
        type: 'contract.result',
        payload: { contractId: `other-${i % 40}`, state: 'passing', previous: 'passing' },
      });
    }
    const query = vi.spyOn(mindly.store.events, 'query');
    write('src/auth.ts', 'export const nothing = 1;\n');
    expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('failing');
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    expect(
      mindly.store.conflicts.list(pid).filter((x) => x.kind === 'contract_broken'),
    ).toHaveLength(1);
  });

  it('keeps the last pass of a contract that had nothing remembered yet', async () => {
    const { root, mindly, pid, cc, write, memory, contracts } = await withDecision();
    const spec = { path: 'src/auth.ts', pattern: 'role:' };
    const c = contracts.create(memory.id, 'pattern_present', spec, USER);
    expect(c.state).toBe('passing');
    // A contract as it was stored before its last pass or fail was kept apart from its state.
    mindly.store.db.prepare("DELETE FROM kv WHERE key LIKE 'contract:conclusive:%'").run();
    expect(mindly.store.contracts.lastConclusive(c.id)).toBeUndefined();

    write('src/auth.ts', `// ${'x'.repeat(600 * 1024)}\n`);
    expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('error');
    expect(mindly.store.contracts.lastConclusive(c.id)).toBe('passing');
    for (let i = 0; i < 2500; i++) {
      mindly.store.events.append({
        projectId: pid,
        sessionId: null,
        type: 'contract.result',
        payload: { contractId: `other-${i % 40}`, state: 'passing', previous: 'passing' },
      });
    }
    write('src/auth.ts', 'export const nothing = 1;\n');
    expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('failing');
    expect(
      mindly.store.conflicts.list(pid).filter((x) => x.kind === 'contract_broken'),
    ).toHaveLength(1);
  });

  it.each(['none', 'failing'] as const)(
    'trusts a passing state over an older remembered "%s"',
    async (stale) => {
      const { root, mindly, pid, cc, write, memory, contracts } = await withDecision();
      const spec = { path: 'src/auth.ts', pattern: 'role:' };
      const c = contracts.create(memory.id, 'pattern_present', spec, USER);
      // The state as a process of a previous version leaves it: updated on its own.
      mindly.store.contracts.setLastConclusive(c.id, stale);
      mindly.store.db.prepare("UPDATE contracts SET state = 'passing' WHERE id = ?").run(c.id);

      write('src/auth.ts', `// ${'x'.repeat(600 * 1024)}\n`);
      expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('error');
      expect(mindly.store.contracts.lastConclusive(c.id)).toBe('passing');
      write('src/auth.ts', 'export const nothing = 1;\n');
      expect(contracts.run(mindly.store.contracts.get(c.id), root, cc).state).toBe('failing');
      expect(
        mindly.store.conflicts.list(pid).filter((x) => x.kind === 'contract_broken'),
      ).toHaveLength(1);
    },
  );

  it('remembers nothing for a contract that is gone when its result arrives', async () => {
    const { mindly, memory, contracts } = await withDecision();
    const c = contracts.create(memory.id, 'file_exists', { path: 'src/auth.ts' }, USER);
    mindly.store.db.prepare('DELETE FROM contracts WHERE id = ?').run(c.id);
    mindly.store.contracts.pruneConclusive();
    for (const state of ['passing', 'error'] as const) {
      expect(codeOf(() => mindly.store.contracts.recordResult(c.id, state, null))).toBe(
        'not_found',
      );
      expect(mindly.store.contracts.lastConclusive(c.id)).toBeUndefined();
    }
  });

  it('reads the event log at most once for a contract that never passed or failed', async () => {
    const { mindly, memory, contracts } = await withDecision();
    const c = contracts.create(memory.id, 'command', { argv: ['pnpm', 'test'] }, USER);
    expect(mindly.store.contracts.lastConclusive(c.id)).toBeUndefined();
    const query = vi.spyOn(mindly.store.events, 'query');
    const timeout = { state: 'error' as const, message: 'command timeout' };
    for (let i = 0; i < 5; i++) {
      expect(contracts.record(mindly.store.contracts.get(c.id), timeout, null).broke).toBe(false);
    }
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(mindly.store.contracts.lastConclusive(c.id)).toBe('none');

    // What is remembered goes with the contract.
    const other = contracts.create(memory.id, 'file_exists', { path: 'src/auth.ts' }, USER);
    expect(mindly.store.contracts.lastConclusive(other.id)).toBe('passing');
    mindly.store.contracts.delete(other.id);
    expect(mindly.store.contracts.lastConclusive(other.id)).toBeUndefined();
    mindly.store.db.prepare('DELETE FROM contracts WHERE id = ?').run(c.id);
    mindly.store.contracts.pruneConclusive();
    expect(mindly.store.contracts.lastConclusive(c.id)).toBeUndefined();
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
    'a?b?c?x.*a.*x',
    'v\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}',
    '(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*[\'"]',
    '(TODO|FIXME|XXX|HACK|BUG|NOTE|OPTIMIZE|REVIEW|DEPRECATED)\\s*:.*',
    '^(feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert)(\\(.+\\))?: .+',
    '^\\s*(?:export\\s)?(?:const|let|var) \\w+ = require\\(',
    'https?://(?:www\\.)?(?:staging|dev)\\.[a-z]+\\.com/.*',
    '\\b(?:describe|it|test)\\.only\\(',
    '<(?<tag>script|iframe)\\b[^>]*>',
    '(?:ab){3}',
    '(\\d{2}-){2}\\d{4}',
    '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}',
    '\\w+\\s+=',
    '\\d{2}\\d?',
    '^\\s*(?:export\\s)?function',
    'assert\\s*\\(?isinstance',
    'if\\s+\\(?item\\s*=',
    '\\xg?y+',
    '\\c?d+',
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
    ['(a+){16}b', 'nested'],
    ['(a+){12}b', 'nested'],
    ['(\\w+\\s?){12}=', 'nested'],
    ['(a|aa){16}b', 'nested'],
    ['(a*){2}b', 'nested'],
    ['(a?a?)+c', 'nested'],
    ['(a?a?){16}c', 'nested'],
    ['(a?b){3}', 'nested'],
    ['(a?){16}a{16}b', 'nested'],
    ['(a?){16}a?a?a{16}b', 'nested'],
    ['(?:a?){16}a{16}b', 'nested'],
    ['(a{0,16}){4}b', 'nested'],
    ['(?:)+x', 'at least one character'],
    ['(?:^)*x', 'at least one character'],
    ['a?a?a{16}b', 'same characters'],
    ['a*a*b', 'same characters'],
    ['.*\\s*x', 'same characters'],
    ['\\d?\\d{2}', 'same characters'],
    ['a?b?c?.*a.*x', 'same characters'],
    ['a+(?:[ab]*[ab])x', 'same characters'],
    ['[a-f]?[^g]+x', 'same characters'],
    ['[', 'compile'],
    ['\\(?ia?a?a+', 'same characters'],
    ['[^](a+)+x', 'nested'],
    ['(?:a+|\\xg)+b', 'nested'],
    ['(?:a+|\\ug)+b', 'nested'],
    ['(?:a+|\\c1)+b', 'nested'],
    ['(?:a+|\\0)+b', 'nested'],
    // `\x` and `\u` without their digits are a plain `x` and `u`.
    ['\\x?x+=', 'same characters'],
    ['\\u?u+=', 'same characters'],
    ['[](a|aa)*x', 'nested'],
    ['x[^]*\\s*y', 'same characters'],
  ])('rejects %s', (p, why) => expect(checkSafePattern(p)).toMatch(why));
});

describe('overlap of character classes', () => {
  const atoms = [
    'a',
    'z',
    '-',
    ']',
    '.',
    '\\d',
    '\\D',
    '\\w',
    '\\W',
    '\\s',
    '\\S',
    '\\n',
    '\\t',
    '\\x41',
    '\\u0430',
    '\\.',
    '[a-f]',
    '[g-z]',
    '[^g]',
    '[^\\w]',
    '[\\s\\d]',
    '[^\\S]',
    '[a\\-z]',
    '[-a]',
    '[\\b]',
    '[\\x41-\\x43]',
    '[\\u0400-\\u04ff]',
    '[^\\n]',
    '[^]',
    '[.]',
    '[\\]]',
    '[A-Z_]',
  ];
  it('agrees with every code unit for each pair of atoms', () => {
    const sets = atoms.map((atom) => {
      const re = new RegExp(`^(?:${atom})$`);
      const bits = new Uint8Array(0x10000);
      for (let c = 0; c <= 0xffff; c++) bits[c] = re.test(String.fromCharCode(c)) ? 1 : 0;
      return bits;
    });
    const wrong: string[] = [];
    atoms.forEach((x, i) =>
      atoms.forEach((y, j) => {
        // `x?y+=`: refused exactly when x and y share a character (`=` is in neither... or both,
        // which does not matter: only x then y is judged).
        const pattern = `${x}?${y}+=`;
        const verdict = checkSafePattern(pattern);
        const shared = sets[i]!.some((bit, c) => bit === 1 && sets[j]![c] === 1);
        const refused = verdict !== null && verdict.includes('same characters');
        if (shared !== refused) wrong.push(`${pattern}: shared ${shared}, verdict ${verdict}`);
      }),
    );
    expect(wrong).toEqual([]);
  });
});

describe('inline modifiers', () => {
  let modifiers = true;
  try {
    new RegExp('(?i:a)');
  } catch {
    modifiers = false;
  }

  it
    .runIf(modifiers)
    .each([
      '(?i:select)\\s+\\w+',
      '(?i:const)\\s+[A-Z_]+ =',
      '(?i:todo)\\s*\\d+',
      '(?-i:x)?[ab]+=',
      '(?i:[^a])?A+=',
    ])('accepts %s', (p) => expect(checkSafePattern(p)).toBeNull());

  it.runIf(modifiers).each([
    ['(?i:a)?A+=', 'same characters'],
    ['(?i:[a-f])?[D-Z]+=', 'same characters'],
    ['(?s:.)?\\n+=', 'same characters'],
    ['(?i:\\u00e9)?\\u00c9+=', 'same characters'],
  ])('refuses %s', (p, why) => expect(checkSafePattern(p)).toMatch(why));

  it.runIf(modifiers)('agrees with case-insensitive matching for each pair of atoms', () => {
    const atoms = [
      'a',
      'A',
      'k',
      '\\u212a',
      's',
      '\\u017f',
      '\\u00e9',
      '\\u00c9',
      '[a-f]',
      '[G-Z]',
      '\\w',
      '\\W',
      '[^a]',
      'ß',
    ];
    const sets = atoms.map((atom) => {
      const re = new RegExp(`^(?:${atom})$`, 'i');
      const bits = new Uint8Array(0x10000);
      for (let c = 0; c <= 0xffff; c++) bits[c] = re.test(String.fromCharCode(c)) ? 1 : 0;
      return bits;
    });
    const wrong: string[] = [];
    atoms.forEach((x, i) =>
      atoms.forEach((y, j) => {
        const pattern = `(?i:${x})?(?i:${y})+=`;
        const verdict = checkSafePattern(pattern);
        const shared = sets[i]!.some((bit, c) => bit === 1 && sets[j]![c] === 1);
        const refused = verdict !== null && verdict.includes('same characters');
        if (shared !== refused) wrong.push(`${pattern}: shared ${shared}, verdict ${verdict}`);
      }),
    );
    expect(wrong).toEqual([]);
  });
});

describe('regex budget', () => {
  it('keeps the worst allowed pattern polynomial in the line length', () => {
    const worst = '.*a.*x';
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

  it.each([
    '(a?){16}a{16}b',
    '(a?){16}a?a?a{16}b',
    '(a+)+b',
    '(a|a)*b',
    '(a|aa)+b',
    '(\\w+\\s?)*$',
    '(a+){12}b',
    'a*a*b',
    '.*a.*b',
  ])('%s is refused, or one evaluation on hostile input stays quick', async (pattern) => {
    const { write, memory, contracts } = await withDecision();
    write('src/data.txt', `${'a'.repeat(200)}\n${'a '.repeat(100)}\n`);
    const spec = { path: 'src/data.txt', pattern };
    if (checkSafePattern(pattern) !== null) {
      expect(codeOf(() => contracts.create(memory.id, 'pattern_absent', spec, USER))).toBe(
        'invalid_input',
      );
      return;
    }
    const start = performance.now();
    contracts.create(memory.id, 'pattern_absent', spec, USER);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('skips a pattern that ran out of time only until the file changes', async () => {
    const { mindly, root, write, memory, contracts } = await withDecision();
    write('src/min.js', 'a'.repeat(400 * 1024));
    const spec = { path: 'src/min.js', pattern: '.*a.*x' };
    let start = performance.now();
    const c = contracts.create(memory.id, 'pattern_absent', spec, USER);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(c.state).toBe('error');
    expect(c.lastMessage).toBe(
      'pattern took longer than 100 ms on src/min.js; it runs again when the file changes',
    );
    // The same content is not checked again.
    start = performance.now();
    expect(contracts.evaluate(mindly.store.contracts.get(c.id), root).message).toBe(c.lastMessage);
    expect(performance.now() - start).toBeLessThan(20);
    // Changed content is.
    write('src/min.js', 'const a = 1;\n');
    expect(contracts.evaluate(mindly.store.contracts.get(c.id), root).state).toBe('passing');
    write('src/min.js', 'const ax = 1;\n');
    expect(contracts.evaluate(mindly.store.contracts.get(c.id), root).state).toBe('failing');
    // What is remembered goes with the contract.
    mindly.store.contracts.delete(c.id);
    expect(mindly.store.contracts.slowRun(c.id)).toBeNull();
  });

  it('a slow file does not switch a contract off: the next break is still reported', async () => {
    const { root, mindly, pid, write, memory, contracts } = await withDecision();
    write('src/fmt.ts', 'export const b = 1;\n');
    // Cubic per window: hundreds of millions of steps over this file, on any machine.
    const spec = { path: 'src/fmt.ts', pattern: '.*a.*x' };
    const c = contracts.create(memory.id, 'pattern_absent', spec, USER);
    expect(c.state).toBe('passing');

    write('src/fmt.ts', 'a'.repeat(400 * 1024));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/fmt.ts', 'a') }),
    );
    expect(mindly.store.contracts.get(c.id).state).toBe('error');

    write('src/fmt.ts', 'export const a = x;\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/fmt.ts', 'x') }),
    );
    expect(mindly.store.contracts.get(c.id).state).toBe('failing');
    expect(
      mindly.store.conflicts.list(pid).filter((x) => x.kind === 'contract_broken'),
    ).toHaveLength(1);
  });

  it('keeps verdicts only for patterns stored contracts use', async () => {
    const { mindly, memory, contracts } = await withDecision();
    const verdicts = () =>
      (
        mindly.store.db
          .prepare("SELECT key FROM kv WHERE key LIKE 'contract:pattern-verdict:%'")
          .all() as { key: string }[]
      ).map((r) => r.key);
    mindly.store.kv.set('contract:pattern-verdict:2:old', { verdict: null });
    const a = contracts.create(
      memory.id,
      'pattern_absent',
      { path: 'src/auth.ts', pattern: 'aaa' },
      USER,
    );
    contracts.create(memory.id, 'pattern_absent', { path: 'src/auth.ts', pattern: 'bbb' }, USER);
    expect(verdicts()).toHaveLength(2);
    expect(verdicts().every((k) => k.includes(process.versions.v8))).toBe(true);
    mindly.store.contracts.delete(a.id);
    contracts.create(memory.id, 'file_exists', { path: 'src/auth.ts' }, USER);
    expect(verdicts()).toHaveLength(1);
  });

  it('judges a stored pattern once, not in every hook', async () => {
    const { root, mindly, write, memory } = await withDecision();
    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFG';
    const g1 = '(?:' + [...letters].map((ch) => `[${ch}]`).join('|') + ')?';
    const g2 = '(?:' + [...'0123456789!#%&,;<=>@~`_":'].map((ch) => `[${ch}]`).join('|') + ')?';
    const pattern = `${g1}${g2}x`;
    expect(pattern.length).toBeLessThanOrEqual(300);
    // Judging even this many classes is quick.
    let start = performance.now();
    expect(checkSafePattern(pattern)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
    // Stored the way an earlier process would have, so nothing is kept for it yet.
    const c = mindly.store.contracts.create({
      projectId: memory.projectId,
      memoryId: memory.id,
      kind: 'pattern_absent',
      spec: { path: 'src/auth.ts', pattern },
      approvedHash: null,
    });
    const verdicts = () =>
      mindly.store.db
        .prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'contract:pattern-verdict:%'")
        .get() as { n: number };
    expect(verdicts().n).toBe(0);
    write('src/auth.ts', 'y\n');
    start = performance.now();
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'y') }),
    );
    expect(performance.now() - start).toBeLessThan(200);
    expect(verdicts().n).toBe(1);
    expect(mindly.store.contracts.get(c.id).state).toBe('passing');
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
});
