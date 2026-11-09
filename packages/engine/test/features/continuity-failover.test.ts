import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFailoverModule,
  detectRateLimit,
  failoverService,
  MAX_TRANSCRIPT_TAIL_BYTES,
  parseTranscriptTail,
  RATE_LIMIT_HANDOFF_MAX_AGE_MS,
  readTranscriptTail,
  recentAgentTexts,
  type Mindly,
} from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { make, tmp } from './continuity-helpers.js';

const SECRET_PROMPT = 'Refactor the zebra-billing module carefully';

function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function assistant(text: string, ts: number): object {
  return {
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

async function claudeTurn(mindly: Mindly, root: string, clockAdvance: () => void) {
  await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
  clockAdvance();
  await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: SECRET_PROMPT }));
  clockAdvance();
  await mindly.hooks.handle(
    event(root, 'claude-code', 'cc', 'post_tool', {
      tool: writeTool('src/auth.ts', 'export function login() { return 1; }'),
    }),
  );
  clockAdvance();
}

function setupFailover(opts: Parameters<typeof make>[0] = {}, homeDir?: string) {
  const env = make(opts);
  env.mindly.use(createFailoverModule(homeDir ? { homeDir } : {}));
  return env;
}

describe('rate-limit failover', () => {
  it('detects a usage limit in the transcript tail and hands off to codex', async () => {
    const { root, clock, mindly, sent } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    mindly.tasks.create({
      projectId: pid,
      title: 'Migrate auth to sessions',
      owner: cc,
      plan: ['add session store', 'switch login'],
    });

    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        {
          type: 'user',
          timestamp: new Date(clock.t - 2000).toISOString(),
          message: { role: 'user', content: SECRET_PROMPT },
        },
        assistant('Working on it.', clock.t - 1000),
        assistant('Claude usage limit reached. Your limit will reset at 3pm.', clock.t),
      ]),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
    );

    expect(mindly.store.sessions.get(cc.id).status).toBe('rate_limited');
    const handoffs = mindly.store.handoffs.list(pid);
    expect(handoffs).toHaveLength(1);
    const h = handoffs[0]!;
    expect(h.reason).toBe('rate_limit');
    expect(h.toAgentKind).toBe('codex');
    expect(h.packet.goal).toBe('Migrate auth to sessions');
    expect(h.packet.nextSteps).toEqual(['add session store', 'switch login']);
    expect(h.packet.filesChanged).toEqual(['src/auth.ts']);
    expect(h.packet.recentPrompts).toEqual([SECRET_PROMPT]);
    expect(h.packet.branch).toBe('main');
    expect(h.packet.headCommit).toBe('abc1234def5678');
    expect(
      mindly.store.events
        .query(pid, { types: ['session.rate_limited'] })
        .map((e) => e.payload.signature),
    ).toEqual(['claude.usage_limit_reached']);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.trigger).toBe('rate_limited');
    expect(sent[0]!.body).toContain('handoff ready for codex');
    expect(JSON.stringify(sent)).not.toMatch(/zebra|Migrate auth/i);

    // A second stop with the same transcript does not re-trigger.
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
    );
    expect(mindly.store.handoffs.list(pid)).toHaveLength(1);
    expect(sent).toHaveLength(1);

    // The next Codex session picks it up at session start.
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Handoff for you');
    expect(cx.context).toContain('it hit its usage limit');
    expect(cx.context).toContain('Migrate auth to sessions');
    expect(mindly.store.handoffs.get(h.id).status).toBe('claimed');
    expect(failoverService(mindly).pendingLaunch()).toHaveLength(0);
  });

  it('detects Codex limits in the last message and targets the next agent in order', async () => {
    const { root, clock, mindly } = setupFailover();
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'fix the tests' }));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'stop', {
        lastMessage: "You've hit your usage limit. Upgrade to Pro or try again later.",
      }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const [h] = mindly.store.handoffs.list(pid);
    expect(h?.toAgentKind).toBe('claude-code');
    const pending = failoverService(mindly).pendingLaunch(pid);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toAgentKind: 'claude-code', autoLaunch: false });
  });

  it('ignores limit messages older than the last prompt and user-side text', async () => {
    const { root, clock, mindly, sent } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const transcript = join(root, 'old.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        assistant('Claude usage limit reached.', clock.t - 60_000),
        {
          type: 'user',
          timestamp: new Date(clock.t).toISOString(),
          message: { role: 'user', content: 'usage limit reached?' },
        },
        assistant('Here is the refactor; I also added a rate limit middleware.', clock.t),
      ]),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('does nothing when failover is disabled', async () => {
    const { root, clock, mindly, sent } = setupFailover({
      config: (c) => {
        c.failover.enabled = false;
      },
    });
    await claudeTurn(mindly, root, () => clock.advance(1000));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { lastMessage: 'Claude usage limit reached.' }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
    expect(mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!.status).toBe('idle');
    expect(sent).toHaveLength(0);
  });

  it('ignores a transcript symlink that points outside the home directory', async () => {
    const home = tmp('syn-home-');
    const outside = tmp('syn-outside-');
    const { root, clock, mindly } = setupFailover({}, home);
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const target = join(outside, 't.jsonl');
    writeFileSync(target, jsonl([assistant('Claude usage limit reached.', clock.t)]));
    const link = join(root, 'link.jsonl');
    symlinkSync(target, link);

    expect(readTranscriptTail(link, home)).toBeNull();
    expect(readTranscriptTail(target, home)).not.toBeNull();
    const inside = join(home, 'in.jsonl');
    writeFileSync(inside, 'hello\n');
    const insideLink = join(outside, 'in-link.jsonl');
    symlinkSync(inside, insideLink);
    expect(readTranscriptTail(insideLink, home)).toBe('hello\n');
    expect(readTranscriptTail('relative/path.jsonl', home)).toBeNull();
    expect(readTranscriptTail(root, home)).toBeNull();

    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'stop', { transcriptPath: link }));
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
  });

  it('reads only the bounded tail of a huge transcript', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const filler = jsonl(
      Array.from({ length: 4000 }, (_, i) => assistant(`step ${i} ${'x'.repeat(400)}`, clock.t)),
    );
    const big = join(root, 'big.jsonl');
    writeFileSync(big, jsonl([assistant('Claude usage limit reached.', clock.t)]) + filler);
    const tail = readTranscriptTail(big)!;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX_TRANSCRIPT_TAIL_BYTES);
    expect(tail.startsWith('{')).toBe(true);

    const started = Date.now();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'stop', { transcriptPath: big }));
    expect(Date.now() - started).toBeLessThan(1000);
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
  });

  it('matches signatures heuristically per agent', () => {
    expect(detectRateLimit('claude-code', ['API Error: 429 {"type":"rate_limit_error"}'])).toBe(
      'claude.rate_limit_error',
    );
    expect(detectRateLimit('claude-code', ['5-hour limit reached'])).toBe('claude.five_hour_limit');
    expect(detectRateLimit('codex', ['stream error: rate limit reached, retry in 30s'])).toBe(
      'codex.rate_limit',
    );
    expect(detectRateLimit('cursor', ['HTTP 429 Too Many Requests'])).toBe(
      'generic.too_many_requests',
    );
    expect(detectRateLimit('codex', ['You\u2019ve hit your usage limit'])).toBe(
      'codex.usage_limit',
    );
    expect(detectRateLimit('codex', ['Fixed the bug on line 429 of parser.ts'])).toBeNull();
    expect(detectRateLimit('codex', ['Added rate limit middleware to the API'])).toBeNull();
  });

  it('does not take an agent writing about limits for an agent hitting one', () => {
    const prose = [
      'Done. The /login endpoint is now rate limited to 5 attempts per minute per IP.',
      'I added a handler that returns HTTP 429 with a Retry-After header.',
      'The client now retries when the server responds with "Too Many Requests".',
      'Fixed: the test expected rate_limit_error but the mock returned overloaded_error.',
      'The docs say the free tier limit will reset monthly; I updated the README.',
      'Added a quota exceeded banner to the billing page.',
      'Summary:\n- Rate limit exceeded handling added to the client\n- Rate limited the export job',
      '- 429 responses are now retried with backoff',
      'Usage limit reached is now a typed error (`UsageLimitError`).',
      'The run failed with:\n```\nError: rate limit exceeded\nHTTP 429 Too Many Requests\n```\nI added a retry.',
      `Usage limit reached. ${'x'.repeat(400)}`,
    ];
    for (const kind of ['claude-code', 'codex', 'gemini', 'cursor']) {
      for (const text of prose) {
        expect([kind, text, detectRateLimit(kind, [text])]).toEqual([kind, text, null]);
      }
    }
  });

  it('still recognises the notices agents print', () => {
    const notices: [string, string, string][] = [
      [
        'claude-code',
        'Claude usage limit reached. Your limit will reset at 3pm.',
        'claude.usage_limit_reached',
      ],
      ['claude-code', 'Your limit will reset at 3pm (Europe/Berlin).', 'claude.limit_will_reset'],
      ['claude-code', '\u23bf  5-hour limit reached \u2219 resets 5pm', 'claude.five_hour_limit'],
      [
        'claude-code',
        'You\u2019ve hit your session limit \u00b7 resets 3pm',
        'claude.limit_reached',
      ],
      ['claude-code', 'Weekly limit reached \u2219 resets Mon 9am', 'claude.limit_reached'],
      ['claude-code', 'Session limit reached \u2219 resets 5pm', 'claude.limit_reached'],
      ['claude-code', "You've reached your usage limit", 'generic.usage_limit'],
      [
        'claude-code',
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
        'claude.rate_limit_error',
      ],
      ['claude-code', 'Working on it.\n\nAPI Error: 429 Too Many Requests', 'claude.http_429'],
      [
        'codex',
        "You've hit your usage limit. Upgrade to Pro or try again later.",
        'codex.usage_limit',
      ],
      ['codex', 'stream error: rate limit reached, retry in 30s', 'codex.rate_limit'],
      ['codex', 'Rate limited. Please try again in 20s.', 'codex.rate_limit'],
      ['gemini', 'Resource has been exhausted (e.g. check quota).', 'gemini.resource_exhausted'],
      ['gemini', '[API Error: got status: RESOURCE_EXHAUSTED]', 'gemini.resource_exhausted_status'],
      ['gemini', 'You have exhausted your daily quota on this model.', 'gemini.quota_exhausted'],
      ['cursor', "You've hit your usage limit", 'generic.usage_limit'],
      ['cursor', 'Error: Rate limit exceeded. Try again in 5 minutes.', 'generic.rate_limit'],
      ['cursor', 'Quota exceeded. Check your plan and billing details.', 'generic.quota_exceeded'],
      ['cursor', 'HTTP 429 Too Many Requests', 'generic.too_many_requests'],
    ];
    for (const [kind, text, id] of notices) {
      expect([text, detectRateLimit(kind, [text])]).toEqual([text, id]);
    }
  });

  it('recognises a notice behind a status glyph, a timestamp or a failure label', () => {
    const notices: [string, string, string][] = [
      ['codex', '\u26a0 You\u2019ve hit your usage limit. Try again at 3pm', 'codex.usage_limit'],
      ['codex', '\u25a0 stream error: rate limit reached', 'codex.rate_limit'],
      ['claude-code', '[12:03:11] Usage limit reached', 'claude.usage_limit_reached'],
      ['claude-code', '2026-01-01T12:00:00Z Usage limit reached.', 'claude.usage_limit_reached'],
      ['claude-code', '[2026-01-01 12:00:00] [error] Weekly limit reached', 'claude.limit_reached'],
      ['cursor', 'Request failed: 429 Too Many Requests', 'generic.too_many_requests'],
      ['cursor', '\u2717 Usage limit reached', 'generic.usage_limit'],
      ['cursor', 'ERROR  rate limit exceeded', 'generic.rate_limit'],
      ['cursor', '\u2502 \ud83d\udeab Fatal: quota exceeded', 'generic.quota_exceeded'],
      ['cursor', 'Warning: usage limit reached, resets at 5pm', 'generic.usage_limit'],
      [
        'gemini',
        '\u2715 [API Error: got status: RESOURCE_EXHAUSTED]',
        'gemini.resource_exhausted_status',
      ],
    ];
    for (const [kind, text, id] of notices) {
      expect([text, detectRateLimit(kind, [text])]).toEqual([text, id]);
    }
  });

  it('still ignores prose however the line is decorated', () => {
    const prose = [
      'Done. The /login endpoint is now rate limited to 5 attempts per minute per IP.',
      'I added a handler that returns HTTP 429 with a Retry-After header.',
      'The client now retries when the server responds with "Too Many Requests".',
      'Fixed: the test expected rate_limit_error but the mock returned overloaded_error.',
      'The docs say the free tier limit will reset monthly; I updated the README.',
      'Added a quota exceeded banner to the billing page.',
    ];
    const extra = [
      'Error handling for rate_limit_error is now covered by a test.',
      'Warning: the mock returns rate_limit_error for every third call.',
      'Failed requests are retried when the rate limit is exceeded.',
      '`Usage limit reached`',
      '"Too Many Requests"',
      '12:30 standup notes: usage limit reached twice last week',
    ];
    const decorate = [
      (t: string) => t,
      (t: string) => `\u2705 ${t}`,
      (t: string) => `\u2022 ${t}`,
      (t: string) => `[12:03:11] ${t}`,
      (t: string) => `> **${t}**`,
    ];
    for (const kind of ['claude-code', 'codex', 'gemini', 'cursor']) {
      for (const text of [...prose, ...extra]) {
        for (const d of decorate) {
          expect([kind, d(text), detectRateLimit(kind, [d(text)])]).toEqual([kind, d(text), null]);
        }
      }
    }
  });

  it('reads only what the agent said from a transcript', () => {
    const at = new Date(1_750_000_000_000).toISOString();
    const notice = 'Usage limit reached.';
    const quoted = [
      // A tool call whose input holds the words, and the agent's private reasoning.
      {
        type: 'assistant',
        timestamp: at,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { content: notice } }],
        },
      },
      {
        type: 'assistant',
        timestamp: at,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: notice }] },
      },
      // Context injected into the session and other bookkeeping.
      {
        type: 'attachment',
        timestamp: at,
        attachment: { type: 'hook_additional_context', content: notice },
      },
      { type: 'system', timestamp: at, subtype: 'informational', content: notice },
      // Tool output.
      {
        type: 'user',
        timestamp: at,
        message: { role: 'user', content: [{ type: 'tool_result', content: notice }] },
      },
      {
        type: 'response_item',
        timestamp: at,
        payload: { type: 'function_call_output', output: notice },
      },
      {
        type: 'response_item',
        timestamp: at,
        payload: { type: 'function_call', arguments: notice },
      },
    ];
    const quotedEntries = parseTranscriptTail(jsonl(quoted));
    expect(quotedEntries.map((e) => e.agent)).toEqual(quoted.map(() => false));
    expect(recentAgentTexts(quotedEntries, 0)).toEqual([]);

    const said = [
      assistant(notice, 1_750_000_000_000),
      { type: 'system', timestamp: at, subtype: 'api_error', level: 'error', content: notice },
      {
        type: 'response_item',
        timestamp: at,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: notice }],
        },
      },
      { type: 'event_msg', timestamp: at, payload: { type: 'agent_message', message: notice } },
      { type: 'event_msg', timestamp: at, payload: { type: 'error', message: notice } },
      { role: 'assistant', timestamp: at, content: notice },
    ];
    expect(recentAgentTexts(parseTranscriptTail(jsonl(said)), 0)).toEqual(said.map(() => notice));
    expect(recentAgentTexts(parseTranscriptTail(`${notice}\n`), 0)).toEqual([notice]);
  });

  it('keeps a session that only talked about rate limiting', async () => {
    const { root, clock, mindly, sent } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const transcript = join(root, 'healthy.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        {
          type: 'assistant',
          timestamp: new Date(clock.t).toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'echo "Usage limit reached."' } },
            ],
          },
        },
        {
          type: 'user',
          timestamp: new Date(clock.t).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'HTTP 429 Too Many Requests' }],
          },
        },
      ]),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', {
        transcriptPath: transcript,
        lastMessage:
          'Done. The /login endpoint is now rate limited to 5 attempts per minute per IP.',
      }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!.status).toBe('idle');
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  async function hitLimit(mindly: Mindly, root: string): Promise<void> {
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { lastMessage: 'Claude usage limit reached.' }),
    );
  }

  it('withdraws the handoff when the limited session carries on', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    const task = mindly.tasks.create({
      projectId: pid,
      title: 'Migrate auth',
      owner: cc,
      plan: ['a', 'b'],
    });
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    expect(h?.status).toBe('pending');

    // The limit resets and the same session is asked to go on.
    clock.advance(5 * 3_600_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    // While it is working, its task is not offered to anyone else.
    const early = await mindly.hooks.handle(event(root, 'codex', 'early', 'session_start'));
    expect(early.context ?? '').not.toContain('Handoff for you');
    expect(mindly.store.handoffs.get(h!.id).status).toBe('pending');

    mindly.tasks.update(
      task.id,
      {
        status: 'done',
        plan: [
          { text: 'a', done: true },
          { text: 'b', done: true },
        ],
      },
      cc,
    );
    clock.advance(60_000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'export function login() { return 2; }'),
      }),
    );
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { lastMessage: 'All done.' }),
    );
    expect(mindly.store.handoffs.get(h!.id).status).toBe('cancelled');
    expect(failoverService(mindly).pendingLaunch(pid)).toHaveLength(0);

    clock.advance(86_400_000);
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context ?? '').not.toContain('Handoff for you');
    expect(mindly.store.tasks.get(task.id).status).toBe('done');
  });

  it('keeps the handoff when a later turn shows neither a notice nor any work', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    const status = () => mindly.store.handoffs.get(h!.id).status;

    // The limit is still on, and this time it is worded in a way no signature knows.
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { lastMessage: 'Out of credits until 3pm.' }),
    );
    expect(status()).toBe('pending');

    // A stop without any message, and a stop on the same prompt again.
    clock.advance(1000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'stop'));
    expect(status()).toBe('pending');

    // Work was done, but the transcript of the turn could not be read.
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'export function login() { return 3; }'),
      }),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: join(root, 'missing.jsonl') }),
    );
    expect(status()).toBe('pending');

    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Handoff for you');
  });

  it('withdraws the handoff after a turn that ends with a real answer', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    clock.advance(60_000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'explain the session store' }),
    );
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', {
        lastMessage: `The session store keeps one row per login. ${'It is read on every request. '.repeat(15)}`,
      }),
    );
    expect(mindly.store.handoffs.get(h!.id).status).toBe('cancelled');
  });

  it('keeps the handoff when the resumed session hits the limit again', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    await hitLimit(mindly, root);
    const handoffs = mindly.store.handoffs.list(pid);
    expect(handoffs.map((h) => h.status)).toEqual(['pending']);
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Handoff for you');
  });

  it('stops offering a usage-limit handoff after a week', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    expect(failoverService(mindly).pendingLaunch(pid)).toHaveLength(1);
    clock.advance(RATE_LIMIT_HANDOFF_MAX_AGE_MS + 1000);
    expect(failoverService(mindly).pendingLaunch(pid)).toHaveLength(0);
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context ?? '').not.toContain('Handoff for you');
    expect(mindly.store.handoffs.list(pid)[0]!.status).toBe('pending');
  });

  it('takes the goal from the latest request when the last task is finished', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    const task = mindly.tasks.create({
      projectId: pid,
      title: 'Fix the login bug',
      owner: cc,
      plan: ['repro', 'fix'],
    });
    mindly.tasks.update(
      task.id,
      {
        status: 'done',
        plan: [
          { text: 'repro', done: true },
          { text: 'fix', done: true },
        ],
      },
      cc,
    );
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', {
        prompt: 'now rewrite the billing exporter to stream CSV',
      }),
    );
    clock.advance(1000);
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    expect(h!.packet.goal).toBe('now rewrite the billing exporter to stream CSV');
    expect(h!.packet.plan).toEqual([]);
    expect(h!.taskId).toBeNull();

    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Goal: now rewrite the billing exporter to stream CSV');
    expect(cx.context).not.toContain('Goal: Fix the login bug');
    expect(mindly.store.tasks.get(task.id).status).toBe('done');
  });

  it('does not reopen a task that was finished after the handoff was made', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    const task = mindly.tasks.create({ projectId: pid, title: 'Migrate auth', owner: cc });
    await hitLimit(mindly, root);
    mindly.tasks.update(task.id, { status: 'done' }, null);
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Handoff for you');
    const after = mindly.store.tasks.get(task.id);
    expect(after.status).toBe('done');
    expect(after.ownerSessionId).toBe(cc.id);
  });

  it('hands on to the agent after the limited one, past agents that are limited too', async () => {
    const { root, clock, mindly } = setupFailover({
      config: (c) => {
        c.failover.order = ['claude-code', 'codex', 'gemini'];
      },
    });
    const svc = failoverService(mindly);
    expect(svc.nextAgent('claude-code')).toBe('codex');
    expect(svc.nextAgent('codex')).toBe('gemini');
    expect(svc.nextAgent('gemini')).toBe('claude-code');
    expect(svc.nextAgent('cursor')).toBe('claude-code');

    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    expect(mindly.store.handoffs.list(pid)[0]!.toAgentKind).toBe('codex');

    // Codex picks the work up and runs into its own limit: Claude Code is still limited.
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'carry on' }));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'stop', { lastMessage: "You've hit your usage limit." }),
    );
    const fromCodex = mindly.store.handoffs.list(pid).find((h) => h.status === 'pending');
    expect(fromCodex?.toAgentKind).toBe('gemini');
    expect(svc.nextAgent('gemini', pid)).toBe('claude-code');
  });
});

