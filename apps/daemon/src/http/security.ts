import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readCookie, SESSION_COOKIE, type AuthState } from '../auth.js';
import { sendError } from './errors.js';

/** Content Security Policy sent with every response (the dashboard build is made for it). */
export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";

/** Headers set on every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** How a request was authenticated. */
export type AuthKind = 'bearer' | 'cookie' | null;

declare module 'fastify' {
  interface FastifyRequest {
    mindlyAuth: AuthKind;
  }
}

/** Mutable listener info: the port is only known after `listen`. */
export interface Listener {
  port: number;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `Host` values accepted for `port` (DNS-rebinding defence). */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** `Origin` values accepted for `port`. */
export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? undefined : v;
}

/**
 * Installs the global guards: Host allow-list (421) and Origin allow-list (403) on every request,
 * plus the security headers on every response and `Cache-Control: no-store` under `/api`.
 */
export function installSecurity(app: FastifyInstance, listener: Listener): void {
  app.decorateRequest('mindlyAuth', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = listener.port;
    const host = header(request, 'host');
    if (!host || !allowedHosts(port).includes(host.toLowerCase())) {
      return sendError(reply, 'bad_host', 'Use http://127.0.0.1:<port> to reach the daemon.');
    }
    const origin = header(request, 'origin');
    if (origin !== undefined && !allowedOrigins(port).includes(origin.toLowerCase())) {
      return sendError(reply, 'forbidden', 'Cross-origin requests are not allowed.');
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    const path = request.url.split('?')[0] ?? '';
    if (path === '/api' || path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

/**
 * Guard for public API routes: state changes still need `X-Mindly-CSRF: 1` so a cross-site form
 * can never reach them.
 */
export function publicGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (MUTATING.has(request.method.toUpperCase()) && header(request, 'x-mindly-csrf') !== '1') {
      return sendError(reply, 'forbidden', 'Missing X-Mindly-CSRF header.');
    }
  };
}

/**
 * Guard for every authenticated API route (installed in the API plugin scope, so it applies
 * however the URL is spelled): a valid bearer token or session cookie (401); for
 * cookie-authenticated state changes a matching Origin and `X-Mindly-CSRF: 1`, and for
 * cookie-authenticated WebSocket upgrades a matching Origin (403).
 */
export function authGuard(auth: AuthState, listener: Listener) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = header(request, 'authorization');
    if (authorization !== undefined) {
      if (!auth.checkBearer(authorization)) {
        return sendError(reply, 'unauthenticated', 'Invalid token.');
      }
      request.mindlyAuth = 'bearer';
      reply.header('Cache-Control', 'no-store');
      return;
    }
    const cookie = readCookie(header(request, 'cookie'), SESSION_COOKIE);
    if (!auth.checkSession(cookie)) {
      return sendError(reply, 'unauthenticated', 'Sign in with `mindly dashboard`.');
    }
    request.mindlyAuth = 'cookie';
    reply.header('Cache-Control', 'no-store');
    const origin = header(request, 'origin');
    const originOk =
      origin !== undefined && allowedOrigins(listener.port).includes(origin.toLowerCase());
    const upgrade = (header(request, 'upgrade') ?? '').toLowerCase() === 'websocket';
    if (upgrade && !originOk) {
      return sendError(reply, 'forbidden', 'WebSocket origin mismatch.');
    }
    const method = request.method.toUpperCase();
    if (MUTATING.has(method) && (!originOk || header(request, 'x-mindly-csrf') !== '1')) {
      return sendError(reply, 'forbidden', 'Missing Origin or X-Mindly-CSRF header.');
    }
  };
}
