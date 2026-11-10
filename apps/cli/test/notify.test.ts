import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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

  it('is sent after the agent has its answer, although the pager takes longer than a hook waits', async () => {
    const hook = await endpoint();
    try {
      const sb = sandbox();
      await setChannel(sb, hook.url);
      // Slower than the 800 ms a hook gives the work it triggers, within the hook's own deadline.
      expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '5000'])).code).toBe(0);
      hook.status.delayMs = 900;

      for (const [event, extra] of [
        ['SessionStart', { source: 'startup' }],
        ['UserPromptSubmit', { prompt: 'Add a discount field' }],
      ] as const) {
        const r = await cli(sb, ['hook', 'claude-code', event], {
          stdin: payload(sb, event, extra),
        });
        expect(r.code).toBe(0);
      }
      expect(hook.bodies).toHaveLength(0);

      const stop = await cli(sb, ['hook', 'claude-code', 'Stop'], {
        stdin: payload(sb, 'Stop', {
          stop_hook_active: false,
          last_assistant_message: 'Claude usage limit reached. Your limit will reset at 3pm.',
        }),
      });
      expect(stop.code).toBe(0);
      expect(hook.bodies).toHaveLength(1);
      expect(JSON.parse(hook.bodies[0]!)).toMatchObject({ trigger: 'rate_limited' });

      // Delivered once: a later hook has nothing left to send.
      const again = await cli(sb, ['hook', 'claude-code', 'Stop'], {
        stdin: payload(sb, 'Stop', { stop_hook_active: false, last_assistant_message: 'Done.' }),
      });
      expect(again.code).toBe(0);
      expect(hook.bodies).toHaveLength(1);
    } finally {
      await hook.close();
    }
  });
});