describe('manual handoffs', () => {
  it('creates, lists and cancels', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    const svc = failoverService(mindly).handoffs;
    await expect(svc.create(cc, { toAgentKind: 'Not Valid', summary: 'x' })).rejects.toThrow();
    await expect(svc.create(cc, { summary: '   ' })).rejects.toThrow();
    const h = await svc.create(cc, {
      toAgentKind: 'cursor',
      summary: 'Finish the login page',
      nextSteps: ['wire the form'],
      blockers: ['needs API key from ops'],
    });
    expect(h.reason).toBe('manual');
    expect(h.packet.goal).toBe('Finish the login page');
    expect(h.packet.nextSteps).toEqual(['wire the form']);
    expect(h.packet.blockers).toEqual(['needs API key from ops']);
    expect(svc.list(pid, 'pending').map((x) => x.id)).toEqual([h.id]);
    expect(svc.cancel(h.id).status).toBe('cancelled');
    expect(() => svc.cancel(h.id)).toThrow(/cancelled/);
    const cu = await mindly.hooks.handle(event(root, 'cursor', 'cu', 'session_start'));
    expect(cu.context ?? '').not.toContain('Handoff for you');
  });

  it('shows the summary to the receiving agent when the goal is the task of the sender', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
    mindly.tasks.create({ projectId: pid, title: 'Migrate auth', owner: cc });
    const svc = failoverService(mindly).handoffs;
    await svc.create(cc, {
      toAgentKind: 'codex',
      summary: 'Half done: token refresh works, logout still broken on Safari',
    });
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context).toContain('Goal: Migrate auth');
    expect(cx.context).toContain('Half done: token refresh works, logout still broken on Safari');

    // Without a task the summary is the goal and is shown once.
    await mindly.hooks.handle(event(root, 'gemini', 'gm', 'session_start'));
    const other = await svc.create(mindly.store.sessions.findByExternal(pid, 'gemini', 'gm')!, {
      toAgentKind: 'cursor',
      summary: 'Finish the login page',
    });
    expect(other.packet.goal).toBe('Finish the login page');
    const cu = await mindly.hooks.handle(event(root, 'cursor', 'cu', 'session_start'));
    expect(cu.context!.match(/Finish the login page/g)).toHaveLength(1);
  });
});
