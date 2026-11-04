import { describe, expect, it } from 'vitest';
import { REDACTED, type UserConfig } from '@synapse/core';
import {
  DEDUPE_WINDOW_MS,
  MAX_PER_WINDOW,
  OSASCRIPT_SOURCE,
  RATE_WINDOW_MS,
  createNotifier,
  toHeaderValue,
  type ExecFileLike,
  type FetchLike,
  type Notification,
} from '../src/index.js';

type NotifyConfig = UserConfig['notify'];

interface Call {
  url: string;
  init: RequestInit;
}

function okFetch(status = 200): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('ok', { status }));
  };
  return { fetchImpl, calls };
}

function fakeExec(): { execFileImpl: ExecFileLike; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  return {
    calls,
    execFileImpl: (file, args) => {
      calls.push({ file, args: [...args] });
      return Promise.resolve();
    },
  };
}

function manualClock(start = Date.UTC(2026, 0, 1)): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const webhook = (url = 'https://hooks.example.com/abc'): NotifyConfig['channels'][number] => ({
  type: 'webhook',
  url,
});
const ntfy = (url = 'https://ntfy.sh'): NotifyConfig['channels'][number] => ({
  type: 'ntfy',
  url,
  topic: 'synapse_topic_1',
});

function config(
  channels: NotifyConfig['channels'],
  triggers?: NotifyConfig['triggers'],
): NotifyConfig {
  return { channels, triggers: triggers ?? ['agent_blocked', 'rate_limited'] };
}

const NON_ASCII = `Caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2713)}`;
const blocked: Notification = { trigger: 'agent_blocked', title: 'Agent blocked', body: 'Waiting' };

describe('trigger filtering', () => {
  it('sends only enabled triggers', async () => {
    const { fetchImpl, calls } = okFetch();
    const n = createNotifier(config([webhook()]), { fetchImpl });
    expect(await n.send({ ...blocked, trigger: 'standup' })).toEqual([
      { channel: 'webhook', status: 'skipped', reason: 'trigger_disabled' },
    ]);
    expect(calls).toHaveLength(0);
    expect(await n.send(blocked)).toEqual([{ channel: 'webhook', status: 'sent' }]);
    expect(calls).toHaveLength(1);
  });

  it('returns no results when no channels are configured', async () => {
    expect(await createNotifier(config([])).send(blocked)).toEqual([]);
  });
});

describe('payload minimisation', () => {
  it('redacts, flattens and truncates title and body', async () => {
    const { fetchImpl, calls } = okFetch();
    const clock = manualClock();
    const n = createNotifier(config([webhook()]), { fetchImpl, clock });
    await n.send({
      ...blocked,
      title: `Leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789\r\nX-Evil: 1 ${'t'.repeat(200)}`,
      body: `line1\nline2 AKIAIOSFODNN7EXAMPLE ${'b'.repeat(500)}`,
      projectName: 'demo',
    });
    const payload = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    const title = String(payload.title);
    const body = String(payload.body);
    expect(title).toContain(REDACTED);
    expect(title).not.toContain('ghp_');
    expect(title).not.toMatch(/[\r\n]/);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(body).not.toContain('AKIA');
    expect(body).not.toMatch(/[\r\n]/);
    expect(body.length).toBeLessThanOrEqual(240);
    expect(payload).toMatchObject({
      trigger: 'agent_blocked',
      project: 'demo',
      ts: new Date(clock.now()).toISOString(),
    });
    expect(Object.keys(payload).sort()).toEqual(['body', 'project', 'title', 'trigger', 'ts']);
  });
});

