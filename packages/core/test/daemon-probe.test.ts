import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeDaemonPort } from '../src/index.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

/** A program on a 127.0.0.1 port that handles each connection with `onConnection`. */
async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    onConnection(socket);
  }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** Answers once the request has arrived, like a real server would. */
function afterRequest(reply: (socket: Socket) => void): (socket: Socket) => void {
  return (socket) => {
    socket.once('data', () => reply(socket));
  };
}

function http(status: string, body: string, headers: string[] = []): string {
  return [
    `HTTP/1.1 ${status}`,
    'content-type: application/json',
    `content-length: ${Buffer.byteLength(body)}`,
    ...headers,
    '',
    body,
  ].join('\r\n');
}

const HEALTH = JSON.stringify({ ok: true, version: '0.5.0' });

describe('probeDaemonPort', () => {
  it('finds a daemon by its health answer', async () => {
    const closing = await listen(afterRequest((s) => s.end(http('200 OK', HEALTH))));
    expect(await probeDaemonPort(closing)).toBe('daemon');
    // The connection may stay open: a body with a length, or the last chunk, completes it.
    const keepAlive = await listen(afterRequest((s) => s.write(http('200 OK', HEALTH))));
    expect(await probeDaemonPort(keepAlive)).toBe('daemon');
    const chunked = await listen(
      afterRequest((s) => {
        s.write('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n');
        s.write(`${HEALTH.length.toString(16)}\r\n${HEALTH}\r\n`);
        s.write('0\r\n\r\n');
      }),
    );
    expect(await probeDaemonPort(chunked)).toBe('daemon');
    const untilClose = await listen(
      afterRequest((s) =>
        s.end(`HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n${HEALTH}`),
      ),
    );
    expect(await probeDaemonPort(untilClose)).toBe('daemon');
  });

  it('nothing listening is absent', async () => {
    const port = await listen(() => undefined);
    const server = servers.pop() as Server;
    server.close();
    await once(server, 'close');
    expect(await probeDaemonPort(port)).toBe('absent');
    for (const bad of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(await probeDaemonPort(bad)).toBe('absent');
    }
  });

  it('a program that is clearly not Mindly is absent, and quickly', async () => {
    const others: Record<string, (socket: Socket) => void> = {
      'closes at once': (s) => s.end(),
      'resets at once': (s) => s.resetAndDestroy(),
      'closes after the request': afterRequest((s) => s.end()),
      'resets after the request': afterRequest((s) => s.resetAndDestroy()),
      'greets in another protocol': (s) => s.write('SSH-2.0-OpenSSH_9.6\r\n'),
      'answers in another protocol': afterRequest((s) => s.write('-ERR unknown command\r\n')),
      'answers in binary': afterRequest((s) =>
        s.write(Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 70])),
      ),
      'answers 404': afterRequest((s) => s.end(http('404 Not Found', '{"error":"nope"}'))),
      'answers 200 with another body': afterRequest((s) => s.end(http('200 OK', '{"ok":true}'))),
      'answers 200 without JSON': afterRequest((s) => s.end(http('200 OK', '<html></html>'))),
      'hangs up in the middle of an answer': afterRequest((s) =>
        s.end('HTTP/1.1 200 OK\r\ncontent-le'),
      ),
      'cuts the body short': afterRequest((s) =>
        s.end('HTTP/1.1 200 OK\r\ncontent-length: 500\r\n\r\n{"ok":true'),
      ),
    };
    for (const [what, behaviour] of Object.entries(others)) {
      const port = await listen(behaviour);
      const started = Date.now();
      expect(await probeDaemonPort(port, 5000), what).toBe('absent');
      // Decided by what the program did, not by waiting out the deadline.
      expect(Date.now() - started, what).toBeLessThan(2500);
    }
  });

  it('a connection held open without a complete answer is silent', async () => {
    const mute = await listen(() => undefined);
    expect(await probeDaemonPort(mute, 300)).toBe('silent');
    // Started to answer like a daemon and stalled: still there, still not answering.
    const stalled = await listen(
      afterRequest((s) => s.write('HTTP/1.1 200 OK\r\ncontent-length: 40\r\n\r\n{"ok":')),
    );
    expect(await probeDaemonPort(stalled, 300)).toBe('silent');
  });
});
