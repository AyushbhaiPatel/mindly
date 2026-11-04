import { describeError, isMindlyError, type ErrorCode, type Logger } from '@mindly/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Error codes the daemon returns: every core `ErrorCode` plus transport-level ones. */
export type ApiErrorCode = ErrorCode | 'unauthenticated' | 'too_large' | 'bad_host';

const STATUS: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  path_outside_project: 400,
  unauthenticated: 401,
  forbidden: 403,
  untrusted_project: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  bad_host: 421,
  internal: 500,
  unavailable: 503,
  timeout: 504,
};

/** An error that maps directly to an HTTP status and API error code. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** Sends `{ error: { code, message } }` with the status for `code`. */
export function sendError(reply: FastifyReply, code: ApiErrorCode, message: string): FastifyReply {
  return reply
    .code(STATUS[code])
    .type('application/json; charset=utf-8')
    .send({ error: { code, message } });
}

/** Formats zod issues without echoing input values. */
export function zodMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join('; ')
    .slice(0, 500);
}

/** Parses `value` with `schema`, throwing an `invalid_input` ApiError on failure. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError('invalid_input', zodMessage(r.error));
  return r.data;
}

/**
 * Fastify error handler: known errors keep their code and message; everything else becomes a
 * generic 500 whose details only go to the log.
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (err instanceof ApiError) return sendError(reply, err.code, err.message);
    if (err instanceof z.ZodError) return sendError(reply, 'invalid_input', zodMessage(err));
    if (isMindlyError(err)) {
      const status = STATUS[err.code];
      if (status >= 500) {
        logger.error('request failed', { url: routeOf(request), error: describeError(err) });
        if (err.code === 'internal') return sendError(reply, 'internal', 'Internal error.');
      }
      return sendError(reply, err.code, err.message);
    }
    const fe = err as { statusCode?: unknown; code?: unknown };
    const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
    if (status === 413) return sendError(reply, 'too_large', 'Request body is too large.');
    if (status === 415)
      return sendError(reply, 'invalid_input', 'Content-Type must be application/json.');
    if (status >= 400 && status < 500) {
      return sendError(reply, 'invalid_input', 'Malformed request.');
    }
    logger.error('request failed', { url: routeOf(request), error: describeError(err) });
    return sendError(reply, 'internal', 'Internal error.');
  };
}

function routeOf(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0] ?? ''}`;
}
