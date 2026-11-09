import { describe, expect, it } from 'vitest';
import type { ContextItem, MindlyEvent, Session } from '../src/types';
import {
  conflictAgents,
  conflictHeadline,
  conflictStatusWords,
  count,
  describeEvent,
  handoffStatusWords,
  humanizeAgentText,
  memorySummary,
  moreWords,
  needActionWords,
  needKindWords,
  memoryKindWords,
  omitReasonWords,
  overviewStats,
  progressWords,
  productName,
  relTime,
  runKindWords,
  saveKindWords,
  saveStatusWords,
  sessionName,
  sessionStatusWords,
  severityWords,
  shortId,
  sourceWords,
  splitCode,
  splitPartStateWords,
  splitStatusWords,
  shortAge,
  trustShort,
  trustWords,
  conflictWhat,
  xraySentence,
} from '../src/vocab';

const CLAUDE = { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d4409d433', agentKind: 'claude-code' };
const CODEX = { id: '0190a1b2-c3d4-7e5f-8a9b-0c1df57f6d10', agentKind: 'codex' };
const sessions = new Map<string, Pick<Session, 'id' | 'agentKind'>>([
  [CLAUDE.id, CLAUDE],
  [CODEX.id, CODEX],
]);

const item = (reason: string): ContextItem => ({
  ref: 'x',
  kind: 'memory',
  title: 't',
  score: 0.5,
  tokens: 10,
  reason,
});

const ev = (type: string, payload: Record<string, unknown>, sessionId: string | null = null) =>
  ({ type, payload, sessionId }) as Pick<MindlyEvent, 'type' | 'payload' | 'sessionId'>;

describe('ids and names', () => {
  it('shortId matches core: last 8 hex chars without dashes', () => {
    expect(shortId(CLAUDE.id)).toBe('4409d433');
    expect(shortId('0190a1b2-c3d4-7e5f-8a9b-0c1d4409-d433')).toBe('4409d433');
    expect(shortId('')).toBe('');
  });

  it('uses product names for agent kinds', () => {
    expect(productName('claude-code')).toBe('Claude Code');
    expect(productName('codex')).toBe('Codex');
    expect(productName('cursor')).toBe('Cursor');
    expect(productName('gemini-cli')).toBe('Gemini CLI');
    expect(productName('my-agent')).toBe('My Agent');
  });

  it('names a session as product plus short tag', () => {
    expect(sessionName(CLAUDE)).toBe('Claude Code · 4409d433');
    expect(sessionName(undefined)).toBe('An agent');
  });

  it('replaces agent slugs in prose but not in paths or code', () => {
    expect(humanizeAgentText('claude-code and codex are both editing x')).toBe(
      'Claude Code and Codex are both editing x',
    );
    expect(humanizeAgentText('see src/codex/run.ts and `codex`')).toBe(
      'see src/codex/run.ts and `codex`',
    );
    expect(humanizeAgentText('Shadow merge of 3 sessions')).toBe('Merge check of 3 sessions');
  });
});

describe('status words', () => {
  it('translates session, severity and conflict status', () => {
    expect(sessionStatusWords('active')).toBe('working');
    expect(sessionStatusWords('rate_limited')).toBe('hit its usage limit');
    expect(sessionStatusWords('ended')).toBe('finished');
    expect(severityWords('info')).toBe('FYI');
    expect(severityWords('warning')).toBe('check this');
    expect(severityWords('critical')).toBe('urgent');
    expect(conflictStatusWords('acknowledged')).toBe('seen');
  });

  it('translates trust and memory kinds', () => {
    expect(trustWords('approved')).toBe('approved by you');
    expect(trustWords('verified')).toBe('confirmed in the code');
    expect(trustWords('proposed', 'Codex')).toBe('suggested by Codex, waiting for you');
    expect(trustWords('proposed')).toBe('waiting for you');
    expect(trustWords('stale')).toBe('may be outdated (code changed)');
    expect(memoryKindWords('mistake')).toBe('known pitfall');
    expect(memoryKindWords('rule')).toBe('rule');
  });

  it('names memory sources', () => {
    expect(sourceWords({ type: 'user', sessionId: null, agentKind: null }, sessions)).toBe('you');
    expect(sourceWords({ type: 'agent', sessionId: CODEX.id, agentKind: 'codex' }, sessions)).toBe(
      'Codex',
    );
    expect(sourceWords({ type: 'agent', sessionId: null, agentKind: 'cursor' }, sessions)).toBe(
      'Cursor',
    );
    // Rules imported from AGENTS.md and similar files are never shown as the user's.
    expect(sourceWords({ type: 'agent', sessionId: null, agentKind: 'repo-file' }, sessions)).toBe(
      'a repository file',
    );
  });

  it('translates handoffs and runs', () => {
    expect(handoffStatusWords({ status: 'pending', toAgentKind: 'claude-code' })).toBe(
      'waiting for Claude Code',
    );
    expect(handoffStatusWords({ status: 'claimed', toAgentKind: null }, 'Codex')).toBe(
      'picked up by Codex',
    );
    expect(runKindWords('shadow_merge')).toBe('merge check');
    expect(runKindWords('sentinel')).toBe('sentinel check');
  });
});

describe('relTime', () => {
  const now = new Date(2026, 10, 4, 15, 0, 0).getTime();
  it('reads naturally', () => {
    expect(relTime(now - 3_000, now)).toBe('just now');
    expect(relTime(now - 40_000, now)).toBe('40s ago');
    expect(relTime(now - 3 * 60_000, now)).toBe('3m ago');
    expect(relTime(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(relTime(new Date(2026, 10, 3, 14, 5).getTime(), now)).toBe('yesterday 14:05');
    expect(relTime(new Date(2026, 9, 1, 9, 0).getTime(), now)).toBe('1 Oct');
    expect(relTime(now + 5 * 60_000, now)).toBe('in 5m');
    expect(relTime(null, now)).toBe('never');
  });
});

describe('overviewStats', () => {
  it('puts counts in numbers and the merge check in one word', () => {
    const stats = overviewStats({
      sessions: [{ status: 'active' }, { status: 'active' }, { status: 'idle' }],
      needsYou: 4,
      lastMergeCheck: { status: 'failed', at: 123 },
    });
    expect(stats.map((s) => `${s.value} ${s.label}`)).toEqual([
      '2 working',
      '1 idle',
      '4 need you',
      'failed merge check',
    ]);
    expect(stats.at(-1)?.at).toBe(123);
    expect(stats.at(-1)?.tone).toBe('bad');
  });

  it('adds the saves of the week once they are known', () => {
    const base = { sessions: [], needsYou: 0, lastMergeCheck: null };
    expect(overviewStats(base).map((s) => s.label)).not.toContain('saves this week');
    expect(
      overviewStats({ ...base, saves: 0 }).find((s) => s.label === 'saves this week'),
    ).toMatchObject({
      value: '0',
      tone: 'neutral',
    });
    expect(
      overviewStats({ ...base, saves: 1 }).find((s) => s.label === 'save this week'),
    ).toMatchObject({
      value: '1',
      tone: 'good',
    });
  });

  it('names save kinds and statuses in plain words', () => {
    expect(saveKindWords('impact_warned')).toBe('Told about a change before building on it');
    expect(saveKindWords('unknown_kind')).toBe('Save');
    expect(saveStatusWords('caught')).toBe('pending');
    expect(saveStatusWords('confirmed')).toBe('counted');
    expect(saveStatusWords('expired')).toBe('not confirmed in time');
    expect(saveStatusWords('rejected')).toBe('not a save');
  });

  it('adds usage limits and handles no merge check', () => {
    const stats = overviewStats({
      sessions: [{ status: 'rate_limited' }],
      needsYou: 0,
      lastMergeCheck: null,
    });
    expect(stats.map((s) => `${s.value} ${s.label}`)).toEqual([
      '0 working',
      '0 idle',
      '1 at usage limit',
      '0 need you',
      'none merge check',
    ]);
  });

  it('names needs-you kinds and their one action', () => {
    expect(needKindWords('rule')).toBe('Rule');
    expect(needActionWords('conflict')).toBe('Resolve');
    expect(needActionWords('memory')).toBe('Review');
    expect(needKindWords('split')).toBe('Split');
    expect(needActionWords('split')).toBe('Open');
  });
});

describe('table wording', () => {
  const now = 10_000_000_000;
  it('writes short ages without "ago"', () => {
    expect(shortAge(now - 3_000, now)).toBe('now');
    expect(shortAge(now - 12_000, now)).toBe('12s');
    expect(shortAge(now - 3 * 60_000, now)).toBe('3m');
    expect(shortAge(now - 2 * 3_600_000, now)).toBe('2h');
    expect(shortAge(now - 3 * 86_400_000, now)).toBe('3d');
    expect(shortAge(null, now)).toBe('—');
  });

  it('summarises memory in one line, skipping zeros', () => {
    expect(
      memorySummary({ approved: 3, verified: 1, proposed: 2, stale: 0, rejected: 1 }).map(
        (p) => `${p.n} ${p.text}`,
      ),
    ).toEqual(['3 approved', '1 confirmed in code', '2 waiting for you']);
    expect(trustShort('stale')).toBe('may be outdated');
    expect(moreWords(2)).toBe('+2 more');
    expect(progressWords(1, 3)).toBe('1/3');
    expect(progressWords(0, 0)).toBe('');
  });

  it('writes the conflict columns without repeating agent names', () => {
    const overlap = {
      kind: 'intent_overlap' as const,
      title: 'raw',
      sessionIds: [CLAUDE.id, CODEX.id],
      paths: ['src/auth.ts'],
    };
    expect(conflictWhat(overlap, sessions)).toBe('Both editing `src/auth.ts`');
    expect(conflictAgents(overlap, sessions)).toBe('Claude Code, Codex');
    const impact = { ...overlap, kind: 'impact' as const };
    expect(conflictWhat(impact, sessions)).toBe('Claude Code changed `src/auth.ts`');
    expect(conflictAgents(impact, sessions)).toBe('Claude Code → Codex');
    expect(
      conflictWhat({ ...overlap, kind: 'contract_broken', sessionIds: [CLAUDE.id] }, sessions),
    ).toBe('Change broke a check in `src/auth.ts`');
    expect(conflictAgents({ kind: 'impact', sessionIds: [] }, sessions)).toBe('—');
  });
});

describe('conflictHeadline', () => {
  it('writes overlaps as a problem statement', () => {
    expect(
      conflictHeadline(
        {
          kind: 'intent_overlap',
          title: 'raw',
          sessionIds: [CLAUDE.id, CODEX.id],
          paths: ['src/auth.ts'],
        },
        sessions,
      ),
    ).toBe('Claude Code and Codex are both editing `src/auth.ts`');
  });

  it('writes impact as who changed what and who uses it', () => {
    expect(
      conflictHeadline(
        { kind: 'impact', title: 'raw', sessionIds: [CLAUDE.id, CODEX.id], paths: ['login()'] },
        sessions,
      ),
    ).toBe("Claude Code changed `login()`; Codex's work uses it");
  });

  it('falls back to the humanised title', () => {
    expect(
      conflictHeadline(
        { kind: 'impact', title: 'codex changed x', sessionIds: [], paths: [] },
        sessions,
      ),
    ).toBe('Codex changed x');
  });

  it('splits code spans for rendering', () => {
    expect(splitCode('a `b` c')).toEqual([
      { text: 'a ', code: false },
      { text: 'b', code: true },
      { text: ' c', code: false },
    ]);
  });
});

describe('xraySentence', () => {
  it('explains what was sent and why things were left out', () => {
    expect(
      xraySentence(
        {
          trigger: 'session_start',
          included: [item('a'), item('b'), item('c')],
          omitted: [item('token budget exhausted'), item('budget')],
        },
        'Codex',
      ),
    ).toBe(
      'Codex received 3 items at session start; 2 were left out because the context was full.',
    );
  });

  it('lists mixed reasons', () => {
    expect(
      xraySentence(
        {
          trigger: 'prompt',
          included: [item('a')],
          omitted: [item('below score threshold'), item('rejected: never injected')],
        },
        'Claude Code',
      ),
    ).toBe(
      'Claude Code received 1 item with a prompt; 2 were left out (1 because it was not relevant enough and 1 because you rejected it).',
    );
    expect(omitReasonWords('path scope src/** does not match')).toBe('it is about other files');
  });

  it('says when nothing was left out', () => {
    expect(xraySentence({ trigger: 'mcp', included: [], omitted: [] }, 'Cursor')).toBe(
      'Cursor received 0 items when it asked Mindly; nothing was left out.',
    );
  });
});

describe('describeEvent', () => {
  it('writes sentences without event type names', () => {
    const line = describeEvent(
      ev('intent.declared', { files: ['src/dash.ts'] }, CODEX.id),
      sessions,
    );
    expect(line.actor).toBe('Codex');
    expect(line.text).toBe('plans to edit src/dash.ts');
  });

  it('uses vocabulary for status and severity', () => {
    expect(describeEvent(ev('session.rate_limited', {}, CLAUDE.id), sessions).text).toBe(
      'hit its usage limit',
    );
    const c = describeEvent(
      ev('conflict.opened', { severity: 'critical', title: 'claude-code broke login' }),
      sessions,
    );
    expect(c.actor).toBeNull();
    expect(c.text).toBe('Conflict (urgent): Claude Code broke login');
    expect(c.tone).toBe('bad');
    expect(
      describeEvent(ev('run.finished', { kind: 'shadow_merge', status: 'passed' }), sessions).text,
    ).toBe('Merge check passed');
    expect(
      describeEvent(ev('memory.created', { kind: 'mistake', title: 'x' }, CODEX.id), sessions).text,
    ).toBe('suggested a known pitfall: “x”');
  });

  it('says what Mindly told an agent before a tool call, and what saves did', () => {
    const say = (type: string, payload: Record<string, unknown>, sid?: string) =>
      describeEvent(ev(type, payload, sid), sessions);
    expect(
      say('tool.before', { paths: ['src/generated/api.ts'], deniedBy: 'r1' }, CODEX.id).text,
    ).toBe('was stopped by your rule from editing src/generated/api.ts');
    expect(
      say(
        'tool.before',
        { paths: ['src/auth.ts'], overlaps: [{ intentId: 'i' }], deniedBy: null },
        CODEX.id,
      ).text,
    ).toBe('was told another agent is editing src/auth.ts');
    expect(say('tool.before', { command: 'npm test', mistakes: ['m1'] }, CODEX.id).text).toBe(
      'was reminded that `npm test` failed before',
    );
    expect(say('tool.after', { command: 'npm test', failed: true }, CODEX.id).text).toBe(
      'ran `npm test`, which failed again',
    );
    expect(
      say('tool.after', { command: 'pnpm lint', failed: true, again: false }, CODEX.id).text,
    ).toBe('ran `pnpm lint`, which failed');
    const confirmed = say('save.confirmed', { title: 'A write by Codex was blocked by your rule' });
    expect(confirmed.text).toBe('Mindly saved you: A write by Codex was blocked by your rule');
    expect(confirmed.tone).toBe('good');
    expect(say('save.caught', { title: 't' }).text).toBe('Possible save, waiting for evidence: t');
    expect(say('save.rejected', { title: 't' }).text).toBe('Not counted as a save: t');
    for (const t of ['save.caught', 'save.confirmed', 'save.rejected']) {
      expect(say(t, { kind: 'rule_enforced', title: 't' }).text).not.toMatch(
        /rule_enforced|save\./,
      );
    }
  });

  it('describes split events without ids or type names', () => {
    expect(
      describeEvent(
        ev('split.created', { splitId: 'x', slug: 'billing', parts: ['api', 'page'] }),
        sessions,
      ),
    ).toEqual({
      actor: null,
      text: 'Split started with 2 parts',
      tone: 'accent',
    });
    expect(
      describeEvent(ev('split.merged', { branch: 'mindly/billing/integration' }), sessions).text,
    ).toBe('Split merged into mindly/billing/integration');
    const aborted = describeEvent(ev('split.aborted', { removedWorktrees: 2 }), sessions);
    expect(aborted.text).toBe('Split abandoned; its worktrees were removed');
    expect(aborted.tone).toBe('warn');
  });

  it('never leaks unknown event types', () => {
    const line = describeEvent(ev('weird.thing_happened', {}, CODEX.id), sessions);
    expect(line.text).not.toMatch(/weird|thing_happened/);
  });

  it('counts with plurals', () => {
    expect(count(1, 'item')).toBe('1 item');
    expect(count(2, 'memory', 'memories')).toBe('2 memories');
  });
});

describe('split words', () => {
  it('names part states and split statuses', () => {
    expect(splitPartStateWords('waiting')).toBe('waiting for an agent');
    expect(splitPartStateWords('working')).toBe('in progress');
    expect(splitPartStateWords('done')).toBe('done');
    expect(splitPartStateWords('blocked')).toBe('blocked');
    expect(splitStatusWords('active')).toBe('in progress');
    expect(splitStatusWords('merged')).toBe('merged');
    expect(splitStatusWords('aborted')).toBe('abandoned');
  });
});
