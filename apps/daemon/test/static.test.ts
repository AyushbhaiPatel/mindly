import { afterEach, describe, expect, it } from 'vitest';
import { CSP, type Daemon } from '../src/index.js';
import { HOST, tempDir, testDaemon, write } from './helpers.js';

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

describe('dashboard assets', () => {
  it('serves the built dashboard without auth, with an SPA fallback and the CSP', async () => {
    const dir = tempDir('mindly-dash-');
    write(dir, 'index.html', '<!doctype html><title>Mission Control</title>');
    write(dir, 'assets/app.js', 'console.log(1)');
    write(dir, '.secret', 'x');
    daemon = (await testDaemon({ dashboardDir: dir })).daemon;
    const inject = (url: string) =>
      daemon!.app.inject({ method: 'GET', url, headers: { host: HOST } });

    const index = await inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('Mission Control');
    expect(index.headers['content-security-policy']).toBe(CSP);
    const js = await inject('/assets/app.js');
    expect(js.statusCode).toBe(200);
    expect(String(js.headers['content-type'])).toContain('javascript');
    const route = await inject('/memory/some-id');
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('Mission Control');
    expect((await inject('/.secret')).body).not.toBe('x');
    const api = await inject('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    const bad = await daemon.app.inject({ method: 'GET', url: '/', headers: { host: 'evil:80' } });
    expect(bad.statusCode).toBe(421);
  });

  it('explains a missing dashboard build', async () => {
    daemon = (await testDaemon({ dashboardDir: tempDir('mindly-nodash-') })).daemon;
    const res = await daemon.app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/not built/);
  });
});
