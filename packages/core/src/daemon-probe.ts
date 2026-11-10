import { connect } from 'node:net';

/**
 * What is on a port a `daemon.json` names:
 * - `daemon`: a Mindly daemon answers `GET /api/health`;
 * - `absent`: no Mindly daemon is there. The connection is refused, or whatever is there shows
 *   it is not Mindly: it answers with something else, or closes or resets the connection;
 * - `silent`: the connection stays open and no complete answer comes before the deadline. That
 *   can be a daemon busy with a long job (or a loaded machine), so it never counts as gone.
 */
export type PortOwner = 'daemon' | 'absent' | 'silent';

/** The daemon only ever listens here. */
export const DAEMON_PROBE_HOST = '127.0.0.1';
export const DAEMON_PROBE_TIMEOUT_MS = 2000;

const MAX_ANSWER_BYTES = 64 * 1024;
const STATUS_LINE_RE = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?\r\n/;

interface HttpAnswer {
  status: number;
  body: string;
}

/**
 * Reads `raw` as one HTTP/1.x response. `ended` says the peer closed the connection, which ends
 * a body that has no length. Returns `incomplete` while more bytes are needed and `invalid` once
 * this cannot be (or become) an HTTP response.
 */
function readAnswer(raw: Buffer, ended: boolean): HttpAnswer | 'incomplete' | 'invalid' {
  const text = raw.toString('latin1');
  const probe = 'HTTP/1.';
  if (!text.startsWith(probe.slice(0, Math.min(probe.length, text.length)))) return 'invalid';
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (text.includes('\r\n') && !STATUS_LINE_RE.test(text)) return 'invalid';
    return ended ? 'invalid' : 'incomplete';
  }
  const status = STATUS_LINE_RE.exec(text);
  if (!status) return 'invalid';
  const head = text.slice(0, headEnd).toLowerCase();
  // latin1 maps one byte to one character, so the index is a byte offset too.
  const rest = raw.subarray(headEnd + 4);
  const done = (body: Buffer): HttpAnswer => ({
    status: Number(status[1]),
    body: body.toString('utf8'),
  });
  if (/\r\ntransfer-encoding:[^\r\n]*chunked/.test(head)) {
    const chunks: Buffer[] = [];
    let at = 0;
    for (;;) {
      const lineEnd = rest.indexOf('\r\n', at);
      if (lineEnd < 0) return ended ? 'invalid' : 'incomplete';
      const size = Number.parseInt(rest.subarray(at, lineEnd).toString('latin1'), 16);
      if (!Number.isInteger(size) || size < 0) return 'invalid';
      if (size === 0) return done(Buffer.concat(chunks));
      const start = lineEnd + 2;
      if (rest.length < start + size + 2) return ended ? 'invalid' : 'incomplete';
      chunks.push(rest.subarray(start, start + size));
      at = start + size + 2;
    }
  }
  const length = /\r\ncontent-length:[ \t]*(\d+)[ \t]*(?:\r\n|$)/.exec(head);
  if (length) {
    const n = Number(length[1]);
    if (rest.length >= n) return done(rest.subarray(0, n));
    return ended ? 'invalid' : 'incomplete';
  }
  return ended ? done(rest) : 'incomplete';
}

function isHealth(answer: HttpAnswer): boolean {
  if (answer.status !== 200) return false;
  try {
    const body = JSON.parse(answer.body) as { ok?: unknown; version?: unknown } | null;
    return body?.ok === true && typeof body.version === 'string';
  } catch {
    return false;
  }
}

/**
 * Asks `port` on 127.0.0.1 who is there (see {@link PortOwner}). Never throws.
 *
 * It speaks HTTP over a plain socket instead of using `fetch`, because the difference that
 * matters is not visible in fetch errors: a program that closes or resets the connection, or
 * answers in another protocol, is clearly not a Mindly daemon (`absent`), while a connection
 * that stays open without an answer may be one that is busy (`silent`).
 */
export function probeDaemonPort(
  port: number,
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS,
): Promise<PortOwner> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.resolve('absent');
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const socket = connect({ host: DAEMON_PROBE_HOST, port });
    const finish = (owner: PortOwner): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(owner);
    };
    // Whatever was said so far, a peer that hangs up has shown it is not stuck.
    const judge = (ended: boolean): void => {
      const answer = readAnswer(received, ended);
      if (answer === 'incomplete') return;
      finish(answer !== 'invalid' && isHealth(answer) ? 'daemon' : 'absent');
    };
    const timer = setTimeout(() => finish('silent'), Math.max(1, timeoutMs));
    socket.on('connect', () => {
      socket.write(
        `GET /api/health HTTP/1.1\r\nHost: ${DAEMON_PROBE_HOST}:${port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_ANSWER_BYTES) finish('absent');
      else judge(false);
    });
    socket.on('end', () => judge(true));
    // Refused, reset or unreachable: nothing of Mindly's answers there.
    socket.on('error', () => finish('absent'));
    socket.on('close', () => {
      judge(true);
      finish('absent');
    });
  });
}
