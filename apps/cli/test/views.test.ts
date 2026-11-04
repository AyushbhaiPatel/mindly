import type {
  Conflict,
  ContextItem,
  Handoff,
  Memory,
  MemorySource,
  Session,
  Snapshot,
} from '@mindly/core';
import type { StandupDigest, XRaySession } from '@mindly/engine';
import { describe, expect, it } from 'vitest';
import { screenFor } from '../src/present/index.js';
import { renderDoctor, type DoctorItem } from '../src/views/doctor.js';
import {
  renderConflicts,
  renderStandup,
  renderWhy,
  renderXray,
  renderXrayQuery,
} from '../src/views/insight.js';
import { renderHandoffs, renderSnapshots } from '../src/views/continuity.js';
import { renderMemoryList, renderRules } from '../src/views/memory.js';
import { renderStatus, type StatusData } from '../src/views/status.js';

/*
 * Snapshot-style tests of the main screens with fixed clocks and ids, no colour. The UTF-8
 * variant uses LANG=en_US.UTF-8; everything else is the ASCII fallback.
 */

const NOW = new Date(2026, 10, 4, 15, 30, 0).getTime();
const MIN = 60_000;
const P = '01a1a6ed-ddef-7813-99fd-5ae7d6c90071';
const id = (tail: string): string => `01a1a6ed-0000-7000-8000-0000${tail}`;

function render(fn: (sc: ReturnType<typeof screenFor>) => void, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  fn(screenFor((l) => lines.push(l), { write: () => undefined, isTTY: false }, env, NOW));
  return `\n${lines.join('\n')}\n`;
}

const UTF8 = { LANG: 'en_US.UTF-8' };

const claude: Session = {
  id: id('4409d433'),
  projectId: P,
  agentKind: 'claude-code',
  externalId: 'cc1',
  status: 'active',
  label: null,
  branch: 'main',
  worktree: '/repo',
  currentTaskId: null,
  transcriptPath: null,
  startedAt: NOW - 30 * MIN,
  lastSeenAt: NOW - MIN,
  endedAt: null,
};
const codex: Session = { ...claude, id: id('f57f6d10'), agentKind: 'codex', externalId: 'cx1' };
const sessions = new Map([claude, codex].map((s) => [s.id, s]));
const sessionOf = (sid: string): Session | null => sessions.get(sid) ?? null;

const conflict: Conflict = {
  id: id('9f02a0c3'),
  projectId: P,
  kind: 'impact',
  severity: 'warning',
  status: 'open',
  title: 'claude-code #4409d433 changed the exports of src/auth.ts',
  detail: 'Changed signature: login. 1 file(s) import it: src/dash.ts.',
  sessionIds: [claude.id, codex.id],
  paths: ['src/auth.ts', 'src/dash.ts'],
  fingerprint: 'f',
  createdAt: NOW - 2 * MIN,
  updatedAt: NOW - 2 * MIN,
  resolvedAt: null,
};

const fromClaude: MemorySource = { type: 'user', sessionId: claude.id, agentKind: 'claude-code' };
function memory(tail: string, over: Partial<Memory>): Memory {
  return {
    id: id(tail),
    projectId: P,
    kind: 'rule',
    title: 'x',
    body: '',
    tags: [],
    scope: { paths: [], branch: null },
    trust: 'approved',
    status: 'active',
    source: { type: 'user', sessionId: null, agentKind: null },
    enforce: false,
    pinned: false,
    version: 1,
    supersedesId: null,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW - 60 * MIN,
    lastVerifiedAt: null,
    ...over,
  };
}
const pnpmRule = memory('a9884755', { title: 'Always use pnpm, never npm', enforce: true });
const exportsRule = memory('7bc7e9b7', {
  title: "Don't use default exports",
  trust: 'proposed',
  source: fromClaude,
});
const npmMistake = memory('bf1da9e0', {
  kind: 'mistake',
  title: 'Command fails: npm test',
  trust: 'proposed',
  source: { type: 'agent', sessionId: codex.id, agentKind: 'codex' },
});
const handoff: Handoff = {
  id: id('2bc5385b'),
  projectId: P,
  fromSessionId: codex.id,
  toAgentKind: 'cursor',
  taskId: null,
  reason: 'manual',
  summary: 'Finish the dashboard login form',
  packet: {
    goal: '',
    plan: [],
    filesChanged: [],
    recentPrompts: [],
    decisions: [],
    blockers: [],
    nextSteps: ['Wire the submit button'],
    branch: 'main',
    headCommit: null,
  },
  status: 'pending',
  claimedBySessionId: null,
  createdAt: NOW - 5 * MIN,
  claimedAt: null,
};

