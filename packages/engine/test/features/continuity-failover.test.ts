import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFailoverModule,
  detectRateLimit,
  failoverService,
  MAX_TRANSCRIPT_TAIL_BYTES,
  readTranscriptTail,
  type Mindly,
} from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { make, tmp } from './continuity-helpers.js';
import { notifyOutbox } from '../../src/features/outbox.js';

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

    // A hook never waits for the pager: the page waits in the outbox for a sender.
    await notifyOutbox(mindly).flush();
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
});
