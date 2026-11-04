import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomToken, type Clock } from '@mindly/core';

/** Name of the dashboard session cookie. */
export const SESSION_COOKIE = 'mindly_session';
/** Lifetime of a one-time login code. */
export const LOGIN_CODE_TTL_MS = 60_000;
/** Lifetime of a dashboard session. */
export const SESSION_TTL_MS = 12 * 60 * 60_000;

const MAX_CODES = 32;
const MAX_SESSIONS = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string comparison (both sides hashed first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Reads the daemon bearer token, creating it (32 random bytes, base64url, mode 0600) when it does
 * not exist yet. Tightens the mode of an existing file and replaces a malformed one.
 */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o777) !== 0o600) {
      chmodSync(path, 0o600);
    }
    const existing = readFileSync(path, 'utf8').trim();
    if (TOKEN_RE.test(existing)) return existing;
  }
  const token = randomToken(32);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return token;
}

/**
 * In-memory authentication state of one daemon process: the bearer token, outstanding one-time
 * login codes and dashboard sessions. Codes and sessions are stored by their sha256 so a lookup
 * never compares secrets byte by byte.
 */
export class AuthState {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly clock: Clock,
  ) {}

  /** True when `header` is `Bearer <token>` with the daemon token. */
  checkBearer(header: string | undefined): boolean {
    if (typeof header !== 'string') return false;
    const m = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header.trim());
    if (!m) return false;
    return safeEqual(m[1] as string, this.token);
  }

  /** Issues a one-time login code valid for 60 s. */
  issueCode(): { code: string; expiresAt: number } {
    this.prune();
    while (this.codes.size >= MAX_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = randomToken(24);
    const expiresAt = this.clock.now() + LOGIN_CODE_TTL_MS;
    this.codes.set(digest(code).toString('hex'), expiresAt);
    return { code, expiresAt };
  }

  /** Consumes a login code (single use) and opens a session. Returns null for a bad code. */
  exchange(code: string): { sessionId: string; expiresAt: number } | null {
    this.prune();
    const key = digest(code).toString('hex');
    const exp = this.codes.get(key);
    this.codes.delete(key);
    if (exp === undefined || exp < this.clock.now()) return null;
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomToken(32);
    const expiresAt = this.clock.now() + SESSION_TTL_MS;
    this.sessions.set(digest(sessionId).toString('hex'), expiresAt);
    return { sessionId, expiresAt };
  }

  /** True when `sessionId` names a live session. */
  checkSession(sessionId: string | undefined): boolean {
    if (!sessionId || sessionId.length > 256) return false;
    const exp = this.sessions.get(digest(sessionId).toString('hex'));
    return exp !== undefined && exp >= this.clock.now();
  }

  /** Ends a session (logout). */
  revoke(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(digest(sessionId).toString('hex'));
  }

  /** Ends every session (shutdown). */
  clear(): void {
    this.codes.clear();
    this.sessions.clear();
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [k, exp] of this.codes) if (exp < now) this.codes.delete(k);
    for (const [k, exp] of this.sessions) if (exp < now) this.sessions.delete(k);
  }
}

/** Extracts one cookie value from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** `Set-Cookie` value for a new session. */
export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

/** `Set-Cookie` value that clears the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
