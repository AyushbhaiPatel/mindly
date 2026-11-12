import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookAncestryKey, type NormalizedHookEvent } from '@mindly/core';
import { rememberClient } from '../src/hook.js';
import { cli, fixture, sandbox, type Sandbox } from './helpers.js';

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

/**
 * Stands in for an agent window: one process that runs a SessionStart hook as its child, then
 * starts its MCP server as its child on its own stdin and stdout, the way a client does.
 */
const WINDOW = `
const { execFileSync, spawn } = require('node:child_process');
const [main, payload] = process.argv.slice(1);
execFileSync(process.execPath, [main, 'hook', 'claude-code', 'SessionStart'], {
  input: payload,
  stdio: ['pipe', 'ignore', 'ignore'],
});
const server = spawn(process.execPath, [main, 'mcp', '--agent', 'claude-code'], { stdio: 'inherit' });
server.on('exit', (code) => process.exit(code ?? 0));
`;

interface Server {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Wires a spawned server (or window) up as a client would and completes the handshake. */
async function connect(child: ChildProcessWithoutNullStreams): Promise<Server> {
  let err = '';
  let buf = '';
  let next = 0;
  const waiting = new Map<number, (message: unknown) => void>();
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child,
    stderr: () => err,
    exited,
    call: (name, args) => request('tools/call', { name, arguments: args }),
  };
}

/** Starts `mindly mcp` directly. */
function start(sb: Sandbox, agent: string): Promise<Server> {
  return connect(
    spawn(process.execPath, [BUILT_MAIN, 'mcp', '--agent', agent], { cwd: sb.repo, env: sb.env }),
  );
}

/** Opens a window whose hook session has the given id. */
function openWindow(sb: Sandbox, sessionId: string): Promise<Server> {
  const payload = JSON.stringify({
    ...fixture('claude-code.SessionStart'),
    cwd: sb.repo,
    session_id: sessionId,
  });
  return connect(
    spawn(process.execPath, ['-e', WINDOW, BUILT_MAIN, payload], { cwd: sb.repo, env: sb.env }),
  );
}

function sessionOf(answer: unknown): string {
  const result = (answer as { result: { structuredContent: { sessionId: string } } }).result;
  return result.structuredContent.sessionId;
}

async function liveAgents(sb: Sandbox): Promise<string> {
  return (await cli(sb, ['status'])).stdout;
}

describe.skipIf(!existsSync(BUILT_MAIN))('mindly mcp process', () => {
  it('leaves no live agent behind when the client closes stdin or signals it', async () => {
    const sb = sandbox();
    for (const how of ['stdin', 'SIGTERM'] as const) {
      const server = await start(sb, 'cursor');
      await server.call('mindly_declare_intent', { summary: 'edit', files: ['README.md'] });
      expect(await liveAgents(sb)).toContain('Cursor');
      if (how === 'stdin') server.child.stdin.end();
      else server.child.kill(how);
      expect((await server.exited).code).toBe(0);
      expect(server.stderr()).toBe('');
      expect(await liveAgents(sb)).toContain('No agent is working');
    }
  });

  it('shuts down cleanly when the client stops reading', async () => {
    const sb = sandbox();
    const server = await start(sb, 'cursor');
    await server.call('mindly_status', {});
    // The next answer cannot be written: that used to end the process on an unhandled error.
    server.child.stdout.destroy();
    void server.call('mindly_status', {});
    void server.call('mindly_status', {});
    expect((await server.exited).code).toBe(0);
    expect(server.stderr()).toBe('');
    expect(await liveAgents(sb)).toContain('No agent is working');
  });

  it('exits quietly when it is stopped while it is still starting', async () => {
    const sb = sandbox();
    // Signalled at several moments of the start-up: never "killed by signal", never an error.
    for (const delay of [15, 40, 80]) {
      const child = spawn(process.execPath, [BUILT_MAIN, 'mcp', '--agent', 'cursor'], {
        cwd: sb.repo,
        env: sb.env,
      });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.on('exit', (code, signal) => resolve({ code, signal })),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      child.kill('SIGTERM');
      const end = await exited;
      // The very first milliseconds belong to the runtime, before any of our code has run.
      if (end.signal === null) expect(end.code).toBe(0);
      expect(err).toBe('');
    }
    expect(await liveAgents(sb)).toContain('No agent is working');
  });

  it.skipIf(process.platform === 'win32')(
    'gives each of two windows in one checkout its own session',
    async () => {
      const sb = sandbox();
      const idA = 'aaaaaaaa-19fa-41d2-8238-13269b9b3ca0';
      const idB = 'bbbbbbbb-19fa-41d2-8238-13269b9b3ca0';
      const a = await openWindow(sb, idA);
      // Window B opens later, so its session is the most recently active one when window A's
      // server makes its first call.
      const b = await openWindow(sb, idB);
      const sessionA = sessionOf(await a.call('mindly_status', {}));
      const sessionB = sessionOf(await b.call('mindly_status', {}));

      const data = JSON.parse((await cli(sb, ['export'])).stdout) as {
        sessions: { id: string; external_id: string }[];
      };
      const external = (id: string): string | undefined =>
        data.sessions.find((s) => s.id === id)?.external_id;
      expect(external(sessionA)).toBe(idA);
      expect(external(sessionB)).toBe(idB);

      a.child.stdin.end();
      b.child.stdin.end();
      await Promise.all([a.exited, b.exited]);
    },
  );
});

