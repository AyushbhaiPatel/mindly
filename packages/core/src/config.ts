import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { z } from 'zod';
import { AgentKindSchema } from './domain.js';
import { MindlyError } from './errors.js';
import { sha256 } from './text.js';

const MAX_CONFIG_BYTES = 256 * 1024;

/** True for `localhost`, `127.0.0.0/8` and `::1`. Hostnames are not resolved. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Why a notification channel URL cannot be used, or null. The same rules are enforced again when
 * a notification is sent; checking here means a URL that could never work is refused when it is
 * set, with the reason, and not only skipped later. The message never repeats the URL.
 */
export function channelUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url is not valid';
  }
  if (url.username || url.password) return 'url must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'url must use https (http only for localhost)';
}

const ChannelUrl = z.url().superRefine((raw, ctx) => {
  const problem = channelUrlProblem(raw);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const NotifyChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('desktop') }),
  z.object({
    type: z.literal('ntfy'),
    /**
     * Base URL of an ntfy server (self-hosted or ntfy.sh). Must be https unless localhost. A
     * query string is kept (`?auth=...` carries an access token).
     */
    url: ChannelUrl,
    topic: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'topic must be 8-64 url-safe characters'),
  }),
  z.object({
    type: z.literal('webhook'),
    url: ChannelUrl,
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

/**
 * Sent by default once a channel is configured: an agent out of usage, a critical conflict, a
 * check that started failing. (`agent_blocked` is accepted for older config files; nothing
 * sends it.)
 */
const DEFAULT_NOTIFY_TRIGGERS: (typeof NOTIFY_TRIGGERS)[number][] = [
  'rate_limited',
  'conflict_critical',
  'check_failed',
];

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
      /**
       * What is sent once a channel is configured. The scheduled standup (`standup.time`) is
       * sent whatever is listed here: setting its time is asking for it.
       */
      triggers: z.array(z.enum(NOTIFY_TRIGGERS)).default(DEFAULT_NOTIFY_TRIGGERS),
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
  checkpoints: z
    .object({
      /** Save a copy of the code after every agent edit (what `mindly bisect` searches). */
      enabled: z.boolean().default(true),
      keepDays: z.number().int().min(1).max(3650).default(14),
      maxPerWorktree: z.number().int().min(10).max(100_000).default(5000),
    })
    .prefault({}),
  track: z
    .object({
      /** Folder segments that make an area of `mindly track` (`src/api` at 2). */
      areaDepth: z.number().int().min(1).max(4).default(2),
      /** Edits an agent needs in an area before any rate is shown there. */
      minEdits: z.number().int().min(1).max(100_000).default(20),
      /** Sessions with edits an agent needs in an area before any rate is shown there. */
      minSessions: z.number().int().min(1).max(10_000).default(3),
    })
    .prefault({}),
  sentinel: z
    .object({
      /**
       * Run the project's trusted checks in the background (daemon) as agents edit, and find the
       * edit that broke one. Off by default: it runs your test commands on its own.
       */
      enabled: z.boolean().default(false),
      /** Check a working tree once this many new steps have piled up since the last check. */
      everySteps: z.number().int().min(1).max(1000).default(10),
      /** Or once no new step has come for this long (the agents paused). */
      quietSec: z.number().int().min(10).max(3600).default(60),
      /** Bisects the sentinel may start per project in 24 hours (each runs a check several times). */
      maxBisectsPerDay: z.number().int().min(0).max(1000).default(20),
    })
    .prefault({}),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export function defaultUserConfig(): UserConfig {
  return UserConfigSchema.parse({});
}

/**
 * Reads a small regular file safely: refuses symlinks, FIFOs, devices and directories (a hostile
 * repository could point its config at `/dev/zero` or a FIFO to hang every hook), opens without
 * following links and without blocking, and never reads more than `max` bytes.
 */
export function readRegularFileBounded(path: string, max: number): string {
  const st = lstatSync(path);
  if (!st.isFile()) throw new MindlyError('invalid_input', 'config path is not a regular file');
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new MindlyError('invalid_input', 'config path is not a regular file');
    }
    const buf = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > max) throw new MindlyError('invalid_input', 'config file too large');
    }
    return buf.subarray(0, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readBoundedJson(path: string): unknown {
  const raw = readRegularFileBounded(path, MAX_CONFIG_BYTES);
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new MindlyError('invalid_input', `config file is not valid JSON: ${path}`, { cause });
  }
}

/**
 * The notification channels of a raw config whose URL cannot be used, with the reason. A config
 * file written before URLs were checked may hold one; it never worked.
 */
function unusableChannels(raw: unknown): { index: number; type: string; problem: string }[] {
  const channels = (raw as { notify?: { channels?: unknown } } | null)?.notify?.channels;
  if (!Array.isArray(channels)) return [];
  const out: { index: number; type: string; problem: string }[] = [];
  channels.forEach((c: unknown, index) => {
    const ch = c as { type?: unknown; url?: unknown } | null;
    if (typeof ch?.url !== 'string' || (ch.type !== 'webhook' && ch.type !== 'ntfy')) return;
    const problem = channelUrlProblem(ch.url);
    if (problem) out.push({ index, type: ch.type, problem });
  });
  return out;
}

/** The channels in the config file at `path` that are left out when it is read, with the reason. */
export function unusableNotifyChannels(path: string): { type: string; problem: string }[] {
  if (!existsSync(path)) return [];
  try {
    return unusableChannels(readBoundedJson(path)).map(({ type, problem }) => ({ type, problem }));
  } catch {
    return [];
  }
}

/**
 * Reads the user config. A notification channel whose URL cannot be used is left out, so a file
 * written before URLs were checked does not stop every command; `mindly config set` refuses such
 * a URL and `mindly notify test` names the channels that were left out.
 */
export function loadUserConfig(path: string): UserConfig {
  if (!existsSync(path)) return defaultUserConfig();
  let raw = readBoundedJson(path);
  const unusable = new Set(unusableChannels(raw).map((c) => c.index));
  if (unusable.size > 0) {
    const src = raw as { notify: { channels: unknown[] } };
    raw = {
      ...src,
      notify: { ...src.notify, channels: src.notify.channels.filter((_, i) => !unusable.has(i)) },
    };
  }
  const parsed = UserConfigSchema.safeParse(raw);
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
  /**
   * What the sentinel runs after agent edits: a subset of `checks` by name (default: all), and a
   * setup command for its scratch tree (e.g. installing dependencies), run again only when a
   * lockfile or manifest changes.
   */
  sentinel: z
    .object({
      checks: z
        .array(z.string().regex(/^[A-Za-z0-9 _.-]{1,64}$/))
        .min(1)
        .max(20)
        .optional(),
      setup: ArgvSchema.optional(),
      setupTimeoutSec: z.number().int().min(5).max(3600).default(600),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** sha256 of the raw file; compared against the project's trusted hash. */
  hash: string | null;
}

export function loadProjectConfig(path: string): LoadedProjectConfig {
  if (!existsSync(path)) return { config: ProjectConfigSchema.parse({}), hash: null };
  const raw = readRegularFileBounded(path, MAX_CONFIG_BYTES);
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
