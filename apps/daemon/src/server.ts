import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolveLayout } from '@mindly/core';
import type { Mindly } from '@mindly/engine';
import type { AuthState } from './auth.js';
import { errorHandler, sendError } from './http/errors.js';
import { installSecurity, type Listener } from './http/security.js';
import type { JobContext } from './jobs/context.js';
import type { LiveFeed } from './live.js';
import { registerApi } from './routes/api.js';

/** Maximum request body size (256 KB). */
export const BODY_LIMIT = 256 * 1024;

/**
 * Default location of the built dashboard: `dashboard/` in the installed `mindly-cli` package,
 * or `apps/dashboard/dist` in a monorepo checkout.
 */
export function defaultDashboardDir(): string {
  return resolveLayout(import.meta.url).dashboardDir;
}

/** Everything the HTTP server is built from. */
export interface ServerDeps {
  mindly: Mindly;
  auth: AuthState;
  listener: Listener;
  jobs: JobContext;
  live: LiveFeed;
  /** Directory with the built dashboard; null disables static serving. */
  dashboardDir: string | null;
}

/**
 * Builds the Fastify app (not listening): security guards, JSON-only bodies capped at 256 KB,
 * the API, the live WebSocket and the dashboard's static files with an SPA fallback.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
    return503OnClosing: true,
    forceCloseConnections: true,
  });
  // Only JSON bodies: no text/plain, so a cross-site form can never post a parsable body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: BODY_LIMIT },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text.trim() === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        const err = new Error('invalid JSON body') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  const logger = deps.jobs.logger;
  app.setErrorHandler(errorHandler(logger));
  // Registered before the guards so its onRequest hook always marks upgrade requests; a guard
  // that rejects an upgrade then still gets the raw socket destroyed after the response.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });
  installSecurity(app, deps.listener);

  const dir = deps.dashboardDir;
  const hasDashboard =
    dir !== null && existsSync(join(dir, 'index.html')) && statSync(dir).isDirectory();
  if (hasDashboard) {
    await app.register(fastifyStatic, {
      root: dir,
      prefix: '/',
      index: ['index.html'],
      dotfiles: 'deny',
      wildcard: true,
      decorateReply: true,
    });
  }

  await registerApi(app, deps);

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isApi = path === '/api' || path.startsWith('/api/');
    if (!isApi && hasDashboard && (request.method === 'GET' || request.method === 'HEAD')) {
      // SPA fallback: client-side routes load the app shell.
      return reply.sendFile('index.html');
    }
    if (!isApi && !hasDashboard && request.method === 'GET' && path === '/') {
      return sendError(
        reply,
        'not_found',
        'The dashboard is not built (pnpm --filter @mindly/dashboard build).',
      );
    }
    return sendError(reply, 'not_found', 'Not found.');
  });

  return app;
}
