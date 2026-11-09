import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, Store, schemaVersion } from '../src/index.js';
import { MIGRATION_V5_TRACK } from '../src/migrations/v5-track.js';
import { setup } from './helpers.js';

const DAY = 86_400_000;
const DOWNGRADE =
  'DROP TABLE sentinel_watches; DROP INDEX file_changes_created; DROP TABLE line_survival; DROP TABLE file_change_lines;';

function change(
  store: Store,
  projectId: string,
  sessionId: string,
  path: string,
  hashes: string[],
  lineHashes: string[] = hashes,
) {
  return store.fileChanges.record({
    projectId,
    sessionId,
    path,
    tool: 'Edit',
    hunkHashes: hashes,
    lineHashes,
    addedLines: hashes.length,
    removedLines: 1,
    promptEventId: null,
  });
}

function tables(store: Store): string[] {
  return (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

function indexSql(store: Store, name: string): string | undefined {
  return (
    store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { sql: string } | undefined
  )?.sql;
}

describe('line survival schema (v5)', () => {
  it('is the fifth migration: added lines, survival and an index for the scan', () => {
    const { store } = setup();
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5);
    expect(MIGRATIONS[4]).toBe(MIGRATION_V5_TRACK);
    expect(MIGRATIONS[3]).not.toContain('line_survival');
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    const cols = (
      store.db.prepare('PRAGMA table_info(line_survival)').all() as { name: string; pk: number }[]
    ).map((c) => [c.name, c.pk]);
    expect(cols).toEqual([
      ['change_id', 1],
      ['project_id', 0],
      ['checked_at', 0],
      ['total_hashes', 0],
      ['kept_hashes', 0],
    ]);
    expect(indexSql(store, 'line_survival_project')).toContain('(project_id)');
    expect(indexSql(store, 'file_changes_created')).toContain('(created_at, id)');
    expect(tables(store)).toContain('file_change_lines');
  });

  it('upgrades a v4 database and keeps its data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mindly-track-')), 'mindly.db');
    const old = Store.open(path);
    const project = old.projects.upsertByRoot('/repo', 'repo');
    const session = old.sessions.upsert({
      projectId: project.id,
      agentKind: 'codex',
      externalId: 'cx-1',
      worktree: '/repo',
      branch: 'main',
      transcriptPath: null,
    }).session;
    old.db.exec(`${DOWNGRADE} PRAGMA user_version = 4;`);
    const c = old.fileChanges.record({
      projectId: project.id,
      sessionId: session.id,
      path: 'src/api/a.ts',
      tool: 'Edit',
      hunkHashes: ['h1', 'h2'],
      addedLines: 2,
      removedLines: 0,
      promptEventId: null,
    });
    const run = old.runs.create({ projectId: project.id, kind: 'bisect', title: 'b', input: {} });
    expect(tables(old)).not.toContain('line_survival');
    old.close();

    const store = Store.open(path);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    expect(tables(store)).toEqual(expect.arrayContaining(['line_survival', 'file_change_lines']));
    expect(store.fileChanges.forPath(project.id, 'src/api/a.ts').map((x) => x.id)).toEqual([c.id]);
    expect(store.fileChanges.findByHash(project.id, 'src/api/a.ts', 'h2').map((x) => x.id)).toEqual(
      [c.id],
    );
    // Edits from before v5 have no tracked lines.
    expect(store.track.hashes(c.id)).toEqual([]);
    expect(store.runs.get(run.id).kind).toBe('bisect');
    expect(store.sessions.get(session.id).agentKind).toBe('codex');
    store.close();
  });
});

