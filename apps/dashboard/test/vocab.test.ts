import { describe, expect, it } from 'vitest';
import type { ContextItem, MindlyEvent, Session } from '../src/types';
import {
  conflictHeadline,
  conflictStatusWords,
  count,
  describeEvent,
  handoffStatusWords,
  humanizeAgentText,
  isAllQuiet,
  memoryKindWords,
  omitReasonWords,
  productName,
  relTime,
  runKindWords,
  sessionName,
  sessionStatusWords,
  severityWords,
  shortId,
  sourceWords,
  splitCode,
  summaryLine,
  trustWords,
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
  });

  it('translates handoffs and runs', () => {
    expect(handoffStatusWords({ status: 'pending', toAgentKind: 'claude-code' })).toBe(
      'waiting for Claude Code',
    );
    expect(handoffStatusWords({ status: 'claimed', toAgentKind: null }, 'Codex')).toBe(
      'picked up by Codex',
    );
    expect(runKindWords('shadow_merge')).toBe('merge check');
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

describe('summaryLine', () => {
  const now = 1_000_000_000;
  it('summarises agents, things that need you and the last merge check', () => {
    expect(
      summaryLine({
        sessions: [{ status: 'active' }, { status: 'active' }],
        needsYou: 2,
        lastMergeCheck: { status: 'passed', at: now - 3 * 60_000 },
        now,
      }),
    ).toBe('2 agents working · 2 things need you · last merge check passed 3m ago');
  });

  it('handles singular, idle and no merge check', () => {
    expect(
      summaryLine({
        sessions: [{ status: 'active' }, { status: 'idle' }],
        needsYou: 1,
        lastMergeCheck: null,
        now,
      }),
    ).toBe('1 agent working · 1 idle · 1 thing needs you');
  });

  it('knows when all is quiet', () => {
    const input = { sessions: [], needsYou: 0, lastMergeCheck: null };
    expect(isAllQuiet(input)).toBe(true);
    expect(summaryLine(input)).toBe('No agents running · nothing needs you');
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
    expect(line.actor).toBe('Codex · f57f6d10');
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

  it('never leaks unknown event types', () => {
    const line = describeEvent(ev('weird.thing_happened', {}, CODEX.id), sessions);
    expect(line.text).not.toMatch(/weird|thing_happened/);
  });

  it('counts with plurals', () => {
    expect(count(1, 'item')).toBe('1 item');
    expect(count(2, 'memory', 'memories')).toBe('2 memories');
  });
});
