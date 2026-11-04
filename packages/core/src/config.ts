import { existsSync, readFileSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { AgentKindSchema } from './domain.js';
import { MindlyError } from './errors.js';
import { sha256 } from './text.js';

const MAX_CONFIG_BYTES = 256 * 1024;

const NotifyChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('desktop') }),
  z.object({
    type: z.literal('ntfy'),
    /** Base URL of an ntfy server (self-hosted or ntfy.sh). Must be https unless localhost. */
    url: z.url(),
    topic: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'topic must be 8-64 url-safe characters'),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z.url(),
  }),
]);
export type NotifyChannel = z.infer<typeof NotifyChannelSchema>;

export const NOTIFY_TRIGGERS = [
  'agent_blocked',
  'rate_limited',
  'conflict_critical',
  'check_failed',
  'review_ready',
  'standup',
] as const;

export const UserConfigSchema = z.object({
  context: z
    .object({
      sessionStartTokens: z.number().int().min(200).max(20_000).default(1800),
      promptTokens: z.number().int().min(100).max(10_000).default(700),
      preToolTokens: z.number().int().min(50).max(5_000).default(300),
    })
    .prefault({}),
  hooks: z
    .object({
      timeoutMs: z.number().int().min(200).max(10_000).default(1500),
    })
    .prefault({}),
  rules: z
    .object({
      autoCapture: z.boolean().default(true),
    })
    .prefault({}),
  retention: z
    .object({
      promptsDays: z.number().int().min(1).max(3650).default(30),
      eventsDays: z.number().int().min(7).max(3650).default(180),
    })
    .prefault({}),
  llm: z
    .object({
      provider: z.enum(['none', 'ollama', 'anthropic', 'openai']).default('none'),
      model: z.string().max(200).optional(),
      /** Only used by `ollama`; must point at localhost unless allowRemote is set. */
      baseUrl: z.url().optional(),
      allowRemote: z.boolean().default(false),
    })
    .prefault({}),
  notify: z
    .object({
      channels: z.array(NotifyChannelSchema).max(10).default([]),
      triggers: z.array(z.enum(NOTIFY_TRIGGERS)).default(['agent_blocked', 'rate_limited']),
    })
    .prefault({}),
  failover: z
    .object({
      enabled: z.boolean().default(true),
      /** When true Mindly may launch the next agent headlessly after a rate limit. */
      autoLaunch: z.boolean().default(false),
      order: z.array(AgentKindSchema).default(['claude-code', 'codex']),
    })
    .prefault({}),
  shadowMerge: z
    .object({
      enabled: z.boolean().default(true),
      intervalSec: z.number().int().min(15).max(3600).default(90),
    })
    .prefault({}),
  standup: z
    .object({
      /** Local time HH:MM to push the standup digest through the pager; unset disables. */
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
    })
    .prefault({}),
  daemon: z
    .object({
      port: z.number().int().min(0).max(65_535).default(7878),
    })
    .prefault({}),
  redaction: z
    .object({
      extraPatterns: z.array(z.string().max(500)).max(50).default([]),
      denyPaths: z.array(z.string().max(512)).max(200).default([]),
    })
    .prefault({}),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export function defaultUserConfig(): UserConfig {
  return UserConfigSchema.parse({});
}

function readBoundedJson(path: string): unknown {
  const size = statSync(path).size;
  if (size > MAX_CONFIG_BYTES) {
    throw new MindlyError('invalid_input', `config file too large: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new MindlyError('invalid_input', `config file is not valid JSON: ${path}`, { cause });
  }
}

export function loadUserConfig(path: string): UserConfig {
  if (!existsSync(path)) return defaultUserConfig();
  const parsed = UserConfigSchema.safeParse(readBoundedJson(path));
  if (!parsed.success) {
    throw new MindlyError('invalid_input', `invalid config: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Atomically writes JSON with owner-only permissions. */
export function writeJsonFile(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------------------------
// Project configuration (`<repo>/.mindly/config.json`). Untrusted until the user runs
// `mindly trust`; commands in it are never executed while untrusted or after it changes.
// ---------------------------------------------------------------------------------------------

const ArgvSchema = z
  .array(z.string().min(1).max(1000))
  .min(1)
  .max(64)
  .refine((argv) => !argv.some((a) => a.includes('\0')), 'argv must not contain NUL bytes');

export const ProjectConfigSchema = z.object({
  /** Commands run against the shadow-merged tree (e.g. typecheck, unit tests). */
  checks: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9 _.-]{1,64}$/),
        argv: ArgvSchema,
        timeoutSec: z.number().int().min(5).max(1800).default(300),
      }),
    )
    .max(20)
    .default([]),
  /** Extra globs Mindly ignores for capture and analysis. */
  ignore: z.array(z.string().max(512)).max(200).default([]),
  /** Optional fixed context included in every session start (subject to trust labelling). */
  notes: z.string().max(4000).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** sha256 of the raw file; compared against the project's trusted hash. */
  hash: string | null;
}

export function loadProjectConfig(path: string): LoadedProjectConfig {
  if (!existsSync(path)) return { config: ProjectConfigSchema.parse({}), hash: null };
  const size = statSync(path).size;
  if (size > MAX_CONFIG_BYTES) {
    throw new MindlyError('invalid_input', 'project config too large');
  }
  const raw = readFileSync(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new MindlyError('invalid_input', 'project config is not valid JSON', { cause });
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new MindlyError(
      'invalid_input',
      `invalid project config: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { config: parsed.data, hash: sha256(raw) };
}
