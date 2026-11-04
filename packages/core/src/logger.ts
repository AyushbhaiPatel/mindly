import { appendFileSync } from 'node:fs';
import { redactDeep } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/** Appends JSON lines to a file created with owner-only permissions. Never throws. */
export function fileSink(path: string): LogSink {
  return (line) => {
    try {
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break the caller (hooks in particular).
    }
  };
}

export const nullSink: LogSink = () => undefined;

/**
 * Structured JSON-lines logger. All fields are passed through the secret redactor, so callers can
 * log payload metadata without leaking credentials.
 */
export function createLogger(
  options: { level?: LogLevel; sink?: LogSink; base?: Record<string, unknown> } = {},
): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? stderrSink;
  const base = options.base ?? {};

  const log = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redactDeep({ t: new Date().toISOString(), level: lvl, msg, ...base, ...fields });
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ t: record.t, level: lvl, msg, note: 'unserializable fields' });
    }
    sink(line);
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => createLogger({ level, sink, base: { ...base, ...fields } }),
  };
}
