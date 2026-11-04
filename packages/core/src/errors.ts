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
 * Error type used across Synapse. `code` is stable and safe to show to users and to return from
 * APIs; `message` must never contain secrets or raw user content.
 */
export class SynapseError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SynapseError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isSynapseError(err: unknown, code?: ErrorCode): err is SynapseError {
  return err instanceof SynapseError && (code === undefined || err.code === code);
}

export function notFound(what: string, id: string): SynapseError {
  return new SynapseError('not_found', `${what} not found`, { details: { id } });
}

export function invalidInput(message: string, details?: Record<string, unknown>): SynapseError {
  return new SynapseError('invalid_input', message, details ? { details } : undefined);
}

/** Converts any thrown value into a short, safe description for logs. */
export function describeError(err: unknown): string {
  if (err instanceof SynapseError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return 'unknown error';
}
