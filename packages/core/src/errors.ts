export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'untrusted_project'
  | 'path_outside_project'
  | 'timeout'
  | 'unavailable'
  | 'internal';

/**
 * Error type used across Mindly. `code` is stable and safe to show to users and to return from
 * APIs; `message` must never contain secrets or raw user content.
 */
export class MindlyError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MindlyError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isMindlyError(err: unknown, code?: ErrorCode): err is MindlyError {
  return err instanceof MindlyError && (code === undefined || err.code === code);
}

export function notFound(what: string, id: string): MindlyError {
  return new MindlyError('not_found', `${what} not found`, { details: { id } });
}

export function invalidInput(message: string, details?: Record<string, unknown>): MindlyError {
  return new MindlyError('invalid_input', message, details ? { details } : undefined);
}

/** Converts any thrown value into a short, safe description for logs. */
export function describeError(err: unknown): string {
  if (err instanceof MindlyError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return 'unknown error';
}
