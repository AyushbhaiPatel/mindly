import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isMindlyError, type ContractKind } from '@mindly/core';
import { describe, expect, it } from 'vitest';
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
  it.each(['role', 'export\\s+function\\s+login', '^import .* from', '(?:foo|bar)\\d?', '[a-z]+'])(
    'accepts %s',
    (p) => expect(checkSafePattern(p)).toBeNull(),
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
    ['[', 'compile'],
  ])('rejects %s', (p, why) => expect(checkSafePattern(p)).toMatch(why));
});