describe('ntfy', () => {
  it('posts to url/topic with safe headers', async () => {
    const { fetchImpl, calls } = okFetch();
    const n = createNotifier(config([ntfy('https://ntfy.example.com/')]), { fetchImpl });
    expect(await n.send({ ...blocked, priority: 'high', projectName: 'web' })).toEqual([
      { channel: 'ntfy', status: 'sent' },
    ]);
    const call = calls[0];
    expect(call?.url).toBe('https://ntfy.example.com/synapse_topic_1');
    expect(call?.init.redirect).toBe('error');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Title).toBe('Agent blocked');
    expect(headers.Priority).toBe('4');
    expect(headers.Tags).toBe('synapse,agent_blocked');
    expect(call?.init.body).toBe('[web] Waiting');
  });

  it('blocks CRLF header injection', async () => {
    const { fetchImpl, calls } = okFetch();
    const n = createNotifier(config([ntfy()]), { fetchImpl });
    await n.send({ ...blocked, title: 'Hi\r\nAuthorization: Bearer x\r\n\r\nbody' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    for (const value of Object.values(headers)) expect(value).not.toMatch(/[\r\n]/);
    expect(headers.Authorization).toBeUndefined();
    // The built headers must be accepted by the real Headers implementation.
    expect(() => new Headers(headers)).not.toThrow();
  });

  it('encodes non-ASCII titles as RFC 2047', async () => {
    const { fetchImpl, calls } = okFetch();
    const n = createNotifier(config([ntfy()]), { fetchImpl });
    await n.send({ ...blocked, title: NON_ASCII });
    const title = (calls[0]?.init.headers as Record<string, string>).Title ?? '';
    expect(title).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const b64 = title.slice('=?UTF-8?B?'.length, -2);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(NON_ASCII);
  });

  it('toHeaderValue strips control characters', () => {
    expect(toHeaderValue('a\r\nb\u0000c')).toBe('a  b c');
  });
});

describe('transport security', () => {
  it.each([
    ['webhook', webhook('http://hooks.example.com/abc')],
    ['ntfy', ntfy('http://ntfy.example.com')],
    ['webhook', webhook('http://192.168.1.2/x')],
    ['webhook', webhook('ftp://example.com/x')],
    ['webhook', webhook('https://user:pass@example.com/x')],
  ])('refuses insecure %s url', async (channel, ch) => {
    const { fetchImpl, calls } = okFetch();
    const res = await createNotifier(config([ch]), { fetchImpl }).send(blocked);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ channel, status: 'failed' });
    expect(res[0]?.reason).not.toContain('example.com');
    expect(calls).toHaveLength(0);
  });

  it.each(['http://localhost:8080/hook', 'http://127.0.0.1/hook', 'http://[::1]:9000/hook'])(
    'allows http to loopback %s',
    async (url) => {
      const { fetchImpl } = okFetch();
      const res = await createNotifier(config([webhook(url)]), { fetchImpl }).send(blocked);
      expect(res).toEqual([{ channel: 'webhook', status: 'sent' }]);
    },
  );

  it('refuses redirects', async () => {
    const calls: RequestInit[] = [];
    // Mirrors fetch semantics: with redirect: 'error' a 3xx response becomes a network error.
    const fetchImpl: FetchLike = (_url, init) => {
      calls.push(init);
      return init.redirect === 'error'
        ? Promise.reject(new TypeError('fetch failed: unexpected redirect to https://evil'))
        : Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil' } }));
    };
    const res = await createNotifier(config([webhook(), ntfy()]), { fetchImpl }).send(blocked);
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);
    expect(res.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(JSON.stringify(res)).not.toContain('evil');
  });

  it('treats a 3xx that reaches us as a refused redirect', async () => {
    const { fetchImpl } = okFetch(307);
    const res = await createNotifier(config([webhook()]), { fetchImpl }).send(blocked);
    expect(res).toEqual([
      { channel: 'webhook', status: 'failed', reason: 'webhook redirect refused' },
    ]);
  });

  it('times out slow webhooks', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const start = Date.now();
    const res = await createNotifier(config([webhook()]), { fetchImpl }).send(blocked);
    expect(res[0]).toMatchObject({ status: 'failed', reason: 'webhook request timed out' });
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});

