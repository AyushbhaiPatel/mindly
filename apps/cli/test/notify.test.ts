import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cli, sandbox, type Sandbox } from './helpers.js';

/** A webhook endpoint on 127.0.0.1: answers `status.code` after `status.delayMs`. */
async function endpoint(): Promise<{
  url: string;
  bodies: string[];
  status: { code: number; delayMs: number };
  close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const status = { code: 200, delayMs: 0 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      bodies.push(body);
      setTimeout(() => {
        res.statusCode = status.code;
        res.end('ok');
      }, status.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    bodies,
    status,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function setChannel(sb: Sandbox, url: string): Promise<void> {
  const r = await cli(sb, [
    'config',
    'set',
    'notify.channels',
    JSON.stringify([{ type: 'webhook', url }]),
  ]);
  expect(r.code, r.stderr).toBe(0);
}

describe('mindly notify test', () => {
  it('says there is nothing to test without a channel', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['notify', 'test']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No notification channel is configured');
  });

  it('sends one notification per channel, every time it is run', async () => {
    const hook = await endpoint();
    try {
      const sb = sandbox();
      await setChannel(sb, hook.url);
      const first = await cli(sb, ['notify', 'test']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('webhook: sent');
      // A test is not held back as a duplicate, and does not need its trigger to be on.
      const second = await cli(sb, ['notify', 'test', '--json']);
      expect(second.code).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual({
        ok: true,
        channels: [{ channel: 'webhook', status: 'sent' }],
      });
      expect(hook.bodies).toHaveLength(2);
      expect(JSON.parse(hook.bodies[0]!)).toMatchObject({ title: 'Mindly test notification' });
    } finally {
      await hook.close();
    }
  });

  it('reports a channel that does not work, with the reason and not the URL', async () => {
    const hook = await endpoint();
    try {
      const sb = sandbox();
      await setChannel(sb, hook.url);
      hook.status.code = 500;
      const r = await cli(sb, ['notify', 'test']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('webhook: webhook returned HTTP 500');
      expect(r.stdout).not.toContain(hook.url);
    } finally {
      await hook.close();
    }
  });
});

describe('notification channel URLs', () => {
  it('are refused when set if they could never be used', async () => {
    const sb = sandbox();
    for (const url of ['http://example.com/hook', 'https://user:pw@example.com/x']) {
      const r = await cli(sb, [
        'config',
        'set',
        'notify.channels',
        JSON.stringify([{ type: 'webhook', url }]),
      ]);
      expect(r.code, url).not.toBe(0);
      expect(r.stderr).toMatch(/url must (use https|not contain credentials)/);
    }
    expect((await cli(sb, ['config', 'get', 'notify.channels'])).stdout.trim()).toBe('[]');
    await setChannel(sb, 'https://hooks.example.com/abc');
  });

  it('do not stop Mindly when an older config file holds one', async () => {
    const sb = sandbox();
    mkdirSync(sb.mindlyHome, { recursive: true });
    writeFileSync(
      join(sb.mindlyHome, 'config.json'),
      JSON.stringify({
        notify: { channels: [{ type: 'webhook', url: 'http://example.com/hook' }] },
      }),
    );
    // Commands still run; the channel is left out and `notify test` says why.
    expect((await cli(sb, ['status'])).code).toBe(0);
    const r = await cli(sb, ['notify', 'test']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/webhook channel in your config cannot be used: url must use https/i);
    expect(r.stderr).not.toContain('example.com');
  });
});

describe('a notification raised in a hook', () => {
  const session = '00893aaf-19fa-41d2-8238-13269b9b3ca0';
  const payload = (sb: Sandbox, event: string, extra: Record<string, unknown>): string =>
    JSON.stringify({
      session_id: session,
      transcript_path: `${sb.home}/none.jsonl`,
      cwd: sb.repo,
      hook_event_name: event,
      ...extra,
    });

  /** Runs `mindly hook` as its own process from the build, as an agent does. */
  const CLI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  function hookProcess(
    sb: Sandbox,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<{ code: number | null; ms: number }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(process.execPath, [CLI_MAIN, 'hook', 'claude-code', event], {
        cwd: sb.repo,
        env: sb.env,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      p.on('close', (code) => resolve({ code, ms: Date.now() - started }));
      p.stdin.end(payload(sb, event, extra));
    });
  }
  const outboxSize = (sb: Sandbox): number => {
    const db = new DatabaseSync(join(sb.mindlyHome, 'mindly.db'), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'notify.outbox:%'")
        .get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  };
  const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return ok();
  };

  it('is sent once by a process of its own, and no hook waits for the pager', async () => {
    const hook = await endpoint();
    try {
      const sb = sandbox();
      await setChannel(sb, hook.url);
      // A pager slower than any hook should take.
      hook.status.delayMs = 3000;

      expect((await hookProcess(sb, 'SessionStart', { source: 'startup' })).code).toBe(0);
      expect(
        (await hookProcess(sb, 'UserPromptSubmit', { prompt: 'Add a discount field' })).code,
      ).toBe(0);
      const stop = await hookProcess(sb, 'Stop', {
        stop_hook_active: false,
        last_assistant_message: 'Claude usage limit reached. Your limit will reset at 3pm.',
      });
      expect(stop.code).toBe(0);
      // The hook is done well before the pager answers.
      expect(stop.ms).toBeLessThan(2500);

      // The sender waits for the answer and records it.
      expect(await until(() => outboxSize(sb) === 0, 15_000)).toBe(true);
      expect(hook.bodies).toHaveLength(1);
      expect(JSON.parse(hook.bodies[0]!)).toMatchObject({ trigger: 'rate_limited' });
      expect(JSON.parse(hook.bodies[0]!).id).toBeTruthy();

      // Later hooks neither send it again nor wait for anything.
      for (let i = 0; i < 3; i++) {
        const r = await hookProcess(sb, 'UserPromptSubmit', { prompt: `next ${i}` });
        expect(r.code).toBe(0);
        expect(r.ms).toBeLessThan(2500);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(hook.bodies).toHaveLength(1);
    } finally {
      await hook.close();
    }
  }, 40_000);
});
