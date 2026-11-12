import { daemonHomeId } from '@mindly/core';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CSP, type Daemon } from '../src/index.js';
import { bearer, HOST, login, ORIGIN, repo, seedSession, testDaemon } from './helpers.js';

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

async function setup() {
  const t = await testDaemon();
  daemon = t.daemon;
  return t;
}

describe('token file', () => {
  it('creates a 0600 base64url token of 32 bytes and reuses it', async () => {
    const { daemon: d, home } = await setup();
    const path = join(home, 'daemon.token');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(d.token);
    expect(Buffer.from(d.token, 'base64url')).toHaveLength(32);
    await d.stop();
    daemon = null;
    const again = await testDaemon({ home });
    daemon = again.daemon;
    expect(again.daemon.token).toBe(d.token);
  });
});

describe('auth matrix', () => {
  it('health is public', async () => {
    const { daemon: d } = await setup();
    const res = await d.app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    // It says which daemon it is: its PID and a hash of its home, never the path.
    const body = res.json() as { home: string };
    expect(body).toEqual({
      ok: true,
      version: expect.any(String),
      pid: process.pid,
      home: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(body.home).toBe(daemonHomeId(d.paths.home));
  });

  it('rejects requests without a token', async () => {
    const { daemon: d } = await setup();
    const res = await d.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('rejects a bad token', async () => {
    const { daemon: d } = await setup();
    for (const authorization of ['Bearer nope', `Bearer ${d.token}x`, d.token, 'Basic abc']) {
      const res = await d.app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: HOST, authorization },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accepts the bearer token without CSRF headers', async () => {
    const { daemon: d } = await setup();
    const res = await d.app.inject({ method: 'GET', url: '/api/projects', headers: bearer(d) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    const root = repo();
    const project = d.mindly.store.projects.upsertByRoot(root, 'repo');
    const snap = await d.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/snapshots`,
      headers: { ...bearer(d), 'content-type': 'application/json' },
      payload: { label: 'cli' },
    });
    expect(snap.statusCode).toBe(201);
  });

  it('rejects a bad Host with 421, even with a valid token', async () => {
    const { daemon: d } = await setup();
    for (const host of ['evil.example:47878', '127.0.0.1:1', 'localhost', '0.0.0.0:47878']) {
      const res = await d.app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { ...bearer(d), host },
      });
      expect(res.statusCode).toBe(421);
      expect(res.json().error.code).toBe('bad_host');
    }
    const ok = await d.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:47878' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects a foreign Origin with 403', async () => {
    const { daemon: d } = await setup();
    const res = await d.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: bearer(d, { origin: 'http://evil.example' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('only the bearer token can mint login codes', async () => {
    const { daemon: d } = await setup();
    const cookie = await login(d);
    const res = await d.app.inject({
      method: 'POST',
      url: '/api/auth/codes',
      headers: { host: HOST, cookie, origin: ORIGIN, 'x-mindly-csrf': '1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exchanges a login code for an HttpOnly SameSite=Strict cookie, once', async () => {
    const { daemon: d } = await setup();
    const codeRes = await d.app.inject({
      method: 'POST',
      url: '/api/auth/codes',
      headers: bearer(d),
    });
    expect(codeRes.statusCode).toBe(200);
    const { code, expiresAt } = codeRes.json() as { code: string; expiresAt: number };
    expect(code).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    const exchange = () =>
      d.app.inject({
        method: 'POST',
        url: '/api/auth/exchange',
        headers: {
          host: HOST,
          origin: ORIGIN,
          'x-mindly-csrf': '1',
          'content-type': 'application/json',
        },
        payload: { code },
      });
    const first = await exchange();
    expect(first.statusCode).toBe(200);
    const setCookie = String(first.headers['set-cookie']);
    expect(setCookie).toMatch(/^mindly_session=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=43200');
    const reuse = await exchange();
    expect(reuse.statusCode).toBe(401);
    expect(reuse.headers['set-cookie']).toBeUndefined();
  });

  it('expires login codes after 60 s', async () => {
    const { daemon: d } = await setup();
    const { code } = d.auth.issueCode();
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(d.auth.exchange(code)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('exchange requires the CSRF header', async () => {
    const { daemon: d } = await setup();
    const { code } = d.auth.issueCode();
    const res = await d.app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: { code },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cookie GETs work; cookie mutations need Origin and X-Mindly-CSRF', async () => {
    const { daemon: d } = await setup();
    const cookie = await login(d);
    const root = repo();
    const s = seedSession(d, root);
    const get = await d.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { host: HOST, cookie },
    });
    expect(get.statusCode).toBe(200);
    const url = `/api/projects/${s.projectId}/snapshots`;
    const body = { 'content-type': 'application/json' };
    const noCsrf = await d.app.inject({
      method: 'POST',
      url,
      headers: { host: HOST, cookie, origin: ORIGIN, ...body },
      payload: { label: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const noOrigin = await d.app.inject({
      method: 'POST',
      url,
      headers: { host: HOST, cookie, 'x-mindly-csrf': '1', ...body },
      payload: { label: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const badOrigin = await d.app.inject({
      method: 'POST',
      url,
      headers: { host: HOST, cookie, origin: 'http://localhost:1', 'x-mindly-csrf': '1', ...body },
      payload: { label: 'x' },
    });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await d.app.inject({
      method: 'POST',
      url,
      headers: { host: HOST, cookie, origin: ORIGIN, 'x-mindly-csrf': '1', ...body },
      payload: { label: 'x' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('rejects an unknown cookie and logs out', async () => {
    const { daemon: d } = await setup();
    const bad = await d.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { host: HOST, cookie: 'mindly_session=forged' },
    });
    expect(bad.statusCode).toBe(401);
    const cookie = await login(d);
    const out = await d.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { host: HOST, cookie, origin: ORIGIN, 'x-mindly-csrf': '1' },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await d.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { host: HOST, cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('transport', () => {
  it('sets security headers on every response, no CORS', async () => {
    const { daemon: d } = await setup();
    const responses = await Promise.all([
      d.app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } }),
      d.app.inject({ method: 'GET', url: '/api/projects', headers: { host: HOST } }),
      d.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil:1' } }),
      d.app.inject({ method: 'GET', url: '/nope', headers: { host: HOST } }),
      d.app.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: { host: HOST, origin: ORIGIN, 'access-control-request-method': 'POST' },
      }),
    ]);
    for (const res of responses) {
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(responses[0]?.headers['cache-control']).toBe('no-store');
    expect(responses[1]?.headers['cache-control']).toBe('no-store');
  });

  it('limits bodies to 256 KB and accepts only JSON', async () => {
    const { daemon: d } = await setup();
    const s = seedSession(d, repo());
    const url = `/api/projects/${s.projectId}/memories`;
    const big = await d.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(d), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'fact', title: 't', body: 'x'.repeat(300 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('too_large');
    const text = await d.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(d), 'content-type': 'text/plain' },
      payload: '{"kind":"fact","title":"t","body":"b"}',
    });
    expect(text.statusCode).toBe(400);
    const broken = await d.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(d), 'content-type': 'application/json' },
      payload: '{"kind":',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('invalid_input');
  });

  it('returns a generic 500 and logs the details', async () => {
    const { daemon: d, home } = await setup();
    d.app.get('/api/boom', async () => {
      throw new Error('secret detail sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    });
    const res = await d.app.inject({ method: 'GET', url: '/api/boom', headers: bearer(d) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal error.' } });
    const log = readFileSync(join(home, 'logs', 'mindly.log'), 'utf8');
    expect(log).toContain('request failed');
    expect(log).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('refuses to bind any interface but 127.0.0.1', async () => {
    await expect(testDaemon({ host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
  });
});
