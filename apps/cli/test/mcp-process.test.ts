import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, sandbox, type Sandbox } from './helpers.js';

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

interface Server {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  exited: Promise<number | null>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Starts `mindly mcp` as a client would and completes the handshake. */
async function start(sb: Sandbox, agent: string): Promise<Server> {
  const child = spawn(process.execPath, [BUILT_MAIN, 'mcp', '--agent', agent], {
    cwd: sb.repo,
    env: sb.env,
  });
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
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
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
      expect(await server.exited).toBe(0);
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
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toBe('');
    expect(await liveAgents(sb)).toContain('No agent is working');
  });
});
