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
  RATE_LIMIT_SIGNATURES,
  readTranscriptTail,
  recentAgentTexts,
  turnEntries,
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
    expect(
      detectRateLimit('codex', ['stream error: rate limit reached, retry in 30s'], 'client'),
    ).toBe('codex.rate_limit');
    expect(detectRateLimit('cursor', ['HTTP 429 Too Many Requests'], 'client')).toBe(
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

  // Wordings that name the account's own limit.
  const ACCOUNT_NOTICES: [string, string, string][] = [
    [
      'claude-code',
      'Claude usage limit reached. Your limit will reset at 3pm.',
      'claude.usage_limit_reached',
    ],
    ['claude-code', 'Claude AI usage limit reached|1712345678', 'claude.usage_limit_reached'],
    ['claude-code', 'Your limit will reset at 3pm (Europe/Berlin).', 'claude.limit_will_reset'],
    ['claude-code', '⎿  5-hour limit reached ∙ resets 5pm', 'claude.five_hour_limit'],
    ['claude-code', 'You’ve hit your session limit · resets 3pm', 'claude.limit_reached'],
    ['claude-code', 'Weekly limit reached ∙ resets Mon 9am', 'claude.limit_reached'],
    ['claude-code', 'Session limit reached ∙ resets 5pm', 'claude.limit_reached'],
    ['claude-code', 'Opus weekly limit reached ∙ resets Oct 9, 5pm', 'claude.limit_reached'],
    ['claude-code', 'You’ve hit your limit · resets 10pm (Asia/Tokyo)', 'claude.limit_reached'],
    ['claude-code', "You've hit your limit ∙ resets 4am", 'claude.limit_reached'],
    ['claude-code', "You've reached your usage limit", 'generic.usage_limit'],
    ['claude-code', '[12:03:11] Usage limit reached', 'claude.usage_limit_reached'],
    ['claude-code', '2026-01-01T12:00:00Z Usage limit reached.', 'claude.usage_limit_reached'],
    ['claude-code', '[2026-01-01 12:00:00] [error] Weekly limit reached', 'claude.limit_reached'],
    [
      'codex',
      "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.",
      'codex.usage_limit',
    ],
    ['codex', '⚠ You’ve hit your usage limit. Try again at 3pm', 'codex.usage_limit'],
    [
      'codex',
      'You exceeded your current quota, please check your plan and billing details.',
      'generic.quota_used_up',
    ],
    ['gemini', 'You have exhausted your daily quota on this model.', 'gemini.quota_exhausted'],
    [
      'gemini',
      'You have exhausted your capacity on this model. Your quota will reset after 2h.',
      'gemini.quota_exhausted',
    ],
    ['cursor', "You've hit your usage limit", 'generic.usage_limit'],
    ['cursor', '✗ Usage limit reached', 'generic.usage_limit'],
  ];

  // What any rate-limited API says: a limit only when the client itself reports it.
  const API_NOTICES: [string, string, string][] = [
    ['claude-code', 'API Error: 429 Too Many Requests', 'claude.http_429'],
    ['codex', 'stream error: rate limit reached, retry in 30s', 'codex.rate_limit'],
    ['codex', '■ stream error: rate limit reached', 'codex.rate_limit'],
    ['codex', 'Rate limited. Please try again in 20s.', 'codex.rate_limit'],
    [
      'codex',
      'Rate limit reached for gpt-5 in organization org-abc on tokens per min. Please try again in 2s.',
      'codex.rate_limit',
    ],
    ['codex', 'exceeded retry limit, last status: 429 Too Many Requests', 'codex.retry_limit'],
    ['gemini', 'Resource has been exhausted (e.g. check quota).', 'gemini.resource_exhausted'],
    [
      'gemini',
      `[API Error: {"error":{"code":429,"message":"${'Quota exceeded for quota metric x. '.repeat(8)}","status":"RESOURCE_EXHAUSTED"}}]`,
      'gemini.resource_exhausted_status',
    ],
    ['cursor', 'Error: Rate limit exceeded. Try again in 5 minutes.', 'generic.rate_limit'],
    ['cursor', 'ERROR  rate limit exceeded', 'generic.rate_limit'],
    ['cursor', 'Rate limit exceeded.', 'generic.rate_limit'],
    ['cursor', 'Rate limited.', 'generic.rate_limit'],
    ['cursor', 'Quota exceeded.', 'generic.quota_exceeded'],
    ['cursor', '│ 🚫 Fatal: quota exceeded', 'generic.quota_exceeded'],
    ['cursor', 'HTTP 429 Too Many Requests', 'generic.too_many_requests'],
    ['cursor', '429 Too Many Requests', 'generic.too_many_requests'],
    ['cursor', 'Request failed: 429 Too Many Requests', 'generic.too_many_requests'],
    ['cursor', 'Warning: usage limit reached, resets at 5pm', 'generic.usage_limit'],
    ['cursor', 'WARN rate limited; backing off for 2s', 'generic.rate_limit'],
    ['cursor', 'Failed: rate limit exceeded', 'generic.rate_limit'],
  ];

  const LONG_ANSWER = [
    'I moved the session store behind an interface and switched login over to it.',
    'The old cookie path is still there for the two callers that have not been migrated,',
    'and the tests for both paths pass. What is left is the logout flow and the admin',
    'impersonation path, which reads the cookie directly in three places. I started on the',
    'first of those and left a note in the file about the order to do the rest in, because',
    'the second one depends on a helper that the first one introduces. Nothing is half',
    'applied: every file I touched is in a state that builds and passes its own tests.',
  ].join('\n');

  it('recognises an account limit from the client and as the last line the assistant wrote', () => {
    expect(LONG_ANSWER.length).toBeGreaterThan(500);
    for (const [kind, text, id] of ACCOUNT_NOTICES) {
      expect([text, detectRateLimit(kind, [text], 'client')]).toEqual([text, id]);
      expect([text, detectRateLimit(kind, [text])]).toEqual([text, id]);
      // At the end of a message of any length.
      expect([text, detectRateLimit(kind, [`${LONG_ANSWER}\n\n${text}`])]).toEqual([text, id]);
      expect([
        text,
        detectRateLimit(kind, [`Working.\nStep one.\nStep two.\nStep three.\n${text}\n\n`]),
      ]).toEqual([text, id]);
      // Not when the message goes on after it.
      expect([text, detectRateLimit(kind, [`${text}\n\n${LONG_ANSWER}`])]).toEqual([text, null]);
    }
  });

  it('takes API vocabulary for a limit only when the client reports it', () => {
    for (const [kind, text, id] of API_NOTICES) {
      expect([text, detectRateLimit(kind, [text], 'client')]).toEqual([text, id]);
      expect([text, detectRateLimit(kind, [`${LONG_ANSWER}\n\n${text}`])]).toEqual([text, null]);
      // The one line a client writes in place of an answer is the client's report.
      const own = /^\W*\[?API Error/.test(text) ? id : null;
      expect([text, detectRateLimit(kind, [text])]).toEqual([text, own]);
    }
    expect(
      detectRateLimit('claude-code', ['API Error: Request rejected (429) · rate_limit_error']),
    ).toBe('claude.rate_limit_error');
    expect(
      detectRateLimit('claude-code', [
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      ]),
    ).toBe('claude.rate_limit_error');
    expect(detectRateLimit('gemini', ['✕ [API Error: got status: RESOURCE_EXHAUSTED]'])).toBe(
      'gemini.resource_exhausted_status',
    );
  });

  it('does not take a short ordinary last message for a limit', () => {
    const ordinary = [
      'Rate limit exceeded.',
      '429 Too Many Requests',
      'Quota exceeded.',
      'Error: rate limit exceeded',
      'Rate limited.',
      'Done. The API returns:\n\nToo many requests',
      'Working on it.\n\nAPI Error: 429 Too Many Requests',
      'Too many requests.',
      'HTTP 429',
    ];
    for (const kind of ['claude-code', 'codex', 'gemini', 'cursor']) {
      for (const text of ordinary) {
        expect([kind, text, detectRateLimit(kind, [text])]).toEqual([kind, text, null]);
      }
    }
  });

  it('reads only a notice-shaped end of what the assistant wrote', () => {
    const sentences = [
      'Your limit will reset at midnight UTC, and the new resetAt field in the response says exactly when.',
      'You have exhausted your daily quota once 100 requests are made, which the new test asserts.',
      'Usage limit reached. Try again at 5pm. Meanwhile I fixed the tests.',
      'Usage limit reached in the billing module is now logged.',
      "You've hit your usage limit when the counter passes 100, so the banner shows.",
    ];
    for (const kind of KINDS) {
      for (const line of sentences) {
        expect([kind, line, detectRateLimit(kind, [line])]).toEqual([kind, line, null]);
        expect([kind, line, detectRateLimit(kind, [`${LONG_ANSWER}\n\n${line}`])]).toEqual([
          kind,
          line,
          null,
        ]);
      }
    }

    // A notice is never introduced by a colon line.
    const quoted = [
      "The banner now reads:\nYou've hit your usage limit. Upgrade to Pro or try again later.",
      "The banner now reads:\n\nYou've hit your usage limit. Upgrade to Pro or try again later.",
      'The banner now reads:\nUsage limit reached. Try again at 5pm.',
      `${LONG_ANSWER}\n\nThe page shows:\nYou’ve hit your limit · resets 10pm\n/upgrade to increase your usage limit.`,
    ];
    for (const text of quoted)
      expect([text, detectRateLimit('codex', [text])]).toEqual([text, null]);

    // A notice over two lines, the second its tail, alone or at the end of an answer.
    const twoLines = 'You’ve hit your limit · resets 10pm\n/upgrade to increase your usage limit.';
    expect(detectRateLimit('claude-code', [twoLines])).toBe('claude.limit_reached');
    expect(detectRateLimit('claude-code', [`${LONG_ANSWER}\n\n${twoLines}`])).toBe(
      'claude.limit_reached',
    );
    expect(detectRateLimit('cursor', ["You've hit your usage limit\nTry again at 5pm."])).toBe(
      'generic.usage_limit',
    );
    // The tail alone is not a notice, nor is a notice line followed by an ordinary one.
    expect(detectRateLimit('claude-code', ['/upgrade to increase your usage limit.'])).toBeNull();
    expect(detectRateLimit('claude-code', ['Try again at 5pm.'])).toBeNull();
    expect(
      detectRateLimit('claude-code', ['Usage limit reached.\nI will pick this up after lunch.']),
    ).toBeNull();
  });

  it('does not hand off when a summary ends in a sentence that opens with a limit wording', async () => {
    for (const line of [
      'Your limit will reset at midnight UTC, and the new resetAt field in the response says exactly when.',
      'You have exhausted your daily quota once 100 requests are made, which the new test asserts.',
    ]) {
      const { root, clock, mindly, sent } = setupFailover();
      await claudeTurn(mindly, root, () => clock.advance(1000));
      const summary = `Done. The quota endpoint is in.\n\n${line}`;
      const transcript = join(root, 'summary.jsonl');
      writeFileSync(transcript, jsonl([assistant(summary, clock.t)]));
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'stop', {
          transcriptPath: transcript,
          lastMessage: summary,
        }),
      );
      const pid = mindly.store.projects.list()[0]!.id;
      expect([line, mindly.store.handoffs.list(pid).length, sent.length]).toEqual([line, 0, 0]);
    }
  });

  // One wording for every signature in the table, as its client reports it.
  const CLIENT_WORDINGS: [string, string, string][] = [
    ['claude-code', 'Claude AI usage limit reached', 'claude.usage_limit_reached'],
    ['claude-code', '5-hour limit reached', 'claude.five_hour_limit'],
    ['claude-code', 'Opus weekly limit reached', 'claude.limit_reached'],
    ['claude-code', 'Your limit will reset at 3pm', 'claude.limit_will_reset'],
    [
      'claude-code',
      'API Error: Request rejected (429) rate_limit_error',
      'claude.rate_limit_error',
    ],
    ['claude-code', '429', 'claude.http_429'],
    ['codex', "You've hit your usage limit", 'codex.usage_limit'],
    ['codex', 'Rate limit reached for gpt-5 in organization org-abc', 'codex.rate_limit'],
    ['codex', 'exceeded retry limit, last status: 429', 'codex.retry_limit'],
    ['codex', '429', 'codex.http_429'],
    ['gemini', 'You have exhausted your daily quota on gemini-2.5-pro', 'gemini.quota_exhausted'],
    ['gemini', 'You have exhausted your capacity', 'gemini.quota_exhausted'],
    ['gemini', 'You have exhausted your daily quota for today', 'gemini.quota_exhausted'],
    ['gemini', 'Resource has been exhausted', 'gemini.resource_exhausted'],
    ['gemini', '[API Error: {"status":"RESOURCE_EXHAUSTED"', 'gemini.resource_exhausted_status'],
    ['cursor', 'Usage limit exceeded', 'generic.usage_limit'],
    ['cursor', 'You exceeded your current quota', 'generic.quota_used_up'],
    ['cursor', 'Rate limit exceeded', 'generic.rate_limit'],
    ['cursor', 'Too many requests', 'generic.too_many_requests'],
    ['cursor', 'Quota exceeded', 'generic.quota_exceeded'],
    ['cursor', 'HTTP 429', 'generic.http_429'],
  ];

  it('reads every wording in the client error reports, whatever follows it', () => {
    const covered = new Set(CLIENT_WORDINGS.map(([, , id]) => id));
    const all = Object.values(RATE_LIMIT_SIGNATURES)
      .flat()
      .map((sig) => sig.id);
    expect(all.filter((id) => !covered.has(id))).toEqual([]);
    const tails = [
      '',
      ' and anything else the client wants to add, which may run on for a while, so be it.',
      '. Your quota will reset after 2h.',
      ' on gemini-2.5-pro. Please see https://example.com/docs/quota?x=1 for details',
    ];
    for (const [kind, wording, id] of CLIENT_WORDINGS) {
      for (const tail of tails) {
        for (const prefix of ['', 'Error: ', '⚠ ', '[12:03:11] ']) {
          const line = `${prefix}${wording}${tail}`;
          expect([line, detectRateLimit(kind, [line], 'client')]).toEqual([line, id]);
        }
      }
    }
    // Wordings from the reports this rule exists for.
    for (const line of [
      'You have exhausted your daily quota on gemini-2.5-pro.',
      'You have exhausted your capacity on gemini-2.5-pro. Your quota will reset after 2h.',
      'You have exhausted your daily quota for today.',
    ]) {
      expect(detectRateLimit('gemini', [line], 'client')).toBe('gemini.quota_exhausted');
    }
  });

  it('reads a long notice the assistant relays, sentence by sentence', () => {
    const notices: [string, string, string][] = [
      [
        'codex',
        "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:12 PM.",
        'codex.usage_limit',
      ],
      [
        'codex',
        'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
        'generic.quota_used_up',
      ],
      [
        'claude-code',
        'Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles). To continue now, upgrade to Max.',
        'claude.usage_limit_reached',
      ],
      [
        'claude-code',
        "You've hit your weekly limit · resets Oct 9, 5pm. To keep going, send a request to your admin or try again in 3 hours.",
        'claude.limit_reached',
      ],
    ];
    for (const [kind, text, id] of notices) {
      expect([text, detectRateLimit(kind, [text])]).toEqual([text, id]);
      expect([text, detectRateLimit(kind, [`${LONG_ANSWER}\n\n${text}`])]).toEqual([text, id]);
    }
    // A sentence about code is not the tail of a notice, whatever word it opens with.
    for (const text of [
      'Usage limit reached. Retry logic added in src/limit.ts.',
      'Usage limit reached. Upgrade path is documented in docs/limits.md.',
      'Usage limit reached. The `retry` helper now waits.',
      'Usage limit reached.\nI updated the billing docs.',
      'Usage limit reached. Then I fixed the tests.',
    ]) {
      expect([text, detectRateLimit('claude-code', [text])]).toEqual([text, null]);
    }
  });

  it('does not take a retry for a limit', () => {
    const retries = [
      'Rate limited, retrying in 30s.',
      '429 Too Many Requests; retrying 1/5 in 205ms',
      'stream error: rate limit reached; retry 2/5',
      'Usage limit reached, retrying shortly',
      'API Error: 429 Too Many Requests (attempt 3 of 10)',
    ];
    for (const kind of ['claude-code', 'codex', 'cursor']) {
      for (const text of retries) {
        expect([text, detectRateLimit(kind, [text], 'client')]).toEqual([text, null]);
        expect([text, detectRateLimit(kind, [text])]).toEqual([text, null]);
      }
    }
  });

  const WRITTEN_ABOUT_LIMITS = [
    '✅ Rate limit exceeded: the API now answers 429 with a Retry-After header',
    '"Rate limit exceeded." is what the API now returns when the bucket is empty.',
    '“Usage limit reached.” is the banner text I added to the billing page.',
    "'Too many requests.' is shown to the user after five failed logins.",
    '✓ rate limit exceeded (3 ms)',
    ' ✓ 429 (returns Retry-After) 2ms',
    '✗ rate limit exceeded: expected 429, got 200',
    '❌ Quota exceeded: this case is still not handled',
    '→ 429: retried with backoff',
    '- [x] Rate limit exceeded: return 429 with Retry-After',
    '[test] rate limit exceeded: returns 429',
    '[warn] quota exceeded: the nightly export skipped 3 tenants',
    'WARN rate limited; backing off for 2s',
    '2026-01-01 12:00:00 WARN rate limited, backing off',
    '// Rate limit exceeded: back off and retry',
    '+ Rate limit exceeded. Please retry later.',
    'Warning: rate limit exceeded, so the importer now sleeps between batches.',
    'Warning 429: see the retry policy in docs/api.md',
    'Failed: rate limit exceeded (test "handles 429")',
    'FAILED rate limit exceeded: expected 429 got 200',
    'Failure: 429 (expected 200) in tests/api.test.ts',
    '12:30 Usage limit reached: discussed in standup',
    'Warning: "rate_limit_error" is the type the mock returns.',
    '- Rate limit exceeded: return 429',
    '## Rate limit exceeded',
    'Done. The /login endpoint is now rate limited to 5 attempts per minute per IP.',
    'I added a handler that returns HTTP 429 with a Retry-After header.',
    'The client now retries when the server responds with "Too Many Requests".',
    'Fixed: the test expected rate_limit_error but the mock returned overloaded_error.',
    'The docs say the free tier limit will reset monthly; I updated the README.',
    'Added a quota exceeded banner to the billing page.',
  ];
  const KINDS = ['claude-code', 'codex', 'gemini', 'cursor'];

  it('does not read a line the assistant wrote about a limit as a notice', () => {
    for (const kind of KINDS) {
      for (const line of WRITTEN_ABOUT_LIMITS) {
        // On its own, as a one-line message.
        expect([kind, line, detectRateLimit(kind, [line])]).toEqual([kind, line, null]);
        // Inside an ordinary final summary.
        const summary = [
          'The login endpoint is protected now. What changed:',
          '',
          line,
          '',
          'The tests pass and nothing else in the request path was touched. I also updated the',
          'API notes so the retry behaviour is described next to the endpoint it applies to,',
          'and left the existing clients alone: they already back off when told to.',
        ].join('\n');
        expect([kind, line, detectRateLimit(kind, [summary])]).toEqual([kind, line, null]);
      }
    }
  });

  it('never takes a long answer for a notice, whatever one of its lines says', () => {
    const answer = [
      'Here is where things stand.',
      '',
      'Usage limit reached.',
      'API Error: 429 Too Many Requests',
      "You've hit your usage limit. Try again at 3pm.",
      '',
      'Those are the three banners the billing page can show; each has a test now. The copy',
      'lives in one place, and the page picks the banner from the error the API returned.',
    ].join('\n');
    for (const kind of KINDS) expect(detectRateLimit(kind, [answer])).toBeNull();
    // The same lines as the client's error report are a limit.
    expect(detectRateLimit('cursor', [answer], 'client')).toBe('generic.usage_limit');
  });

  it('does not hand off when a normal summary mentions a limit', async () => {
    const { root, clock, mindly, sent } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const summary = [
      'Done. Summary of the change:',
      '',
      '✅ Rate limit exceeded: the API now answers 429 with a Retry-After header',
      '✅ The client waits for the time the header gives before it retries',
    ].join('\n');
    const transcript = join(root, 'summary.jsonl');
    writeFileSync(transcript, jsonl([assistant(summary, clock.t)]));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', {
        transcriptPath: transcript,
        lastMessage: summary,
      }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!.status).toBe('idle');
    expect(mindly.store.handoffs.list(pid)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('reads the error a client reports more generously than what the model wrote', async () => {
    const at = new Date(1_750_000_000_000).toISOString();
    const line = 'WARN rate limited; backing off for 2s';
    const entries = parseTranscriptTail(
      jsonl([
        { type: 'event_msg', timestamp: at, payload: { type: 'agent_message', message: line } },
        { type: 'event_msg', timestamp: at, payload: { type: 'stream_error', message: line } },
        { type: 'system', timestamp: at, level: 'error', content: line },
        {
          type: 'assistant',
          timestamp: at,
          isApiErrorMessage: true,
          message: { role: 'assistant', content: [{ type: 'text', text: line }] },
        },
        assistant(line, 1_750_000_000_000),
      ]),
    );
    expect(entries.map((e) => e.client)).toEqual([false, true, true, true, false]);
    expect(recentAgentTexts(entries, 0, 'client')).toHaveLength(3);
    expect(recentAgentTexts(entries, 0, 'assistant')).toHaveLength(2);
    expect(detectRateLimit('codex', recentAgentTexts(entries, 0, 'assistant'))).toBeNull();
    expect(detectRateLimit('codex', recentAgentTexts(entries, 0, 'client'), 'client')).toBe(
      'codex.rate_limit',
    );

    // End to end: the Codex client reports the limit in an error event.
    const { root, clock, mindly } = setupFailover();
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'fix the tests' }));
    clock.advance(1000);
    const rollout = join(root, 'rollout.jsonl');
    writeFileSync(
      rollout,
      jsonl([
        {
          type: 'event_msg',
          timestamp: new Date(clock.t).toISOString(),
          payload: { type: 'error', message: '■ stream error: rate limit reached' },
        },
      ]),
    );
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'stop', { transcriptPath: rollout }));
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid).map((h) => h.reason)).toEqual(['rate_limit']);
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

  function toolUse(ts: number): object {
    return {
      type: 'assistant',
      timestamp: new Date(ts).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }],
      },
    };
  }

  function toolResult(ts: number): object {
    return {
      type: 'user',
      timestamp: new Date(ts).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', content: '42 passed' }] },
    };
  }

  it('does not hand off for a notice the agent got past in the same turn', async () => {
    const hiccups = (ts: number): [string, object][] => [
      ['assistant', assistant('You’ve hit your usage limit. Try again at 3pm.', ts)],
      ['assistant retry', assistant('Rate limited, retrying in 30s.', ts)],
      [
        'codex stream error',
        {
          type: 'event_msg',
          timestamp: new Date(ts).toISOString(),
          payload: {
            type: 'stream_error',
            message: '429 Too Many Requests; retrying 1/5 in 205ms',
          },
        },
      ],
      [
        'codex error',
        {
          type: 'event_msg',
          timestamp: new Date(ts).toISOString(),
          payload: { type: 'error', message: 'stream error: rate limit reached' },
        },
      ],
      [
        'system api error',
        {
          type: 'system',
          subtype: 'api_error',
          level: 'error',
          timestamp: new Date(ts).toISOString(),
          content: 'API Error: 429 Too Many Requests',
        },
      ],
    ];
    for (const [name, hiccup] of hiccups(0).map(([n], i) => [n, i] as const)) {
      const { root, clock, mindly, sent } = setupFailover();
      await claudeTurn(mindly, root, () => clock.advance(1000));
      const entry = hiccups(clock.t)[hiccup]![1];
      const transcript = join(root, 'carried-on.jsonl');
      writeFileSync(
        transcript,
        jsonl([
          entry,
          toolUse(clock.t + 1),
          toolResult(clock.t + 2),
          assistant(LONG_ANSWER, clock.t + 3),
        ]),
      );
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'stop', {
          transcriptPath: transcript,
          lastMessage: LONG_ANSWER,
        }),
      );
      const pid = mindly.store.projects.list()[0]!.id;
      expect([name, mindly.store.handoffs.list(pid).length]).toEqual([name, 0]);
      expect([name, sent.length]).toEqual([name, 0]);

      // The same entry as the last thing in the turn is the limit (a retry never is).
      const again = setupFailover();
      await claudeTurn(again.mindly, again.root, () => again.clock.advance(1000));
      const ended = join(again.root, 'ended.jsonl');
      const last = hiccups(again.clock.t + 2)[hiccup]![1];
      writeFileSync(
        ended,
        jsonl([
          toolUse(again.clock.t),
          toolResult(again.clock.t + 1),
          last,
          { type: 'system', subtype: 'turn_duration' },
        ]),
      );
      await again.mindly.hooks.handle(
        event(again.root, 'claude-code', 'cc', 'stop', { transcriptPath: ended }),
      );
      const apid = again.mindly.store.projects.list()[0]!.id;
      expect([name, again.mindly.store.handoffs.list(apid).length]).toEqual([
        name,
        name.includes('retry') || name === 'codex stream error' ? 0 : 1,
      ]);
    }
  });

  it('takes an entry without a timestamp as part of the turn it follows', () => {
    const since = 1_750_000_000_000;
    const notice = {
      type: 'assistant',
      message: { role: 'assistant', content: 'Usage limit reached.' },
    };
    const turn = turnEntries(
      parseTranscriptTail(
        jsonl([
          assistant('Usage limit reached.', since - 60_000),
          {
            type: 'user',
            timestamp: new Date(since).toISOString(),
            message: { role: 'user', content: 'go' },
          },
          toolUse(since + 1),
          toolResult(since + 2),
          { type: 'system', subtype: 'turn_duration' },
          notice,
          { type: 'assistant', message: { role: 'assistant', content: '   ' } },
        ]),
      ),
      since,
    );
    expect(turn.map((e) => (e.tool ? 'tool' : e.text))).toEqual([
      'tool',
      'tool',
      'Usage limit reached.',
    ]);
    // Without any timestamps the turn starts after the last prompt, not after a tool result.
    const plain = turnEntries(
      parseTranscriptTail(
        jsonl([
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
          { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
          { role: 'assistant', content: 'new answer' },
        ]),
      ),
      since,
    );
    expect(plain.map((e) => (e.tool ? 'tool' : e.text))).toEqual(['tool', 'tool', 'new answer']);
  });

  it('reads Gemini-style entries and leaves subagent entries out', () => {
    const at = new Date(1_750_000_000_000).toISOString();
    const entries = parseTranscriptTail(
      jsonl([
        {
          type: 'gemini',
          timestamp: at,
          content: 'Looking at the tests.',
          toolCalls: [{ name: 'run_shell_command' }],
        },
        {
          type: 'gemini',
          timestamp: at,
          content: 'You have exhausted your daily quota on this model.',
        },
        {
          type: 'assistant',
          timestamp: at,
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached.' }] },
        },
        { ...toolUse(1_750_000_000_000), isSidechain: true },
      ]),
    );
    expect(entries.map((e) => [e.agent, e.tool])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
    const turn = turnEntries(entries, 0);
    expect(turn).toHaveLength(2);
    expect(detectRateLimit('gemini', [turn[1]!.text])).toBe('gemini.quota_exhausted');
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

  it('withdraws the handoff when the resumed session only runs commands', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    const transcript = join(root, 'resumed.jsonl');
    const lines: object[] = [];
    const stop = async (lastMessage: string) => {
      writeFileSync(transcript, jsonl(lines));
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript, lastMessage }),
      );
    };

    // A turn with a short answer and no tool call says nothing either way.
    clock.advance(3_600_000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'still there?' }),
    );
    clock.advance(1000);
    lines.push(assistant('Yes.', clock.t));
    await stop('Yes.');
    expect(mindly.store.handoffs.get(h!.id).status).toBe('pending');

    // The agent runs the tests and reports in a line: no file changes, but it is at work.
    clock.advance(60_000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'run the tests' }),
    );
    clock.advance(1000);
    const at = new Date(clock.t).toISOString();
    lines.push(
      {
        type: 'assistant',
        timestamp: at,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
      {
        type: 'user',
        timestamp: at,
        message: { role: 'user', content: [{ type: 'tool_result', content: '42 passed' }] },
      },
      assistant('All 42 tests pass.', clock.t),
    );
    await stop('All 42 tests pass.');
    expect(mindly.store.handoffs.get(h!.id).status).toBe('cancelled');
    const cx = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(cx.context ?? '').not.toContain('Handoff for you');
  });

  it('does not count tool calls from before the handoff as carrying on', async () => {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    const before = new Date(clock.t).toISOString();
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    const transcript = join(root, 'older.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        {
          type: 'response_item',
          timestamp: before,
          payload: { type: 'function_call', name: 'shell' },
        },
        assistant('Still limited, sorry.', clock.t),
      ]),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
    );
    expect(mindly.store.handoffs.get(h!.id).status).toBe('pending');
  });

  it('keeps the handoff when a turn that did work ends in an error of any wording', async () => {
    const endings = (ts: number): [string, object, string | undefined][] => [
      [
        'unknown wording from the client',
        {
          type: 'system',
          subtype: 'api_error',
          level: 'error',
          timestamp: new Date(ts).toISOString(),
          content: 'No more credits on this workspace until 10pm (Asia/Tokyo)',
        },
        undefined,
      ],
      [
        'client notice without a timestamp',
        {
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'You’ve hit your limit · resets 10pm (Asia/Tokyo)' }],
          },
        },
        undefined,
      ],
      [
        'known notice without a timestamp',
        { type: 'assistant', message: { role: 'assistant', content: 'Usage limit reached.' } },
        undefined,
      ],
      ['cut off after a tool call', toolResult(ts), undefined],
    ];
    for (let i = 0; i < endings(0).length; i++) {
      const { root, clock, mindly } = setupFailover();
      await claudeTurn(mindly, root, () => clock.advance(1000));
      const pid = mindly.store.projects.list()[0]!.id;
      await hitLimit(mindly, root);
      const [h] = mindly.store.handoffs.list(pid);
      clock.advance(3_600_000);
      await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
      clock.advance(1000);
      const [name, ending] = endings(clock.t + 2)[i]!;
      const transcript = join(root, 'ended-in-error.jsonl');
      writeFileSync(transcript, jsonl([toolUse(clock.t), toolResult(clock.t + 1), ending]));
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
      );
      expect([name, mindly.store.handoffs.get(h!.id).status]).toEqual([name, 'pending']);
      expect(mindly.store.handoffs.list(pid)).toHaveLength(1);
    }
  });

  async function resumedTurn(entries: (ts: number) => object[], lastMessage?: string) {
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    clock.advance(3_600_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    const transcript = join(root, 'resumed-turn.jsonl');
    writeFileSync(transcript, jsonl(entries(clock.t)));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', {
        transcriptPath: transcript,
        ...(lastMessage === undefined ? {} : { lastMessage }),
      }),
    );
    return {
      status: mindly.store.handoffs.get(h!.id).status,
      count: mindly.store.handoffs.list(pid).length,
    };
  }

  it('keeps the handoff when only the last message, not the transcript, shows an answer', async () => {
    // The client may not have written its final answer yet, or the message is a limit in a
    // wording no signature knows, or text from earlier in the turn: when in doubt, keep it.
    const working = (ts: number) => [toolUse(ts), toolResult(ts + 1)];
    for (const lastMessage of [
      'All done, tests pass.',
      'Out of credits until 3pm.',
      'You’re out of extra usage · resets 3pm (Europe/Berlin)',
      'Let me run the tests.',
      "You've hit your usage limit. Upgrade to Pro or try again later.",
      undefined,
    ]) {
      expect([lastMessage, await resumedTurn(working, lastMessage)]).toEqual([
        lastMessage,
        { status: 'pending', count: 1 },
      ]);
    }
    // Once the transcript holds the answer, the turn ended normally.
    const answered = (ts: number) => [...working(ts), assistant('All done, tests pass.', ts + 2)];
    expect(await resumedTurn(answered, 'All done, tests pass.')).toEqual({
      status: 'cancelled',
      count: 1,
    });
  });

  it('reads every error the client reported at the end of the turn', async () => {
    const at = (ts: number) => new Date(ts).toISOString();
    const notice = (ts: number) => ({
      type: 'assistant',
      timestamp: at(ts),
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'You’ve hit your limit · resets 10pm (Asia/Tokyo)' }],
      },
    });
    const systemError = (ts: number) => ({
      type: 'system',
      level: 'error',
      timestamp: at(ts),
      content: 'Stop hook failed with exit code 1',
    });
    for (const [name, entries] of [
      [
        'client notice, then a system error',
        (ts: number) => [toolUse(ts), toolResult(ts + 1), notice(ts + 2), systemError(ts + 3)],
      ],
      [
        'assistant notice, then a system error',
        (ts: number) => [
          toolUse(ts),
          toolResult(ts + 1),
          assistant('Usage limit reached. Your limit will reset at 3pm.', ts + 2),
          systemError(ts + 3),
        ],
      ],
    ] as const) {
      const { root, clock, mindly } = setupFailover();
      await claudeTurn(mindly, root, () => clock.advance(1000));
      const transcript = join(root, 'ending.jsonl');
      writeFileSync(transcript, jsonl(entries(clock.t)));
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
      );
      const pid = mindly.store.projects.list()[0]!.id;
      expect([name, mindly.store.handoffs.list(pid).length]).toEqual([name, 1]);
    }
  });

  it('skips a line that is cut off or still being written', async () => {
    const partial = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"te';
    const entries = parseTranscriptTail(
      `${jsonl([toolUse(1), assistant('Usage limit reached.', 2)])}${partial}\n`,
    );
    expect(entries).toHaveLength(2);
    expect(detectRateLimit('claude-code', [entries[1]!.text])).toBe('claude.usage_limit_reached');

    // A partial line is no answer: the resumed turn below was cut off after a tool result.
    const { root, clock, mindly } = setupFailover();
    await claudeTurn(mindly, root, () => clock.advance(1000));
    const pid = mindly.store.projects.list()[0]!.id;
    await hitLimit(mindly, root);
    const [h] = mindly.store.handoffs.list(pid);
    clock.advance(3_600_000);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    const transcript = join(root, 'partial.jsonl');
    writeFileSync(transcript, `${jsonl([toolUse(clock.t), toolResult(clock.t + 1)])}${partial}`);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
    );
    expect(mindly.store.handoffs.get(h!.id).status).toBe('pending');

    // And with the notice before the partial line, the limit is still found.
    const fresh = setupFailover();
    await claudeTurn(fresh.mindly, fresh.root, () => fresh.clock.advance(1000));
    const cut = join(fresh.root, 'cut.jsonl');
    writeFileSync(
      cut,
      `${jsonl([toolUse(fresh.clock.t), toolResult(fresh.clock.t + 1), assistant('Usage limit reached.', fresh.clock.t + 2)])}${partial}`,
    );
    await fresh.mindly.hooks.handle(
      event(fresh.root, 'claude-code', 'cc', 'stop', { transcriptPath: cut }),
    );
    const fpid = fresh.mindly.store.projects.list()[0]!.id;
    expect(fresh.mindly.store.handoffs.list(fpid)).toHaveLength(1);
  });

  it('reads a one-line JSON document and a pretty one with an empty object in it', () => {
    const session = {
      sessionId: 'g2',
      messages: [
        { type: 'user', content: 'fix the tests' },
        { type: 'gemini', content: 'Running them.', toolCalls: [{ name: 'run_shell_command' }] },
        { type: 'gemini', content: 'You have exhausted your daily quota on this model.' },
      ],
    };
    const compact = parseTranscriptTail(`${JSON.stringify(session)}\n`);
    expect(compact.map((e) => e.text)).toEqual([
      '',
      'Running them.',
      'You have exhausted your daily quota on this model.',
    ]);
    const withEmpty = { ...session, metadata: {} };
    const pretty = JSON.stringify(withEmpty, null, 2);
    expect(pretty.split('\n').some((l) => l.trim() === '"metadata": {}' || l.trim() === '{}')).toBe(
      true,
    );
    const prettyWithBareObject = pretty.replace('"metadata": {}', '"extra": [\n    {}\n  ]');
    for (const text of [pretty, prettyWithBareObject]) {
      expect(parseTranscriptTail(text).map((e) => e.text)).toEqual(compact.map((e) => e.text));
    }
  });

  it('reads a transcript that is one JSON document', async () => {
    const session = {
      sessionId: 'g1',
      messages: [
        { type: 'user', content: 'fix the tests' },
        { type: 'gemini', content: 'Running them.', toolCalls: [{ name: 'run_shell_command' }] },
        { type: 'gemini', content: 'You have exhausted your daily quota on this model.' },
      ],
    };
    const pretty = `${JSON.stringify(session, null, 2)}\n`;
    const entries = parseTranscriptTail(pretty);
    expect(entries.map((e) => [e.user, e.agent, e.tool])).toEqual([
      [true, false, false],
      [false, true, true],
      [false, true, false],
    ]);
    expect(parseTranscriptTail(JSON.stringify(session.messages, null, 2))).toHaveLength(3);
    // Cut by the tail it is not read at all: no stray "}" taken for something the agent said.
    expect(parseTranscriptTail(pretty.slice(pretty.indexOf('\n', 40) + 1))).toEqual([]);

    const { root, clock, mindly } = setupFailover({
      config: (c) => {
        c.failover.order = ['gemini', 'claude-code'];
      },
    });
    await mindly.hooks.handle(event(root, 'gemini', 'gm', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(event(root, 'gemini', 'gm', 'prompt', { prompt: 'fix the tests' }));
    const file = join(root, 'session.json');
    writeFileSync(file, pretty);
    await mindly.hooks.handle(event(root, 'gemini', 'gm', 'stop', { transcriptPath: file }));
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.handoffs.list(pid).map((h) => h.toAgentKind)).toEqual(['claude-code']);
  });

  it('does not take a model entry that ends in a tool call for an answer', async () => {
    const geminiTool = (ts: number) => [
      {
        type: 'gemini',
        timestamp: new Date(ts).toISOString(),
        content: 'Running the tests now.',
        toolCalls: [{ name: 'run_shell_command' }],
      },
    ];
    expect(await resumedTurn(geminiTool)).toEqual({ status: 'pending', count: 1 });
    const answered = (ts: number) => [
      ...geminiTool(ts),
      { type: 'gemini', timestamp: new Date(ts + 1).toISOString(), content: 'All 42 tests pass.' },
    ];
    expect(await resumedTurn(answered)).toEqual({ status: 'cancelled', count: 1 });
  });

  it('keeps the handoff when a long last message ends in the notice and there is no transcript', async () => {
    const { root, clock, mindly } = setupFailover();
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'migrate auth' }));
    clock.advance(1000);
    const notice = "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.";
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'stop', { lastMessage: `${LONG_ANSWER}\n\n${notice}` }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const [h] = mindly.store.handoffs.list(pid);
    expect(h?.reason).toBe('rate_limit');

    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'continue' }));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'stop', {
        lastMessage: `${LONG_ANSWER}\n\nStep one.\nStep two.\nStep three.\nStep four.\n${notice}`,
      }),
    );
    expect(mindly.store.handoffs.list(pid).map((x) => x.status)).toEqual(['pending']);
    expect(mindly.store.handoffs.get(h!.id).status).toBe('pending');
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
        lastMessage: `The session store keeps one row per login. ${'It is read on every request. '.repeat(20)}`,
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
