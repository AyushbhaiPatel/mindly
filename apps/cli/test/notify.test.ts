import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('in an older config file stop nothing, and are named where they are looked for', async () => {
    const sb = sandbox();
    mkdirSync(sb.mindlyHome, { recursive: true });
    const file = join(sb.mindlyHome, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        notify: {
          channels: [{ type: 'desktop' }, { type: 'webhook', url: 'http://example.com/hook' }],
        },
      }),
    );
    // Commands still run.
    expect((await cli(sb, ['status'])).code).toBe(0);

    // Other settings can be changed; the entry stays in the file as it was.
    const set = await cli(sb, ['config', 'set', 'hooks.timeoutMs', '2000']);
    expect(set.code, set.stderr).toBe(0);
    const written = JSON.parse(readFileSync(file, 'utf8')) as {
      notify: { channels: unknown[] };
      hooks: { timeoutMs: number };
    };
    expect(written.hooks.timeoutMs).toBe(2000);
    expect(written.notify.channels).toHaveLength(2);
    expect((await cli(sb, ['config', 'set', 'notify.triggers', '["rate_limited"]'])).code).toBe(0);

    // `config get` shows it as written and says why it is not used.
    const get = await cli(sb, ['config', 'get', 'notify.channels']);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual([
      { type: 'desktop' },
      { type: 'webhook', url: 'http://example.com/hook' },
    ]);
    expect(get.stderr).toContain('notify.channels[1] (webhook) is not used');
    expect(get.stderr).toContain('url must use https');
    const all = await cli(sb, ['config', 'get']);
    expect(JSON.parse(all.stdout).notify.channels).toHaveLength(2);

    // Setting the channels is held to the rules.
    const again = await cli(sb, [
      'config',
      'set',
      'notify.channels',
      JSON.stringify([{ type: 'webhook', url: 'http://example.com/hook' }]),
    ]);
    expect(again.code).not.toBe(0);

    // doctor and notify test name it, without the URL.
    const doctor = await cli(sb, ['doctor', '--json']);
    expect(doctor.stdout).toContain('notify-channel');
    expect(doctor.stdout).toContain('notify.channels[1] (webhook)');
    expect(doctor.stdout).not.toContain('example.com');
    const test = await cli(sb, ['notify', 'test', '--json']);
    expect(test.code).toBe(1);
    expect(JSON.parse(test.stdout).unusable).toEqual([
      { index: 1, type: 'webhook', problem: 'url must use https (http only for localhost)' },
    ]);
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
    sessionId: string = session,
  ): Promise<{ code: number | null; ms: number }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(process.execPath, [CLI_MAIN, 'hook', 'claude-code', event], {
        cwd: sb.repo,
        env: sb.env,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      p.on('close', (code) => resolve({ code, ms: Date.now() - started }));
      p.stdin.end(
        JSON.stringify({ ...JSON.parse(payload(sb, event, extra)), session_id: sessionId }),
      );
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

  it('sends a second page raised while the first is still on its way, each once', async () => {
    const hook = await endpoint();
    try {
      const sb = sandbox();
      await setChannel(sb, hook.url);
      hook.status.delayMs = 2000;
      const limit = {
        stop_hook_active: false,
        last_assistant_message: 'Claude usage limit reached. Your limit will reset at 3pm.',
      };
      // Two sessions hit their limit one second apart, while the pager is slow.
      for (const s of ['01', '02']) {
        const id = `00893aaf-19fa-41d2-8238-1326000000${s}`;
        expect((await hookProcess(sb, 'SessionStart', { source: 'startup' }, id)).code).toBe(0);
        expect(
          (await hookProcess(sb, 'UserPromptSubmit', { prompt: 'Add a field' }, id)).code,
        ).toBe(0);
      }
      const first = await hookProcess(sb, 'Stop', limit, '00893aaf-19fa-41d2-8238-132600000001');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const second = await hookProcess(sb, 'Stop', limit, '00893aaf-19fa-41d2-8238-132600000002');
      expect(first.ms).toBeLessThan(2500);
      expect(second.ms).toBeLessThan(2500);

      expect(await until(() => outboxSize(sb) === 0, 20_000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hook.bodies).toHaveLength(2);
      const ids = hook.bodies.map((b) => (JSON.parse(b) as { id: string }).id);
      expect(new Set(ids).size).toBe(2);
    } finally {
      await hook.close();
    }
  }, 40_000);

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
