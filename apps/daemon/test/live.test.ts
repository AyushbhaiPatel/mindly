import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MAX_LIVE_SOCKETS, startDaemon, type Daemon } from '../src/index.js';
import { fakeRunners, repo, seedSession, tempDir } from './helpers.js';

let daemon: Daemon | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await daemon?.stop();
  daemon = null;
});

async function start(home = tempDir('mindly-live-home-')): Promise<Daemon> {
  daemon = await startDaemon({
    home,
    env: { MINDLY_HOME: home },
    port: 0,
    dashboardDir: null,
    jobs: false,
    runners: fakeRunners(),
    runtime: { disableNotify: true, disableLlm: true },
  });
  return daemon;
}

interface Msg {
  type: string;
  [k: string]: unknown;
}

function connect(
  d: Daemon,
  headers: Record<string, string>,
): Promise<{ ws: WebSocket; messages: Msg[]; next: (type: string) => Promise<Msg> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/api/live`, { headers });
    sockets.push(ws);
    const messages: Msg[] = [];
    const waiters: { type: string; resolve: (m: Msg) => void }[] = [];
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.type === m.type) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    const next = (type: string) =>
      new Promise<Msg>((res, rej) => {
        const seen = messages.find((m) => m.type === type && !(m as { _taken?: boolean })._taken);
        if (seen) {
          (seen as { _taken?: boolean })._taken = true;
          res(seen);
          return;
        }
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 5000);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            (m as { _taken?: boolean })._taken = true;
            res(m);
          },
        });
      });
    ws.once('open', () => resolve({ ws, messages, next }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('daemon lifecycle', () => {
  it('listens on 127.0.0.1, writes daemon.json (0600) and removes it on stop', async () => {
    const home = tempDir('mindly-live-home-');
    const d = await start(home);
    const statePath = join(home, 'daemon.json');
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state).toMatchObject({ pid: process.pid, port: d.port, version: expect.any(String) });
    expect(d.port).toBeGreaterThan(0);
    const res = await fetch(`${d.url}/api/health`);
    expect(res.status).toBe(200);
    await expect(
      startDaemon({ home, env: { MINDLY_HOME: home }, port: 0, dashboardDir: null, jobs: false }),
    ).rejects.toThrow(/already running/);
    await d.stop();
    daemon = null;
    expect(existsSync(statePath)).toBe(false);
  });

  it('starts over a daemon.json whose PID now belongs to another program', async () => {
    const home = tempDir('mindly-live-home-');
    const statePath = join(home, 'daemon.json');
    // A closed port: nothing answers there.
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const deadPort = (probe.address() as AddressInfo).port;
    probe.close();
    await once(probe, 'close');
    // This test process stands in for the unrelated program that got the old daemon's PID.
    writeFileSync(
      statePath,
      JSON.stringify({ pid: process.pid, port: deadPort, startedAt: 1, version: '0.0.1' }),
    );
    const d = await start(home);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ port: d.port });
    expect((await fetch(`${d.url}/api/health`)).status).toBe(200);
  });

  it('a daemon that loses the port leaves the running daemon and its runs alone', async () => {
    const home = tempDir('mindly-live-home-');
    const d = await start(home);
    const statePath = join(home, 'daemon.json');
    const s = seedSession(d, repo());
    const run = d.mindly.store.runs.create({
      projectId: s.projectId,
      kind: 'shadow_merge',
      title: 'merge check',
      input: {},
    });
    const state = readFileSync(statePath, 'utf8');
    // With the state file gone, only the port tells the second daemon it is not alone.
    rmSync(statePath);
    await expect(
      startDaemon({
        home,
        env: { MINDLY_HOME: home },
        port: d.port,
        dashboardDir: null,
        jobs: false,
        runners: fakeRunners(),
        runtime: { disableNotify: true, disableLlm: true },
      }),
    ).rejects.toThrow(/already in use/);
    expect(d.mindly.store.runs.get(run.id).status).toBe('queued');
    expect(existsSync(statePath)).toBe(false);
    writeFileSync(statePath, state);
  });
});

describe('live feed', () => {
  it('sends hello, then the subscribed project events in seq order', async () => {
    const d = await start();
    const root = repo();
    const s = seedSession(d, root);
    const other = seedSession(d, repo());
    const { ws, next } = await connect(d, { authorization: `Bearer ${d.token}` });
    const hello = await next('hello');
    expect(hello.lastSeq).toBe(d.mindly.store.events.maxSeq());
    ws.send(JSON.stringify({ type: 'subscribe', projectId: s.projectId }));
    await new Promise((r) => setTimeout(r, 50));
    d.mindly.store.events.append({
      projectId: other.projectId,
      sessionId: null,
      type: 'task.created',
      payload: {},
    });
    const e1 = d.mindly.store.events.append({
      projectId: s.projectId,
      sessionId: s.id,
      type: 'task.created',
      payload: { n: 1 },
    });
    const e2 = d.mindly.store.events.append({
      projectId: s.projectId,
      sessionId: s.id,
      type: 'task.updated',
      payload: { n: 2 },
    });
    const batch = await next('events');
    expect(batch.projectId).toBe(s.projectId);
    expect((batch.events as { seq: number }[]).map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
  });

  it('replays from afterSeq on subscribe', async () => {
    const d = await start();
    const s = seedSession(d, repo());
    const e1 = d.mindly.store.events.append({
      projectId: s.projectId,
      sessionId: null,
      type: 'task.created',
      payload: {},
    });
    const { ws, next } = await connect(d, { authorization: `Bearer ${d.token}` });
    await next('hello');
    ws.send(JSON.stringify({ type: 'subscribe', projectId: s.projectId, afterSeq: e1.seq - 1 }));
    const batch = await next('events');
    expect((batch.events as { id: string }[]).map((e) => e.id)).toEqual([e1.id]);
  });

  it('requires auth and, for cookies, a matching Origin', async () => {
    const d = await start();
    await expect(connect(d, {})).rejects.toThrow(/401/);
    await expect(connect(d, { authorization: 'Bearer wrong' })).rejects.toThrow(/401/);
    const { code } = d.auth.issueCode();
    const session = d.auth.exchange(code);
    const cookie = `mindly_session=${session?.sessionId}`;
    await expect(connect(d, { cookie })).rejects.toThrow(/403/);
    await expect(connect(d, { cookie, origin: 'http://evil.example' })).rejects.toThrow(/403/);
    const ok = await connect(d, { cookie, origin: `http://127.0.0.1:${d.port}` });
    await ok.next('hello');
    await expect(
      connect(d, { authorization: `Bearer ${d.token}`, host: 'evil.example' }),
    ).rejects.toThrow(/421/);
  });

  it(`accepts at most ${MAX_LIVE_SOCKETS} sockets`, async () => {
    const d = await start();
    const conns = [];
    for (let i = 0; i < MAX_LIVE_SOCKETS; i++) {
      conns.push(await connect(d, { authorization: `Bearer ${d.token}` }));
    }
    expect(d.live.size).toBe(MAX_LIVE_SOCKETS);
    const extra = await connect(d, { authorization: `Bearer ${d.token}` });
    const code = await new Promise<number>((r) => extra.ws.once('close', (c) => r(c)));
    expect(code).toBe(1013);
  });

  it('closes sockets on shutdown', async () => {
    const d = await start();
    const { ws, next } = await connect(d, { authorization: `Bearer ${d.token}` });
    await next('hello');
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    await d.stop();
    daemon = null;
    expect(await closed).toBe(1001);
  });
});