describe('dedupe and rate limiting', () => {
  it('sends the same dedupeKey at most once per 10 minutes', async () => {
    const { fetchImpl, calls } = okFetch();
    const clock = manualClock();
    const n = createNotifier(config([webhook()]), { fetchImpl, clock });
    const msg = { ...blocked, dedupeKey: 'session-1-blocked' };
    expect((await n.send(msg))[0]?.status).toBe('sent');
    clock.advance(DEDUPE_WINDOW_MS - 1);
    expect(await n.send(msg)).toEqual([
      { channel: 'webhook', status: 'skipped', reason: 'deduped' },
    ]);
    expect((await n.send({ ...msg, dedupeKey: 'other' }))[0]?.status).toBe('sent');
    clock.advance(1);
    expect((await n.send(msg))[0]?.status).toBe('sent');
    expect(calls).toHaveLength(3);
  });

  it('caps notifications at 30 per hour', async () => {
    const { fetchImpl, calls } = okFetch();
    const clock = manualClock();
    const n = createNotifier(config([webhook()]), { fetchImpl, clock });
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      expect((await n.send(blocked))[0]?.status).toBe('sent');
      clock.advance(1000);
    }
    expect(await n.send(blocked)).toEqual([
      { channel: 'webhook', status: 'skipped', reason: 'rate_limited' },
    ]);
    clock.advance(RATE_WINDOW_MS - MAX_PER_WINDOW * 1000 + 1);
    expect((await n.send(blocked))[0]?.status).toBe('sent');
    expect(calls).toHaveLength(MAX_PER_WINDOW + 1);
  });

  it('does not count filtered triggers against the limit', async () => {
    const { fetchImpl } = okFetch();
    const n = createNotifier(config([webhook()]), { fetchImpl, clock: manualClock() });
    for (let i = 0; i < 50; i++) await n.send({ ...blocked, trigger: 'standup' });
    expect((await n.send(blocked))[0]?.status).toBe('sent');
  });
});

describe('desktop', () => {
  const hostile: Notification = {
    trigger: 'agent_blocked',
    title: '-e do shell script "rm -rf ~"',
    body: '" & (do shell script "id") & "',
    projectName: 'proj',
  };

  it('macOS passes user text only as argv after a fixed script', async () => {
    const { execFileImpl, calls } = fakeExec();
    const res = await createNotifier(config([{ type: 'desktop' }]), {
      platform: 'darwin',
      execFileImpl,
    }).send(hostile);
    expect(res).toEqual([{ channel: 'desktop', status: 'sent' }]);
    const call = calls[0];
    expect(call?.file).toBe('osascript');
    expect(call?.args[0]).toBe('-e');
    expect(call?.args[1]).toBe(OSASCRIPT_SOURCE);
    expect(call?.args[2]).toBe('--');
    expect(call?.args.slice(3)).toEqual([hostile.title, hostile.body, 'proj']);
    const script = call?.args[1] ?? '';
    expect(script).not.toContain('rm -rf');
    expect(script).not.toContain('do shell script');
    expect(script).toContain('on run argv');
    // Only one -e: no user value can become a second script statement.
    expect(call?.args.filter((a) => a === '-e')).toHaveLength(1);
  });

  it('linux uses notify-send with an argument array', async () => {
    const { execFileImpl, calls } = fakeExec();
    await createNotifier(config([{ type: 'desktop' }]), { platform: 'linux', execFileImpl }).send(
      blocked,
    );
    expect(calls[0]).toEqual({
      file: 'notify-send',
      args: ['--urgency=normal', '--', 'Agent blocked', 'Waiting'],
    });
  });

  it('windows is reported as unsupported', async () => {
    const { execFileImpl, calls } = fakeExec();
    const res = await createNotifier(config([{ type: 'desktop' }]), {
      platform: 'win32',
      execFileImpl,
    }).send(blocked);
    expect(res).toEqual([{ channel: 'desktop', status: 'skipped', reason: 'unsupported' }]);
    expect(calls).toHaveLength(0);
  });

  it('reports execFile failures without throwing', async () => {
    const execFileImpl: ExecFileLike = () => Promise.reject(new Error('boom'));
    const res = await createNotifier(config([{ type: 'desktop' }]), {
      platform: 'linux',
      execFileImpl,
    }).send(blocked);
    expect(res).toEqual([{ channel: 'desktop', status: 'failed', reason: 'desktop failed' }]);
  });
});