function statusData(over: Partial<StatusData> = {}): StatusData {
  return {
    projectName: 'my-app',
    agents: [
      {
        session: claude,
        editing: [],
        plans: [],
        lastEdit: { path: 'src/auth.ts', at: NOW - MIN },
        task: null,
      },
      { session: codex, editing: ['src/dash.ts'], plans: [], lastEdit: null, task: null },
    ],
    conflicts: [conflict],
    proposed: [exportsRule],
    handoffs: [],
    tasks: [],
    otherIntents: [],
    config: 'none',
    sessionOf,
    ...over,
  };
}

describe('status screen', () => {
  it('matches the shape in docs/output-style.md', () => {
    expect(render((sc) => renderStatus(sc, statusData()), UTF8)).toMatchInlineSnapshot(`
      "
      Mindly \u00B7 my-app \u00B7 2 agents working \u00B7 2 things need you

      Agents
        \u25CF Claude Code \u00B7 4409d433   working \u00B7 main \u00B7 edited src/auth.ts 1m ago
        \u25CF Codex \u00B7 f57f6d10         working \u00B7 main \u00B7 editing src/dash.ts

      Needs you
        ! Conflict: Claude Code \u00B7 4409d433 changed the exports of src/auth.ts; Codex's
          src/dash.ts uses them  [9f02a0c3]
        \u2022 Suggested rule from Claude Code: "Don't use default exports"  [7bc7e9b7]

      \u2192 mindly conflict 9f02a0c3 resolve   mark the conflict resolved
      \u2192 mindly rules --approve 7bc7e9b7    make the rule apply to every agent
      "
    `);
  });

  it('falls back to ASCII and lists every kind of item that needs you', () => {
    expect(
      render((sc) =>
        renderStatus(
          sc,
          statusData({
            proposed: [exportsRule, npmMistake],
            handoffs: [handoff],
            config: 'untrusted',
            agents: [
              {
                session: { ...codex, status: 'rate_limited' },
                editing: [],
                plans: [],
                lastEdit: null,
                task: null,
              },
            ],
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      "
      Mindly - my-app - 1 agent idle - 5 things need you

      Agents
        [!] Codex - f57f6d10   hit its usage limit - main - last active 1m ago

      Needs you
        [!] This project's .mindly/config.json is not trusted yet, so its checks do not run
        [!] Conflict: Claude Code - 4409d433 changed the exports of src/auth.ts; Codex's
            src/dash.ts uses them  [9f02a0c3]
        - Suggested rule from Claude Code: "Don't use default exports"   [7bc7e9b7]
        - Suggested known pitfall from Codex: "Command fails: npm test"  [bf1da9e0]
        - Handoff waiting for Cursor: "Finish the dashboard login form"  [2bc5385b]

      -> mindly trust                       review the project config and its commands
      -> mindly conflict 9f02a0c3 resolve   mark the conflict resolved
      "
    `);
  });

  it('says "All quiet." when nothing is happening', () => {
    expect(
      render((sc) => renderStatus(sc, statusData({ agents: [], conflicts: [], proposed: [] }))),
    ).toMatchInlineSnapshot(`
      "
      Mindly - my-app - All quiet.
      No agent is working in this project right now. Agents appear here when they start.
      "
    `);
  });
});

describe('memory screens', () => {
  it('rules', () => {
    expect(render((sc) => renderRules(sc, [pnpmRule], [exportsRule]), UTF8)).toMatchInlineSnapshot(`
      "
      Rules \u00B7 1 rule every agent follows \u00B7 1 waiting for you

      Every agent follows
        \u2713 Always use pnpm, never npm (approved by you; enforced: blocks edits that break it)  [a9884755]

      Waiting for you
        ! Don't use default exports (you said it in Claude Code, waiting for you)  [7bc7e9b7]

      \u2192 mindly rules --approve 7bc7e9b7   make the rule apply to every agent
      \u2192 mindly memory reject 7bc7e9b7     drop the suggestion
      "
    `);
    expect(render((sc) => renderRules(sc, [], []))).toMatchInlineSnapshot(`
      "
      No rules yet.
      Agents suggest a rule when you say something like "always use pnpm". You can also add one yourself.

      -> mindly memory add --kind rule --title "Use pnpm, never npm"   add a rule every agent follows
      "
    `);
  });

  it('memory list', () => {
    expect(render((sc) => renderMemoryList(sc, [pnpmRule, exportsRule, npmMistake])))
      .toMatchInlineSnapshot(`
        "
        3 memories - 2 waiting for you

          [ok] Rule: Always use pnpm, never npm (approved by you; enforced: blocks edits that
               break it)  [a9884755]
          [!] Rule: Don't use default exports (you said it in Claude Code, waiting for you)  [7bc7e9b7]
          [!] Known pitfall: Command fails: npm test (suggested by Codex, waiting for you)   [bf1da9e0]

        -> mindly memory approve 7bc7e9b7   share it with every agent
        -> mindly memory show 7bc7e9b7      see the details and history
        "
      `);
  });
});

describe('insight screens', () => {
  it('conflicts', () => {
    expect(render((sc) => renderConflicts(sc, [conflict], sessionOf, false), UTF8))
      .toMatchInlineSnapshot(`
        "
        1 open conflict

          ! Claude Code \u00B7 4409d433 changed the exports of src/auth.ts; Codex's src/dash.ts uses
            them  [9f02a0c3]
            check this \u00B7 open \u00B7 2m ago
            Changed signature: login. 1 file imports it: src/dash.ts.

        \u2192 mindly conflict 9f02a0c3 resolve   mark it resolved once fixed
        \u2192 mindly conflict 9f02a0c3 dismiss   if it is not a real problem
        "
      `);
    expect(render((sc) => renderConflicts(sc, [], sessionOf, false))).toMatchInlineSnapshot(`
      "
      No open conflicts.
      Mindly reports a conflict when one agent's change breaks or overlaps another agent's work.
      "
    `);
  });

  it('why', () => {
    expect(
      render((sc) =>
        renderWhy(sc, {
          path: 'src/auth.ts',
          line: 1,
          text: 'export function login(u: string, pw: string) {',
          changes: [
            {
              sessionId: claude.id,
              agentKind: 'claude-code',
              label: 'claude-code #4409d433',
              at: new Date(2026, 10, 4, 15, 28).getTime(),
              tool: 'Edit',
              prompt: 'Add a password parameter to login',
              promptEventId: null,
            },
          ],
          memories: [
            {
              id: pnpmRule.id,
              kind: 'rule',
              title: pnpmRule.title,
              trust: 'approved',
              evidenceValid: true,
            },
          ],
        }),
      ),
    ).toMatchInlineSnapshot(`
      "
      src/auth.ts:1
        export function login(u: string, pw: string) {

      Written by Claude Code - 4409d433 with its Edit tool, 2026-11-04 15:28 (2m ago)
        Asked to: "Add a password parameter to login"

      Related memories
        [ok] Rule: Always use pnpm, never npm (approved by you)  [a9884755]
      "
    `);
  });

  it('xray explains what was sent and left out', () => {
    const item = (over: Partial<ContextItem>): ContextItem => ({
      ref: 'r',
      kind: 'memory',
      title: 't',
      score: 1,
      tokens: 10,
      reason: 'rule/approved',
      ...over,
    });
    const r: XRaySession = {
      sessionId: codex.id,
      label: 'codex #f57f6d10',
      packets: [
        {
          id: 'p1',
          trigger: 'session_start',
          query: null,
          at: NOW - 3 * MIN,
          tokenBudget: 1800,
          tokensUsed: 135,
          included: [
            item({ kind: 'session', title: 'claude-code #4409d433', reason: 'live agent' }),
            item({ title: pnpmRule.title }),
            item({ kind: 'conflict', title: conflict.title, reason: 'impact conflict' }),
          ],
          omitted: [
            item({
              title: 'Auth uses sessions, not JWT',
              reason: 'decision/approved; over token budget',
            }),
          ],
        },
      ],
    };
    expect(render((sc) => renderXray(sc, codex, r), UTF8)).toMatchInlineSnapshot(`
      "
      Context sent to Codex \u00B7 f57f6d10

      At session start (3m ago), Codex received 3 items:
        \u2713 Claude Code \u00B7 4409d433 is working in this project too
        \u2713 Rule "Always use pnpm, never npm"
        \u2713 Conflict: Claude Code \u00B7 4409d433 changed the exports of src/auth.ts
      Left out (no room left in the context): 1 item
        ! Decision "Auth uses sessions, not JWT"

      \u2192 mindly xray --session f57f6d10 --query "<words>"   find out why a memory did or did not reach it
      "
    `);
    expect(
      render((sc) =>
        renderXrayQuery(sc, codex, {
          sessionId: codex.id,
          query: 'exports',
          tokenBudget: 1800,
          items: [
            {
              memoryId: exportsRule.id,
              title: exportsRule.title,
              kind: 'rule',
              trust: 'proposed',
              reason: 'trust_filter',
              detail: 'trust is proposed; never injected automatically',
              lastSeen: null,
            },
            {
              memoryId: pnpmRule.id,
              title: pnpmRule.title,
              kind: 'rule',
              trust: 'approved',
              reason: 'included',
              detail: 'score 0.9, 20 tokens',
              lastSeen: null,
            },
          ],
        }),
      ),
    ).toMatchInlineSnapshot(`
      "
      Would memories about "exports" reach Codex - f57f6d10?

        [!] Rule "Don't use default exports": not sent: waiting for your approval  [7bc7e9b7]
        [ok] Rule "Always use pnpm, never npm": would be sent                      [a9884755]

      -> mindly memory approve 7bc7e9b7   let it reach agents
      "
    `);
  });

  it('standup', () => {
    const digest: StandupDigest = {
      projectId: P,
      projectName: 'my-app',
      since: NOW - 24 * 60 * MIN,
      until: NOW,
      agents: [
        {
          agentKind: 'claude-code',
          sessions: 2,
          turns: 5,
          filesChanged: 1,
          topFiles: ['src/auth.ts'],
          rateLimits: 0,
        },
        { agentKind: 'codex', sessions: 1, turns: 0, filesChanged: 0, topFiles: [], rateLimits: 1 },
      ],
      memories: {
        decisions: [{ id: id('00000001'), title: 'Auth uses sessions, not JWT' }],
        facts: [],
        rules: [{ id: exportsRule.id, title: exportsRule.title }],
      },
      conflicts: { opened: 1, resolved: 0, open: 1 },
      handoffs: [],
      rateLimits: 1,
      blockedTasks: [],
      needsYou: {
        proposedRules: [{ id: exportsRule.id, title: exportsRule.title }],
        proposedMemories: [],
        criticalConflicts: [],
        unclaimedHandoffs: [],
      },
    };
    expect(render((sc) => renderStandup(sc, digest))).toMatchInlineSnapshot(`
      "
      Standup - my-app - last 24h (since yesterday 15:30)

      Agents
        - Claude Code: 2 sessions, 5 turns, changed 1 file (src/auth.ts)
        - Codex: 1 session, no file changes, hit its usage limit once

      Learned
        - 1 new decision: "Auth uses sessions, not JWT"
        - 1 new rule: "Don't use default exports"

      Coordination
        [!] 1 conflict opened, 0 resolved, 1 still open

      Needs you
        - Suggested rule: "Don't use default exports"  [7bc7e9b7]

      -> mindly rules    review the suggested rules
      -> mindly status   see everything that needs you
      "
    `);
  });
});

describe('continuity screens', () => {
  it('handoffs and snapshots', () => {
    expect(render((sc) => renderHandoffs(sc, [handoff], sessionOf))).toMatchInlineSnapshot(`
      "
      1 handoff - 1 waiting to be picked up

        [!] Finish the dashboard login form  [2bc5385b]
            waiting for Cursor - from Codex - f57f6d10 - handed over by you - 5m ago
            Next: Wire the submit button

      -> Start Cursor in this project: it picks the handoff up at the start of its session.
      "
    `);
    const snap: Snapshot = {
      id: id('42ec8a00'),
      projectId: P,
      label: 'before refactor',
      gitRef: 'refs/mindly/snapshots/x',
      commit: '645b014e3989aaaa',
      createdAt: NOW - 90 * MIN,
    };
    expect(render((sc) => renderSnapshots(sc, [snap]))).toMatchInlineSnapshot(`
      "
      1 snapshot

        - "before refactor" - 1h ago - code at commit 645b014e  [42ec8a00]

      -> mindly snapshot diff 42ec8a00      see what changed since
      -> mindly snapshot restore 42ec8a00   go back to it (nothing is deleted)
      "
    `);
  });
});

describe('doctor screen', () => {
  const ok = (name: string, group: DoctorItem['group'], text: string): DoctorItem => ({
    check: { name, status: 'ok', detail: 'd' },
    group,
    text,
    fix: null,
  });
  it('groups checks and ends with a verdict and the fixes', () => {
    const items: DoctorItem[] = [
      ok('node', 'Setup', 'Node.js 24.1.0'),
      ok('database', 'Setup', 'Database is up to date'),
      ok('claude-code', 'Agents', 'Claude Code: connected (automatic capture and Mindly tools)'),
      {
        check: { name: 'cursor', status: 'warn', detail: 'd' },
        group: 'Agents',
        text: 'Cursor is installed but not connected to Mindly',
        fix: { cmd: 'mindly init --agents cursor', why: 'connect it' },
      },
      {
        check: { name: 'codex', status: 'warn', detail: 'd' },
        group: 'Agents',
        text: 'Codex is installed but not connected to Mindly',
        fix: { cmd: 'mindly init --agents codex', why: 'connect it' },
      },
      {
        check: { name: 'daemon', status: 'info', detail: 'd' },
        group: 'Optional',
        text: 'Background service is not running',
        fix: null,
      },
    ];
    expect(render((sc) => renderDoctor(sc, items), UTF8)).toMatchInlineSnapshot(`
      "
      Mindly doctor \u00B7 working, 2 things to check

      Setup
        \u2713 Node.js 24.1.0
        \u2713 Database is up to date

      Agents
        \u2713 Claude Code: connected (automatic capture and Mindly tools)
        ! Cursor is installed but not connected to Mindly
        ! Codex is installed but not connected to Mindly

      Optional
        \u2022 Background service is not running

      ! Mindly works, but 2 things need your attention.

      \u2192 mindly init --agents cursor,codex   connect Cursor and Codex
      "
    `);
    expect(
      render((sc) =>
        renderDoctor(sc, [
          {
            check: { name: 'git', status: 'fail', detail: 'd' },
            group: 'Setup',
            text: 'git was not found',
            fix: { why: 'Install git and make sure it is on your PATH' },
          },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "
      Mindly doctor - 1 problem to fix

      Setup
        [x] git was not found

      Agents
        [!] No agent is connected to Mindly yet (connect one with: mindly init)

      [x] Mindly cannot work until you fix this problem.

      -> Install git and make sure it is on your PATH
      "
    `);
  });
});

describe('human output never shows internals', () => {
  it('has no full ids, enum values, event names or token counts', () => {
    const all = [
      render((sc) =>
        renderStatus(sc, statusData({ proposed: [exportsRule, npmMistake], handoffs: [handoff] })),
      ),
      render((sc) => renderRules(sc, [pnpmRule], [exportsRule])),
      render((sc) => renderMemoryList(sc, [pnpmRule, exportsRule, npmMistake])),
      render((sc) => renderConflicts(sc, [conflict], sessionOf, true)),
      render((sc) => renderHandoffs(sc, [handoff], sessionOf)),
    ].join('\n');
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(all).not.toMatch(
      /\b(proposed|approved\b(?! by you)|verified|session_start|intent_overlap|impact|rate_limited|acknowledged|tokens?|claude-code #|manual|pending)\b/,
    );
  });
});