describe('TrackRepo', () => {
  it('keeps the whole added lines apart from the provenance hashes', () => {
    const { store, project, a } = setup();
    const c = change(store, project.id, a.id, 'src/a.ts', ['frag', 'line1', 'line2'], ['line1']);
    expect(store.track.hashes(c.id)).toEqual(['line1']);
    expect(store.fileChanges.findByHash(project.id, 'src/a.ts', 'frag')).toHaveLength(1);
  });

  it('groups edits by path and session within the window', () => {
    const { store, project, a, b, clock } = setup();
    change(store, project.id, a.id, 'src/api/x.ts', ['1']);
    clock.advance(DAY);
    const from = clock.now();
    change(store, project.id, a.id, 'src/api/x.ts', ['2', '3']);
    change(store, project.id, a.id, 'src/api/x.ts', ['4']);
    change(store, project.id, b.id, 'README.md', []);
    const groups = store.track
      .editGroups(project.id, from)
      .sort((x, y) => x.path.localeCompare(y.path));
    expect(groups).toEqual([
      {
        path: 'README.md',
        sessionId: b.id,
        agentKind: 'codex',
        edits: 1,
        addedLines: 0,
        removedLines: 1,
      },
      {
        path: 'src/api/x.ts',
        sessionId: a.id,
        agentKind: 'claude-code',
        edits: 2,
        addedLines: 3,
        removedLines: 2,
      },
    ]);
  });

  it('records survival once, groups it, and lists what is still pending', () => {
    const { store, project, a, clock } = setup();
    const old = change(store, project.id, a.id, 'src/a.ts', ['1', '2']);
    const skipped = change(store, project.id, a.id, 'src/a.ts', ['3']);
    clock.advance(10 * DAY);
    const recent = change(store, project.id, a.id, 'src/b.ts', ['3']);
    const before = clock.now() - 7 * DAY;
    expect(store.track.pendingSurvival(project.id, before, 10).map((p) => p.changeId)).toEqual([
      old.id,
      skipped.id,
    ]);
    expect(store.track.pendingSurvival(null, before, 10)[0]).toMatchObject({
      changeId: old.id,
      projectId: project.id,
      sessionId: a.id,
      path: 'src/a.ts',
      worktree: '/repo',
      branch: 'main',
      createdAt: old.createdAt,
    });
    // After a cursor: only what comes later.
    expect(
      store.track
        .pendingSurvival(null, before, 10, 0, { createdAt: old.createdAt, id: old.id })
        .map((p) => p.changeId),
    ).toEqual([skipped.id]);
    expect(store.track.countPendingSurvival(project.id, before)).toBe(2);
    expect(store.track.countPendingSurvival(project.id, clock.now())).toBe(3);
    const rec = (id: string, total: number, kept: number) =>
      store.track.recordSurvival({
        changeId: id,
        projectId: project.id,
        totalHashes: total,
        keptHashes: kept,
      });
    rec(old.id, 2, 5);
    // Computed once: a second result for the same edit is ignored.
    rec(old.id, 2, 0);
    rec(skipped.id, 0, 0);
    const row = store.db
      .prepare('SELECT total_hashes, kept_hashes FROM line_survival WHERE change_id = ?')
      .get(old.id) as { total_hashes: number; kept_hashes: number };
    expect(row).toEqual({ total_hashes: 2, kept_hashes: 2 });
    // Skipped edits (0 of 0) are not counted as checked.
    expect(store.track.survivalGroups(project.id, 0, clock.now())).toEqual([
      {
        path: 'src/a.ts',
        sessionId: a.id,
        agentKind: 'claude-code',
        edits: 1,
        totalHashes: 2,
        keptHashes: 2,
      },
    ]);
    expect(store.track.countPendingSurvival(project.id, before)).toBe(0);
    expect(store.track.pendingSurvival(project.id, clock.now(), 10).map((p) => p.changeId)).toEqual(
      [recent.id],
    );
  });

  it('deletes added lines and survival rows with their edit (and project)', () => {
    const { store, project, a } = setup();
    const c = change(store, project.id, a.id, 'src/a.ts', ['1']);
    store.track.recordSurvival({
      changeId: c.id,
      projectId: project.id,
      totalHashes: 1,
      keptHashes: 1,
    });
    store.projects.delete(project.id);
    for (const t of ['line_survival', 'file_change_lines']) {
      const n = store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(n.n, t).toBe(0);
    }
  });

  it('reads each opening of a conflict from its event, and dismissed conflicts', () => {
    const { store, project, a, b, clock } = setup();
    const report = (ids: string[]) =>
      store.conflicts.report({
        projectId: project.id,
        kind: 'merge_conflict',
        severity: 'critical',
        title: 't',
        detail: 'd',
        sessionIds: ids,
        paths: ['src/a.ts'],
        fingerprint: 'fp',
      }).conflict;
    const opened = (id: string, ids: string[] | undefined, extra: Record<string, unknown> = {}) =>
      store.events.append({
        projectId: project.id,
        sessionId: null,
        type: 'conflict.opened',
        payload: {
          conflictId: id,
          kind: 'merge_conflict',
          ...(ids ? { sessionIds: ids, paths: ['src/a.ts'] } : {}),
          ...extra,
        },
      });
    const from = clock.now();
    const c = report([a.id]);
    opened(c.id, [a.id]);
    clock.advance(1000);
    // The row is overwritten by the next report; the first opening is not.
    report([b.id]);
    opened(c.id, [b.id], { actorInRoot: false });
    opened(c.id, undefined);
    store.events.append({
      projectId: project.id,
      sessionId: null,
      type: 'conflict.opened',
      payload: { conflictId: 'x', kind: 'file_overlap', sessionIds: [a.id] },
    });
    const openings = store.track.conflictOpenings(
      project.id,
      ['merge_conflict', 'contract_broken'],
      from,
    );
    expect(openings.map((o) => [o.sessionIds, o.actorInRoot])).toEqual([
      [null, null],
      [[b.id], false],
      [[a.id], null],
    ]);
    expect(openings[2]).toMatchObject({ conflictId: c.id, kind: 'merge_conflict', at: from });
    expect(store.track.dismissedConflicts(project.id).size).toBe(0);
    store.conflicts.setStatus(c.id, 'dismissed');
    expect([...store.track.dismissedConflicts(project.id)]).toEqual([c.id]);
  });

  it('finds sessions that hit a usage limit from events and rate-limit handoffs', () => {
    const { store, project, a, b, clock } = setup();
    const from = clock.now();
    store.events.append({
      projectId: project.id,
      sessionId: a.id,
      type: 'session.rate_limited',
      payload: {},
    });
    store.handoffs.create({
      projectId: project.id,
      fromSessionId: b.id,
      toAgentKind: 'claude-code',
      taskId: null,
      reason: 'rate_limit',
      summary: 'limit',
      packet: {
        goal: 'g',
        plan: [],
        filesChanged: [],
        recentPrompts: [],
        decisions: [],
        blockers: [],
        nextSteps: [],
        branch: null,
        headCommit: null,
      },
    });
    expect([...store.track.limitedSessionIds(project.id, from)].sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.track.limitedSessionIds(project.id, clock.now() + 1).size).toBe(0);
  });
});