describe('rememberClient', () => {
  function fakeStore(): { kv: Map<string, unknown>; mindly: unknown } {
    const kv = new Map<string, unknown>();
    const mindly = {
      store: {
        kv: {
          get: (key: string) => kv.get(key) ?? null,
          set: (key: string, value: unknown) => void kv.set(key, value),
          delete: (key: string) => void kv.delete(key),
        },
      },
    };
    return { kv, mindly };
  }
  const event = (name: NormalizedHookEvent['event']): NormalizedHookEvent => ({
    agentKind: 'claude-code',
    event: name,
    externalSessionId: 'sess-1',
    cwd: '/nowhere',
    transcriptPath: null,
    startSource: null,
    prompt: null,
    tool: null,
    lastMessage: null,
  });
  const key = hookAncestryKey('claude-code', 'sess-1');

  it('records the ancestors of the first hook of a session and forgets them at its end', () => {
    const { kv, mindly } = fakeStore();
    rememberClient(mindly, event('session_start'));
    const chain = kv.get(key) as { pid: number }[];
    if (process.platform !== 'win32') expect(chain[0]?.pid).toBe(process.ppid);
    // Later hooks leave the record alone.
    kv.set(key, 'kept');
    rememberClient(mindly, event('prompt'));
    expect(kv.get(key)).toBe('kept');
    rememberClient(mindly, event('session_end'));
    expect(kv.has(key)).toBe(false);
    // A session whose start was missed is recorded at its next hook.
    rememberClient(mindly, event('pre_tool'));
    expect(kv.has(key)).toBe(true);
  });

  it('does not keep an empty answer: the next hook tries again, a minute later', () => {
    const { kv, mindly } = fakeStore();
    const t0 = 1_000_000;
    let reads = 0;
    const nothing = () => {
      reads++;
      return [];
    };
    rememberClient(mindly, event('session_start'), { now: t0, chain: nothing });
    expect(Array.isArray(kv.get(key))).toBe(false);
    rememberClient(mindly, event('prompt'), { now: t0 + 1000, chain: nothing });
    expect(reads).toBe(1);
    const found = () => [{ pid: 42, start: 's42' }];
    rememberClient(mindly, event('prompt'), { now: t0 + 61_000, chain: found });
    expect(kv.get(key)).toEqual([{ pid: 42, start: 's42' }]);
  });

  it('clears out what sessions that never ended left behind', async () => {
    const sb = sandbox();
    const { openMindly } = await import('@mindly/runtime');
    const mindly = openMindly({ env: sb.env });
    try {
      const day = 86_400_000;
      mindly.store.kv.set(hookAncestryKey('codex', 'gone'), [{ pid: 9, start: 'x' }]);
      mindly.store.kv.set('hook:ancestryX', 'not a chain key');
      mindly.store.kv.set('mcp:claims', {});
      const later = Date.now() + 8 * day;
      rememberClient(mindly, event('session_start'), {
        now: later,
        chain: () => [{ pid: 1, start: 'y' }],
      });
      expect(mindly.store.kv.get(hookAncestryKey('codex', 'gone'))).toBeNull();
      expect(mindly.store.kv.get('hook:ancestryX')).toBe('not a chain key');
      expect(mindly.store.kv.get('mcp:claims')).toEqual({});
      expect(mindly.store.kv.get(key)).toEqual([{ pid: 1, start: 'y' }]);
    } finally {
      mindly.close();
    }
  });

  it('never throws, whatever it is given', () => {
    expect(() => rememberClient(null, event('session_start'))).not.toThrow();
    expect(() => rememberClient({}, event('session_start'))).not.toThrow();
    const broken = {
      store: {
        kv: {
          get: () => {
            throw new Error('database is locked');
          },
        },
      },
    };
    expect(() => rememberClient(broken, event('prompt'))).not.toThrow();
  });
});
